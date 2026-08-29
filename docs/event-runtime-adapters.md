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

## Explicit host fallback

An operator may temporarily run otherwise eligible workspace-only scans on a
host that lacks Gondolin by setting the instance-local policy:

```yaml
sandbox:
  workspace_only_fallback: host
```

This is an opt-out from filesystem enforcement, not another sandbox provider.
It applies only when all of these conditions hold:

- the agent is explicitly non-mutating;
- its filesystem capability is exactly `workspace-only`;
- a model-backed adapter was selected; and
- the agent definition has no explicit `sandbox:` block.

The value must be exactly `host`. Missing, misspelled, malformed, or unknown
values fail closed. The downgrade is never silent: every terminal run receipt
that used it contains this worker-controlled attestation:

```json
{
  "filesystemConfinement": {
    "status": "unconfined",
    "declared": "workspace-only",
    "fallback": "host",
    "source": "policy:sandbox.workspace_only_fallback"
  }
}
```

The worker writes this field after any agent-authored receipt data so the agent
cannot overwrite the audit marker.

## Operator procedure

1. Confirm Gondolin is unavailable with
   `bun event-runtime/cli.mjs sandbox doctor`.
2. Add the exact host fallback to the live `config/policy.yaml`.
3. Restart the event-runtime worker processes so they read the new policy.
4. Confirm the affected scan runs complete and their receipts say
   `filesystemConfinement.status: unconfined`.
5. Install the missing Gondolin/QEMU prerequisites, remove the fallback, restart
   workers, and confirm a sandboxed smoke run succeeds.

The tracked `config/policy.example.yaml` leaves the opt-out commented because
new installations must remain fail-closed by default. Factory follow-up #1259
tracks installing Gondolin/QEMU on the current operator runner so the interim
host fallback can be removed.
