import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAdapterRegistry } from "../lib/adapters/index.mjs";
import { loadExtensions } from "../lib/extensions.mjs";
import { startConnectors, stopConnectors } from "../lib/connectors.mjs";
import {
  API_HOST,
  DEFAULT_PORT,
  artifactsRoot,
  dbPath,
  ensureHome,
  environmentName,
  policyVersion,
  runtimeHome,
  workspacesRoot,
} from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";
import { newWorkerId } from "../lib/ids.mjs";
import { pruneArtifacts } from "../lib/artifacts.mjs";
import { publishOutbox } from "../lib/outbox.mjs";
import { autoApproveScheduled, emitDueTicks } from "../lib/schedules.mjs";
import { autoApproveChains } from "../lib/auto-approval.mjs";
import {
  worktreeDispatchAutoEligibility,
  planAdmittedEvents,
} from "../lib/planner.mjs";
import { resolveChains } from "../lib/chain.mjs";
import { notifyPending } from "../lib/notify.mjs";
import { reconcileInbox } from "../lib/inbox.mjs";
import { loadModelTierMap, loadRegistry } from "../lib/registry.mjs";
import { applyModelTierCellOverrides } from "../lib/runtime-overrides.mjs";
import { approveProposal } from "../lib/proposals.mjs";
import { startApi } from "../lib/api.mjs";
import { runOnce } from "../lib/worker.mjs";
import { reapExpiredLeases } from "../lib/reaper.mjs";
import { CLI_PATH, fail, flagValue, log } from "./shared.mjs";

