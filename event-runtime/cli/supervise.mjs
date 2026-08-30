import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { FACTORY_ROOT, ensureHome } from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";
import { newWorkerId } from "../lib/ids.mjs";
import {
  DEFAULT_POOL,
  loadWorkerPolicy,
  parsePoolSpec,
  poolCounts,
  poolDecision,
} from "../lib/workers.mjs";
import { CLI_PATH, fail, flagValue, log } from "./shared.mjs";

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
    crashLoop: path.join(dir, `worker-${n}.crash-loop.json`),
  };
}

const CRASH_LOOP_LIMIT = 3;
const CRASH_BACKOFF_MS = 2_000;
const CRASH_BACKOFF_MAX_MS = 60_000;

function readCrashLoop(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      fastExits: Math.max(0, Number(parsed.fastExits) || 0),
      spawnedAt: Number(parsed.spawnedAt) || null,
      lastExitedAt: Number(parsed.lastExitedAt) || null,
      lastExitDurationMs: Number(parsed.lastExitDurationMs) || null,
      workerId: typeof parsed.workerId === "string" ? parsed.workerId : null,
      nextAttemptAt: Number(parsed.nextAttemptAt) || null,
      loggedRetryAt: Number(parsed.loggedRetryAt) || null,
    };
  } catch {
    return null;
  }
}

function writeCrashLoop(file, state) {
  // tmp + rename: a concurrent `status` reads either the previous complete
  // state or the new one, never a torn file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, file);
}

export function crashBackoffMs(fastExits) {
  return Math.min(
    CRASH_BACKOFF_MS * 2 ** (fastExits - CRASH_LOOP_LIMIT),
    CRASH_BACKOFF_MAX_MS,
  );
}

function remainingSeconds(at, now) {
  return Math.max(1, Math.ceil((at - now) / 1000));
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
    /* dir missing or unreadable: names stays [] from the initializer */
  }
  const slotNumbers = new Set();
  for (const name of names) {
    const m = /^worker-(\d+)\.(?:pid|crash-loop\.json)$/.exec(name);
    if (!m) continue;
    slotNumbers.add(Number(m[1]));
  }
  const slots = [];
  for (const n of slotNumbers) {
    const files = slotFiles(dir, n);
    const pid = readPidFile(files.pid);
    const crashLoop = readCrashLoop(files.crashLoop);
    slots.push({
      n,
      pid,
      hasPidFile: existsSync(files.pid),
      alive: pidAlive(pid),
      draining: existsSync(files.drain),
      workerId: readFileTrimmed(files.id),
      crashLoops: crashLoop?.fastExits ?? 0,
      nextAttemptAt: crashLoop?.nextAttemptAt ?? null,
    });
  }
  slots.sort((a, b) => a.n - b.n);
  const supervisorPid = readPidFile(path.join(dir, "supervisor.pid"));
  return {
    supervisor:
      supervisorPid === null
        ? null
        : { pid: supervisorPid, alive: pidAlive(supervisorPid) },
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

/** Flags that shape a worker are passed through unchanged by the pool. */
export function workerPassthroughArgs(args) {
  const passthrough = [];
  for (const flag of ["--adapter-override", "--poll-ms", "--drain-timeout"]) {
    const v = flagValue(args, flag);
    if (v !== null && v !== undefined) passthrough.push(flag, v);
  }
  if (args.includes("--reload-on-change"))
    passthrough.push("--reload-on-change");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--label")
      passthrough.push("--label", String(args[i + 1] ?? ""));
  }
  return passthrough;
}

/**
 * The pool supervisor: a deterministic loop that maintains
 * `workers.min ≤ pool ≤ workers.max` from observed queue depth. It is its own
 * process, not part of `serve`, so restarting the control plane never touches
 * capacity — and it scales DOWN only by asking a worker to drain, never by
 * signalling one that might hold a lease.
 *
 *   bun event-runtime/cli.mjs supervise [--workers 1:3] [--interval-ms 2000] [--once]
 */
