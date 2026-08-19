/**
 * Timing-bound test registry and condition-polling helpers (WM-918).
 *
 * Required CI excludes tests whose names contain any TIMING_TEST_SUBSTRINGS
 * entry. A separate non-required job runs that group with retries. Classify
 * a bun-test log so merge-scan can treat an all-timing failure as a flake
 * rather than ESCALATE if exclusion ever misses.
 *
 * Each substring still has to fail on the regression it guards — quarantining
 * is not a skip of the assertion, only of the required lane.
 */
import { readFileSync } from "node:fs";

const parsedLoadFactor = Number.parseFloat(process.env.CI_LOAD_FACTOR ?? "1");

/**
 * Stretch only liveness ceilings when CI reports shared-host contention.
 * Assertions still wait on observable state; this is not a fixed delay.
 */
export const CI_LOAD_FACTOR =
  Number.isFinite(parsedLoadFactor) && parsedLoadFactor >= 1
    ? Math.min(parsedLoadFactor, 4)
    : 1;

export const loadAdjustedTimeout = (timeoutMs) =>
  Math.ceil(timeoutMs * CI_LOAD_FACTOR);

/**
 * Known wall-clock spawn tests. Keep the strings as they appear in bun's
 * test name (describe prefix optional — substring match). Regression notes
 * document how the assertion still fails when the production bug returns.
 */
export const TIMING_TEST_SUBSTRINGS = [
  // Drain must finish the leased hang-run before exiting 0. A worker that
  // exits on the drain flag mid-run fails the `run_drain_busy →` vs
  // `drain requested` order assertion in cli/work.test.mjs.
  "a drain-signalled worker holding a lease finishes its run first, then exits 0",
  // Reload is HEAD-and-worktree, not HEAD-only. A stamp that ignores the
  // working tree never logs `reloading worker (exit 75)` in cli/work.test.mjs.
  "an idle worker exits 75 within a poll interval of an uncommitted edit",
  // Scale-down must drain to workers.min and stay there. A supervisor that
  // respawns past min fails `poolSize === 1` / "no third spawn" in
  // cli/supervise.test.mjs.
  "surplus idle workers drain back to workers.min, and the pool is not respawned past target",
  // Whole describe: beforeAll races ECONNREFUSED on a just-bound ephemeral
  // port. Duplicate-prefix still fails immediately on intake; re-seed still
  // requires a new prefix to clear hang runs (demo/seed.test.mjs, OPS-464).
  "seed & re-seed deduplication (OPS-464)",
  "re-seeding with a NEW prefix cleans up hang runs and allows verify to pass",
  // Durable inbox POST against a live stub server. A notify that falls back
  // to the unreachable-runtime path leaves requestFile unwritten
  // (bin/factory.test.mjs).
  "factory notify posts a structured inbox item when serve is reachable",
  // Adapter timeout must kill the grandchild, not just the wrapper. A leak
  // fails `expectProcessExit` in lib/adapters/cursor.test.mjs (WM-263).
  "timeout kills a real long-lived grandchild",
];

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function timingIncludePattern(substrings = TIMING_TEST_SUBSTRINGS) {
  if (!substrings.length) {
    throw new Error("timing include pattern requires at least one substring");
  }
  return `(${substrings.map(escapeRegex).join("|")})`;
}

export function timingExcludePattern(substrings = TIMING_TEST_SUBSTRINGS) {
  return `^(?!.*(?:${substrings.map(escapeRegex).join("|")})).*$`;
}

export function isTimingTestName(name, substrings = TIMING_TEST_SUBSTRINGS) {
  const haystack = String(name ?? "");
  return substrings.some((s) => haystack.includes(s));
}

/**
 * Parse failing test names from `bun test` stdout/stderr.
 * Handles `(fail) file > describe > name` and `✗ name [12.00ms]` forms.
 */
export function parseFailingTests(logText) {
  const names = [];
  const seen = new Set();
  const push = (name) => {
    const trimmed = String(name ?? "").trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    names.push(trimmed);
  };

  for (const raw of String(logText ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const fail = /^\(fail\)\s+(.+)$/.exec(line);
    if (fail) {
      const body = fail[1];
      const parts = body.split(" > ");
      push(parts[parts.length - 1].replace(/\s+\[[^\]]+\]\s*$/, ""));
      continue;
    }
    const mark = /^\s*[×x✗✘]\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/.exec(line);
    if (mark) push(mark[1]);
  }
  return names;
}

export function classifyTimingFailures(
  logText,
  substrings = TIMING_TEST_SUBSTRINGS,
) {
  const failing = parseFailingTests(logText);
  const timing = failing.filter((name) => isTimingTestName(name, substrings));
  const other = failing.filter((name) => !isTimingTestName(name, substrings));
  return {
    failing,
    timing,
    other,
    allTiming: failing.length > 0 && other.length === 0,
  };
}

/**
 * Poll `fn` until it returns a truthy value. Ceiling stretches with
 * CI_LOAD_FACTOR; the predicate is the assertion, not the clock.
 */
export async function until(
  what,
  fn,
  { timeoutMs = 15_000, everyMs = 10 } = {},
) {
  const ceiling = loadAdjustedTimeout(timeoutMs);
  const deadline = Date.now() + ceiling;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await Bun.sleep(everyMs);
  }
  throw new Error(
    `${what} did not become true within ${ceiling}ms (CI_LOAD_FACTOR=${CI_LOAD_FACTOR})`,
  );
}

/** Ask the OS for a free loopback port and release the probe. */
export function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`freePort() got invalid port ${port}`);
  }
  return String(port);
}

export function formatTimingClassifyAnnotation(result) {
  const names = result.failing.join(", ") || "(none parsed)";
  if (result.failing.length === 0) {
    return `::warning title=timing-classify::No bun failing-test names parsed from the log.`;
  }
  if (result.allTiming) {
    return `::error title=timing-flake::All failing tests are in the WM-918 timing group: ${names}`;
  }
  return `::error title=non-timing-fail::Failures include tests outside the WM-918 timing group: ${result.other.join(", ")}`;
}

function printClassify(logText) {
  const result = classifyTimingFailures(logText);
  for (const name of result.failing) {
    const kind = isTimingTestName(name) ? "timing" : "other";
    console.log(`${kind}: ${name}`);
  }
  if (result.failing.length === 0) {
    console.log("timing-classify: no failing test names parsed");
  } else if (result.allTiming) {
    console.log("timing-classify: all failures are in the timing group");
  } else {
    console.log("timing-classify: mixed or non-timing failures");
  }
  console.log(formatTimingClassifyAnnotation(result));
}

if (import.meta.main) {
  const verb = process.argv[2] ?? "";
  if (verb === "exclude-pattern") {
    process.stdout.write(`${timingExcludePattern()}\n`);
  } else if (verb === "include-pattern") {
    process.stdout.write(`${timingIncludePattern()}\n`);
  } else if (verb === "classify") {
    const file = process.argv[3];
    if (!file) {
      console.error("classify requires a log file path");
      process.exit(2);
    }
    printClassify(readFileSync(file, "utf8"));
  } else {
    console.error(
      "usage: bun event-runtime/lib/test-helpers-timing.mjs exclude-pattern|include-pattern|classify <logfile>",
    );
    process.exit(2);
  }
}