export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const TICK_SUBSYSTEMS = [
  "tick emit",
  "plan",
  "auto-approve",
  "auto-approve-chains",
  "announce",
  "inbox",
  "notify",
  "reap",
  "worker",
  "announce-after",
  "outbox",
  "GC",
  "chains",
];

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
      logLine(
        `tick ${t.loop} @ ${t.slot}${t.skipped > 0 ? ` (stands for ${t.skipped} skipped slot(s))` : ""}`,
      );
    }
    for (const err of ticks.errors) logLine(`schedule error: ${err}`);
  });

  await runStep("plan", () => {
    planAdmittedEvents(db, registry, {
      now,
      policyVersion: pv,
      adapterOverride,
    });
  });

  await runStep("auto-approve", () => {
    const auto = autoApproveScheduled(db, registry, approveProposal, {
      now,
      policyVersion: pv,
    });
    for (const a of auto.approved)
      logLine(`schedule approved ${a.loop} → run ${a.runId} (actor: schedule)`);
    for (const err of auto.errors) logLine(`schedule approval error: ${err}`);
  });

  await runStep("auto-approve-chains", async () => {
    const auto = await autoApproveChains(db, registry, {
      now,
      policyVersion: pv,
      dispatchEligibility: worktreeDispatchAutoEligibility,
      dispatch: db ? db : null,
    });
    for (const a of auto.approved)
      logLine(
        `chain proposal approved ${a.proposalId} → run ${a.runId} (actor: chain auto)`,
      );
    for (const e of auto.errors)
      logLine(`chain approval error: ${e.proposalId}:${e.reason}`);
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
        workspacesRoot: workspacesRoot(),
        owner,
        now,
        policyVersion: pv,
        ...(adapterOverride ? { adapterOverride } : {}),
      });
    });
  }

  await runStep("announce-after", () => {
    announceTransitions();
  });

  await runStep("outbox", () => {
    publishOutbox(db, {
      sink: (e) =>
        logLine(
          `result event ${e.type} (${e.eventId}) artifact ${e.payload?.artifactHash ?? "-"}`,
        ),
      now,
    });
  });

  let nextPrune = lastPrune;
  await runStep("GC", () => {
    if (now - lastPrune <= pruneIntervalMs) return;
    try {
      const pruned = pruneArtifacts(db, storeRoot ?? artifactsRoot(), { now });
      if (pruned.deleted > 0)
        logLine(
          `artifacts: pruned ${pruned.deleted} orphan(s), freed ${pruned.freedBytes}B`,
        );
    } finally {
      nextPrune = now;
    }
  });

  await runStep("chains", () => {
    const chains = resolveChains(db, registry, { now });
    if (chains.emitted > 0)
      logLine(`chain: emitted ${chains.emitted} follow-up event(s) — planning`);
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
    JSON.stringify({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
    }),
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
  return (
    process.execArgv.includes("--watch") || process.execArgv.includes("--hot")
  );
}

/**
 * Re-exec under `bun --watch` so lib/ edits replace this process. In-flight
 * runs are dropped on purpose — a stale backend is worse during development.
 */
function watchServe(args) {
  const rest = args.filter((a) => a !== "--watch");
  log(
    "serve --watch: restarting on event-runtime/ changes (in-flight runs are dropped)",
  );
  const child = spawn(
    process.execPath,
    ["--watch", CLI_PATH, "serve", ...rest],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
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

export default async function serve(args) {
  if (args.includes("--watch") && !underBunWatch()) return watchServe(args);

  const portFlag = flagValue(args, "--port");
  const rawPort = portFlag ?? process.env.FACTORY_EVENT_PORT ?? "7381";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`serve: invalid port "${rawPort}" (must be integer 1-65535)`);
  }
  const adapterOverride = flagValue(args, "--adapter-override") ?? undefined;
  // Built-ins first, then allow-listed extensions (lib/extensions.mjs,
  // WM-838) — before toMap(), which is a snapshot. The registry validates the
  // contract and wraps every adapter in the sandbox seam (WM-837); a broken
  // extension is a configuration anomaly on /status, never a failed start.
  const adapterRegistry = createAdapterRegistry();
  const extensions = await loadExtensions({ adapterRegistry });
  const adapters = adapterRegistry.toMap();
  if (adapterOverride && !adapterRegistry.has(adapterOverride)) {
    fail(
      `serve: unknown --adapter-override "${adapterOverride}" (have: ${Object.keys(adapters).join(", ")})`,
    );
  }

  ensureHome();
  const home = runtimeHome();
  try {
    acquireServeLock(home, port);
  } catch (err) {
    fail(`serve: ${err.message}`);
  }

  const db = openDb();
  // Policy models are a startup snapshot. Persisted cells compose over the
  // tracked map before registry validation; PUT/DELETE never mutate this
  // process, so operators get the promised explicit restart boundary.
  const trackedModelTiers = loadModelTierMap();
  const modelTiers = applyModelTierCellOverrides(db, trackedModelTiers);
  const registry = loadRegistry({
    packRoots: extensions.packRoots,
    panelRoots: extensions.panelRoots,
    harnessRoots: extensions.harnessRoots,
    modelTiers,
    trackedModelTiers,
  });
  registry.anomalies.push(...extensions.anomalies);
  const startedConnectors = await startConnectors({ db, registry, log });
  registry.anomalies.push(...startedConnectors.anomalies);
  const pv = policyVersion();
  const owner = newWorkerId();

  const seenProposals = new Set();
  let lastSeq =
    db.query(`SELECT MAX(seq) AS m FROM lifecycle_events`).get().m ?? 0;

  /** Print any open proposal not yet announced — §12: proposals render here. */
  function announceProposals() {
    for (const p of db
      .query(
        `SELECT * FROM proposals WHERE status = 'open' ORDER BY created_at, rowid`,
      )
      .all()) {
      if (seenProposals.has(p.id)) continue;
      seenProposals.add(p.id);
      const spec = p.spec_json ? JSON.parse(p.spec_json) : null;
      if (p.decision === "run") {
        log(`proposal ${p.id}  agent ${spec?.agent}  ttl ${p.ttl_seconds}s`);
        log(`  approve with: bun event-runtime/cli.mjs approve ${p.id}`);
      } else {
        log(
          `proposal ${p.id}  decision ${p.decision}  reason ${p.reason ?? "-"}`,
        );
      }
    }
  }

  /** Narrate approvals, cancellations, and terminal states from the journal. */
  function announceTransitions() {
    const rows = db
      .query(`SELECT * FROM lifecycle_events WHERE seq > ? ORDER BY seq`)
      .all(lastSeq);
    for (const row of rows) {
      lastSeq = row.seq;
      if (
        [
          "APPROVED",
          "CANCELLED",
          "COMPLETED",
          "REFUSED",
          "FAILED",
          "TIMED_OUT",
        ].includes(row.to_state)
      ) {
        log(
          `run ${row.run_id} → ${row.to_state} (${row.reason ?? "-"}) by ${row.actor}`,
        );
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

  const env = {
    name: environmentName(),
    home: runtimeHome(),
    adapter: adapterOverride ?? null,
  };
  const server = startApi({
    db,
    registry,
    policyVersion: pv,
    port,
    env,
    onEvent: (kind) => {
      log(`event ${kind} — planning`);
      loopTick();
    },
  });
  // Without this the `error` event has no listener, so a busy port kills the
  // process with no output at all: the caller sees exit 1 and an empty log,
  // and every waiter downstream reports "never printed control API on" as if
  // the runtime hung (WM-1037). Say which port and who to blame instead.
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      log(
        `serve: port ${port} is already in use — another runtime or a leftover ` +
          `process holds http://${API_HOST}:${port}. Stop it, or pass a free --port.`,
      );
    } else {
      log(`serve: control API failed to start: ${err?.message ?? err}`);
    }
    process.exit(1);
  });
  server.on("listening", () => {
    log(
      `environment "${env.name}" — control API on http://${API_HOST}:${port} (db ${dbPath()}, policy ${pv})`,
    );
    if (adapterOverride)
      log(`adapter override: all new run specs use "${adapterOverride}"`);
    if (!process.env.FACTORY_CONTROL_API_TOKEN) {
      log(
        "WARNING: FACTORY_CONTROL_API_TOKEN is unset; all non-intake control API routes will return 503",
      );
    }
    if (!process.env.FACTORY_EVENT_SECRET) {
      log(
        "webhook intake: disabled (FACTORY_EVENT_SECRET is unset; webhooks will be rejected with 401)",
      );
    }
    if (!process.env.FACTORY_GITHUB_WEBHOOK_SECRET) {
      log(
        "github intake: disabled (FACTORY_GITHUB_WEBHOOK_SECRET is unset; GitHub webhooks will be rejected with 401)",
      );
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
    const finish = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref?.();
    };
    Promise.resolve(stopConnectors())
      .catch((err) => log(`connector stop: ${err.message}`))
      .finally(finish);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => releaseServeLock(home));
}
