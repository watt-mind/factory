import { API_HOST, DEFAULT_PORT } from "../lib/config.mjs";
import { CODE_RELOAD_EXIT } from "../lib/worker.mjs";

export const USAGE = `event-runtime — watched event → agent runtime (docs/event-runtime.md)

usage: bun event-runtime/cli.mjs <command>

  serve [--port N] [--adapter-override fake] [--watch] [--with-worker]
                                 start the control API (loopback) and planner
                                 in the foreground. Runs NO worker unless
                                 --with-worker (OPS-233) — start workers as
                                 separate "work" processes so serve restarts
                                 never kill a running agent.
                                 --watch restarts on event-runtime/ changes
  work [--label k=v ...] [--adapter-override fake] [--drain-timeout N]
       [--reload-on-change] [--drain-file PATH] [--worker-id ID]
                                 worker process: claim, execute, verify, and publish
                                 runs from the database
                                 --reload-on-change exits ${CODE_RELOAD_EXIT} for a supervisor to
                                 restart when event-runtime code changes, but
                                 only between claims (dev; see factory up --dev)
                                 --drain-file exits 0 once that file appears, at
                                 an idle poll boundary — never mid-run (WM-226)
  supervise [--workers min:max] [--interval-ms N] [--once]
                                 worker pool supervisor (WM-226): scales \`work\`
                                 processes between workers.min and workers.max
                                 from config/policy.yaml on observed queue depth.
                                 Scales down by draining, never by signalling a
                                 worker that holds a lease.
  status                         events, proposals, runs, anomalies
  doctor                         system health check: anomaly report (exits non-zero on anomalies)
  events [status]                admitted events, optionally filtered by status
  ps [state]                     running event processes/runs (default: RUNNING or LEASED)
  runs [state]                   runs (optionally filtered by state)
  proposals                      open proposals with TTL age
  inbox                          open items waiting on the human
  agents                         registered agent definitions and event routing
  workers                        worker processes: host, labels, state, heartbeat
  schedule                       recurring loops: cadence, approval, last fire, next due
  repos                          factory repos: team, base, dispatch vs report-only
  sandbox doctor                 Gondolin microVM sandbox availability (qemu, node, sdk)
  sandbox exec [--dir P] [--allow HOST]... [--secret NAME=ENVVAR]... [--shell]
              [--timeout S] -- <command>
                                 run a command inside a microVM: P mounted at
                                 /workspace, egress default-deny, secrets
                                 injected host-side (guest sees placeholders)
  approve <proposal-id>          approve an open proposal
  reject <proposal-id> <reason>  reject an open proposal
  inject <envelope.json|->       replay an event envelope (same intake as the webhook)
  requeue <source> <event-id>    re-plan a dead-lettered or human_needed event
  cancel <run-id> [reason]       cancel a run before it is RUNNING
  retry <run-id> [--force]       re-queue a FAILED run (--force past maxAttempts)
  extend <run-id> --seconds N [--override]
                                 extend a RUNNING/VERIFYING deadline (max 3600s per call)
  inspect <run-id>               spec, lifecycle journal, result, receipt, workspace
  trace <run-id>                 live agent trace: assistant text, tool calls, usage
  update-pins [--pack NAME]      re-pin built-in definitions, or one explicitly named pack

All commands except serve, work, supervise, and update-pins are clients of the control
API and need serve running on ${API_HOST}:${DEFAULT_PORT} (FACTORY_EVENT_PORT to change).`;
