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

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

const APPLY = has("--apply");
const ONCE = has("--once");
const ALL = has("--all");
const ONLY = (val("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);

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

if (has("--list") || (!ALL && ONLY.length === 0)) {
  console.log(c.bold("\njobs in config/schedule.yaml\n"));
  for (const j of jobs) {
    const timer = j.enabled === false ? c.dim("no timer") : c.green("timer eligible");
    console.log(`  ${c.bold(j.name.padEnd(18))} every ${String(j.every).padEnd(5)} ${timer}`);
    if (j.dry_command) console.log(c.dim(`    dry:   ${j.dry_command}`));
    console.log(c.dim(`    apply: ${j.command}`));
  }
  console.log(`
${c.bold("run one:")}  bun orchestrator/run.mjs --only ${jobs[0]?.name ?? "<job>"} --once
${c.bold("for real:")} add --apply     ${c.dim("(without it you get the dry command)")}

${c.dim("Nothing runs unless you name it. `enabled:` governs launchd installation,")}
${c.dim("not this supervisor — see deploy/gen.mjs.")}
`);
  process.exit(0);
}

const selected = ALL ? jobs : jobs.filter((j) => ONLY.includes(j.name));
const unknown = ONLY.filter((n) => !jobs.some((j) => j.name === n));
if (unknown.length) {
  console.error(c.red(`unknown job(s): ${unknown.join(", ")}`));
  console.error(`known: ${jobs.map((j) => j.name).join(", ")}`);
  process.exit(2);
}
if (!selected.length) { console.error(c.red("nothing selected")); process.exit(2); }

for (const j of selected) {
  if (!APPLY && !j.dry_command) {
    console.error(c.red(`\n${j.name} has no dry_command, so there is no safe way to preview it.`));
    console.error(`Add one to config/schedule.yaml, or run with --apply if you mean it.\n`);
    process.exit(2);
  }
}

const commandFor = (j) => (APPLY ? j.command : j.dry_command);

console.log(c.bold(`\nfactory supervisor — ${c.cyan(TARGET)} · ${c.cyan(AGENT)} — ${APPLY ? c.yellow("APPLY (changes will be made)") : c.green("DRY RUN")}`));
console.log(c.dim(`${selected.length} job(s); Ctrl-C to stop. Nothing runs after you exit.\n`));
for (const j of selected) console.log(`  ${c.cyan(j.name)}  every ${j.every}  ${c.dim(commandFor(j))}`);
console.log();

const running = new Set();
let completed = 0;
let failed = 0;

/**
 * Run a command, return its exit code. Used for gates, where we want the code
 * rather than the streaming behaviour of a real job.
 */
function probe(cmd) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", cmd], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

async function runJob(job) {
  if (running.has(job.name)) {
    console.log(`${c.dim(clock())} ${c.yellow("skip")}  ${job.name} — previous run still going`);
    return;
  }

  // A gate is what makes frequent polling affordable: checking costs one cheap
  // query, spawning an agent costs budget. Exit 0 = work exists, 1 = idle,
  // anything else = a real error worth surfacing rather than silently skipping.
  if (job.gate_command && APPLY) {
    const { code, out } = await probe(job.gate_command);
    if (code === 1) {
      console.log(`${c.dim(clock())} ${c.dim("idle")}  ${job.name} ${c.dim(`— ${out.split("\n").pop() || "nothing to do"}`)}`);
      return;
    }
    if (code !== 0) {
      failed++;
      console.log(`${c.dim(clock())} ${c.red("GATE FAIL")} ${job.name} ${c.dim(`exit ${code}: ${out.split("\n").pop()}`)}`);
      return;
    }
    console.log(`${c.dim(clock())} ${c.green("gate")}  ${job.name} ${c.dim(out.split("\n").pop() || "")}`);
  }

  running.add(job.name);
  const cmd = commandFor(job);
  const started = Date.now();
  console.log(`${c.dim(clock())} ${c.cyan("start")} ${c.bold(job.name)} ${c.dim(cmd)}`);

  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", cmd], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const prefix = c.dim(`  │ `);
    const pipe = (stream, color) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) console.log(prefix + (color ? color(l) : l));
      });
      stream.on("end", () => { if (buf.trim()) console.log(prefix + (color ? color(buf) : buf)); });
    };
    pipe(child.stdout);
    pipe(child.stderr, c.red);

    child.on("close", (code) => {
      running.delete(job.name);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) { completed++; console.log(`${c.dim(clock())} ${c.green("done")}  ${job.name} ${c.dim(`(${secs}s)`)}`); }
      else { failed++; console.log(`${c.dim(clock())} ${c.red("FAIL")}  ${job.name} ${c.dim(`exit ${code}, ${secs}s`)}`); }
      resolve();
    });
  });
}

