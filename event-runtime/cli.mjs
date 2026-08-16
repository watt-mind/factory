#!/usr/bin/env bun
/**
 * Event-runtime CLI (docs/event-runtime.md §12–§13, §15).
 *
 *   bun event-runtime/cli.mjs serve          # control API + planner + one worker
 *   bun event-runtime/cli.mjs status         # ... and the other operator verbs
 *
 * `serve` is the runtime: the explicit foreground start (§3 — no timer, no
 * daemon) that binds the loopback control API and runs the watched
 * plan → propose → approve → execute loop with a single worker. Every other
 * verb except update-pins is a client of that API via lib/client.mjs — the
 * database is never a client interface (§12). update-pins is the one
 * deliberate exception: it edits agent definition files in the repo, not
 * runtime state.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import * as actions from "./lib/adapters/actions.mjs";
import * as claude from "./lib/adapters/claude.mjs";
import * as command from "./lib/adapters/command.mjs";
import * as fake from "./lib/adapters/fake.mjs";
import * as pi from "./lib/adapters/pi.mjs";
import { apiClient } from "./lib/client.mjs";
import {
  API_HOST, DEFAULT_PORT, FACTORY_ROOT, artifactsRoot, dbPath, ensureHome, environmentName, policyVersion, runtimeHome, workspacesRoot,
} from "./lib/config.mjs";
import { openDb } from "./lib/db.mjs";
import { newWorkerId } from "./lib/ids.mjs";
import { pruneArtifacts } from "./lib/artifacts.mjs";
import { publishOutbox } from "./lib/outbox.mjs";
import { autoApproveScheduled, emitDueTicks, scheduleView } from "./lib/schedules.mjs";
import { autoApproveChains } from "./lib/auto-approval.mjs";
import { worktreeDispatchAutoEligibility } from "./lib/planner.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { notifyPending } from "./lib/notify.mjs";
import { reconcileInbox } from "./lib/inbox.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { loadRegistry, updatePins } from "./lib/registry.mjs";
import { approveProposal } from "./lib/proposals.mjs";
import { startApi } from "./lib/api.mjs";
import {
  claimNext, CODE_RELOAD_EXIT, createReloadWatcher, executeClaimed, RELOAD_CHECK_INTERVAL_MS, runOnce,
} from "./lib/worker.mjs";
import { reapExpiredLeases } from "./lib/reaper.mjs";
import { preflight as sandboxPreflight, runInSandbox } from "./lib/sandbox/gondolin.mjs";
import {
  DEFAULT_POOL, deregisterWorker, heartbeat, loadWorkerPolicy, parsePoolSpec, poolCounts, poolDecision, registerWorker,
} from "./lib/workers.mjs";

const USAGE = `event-runtime — watched event → agent runtime (docs/event-runtime.md)

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
  inspect <run-id>               spec, lifecycle journal, result, receipt, workspace
  trace <run-id>                 live agent trace: assistant text, tool calls, usage
  update-pins                    re-pin agent definition content hashes (edits repo files)

All commands except serve, work, supervise, and update-pins are clients of the control
API and need serve running on ${API_HOST}:${DEFAULT_PORT} (FACTORY_EVENT_PORT to change).`;

const stamp = () => new Date().toISOString();
const log = (line) => console.log(`[${stamp()}] ${line}`);
const pad = (value, width) => String(value ?? "-").padEnd(width);

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Run one client verb; connection refusal names the fix, exactly (§12). */
async function withClient(fn) {
  const client = apiClient();
  try {
    await fn(client);
  } catch (err) {
    if (err.status === undefined) {
      fail(`control API not reachable on ${client.host}:${client.port} — start it with: bun event-runtime/cli.mjs serve`);
    }
    fail(err.message);
  }
}

// Artifact GC interval. Unreferenced bytes older than a week are pruned, but
// the serve loop only *attempts* that pass once an hour so a large store
// cannot hitch every 1s tick.
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const TICK_SUBSYSTEMS = ["tick emit", "plan", "auto-approve", "auto-approve-chains", "inbox", "notify", "outbox", "GC", "chains"];

/**
 * One serve-loop pass (OPS-412). Each named subsystem is caught on its own
 * so a throw in GC cannot skip chain resolution — or any other step.
 *
 * `subsystems` may replace a step by the names in TICK_SUBSYSTEMS; tests use
 * that to prove isolation. `storeRoot` defaults to `artifactsRoot()`.
 *
 * @returns {{ lastPrune: number }}
 */
export async function tick({
  db,
  registry,
  now = Date.now(),
  policyVersion: pv,
  adapterOverride,
  withWorker = false,
  adapters,
  owner,
  lastPrune = 0,
  pruneIntervalMs = PRUNE_INTERVAL_MS,
  storeRoot,
  log: logLine = log,
  announceProposals = () => {},
  announceTransitions = () => {},
  subsystems = {},
} = {}) {
  const runStep = async (name, fn) => {
    try {
      await (subsystems[name] ?? fn)();
    } catch (err) {
      logLine(`tick ${name}: ${err.message}`);
    }
  };

  await runStep("tick emit", () => {
    const ticks = emitDueTicks(db, registry, { now });
    for (const t of ticks.emitted) {
      logLine(`tick ${t.loop} @ ${t.slot}${t.skipped > 0 ? ` (stands for ${t.skipped} skipped slot(s))` : ""}`);
    }
    for (const err of ticks.errors) logLine(`schedule error: ${err}`);
  });

  await runStep("plan", () => {
    planAdmittedEvents(db, registry, { now, policyVersion: pv, adapterOverride });
  });

  await runStep("auto-approve", () => {
    const auto = autoApproveScheduled(db, registry, approveProposal, { now, policyVersion: pv });
    for (const a of auto.approved) logLine(`schedule approved ${a.loop} → run ${a.runId} (actor: schedule)`);
    for (const err of auto.errors) logLine(`schedule approval error: ${err}`);
  });

  await runStep("auto-approve-chains", () => {
    const auto = autoApproveChains(db, registry, {
      now,
      policyVersion: pv,
      dispatchEligibility: worktreeDispatchAutoEligibility,
      dispatch: db ? db : null,
    });
    for (const a of auto.approved) logLine(`chain proposal approved ${a.proposalId} → run ${a.runId} (actor: chain auto)`);
    for (const e of auto.errors) logLine(`chain approval error: ${e.proposalId}:${e.reason}`);
  });

  await runStep("announce", () => {
    announceProposals();
    announceTransitions();
  });

  // Referent state is authoritative: acknowledged or untouched items both
  // resolve automatically once the proposal/event no longer needs a human.
  await runStep("inbox", () => {
    reconcileInbox(db, { now });
  });

  // Push channel for states awaiting a human (WM-65): human_needed parks and
  // aging watched proposals. Off unless FACTORY_EVENT_NOTIFY=1; deliveries
  // are fire-and-forget so a slow or broken notifier cannot delay the tick.
  await runStep("notify", () => {
    notifyPending(db, { now, log: logLine });
  });

  await runStep("reap", () => {
    reapExpiredLeases(db, { now, policyVersion: pv });
  });

  if (withWorker) {
    await runStep("worker", async () => {
      await runOnce(db, registry, adapters, {
        workspacesRoot: workspacesRoot(), owner, now, policyVersion: pv,
        ...(adapterOverride ? { adapterOverride } : {}),
      });
    });
  }

  await runStep("announce-after", () => {
    announceTransitions();
  });

  await runStep("outbox", () => {
    publishOutbox(db, {
      sink: (e) => logLine(`result event ${e.type} (${e.eventId}) artifact ${e.payload?.artifactHash ?? "-"}`),
      now,
    });
  });

  let nextPrune = lastPrune;
  await runStep("GC", () => {
    if (now - lastPrune <= pruneIntervalMs) return;
    try {
      const pruned = pruneArtifacts(db, storeRoot ?? artifactsRoot(), { now });
      if (pruned.deleted > 0) logLine(`artifacts: pruned ${pruned.deleted} orphan(s), freed ${pruned.freedBytes}B`);
    } finally {
      nextPrune = now;
    }
  });

  await runStep("chains", () => {
    const chains = resolveChains(db, registry, { now });
    if (chains.emitted > 0) logLine(`chain: emitted ${chains.emitted} follow-up event(s) — planning`);
    for (const err of chains.errors) logLine(`chain error: ${err}`);
  });

  return { lastPrune: nextPrune };
}

