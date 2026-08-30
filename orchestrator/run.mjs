#!/usr/bin/env bun
/**
 * Foreground supervisor — the scheduler you watch.
 *
 *   bun orchestrator/run.mjs --list
 *   bun orchestrator/run.mjs --only linear-reaper --once      # dry run, one pass
 *   bun orchestrator/run.mjs --only linear-reaper --apply     # for real, on its cadence
 *   bun orchestrator/run.mjs --all --apply
 *
 * This is deliberately NOT a cron daemon. It runs in your terminal, prints
 * every command before it runs it and every line of output as it arrives, and
 * dies with Ctrl-C. When it isn't running, nothing is running — which is the
 * whole point of the foreground policy: no agent acts without someone looking.
 *
 * Three safety properties, in order of how much they matter:
 *
 *   1. DRY BY DEFAULT. A job declares `dry_command` alongside `command`;
 *      without --apply you get the dry one. The reaper's first real run would
 *      have unassigned 31 tickets, so "what would this do" is the default
 *      question.
 *   2. EXPLICIT SELECTION. --only or --all, always. There is no "run whatever
 *      is enabled" mode, because `enabled:` means "may be installed as an
 *      unattended timer" and that is a different decision from "run it now".
 *   3. NO OVERLAP. A job still running when its next tick arrives is skipped,
 *      not stacked. Two reapers racing is exactly the failure the reaper exists
 *      to clean up.
 */
import { spawn } from "node:child_process";
import { loadSchedule, toSeconds, ROOT } from "../lib/schedule.mjs";
import { latestReaperRunMs } from "./reaper.mjs";

/**
 * Keep spawned processes reachable until their stdio has closed. Shutdown can
 * then signal every active child and await settlement without polling.
 */
export function createChildTracker({
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const active = new Set();
  const waiters = new Set();

  const resolveWaiters = () => {
    if (active.size) return;
    for (const resolve of [...waiters]) resolve(true);
  };

  return {
    active,
    get size() {
      return active.size;
    },

    track(child) {
      active.add(child);
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        active.delete(child);
        resolveWaiters();
      };
      child.once("close", cleanup);
      return child;
    },

    terminateAll(signal = "SIGTERM") {
      for (const child of [...active]) {
        try {
          child.kill(signal);
        } catch {
          /* intentionally ignored */
        }
      }
    },

    waitForEmpty(timeoutMs) {
      if (!active.size) return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer;
        const done = (drained) => {
          clearTimeoutFn(timer);
          waiters.delete(done);
          resolve(drained);
        };
        waiters.add(done);
        timer = setTimeoutFn(() => done(false), timeoutMs);
      });
    },
  };
}

/**
 * Build the signal handler separately from the scheduler so forwarding,
 * bounded settlement, and the double-interrupt escape hatch are unit-testable.
 */
export function createShutdownController({
  childTracker,
  clearTimers,
  setTitle = () => {},
  getCounts = () => ({ completed: 0, failed: 0 }),
  getRunningNames = () => [],
  log = console.log,
  exit = (code) => process.exit(code),
  timeoutMs = 10_000,
}) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) {
      exit(130);
      return { forced: true, drained: false };
    }
    shuttingDown = true;

    clearTimers();
    setTitle("");
    const names = getRunningNames();
    if (childTracker.size) {
      const detail = names.length ? ` (${names.join(", ")})` : "";
      log(
        `\n${signal} — stopping ${childTracker.size} active child process(es)${detail}. Signal again to exit immediately.`,
      );
    }

    childTracker.terminateAll("SIGTERM");
    const drained = await childTracker.waitForEmpty(timeoutMs);
    const { completed, failed } = getCounts();

    setTitle("");
    log(`\nstopped. ${completed} run(s) ok, ${failed} failed.`);
    if (!drained)
      log(
        `  shutdown deadline reached; exiting with child process(es) still active.`,
      );
    log("nothing is scheduled; nothing runs until you start this again.\n");
    exit(failed ? 1 : 0);
    return { forced: false, drained };
  };
}

/**
 * Create the per-job runner separately from the supervisor setup so its
 * in-flight reservation and gate behaviour can be exercised without a TTY.
 */
