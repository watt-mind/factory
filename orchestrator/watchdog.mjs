#!/usr/bin/env bun
/**
 * Factory Watchdog — health inspection, wedged run detection, and circuit breaker.
 *
 *   factory watchdog --once
 *   factory watchdog --interval-sec 300 --notify
 *   factory watchdog --json
 *
 * Checks API/Web health, worker fleet, wedged runs, idle stalls, and CI runner status.
 * Emits factory notify alerts on critical failures.
 */
import { existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ROOT } from "../lib/schedule.mjs";
import { loadForge } from "../lib/forge/index.mjs";

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

export const SANDBOX_REFUSAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Every non-mutating `capabilities.filesystem: "workspace-only"` agent in
 * event-runtime/agents — i.e. exactly the set the #962 confinement gate can
 * refuse for a missing host sandbox. Mutating agents (dispatch, label-guard,
 * ci-notify …) never reach that gate and are deliberately absent.
 *
 * Kept as a literal rather than derived from the registry so the watchdog
 * stays a dependency-light health probe that runs without loading packs;
 * watchdog.test.mjs re-derives it from event-runtime/agents to keep it honest.
 */
export const SCAN_LOOP_AGENTS = Object.freeze([
  "agy-smoke",
  "ci-doctor",
  "ci-log-capture",
  "cursor-smoke",
  "disk-diagnose",
  "factory-status-report",
  "janitor-scan",
  "merge-plan",
  "merge-review",
  "merge-scan",
  "pi-smoke",
  "run-postmortem",
  "ship-scan",
  "sweep-scan",
  "triage-scan",
  "unblock-digest",
  "unblock-scan",
  "work-scan",
]);
const SCAN_LOOP_AGENT_SET = new Set(SCAN_LOOP_AGENTS);

/** Match on the bare agent name, ignoring pack namespace and `@version`. */
export function isScanLoopAgent(agent) {
  if (typeof agent !== "string" || agent === "") return false;
  return SCAN_LOOP_AGENT_SET.has(agent.split("@")[0].split("/").pop());
}

// A health probe must never become the slow thing it is watching. The refusal
// scan is therefore bounded three ways — pages, runs, and wall clock — so a
// backlog of thousands of refused runs costs a bounded amount of work on
// every watchdog tick and every `factory pulse`.
export const SANDBOX_REFUSAL_MAX_PAGES = 2;
export const SANDBOX_REFUSAL_MAX_RUNS = 50;
export const SANDBOX_REFUSAL_DETAIL_CONCURRENCY = 4;
export const SANDBOX_REFUSAL_BUDGET_MS = 5_000;

/**
 * Read recent scan refusals caused by a missing host sandbox capability.
 *
 * Bounded by construction: at most `SANDBOX_REFUSAL_MAX_PAGES` listing pages,
 * at most `SANDBOX_REFUSAL_MAX_RUNS` detail fetches, at most
 * `SANDBOX_REFUSAL_DETAIL_CONCURRENCY` of those in flight, and the whole
 * thing abandons what it has not read once `budgetMs` elapses. The result is
 * an alert signal, not an inventory: seeing *some* refusals is enough to
 * raise it, so truncation cannot produce a false "all clear".
 */
export async function fetchRecentSandboxRefusals({
  host = "127.0.0.1",
  port = 7381,
  fetchFn = fetch,
  now = Date.now(),
  windowMs = SANDBOX_REFUSAL_WINDOW_MS,
  maxPages = SANDBOX_REFUSAL_MAX_PAGES,
  maxRuns = SANDBOX_REFUSAL_MAX_RUNS,
  concurrency = SANDBOX_REFUSAL_DETAIL_CONCURRENCY,
  budgetMs = SANDBOX_REFUSAL_BUDGET_MS,
  clock = () => Date.now(),
} = {}) {
  const deadline = clock() + budgetMs;
  const outOfBudget = () => clock() >= deadline;
  const runs = [];
  const seenCursors = new Set();
  let before = null;
  for (let page = 0; page < maxPages; page += 1) {
    if (runs.length >= maxRuns || outOfBudget()) break;
    const url = new URL(`http://${host}:${port}/runs`);
    url.searchParams.set("state", "REFUSED");
    url.searchParams.set("population", "terminal");
    url.searchParams.set("from", new Date(now - windowMs).toISOString());
    url.searchParams.set("to", new Date(now + 1_000).toISOString());
    url.searchParams.set("limit", String(maxRuns));
    if (before) url.searchParams.set("before", before);
    const body = await fetchFn(url, {
      signal: AbortSignal.timeout(3000),
    }).then((response) => response.json());
    for (const run of body?.runs ?? []) {
      if (!isScanLoopAgent(run.agent)) continue;
      runs.push(run);
      if (runs.length >= maxRuns) break;
    }
    before = body?.nextBefore ?? null;
    if (!before || seenCursors.has(before)) break;
    seenCursors.add(before);
  }

  const refusals = [];
  let next = 0;
  const readOne = async (run) => {
    const detail = await fetchFn(
      `http://${host}:${port}/runs/${encodeURIComponent(run.runId)}`,
      { signal: AbortSignal.timeout(3000) },
    ).then((response) => response.json());
    const refusal = [...(detail?.lifecycle ?? [])]
      .reverse()
      .find(
        (entry) =>
          entry?.to_state === "REFUSED" &&
          typeof entry.reason === "string" &&
          entry.reason.includes("sandbox_unavailable:"),
      );
    if (refusal) {
      refusals.push({
        runId: run.runId,
        agent: run.agent,
        reason: refusal.reason,
        at: refusal.at,
      });
    }
  };
  const worker = async () => {
    while (next < runs.length && !outOfBudget()) {
      await readOne(runs[next++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, runs.length) }, worker),
  );
  return refusals;
}