// ---------------------------------------------------------------------------
// serve — the runtime itself (§3: explicit foreground start, one worker)
// ---------------------------------------------------------------------------

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function serveLockPath(home = runtimeHome()) {
  return path.join(home, "serve.pid");
}

export function acquireServeLock(home = runtimeHome(), port = DEFAULT_PORT) {
  const lockFile = serveLockPath(home);
  if (existsSync(lockFile)) {
    try {
      const content = JSON.parse(readFileSync(lockFile, "utf8"));
      const ownerPid = Number(content.pid);
      if (ownerPid && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
        throw new Error(
          `runtime home "${home}" is already locked by PID ${ownerPid} (port ${content.port ?? "unknown"})`,
        );
      }
    } catch (err) {
      if (err.message.includes("is already locked by PID")) throw err;
      // Stale or corrupt lock file — will be overwritten
    }
  }
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }),
    "utf8",
  );
  return { lockFile, pid: process.pid, port };
}

export function releaseServeLock(home = runtimeHome()) {
  const lockFile = serveLockPath(home);
  try {
    if (existsSync(lockFile)) {
      const content = JSON.parse(readFileSync(lockFile, "utf8"));
      if (Number(content.pid) === process.pid) {
        rmSync(lockFile, { force: true });
      }
    }
  } catch {
    // ignore
  }
}

function underBunWatch() {
  return process.execArgv.includes("--watch") || process.execArgv.includes("--hot");
}

/**
 * Re-exec under `bun --watch` so lib/ edits replace this process. In-flight
 * runs are dropped on purpose — a stale backend is worse during development.
 */
function watchServe(args) {
  const rest = args.filter((a) => a !== "--watch");
  log("serve --watch: restarting on event-runtime/ changes (in-flight runs are dropped)");
  const child = spawn(process.execPath, ["--watch", import.meta.path, "serve", ...rest], {
    stdio: "inherit",
    env: process.env,
  });
  const forward = (signal) => () => child.kill(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
  });
}

async function serve(args) {
  if (args.includes("--watch") && !underBunWatch()) return watchServe(args);

  const portFlag = flagValue(args, "--port");
  const rawPort = portFlag ?? process.env.FACTORY_EVENT_PORT ?? "7381";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`serve: invalid port "${rawPort}" (must be integer 1-65535)`);
  }
  const adapterOverride = flagValue(args, "--adapter-override") ?? undefined;
  const adapters = { actions, claude, command, fake, pi };
  if (adapterOverride && !adapters[adapterOverride]) {
    fail(`serve: unknown --adapter-override "${adapterOverride}" (have: ${Object.keys(adapters).join(", ")})`);
  }

  ensureHome();
  const home = runtimeHome();
  try {
    acquireServeLock(home, port);
  } catch (err) {
    fail(`serve: ${err.message}`);
  }

  const db = openDb();
  const registry = loadRegistry();
  const pv = policyVersion();
  const owner = newWorkerId();

  const seenProposals = new Set();
  let lastSeq = db.query(`SELECT MAX(seq) AS m FROM lifecycle_events`).get().m ?? 0;

  /** Print any open proposal not yet announced — §12: proposals render here. */
  function announceProposals() {
    for (const p of db.query(`SELECT * FROM proposals WHERE status = 'open' ORDER BY created_at, rowid`).all()) {
      if (seenProposals.has(p.id)) continue;
      seenProposals.add(p.id);
      const spec = p.spec_json ? JSON.parse(p.spec_json) : null;
      if (p.decision === "run") {
        log(`proposal ${p.id}  agent ${spec?.agent}  ttl ${p.ttl_seconds}s`);
        log(`  approve with: bun event-runtime/cli.mjs approve ${p.id}`);
      } else {
        log(`proposal ${p.id}  decision ${p.decision}  reason ${p.reason ?? "-"}`);
      }
    }
  }

  /** Narrate approvals, cancellations, and terminal states from the journal. */
  function announceTransitions() {
    const rows = db.query(`SELECT * FROM lifecycle_events WHERE seq > ? ORDER BY seq`).all(lastSeq);
    for (const row of rows) {
      lastSeq = row.seq;
      if (["APPROVED", "CANCELLED", "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT"].includes(row.to_state)) {
        log(`run ${row.run_id} → ${row.to_state} (${row.reason ?? "-"}) by ${row.actor}`);
      }
    }
  }

  // The worker is its own process now (OPS-233): restarting the API to
  // iterate must not kill a running agent. `--with-worker` restores the old
  // all-in-one behaviour for a quick single-process demo.
  const withWorker = args.includes("--with-worker");

  let lastPrune = Date.now();
  let busy = false;
  async function loopTick() {
    if (busy) return; // never overlap: planning and (optional) execution share this tick
    busy = true;
    try {
      const result = await tick({
        db,
        registry,
        policyVersion: pv,
        adapterOverride,
        withWorker,
        adapters,
        owner,
        lastPrune,
        log,
        announceProposals,
        announceTransitions,
      });
      lastPrune = result.lastPrune;
    } catch (err) {
      log(`tick error: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  const env = { name: environmentName(), home: runtimeHome(), adapter: adapterOverride ?? null };
  const server = startApi({
    db, registry, policyVersion: pv, port, env,
    onEvent: (kind) => {
      log(`event ${kind} — planning`);
      loopTick();
    },
  });
  server.on("listening", () => {
    log(`environment "${env.name}" — control API on http://${API_HOST}:${port} (db ${dbPath()}, policy ${pv})`);
    if (adapterOverride) log(`adapter override: all new run specs use "${adapterOverride}"`);
    if (!process.env.FACTORY_EVENT_SECRET) {
      log("webhook intake: disabled (FACTORY_EVENT_SECRET is unset; webhooks will be rejected with 401)");
    }
    if (!process.env.FACTORY_GITHUB_WEBHOOK_SECRET) {
      log("github intake: disabled (FACTORY_GITHUB_WEBHOOK_SECRET is unset; GitHub webhooks will be rejected with 401)");
    }
    log(
      withWorker
        ? "worker: in-process (--with-worker) — restarting serve interrupts running agents"
        : "worker: none in this process — start one with: bun event-runtime/cli.mjs work",
    );
  });
  server.on("error", (err) => {
    releaseServeLock(home);
    fail(`serve: ${err.message}`);
  });

  // The watched loop starts ONLY once the API actually owns its port. A serve
  // that lost the bind race must die, not keep planning and working the same
  // database as the serve that won — that is a second unmanaged worker and a
  // straight violation of the §3 single-worker cap. (Observed live: a portless
  // serve raced the real one and executed its runs with stale code.)
  let timer = null;
  server.on("listening", () => {
    announceProposals();
    timer = setInterval(loopTick, 1000);
  });

  // SIGTERM is what `bun --watch` sends on reload; without a close the next
  // process loses the bind race on 7381.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${signal})`);
    if (timer) clearInterval(timer);
    releaseServeLock(home);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => releaseServeLock(home));
}

