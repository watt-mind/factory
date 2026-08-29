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
 *
 * The `--idle` mode is the loop that *acts* on an idle stall (#1063):
 *
 *   bun orchestrator/watchdog.mjs --idle --once --repo factory
 *   bun orchestrator/watchdog.mjs --idle --interval-sec 300
 *
 * It approves one waiting dispatch/work-scan proposal, or injects one
 * work-scan when the factory is idle with dispatchable supply — at most one
 * action per tick. See the "Idle watchdog" section below.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ROOT } from "../lib/schedule.mjs";
import { STATE_DIR } from "../lib/factory-state.mjs";
import { budgetExhausted } from "../lib/spend.mjs";
import { loadForge } from "../lib/forge/index.mjs";
import { resolveConfigPath } from "../event-runtime/lib/config.mjs";
import { reposRoot } from "../event-runtime/lib/repos.mjs";

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

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
    const [statusRes, workersRes, runningRes] = await Promise.all([
      fetch(`http://${host}:${port}/status`, {
        signal: AbortSignal.timeout(3000),
      }).then((r) => r.json()),
      fetch(`http://${host}:${port}/workers`, {
        signal: AbortSignal.timeout(3000),
      }).then((r) => r.json()),
      fetch(`http://${host}:${port}/runs?state=RUNNING`, {
        signal: AbortSignal.timeout(3000),
      }).then((r) => r.json()),
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

/* ------------------------------------------------------------------ *
 * Idle watchdog (#1063)
 *
 * The check above *reports* an idle stall; this one *ends* it. The
 * operator's requirement is blunt: the factory must not sit idle while
 * dispatchable work exists. The failure it repairs is real and recurring —
 * a work-scan proposal left open, or a 30m `work-factory` slot that has not
 * come round yet, while the agent-ready queue is non-empty and every worker
 * is asleep.
 *
 * Three rules keep an unattended repair loop from becoming the outage:
 *   1. At most ONE action per tick. Approving four proposals at once is how
 *      the claim lock gets burst; a 5m cadence catches up soon enough.
 *   2. An unreadable factory is never an idle factory. Serve down, a status
 *      read that throws, a supply read that fails — each is `skip`, never
 *      "0 in flight, inject". Injecting on a failed read is how a wedged
 *      runtime gets a scan storm on top of being wedged.
 *   3. Only proposals the planner already decided to `run` are approved.
 *      `human_needed` is a question addressed to a human and stays open.
 *   4. The loop never buys what unattended approval would refuse. Approving
 *      over the day budget, or with no runtime policy on disk, would let an
 *      unattended loop spend exactly where event-runtime/lib/auto-approval.mjs
 *      (`chainRuntimeGuard`) deliberately stops and waits for an operator.
 * ------------------------------------------------------------------ */

/**
 * Run states that do not occupy the factory. Mirrors the singleton predicate
 * in event-runtime/lib/schedules.mjs — PROPOSED is deliberately *not* in
 * flight (an unapproved proposal is exactly the stall we are here to clear).
 */
export const IDLE_TERMINAL_RUN_STATES = new Set([
  "PROPOSED",
  "COMPLETED",
  "REFUSED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
]);

/** Proposals this loop may approve: the two that start work, nothing else. */
export const IDLE_APPROVABLE_AGENTS = ["work-scan@1", "dispatch@1"];

/** One inject per minute, floor. Slower than any real dispatch, faster than a stall. */
export const IDLE_MIN_INJECT_INTERVAL_MS = 60_000;

/** Pages of open proposals a tick will read (200 each) before it stops asking. */
export const IDLE_PROPOSAL_MAX_PAGES = 5;

/** Default cadence for the loop itself: short, because a stall costs a whole slot. */
export const IDLE_DEFAULT_INTERVAL_SEC = 300;

/** Repeated `error=`/unreadable ticks before the loop shouts for a human. */
export const IDLE_FAILURE_ALERT_THRESHOLD = 3;

/** At most one repeated-failure notify an hour; the log line is free. */
export const IDLE_ALERT_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Skip reasons that mean "the read failed", not "the factory said no". These
 * are what a missing FACTORY_CONTROL_API_TOKEN looks like from here: every
 * call 401s, every tick skips, and nothing ever tells anyone.
 */
export const IDLE_READ_FAILURE_REASONS = new Set([
  "serve_unreachable",
  "runtime_state_unreadable",
  "proposals_unreadable",
  "supply_unreadable",
]);

/**
 * Stored `reason` codes on an open proposal that this loop may still approve.
 *
 * Anything auto-approval wrote as `auto_approval_ineligible:<code>` is its
 * refusal, and an unattended loop must not overturn it with an `operator`
 * approval that carries no spend policy. The one exception is a dispatch
 * recheck that deferred *because work was in flight* — the very condition an
 * idle tick has already observed to be false. A proposal with no stored
 * reason is the normal case: auto-approval only ever considers `chain` and
 * `handoff` sourced proposals, so a scheduler- or operator-sourced work-scan
 * (the stall this loop exists to clear) never carries one.
 */
export const IDLE_APPROVABLE_OPEN_REASONS = new Set([
  "auto_approval_ineligible:dispatch_recheck_deferred",
]);

/** True when a proposal's stored reason does not forbid an unattended approval. */
export function idleProposalReasonApprovable(reason) {
  if (reason === null || reason === undefined || reason === "") return true;
  return IDLE_APPROVABLE_OPEN_REASONS.has(String(reason));
}

/**
 * The db-free half of `chainRuntimeGuard` (auto-approval.mjs): is there a
 * runtime policy at all, and is the day budget spent?
 *
 * The other half — the worker cap and the environment-failure circuit breaker
 * — needs the runtime database, which this loop does not have (it speaks only
 * to the control API, possibly across a host boundary). The worker cap is
 * covered anyway: a tick only reaches an approval after observing zero runs in
 * flight. The circuit breaker is not, which is why the reason allowlist above
 * refuses any proposal auto-approval already declined; between the two, an
 * `operator` approval from here can no longer buy what the unattended path
 * refused on budget or policy grounds.
 *
 * @returns {null|"runtime_policy_unavailable"|"budget_exhausted"|"budget_check_failed"}
 */
export function idleApprovalGateReason({
  root = reposRoot(),
  runtimePolicy = undefined,
  budgetCheck = budgetExhausted,
} = {}) {
  let policy = runtimePolicy;
  if (policy === undefined) {
    try {
      const file = resolveConfigPath("policy", { root, warn: false });
      policy = existsSync(file)
        ? Bun.YAML.parse(readFileSync(file, "utf8"))
        : null;
      if (!policy || typeof policy !== "object") policy = null;
    } catch {
      policy = null;
    }
  }
  if (!policy) return "runtime_policy_unavailable";
  try {
    if (budgetCheck(policy)) return "budget_exhausted";
  } catch {
    return "budget_check_failed";
  }
  return null;
}

/**
 * In-flight run count from `GET /status`'s `runs.byState`, or null when the
 * shape is not readable. null means "unknown", and unknown is never idle.
 */
export function inFlightFromByState(byState) {
  if (!byState || typeof byState !== "object") return null;
  let total = 0;
  for (const [state, count] of Object.entries(byState)) {
    if (IDLE_TERMINAL_RUN_STATES.has(state)) continue;
    const n = Number(count);
    if (!Number.isFinite(n)) return null;
    total += n;
  }
  return total;
}

/**
 * The one decision this loop makes, as a pure function of what it observed.
 *
 * Everything that can go wrong is a distinct `reason`, so the log line says
 * why nothing happened — "idle but rate-limited" and "idle but the queue is
 * empty" are different facts and a single "no action" would hide both.
 *
 * @param {object} obs
 * @param {boolean} obs.serveOk        false/null → serve unreachable
 * @param {number|null} obs.inFlight   null → the status read failed
 * @param {Array|null} obs.proposals   open proposals, or null when unreadable
 * @param {number|null} obs.supply     dispatchable tickets, or null when unreadable
 * @param {number|null} obs.lastInjectAtMs
 * @param {() => (string|null)} obs.approvalGate  budget/policy gate, consulted
 *   only when a proposal is about to be approved (it reads the spend log).
 * @returns {{action: "skip"|"none"|"approve"|"inject", reason: string, proposalId?: string, inFlight: number|null, supply: number|null}}
 */
export function idleWatchdogDecision({
  serveOk,
  inFlight,
  proposals,
  supply,
  lastInjectAtMs = null,
  now = Date.now(),
  minInjectIntervalMs = IDLE_MIN_INJECT_INTERVAL_MS,
  approvableAgents = IDLE_APPROVABLE_AGENTS,
  approvalGate = () => null,
} = {}) {
  const base = { inFlight: inFlight ?? null, supply: supply ?? null };
  if (!serveOk) return { action: "skip", reason: "serve_unreachable", ...base };
  if (inFlight === null || inFlight === undefined || !Number.isFinite(inFlight))
    return { action: "skip", reason: "runtime_state_unreadable", ...base };
  if (inFlight > 0) return { action: "none", reason: "busy", ...base };

  // Idle. A proposal already exists for the work we would otherwise ask for:
  // approving it is strictly cheaper than injecting a second scan beside it.
  if (proposals === null || proposals === undefined)
    return { action: "skip", reason: "proposals_unreadable", ...base };
  const approvable = [...proposals]
    .filter(
      (p) =>
        p &&
        p.status === "open" &&
        p.decision === "run" &&
        !p.expired &&
        approvableAgents.includes(p.agent) &&
        // Never overturn an auto-approval refusal with an operator approval.
        idleProposalReasonApprovable(p.reason),
    )
    // Oldest first: the proposal that has waited longest is the stall.
    .sort((a, b) =>
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    );
  if (approvable.length > 0) {
    // The same gate unattended approval evaluates. Refusing here is a skip,
    // not a fall-through to inject: injecting would only manufacture another
    // proposal nobody is allowed to approve, at the cost of a scan.
    let gate;
    try {
      gate = approvalGate();
    } catch {
      gate = "gate_check_failed";
    }
    if (gate)
      return {
        action: "skip",
        reason: `budget_gate:${gate}`,
        proposalId: approvable[0].id,
        agent: approvable[0].agent,
        ...base,
      };
    return {
      action: "approve",
      reason: "open_dispatch_proposal",
      proposalId: approvable[0].id,
      agent: approvable[0].agent,
      ...base,
    };
  }

  if (supply === null || supply === undefined || !Number.isFinite(supply))
    return { action: "skip", reason: "supply_unreadable", ...base };
  if (supply <= 0) return { action: "none", reason: "no_supply", ...base };
  if (
    Number.isFinite(lastInjectAtMs) &&
    lastInjectAtMs !== null &&
    now - lastInjectAtMs < minInjectIntervalMs
  )
    return { action: "none", reason: "inject_rate_limited", ...base };
  // An injected work-scan spends too, so it answers to the same gate.
  let injectGate;
  try {
    injectGate = approvalGate();
  } catch {
    injectGate = "gate_check_failed";
  }
  if (injectGate)
    return { action: "skip", reason: `budget_gate:${injectGate}`, ...base };
  return { action: "inject", reason: "idle_with_supply", ...base };
}

/**
 * Why this tick counts as a failure, or null when it does not. A budget gate
 * refusing is the loop working; an unreadable factory is the loop blind.
 */
export function idleTickFailureCode(decision) {
  if (decision?.error) return "effect_failed";
  if (
    decision?.action === "skip" &&
    IDLE_READ_FAILURE_REASONS.has(decision.reason)
  )
    return decision.reason;
  return null;
}

/** The alert line a run of consecutive failures writes. */
export function formatIdleWatchdogAlert(
  count,
  code,
  { now = Date.now() } = {},
) {
  return `${new Date(now).toISOString()} idle-watchdog ALERT repeated_failures=${count} code=${code}`;
}

/** The single log line a tick is allowed to write. */
export function formatIdleWatchdogLine(decision, { now = Date.now() } = {}) {
  const parts = [
    new Date(now).toISOString(),
    "idle-watchdog",
    `action=${decision.action}`,
    `reason=${decision.reason}`,
    `inFlight=${decision.inFlight ?? "?"}`,
    `supply=${decision.supply ?? "?"}`,
  ];
  if (decision.proposalId) parts.push(`proposal=${decision.proposalId}`);
  if (decision.agent) parts.push(`agent=${decision.agent}`);
  if (decision.error) parts.push(`error=${decision.error}`);
  return parts.join(" ");
}

/** The work-scan envelope a tick injects. Same shape the scheduler emits. */
export function idleWorkRequestEnvelope(repo, { now = Date.now() } = {}) {
  const iso = new Date(now).toISOString();
  return {
    schemaVersion: "factory.event/v1",
    eventId: `idle-watchdog:${repo}:${iso}`,
    type: "factory.work.requested",
    source: "operator",
    subject: `work-${repo}`,
    occurredAt: iso,
    payload: { repo, reason: "idle-watchdog" },
  };
}

/**
 * One tick: observe, decide, take at most one action, log one line.
 *
 * Every observation and every effect is injected, so the whole loop is
 * testable against a fake runtime — which matters more here than anywhere
 * else in the orchestrator, because the code path that matters most is the
 * one that must NOT act.
 */
export async function runIdleWatchdogTick({
  repo = "factory",
  serveOk,
  inFlight,
  proposals,
  supply,
  approve,
  inject,
  approvalGate = idleApprovalGateReason,
  readState = () => ({}),
  writeState = () => {},
  notify = null,
  log = () => {},
  now = () => Date.now(),
  minInjectIntervalMs = IDLE_MIN_INJECT_INTERVAL_MS,
  failureAlertThreshold = IDLE_FAILURE_ALERT_THRESHOLD,
  alertMinIntervalMs = IDLE_ALERT_MIN_INTERVAL_MS,
} = {}) {
  const at = now();
  const safe = async (fn, fallback) => {
    if (typeof fn !== "function") return fallback;
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const up = await safe(serveOk, false);
  // Short-circuit the remaining reads when serve is down: they would all fail,
  // and each failed read is another few seconds of a cron tick spent waiting.
  const observed = up
    ? {
        inFlight: await safe(inFlight, null),
        proposals: await safe(proposals, null),
      }
    : { inFlight: null, proposals: null };
  // Supply is the expensive read (it goes to the tracker), so it is only taken
  // when the cheap local reads already say the factory is idle and unblocked.
  const needsSupply =
    up &&
    Number.isFinite(observed.inFlight) &&
    observed.inFlight === 0 &&
    Array.isArray(observed.proposals);
  const supplyCount = needsSupply ? await safe(supply, null) : null;

  const state = (await safe(readState, {})) ?? {};

  const decision = idleWatchdogDecision({
    serveOk: up,
    inFlight: observed.inFlight,
    proposals: observed.proposals,
    supply: supplyCount,
    lastInjectAtMs: Number.isFinite(state.lastInjectAtMs)
      ? state.lastInjectAtMs
      : null,
    now: at,
    minInjectIntervalMs,
    approvalGate,
  });

  let acted = false;
  if (decision.action === "approve") {
    try {
      await approve(decision.proposalId);
      acted = true;
    } catch (err) {
      decision.error = err.message;
    }
  } else if (decision.action === "inject") {
    try {
      await inject(idleWorkRequestEnvelope(repo, { now: at }));
      state.lastInjectAtMs = at;
      acted = true;
    } catch (err) {
      decision.error = err.message;
    }
  }

  log(formatIdleWatchdogLine(decision, { now: at }));

  // A loop that cannot read the factory is silent by design — one skip line an
  // interval into a log nobody tails. Three in a row is an outage (a stale or
  // missing FACTORY_CONTROL_API_TOKEN 401s every call), so it says so out loud.
  const failure = idleTickFailureCode(decision);
  let alerted = false;
  if (failure) {
    const streak =
      (Number.isFinite(state.failureStreak) ? state.failureStreak : 0) + 1;
    state.failureStreak = streak;
    state.lastFailureCode = failure;
    if (streak >= failureAlertThreshold) {
      log(formatIdleWatchdogAlert(streak, failure, { now: at }));
      const lastAlert = Number.isFinite(state.lastAlertAtMs)
        ? state.lastAlertAtMs
        : null;
      if (
        typeof notify === "function" &&
        (lastAlert === null || at - lastAlert >= alertMinIntervalMs)
      ) {
        const sent = await safe(
          () =>
            notify(
              `BLOCKED idle-watchdog: ${streak} consecutive failed ticks (${failure}) — the idle loop cannot act`,
            ),
          false,
        );
        if (sent !== false) {
          state.lastAlertAtMs = at;
          alerted = true;
        }
      }
    }
  } else if (state.failureStreak) {
    state.failureStreak = 0;
    state.lastFailureCode = null;
  }

  await safe(() => writeState(state), undefined);
  return { decision, acted, alerted, failureStreak: state.failureStreak ?? 0 };
}

/* --- default (live) observations and effects ---------------------------- */

const controlApiToken = () => process.env.FACTORY_CONTROL_API_TOKEN ?? "";

async function controlApi(
  pathname,
  { host, port, method = "GET", body = null, timeoutMs = 8000 } = {},
) {
  const headers = {};
  const token = controlApiToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`http://${host}:${port}${pathname}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Live dependencies for `runIdleWatchdogTick`.
 *
 * The state file is what makes the rate limit survive the one-shot form: a
 * `--once` invocation on a cron has no memory of the previous tick, and an
 * in-process counter would let five crons inject five scans.
 */
export function liveIdleWatchdogDeps({
  repo = "factory",
  host = "127.0.0.1",
  port = 7381,
  stateFile = path.join(STATE_DIR, "idle-watchdog.json"),
  logFile = path.join(homedir(), ".factory", "logs", "idle-watchdog.log"),
} = {}) {
  const api = (pathname, opts) => controlApi(pathname, { host, port, ...opts });
  return {
    repo,
    serveOk: async () => {
      // Serve answers /health while its event loop is briefly busy, so one
      // retry separates "wedged" from "was mid-tick when we asked".
      for (const attempt of [0, 1]) {
        try {
          await api("/health", { timeoutMs: 15000 });
          return true;
        } catch {
          if (attempt === 1) return false;
        }
      }
      return false;
    },
    inFlight: async () =>
      inFlightFromByState((await api("/status"))?.runs?.byState),
    // `GET /proposals` returns newest-first pages, so a single default page
    // hides the *oldest* open proposals — exactly the ones the loop wants.
    // Page explicitly at the API's max limit and let the decision sort.
    proposals: async () => {
      const all = [];
      let cursor = null;
      for (let page = 0; page < IDLE_PROPOSAL_MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ status: "open", limit: "200" });
        if (cursor) query.set("before", cursor);
        const body = await api(`/proposals?${query}`);
        const rows = body?.proposals;
        if (!Array.isArray(rows)) return page === 0 ? null : all;
        all.push(...rows);
        cursor = body?.nextBefore ?? null;
        if (!cursor) break;
      }
      return all;
    },
    supply: async () => {
      const { fetchQueueSummaries, loadQueueConfig } =
        await import("../lib/queue-summary.mjs");
      const { repos, defaultCap } = loadQueueConfig([repo]);
      if (!repos.length) return null;
      const summaries = await fetchQueueSummaries(repos, defaultCap);
      const mine = summaries.find((s) => s.repo === repo);
      // `startable` is dispatchable supply: agent-ready, unblocked, and not
      // colliding with an in-flight ticket's Owned Paths. A ticket the
      // dispatcher would refuse is not a reason to wake it up.
      return mine ? mine.startable.length : null;
    },
    approve: (id) =>
      api(`/proposals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: "{}",
        timeoutMs: 30000,
      }),
    inject: (envelope) =>
      api("/replay", {
        method: "POST",
        body: JSON.stringify(envelope),
        timeoutMs: 30000,
      }),
    readState: () => {
      try {
        const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    },
    writeState: (state) => {
      try {
        mkdirSync(path.dirname(stateFile), { recursive: true });
        writeFileSync(stateFile, JSON.stringify(state));
      } catch {
        // A read-only state dir costs the rate limit and the alert
        // throttle, not the loop.
      }
    },
    notify: (message) => {
      if (!Bun.which("factory")) return false;
      const result = Bun.spawnSync({
        cmd: ["factory", "notify", message],
        cwd: ROOT,
        stdout: "ignore",
        stderr: "ignore",
      });
      return result.exitCode === 0;
    },
    log: (line) => {
      console.log(line);
      try {
        mkdirSync(path.dirname(logFile), { recursive: true });
        appendFileSync(logFile, `${line}\n`);
      } catch {
        // stdout already carries the line; a missing log dir is not fatal.
      }
    },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes("--json");
  const once = argv.includes("--once");
  const shouldNotify = argv.includes("--notify");
  const intervalIdx = argv.indexOf("--interval-sec");
  const idle = argv.includes("--idle");
  const repoIdx = argv.indexOf("--repo");
  const repo = repoIdx !== -1 ? (argv[repoIdx + 1] ?? "factory") : "factory";
  const defaultInterval = idle ? IDLE_DEFAULT_INTERVAL_SEC : 300;
  const intervalSec =
    intervalIdx !== -1
      ? parseInt(argv[intervalIdx + 1], 10) || defaultInterval
      : defaultInterval;

  async function tick() {
    if (idle) {
      // `--idle` is a different loop with a different contract: it acts, it
      // never alerts, and it exits 0 whatever it decided — a cron must not
      // read "the factory was busy" as a failed job.
      return runIdleWatchdogTick(liveIdleWatchdogDeps({ repo }));
    }
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
    process.exit(idle ? 0 : result.ok ? 0 : 1);
  } else {
    console.log(
      c.bold(
        idle
          ? `Starting factory idle-watchdog for ${repo} (checking every ${intervalSec}s)...`
          : `Starting factory watchdog daemon (checking every ${intervalSec}s)...`,
      ),
    );
    await tick();
    setInterval(async () => {
      await tick();
    }, intervalSec * 1000);
  }
}