const timers = [];
function shutdown() {
  for (const t of timers) clearInterval(t);
  console.log(`\n${c.bold("stopped.")} ${completed} run(s) ok, ${failed} failed.`);
  if (running.size) console.log(c.yellow(`  ${[...running].join(", ")} still finishing — they are child processes and will exit on their own.`));
  console.log(c.dim("nothing is scheduled; nothing runs until you start this again.\n"));
  process.exit(failed ? 1 : 0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Startup backstop: the reaper matters most at exactly the moment the factory
// comes back up — agents crash while the supervisor is down, and their stale
// claims sit unreaped until something runs it. If this session doesn't include
// the linear-reaper job and no reaper has run anywhere in the last hour
// (known from its own logs in ~/.factory/logs/reaper-*.log), run one pass
// before the first job pass. Dry unless the supervisor itself is --apply —
// starting a watched dry session must not silently unassign tickets.
const REAPER_BACKSTOP_MIN = 60;
if (!selected.some((j) => j.name === "linear-reaper")) {
  const last = latestReaperRunMs();
  const ageMin = last === null ? Infinity : (Date.now() - last) / 60_000;
  if (ageMin > REAPER_BACKSTOP_MIN) {
    const ageStr = last === null ? "never" : `${Math.round(ageMin)}m ago`;
    console.log(`${c.dim(clock())} ${c.yellow("reaper")} last ran ${ageStr} — backstop ${APPLY ? "apply" : "dry"} pass first`);
    const { code, out } = await probe(`bun orchestrator/reaper.mjs${APPLY ? " --apply" : ""}`);
    for (const l of out.split("\n")) if (l.trim()) console.log(c.dim(`  │ ${l}`));
    if (code !== 0) console.log(`${c.dim(clock())} ${c.red("reaper backstop failed")} ${c.dim(`exit ${code}`)}`);
  }
}

// Start the first pass, but DO NOT await it before scheduling.
//
// `dispatch` is deliberately long-running: rolling refill keeps tick.mjs alive
// for as long as tickets are in flight, which is hours. Awaiting the first pass
// before installing timers therefore meant the timers were never installed at
// all — the supervisor silently degraded into a one-shot the moment dispatch
// picked up a ticket. legalease ran merge exactly once, at 08:54, and never
// again while twelve green PRs piled up behind it; the loop looked alive
// because dispatch's agents kept printing.
//
// Overlap is already handled per job by the `running` set, so a timer that
// fires while its own job is still going skips rather than stacks.
const firstPass = Promise.all(selected.map(runJob)).catch(() => {});

if (ONCE) {
  await firstPass;
  console.log(`\n${c.bold("one pass complete.")} ${completed} ok, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

for (const job of selected) {
  const ms = toSeconds(job.every) * 1000;
  console.log(c.dim(`  ${job.name}: next in ${job.every}`));
  timers.push(setInterval(() => runJob(job), ms));
}
console.log(c.dim("\nwatching — Ctrl-C to stop.\n"));