export function createJobRunner({
  running,
  probe,
  spawnCommand,
  commandFor,
  shouldProbeGate,
  log = console.log,
  clock = () => new Date().toTimeString().slice(0, 8),
  c = {
    dim: (s) => s,
    bold: (s) => s,
    red: (s) => s,
    green: (s) => s,
    yellow: (s) => s,
    cyan: (s) => s,
  },
  refreshTitle = () => {},
  onCompleted = () => {},
  onFailed = () => {},
}) {
  return async function runJob(job) {
    if (running.has(job.name)) {
      log(
        `${c.dim(clock())} ${c.yellow("skip")}  ${job.name} — previous run still going`,
      );
      return;
    }

    // Reserve the job before its (potentially slow) gate probe. This includes
    // the probe in the no-overlap guarantee rather than just the spawned job.
    running.add(job.name);
    refreshTitle();
    try {
      // A gate is what makes frequent polling affordable: checking costs one
      // cheap query, spawning an agent costs budget. Exit 0 = work exists,
      // 1 = idle, anything else is surfaced rather than silently skipped.
      if (job.gate_command && shouldProbeGate) {
        const { code, out } = await probe(job.gate_command);
        if (code === 1) {
          log(
            `${c.dim(clock())} ${c.dim("idle")}  ${job.name} ${c.dim(`— ${out.split("\n").pop() || "nothing to do"}`)}`,
          );
          return;
        }
        if (code !== 0) {
          onFailed();
          log(
            `${c.dim(clock())} ${c.red("GATE FAIL")} ${job.name} ${c.dim(`exit ${code}: ${out.split("\n").pop()}`)}`,
          );
          return;
        }
        log(
          `${c.dim(clock())} ${c.green("gate")}  ${job.name} ${c.dim(out.split("\n").pop() || "")}`,
        );
      }

      const cmd = commandFor(job);
      const started = Date.now();
      log(
        `${c.dim(clock())} ${c.cyan("start")} ${c.bold(job.name)} ${c.dim(cmd)}`,
      );

      const code = await new Promise((resolve, reject) => {
        const child = spawnCommand(cmd);
        const prefix = c.dim("  │ ");
        const pipe = (stream, color) => {
          let buf = "";
          stream.on("data", (data) => {
            buf += data.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines)
              log(prefix + (color ? color(line) : line));
          });
          stream.on("end", () => {
            if (buf.trim()) log(prefix + (color ? color(buf) : buf));
          });
        };
        pipe(child.stdout);
        pipe(child.stderr, c.red);
        child.once("error", reject);
        child.once("close", resolve);
      });

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) {
        onCompleted();
        log(
          `${c.dim(clock())} ${c.green("done")}  ${job.name} ${c.dim(`(${secs}s)`)}`,
        );
      } else {
        onFailed();
        log(
          `${c.dim(clock())} ${c.red("FAIL")}  ${job.name} ${c.dim(`exit ${code}, ${secs}s`)}`,
        );
      }
    } catch (error) {
      onFailed();
      log(
        `${c.dim(clock())} ${c.red("GATE FAIL")} ${job.name} ${c.dim(error instanceof Error ? error.message : String(error))}`,
      );
    } finally {
      running.delete(job.name);
      refreshTitle();
    }
  };
}

