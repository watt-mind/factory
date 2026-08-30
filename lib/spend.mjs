/**
 * What today's runs have cost, in the notional units Claude reports.
 *
 * Lives here rather than in tick.mjs because the day budget has to bind every
 * stage that spawns an agent, not just dispatch. It used to gate dispatch
 * alone, which produced the exact inversion you do not want when over budget:
 * the stage that makes progress stopped, while triage and merge kept spawning
 * opus sessions every 5 and 10 minutes. On 2026-08-04 that ran to ~$335 of a
 * $200 budget, most of it re-reviewing two PRs that were already escalated and
 * waiting on a human.
 *
 * Subscription auth means these are not dollars — read it as a runaway guard.
 *
 * ONLY CLAUDE REPORTS A COST. codex, pi and agy stream token counts and no
 * price, so summing `total_cost_usd` alone measured 65% of the factory on
 * 2026-08-04 (109 codex + 50 agy runs contributed exactly $0) while the gate
 * reported it as the whole. A budget gate that cannot see a third of the runs is
 * worse than no gate, because it reads as green while the window drains.
 *
 * So the other harnesses are priced from their token counts, at Claude's rates,
 * and labelled as the estimate they are. The point is not accuracy — these were
 * never dollars — it is that every run moves the number.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseRun, estimateUSD } from "./transcript.mjs";

export const LOG_DIR = path.join(homedir(), ".factory/logs");

/**
 * {usd, reported, estimated, runs, skipped, scanned} — `estimated` is the
 * non-Claude share. A missing log directory is a clean, empty scan; other scan
 * failures are reported so callers can fail closed instead of mistaking them
 * for zero. A single log file that vanishes mid-scan (rotated or deleted
 * between the directory listing and its stat/read) is not a scan failure: it
 * is counted in `skipped` and the rest of the day still totals.
 */
export function todaysSpendBreakdown(
  logDir = LOG_DIR,
  { stat = statSync, readFile = readFileSync } = {},
) {
  const today = new Date().toISOString().slice(0, 10);
  let reported = 0,
    estimated = 0,
    runs = 0,
    skipped = 0;

  // Bun.Glob.scanSync() can represent a missing directory as an empty result,
  // which is indistinguishable from an idle day. Check it explicitly first so
  // ENOENT remains the one benign failure mode.
  try {
    stat(logDir);
  } catch (error) {
    if (error?.code === "ENOENT")
      return {
        usd: 0,
        reported: 0,
        estimated: 0,
        runs: 0,
        skipped: 0,
        scanned: false,
        reason: "no log directory",
      };

    return {
      usd: 0,
      reported: 0,
      estimated: 0,
      runs: 0,
      skipped: 0,
      scanned: false,
      error: errorMessage(error),
    };
  }

  try {
    for (const f of new Bun.Glob("*.jsonl").scanSync(logDir)) {
      const full = path.join(logDir, f);
      const day = fileDay(full, stat);
      if (day === null) {
        skipped++;
        continue;
      }
      if (day !== today) continue;
      let text;
      try {
        text = readFile(full, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        skipped++;
        continue;
      }
      const run = parseRun(f, text);
      runs++;
      if (run.cost > 0) reported += run.cost;
      else estimated += estimateUSD(run);
    }
  } catch (error) {
    return {
      usd: reported + estimated,
      reported,
      estimated,
      runs,
      skipped,
      scanned: false,
      error: errorMessage(error),
    };
  }
  return {
    usd: reported + estimated,
    reported,
    estimated,
    runs,
    skipped,
    scanned: true,
  };
}

/**
 * The YYYY-MM-DD a log file was last written, or null when the file cannot be
 * dated on its own — gone (ENOENT) or carrying an unusable mtime. Any other
 * stat failure propagates: it is the directory's problem, not one file's.
 */
function fileDay(full, stat) {
  let mtimeMs;
  try {
    mtimeMs = stat(full).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!Number.isFinite(mtimeMs)) return null;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function todaysSpendUSD(logDir = LOG_DIR) {
  return todaysSpendBreakdown(logDir).usd;
}

/** null when under budget; a human-readable reason when the day is spent. */
export function budgetExhausted(policy, logDir = LOG_DIR, scanOptions) {
  const perDay = policy?.budget?.per_day_usd;
  if (!perDay) return null;
  const { usd, reported, estimated, error } = todaysSpendBreakdown(
    logDir,
    scanOptions,
  );
  if (error)
    return `day budget unavailable — unreadable log directory (${error})`;
  if (usd < perDay) return null;
  const split =
    estimated > 0.005
      ? ` — $${reported.toFixed(2)} reported + $${estimated.toFixed(2)} estimated for harnesses that report no cost`
      : "";
  return `day budget spent (~$${usd.toFixed(2)} of $${perDay} notional${split})`;
}
