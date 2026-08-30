# Event-runtime adapters and workspace confinement

Model-backed adapters can execute tools chosen by a model. A non-mutating
agent definition with `capabilities.filesystem: workspace-only` therefore
promises more than a convenient working directory: by default the worker must
prove that the selected adapter enters a Gondolin guest before it starts the
model process.

## Fail-closed behavior

Without an operator opt-out, a worker that cannot provide Gondolin refuses the
run before creating its workspace or spawning the adapter. The stable result
code remains `filesystem_confinement_unavailable`; the lifecycle detail names
the missing host capability, for example:

```text
work-scan@1: sandbox_unavailable:qemu — qemu-system-x86_64 is not on PATH
```

Other preflight tokens include `sandbox_unavailable:node` and
`sandbox_unavailable:sdk`. `factory watchdog` and `factory pulse` surface
recent refusals so a stopped scan supply loop is not mistaken for an idle
factory.

An explicit `sandbox:` block on an agent definition is always strict. It is
never eligible for host fallback: unsupported adapters, invalid policies, and
unavailable guest infrastructure continue to refuse.

## Explicit host fallback (an allow-list, never a switch)

An operator may temporarily run _named_ workspace-only scans on a host that
lacks Gondolin by adding this to the instance-local `config/policy.yaml`:

```yaml
sandbox:
  workspace_only_fallback:
    mode: host
    agents:
      - work-scan
      - triage-scan
      - ci-doctor
```

This is an opt-out from filesystem enforcement, not another sandbox provider,
so it is deliberately not a single global switch: the operator writes down
exactly which agents they accept running unconfined, and every other
workspace-only agent keeps refusing. Adding an agent to the list is a
reviewable one-line change; forgetting to remove one is visible in the policy
file rather than hidden behind a boolean.

It applies only when all of these conditions hold:

- this host's sandbox preflight fails — a host that _can_ sandbox never falls
  back, whatever the allow-list says;
- the agent is explicitly non-mutating;
- its filesystem capability is exactly `workspace-only`;
- a model-backed adapter was selected;
- the agent definition has no explicit `sandbox:` block; and
- `agents` names the agent (bare name, no `@version`, no pack namespace).

An agent absent from `agents` is refused exactly as it was before this
fallback existed, with the reason naming the missing host capability
(`sandbox_unavailable:qemu`) rather than the policy shape.

Missing, misspelled, malformed, and unknown values all fail closed — including
`mode: host` with an empty or absent `agents` list, which grants nobody.

### The legacy blanket form

```yaml
sandbox:
  workspace_only_fallback: host # deprecated
```

The bare string is still accepted for instances configured before the
allow-list landed. It means "every non-mutating workspace-only agent" and logs
a loud warning on every claim. Replace it with the object form.

### The audit marker

The downgrade is never silent: every terminal run receipt written by a run
that used it — completed _and_ refused — contains this worker-controlled
attestation, and the failure paths that write no receipt record the same
object on the attempt trace:

```json
{
  "filesystemConfinement": {
    "status": "unconfined",
    "declared": "workspace-only",
    "fallback": "host",
    "source": "policy:sandbox.workspace_only_fallback",
    "agent": "work-scan",
    "hostCapability": "qemu"
  }
}
```

The worker writes this field after any agent-authored receipt data so the agent
cannot overwrite the audit marker.

## Operator procedure

1. Confirm Gondolin is unavailable with
   `bun event-runtime/cli.mjs sandbox doctor`.
2. Add the allow-list stanza to the live `config/policy.yaml`, naming only
   the agents you accept running unconfined.
3. Restart the event-runtime worker processes so they read the new policy.
4. Confirm the affected scan runs complete and their receipts say
   `filesystemConfinement.status: unconfined`.
5. Install the missing Gondolin/QEMU prerequisites, remove the fallback, restart
   workers, and confirm a sandboxed smoke run succeeds.

The tracked `config/policy.example.yaml` leaves the opt-out commented because
new installations must remain fail-closed by default. Factory follow-up #1259
tracks installing Gondolin/QEMU on the current operator runner so the interim
host fallback can be removed.
