#!/usr/bin/env bun
/**
 * What is wasting the factory's time?
 *
 *   bun orchestrator/friction.mjs                 # all captured runs
 *   bun orchestrator/friction.mjs --since 2d
 *   bun orchestrator/friction.mjs --run bj29-factory-work-20260803-230342
 *
 * Every orchestrator run writes a full JSONL transcript to ~/.factory/logs/.
 * That is a record of what agents actually did, so friction can be MEASURED
 * rather than remembered — an agent that had to fight a cookie banner will not
 * reliably write that down, but its transcript shows the same click three runs
 * running.
 *
 * Parses every harness schema via lib/transcript.mjs (claude, codex, pi, agy).
 * Interactive harness sessions without transcripts are captured separately via
 * /factory-friction; /factory-retro merges both sources.
 *
 * This finds the repeatable kind:
 *   - tool calls that errored, grouped by what the error actually was
 *   - identical commands run more than once in a session (retry loops)
 *   - commands that dominate wall clock (installs, compiles, sleeps)
 *   - runs that ended without producing anything
 *
 * It proposes nothing on its own. `/factory-retro` reads this, decides what is
 * worth fixing, and files it — because the judgement of "is this worth a
 * change" is not a job for a histogram.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { parseRun, LOG_DIR, parseDuration } from "../lib/transcript.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const JSON_OUT = argv.includes("--json");

if (!existsSync(LOG_DIR)) { console.error(`no transcripts at ${LOG_DIR}`); process.exit(1); }

const sinceArg = val("--since");
const sinceMs = sinceArg ? Date.now() - parseDuration(sinceArg) : 0;
const onlyRun = val("--run");

const files = readdirSync(LOG_DIR)
  .filter((f) => f.endsWith(".jsonl"))
  .filter((f) => !onlyRun || f.startsWith(onlyRun))
  .map((f) => ({ f, p: `${LOG_DIR}/${f}`, t: statSync(`${LOG_DIR}/${f}`).mtimeMs }))
  .filter((x) => x.t >= sinceMs)
  .sort((a, b) => a.t - b.t);

if (!files.length) { console.error("no transcripts match"); process.exit(1); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
};

const errors = new Map();     // signature -> {count, tool, sample, runs:Set}
const repeats = new Map();    // command -> {count, runs:Set}
const toolUse = new Map();    // tool -> count
const runs = [];

for (const { f, p, t } of files) {
  const parsed = parseRun(f, readFileSync(p, "utf8"), t);

  for (const [name, n] of parsed.toolCalls) toolUse.set(name, (toolUse.get(name) ?? 0) + n);

  for (const [sig, hit] of parsed.errorSigs) {
    const agg = errors.get(sig) ?? { count: 0, tool: hit.tool, sample: hit.sample, runs: new Set() };
    agg.count += hit.count;
    agg.runs.add(f);
    errors.set(sig, agg);
  }

  for (const [cmd, n] of parsed.commands) {
    if (n < 2) continue;
    const hit = repeats.get(cmd) ?? { count: 0, runs: new Set() };
    hit.count += n;
    hit.runs.add(f);
    repeats.set(cmd, hit);
  }

  runs.push({
    file: f,
    harness: parsed.harness,
    ok: parsed.ok,
    turns: parsed.turns,
    cost: parsed.estCost ?? parsed.cost,
    tools: parsed.tools,
    errors: parsed.errors,
    durationMs: parsed.durMs,
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    runs: runs.map((r) => ({ file: r.file, harness: r.harness, ok: r.ok, turns: r.turns, cost: r.cost, tools: r.tools, errors: r.errors })),
    errors: [...errors.values()].map((e) => ({ tool: e.tool, count: e.count, sample: e.sample, runs: e.runs.size })),
    repeats: [...repeats.entries()].map(([cmd, v]) => ({ cmd, count: v.count, runs: v.runs.size })),
  }, null, 2));
  process.exit(0);
}

console.log(c.bold(`\nfriction across ${files.length} run(s)\n`));
for (const r of runs) {
  const status = r.ok === null ? c.yellow("no result") : r.ok ? c.green("ok") : c.red("FAILED");
  const harness = r.harness !== "unknown" ? c.dim(`[${r.harness}] `) : "";
  console.log(`  ${status.padEnd(18)} ${harness}${r.file.replace(/\.jsonl$/, "")}`);
  console.log(c.dim(`     ${r.turns} turns · ${r.tools} tool calls · ${r.errors} errors · ~$${r.cost.toFixed(2)} · ${(r.durationMs / 60000).toFixed(1)}min`));
}

const sortedErrors = [...errors.values()].sort((a, b) => b.count - a.count);
if (sortedErrors.length) {
  console.log(c.bold(`\nrecurring failures`) + c.dim("  (grouped by failure shape, paths and ids normalised)\n"));
  for (const e of sortedErrors.slice(0, 12)) {
    const flag = e.runs.size > 1 ? c.red(`×${e.count} in ${e.runs.size} runs`) : c.yellow(`×${e.count}`);
    console.log(`  ${flag}  ${c.bold(e.tool)}`);
    console.log(c.dim(`     err: ${e.sample}`));
  }
  console.log(c.dim(`\n  Failures spanning MORE THAN ONE run are the ones worth fixing —`));
  console.log(c.dim(`  a one-off is a ticket's problem, a repeat is the harness's.`));
}

const sortedRepeats = [...repeats.entries()].filter(([, v]) => v.count > 2).sort((a, b) => b[1].count - a[1].count);
if (sortedRepeats.length) {
  console.log(c.bold(`\nrepeated commands`) + c.dim("  (same command re-run inside a session — a retry loop or a missing shortcut)\n"));
  for (const [cmd, v] of sortedRepeats.slice(0, 10)) {
    console.log(`  ${c.yellow(`×${v.count}`)}  ${cmd.slice(0, 100)}`);
  }
}

const topTools = [...toolUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(c.bold(`\ntool usage\n`));
console.log("  " + topTools.map(([n, k]) => `${n}×${k}`).join("  "));

console.log(c.dim(`\nNext: /factory-retro turns the repeats above into changes, or records why not.`));
console.log(c.dim(`Interactive sessions without transcripts: search Linear for FIP: and ## Session friction.\n`));
