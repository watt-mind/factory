#!/usr/bin/env bun
/**
 * Factory Swift Dispatch CLI (OPS-369).
 *
 * Injects structured events into the Factory event-runtime control API and
 * optionally follows the live execution trace on the worker pool.
 *
 * Usage:
 *   factory dispatch triage [--repo <name>] [--watch]
 *   factory dispatch status [--repo <name>] [--watch]
 *   factory dispatch janitor [--repo <name>] [--apply] [--watch]
 *   factory dispatch event <event-type> [--payload '<json>'] [--watch]
 */
import { parseArgs } from "node:util";
import { unauthorizedMessage } from "../event-runtime/lib/client.mjs";

export const DEFAULT_PORT = 7381;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_MS = 500;
export const DEFAULT_WATCH_TIMEOUT_MS = 10_000;
export const DEFAULT_WATCH_MAX_MS = 30 * 60_000;
export const EXIT = {
  CONTROL_API_ERROR: 1,
  RUN_NOT_COMPLETED: 2,
  NO_PROPOSAL: 3,
};
const TERMINAL_STATES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REFUSED",
  "TIMED_OUT",
]);

export function resolvePort(env = process.env) {
  return env.FACTORY_EVENT_PORT ? Number(env.FACTORY_EVENT_PORT) : DEFAULT_PORT;
}

export function resolveTimeoutMs(env = process.env) {
  const timeoutMs = Number(env.FACTORY_DISPATCH_TIMEOUT_MS);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

function positiveEnv(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolvePollMs(env = process.env) {
  return positiveEnv(env, "FACTORY_DISPATCH_POLL_MS", DEFAULT_POLL_MS);
}

export function resolveWatchTimeoutMs(env = process.env) {
  return positiveEnv(
    env,
    "FACTORY_DISPATCH_WATCH_TIMEOUT_MS",
    DEFAULT_WATCH_TIMEOUT_MS,
  );
}

export function resolveWatchMaxMs(env = process.env) {
  return positiveEnv(
    env,
    "FACTORY_DISPATCH_WATCH_MAX_MS",
    DEFAULT_WATCH_MAX_MS,
  );
}

const port = resolvePort();
const BASE_URL = `http://127.0.0.1:${port}`;
const timeoutMs = resolveTimeoutMs();
const pollMs = resolvePollMs();
const watchTimeoutMs = resolveWatchTimeoutMs();
const watchMaxMs = resolveWatchMaxMs();

const HELP = `factory dispatch — swift event-runtime task dispatcher

Usage:
  factory dispatch <action> [options]

Actions:
  triage              Dispatch triage-scan on a repo (event: factory.triage.requested)
  status              Dispatch factory status report (event: factory.status-report.requested)
  janitor             Dispatch worktree janitor scan/teardown (event: factory.janitor-scan / janitor-apply)
  event <type>        Dispatch arbitrary registered event type

Options:
  --repo <name>       Target repository (default: factory)
  --apply             For janitor: execute teardown instead of dry scan
  --payload <json>    Custom JSON payload for 'event' action
  --watch, -w         Stream live run trace to stdout until completion
  --json              Output raw JSON response
  --help, -h          Show this help

Exit status:
  0                  Event run completed
  1                  Control API or command error
  2                  Event run settled in a non-COMPLETED state, or --watch
                     exceeded FACTORY_DISPATCH_WATCH_MAX_MS (default 30 min)
  3                  Event was admitted but the planner produced no run
                     (NOOP, or a proposal still AWAITING_APPROVAL)
`;

function die(msg, code = 1) {
  console.error(`factory dispatch: ${msg}`);
  process.exit(code);
}

async function api(path, options = {}) {
  const token = process.env.FACTORY_CONTROL_API_TOKEN || null;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      signal: timeout,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err =
        res.status === 401 ||
        (res.status === 503 && json?.error === "control_api_token_unset")
          ? unauthorizedMessage(Boolean(token))
          : json?.error ||
            (Array.isArray(json?.errors)
              ? json.errors.join("; ")
              : `HTTP ${res.status}`);
      die(`control API error on ${path}: ${err}`);
    }
    return json;
  } catch (e) {
    if (timeout.aborted) {
      die(`control API request to ${path} timed out after ${timeoutMs}ms`);
    }
    die(
      `failed to reach event runtime on port ${port} — is 'factory serve' running? (${e.message})`,
    );
  }
}

function progress(message, json) {
  (json ? console.error : console.log)(message);
}

function finalWatchResult(
  { eventId, runId, state, reasonCode, ...extra },
  json,
) {
  const result = {
    eventId,
    runId,
    state,
    reasonCode: reasonCode ?? null,
    ...extra,
  };
  if (json) console.log(JSON.stringify(result));
  else {
    const subject = runId ? `Run ${runId}` : `Event ${eventId}`;
    console.log(
      `\n==> ${subject} settled: ${state} (${result.reasonCode || "ok"})`,
    );
  }
  return result;
}

