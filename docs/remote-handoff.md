# Remote ticket handoff

`factory handoff` sends one already-specified ticket from an operator's configured repository to the central Factory runtime. The transport is a dedicated OpenSSH key over Tailscale. It does **not** expose the runtime webhook secret to clients and does not make the operator HTTP API public.

## Trust boundary

The client sends one bounded `factory.handoff/v1` JSON document containing only:

```json
{
  "schemaVersion": "factory.handoff/v1",
  "requestId": "handoff-unique-id",
  "repo": "factory",
  "ticket": "watt-mind/factory#1153"
}
```

The forced-command server rejects unknown fields, malformed IDs, unconfigured repos, report-only repos, ticket/repo mismatches, and any caller-supplied `SSH_ORIGINAL_COMMAND`. It derives the `factory.dispatch.requested` envelope, including `source: "handoff"`, then signs the exact POST `/events` bytes with the server's existing `FACTORY_EVENT_SECRET`. The secret is never accepted from the request or printed in a receipt.

`handoff` is reserved provenance. Unsigned intake still fails, `/replay` rejects both `handoff` and `chain`, and only authenticated signed `/events` may admit `handoff`. A handoff is unattended, not operator authorization: sensitive/escalated and `escalate_paths` bypasses remain false.

## Client SSH alias

Create a dedicated key for this purpose; do not reuse an interactive-login key. No key is committed to Factory. Configure an alias on the client:

```sshconfig
Host factory-runner
  HostName runner
  User factory-handoff
  IdentityFile ~/.ssh/factory-handoff
  IdentitiesOnly yes
  RequestTTY no
```

Set the alias once per client environment, or pass it explicitly:

```sh
export FACTORY_HANDOFF_SSH_HOST=factory-runner
factory handoff --repo factory watt-mind/factory#1153
# equivalent: factory handoff --host factory-runner --repo factory watt-mind/factory#1153
```

When cwd is under a configured repo `path` or `worktree_root`, `--repo` may be omitted. The client supplies no remote command, so the server's forced command is the only executable path.

## Server forced command

Create a root-owned wrapper, for example `/usr/local/sbin/factory-handoff-accept`:

```sh
#!/bin/sh
set -eu
. /etc/factory/event-runtime.env
exec /opt/factory/current/bin/factory handoff accept
```

The environment file must be readable by the dedicated account and must load the same `FACTORY_EVENT_SECRET` used by the running event runtime. It may also set:

```sh
FACTORY_EVENT_URL=http://127.0.0.1:7381
FACTORY_DASHBOARD_URL=https://factory.whale-pike.ts.net
FACTORY_REPOS_ROOT=/opt/factory/current
# When the runtime's existing control API bearer gate is enabled:
FACTORY_CONTROL_API_TOKEN=...
```

Do not echo the environment, enable shell tracing, place either secret in `authorized_keys`, or copy them to clients. `POST /events` continues to authenticate with the event HMAC; the optional control API token is sent only on the broker's read-only receipt-enrichment requests.

Install the client's **public** key for the dedicated account using a forced command. Replace the example Tailscale address and key with deployment-local values:

```text
restrict,from="100.64.0.10",command="/usr/local/sbin/factory-handoff-accept" ssh-ed25519 AAAA... factory-handoff-client
```

`restrict` disables forwarding, agent/X11 forwarding, PTY allocation, and user commands. Keep `from=` narrowed to the expected Tailscale source IP (or the smallest stable source range). In addition, restrict sshd/firewall access to the Tailscale interface and ACL the dedicated account/host to approved operator devices. The `from=` check is defense in depth, not a substitute for Tailscale ACLs.

## Receipt and retries

The server returns one `factory.handoff-receipt/v1` JSON document with admission/duplicate status, event state, proposal/run IDs and states when already visible, and `FACTORY_DASHBOARD_URL` when configured. State fields can be pending because planning runs asynchronously after durable admission.

`requestId` is the idempotency key for `(source=handoff, eventId=requestId)`. If SSH disconnects after submission, retry with the same ID:

```sh
factory handoff --request-id handoff-original-id --repo factory watt-mind/factory#1153
```

A retry returns `duplicate: true` and the original event rather than dispatching a second run. Reusing that request ID for a different repo or ticket fails with `idempotency_conflict`; it never reports the original dispatch as if it covered the new request.

## Rollout

1. Deploy code and regenerate/install the Factory CLI before installing any key.
2. Confirm the runtime has `FACTORY_EVENT_SECRET` and loopback `/health` reports `webhookSecret: "set"`.
3. Install the environment wrapper and verify its owner/mode without running it under a tracing shell.
4. Add the dedicated user, Tailscale ACL/source restriction, and one forced-command public key.
5. Configure one client alias and hand off a disposable agent-ready ticket with an explicit request ID.
6. Confirm the receipt, `source=handoff` event, auto-approval evidence, and ordinary worker claim/worktree lifecycle in the dashboard.
7. Retry the same ID and confirm `duplicate: true` with no second run.

## Rollback

Remove or comment out the dedicated `authorized_keys` entry first; this stops new handoffs immediately without affecting the runtime. Then remove the client alias/key and wrapper if desired. Already admitted events remain in the durable ledger and continue under normal dispatch policy; reject/cancel them through existing operator procedures if necessary. No HTTP route, bearer credential, production key, or new runtime secret needs rollback.

## Out of scope

This feature does not introduce or configure bearer auth; it only interoperates with the runtime's existing `FACTORY_CONTROL_API_TOKEN` gate when that token is already enabled. It does not add direct remote `/replay` access, public `/events` access, production keys, or a second dispatch policy.