export async function runWatchdogCheck({
  host = "127.0.0.1",
  port = 7381,
  webPort = 7382,
  stuckMinutes = 45,
  checkShadowFleet = true,
} = {}) {
  const issues = [];
  const metrics = {
    apiOk: false,
    webOk: false,
    workersCount: 0,
    runningRuns: 0,
    wedgedRuns: 0,
    queuedRuns: 0,
    sandboxRefusals: [],
    anomalies: [],
  };

  // 1. Control API Health
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      metrics.apiOk = true;
    } else {
      issues.push({
        severity: "CRITICAL",
        code: "API_ERROR",
        message: `Control API returned HTTP ${res.status}`,
      });
    }
  } catch (err) {
    issues.push({
      severity: "CRITICAL",
      code: "API_DOWN",
      message: `Control API on :${port} unreachable: ${err.message}`,
    });
  }

  // 2. Web UI Health
  try {
    const webRes = await fetch(`http://${host}:${webPort}/`, {
      signal: AbortSignal.timeout(2000),
    });
    metrics.webOk = webRes.ok || webRes.status === 404;
  } catch {
    issues.push({
      severity: "WARNING",
      code: "WEB_DOWN",
      message: `Web UI on :${webPort} unreachable`,
    });
  }

  // If API is down, we cannot perform status/workers checks
  if (!metrics.apiOk) {
    return { ok: false, issues, metrics };
  }

  // 3. Workers & Runs Status from API
  try {
    const [statusRes, workersRes, runningRes, sandboxRefusals] =
      await Promise.all([
        fetch(`http://${host}:${port}/status`, {
          signal: AbortSignal.timeout(3000),
        }).then((r) => r.json()),
        fetch(`http://${host}:${port}/workers`, {
          signal: AbortSignal.timeout(3000),
        }).then((r) => r.json()),
        fetch(`http://${host}:${port}/runs?state=RUNNING`, {
          signal: AbortSignal.timeout(3000),
        }).then((r) => r.json()),
        fetchRecentSandboxRefusals({ host, port }),
      ]);

    const workers = workersRes?.workers ?? [];
    metrics.workersCount = workers.length;
    if (workers.length === 0) {
      issues.push({
        severity: "CRITICAL",
        code: "NO_WORKERS",
        message: "No live workers registered in event runtime",
      });
    }

    const runs = runningRes?.runs ?? [];
    metrics.runningRuns = runs.length;
    const now = Date.now();
    const wedged = runs.filter((r) => {
      const created = new Date(r.created_at || now).getTime();
      const updated = new Date(r.updated_at || r.created_at || now).getTime();
      const ageMin = (now - created) / 60000;
      const quietMin = (now - updated) / 60000;
      return ageMin > stuckMinutes && quietMin > stuckMinutes / 2;
    });

    metrics.wedgedRuns = wedged.length;
    for (const w of wedged) {
      const ageMin = Math.round(
        (now - new Date(w.created_at).getTime()) / 60000,
      );
      issues.push({
        severity: "CRITICAL",
        code: "WEDGED_RUN",
        message: `Run ${w.runId} (${w.agent}) in ${w.state} for ${ageMin}m without progress`,
      });
    }

    metrics.queuedRuns = statusRes?.runs?.byState?.QUEUED ?? 0;
    metrics.sandboxRefusals = sandboxRefusals;
    if (metrics.sandboxRefusals.length > 0) {
      const agents = [
        ...new Set(metrics.sandboxRefusals.map((entry) => entry.agent)),
      ].sort();
      issues.push({
        severity: "CRITICAL",
        code: "SCAN_SANDBOX_UNAVAILABLE",
        message: `Scan loops refused: sandbox unavailable (${agents.join(", ")})`,
      });
    }
    const idleWorkers = workers.filter((w) => w.state === "idle").length;
    if (
      metrics.queuedRuns > 0 &&
      idleWorkers > 0 &&
      metrics.runningRuns === 0
    ) {
      issues.push({
        severity: "WARNING",
        code: "IDLE_STALL",
        message: `${metrics.queuedRuns} runs queued with ${idleWorkers} idle workers, but 0 running`,
      });
    }

    if (statusRes?.anomalies) {
      const anomalyList = [];
      for (const [key, val] of Object.entries(statusRes.anomalies)) {
        if (Array.isArray(val) && val.length > 0) {
          anomalyList.push(`${key}: ${val.length}`);
        } else if (typeof val === "number" && val > 0) {
          anomalyList.push(`${key}: ${val}`);
        }
      }
      metrics.anomalies = anomalyList;
      if (anomalyList.length > 0) {
        issues.push({
          severity: "WARNING",
          code: "RUNTIME_ANOMALIES",
          message: `Runtime reported anomalies (${anomalyList.join(", ")})`,
        });
      }
    }
  } catch (err) {
    issues.push({
      severity: "WARNING",
      code: "STATUS_FETCH_ERROR",
      message: `Failed fetching status details: ${err.message}`,
    });
  }

  // 4. CI Runner Fleet Check
  if (checkShadowFleet) {
    try {
      const forge = loadForge();
      const queuedCount = forge
        .runList("watt-mind/factory", {
          limit: 10,
          fields: ["status"],
          cwd: ROOT,
        })
        .filter((r) => r.status === "queued").length;
      if (queuedCount > 2) {
        const onlineShadows =
          parseInt(
            forge.apiRaw("orgs/watt-mind/actions/runners", {
              jq: '[.runners[] | select(.labels | map(.name) | index("shadow")) | select(.status=="online")] | length',
              cwd: ROOT,
            }),
            10,
          ) || 0;
        if (onlineShadows === 0) {
          issues.push({
            severity: "CRITICAL",
            code: "FLEET_OFFLINE",
            message: `${queuedCount} CI runs queued with 0 online shadow runners (actions.runner fleet down)`,
          });
        }
      }
    } catch {
      /* intentionally ignored */
    }
  }

  const hasCritical = issues.some((i) => i.severity === "CRITICAL");
  return {
    ok: !hasCritical,
    issues,
    metrics,
  };
}