async function streamTrace(eventId, runId, json) {
  progress(
    `\n==> Streaming live trace for run ${runId} (Ctrl+C to detach)...\n`,
    json,
  );
  let since = 0;
  const startedAt = Date.now();

  while (true) {
    const trace = await api(
      `/runs/${encodeURIComponent(runId)}/trace?since=${since}&limit=100`,
    );
    if (trace?.entries) {
      for (const entry of trace.entries) {
        since = Math.max(since, entry.seq);
        const time = entry.occurred_at
          ? new Date(entry.occurred_at).toLocaleTimeString()
          : "";
        const type = entry.type || "trace";
        let detail;
        if (entry.data?.text) detail = entry.data.text;
        else if (entry.data?.summary) detail = entry.data.summary;
        else if (entry.data?.command) detail = entry.data.command;
        else if (entry.data?.tool) detail = `[tool: ${entry.data.tool}]`;
        else detail = JSON.stringify(entry.data || {});

        progress(`[${time}] ${type.padEnd(14)} ${detail}`, json);
      }
    }

    const view = await api(`/runs/${encodeURIComponent(runId)}`);
    const state = view?.run?.state;
    if (TERMINAL_STATES.has(state)) {
      const latestAttempt = view.attempts?.at(-1);
      const result = finalWatchResult(
        { eventId, runId, state, reasonCode: latestAttempt?.reason_code },
        json,
      );
      return {
        exitCode: state === "COMPLETED" ? 0 : EXIT.RUN_NOT_COMPLETED,
        result,
      };
    }

    if (Date.now() - startedAt >= watchMaxMs) {
      const result = finalWatchResult(
        { eventId, runId, state: "WATCH_TIMEOUT", reasonCode: "watch_timeout" },
        json,
      );
      return { exitCode: EXIT.RUN_NOT_COMPLETED, result };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function findRunForEvent(source, eventId, maxWaitMs = watchTimeoutMs) {
  const start = Date.now();
  let proposal = null;
  while (Date.now() - start < maxWaitMs) {
    const res = await api(`/proposals?status=all`);
    proposal = (res.proposals || []).find(
      (p) => p.eventSource === source && p.eventId === eventId,
    );
    if (proposal?.runId) {
      return { runId: proposal.runId };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // A live proposal without a run is waiting on approval (or approved but
  // not yet started); noop/rejected/superseded/expired ones are a planner NOOP.
  if (
    proposal &&
    proposal.decision !== "noop" &&
    !proposal.expired &&
    (proposal.status === "open" || proposal.status === "approved")
  ) {
    return {
      runId: null,
      state: "AWAITING_APPROVAL",
      reasonCode: "awaiting_approval",
      proposalId: proposal.id ?? null,
      proposalStatus: proposal.status,
    };
  }
  const events = await api(`/events`);
  const event = (events.events || []).find(
    (entry) => entry.source === source && entry.eventId === eventId,
  );
  return {
    runId: null,
    state: "NOOP",
    reasonCode: event?.lastPlanError || proposal?.reason || "no_proposal",
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      apply: { type: "boolean", default: false },
      payload: { type: "string" },
      watch: { type: "boolean", short: "w", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const action = positionals[0];
  let eventType = "";
  let payload = {};
  const repo = values.repo || "factory";

  switch (action) {
    case "triage":
      eventType = "factory.triage.requested";
      payload = { repo };
      break;
    case "status":
      eventType = "factory.status-report.requested";
      payload = { repos: [repo] };
      break;
    case "janitor":
      eventType = values.apply
        ? "factory.janitor-apply.requested"
        : "factory.janitor-scan.requested";
      payload = { repo };
      break;
    case "event": {
      eventType = positionals[1];
      if (!eventType)
        die(
          "missing event type for 'event' action. Usage: factory dispatch event <type>",
        );
      if (values.payload) {
        try {
          payload = JSON.parse(values.payload);
        } catch (e) {
          die(`invalid JSON in --payload: ${e.message}`);
        }
      }
      break;
    }
    default:
      die(`unknown action "${action}". See: factory dispatch --help`);
  }

  const id = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const envelope = {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type: eventType,
    source: "factory-cli",
    subject: repo,
    occurredAt: new Date().toISOString(),
    correlationId: id,
    payload,
  };

  const res = await api("/replay", {
    method: "POST",
    body: JSON.stringify(envelope),
  });

  if (values.json && !values.watch) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  progress(`✓ Admitted event ${res.eventId} (type: ${eventType})`, values.json);
  progress(`  Source:  ${envelope.source}`, values.json);
  progress(`  Subject: ${envelope.subject}`, values.json);
  progress(`  Payload: ${JSON.stringify(payload)}`, values.json);

  if (values.watch) {
    progress(
      `\nWaiting for planner to assign proposal and run...`,
      values.json,
    );
    const planned = await findRunForEvent(envelope.source, envelope.eventId);
    if (planned.runId) {
      const watched = await streamTrace(
        envelope.eventId,
        planned.runId,
        values.json,
      );
      process.exitCode = watched.exitCode;
    } else {
      finalWatchResult({ eventId: envelope.eventId, ...planned }, values.json);
      process.exitCode = EXIT.NO_PROPOSAL;
    }
  } else {
    progress(
      `\nView live status: http://127.0.0.1:${process.env.FACTORY_EVENT_WEB_PORT || 7382}/#/events`,
      values.json,
    );
  }
}

if (import.meta.main) {
  main().catch((e) => die(e.message));
}