// ---------------------------------------------------------------------------
// work — the worker process (OPS-233; docs/event-runtime-workers.md §2)
// ---------------------------------------------------------------------------

/**
 * A worker owns exactly one thing: claim → execute → verify → publish. It
 * never serves the API and never plans, so `serve` can restart under it
 * freely — the whole point of the split. It talks to the same database, and
 * on one machine SQLite (WAL + BEGIN IMMEDIATE claims) makes concurrent
 * claiming correct; Postgres is what remote nodes need, not this.
 *
 *   bun event-runtime/cli.mjs work [--label k=v ...] [--adapter-override fake] [--poll-ms 500]
 *                                 [--reload-on-change]
 */
async function work(args) {
  const adapterOverride = flagValue(args, "--adapter-override") ?? undefined;
  const pollMs = Number(flagValue(args, "--poll-ms") ?? 500);
  if (!Number.isInteger(pollMs) || pollMs < 25 || pollMs > 5_000) {
    fail("work: --poll-ms must be an integer between 25 and 5000");
  }
  const adapters = { actions, claude, command, fake, pi };
  if (adapterOverride && !adapters[adapterOverride]) {
    fail(`work: unknown --adapter-override "${adapterOverride}" (have: ${Object.keys(adapters).join(", ")})`);
  }

  // --label node=lab --label can=infra-exec  → placement (§4)
  const labels = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--label") continue;
    const [key, ...rest] = String(args[i + 1] ?? "").split("=");
    if (!key || rest.length === 0) fail("work: --label expects key=value");
    labels[key] = rest.join("=");
  }

  // Pool supervision (WM-226). The drain file is the scale-down signal: the
  // supervisor creates it, this worker leaves when it next reaches an idle poll
  // boundary, and a run in flight is finished first — that boundary IS the
  // guarantee that no leased worker is ever cut off. --worker-id lets the
  // supervisor name the row it just spawned instead of guessing which of N
  // registry entries belongs to which slot.
  const drainFile = flagValue(args, "--drain-file") ?? null;

  // Advertise sandbox capability only when this host can actually honour it
  // (WM-185). Placement matches on labels, so claiming `sandbox=gondolin`
  // without a working hypervisor would route sandboxed runs here purely to
  // fail them. An operator-supplied --label always wins, so the capability
  // can be forced off for a node under investigation.
  const sandboxReport = sandboxPreflight();
  if (labels.sandbox === undefined && sandboxReport.available) {
    labels.sandbox = "gondolin";
  }

  ensureHome();
  const db = openDb();
  const registry = loadRegistry();
  const pv = policyVersion();
  const workerId = flagValue(args, "--worker-id") ?? newWorkerId();
  const adapterNames = adapterOverride ? [adapterOverride] : Object.keys(adapters);

  registerWorker(db, { workerId, labels, adapters: adapterNames });
  log(`worker ${workerId} on ${hostname()} (db ${dbPath()}, policy ${pv})`);
  if (Object.keys(labels).length > 0) log(`labels: ${JSON.stringify(labels)}`);
  if (!sandboxReport.available) log(`sandbox: unavailable — ${sandboxReport.reason}`);
  if (adapterOverride) log(`adapter override: executing every run with "${adapterOverride}"`);
  if (drainFile) log(`drain-file: ${drainFile} (supervised worker — exits 0 when it appears, between claims)`);

  let draining = false;
  let inFlight = null;

  // Dev live-reload (WM-213). Off unless asked for: a production worker must
  // never decide on its own that it is out of date.
  const watcher = args.includes("--reload-on-change") ? createReloadWatcher() : null;
  if (watcher) log(`reload-on-change: armed at code stamp ${watcher.from} (reloads only between claims)`);

  // The heartbeat runs on its own timer, NOT inside the claim loop: that loop
  // blocks for the whole duration of an agent run (up to the spec timeout),
  // so a loop-driven heartbeat would mark every legitimately busy worker as
  // stale — and the doctor's "stalled worker" check exists precisely to tell
  // busy apart from dead.
  const beat = setInterval(
    () => heartbeat(db, workerId, { state: inFlight ? "busy" : "idle", runId: inFlight }),
    15_000,
  );
  beat.unref?.();

  /**
   * True when this worker should exit for a supervisor to restart it. Consulted
   * from two places for one reason each: the timer notices a change *during* a
   * run so the deferral is logged while it is still true, and the loop top is
   * the idle boundary where acting on it is safe.
   */
  function reloadWanted() {
    if (!watcher || draining) return false;
    const r = watcher.check(inFlight);
    if (r.action === "deferred") {
      if (r.first) log(`code changed (${r.from} → ${r.to}) — reload deferred until ${r.runId} finishes`);
      return false;
    }
    if (r.action === "reload") {
      log(`code changed (${r.from} → ${r.to}) — reloading worker (exit ${CODE_RELOAD_EXIT})`);
      return true;
    }
    return false;
  }

  async function loop() {
    while (!draining) {
      try {
        if (reloadWanted()) return finish("code_reload", CODE_RELOAD_EXIT);
        // Checked here and only here: the loop top is the one place where
        // nothing is in flight, so leaving from it cannot interrupt a run.
        if (drainFile && existsSync(drainFile)) {
          log(`drain requested (${drainFile}) — stopping at idle poll boundary`);
          return finish("drain_requested");
        }
        heartbeat(db, workerId, { state: inFlight ? "busy" : "idle", runId: inFlight });
        const claim = claimNext(db, {
          owner: workerId, policyVersion: pv, labels,
          adapters: adapterOverride ? null : adapterNames,
          ...(adapterOverride ? { adapterOverride } : {}),
        });
        if (!claim) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        inFlight = claim.runId;
        heartbeat(db, workerId, { state: "busy", runId: claim.runId });
        log(`claimed ${claim.runId} attempt ${claim.attempt} (${claim.spec.agent})`);
        const summary = await executeClaimed(db, registry, adapters, claim, {
          workspacesRoot: workspacesRoot(), policyVersion: pv,
          ...(adapterOverride ? { adapterOverride } : {}),
        });
        log(`${claim.runId} → ${summary?.terminalState ?? "?"} (${summary?.reasonCode ?? "-"})`);
      } catch (err) {
        log(`worker error: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } finally {
        inFlight = null;
      }
    }
  }

  // Graceful drain: stop claiming, let the attempt in flight finish — the
  // agent subprocess keeps its own timeout discipline, and killing it here
  // would be the interruption this split exists to prevent.
  //
  // Bounded, though: waiting out a 10-minute agent run trains operators to
  // SIGKILL, which orphans the agent AND leaves a lying registry row. After
  // the grace period the worker leaves honestly and says what happens next —
  // the lease expires and the reaper requeues the run.
  const drainTimeoutMs = Number(flagValue(args, "--drain-timeout") ?? 60) * 1000;
  const finish = (reason, code = 0) => {
    clearInterval(beat);
    deregisterWorker(db, workerId);
    log(`worker stopped (${reason})`);
    process.exit(code);
  };

  // Armed only after `finish` exists — this timer is the path that notices a
  // change while a run is in flight, which is where the deferral line comes from.
  if (watcher) {
    const reloadTimer = setInterval(() => {
      if (reloadWanted()) finish("code_reload", CODE_RELOAD_EXIT);
    }, RELOAD_CHECK_INTERVAL_MS);
    reloadTimer.unref?.();
  }
  const drain = (signal) => {
    if (draining) {
      // A second signal means "now": the operator has decided.
      log("second signal — leaving immediately");
      return finish("forced");
    }
    draining = true;
    if (!inFlight) return finish(signal);
    log(`draining (${signal}) — finishing ${inFlight}, up to ${drainTimeoutMs / 1000}s`);
    const deadline = Date.now() + drainTimeoutMs;
    const poll = setInterval(() => {
      if (!inFlight) {
        clearInterval(poll);
        return finish(signal);
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        log(`drain timeout — leaving ${inFlight} to its lease; the reaper will requeue it`);
        finish("drain_timeout");
      }
    }, 250);
  };
  process.on("SIGINT", () => drain("SIGINT"));
  process.on("SIGTERM", () => drain("SIGTERM"));

  await loop();
}

// ---------------------------------------------------------------------------
// supervise — the worker pool supervisor (WM-226; workers doc §2a)
// ---------------------------------------------------------------------------

/** Where daemons keep their pidfiles and logs — the same dir bin/live-stack.sh uses. */
export function runDir() {
  return process.env.FACTORY_RUN_DIR || path.join(homedir(), ".factory", "run");
}

/** One pool slot's four files. The run dir IS the supervisor's durable state. */
export function slotFiles(dir, n) {
  return {
    pid: path.join(dir, `worker-${n}.pid`),
    drain: path.join(dir, `worker-${n}.drain`),
    log: path.join(dir, `worker-${n}.log`),
    id: path.join(dir, `worker-${n}.id`),
  };
}

/** Signal 0 probes without delivering: EPERM still proves the process exists. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readFileTrimmed(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function readPidFile(file) {
  const n = Number(readFileTrimmed(file));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The pool as the filesystem sees it. Deliberately derived from pidfiles rather
 * than from supervisor memory: workers are spawned detached, so a supervisor
 * that restarts (or a `factory events status` run by a human) reads the same
 * truth, and a control-plane restart adopts the running pool instead of
 * killing capacity.
 */
export function readPool(dir = runDir()) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const slots = [];
  for (const name of names) {
    const m = /^worker-(\d+)\.pid$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    const files = slotFiles(dir, n);
    const pid = readPidFile(files.pid);
    slots.push({
      n, pid,
      alive: pidAlive(pid),
      draining: existsSync(files.drain),
      workerId: readFileTrimmed(files.id),
    });
  }
  slots.sort((a, b) => a.n - b.n);
  const supervisorPid = readPidFile(path.join(dir, "supervisor.pid"));
  return {
    supervisor: supervisorPid === null ? null : { pid: supervisorPid, alive: pidAlive(supervisorPid) },
    slots,
    size: slots.filter((s) => s.alive).length,
  };
}

/**
 * A worker takes a second or two to boot and register. Within this window a
 * freshly spawned slot counts as `pending` rather than as missing capacity —
 * without it every tick during a spawn sees "queued work, nothing idle" and
 * spawns again, straight to max, for a single queued run.
 */
export const SPAWN_GRACE_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pool supervisor: a deterministic loop that maintains
 * `workers.min ≤ pool ≤ workers.max` from observed queue depth. It is its own
 * process, not part of `serve`, so restarting the control plane never touches
 * capacity — and it scales DOWN only by asking a worker to drain, never by
 * signalling one that might hold a lease.
 *
 *   bun event-runtime/cli.mjs supervise [--workers 1:3] [--interval-ms 2000] [--once]
 */
async function supervise(args) {
  const dir = runDir();
  mkdirSync(dir, { recursive: true });

  let bounds;
  try {
    const spec = flagValue(args, "--workers");
    bounds = spec ? parsePoolSpec(spec) : (loadWorkerPolicy() ?? { ...DEFAULT_POOL });
  } catch (err) {
    return fail(`supervise: ${err.message}`);
  }

  const intervalMs = Number(flagValue(args, "--interval-ms") ?? 2_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    return fail("supervise: --interval-ms must be an integer between 100 and 60000");
  }
  const drainTimeoutMs = Number(flagValue(args, "--drain-timeout") ?? 60) * 1000;
  const spawnGraceMs = Number(flagValue(args, "--spawn-grace-ms") ?? SPAWN_GRACE_MS);
  if (!Number.isInteger(spawnGraceMs) || spawnGraceMs < 0) {
    return fail("supervise: --spawn-grace-ms must be a non-negative integer");
  }
  const once = args.includes("--once");

  // Whatever shapes a worker gets handed straight through, so a supervised pool
  // is configured exactly like the single worker it replaces.
  const passthrough = [];
  for (const flag of ["--adapter-override", "--poll-ms", "--drain-timeout"]) {
    const v = flagValue(args, flag);
    if (v !== null && v !== undefined) passthrough.push(flag, v);
  }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--label") passthrough.push("--label", String(args[i + 1] ?? ""));
  }

  // One supervisor per run dir. Two would allocate the same slot numbers and
  // silently orphan each other's workers — pidfiles overwritten, processes
  // still running, nothing able to drain them.
  const supervisorPidFile = path.join(dir, "supervisor.pid");
  const incumbent = readPool(dir).supervisor;
  if (incumbent?.alive && incumbent.pid !== process.pid) {
    return fail(`supervise: a supervisor is already running for ${dir} (pid ${incumbent.pid}) — stop it first, or point FACTORY_RUN_DIR elsewhere`);
  }

  ensureHome();
  const db = openDb();
  writeFileSync(supervisorPidFile, `${process.pid}\n`);

  log(`supervisor ${process.pid} — workers min ${bounds.min}, max ${bounds.max}, tick ${intervalMs}ms (run dir ${dir})`);

  const spawnedAt = new Map();

  function releaseSlot(n) {
    const files = slotFiles(dir, n);
    for (const f of [files.pid, files.drain, files.id]) rmSync(f, { force: true });
    spawnedAt.delete(n);
  }

  function spawnSlot(n) {
    const files = slotFiles(dir, n);
    // Never inherit the previous tenant's drain flag: a fresh worker that finds
    // one exits immediately and the pool silently refuses to grow.
    rmSync(files.drain, { force: true });
    const workerId = newWorkerId();
    const out = openSync(files.log, "a");
    const child = spawn(
      process.execPath,
      [import.meta.path, "work", ...passthrough, "--worker-id", workerId, "--drain-file", files.drain],
      { cwd: FACTORY_ROOT, detached: true, stdio: ["ignore", out, out], env: process.env },
    );
    child.unref();
    closeSync(out);
    writeFileSync(files.pid, `${child.pid}\n`);
    writeFileSync(files.id, `${workerId}\n`);
    spawnedAt.set(n, Date.now());
    return { pid: child.pid, workerId, log: files.log };
  }

  /**
   * Prefer a slot the registry says is idle, so the common case drains a worker
   * that is doing nothing. Falling back to the highest slot is safe rather than
   * merely convenient: the flag is only read at an idle poll boundary, so even
   * a wrong guess finishes its run before leaving.
   */
  function chooseDrainSlot(alive, idleWorkerIds) {
    const candidates = alive.filter((s) => !s.draining);
    if (candidates.length === 0) return null;
    const idle = [...candidates].reverse().find((s) => s.workerId && idleWorkerIds.has(s.workerId));
    return idle ?? candidates[candidates.length - 1];
  }

  let lastHold = null;

  function tick() {
    const now = Date.now();
    for (const s of readPool(dir).slots) {
      if (s.alive) continue;
      log(`slot ${s.n} (worker ${s.workerId ?? "?"}, pid ${s.pid ?? "?"}) exited — slot released`);
      releaseSlot(s.n);
    }

    const alive = readPool(dir).slots.filter((s) => s.alive);
    const observed = poolCounts(db, { now });
    const pending = alive.filter((s) => now - (spawnedAt.get(s.n) ?? 0) < spawnGraceMs).length;
    const draining = alive.filter((s) => s.draining).length;
    const decision = poolDecision({
      queued: observed.queued, idle: observed.idle, pool: alive.length, pending, draining,
      min: bounds.min, max: bounds.max,
    });
    const counts = `queued=${observed.queued} idle=${observed.idle} busy=${observed.busy} pool=${alive.length} pending=${pending} draining=${draining} min=${bounds.min} max=${bounds.max}`;

    if (decision.action === "spawn") {
      const taken = new Set(alive.map((s) => s.n));
      let slot = 1;
      while (taken.has(slot)) slot += 1;
      if (slot > bounds.max) {
        log(`hold — no free slot below max ${bounds.max} [${counts}]`);
        return decision;
      }
      const { pid, workerId, log: logFile } = spawnSlot(slot);
      log(`spawn slot ${slot} → worker ${workerId} pid ${pid} (${logFile}): ${decision.reason} [${counts}]`);
      lastHold = null;
      return decision;
    }

    if (decision.action === "drain") {
      const target = chooseDrainSlot(alive, observed.idleWorkerIds);
      if (!target) {
        log(`hold — every live slot is already draining [${counts}]`);
        return decision;
      }
      writeFileSync(slotFiles(dir, target.n).drain, `scale-down ${new Date(now).toISOString()}\n`);
      log(`drain slot ${target.n} (worker ${target.workerId ?? "?"}): ${decision.reason} [${counts}] — it exits at its next idle poll boundary, never mid-run`);
      lastHold = null;
      return decision;
    }

    // Holding is the steady state; logging it every tick would bury the two
    // decisions that matter. Only the transition is news.
    if (decision.reason !== lastHold) {
      log(`hold — ${decision.reason} [${counts}]`);
      lastHold = decision.reason;
    }
    return decision;
  }

  if (once) {
    tick();
    rmSync(supervisorPidFile, { force: true });
    return;
  }

  let stopping = false;
  const timer = setInterval(tick, intervalMs);
  tick();

  /**
   * Shutdown escalates, and every step short of the last is a request rather
   * than a kill: drain flags → SIGTERM (which starts each worker's OWN bounded
   * graceful drain) → leave the stragglers to their leases and say so. The
   * reaper requeues whatever a lease outlives; a SIGKILL here would orphan an
   * agent process and leave a lying registry row instead.
   */
  const shutdown = async (signal) => {
    if (stopping) {
      log("second signal — leaving the pool to finish on its own");
      rmSync(supervisorPidFile, { force: true });
      process.exit(0);
    }
    stopping = true;
    clearInterval(timer);
    const alive = readPool(dir).slots.filter((s) => s.alive);
    log(`${signal} — draining ${alive.length} worker(s); anything holding a lease finishes its run first`);
    for (const s of alive) writeFileSync(slotFiles(dir, s.n).drain, `${signal}\n`);

    const waitFor = async (deadline) => {
      while (Date.now() < deadline && readPool(dir).slots.some((s) => s.alive)) await sleep(200);
      return readPool(dir).slots.filter((s) => s.alive);
    };

    let left = await waitFor(Date.now() + drainTimeoutMs);
    if (left.length > 0) {
      log(`${left.length} worker(s) still busy after ${drainTimeoutMs / 1000}s — SIGTERM (each runs its own bounded drain)`);
      for (const s of left) {
        try {
          process.kill(s.pid, "SIGTERM");
        } catch {
          // already gone between the read and the signal
        }
      }
      left = await waitFor(Date.now() + drainTimeoutMs);
    }
    if (left.length > 0) {
      log(`${left.length} worker(s) did not exit — leaving them to their leases; the reaper will requeue`);
    } else {
      log("pool drained — supervisor stopping");
    }
    for (const s of readPool(dir).slots) if (!s.alive) releaseSlot(s.n);
    rmSync(supervisorPidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Nothing else keeps this process alive: the interval is the loop.
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// operator verbs — clients of the control API (§12–§13)
// ---------------------------------------------------------------------------

function countLine(label, counts, order = Object.keys(counts)) {
  const parts = order.map((k) => `${k} ${counts[k] ?? 0}`);
  return `${pad(label, 11)}${parts.join("   ")}`;
}

function spendLine(label, usage) {
  const cost = Number(usage?.costUSD ?? 0);
  return `${pad(label, 11)}${usage?.totalTokens ?? 0} tokens   input ${usage?.inputTokens ?? 0}   output ${usage?.outputTokens ?? 0}   cache-write ${usage?.cacheCreationInputTokens ?? 0}   cache-read ${usage?.cacheReadInputTokens ?? 0}   $${cost.toFixed(4)}`;
}

export function getAnomalyLines(s) {
  const a = s?.anomalies ?? {};
  const anomalyLines = [];
  for (const id of a.expiredOpenProposals ?? []) anomalyLines.push(`expired open proposal ${id}`);
  if (a.staleLeases > 0) anomalyLines.push(`stale leases: ${a.staleLeases}`);
  if (a.unpublishedOutbox > 0) anomalyLines.push(`unpublished outbox rows: ${a.unpublishedOutbox}`);
  for (const d of a.deadLettered ?? []) anomalyLines.push(`dead-lettered (${d.source}, ${d.eventId}): ${d.lastError}`);
  for (const amb of a.ambiguousOpenProposals ?? []) {
    anomalyLines.push(`ambiguous open proposals for run ${amb.runId}: ${amb.count} open proposals exist for one run`);
  }
  for (const w of a.stalledWorkers ?? []) {
    anomalyLines.push(
      `stalled worker ${w.workerId}${w.host ? ` on ${w.host}` : ""}${w.runId ? ` holding run ${w.runId}` : ""}${w.lastSeen ? ` (last seen ${w.lastSeen})` : ""}`,
    );
  }
  for (const sc of a.stoppedSchedules ?? []) {
    anomalyLines.push(
      `stopped schedule ${sc.loop}: ${sc.error ? `error: ${sc.error}` : `${sc.intervalsLate ?? "unknown"} intervals late`}`,
    );
  }
  for (const p of a.proposalsPilingUp ?? []) {
    anomalyLines.push(
      `proposals piling up for schedule ${p.loop}: ${p.count} open proposals exist (threshold ${p.threshold})`,
    );
  }
  if (a.noWorkers) anomalyLines.push("no live workers with queued runs");
  if (a.unreferencedArtifacts > 0) {
    anomalyLines.push(`unreferenced artifacts: ${a.unreferencedArtifacts}`);
  } else if (s?.artifacts?.orphans > 0) {
    anomalyLines.push(`unreferenced artifacts: ${s.artifacts.orphans} (${s.artifacts.orphanBytes ?? 0}B)`);
  }
  if (Array.isArray(a.orphanedWorkspaces)) {
    for (const ws of a.orphanedWorkspaces) anomalyLines.push(`orphaned workspace: ${ws}`);
  } else if (a.orphanedWorkspaces > 0) {
    anomalyLines.push(`orphaned workspaces: ${a.orphanedWorkspaces}`);
  } else if (Array.isArray(a.orphanWorkspaces)) {
    for (const ws of a.orphanWorkspaces) anomalyLines.push(`orphaned workspace: ${ws}`);
  } else if (a.orphanWorkspaces > 0) {
    anomalyLines.push(`orphaned workspaces: ${a.orphanWorkspaces}`);
  }

  const handledKeys = new Set([
    "expiredOpenProposals", "staleLeases", "unpublishedOutbox", "deadLettered",
    "ambiguousOpenProposals", "stalledWorkers", "stoppedSchedules", "noWorkers",
    "unreferencedArtifacts", "orphanedWorkspaces", "orphanWorkspaces", "orphans", "orphanArtifacts",
    "proposalsPilingUp",
  ]);

  for (const [key, val] of Object.entries(a)) {
    if (handledKeys.has(key)) continue;
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        anomalyLines.push(`${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`);
      }
    } else if (typeof val === "number" && val > 0) {
      anomalyLines.push(`${key}: ${val}`);
    } else if (typeof val === "boolean" && val) {
      anomalyLines.push(`${key}`);
    } else if (typeof val === "string" && val.length > 0) {
      anomalyLines.push(`${key}: ${val}`);
    } else if (typeof val === "object" && Object.keys(val).length > 0) {
      anomalyLines.push(`${key}: ${JSON.stringify(val)}`);
    }
  }

  return anomalyLines;
}

/**
 * The pool, as this machine's run dir reports it (WM-226). Read locally rather
 * than through the control API on purpose: pidfile liveness is node-local state
 * the API has no way to see, and the supervisor is deliberately not part of
 * `serve`. Nothing is printed when no pool was ever started, so a plain
 * single-worker stack looks exactly as it did before.
 */
export function getPoolLines(pool, s) {
  const started = pool?.supervisor !== null && pool?.supervisor !== undefined;
  if (!started && (pool?.slots?.length ?? 0) === 0) return { line: null, anomalies: [] };

  const sup = pool.supervisor;
  const supText = !sup ? "absent" : sup.alive ? `live (pid ${sup.pid})` : `DEAD (stale pid ${sup.pid})`;
  const draining = pool.slots.filter((sl) => sl.alive && sl.draining).length;
  const line = `${pad("pool", 11)}supervisor ${supText}   workers ${pool.size}${draining > 0 ? ` (${draining} draining)` : ""}`;

  // §13's shape of anomaly: work waiting with nothing left that can grow the
  // pool. The queue is not stuck yet — the live workers may still drain it —
  // but nothing will scale up behind them, and that is what an operator wants
  // told rather than discovered.
  const queued = s?.runs?.byState?.QUEUED ?? 0;
  const anomalies = [];
  if (sup && !sup.alive && queued > 0) {
    anomalies.push(`worker pool supervisor is dead (stale pid ${sup.pid}) with ${queued} queued run(s)`);
  }
  return { line, anomalies };
}

export async function status(client) {
  const s = await client.status();
  if (s.env) {
    console.log(`${pad("env", 11)}${s.env.name}${s.env.adapter ? `   (adapter override: ${s.env.adapter})` : ""}   ${s.env.home}`);
  }
  console.log(countLine("events", s.events, ["admitted", "planned", "noop", "human_needed", "dead_lettered"]));
  console.log(countLine("proposals", s.proposals, ["open", "expired"]));
  if (s.inbox) console.log(countLine("inbox", s.inbox, ["open", "acked"]));
  const states = Object.keys(s.runs.byState);
  console.log(states.length ? countLine("runs", s.runs.byState, states) : `${pad("runs", 11)}none`);
  const spend = s.runs?.spend;
  if (spend) {
    console.log(spendLine("spend 1h", spend.rolling1h));
    console.log(spendLine("spend 24h", spend.rolling24h));
    for (const row of spend.byAgent24h ?? []) {
      console.log(spendLine(`  ${row.agent}`, row));
    }
  }
  const pool = getPoolLines(readPool(), s);
  if (pool.line) console.log(pool.line);
  const anomalyLines = [...getAnomalyLines(s), ...pool.anomalies];
  if (anomalyLines.length === 0) console.log(`${pad("anomalies", 11)}none`);
  else for (const line of anomalyLines) console.log(`${pad("anomalies", 11)}${line}`);
  return anomalyLines;
}

export async function doctor(client) {
  const anomalyLines = await status(client);
  if (anomalyLines.length > 0) {
    process.exit(1);
  }
}

async function events(client, statusFilter) {
  const { events: rows } = await client.events(statusFilter);
  if (rows.length === 0) {
    console.log(statusFilter ? `no events with status ${statusFilter}` : "no events");
    return;
  }
  console.log(`${pad("SOURCE", 16)}${pad("EVENT", 24)}${pad("TYPE", 36)}${pad("STATUS", 14)}${pad("ADMITTED", 26)}ERROR`);
  for (const e of rows) {
    console.log(
      `${pad(e.source, 16)}${pad(e.eventId, 24)}${pad(e.type, 36)}${pad(e.status, 14)}${pad(e.admittedAt, 26)}${e.lastPlanError ?? "-"}`,
    );
  }
}

async function runs(client, stateFilter) {
  const { runs: rows } = await client.runs(stateFilter);
  if (rows.length === 0) {
    console.log(stateFilter ? `no runs with state ${stateFilter}` : "no runs");
    return;
  }
  console.log(`${pad("RUN ID", 42)}${pad("STATE", 12)}${pad("AGENT", 26)}${pad("ADAPTER", 12)}${pad("ATTEMPTS", 10)}${pad("ORIGIN EVENT", 24)}UPDATED`);
  for (const r of rows) {
    console.log(
      `${pad(r.runId, 42)}${pad(r.state, 12)}${pad(r.agent, 26)}${pad(r.adapter, 12)}${pad(`${r.attempts}/${r.maxAttempts}`, 10)}${pad(r.eventId ?? "-", 24)}${r.updated_at}`,
    );
  }
}

async function ps(client, stateFilter) {
  const { runs: rows } = await client.runs();
  const filtered = stateFilter
    ? rows.filter((r) => r.state.toUpperCase() === stateFilter.toUpperCase())
    : rows.filter((r) => r.state === "RUNNING" || r.state === "LEASED");

  if (filtered.length === 0) {
    console.log(stateFilter ? `no process runs with state ${stateFilter}` : "no running processes");
    return;
  }
  console.log(`${pad("RUN ID", 42)}${pad("STATE", 12)}${pad("AGENT", 26)}${pad("ADAPTER", 12)}${pad("ATTEMPTS", 10)}${pad("ORIGIN EVENT", 24)}UPDATED`);
  for (const r of filtered) {
    console.log(
      `${pad(r.runId, 42)}${pad(r.state, 12)}${pad(r.agent, 26)}${pad(r.adapter, 12)}${pad(`${r.attempts}/${r.maxAttempts}`, 10)}${pad(r.eventId ?? "-", 24)}${r.updated_at}`,
    );
  }
}

async function proposals(client) {
  const { proposals: open } = await client.proposals();
  if (open.length === 0) {
    console.log("no open proposals");
    return;
  }
  console.log(`${pad("ID", 42)}${pad("DECISION", 14)}${pad("AGENT", 26)}${pad("TTL", 8)}${pad("EXPIRED", 9)}REASON`);
  for (const p of open) {
    console.log(
      `${pad(p.id, 42)}${pad(p.decision, 14)}${pad(p.agent, 26)}${pad(`${p.ttl_seconds}s`, 8)}${pad(p.expired ? "yes" : "no", 9)}${p.reason ?? "-"}`,
    );
  }
  console.log(`\napprove with: bun event-runtime/cli.mjs approve <id>`);
}

async function inbox(client) {
  const res = await fetch(`http://${client.host}:${client.port}/inbox?status=open`);
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (body.items.length === 0) {
    console.log("no open inbox items");
    return;
  }
  console.log(`${pad("ID", 44)}${pad("KIND", 18)}${pad("SEVERITY", 11)}${pad("CREATED", 26)}TITLE`);
  for (const item of body.items) {
    console.log(`${pad(item.id, 44)}${pad(item.kind, 18)}${pad(item.severity, 11)}${pad(item.createdAt, 26)}${item.title}`);
  }
}

async function inspect(client, runId) {
  const view = await client.run(runId);
  const { run } = view;
  console.log(`run        ${run.runId}`);
  console.log(`state      ${run.state}   attempts ${run.attempts}/${run.spec.maxAttempts}`);
  console.log(`agent      ${run.spec.agent}   adapter ${run.spec.adapter}   contract ${run.spec.outputContract}`);
  console.log(`created    ${run.created_at}   updated ${run.updated_at}`);
  console.log(`workspace  ${view.workspace ?? "-"}`);
  if (view.usage) {
    console.log("\nusage");
    console.log(`  ${spendLine("total", view.usage.totals).trimStart()}`);
    for (const row of view.usage.attempts ?? []) {
      console.log(`  ${spendLine(`attempt ${row.attempt}`, row).trimStart()}   model ${row.model ?? "-"}   adapter ${row.adapter}`);
    }
  }
  console.log("\nlifecycle");
  for (const e of view.lifecycle) {
    console.log(`  ${pad(e.at, 26)}${pad(`${e.from_state ?? "·"} → ${e.to_state}`, 26)}${pad(e.actor, 24)}${e.reason ?? ""}`);
  }
  if (view.result) {
    console.log("\nresult");
    console.log(`  terminalState ${view.result.terminalState}   reason ${view.result.reasonCode ?? "-"}`);
    if (view.result.artifact !== undefined) console.log(`  artifact ${JSON.stringify(view.result.artifact)}`);
  }
  if (view.receipt) {
    console.log("\nreceipt");
    for (const [k, v] of Object.entries(view.receipt)) console.log(`  ${pad(k, 20)}${v ?? "-"}`);
  }
  if (view.result?.artifacts?.length) {
    console.log("\nartifacts");
    for (const a of view.result.artifacts) {
      console.log(`  ${pad(a.kind, 14)}${pad(a.sizeBytes != null ? `${a.sizeBytes}B` : "-", 10)}${pad(a.sha256, 66)}${a.uri}`);
    }
  }
}

/** One line of `trace` output: kind-aware payload summary, single line. */
function traceSummary(e) {
  const clip = (value, n = 120) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  const p = e.payload ?? {};
  switch (e.kind) {
    case "assistant_text":
      return clip(p.text);
    case "tool_use":
      return `${p.name ?? "?"} ${clip(JSON.stringify(p.input ?? {}), 100)}`;
    case "tool_result":
      return `${p.isError ? "ERROR " : ""}${clip(p.content)}`;
    case "usage":
      return `${p.durationMs ?? "-"}ms   turns ${p.numTurns ?? "-"}   $${p.costUSD ?? "-"}`;
    default:
      return clip(JSON.stringify(p));
  }
}

/** Live agent trace (factory.trace/v1): what the agent said and ran. */
async function trace(client, runId) {
  const view = await client.trace(runId, { limit: 500 });
  if (view.entries.length === 0) {
    console.log(`no trace recorded for run ${runId}`);
    return;
  }
  for (const e of view.entries) {
    console.log(`[${e.ts}] ${pad(e.kind, 16)}${traceSummary(e)}`);
  }
}

async function workers(client) {
  const { workers: rows } = await client.workers();
  if (rows.length === 0) {
    console.log("no workers have registered — start one with: bun event-runtime/cli.mjs work");
    return;
  }
  console.log(`${pad("WORKER", 26)}${pad("HOST", 18)}${pad("STATE", 10)}${pad("LABELS", 24)}${pad("CURRENT RUN", 42)}LAST SEEN`);
  for (const w of rows) {
    const state = w.stale ? `${w.state}!stale` : w.state;
    const labels = Object.entries(w.labels).map(([k, v]) => `${k}=${v}`).join(",") || "-";
    console.log(`${pad(w.workerId, 26)}${pad(w.host, 18)}${pad(state, 10)}${pad(labels, 24)}${pad(w.currentRun ?? "-", 42)}${w.lastSeen}`);
  }
}

/**
 * The factory repo registry (OPS-299). MODE is the column an operator actually
 * scans for — a report-only repo is one the loop reports on but never dispatches
 * to — and CLEANUP says whether the janitor has a teardown script to call.
 */
async function repos(client) {
  const { repos: rows } = await client.repos();
  if (rows.length === 0) {
    console.log("no repos in config/repos.yaml");
    return;
  }
  console.log(`${pad("REPO", 16)}${pad("TEAM", 6)}${pad("MODE", 12)}${pad("BASE", 10)}${pad("DEPLOY", 10)}${pad("CAP", 5)}${pad("CLEANUP", 9)}WORKTREE ROOT`);
  for (const r of rows) {
    console.log(
      `${pad(r.name, 16)}${pad(r.team, 6)}${pad(r.reportOnly ? "report-only" : "dispatch", 12)}${pad(r.base, 10)}${pad(r.deployBranch, 10)}${pad(r.maxInFlight, 5)}${pad(r.hasWorktreeDown ? "yes" : "no", 9)}${r.worktreeRoot ?? "-"}`,
    );
  }
}

async function schedule(client) {
  const { schedules } = await client.schedules();
  if (schedules.length === 0) {
    console.log("no schedules registered (event-runtime/schedules.json)");
    return;
  }
  console.log(`${pad("LOOP", 16)}${pad("EVERY", 8)}${pad("ENABLED", 9)}${pad("APPROVAL", 10)}${pad("CATCHUP", 9)}${pad("LAST SLOT", 26)}${pad("NEXT DUE", 26)}STATE`);
  for (const s of schedules) {
    const state = s.error ? `error: ${s.error}` : s.stopped ? `STOPPED (${s.intervalsLate} intervals late)` : s.enabled ? "ok" : "off";
    console.log(
      `${pad(s.loop, 16)}${pad(s.every, 8)}${pad(s.enabled ? "yes" : "no", 9)}${pad(s.approval, 10)}${pad(s.catchUp, 9)}${pad(s.lastSlot ?? "-", 26)}${pad(s.nextDue ?? "-", 26)}${state}`,
    );
  }
}

async function agents(client) {
  const { agents: defs } = await client.agents();
  for (const d of defs) {
    console.log(`${d.ref}   contract ${d.outputContract}   mutating ${d.mutating}   timeout ${d.limits.timeout_seconds}s   attempts ${d.limits.attempts}`);
    console.log(`  capabilities  ${d.capabilities.filesystem}; ${(d.capabilities.services ?? []).join(", ") || "-"}`);
    if (d.modelTier || d.model) {
      // Declared intent (WM-135); the per-route resolved value rides on each
      // event type line below, since resolution is per adapter.
      const parts = [];
      if (d.modelTier) parts.push(`tier ${d.modelTier}`);
      if (d.model) parts.push(`override ${d.model}`);
      console.log(`  model         ${parts.join("   ")}`);
    }
    console.log(`  files         ${d.promptFile}, ${d.inputSchemaFile}, ${d.outputSchemaFile}`);
    for (const t of d.eventTypes) {
      const model = t.resolvedModel != null ? `   model ${t.resolvedModel}` : "";
      console.log(`  event type    ${t.type}   adapter ${t.adapter}   scope ${t.idempotencyScope.join("+")}   ttl ${t.proposalTtlSeconds ?? "-"}s${model}`);
    }
  }
}

async function inject(client, file) {
  const raw = readFileSync(file === "-" ? 0 : file, "utf8");
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    fail(`inject: ${file} is not valid JSON: ${err.message}`);
  }
  const outcome = await client.replay(envelope);
  console.log(outcome.duplicate ? `duplicate — event ${outcome.eventId} was already admitted` : `admitted event ${outcome.eventId}`);
}

// ---------------------------------------------------------------------------

/**
 * Hand-driven sandbox access (WM-185) — the way to try a Gondolin microVM
 * without wiring an event, an agent definition, or a worker:
 *
 *   sandbox doctor
 *   sandbox exec --dir . --allow api.github.com --secret GITHUB_TOKEN=GH_TOKEN --shell -- \
 *     'curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user'
 *
 * `--secret NAME=ENVVAR` reads ENVVAR from this shell and scopes it to every
 * --allow host; the guest only ever sees a placeholder. `--shell` runs the
 * command through the guest's /bin/sh, which is a convenience for interactive
 * use — the command adapter always uses argv form, with no shell at all.
 */
async function sandbox(args) {
  const sub = args[0];

  if (sub === "doctor") {
    const report = sandboxPreflight();
    console.log(`${pad("available", 14)}${report.available ? "yes" : "no"}`);
    if (report.cause) console.log(`${pad("cause", 14)}${report.cause}`);
    console.log(`${pad("qemu", 14)}${report.qemu ?? "-"}`);
    console.log(`${pad("node", 14)}${report.node ?? "-"}${report.nodeVersion ? `   (v${report.nodeVersion})` : ""}`);
    console.log(`${pad("sdk", 14)}${report.sdk ? "@earendil-works/gondolin installed" : "-"}`);
    if (!report.available) {
      console.log(`\n${report.reason}`);
      // The exit code carries the distinction, not just the text (WM-312): a
      // host that cannot virtualize is an ordinary fact about that machine; a
      // missing harness is a stale checkout someone must fix. CI asserts on
      // `install` and tolerates `host`, so runners without QEMU do not turn a
      // real regression into noise everyone learns to skip past.
      process.exit(report.cause === "install" ? 2 : 1);
    }
    return;
  }

  if (sub !== "exec") {
    fail("usage: sandbox doctor | sandbox exec [--dir P] [--allow HOST]... [--secret NAME=ENVVAR]... [--shell] [--timeout S] -- <command>");
  }

  const rest = args.slice(1);
  const separator = rest.indexOf("--");
  if (separator === -1 || separator === rest.length - 1) {
    fail("sandbox exec: the command must follow `--` (e.g. sandbox exec --dir . -- /bin/ls -la /workspace)");
  }
  const flags = rest.slice(0, separator);
  const commandArgv = rest.slice(separator + 1);

  const dir = path.resolve(flagValue(flags, "--dir") ?? process.cwd());
  const shell = flags.includes("--shell");
  const timeoutSeconds = Number(flagValue(flags, "--timeout") ?? 120);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail("sandbox exec: --timeout must be a positive number of seconds");

  const allowedHosts = [];
  const secrets = {};
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === "--allow") {
      const host = flags[i + 1];
      if (!host) fail("sandbox exec: --allow expects a host");
      allowedHosts.push(host);
    }
    if (flags[i] === "--secret") {
      const [name, ...envRest] = String(flags[i + 1] ?? "").split("=");
      if (!name) fail("sandbox exec: --secret expects NAME or NAME=ENVVAR");
      secrets[name] = { env: envRest.length > 0 ? envRest.join("=") : name };
    }
  }
  // A secret is scoped to whatever egress was actually allowed; policy
  // normalization rejects any wider claim, so this can never over-grant.
  for (const secret of Object.values(secrets)) secret.hosts = allowedHosts;

  const report = sandboxPreflight();
  if (!report.available) fail(`sandbox exec: ${report.reason}`);

  try {
    const { exitCode, timedOut, bootMs } = await runInSandbox({
      policy: { provider: "gondolin", allowedHosts, secrets },
      command: shell ? commandArgv.join(" ") : commandArgv,
      workspaceDir: dir,
      timeoutMs: timeoutSeconds * 1000,
      shell,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    console.error(
      `\n[sandbox] ${dir} mounted at /workspace   egress: ${allowedHosts.length ? allowedHosts.join(", ") : "deny-all"}   boot ${bootMs ?? "?"}ms`,
    );
    if (timedOut) fail(`sandbox exec: timed out after ${timeoutSeconds}s`);
    process.exit(exitCode ?? 1);
  } catch (err) {
    fail(`sandbox exec: ${err.message}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "serve":
      return serve(args);

    case "work":
      return work(args);

    case "supervise":
      return supervise(args);

    case "status":
      return withClient(status);

    case "doctor":
      return withClient(doctor);

    case "events":
      return withClient((client) => events(client, args[0]));

    case "runs":
      return withClient((client) => runs(client, args[0]));

    case "ps":
      return withClient((client) => ps(client, args[0]));

    case "proposals":
      return withClient(proposals);

    case "inbox":
      return withClient(inbox);

    case "agents":
      return withClient(agents);

    case "workers":
      return withClient(workers);

    case "schedule":
      return withClient(schedule);

    case "repos":
      return withClient(repos);

    case "sandbox":
      return sandbox(args);

    case "approve": {
      if (!args[0]) fail("usage: approve <proposal-id>");
      return withClient(async (client) => {
        const outcome = await client.approve(args[0]);
        if (outcome.approved) console.log(`approved — run ${outcome.runId} queued`);
        else console.log(`proposal expired and re-planned — review and approve the new proposal ${outcome.proposal.id}`);
      });
    }

    case "reject": {
      if (!args[0] || !args[1]) fail('usage: reject <proposal-id> "<reason>"');
      return withClient(async (client) => {
        await client.reject(args[0], args[1]);
        console.log(`rejected ${args[0]}`);
      });
    }

    case "inject": {
      if (!args[0]) fail("usage: inject <envelope.json|->");
      return withClient((client) => inject(client, args[0]));
    }

    case "requeue": {
      if (!args[0] || !args[1]) fail("usage: requeue <source> <event-id>");
      return withClient(async (client) => {
        await client.requeue(args[0], args[1]);
        console.log(`requeued (${args[0]}, ${args[1]}) — will be re-planned`);
      });
    }

    case "cancel": {
      if (!args[0]) fail("usage: cancel <run-id> [reason]");
      return withClient(async (client) => {
        const res = await client.cancel(args[0], args[1]);
        if (res?.ambiguousOpenProposals?.length) {
          console.log(`cancelled ${args[0]} (warning: ${res.ambiguousOpenProposals[0].count} open proposals remain ambiguous)`);
        } else {
          console.log(`cancelled ${args[0]}`);
        }
      });
    }

    case "retry": {
      if (!args[0]) fail("usage: retry <run-id> [--force]");
      return withClient(async (client) => {
        await client.retry(args[0], { force: args.includes("--force") });
        console.log(`re-queued ${args[0]}`);
      });
    }

    case "inspect": {
      if (!args[0]) fail("usage: inspect <run-id>");
      return withClient((client) => inspect(client, args[0]));
    }

    case "trace": {
      if (!args[0]) fail("usage: trace <run-id>");
      return withClient((client) => trace(client, args[0]));
    }

    case "update-pins": {
      const changed = updatePins();
      console.log(changed.length ? `re-pinned: ${changed.join(", ")}` : "pins already current");
      return;
    }

    default:
      console.error(USAGE);
      process.exit(1);
  }
}

if (import.meta.main || process.argv[1]?.endsWith("cli.mjs")) {
  await main();
}