export default async function supervise(args) {
  const dir = runDir();
  mkdirSync(dir, { recursive: true });

  let bounds;
  try {
    const spec = flagValue(args, "--workers");
    bounds = spec
      ? parsePoolSpec(spec)
      : (loadWorkerPolicy() ?? { ...DEFAULT_POOL });
  } catch (err) {
    return fail(`supervise: ${err.message}`);
  }

  const intervalMs = Number(flagValue(args, "--interval-ms") ?? 2_000);
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 100 ||
    intervalMs > 60_000
  ) {
    return fail(
      "supervise: --interval-ms must be an integer between 100 and 60000",
    );
  }
  const drainTimeoutSeconds = Number(flagValue(args, "--drain-timeout") ?? 60);
  if (
    !Number.isInteger(drainTimeoutSeconds) ||
    drainTimeoutSeconds < 1 ||
    drainTimeoutSeconds > 3_600
  ) {
    return fail(
      "supervise: --drain-timeout must be an integer between 1 and 3600 seconds",
    );
  }
  const drainTimeoutMs = drainTimeoutSeconds * 1000;
  const spawnGraceMs = Number(
    flagValue(args, "--spawn-grace-ms") ?? SPAWN_GRACE_MS,
  );
  if (!Number.isInteger(spawnGraceMs) || spawnGraceMs < 0) {
    return fail("supervise: --spawn-grace-ms must be a non-negative integer");
  }
  const once = args.includes("--once");

  // Whatever shapes a worker gets handed straight through, so a supervised pool
  // is configured exactly like the single worker it replaces.
  const passthrough = workerPassthroughArgs(args);

  // One supervisor per run dir. Two would allocate the same slot numbers and
  // silently orphan each other's workers — pidfiles overwritten, processes
  // still running, nothing able to drain them.
  const supervisorPidFile = path.join(dir, "supervisor.pid");
  const incumbent = readPool(dir).supervisor;
  if (incumbent?.alive && incumbent.pid !== process.pid) {
    return fail(
      `supervise: a supervisor is already running for ${dir} (pid ${incumbent.pid}) — stop it first, or point FACTORY_RUN_DIR elsewhere`,
    );
  }

  ensureHome();
  const db = openDb();
  writeFileSync(supervisorPidFile, `${process.pid}\n`);

  log(
    `supervisor ${process.pid} — workers min ${bounds.min}, max ${bounds.max}, tick ${intervalMs}ms (run dir ${dir})`,
  );

  const spawnedAt = new Map();

  function releaseSlot(n) {
    const files = slotFiles(dir, n);
    for (const f of [files.pid, files.drain, files.id])
      rmSync(f, { force: true });
    spawnedAt.delete(n);
  }

  function resetCrashLoop(n, state) {
    if (state.fastExits === 0 && state.nextAttemptAt === null) return;
    writeCrashLoop(slotFiles(dir, n).crashLoop, {
      ...state,
      fastExits: 0,
      nextAttemptAt: null,
      loggedRetryAt: null,
    });
    log(`slot ${n} registered past spawn grace — crash-loop counter reset`);
  }

  function resetRegisteredSlots(now) {
    for (const slot of readPool(dir).slots) {
      if (!slot.alive || !slot.workerId) continue;
      const files = slotFiles(dir, slot.n);
      const state = readCrashLoop(files.crashLoop);
      if (
        !state ||
        state.fastExits === 0 ||
        state.workerId !== slot.workerId ||
        now - (state.spawnedAt ?? now) < spawnGraceMs
      )
        continue;
      const worker = db
        .query(`SELECT started_at FROM workers WHERE worker_id = ?`)
        .get(slot.workerId);
      if (
        worker &&
        Number.isFinite(Date.parse(worker.started_at)) &&
        now - Date.parse(worker.started_at) >= spawnGraceMs
      )
        resetCrashLoop(slot.n, state);
    }
  }

  function recordExit(slot, now) {
    const files = slotFiles(dir, slot.n);
    const state = readCrashLoop(files.crashLoop);
    const startedAt = spawnedAt.get(slot.n) ?? state?.spawnedAt;
    const fastExit =
      !slot.draining &&
      Number.isFinite(startedAt) &&
      now - startedAt < spawnGraceMs;
    releaseSlot(slot.n);

    if (!fastExit) {
      rmSync(files.crashLoop, { force: true });
      return null;
    }

    const fastExits = (state?.fastExits ?? 0) + 1;
    const nextAttemptAt =
      fastExits >= CRASH_LOOP_LIMIT ? now + crashBackoffMs(fastExits) : null;
    writeCrashLoop(files.crashLoop, {
      fastExits,
      spawnedAt: null,
      lastExitedAt: now,
      lastExitDurationMs: now - startedAt,
      workerId: slot.workerId ?? state?.workerId ?? null,
      nextAttemptAt,
      loggedRetryAt: null,
    });
    return { fastExits, nextAttemptAt };
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
      [
        CLI_PATH,
        "work",
        ...passthrough,
        "--worker-id",
        workerId,
        "--drain-file",
        files.drain,
      ],
      {
        cwd: FACTORY_ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        env: process.env,
      },
    );
    child.unref();
    closeSync(out);
    writeFileSync(files.pid, `${child.pid}\n`);
    writeFileSync(files.id, `${workerId}\n`);
    const startedAt = Date.now();
    spawnedAt.set(n, startedAt);
    const previous = readCrashLoop(files.crashLoop);
    writeCrashLoop(files.crashLoop, {
      fastExits: previous?.fastExits ?? 0,
      spawnedAt: startedAt,
      lastExitedAt: previous?.lastExitedAt ?? null,
      lastExitDurationMs: previous?.lastExitDurationMs ?? null,
      workerId,
      nextAttemptAt: null,
      loggedRetryAt: null,
    });
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
    const idle = [...candidates]
      .reverse()
      .find((s) => s.workerId && idleWorkerIds.has(s.workerId));
    return idle ?? candidates[candidates.length - 1];
  }

  let lastHold = null;

  function tick() {
    const now = Date.now();
    for (const s of readPool(dir).slots) {
      // A crash-loop state intentionally remains after its pidfile is removed
      // so status can expose the held slot. It is not a second exit.
      if (s.alive || !s.hasPidFile) continue;
      log(
        `slot ${s.n} (worker ${s.workerId ?? "?"}, pid ${s.pid ?? "?"}) exited — slot released`,
      );
      recordExit(s, now);
    }

    // A registered worker which survives the boot window is healthy enough to
    // forget previous fast exits. Check the registry as well as its pid: a
    // process that never registered has not recovered the pool.
    resetRegisteredSlots(now);

    const alive = readPool(dir).slots.filter((s) => s.alive);
    const observed = poolCounts(db, { now });
    const pending = alive.filter((s) => {
      const state = readCrashLoop(slotFiles(dir, s.n).crashLoop);
      const startedAt = spawnedAt.get(s.n) ?? state?.spawnedAt ?? 0;
      return now - startedAt < spawnGraceMs;
    }).length;
    const draining = alive.filter((s) => s.draining).length;
    const decision = poolDecision({
      queued: observed.queued,
      idle: observed.idle,
      pool: alive.length,
      pending,
      draining,
      min: bounds.min,
      max: bounds.max,
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
      const files = slotFiles(dir, slot);
      const crashLoop = readCrashLoop(files.crashLoop);
      if (crashLoop?.nextAttemptAt && crashLoop.nextAttemptAt > now) {
        if (crashLoop.loggedRetryAt !== crashLoop.nextAttemptAt) {
          log(
            `crash-loop slot ${slot}: ${crashLoop.fastExits} fast exits, next attempt in ${remainingSeconds(crashLoop.nextAttemptAt, now)}s [${counts}]`,
          );
          writeCrashLoop(files.crashLoop, {
            ...crashLoop,
            loggedRetryAt: crashLoop.nextAttemptAt,
          });
        }
        return decision;
      }
      const { pid, workerId, log: logFile } = spawnSlot(slot);
      log(
        `spawn slot ${slot} → worker ${workerId} pid ${pid} (${logFile}): ${decision.reason} [${counts}]`,
      );
      lastHold = null;
      return decision;
    }

    if (decision.action === "drain") {
      const target = chooseDrainSlot(alive, observed.idleWorkerIds);
      if (!target) {
        log(`hold — every live slot is already draining [${counts}]`);
        return decision;
      }
      writeFileSync(
        slotFiles(dir, target.n).drain,
        `scale-down ${new Date(now).toISOString()}\n`,
      );
      log(
        `drain slot ${target.n} (worker ${target.workerId ?? "?"}): ${decision.reason} [${counts}] — it exits at its next idle poll boundary, never mid-run`,
      );
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
    log(
      `${signal} — draining ${alive.length} worker(s); anything holding a lease finishes its run first`,
    );
    for (const s of alive)
      writeFileSync(slotFiles(dir, s.n).drain, `${signal}\n`);

    const waitFor = async (deadline) => {
      while (Date.now() < deadline && readPool(dir).slots.some((s) => s.alive))
        await sleep(200);
      return readPool(dir).slots.filter((s) => s.alive);
    };

    let left = await waitFor(Date.now() + drainTimeoutMs);
    if (left.length > 0) {
      log(
        `${left.length} worker(s) still busy after ${drainTimeoutMs / 1000}s — SIGTERM (each runs its own bounded drain)`,
      );
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
      log(
        `${left.length} worker(s) did not exit — leaving them to their leases; the reaper will requeue`,
      );
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
