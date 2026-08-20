#!/usr/bin/env bun
/**
 * What is the factory SPENDING, and on what?
 *
 *   bun orchestrator/economics.mjs                # every captured run
 *   bun orchestrator/economics.mjs --since 2d
 *   bun orchestrator/economics.mjs --json         # machine-readable
 *   bun orchestrator/economics.mjs --roll         # append to the durable rollup
 *
 * friction.mjs answers "what wasted the agents' TIME". This answers "what
 * consumed the CONTEXT and the usage window" — the other half, and the one that
 * decides how much work fits in a day.
 *
 * Three things it measures that a per-run cost figure cannot:
 *
 *   - CONTEXT BURN. Every tool result is re-sent on every later turn of the
 *     session. A 600KB screenshot read at turn 5 of a 40-turn run is not paid
 *     for once, it is paid for 35 times. So the interesting number is not
 *     "tokens in the reply", it is bytes-of-tool-output x turns-remaining.
 *   - CACHE REUSE. cache_read is 0.1x and cache_write is 1.25x, so a session
 *     that keeps invalidating its prefix costs an order of magnitude more than
 *     one that appends. The read:write ratio is the single best health number.
 *   - WASTE. Runs that produced no result, harnesses erroring on quota, runs
 *     killed at the wall-clock cap. These cost a dispatch slot and real minutes
 *     while producing nothing, and they do not show up in any cost field.
 *
 * MULTI-HARNESS ON PURPOSE. The factory dispatches to claude, codex, pi and agy,
 * and each streams a different JSON schema. A parser that only understands
 * Claude reports the other three as "no result / $0" — which is exactly the
 * shape of a blind spot that hides a broken harness for days. Every schema is
 * normalised into one Run record here, and `lib/spend.mjs` shares the parser so
 * the budget gate cannot see a different world than this report does.
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { dbPath } from "../event-runtime/lib/config.mjs";
import { modelTierEconomicsView } from "../event-runtime/lib/metrics.mjs";
import {
  LOG_DIR,
  METRICS_DIR,
  ROLLUP,
  parseRun,
  messageSignature,
  parseDuration,
} from "../lib/transcript.mjs";

/**
 * Load normalised run records from orchestrator transcripts.
 *
 * Exported so launch metrics (and tests) can reuse the same parser and
 * directory contract as this CLI, without importing a file that used to
 * exit as a side effect of being loaded.
 */
export function loadTranscriptRuns({ logDir = LOG_DIR, sinceMs = 0 } = {}) {
  if (!existsSync(logDir)) {
    return {
      ok: false,
      code: "no-dir",
      message: `no transcripts at ${logDir}`,
      runs: [],
      files: [],
    };
  }
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      f,
      p: path.join(logDir, f),
      t: statSync(path.join(logDir, f)).mtimeMs,
    }))
    .filter((x) => x.t >= sinceMs)
    .sort((a, b) => a.t - b.t);
  if (!files.length) {
    return {
      ok: false,
      code: "no-match",
      message: "no transcripts match",
      runs: [],
      files: [],
    };
  }
  return {
    ok: true,
    code: "ok",
    message: null,
    files,
    runs: files.map(({ f, p, t }) => parseRun(f, readFileSync(p, "utf8"), t)),
  };
}

