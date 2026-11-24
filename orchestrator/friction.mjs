#!/usr/bin/env bun
/**
 * What is wasting the factory's time?
 *
 *   bun orchestrator/friction.mjs                 # all captured runs
 *   bun orchestrator/friction.mjs --since 2d
 *   bun orchestrator/friction.mjs --run bj29-factory-work-20260803-230342
 *   bun orchestrator/friction.mjs --include-brain --since 2d
 *   bun orchestrator/friction.mjs --brain-only --since 1d
 *   bun orchestrator/friction.mjs --brain-only --brain-dir /path/to/brain --json
 *   bun orchestrator/friction.mjs --sources all --since 2d
 *   bun orchestrator/friction.mjs --sources claude,codex,t3code --since 2d --json
 *
 * Every orchestrator run writes a full JSONL transcript to ~/.factory/logs/.
 * Interactive sessions can also be mined alongside orchestrator logs:
 *   - brain:  ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
 *   - claude: ~/.claude/projects/**\/*.jsonl
 *   - codex:  ~/.codex/sessions/**\/*.jsonl and ~/.codex/archived_sessions/**\/*.jsonl
 *   - t3code: ~/.t3/userdata/statev2.sqlite (run failures/interruptions & rejected receipts)
 * That is a record of what agents actually did, so friction can be MEASURED
 * rather than remembered — an agent that had to fight a cookie banner will not
 * reliably write that down, but its transcript shows the same click three runs
 * running.
 *
 * Parses every harness schema via lib/transcript.mjs (claude, codex, codex-session, pi, agy, agy-brain).
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
import path from "node:path";
import {
  parseRun,
  readT3CodeSummary,
  LOG_DIR,
  BRAIN_DIRS,
  CLAUDE_PROJECTS_DIR,
  CODEX_SESSIONS_DIRS,
  T3_DB_PATH,
  parseDuration,
} from "../lib/transcript.mjs";

const VALID_SOURCES = new Set([
  "factory",
  "brain",
  "claude",
  "codex",
  "t3code",
]);

const argv = process.argv.slice(2);
const val = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};
const JSON_OUT = argv.includes("--json");
const BRAIN_ONLY = argv.includes("--brain-only");
const brainDirArg = val("--brain-dir");
const claudeDirArg = val("--claude-dir");
const codexDirArg = val("--codex-dir");
const t3DbArg = val("--t3-db");
const hasSourcesFlag = argv.includes("--sources");
const sourcesArg = val("--sources");

const sources = new Set();
if (hasSourcesFlag) {
  if (!sourcesArg || sourcesArg.startsWith("-")) {
    console.error(
      `--sources requires a comma-separated list (valid: ${[...VALID_SOURCES].join(",")},all)`,
    );
    process.exit(1);
  }
  for (const raw of sourcesArg.split(",")) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    if (s === "all") {
      for (const name of VALID_SOURCES) sources.add(name);
    } else if (VALID_SOURCES.has(s)) {
      sources.add(s);
    } else {
      console.error(
        `unknown source "${s}" (valid: ${[...VALID_SOURCES].join(",")},all)`,
      );
      process.exit(1);
    }
  }
  if (sources.size === 0) {
    console.error(
      `--sources must include at least one source (valid: ${[...VALID_SOURCES].join(",")},all)`,
    );
    process.exit(1);
  }
  if (argv.includes("--include-brain") || BRAIN_ONLY) sources.add("brain");
} else {
  if (!BRAIN_ONLY) sources.add("factory");
  if (argv.includes("--include-brain") || BRAIN_ONLY || Boolean(brainDirArg)) {
    sources.add("brain");
  }
  if (claudeDirArg) sources.add("claude");
  if (codexDirArg) sources.add("codex");
  if (t3DbArg) sources.add("t3code");
}

const sinceArg = val("--since");
const sinceMs = sinceArg ? Date.now() - parseDuration(sinceArg) : 0;
const onlyRun = val("--run");

const files = [];

const collectJsonlRecursive = (root, prefix) => {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.replace(/\.jsonl$/, "");
      const f = `${prefix}:${id}`;
      if (onlyRun && !f.startsWith(onlyRun) && !id.startsWith(onlyRun))
        continue;
      const t = statSync(p).mtimeMs;
      if (t >= sinceMs) files.push({ f, p, t });
    }
  }
};

if (sources.has("factory")) {
  if (!existsSync(LOG_DIR)) {
    if (sources.size === 1) {
      console.error(`no transcripts at ${LOG_DIR}`);
      process.exit(1);
    }
  } else {
    for (const f of readdirSync(LOG_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      if (onlyRun && !f.startsWith(onlyRun)) continue;
      const p = path.join(LOG_DIR, f);
      const t = statSync(p).mtimeMs;
      if (t >= sinceMs) files.push({ f, p, t });
    }
  }
}

if (sources.has("brain")) {
  const brainRoots = brainDirArg ? [brainDirArg] : BRAIN_DIRS;
  const collectBrainTranscript = (id, p) => {
    if (!existsSync(p)) return;
    const f = `brain:${id}`;
    if (onlyRun && !f.startsWith(onlyRun) && !id.startsWith(onlyRun)) return;
    const t = statSync(p).mtimeMs;
    if (t >= sinceMs) files.push({ f, p, t });
  };

  for (const root of brainRoots) {
    if (!existsSync(root)) continue;
    collectBrainTranscript(
      path.basename(root),
      path.join(root, ".system_generated", "logs", "transcript.jsonl"),
    );
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      collectBrainTranscript(
        entry.name,
        path.join(
          root,
          entry.name,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        ),
      );
    }
  }
}

if (sources.has("claude")) {
  const claudeRoot = claudeDirArg ?? CLAUDE_PROJECTS_DIR;
  collectJsonlRecursive(claudeRoot, "claude");
}

if (sources.has("codex")) {
  const codexRoots = codexDirArg ? [codexDirArg] : CODEX_SESSIONS_DIRS;
  for (const root of codexRoots) {
    collectJsonlRecursive(root, "codex");
  }
}

const t3Summary = sources.has("t3code")
  ? readT3CodeSummary(t3DbArg ?? T3_DB_PATH, { sinceMs })
  : null;

files.sort((a, b) => a.t - b.t);

if (!files.length && !t3Summary) {
  console.error("no transcripts match");
  process.exit(1);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
};

const errors = new Map(); // signature -> {count, tool, sample, runs:Set}
const repeats = new Map(); // command -> {count, runs:Set}
const toolUse = new Map(); // tool -> count
const runs = [];

for (const { f, p, t } of files) {
  const parsed = parseRun(f, readFileSync(p, "utf8"), t);

  for (const [name, n] of parsed.toolCalls)
    toolUse.set(name, (toolUse.get(name) ?? 0) + n);

  for (const [sig, hit] of parsed.errorSigs) {
    const agg = errors.get(sig) ?? {
      count: 0,
      tool: hit.tool,
      sample: hit.sample,
      runs: new Set(),
    };
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
  const payload = {
    runs: runs.map((r) => ({
      file: r.file,
      harness: r.harness,
      ok: r.ok,
      turns: r.turns,
      cost: r.cost,
      tools: r.tools,
      errors: r.errors,
    })),
    errors: [...errors.values()].map((e) => ({
      tool: e.tool,
      count: e.count,
      sample: e.sample,
      runs: e.runs.size,
    })),
    repeats: [...repeats.entries()].map(([cmd, v]) => ({
      cmd,
      count: v.count,
      runs: v.runs.size,
    })),
  };
  if (t3Summary) payload.t3code = t3Summary;
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log(c.bold(`\nfriction across ${files.length} run(s)\n`));
for (const r of runs) {
  const status =
    r.ok === null
      ? c.yellow("no result")
      : r.ok
        ? c.green("ok")
        : c.red("FAILED");
  const harness = r.harness !== "unknown" ? c.dim(`[${r.harness}] `) : "";
  console.log(
    `  ${status.padEnd(18)} ${harness}${r.file.replace(/\.jsonl$/, "")}`,
  );
  console.log(
    c.dim(
      `     ${r.turns} turns · ${r.tools} tool calls · ${r.errors} errors · ~$${r.cost.toFixed(2)} · ${(r.durationMs / 60000).toFixed(1)}min`,
    ),
  );
}

const sortedErrors = [...errors.values()].sort((a, b) => b.count - a.count);
if (sortedErrors.length) {
  console.log(
    c.bold(`\nrecurring failures`) +
      c.dim("  (grouped by failure shape, paths and ids normalised)\n"),
  );
  for (const e of sortedErrors.slice(0, 12)) {
    const flag =
      e.runs.size > 1
        ? c.red(`×${e.count} in ${e.runs.size} runs`)
        : c.yellow(`×${e.count}`);
    console.log(`  ${flag}  ${c.bold(e.tool)}`);
    console.log(c.dim(`     err: ${e.sample}`));
  }
  console.log(
    c.dim(
      `\n  Failures spanning MORE THAN ONE run are the ones worth fixing —`,
    ),
  );
  console.log(
    c.dim(`  a one-off is a ticket's problem, a repeat is the harness's.`),
  );
}

const sortedRepeats = [...repeats.entries()]
  .filter(([, v]) => v.count > 2)
  .sort((a, b) => b[1].count - a[1].count);
if (sortedRepeats.length) {
  console.log(
    c.bold(`\nrepeated commands`) +
      c.dim(
        "  (same command re-run inside a session — a retry loop or a missing shortcut)\n",
      ),
  );
  for (const [cmd, v] of sortedRepeats.slice(0, 10)) {
    console.log(`  ${c.yellow(`×${v.count}`)}  ${cmd.slice(0, 100)}`);
  }
}

const topTools = [...toolUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
if (topTools.length) {
  console.log(c.bold(`\ntool usage\n`));
  console.log("  " + topTools.map(([n, k]) => `${n}×${k}`).join("  "));
}

if (t3Summary) {
  const failed = t3Summary.statusCounts.failed ?? 0;
  const interrupted = t3Summary.statusCounts.interrupted ?? 0;
  const cancelled = t3Summary.statusCounts.cancelled ?? 0;
  console.log(
    c.bold(`\nt3code v2`) +
      c.dim(
        `  (${t3Summary.totalRuns} runs: ${failed} failed · ${interrupted} interrupted · ${cancelled} cancelled · ${t3Summary.rejectedReceiptsCount} rejected receipts)\n`,
      ),
  );
  for (const r of t3Summary.problemRuns.slice(0, 10)) {
    const label = r.threadTitle ? `${r.threadTitle} (${r.runId})` : r.runId;
    const badge = r.status === "failed" ? c.red(r.status) : c.yellow(r.status);
    console.log(`  ${badge.padEnd(20)} ${c.dim(`[${r.provider}]`)} ${label}`);
  }
  if (t3Summary.rejectedReceipts.length) {
    console.log(c.bold(`\n  rejected command receipts\n`));
    for (const r of t3Summary.rejectedReceipts.slice(0, 10)) {
      console.log(`  ${c.yellow(`×${r.count}`)}  ${c.bold(r.commandType)}`);
      console.log(c.dim(`     err: ${r.sample}`));
    }
  }
}

console.log(
  c.dim(
    `\nNext: /factory-retro turns the repeats above into changes, or records why not.`,
  ),
);
console.log(
  c.dim(
    `Interactive sessions without transcripts: search Linear for FIP: and ## Session friction.\n`,
  ),
);