export async function main(argv = process.argv.slice(2)) {
  const has = (flag) => argv.includes(flag);
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };

  const APPLY = has("--apply");
  const ONCE = has("--once");
  const ALL = has("--all");
  const ONLY = (val("--only") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // One supervisor per repo. Run two of these side by side to work two repos at
  // once — they share nothing but the machine, and either can be stopped alone.
  const REPO = val("--repo");
  const HARNESS = val("--harness");
  const { jobs, repo: TARGET, harness: AGENT } = loadSchedule(REPO, HARNESS);

  const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  };
  const clock = () => new Date().toTimeString().slice(0, 8);
  const running = new Set();

  // Terminal tab title (OSC 0) — so a wall of tabs reads "which repo, which
  // mode, what's running right now" without focusing any of them.
  const setTitle = (s) => {
    if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${s}\x07`);
  };
  const baseTitle = () => `factory ${TARGET} — ${APPLY ? "APPLY" : "dry"}`;
  const refreshTitle = () =>
    setTitle(
      running.size ? `${baseTitle()} ▸ ${[...running].join(",")}` : baseTitle(),
    );

  if (has("--list") || (!ALL && ONLY.length === 0)) {
    console.log(c.bold("\njobs in config/schedule.yaml\n"));
    for (const job of jobs) {
      const timer =
        job.enabled === false ? c.dim("no timer") : c.green("timer eligible");
      console.log(
        `  ${c.bold(job.name.padEnd(18))} every ${String(job.every).padEnd(5)} ${timer}`,
      );
      if (job.dry_command) console.log(c.dim(`    dry:   ${job.dry_command}`));
      console.log(c.dim(`    apply: ${job.command}`));
    }
    console.log(`
${c.bold("run one:")}  bun orchestrator/run.mjs --only ${jobs[0]?.name ?? "<job>"} --once
${c.bold("for real:")} add --apply     ${c.dim("(without it you get the dry command)")}

${c.dim("Nothing runs unless you name it. `enabled:` governs launchd installation,")}
${c.dim("not this supervisor — see deploy/gen.mjs.")}
`);
    return 0;
  }

  const selected = ALL ? jobs : jobs.filter((job) => ONLY.includes(job.name));
  const unknown = ONLY.filter((name) => !jobs.some((job) => job.name === name));
  if (unknown.length) {
    console.error(c.red(`unknown job(s): ${unknown.join(", ")}`));
    console.error(`known: ${jobs.map((job) => job.name).join(", ")}`);
    return 2;
  }
  if (!selected.length) {
    console.error(c.red("nothing selected"));
    return 2;
  }

  for (const job of selected) {
    if (!APPLY && !job.dry_command) {
      console.error(
        c.red(
          `\n${job.name} has no dry_command, so there is no safe way to preview it.`,
        ),
      );
      console.error(
        "Add one to config/schedule.yaml, or run with --apply if you mean it.\n",
      );
      return 2;
    }
  }

  const commandFor = (job) => (APPLY ? job.command : job.dry_command);

  console.log(
    c.bold(
      `\nfactory supervisor — ${c.cyan(TARGET)} · ${c.cyan(AGENT)} — ${APPLY ? c.yellow("APPLY (changes will be made)") : c.green("DRY RUN")}`,
    ),
  );
  console.log(
    c.dim(
      `${selected.length} job(s); Ctrl-C to stop. Nothing runs after you exit.\n`,
    ),
  );
  for (const job of selected)
    console.log(
      `  ${c.cyan(job.name)}  every ${job.every}  ${c.dim(commandFor(job))}`,
    );
  console.log();

  const children = createChildTracker();
  let completed = 0;
  let failed = 0;
  refreshTitle();

  /**
   * Run a command, return its exit code. Used for gates, where we want the code
   * rather than the streaming behaviour of a real job.
   */
  function probe(cmd) {
    return new Promise((resolve) => {
      const child = children.track(
        spawn("/bin/bash", ["-lc", cmd], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      let out = "";
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (out += data));
      child.on("close", (code) => resolve({ code, out: out.trim() }));
    });
  }

  const runJob = createJobRunner({
    running,
    probe,
    spawnCommand: (cmd) =>
      children.track(
        spawn("/bin/bash", ["-lc", cmd], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    commandFor,
    shouldProbeGate: APPLY,
    clock,
    c,
    refreshTitle,
    onCompleted: () => completed++,
    onFailed: () => failed++,
  });

  const timers = [];
  const shutdown = createShutdownController({
    childTracker: children,
    clearTimers: () => {
      for (const timer of timers) clearInterval(timer);
    },
    setTitle,
    getCounts: () => ({ completed, failed }),
    getRunningNames: () => [...running],
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Startup backstop: the reaper matters most at exactly the moment the factory
  // comes back up — agents crash while the supervisor is down, and their stale
  // claims sit unreaped until something runs it. If this session doesn't include
  // the linear-reaper job and no reaper has run anywhere in the last hour
  // (known from its own logs in ~/.factory/logs/reaper-*.log), run one pass
  // before the first job pass. Dry unless the supervisor itself is --apply —
  // starting a watched dry session must not silently unassign tickets.
  const REAPER_BACKSTOP_MIN = 60;
  if (!selected.some((job) => job.name === "linear-reaper")) {
    const last = latestReaperRunMs();
    const ageMin = last === null ? Infinity : (Date.now() - last) / 60_000;
    if (ageMin > REAPER_BACKSTOP_MIN) {
      const ageStr = last === null ? "never" : `${Math.round(ageMin)}m ago`;
      console.log(
        `${c.dim(clock())} ${c.yellow("reaper")} last ran ${ageStr} — backstop ${APPLY ? "apply" : "dry"} pass first`,
      );
      const { code, out } = await probe(
        `bun orchestrator/reaper.mjs${APPLY ? " --apply" : ""}`,
      );
      for (const line of out.split("\n"))
        if (line.trim()) console.log(c.dim(`  │ ${line}`));
      if (code !== 0)
        console.log(
          `${c.dim(clock())} ${c.red("reaper backstop failed")} ${c.dim(`exit ${code}`)}`,
        );
    }
  }

  // Start the first pass, but DO NOT await it before scheduling. Long-running
  // dispatch jobs must not prevent timers for the other jobs from being set.
  // Overlap is handled per job by the `running` set.
  const firstPass = Promise.all(selected.map(runJob)).catch(() => {});

  if (ONCE) {
    await firstPass;
    console.log(
      `\n${c.bold("one pass complete.")} ${completed} ok, ${failed} failed.`,
    );
    return failed ? 1 : 0;
  }

  for (const job of selected) {
    const ms = toSeconds(job.every) * 1000;
    console.log(c.dim(`  ${job.name}: next in ${job.every}`));
    timers.push(setInterval(() => runJob(job), ms));
  }
  console.log(c.dim("\nwatching — Ctrl-C to stop.\n"));
  return 0;
}

if (import.meta.main) process.exitCode = await main();
