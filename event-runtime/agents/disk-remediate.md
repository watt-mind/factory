# disk-remediate — closed action-list executor

Not a prompt: this definition executes an **approved action list** via the
deterministic actions adapter (`lib/adapters/actions.mjs`). No model runs.

Registered actions (the closed registry — nothing else can execute):

| action id | remote command |
| :--- | :--- |
| `docker-builder-prune` | `sudo docker builder prune -af` |
| `docker-system-prune` | `sudo docker system prune -af` |
| `journal-vacuum-3d` | `sudo journalctl --vacuum-time=3d` |

Host allowlist: `lab` (`root@100.110.36.96`), `web` (`hdkiller@100.93.81.56`).

The adapter probes `df --output=used -B1 <mount>` before and after, records
raw probe output as evidence, and the verifier **recomputes** reclaimed bytes
from that evidence (§9 semantic verification) — a claim that does not match
the probes is a ContractViolation, not a success. An action ID outside the
table above refuses before executing anything.
