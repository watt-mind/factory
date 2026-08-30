import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { createAdapterRegistry } from "../lib/adapters/index.mjs";
import { loadExtensions } from "../lib/extensions.mjs";
import {
  dbPath,
  ensureHome,
  policyVersion,
  workspacesRoot,
} from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";
import { newWorkerId } from "../lib/ids.mjs";
import { loadRegistry } from "../lib/registry.mjs";
import {
  claimNext,
  checkoutPolicyVersion,
  CODE_RELOAD_EXIT,
  codeStamp,
  createReloadWatcher,
  executeClaimed,
  RELOAD_CHECK_INTERVAL_MS,
} from "../lib/worker.mjs";
import { preflight as sandboxPreflight } from "../lib/sandbox/gondolin.mjs";
import {
  deregisterWorker,
  heartbeat,
  registerWorker,
} from "../lib/workers.mjs";
import { fail, flagValue, log } from "./shared.mjs";

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
export default async function work(args) {
  const adapterOverride = flagValue(args, "--adapter-override") ?? undefined;
  const pollMs = Number(flagValue(args, "--poll-ms") ?? 500);
  if (!Number.isInteger(pollMs) || pollMs < 25 || pollMs > 5_000) {
    fail("work: --poll-ms must be an integer between 25 and 5000");
  }
  // Built-ins first, then allow-listed extensions (lib/extensions.mjs,
  // WM-838) — before toMap(), which is a snapshot. The registry validates the
  // contract and wraps every adapter in the sandbox seam (WM-837); a broken
  // extension is a configuration anomaly on /status, never a failed start.
  const adapterRegistry = createAdapterRegistry();
  const extensions = await loadExtensions({ adapterRegistry });
  const adapters = adapterRegistry.toMap();
  if (adapterOverride && !adapterRegistry.has(adapterOverride)) {
    fail(
      `work: unknown --adapter-override "${adapterOverride}" (have: ${Object.keys(adapters).join(", ")})`,
    );
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
  const registry = loadRegistry({
    packRoots: extensions.packRoots,
    harnessRoots: extensions.harnessRoots,
  });
  registry.anomalies.push(...extensions.anomalies);
  const pv = policyVersion();
  const workerId = flagValue(args, "--worker-id") ?? newWorkerId();
  const adapterNames = adapterOverride
    ? [adapterOverride]
    : Object.keys(adapters);
  const startedAt = Date.now();

  registerWorker(db, {
    workerId,
    labels,
    adapters: adapterNames,
    now: startedAt,
  });
  log(`worker ${workerId} on ${hostname()} (db ${dbPath()}, policy ${pv})`);
  if (Object.keys(labels).length > 0) log(`labels: ${JSON.stringify(labels)}`);
  if (!sandboxReport.available)
    log(`sandbox: unavailable — ${sandboxReport.reason}`);
  if (adapterOverride)
    log(`adapter override: executing every run with "${adapterOverride}"`);
  if (drainFile)
    log(
      `drain-file: ${drainFile} (supervised worker — exits 0 when it appears, between claims)`,
    );

  let draining = false;
  let inFlight = null;

  // Dev live-reload (WM-213). Off unless asked for: a production worker must
  // never decide on its own that it is out of date.
  const watcher = args.includes("--reload-on-change")
    ? createReloadWatcher({
        stamp: () =>
          codeStamp(undefined, [
            "event-runtime/lib",
            "event-runtime/cli.mjs",
            "event-runtime/cli",
          ]),
      })
    : null;
  if (watcher)
    log(
      `reload-on-change: armed at code stamp ${watcher.from} (reloads only between claims)`,
    );

  // The heartbeat runs on its own timer, NOT inside the claim loop: that loop
  // blocks for the whole duration of an agent run (up to the spec timeout),
  // so a loop-driven heartbeat would mark every legitimately busy worker as
  // stale — and the doctor's "stalled worker" check exists precisely to tell
  // busy apart from dead.
  const workerHeartbeat = (options) =>
    heartbeat(db, workerId, {
      ...options,
      labels,
      adapters: adapterNames,
      startedAt,
    });
  const beat = setInterval(
    () =>
      workerHeartbeat({
        state: inFlight ? "busy" : "idle",
        runId: inFlight,
      }),
    15_000,
  );
  beat.unref?.();

  /**
   * True when this worker should exit for a supervisor to restart it. Consulted
   * from two places for one reason each: the timer notices a change *during* a
   * run so the deferral is logged while it is still true, and the loop top is
   * the idle boundary where acting on it is safe.
   */
  function reloadWanted({ force = false } = {}) {
    if (!watcher || draining) return false;
    const r = watcher.check(inFlight, { force });
    if (r.action === "deferred") {
      if (r.first)
        log(
          `code changed (${r.from} → ${r.to}) — reload deferred until ${r.runId} finishes`,
        );
      return false;
    }
    if (r.action === "reload") {
      log(
        `code changed (${r.from} → ${r.to}) — reloading worker (exit ${CODE_RELOAD_EXIT})`,
      );
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
          log(
            `drain requested (${drainFile}) — stopping at idle poll boundary`,
          );
          return finish("drain_requested");
        }
        workerHeartbeat({
          state: inFlight ? "busy" : "idle",
          runId: inFlight,
        });
        const claim = claimNext(db, {
          owner: workerId,
          policyVersion: pv,
          registryVersion: pv,
          currentRegistryVersion: checkoutPolicyVersion,
          labels,
          adapters: adapterOverride ? null : adapterNames,
          ...(adapterOverride ? { adapterOverride } : {}),
        });
        if (!claim) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        if (claim.refused) {
          log(
            `refused ${claim.runId} (${claim.reasonCode}, retryable): worker registry ${claim.workerRegistryVersion}, checkout registry ${claim.checkoutRegistryVersion}, run prompt ${claim.spec.promptVersion}, run policy ${claim.spec.policyVersion}`,
          );
          if (claim.reloadRequired)
            return finish("registry_stale", CODE_RELOAD_EXIT);
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        inFlight = claim.runId;
        workerHeartbeat({ state: "busy", runId: claim.runId });
        log(
          `claimed ${claim.runId} attempt ${claim.attempt} (${claim.spec.agent})`,
        );
        const summary = await executeClaimed(db, registry, adapters, claim, {
          workspacesRoot: workspacesRoot(),
          policyVersion: pv,
          ...(adapterOverride ? { adapterOverride } : {}),
        });
        log(
          `${claim.runId} → ${summary?.terminalState ?? "?"} (${summary?.reasonCode ?? "-"})`,
        );
        // Force a fresh code stamp after every completed run. Without this,
        // an interval-gated check can immediately claim from a hot queue using
        // the registry snapshot from before the checkout changed.
        inFlight = null;
        if (reloadWanted({ force: true }))
          return finish("code_reload", CODE_RELOAD_EXIT);
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
  const drainTimeoutMs =
    Number(flagValue(args, "--drain-timeout") ?? 60) * 1000;
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
    log(
      `draining (${signal}) — finishing ${inFlight}, up to ${drainTimeoutMs / 1000}s`,
    );
    const deadline = Date.now() + drainTimeoutMs;
    const poll = setInterval(() => {
      if (!inFlight) {
        clearInterval(poll);
        return finish(signal);
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        log(
          `drain timeout — leaving ${inFlight} to its lease; the reaper will requeue it`,
        );
        finish("drain_timeout");
      }
    }, 250);
  };
  process.on("SIGINT", () => drain("SIGINT"));
  process.on("SIGTERM", () => drain("SIGTERM"));

  await loop();
}
