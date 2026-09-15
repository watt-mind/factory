# Infra recovery verbs (`factory infra`)

Three recoveries on the legal-dev stack that are documented, mechanical and
low-risk, wrapped so an agent can run them without asking a human first.

## Why they exist

During the 2026-09-15 release each of these was blocked by the coding agent's
permission classifier, and each block cost a Telegram round-trip to the
operator for a decision they had already made. The classifier was not wrong to
be suspicious: the shape an agent had to type was `ssh … sudo rm -rf …`,
`kubectl delete pods --field-selector=status.phase=Failed`, or
`gh variable set … --body <digest>` — three of the most dangerous strings in
the fleet, with the safety entirely in the operator's head.

Wrapping them moves the safety into code and the permission surface into one
reviewable rule. The verb refuses on the preconditions the runbook describes,
so allowing `factory infra` is allowing _those three recoveries_, not a shell.

| Verb                             | Incident  | What went wrong without it                                                                                                                                                                               |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rotate-driver-digest`           | OPS-694   | The dev-qualification driver was rotated on the runner but `DEV_QUALIFICATION_DRIVER_SHA256` stayed stale in `legalease` and `lawz`, so the qualify gate checked against a digest nobody had installed.  |
| `discard-unprepared-transaction` | CLNT-3170 | A failed `lawz` publish left an unprepared `research-runner` directory under the promotion journal; every LegalEase publisher then exited 3 behind it until an operator discarded the directory by hand. |
| `sweep-evicted-pods`             | CLNT-3167 | Runner disk pressure evicted dev-cluster pods. Their `Failed` husks failed the qualify gate, and the fixture pods among them have no controller to recreate them.                                        |

## Shared behaviour

- **Dry run is the default.** Nothing mutates without `--yes`. `--dry-run` is
  accepted as an explicit spelling of the default so a cautious caller can say
  so out loud.
- **Exit codes.** `0` evaluated clean (acted, or printed the plan) · `2`
  REFUSED — a precondition says no and nothing was mutated · `3` CANNOT
  EVALUATE — an adapter failed or the flags are unusable. A verb that could not
  read the world never reports a clean run.
- **Logging.** Every invocation tees its output to
  `~/.factory/logs/infra/<verb>-<YYYYMMDD-HHMMSS>.log`, and prints the path.
  Log failures are swallowed — logging must never break a recovery.
- **`--ticket <ID>`** posts one line of result on that ticket (add
  `--ticket-repo <name>` to route through a specific configured repo, e.g.
  `--ticket-repo wm-home` from the factory checkout, whose own control plane is
  GitHub Issues).
- **`--host`** defaults to the runner, `hdkiller@100.74.142.98`. `kubectl` runs
  _on the host_ over ssh, because the dev cluster is k3s on the runner and its
  kubeconfig lives there.
- Reads that need root (`/etc/legalease/dev-qualification/config.json`, the
  journal) use `sudo -n`; a host without passwordless sudo for them yields
  exit 3, not a false pass.

## `factory infra rotate-driver-digest`

```
factory infra rotate-driver-digest --digest sha256:<64hex> --repos legalease,lawz [--yes]
```

Verifies, read-only over ssh, that the digest is what is _actually installed_:

- `sha256sum /usr/local/libexec/legalease/dev-qualification-driver`, and
- `driver_sha256` in `/etc/legalease/dev-qualification/config.json`.

Both must agree with `--digest`. A digest matching neither is the OPS-694 bug
itself; one matching only the config would pin CI to a driver nobody installed.
On mismatch the verb exits 2 having made **zero** `gh` calls.

When they agree it prints before/after per repo and, with `--yes`, runs
`gh variable set DEV_QUALIFICATION_DRIVER_SHA256 -R watt-mind/<repo> --body
<digest>`. A repo already holding the digest is skipped, and an unset variable
reads as `(unset)` rather than blank.

## `factory infra discard-unprepared-transaction`

```
factory infra discard-unprepared-transaction --role research-runner|case-agent [--yes]
```

Everything on the host runs under `flock -w 30 -x` on
`/var/lib/legal-dev-runtime-promotion/legal-dev-runtime-promotion.lock` — the
same lock the publishers take, so the probe cannot race a live transaction.

It **refuses** (exit 2) when:

- `active/<role>/promotion.state` or `active/<role>/coordinator.phase` exists.
  That transaction told the coordinator it owns the promotion; discarding it
  turns a stuck publisher into a half-applied rollout.
- the target deployment's live `metadata.resourceVersion` differs from the
  `{"op":"test","path":"/metadata/resourceVersion"}` precondition in
  `active/<role>/deployment-patch.json`. Something was already applied, so the
  directory is evidence, not garbage. The deployment is read from the
  transaction's own `live-deployment.json` (`metadata.namespace`/`name`) rather
  than a hard-coded role map.

It **cannot evaluate** (exit 3) when the patch has no such `test` op, the live
`resourceVersion` is unreadable, or `qualification-stage.binding` is missing —
each of those is a question it could not answer, never a pass. An absent
`active/<role>` is a clean no-op (exit 0, "nothing is stranded").

With `--yes` it then, under the lock:

1. `sudo <driver> --recover $(cat active/<role>/qualification-stage.binding)` —
   a non-zero exit here is tolerated and reported, because the point of the
   discard is to clear state the driver may itself be unable to reconcile;
2. `rm -f /var/lib/legalease/dev-qualification/exchange/publisher-<role>-candidate.json`;
3. `rm -rf active/<role>` and `fsync` of `active/`;
4. prints the last 4 events from `/var/lib/legalease/dev-qualification/journal/`.

The lock is released between probe and act (two ssh sessions), so the act
script re-asserts both state-file preconditions in shell and exits 9 if either
appeared; the verb reports that as REFUSED, not as success.

**Candidate filename.** The exchange file is named for the _publisher_ role,
which is spelled with underscores (`publisher-research_runner-candidate.json`).
The default is the `--role` value with `-` replaced by `_`. LegalEase's own
publisher calls its roles `case_agent` and `research_broker`
(`scripts/dev_qualification_publisher.py`), so if a future stranded transaction
belongs to a publisher whose role name is not simply the transaction role,
pass `--candidate-role <name>`. The dry run prints the exchange directory
listing next to the path it would remove, so the mismatch is visible before
`--yes`.

## `factory infra sweep-evicted-pods`

```
factory infra sweep-evicted-pods [--namespaces 'office-*,legal-research-dev,legalease-pii'] [--yes]
```

Takes one `kubectl get pods -A -o json` snapshot and selects pods that are all
of:

- in a namespace matching the patterns (`*` is the only metacharacter);
- `status.phase == Failed`;
- `status.reason` in `Evicted` or `ContainerStatusUnknown`;
- **and** either owned by something with a `Running` replica _in the same
  namespace_, or ownerless and older than 24 h.

The owner test is the safety property: an evicted pod whose ReplicaSet already
has a Running replica is pure garbage, while one whose owner has nothing
running may be the only record of why a workload is down. The Running sibling
is read out of the same snapshot, so the decision is a pure function of one
cluster read. The 24 h floor for ownerless pods exists because the dev
cluster's fixture pods have no controller (CLNT-3167).

Running, Pending and Succeeded pods are never selected — phase is the gate, not
the reason string. The plan is always printed (`DELETE` / `keep` with the why);
with `--yes` it deletes exactly the selected pods, one
`kubectl delete pod -n <ns> <name>` each, and one failure does not abort the
rest.

## Allow-rule for Claude Code

The point of the verbs is that one rule can replace three classifier
round-trips. Add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(factory infra *)"]
  }
}
```

This file is the operator's and lives outside this repo, so it is not edited by
the factory — paste the rule yourself, or run `/update-config`. Allowing the
verbs is not allowing a shell: without `--yes` every one of them is read-only,
and with it each is confined to the preconditions above.