export function formatWatchdogReport(result) {
  const lines = [];
  const ts = new Date().toUTCString();
  if (result.ok && result.issues.length === 0) {
    lines.push(`${c.green("✓")} ${c.bold("WATCHDOG OK")} — ${ts}`);
    lines.push(
      `  Workers: ${result.metrics.workersCount} | Running: ${result.metrics.runningRuns} | Wedged: ${result.metrics.wedgedRuns}`,
    );
  } else {
    const badge = result.ok
      ? c.yellow("! WATCHDOG WARNING")
      : c.red("✗ WATCHDOG CRITICAL");
    lines.push(`${badge} — ${ts}`);
    for (const issue of result.issues) {
      const col = issue.severity === "CRITICAL" ? c.red : c.yellow;
      lines.push(
        `  ${col(`[${issue.severity}]`)} ${c.bold(issue.code)}: ${issue.message}`,
      );
    }
  }
  return lines.join("\n");
}

export async function sendWatchdogNotification(issues) {
  const critical = issues.filter((i) => i.severity === "CRITICAL");
  if (critical.length === 0) return;

  const eventType = critical.some(
    (i) => i.code === "FLEET_OFFLINE" || i.code === "API_DOWN",
  )
    ? "CIRCUIT BREAKER"
    : "BLOCKED";

  const msg = `${eventType} watchdog: ${critical.map((i) => i.message).join("; ")}`;
  try {
    const result = Bun.spawnSync({
      cmd: ["factory", "notify", msg],
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes("--json");
  const once = argv.includes("--once");
  const shouldNotify = argv.includes("--notify");
  const intervalIdx = argv.indexOf("--interval-sec");
  const intervalSec =
    intervalIdx !== -1 ? parseInt(argv[intervalIdx + 1], 10) || 300 : 300;

  async function tick() {
    const result = await runWatchdogCheck();
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatWatchdogReport(result));
    }

    if (shouldNotify && !result.ok) {
      await sendWatchdogNotification(result.issues);
    }
    return result;
  }

  if (once) {
    const result = await tick();
    process.exit(result.ok ? 0 : 1);
  } else {
    console.log(
      c.bold(
        `Starting factory watchdog daemon (checking every ${intervalSec}s)...`,
      ),
    );
    await tick();
    setInterval(async () => {
      await tick();
    }, intervalSec * 1000);
  }
}