/** Per-harness token and run totals. Pure; takes already-parsed Run records. */
export function harnessTokenTotals(runs) {
  const m = new Map();
  for (const r of runs) {
    const key = r.harness || "unknown";
    const row = m.get(key) ?? {
      harness: key,
      runs: 0,
      ok: 0,
      fail: 0,
      none: 0,
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
      estCost: 0,
    };
    row.runs++;
    if (r.ok === true) row.ok++;
    else if (r.ok === false) row.fail++;
    else row.none++;
    row.in += r.in ?? 0;
    row.out += r.out ?? 0;
    row.cacheRead += r.cacheRead ?? 0;
    row.cacheWrite += r.cacheWrite ?? 0;
    row.cost += r.cost ?? 0;
    row.estCost += r.estCost ?? 0;
    row.tokens = row.in + row.out;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.runs - a.runs);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  const JSON_OUT = argv.includes("--json");
  const ROLL = argv.includes("--roll");
  const TOP = Number(val("--top") ?? 15);

  if (!existsSync(LOG_DIR)) {
    console.error(`no transcripts at ${LOG_DIR}`);
    process.exit(1);
  }

  // --gate: is there enough un-rolled material to justify a retro run? Filename
  // comparison only — the rollup keys on the transcript basename, so this never
  // parses a transcript (the gate must stay cheap enough to poll). Exit 0 when
  // >= --gate-min (default 5) completed runs are not yet in the rollup; runs
  // younger than 5 minutes are skipped as possibly still streaming, mirroring
  // the in-flight rule in the rollup writer below.
  if (argv.includes("--gate")) {
    const min = Number(val("--gate-min") ?? 5);
    const seen = new Set();
    if (existsSync(ROLLUP)) {
      for (const line of readFileSync(ROLLUP, "utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          seen.add(JSON.parse(line).file);
        } catch {
          /* intentionally ignored */
        }
      }
    }
    const unrolled = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".jsonl") && !seen.has(f))
      .filter(
        (f) =>
          Date.now() - statSync(path.join(LOG_DIR, f)).mtimeMs > 5 * 60_000,
      );
    console.error(
      `gate: ${unrolled.length} un-rolled run(s), threshold ${min}`,
    );
    process.exit(unrolled.length >= min ? 0 : 1);
  }

  const sinceArg = val("--since");
  const sinceMs = sinceArg ? Date.now() - parseDuration(sinceArg) : 0;

  const files = readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      f,
      p: path.join(LOG_DIR, f),
      t: statSync(path.join(LOG_DIR, f)).mtimeMs,
    }))
    .filter((x) => x.t >= sinceMs)
    .sort((a, b) => a.t - b.t);

  if (!files.length) {
    console.error("no transcripts match");
    process.exit(1);
  }

  const runs = files.map(({ f, p, t }) =>
    parseRun(f, readFileSync(p, "utf8"), t),
  );

  // ---------------------------------------------------------------- rollup ---
  // Transcripts are big (350MB for two days) and will eventually be pruned. The
  // rollup is the small, permanent record: one line per run, append-only, keyed
  // by log filename so re-running is idempotent. This is what a dashboard reads.
  if (ROLL) {
    mkdirSync(METRICS_DIR, { recursive: true });
    const seen = new Set();
    if (existsSync(ROLLUP)) {
      for (const line of readFileSync(ROLLUP, "utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          seen.add(JSON.parse(line).file);
        } catch {
          /* intentionally ignored */
        }
      }
    }
    let added = 0,
      inFlight = 0;
    for (const r of runs) {
      if (seen.has(r.file)) continue;
      // A run still streaming has no verdict yet, and the append-only key would
      // then refuse to replace the half-finished row. Judge that by RECENCY, not
      // by the missing verdict: a truncated transcript is a permanent record of a
      // killed run, and that is precisely the waste worth keeping.
      if (r.truncated && Date.now() - r.mtime < 5 * 60_000) {
        inFlight++;
        continue;
      }
      const { commands, toolResultBytes, toolCalls, errorSigs, ...rest } = r;
      // Maps stringify to {}. Flatten the two worth keeping — per-run tool mix and
      // failure shapes are what makes the rollup answer questions on its own,
      // after the 350MB of transcripts behind it have been pruned.
      appendFileSync(
        ROLLUP,
        JSON.stringify({
          ...rest,
          toolCalls: Object.fromEntries(toolCalls),
          errorSigs: Object.fromEntries(
            [...errorSigs].map(([k, v]) => [k, v.count]),
          ),
        }) + "\n",
      );
      added++;
    }
    console.error(
      `rollup: +${added} run(s)${inFlight ? `, ${inFlight} still in flight` : ""} -> ${ROLLUP}`,
    );
  }

  // ----------------------------------------------------------- aggregation ---
  const sum = (xs, k) => xs.reduce((a, b) => a + (b[k] ?? 0), 0);
  const groupBy = (xs, key) => {
    const m = new Map();
    for (const x of xs) {
      const k = key(x);
      (m.get(k) ?? m.set(k, []).get(k)).push(x);
    }
    return m;
  };

  const toolBytes = new Map(); // tool -> {bytes, calls, weighted}
  const toolCalls = new Map();
  const errorsBySig = new Map();
  for (const r of runs) {
    for (const [name, v] of r.toolResultBytes) {
      const t = toolBytes.get(name) ?? { bytes: 0, calls: 0, weighted: 0 };
      t.bytes += v.bytes;
      t.calls += v.calls;
      t.weighted += v.weighted;
      toolBytes.set(name, t);
    }
    for (const [name, n] of r.toolCalls)
      toolCalls.set(name, (toolCalls.get(name) ?? 0) + n);
    for (const [sig, v] of r.errorSigs) {
      const e = errorsBySig.get(sig) ?? {
        count: 0,
        runs: 0,
        sample: v.sample,
        tool: v.tool,
      };
      e.count += v.count;
      e.runs++;
      errorsBySig.set(sig, e);
    }
  }

  const totals = {
    runs: runs.length,
    cost: sum(runs, "cost"),
    freshIn: sum(runs, "in"),
    cacheRead: sum(runs, "cacheRead"),
    cacheWrite: sum(runs, "cacheWrite"),
    out: sum(runs, "out"),
    turns: sum(runs, "turns"),
    tools: sum(runs, "tools"),
    errors: sum(runs, "errors"),
    wallMin: sum(runs, "durMs") / 60000,
    resultBytes: sum(runs, "resultBytes"),
    weightedBytes: sum(runs, "weightedBytes"),
    wasted: runs.filter((r) => r.wasted).length,
    wastedMin:
      runs.filter((r) => r.wasted).reduce((a, b) => a + b.durMs, 0) / 60000,
  };

  // The runtime ledger is the source of truth for immutable RunSpecs and merged
  // tickets. Transcript filenames do identify tickets, but cannot safely recover
  // the tier from a mutable model name or the complete merge/fix history.
  let modelTierEconomics = [];
  const runtimeDb = dbPath();
  if (existsSync(runtimeDb)) {
    const db = new Database(runtimeDb, { readonly: true });
    try {
      modelTierEconomics = modelTierEconomicsView(db, {
        startMs: sinceMs,
        endMs: Date.now(),
      });
    } finally {
      db.close();
    }
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          totals,
          runs: runs.map(
            ({ commands, toolResultBytes, errorSigs, toolCalls, ...r }) => r,
          ),
          tools: [...toolBytes.entries()].map(([name, v]) => ({
            name,
            ...v,
            calls: toolCalls.get(name) ?? v.calls,
          })),
          errors: [...errorsBySig.entries()].map(([sig, v]) => ({ sig, ...v })),
          modelTierEconomics,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // --------------------------------------------------------------- render ---
  const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  };
  const M = (n) =>
    n >= 1e6
      ? (n / 1e6).toFixed(1) + "M"
      : n >= 1e3
        ? (n / 1e3).toFixed(0) + "k"
        : String(Math.round(n));
  const MB = (n) => (n / 1e6).toFixed(1) + "MB";
  const pad = (s, n) => String(s).padStart(n);
  const padR = (s, n) => String(s).padEnd(n);

  console.log(c.bold("\nmerged-ticket economics by model tier\n"));
  if (!modelTierEconomics.length) {
    console.log(
      c.dim("  no merged, RunSpec-pinned ticket cohorts in this window"),
    );
  } else {
    console.log(
      c.dim(
        "  tier       dispatched  merged  median $/merged  total $  std escalation",
      ),
    );
    for (const row of modelTierEconomics) {
      const escalation =
        row.standardTierEscalationRate == null
          ? "—"
          : `${(row.standardTierEscalationRate * 100).toFixed(1)}%`;
      console.log(
        `  ${padR(row.key, 11)}${pad(row.ticketsDispatched, 6)}${pad(row.ticketsMerged, 8)}` +
          `${pad(row.medianCostPerMergedTicketUSD == null ? "—" : "$" + row.medianCostPerMergedTicketUSD.toFixed(2), 17)}` +
          `${pad("$" + row.totalCostUSD.toFixed(2), 9)}${pad(escalation, 16)}`,
      );
    }
  }

  console.log(
    c.bold(
      `\neconomics across ${totals.runs} run(s)${sinceArg ? ` (last ${sinceArg})` : ""}\n`,
    ),
  );

  const allIn = totals.freshIn + totals.cacheRead + totals.cacheWrite;
  console.log(
    `  input   fresh ${pad(M(totals.freshIn), 7)}   cache-write ${pad(M(totals.cacheWrite), 7)}   cache-read ${pad(M(totals.cacheRead), 7)}`,
  );
  console.log(
    `  output  ${pad(M(totals.out), 7)}        wall ${pad(totals.wallMin.toFixed(0) + "min", 8)}    turns ${pad(totals.turns, 6)}   tools ${pad(totals.tools, 6)}`,
  );
  if (allIn) {
    const hit = (100 * totals.cacheRead) / allIn;
    const ratio = totals.cacheWrite ? totals.cacheRead / totals.cacheWrite : 0;
    const verdict =
      ratio >= 20
        ? c.green("healthy")
        : ratio >= 8
          ? c.yellow("mediocre")
          : c.red("POOR — prefix keeps invalidating");
    console.log(
      `  cache   ${hit.toFixed(1)}% of input served from cache · read:write 1:${ratio.toFixed(1)}  ${verdict}`,
    );
  }
  console.log(
    `  cost    $${totals.cost.toFixed(2)} notional  ${c.dim(`(subscription auth — a runaway gauge, not a bill)`)}`,
  );

  // Context burn is the number that actually explains the bill: bytes of tool
  // output multiplied by the turns that output was still in the window for.
  console.log(
    `  context ${MB(totals.resultBytes)} of tool output, re-sent ${MB(totals.weightedBytes)} across turns ` +
      c.dim(`(~${M(totals.weightedBytes / 4)} tok of cache traffic)`),
  );
  if (totals.wasted) {
    console.log(
      c.red(
        `  wasted  ${totals.wasted} run(s) produced nothing — ${totals.wastedMin.toFixed(0)}min of wall clock`,
      ),
    );
  }

  // ---- by harness: the blind spot that motivated this file -------------------
  console.log(
    c.bold(`\nby harness`) +
      c.dim(
        `   a harness that only ever errors still consumes dispatch slots\n`,
      ),
  );
  console.log(
    c.dim(
      "  harness   runs    ok   fail  none   cost$   wall   avg turns   note",
    ),
  );
  for (const [h, rs] of [...groupBy(runs, (r) => r.harness)].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const ok = rs.filter((r) => r.ok === true).length;
    const fail = rs.filter((r) => r.ok === false).length;
    const none = rs.filter((r) => r.ok === null).length;
    const cost = sum(rs, "cost");
    const wall = sum(rs, "durMs") / 60000;
    // Only Claude and agy report a duration. Printing "0m" for the others reads
    // as "instant" when it means "not measured" — say which it is.
    const wallCell =
      wall > 0 ? pad(wall.toFixed(0) + "m", 7) : c.dim(pad("n/a", 7));
    const note =
      cost === 0 && rs.length > 3
        ? c.yellow(
            `priced from tokens (~$${sum(rs, "estCost").toFixed(0)}) — this harness reports no cost`,
          )
        : "";
    console.log(
      `  ${padR(h, 9)}${pad(rs.length, 5)}${pad(ok, 6)}${pad(fail, 7)}${pad(none, 6)}${pad("$" + cost.toFixed(0), 8)}${wallCell}${pad((sum(rs, "turns") / rs.length).toFixed(0), 12)}   ${note}`,
    );
  }

  // ---- by stage --------------------------------------------------------------
  console.log(c.bold(`\nby stage\n`));
  console.log(
    c.dim(
      "  stage            runs   cost$  $/run  turns/run  tools/run  err  wasted  ctx re-sent",
    ),
  );
  for (const [s, rs] of [...groupBy(runs, (r) => r.stage)].sort(
    (a, b) => sum(b[1], "cost") - sum(a[1], "cost"),
  )) {
    const cost = sum(rs, "cost");
    console.log(
      `  ${padR(s, 16)}${pad(rs.length, 5)}${pad("$" + cost.toFixed(0), 8)}${pad("$" + (cost / rs.length).toFixed(2), 7)}` +
        `${pad((sum(rs, "turns") / rs.length).toFixed(0), 11)}${pad((sum(rs, "tools") / rs.length).toFixed(0), 11)}` +
        `${pad(sum(rs, "errors"), 5)}${pad(rs.filter((r) => r.wasted).length, 8)}${pad(MB(sum(rs, "weightedBytes")), 13)}`,
    );
  }

  // ---- by repo ---------------------------------------------------------------
  console.log(c.bold(`\nby repo\n`));
  console.log(c.dim("  repo             runs   cost$  $/run   err  wasted"));
  for (const [s, rs] of [...groupBy(runs, (r) => r.repo)].sort(
    (a, b) => sum(b[1], "cost") - sum(a[1], "cost"),
  )) {
    const cost = sum(rs, "cost");
    console.log(
      `  ${padR(s, 16)}${pad(rs.length, 5)}${pad("$" + cost.toFixed(0), 8)}${pad("$" + (cost / rs.length).toFixed(2), 7)}${pad(sum(rs, "errors"), 6)}${pad(rs.filter((r) => r.wasted).length, 8)}`,
    );
  }

  // ---- context burn ----------------------------------------------------------
  console.log(
    c.bold(`\ncontext burn by tool`) +
      c.dim(`   "re-sent" = payload x turns it stayed in the window\n`),
  );
  console.log(c.dim("     calls    payload    re-sent   avg/call   tool"));
  for (const [name, v] of [...toolBytes.entries()]
    .sort((a, b) => b[1].weighted - a[1].weighted)
    .slice(0, TOP)) {
    const avg = v.bytes / Math.max(1, v.calls);
    const flag = avg > 50000 ? c.red("  <- huge payload per call") : "";
    console.log(
      `  ${pad(toolCalls.get(name) ?? v.calls, 6)}${pad(MB(v.bytes), 11)}${pad(MB(v.weighted), 11)}${pad(M(avg) + "B", 11)}   ${name}${flag}`,
    );
  }

  // ---- worst individual runs -------------------------------------------------
  console.log(c.bold(`\nmost expensive runs\n`));
  for (const r of [...runs].sort((a, b) => b.cost - a.cost).slice(0, TOP)) {
    const ratio = r.cacheWrite ? (r.cacheRead / r.cacheWrite).toFixed(0) : "-";
    console.log(
      `  ${pad("$" + r.cost.toFixed(2), 8)}  ${pad(r.turns + "t", 6)} ${pad(r.tools + "tc", 7)}  cache 1:${pad(ratio, 3)}  ${pad((r.durMs / 60000).toFixed(0) + "m", 5)}  ${c.dim(r.file.replace(/\.+jsonl$/, ""))}`,
    );
  }

  // ---- waste -----------------------------------------------------------------
  const wasted = runs.filter((r) => r.wasted);
  if (wasted.length) {
    console.log(
      c.bold(`\nruns that produced nothing`) +
        c.dim(`   these still held a dispatch slot\n`),
    );
    // Group by failure SHAPE, not exact text: "quota reached, resets in 44h1m15s"
    // and "...44h21m16s" are one problem, and listing them separately buries it.
    const byReason = groupBy(wasted, (r) =>
      r.error
        ? messageSignature(r.error)
        : r.truncated
          ? "killed mid-run — no final envelope (wall-clock cap, crash, or kill)"
          : r.ok === false
            ? "harness reported failure"
            : "no verdict recorded",
    );
    for (const [reason, rs] of [...byReason]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, TOP)) {
      const mins = sum(rs, "durMs") / 60000;
      const where = [...new Set(rs.map((r) => r.harness))].join("/");
      console.log(
        `  ${c.red("x" + pad(rs.length, 3))}  ${padR(reason.slice(0, 66), 66)} ${c.dim(padR(where, 8))} ${c.dim(mins ? mins.toFixed(0) + "min" : "")}`,
      );
    }
  }

  console.log(
    c.dim(
      `\nNext: friction.mjs for what wasted time; --roll to persist these rows for a dashboard.\n`,
    ),
  );
}
