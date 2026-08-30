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

export function resolvePort(env = process.env) {
  return env.FACTORY_EVENT_PORT ? Number(env.FACTORY_EVENT_PORT) : DEFAULT_PORT;
}

const port = resolvePort();
const BASE_URL = `http://127.0.0.1:${port}`;

const HELP = `factory dispatch — swift event-runtime task dispatcher

Usage:
  factory dispatch <action> [options]

Actions:
  triage              Dispatch triage-scan on a repo (event: factory.triage.requested)
  status              Dispatch factory status report (event: factory.status-report.requested)
  janitor             Dispatch worktree janitor scan/teardown (event: factory.janitor-scan / janitor-apply)
  event <type>        Dispatch arbitrary registered event type

Options:
  --repo <name>       Target repository (default: cwd repo or factory)
  --apply             For janitor: execute teardown instead of dry scan
  --payload <json>    Custom JSON payload for 'event' action
  --watch, -w         Stream live run trace to stdout until completion
  --json              Output raw JSON response
  --help, -h          Show this help
`;

function die(msg, code = 1) {
  console.error(`factory dispatch: ${msg}`);
  process.exit(code);
}

async function api(path, options = {}) {
  const token = process.env.FACTORY_CONTROL_API_TOKEN || null;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
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
    die(
      `failed to reach event runtime on port ${port} — is 'factory serve' running? (${e.message})`,
    );
  }
}

async function streamTrace(runId) {
  console.log(
    `\n==> Streaming live trace for run ${runId} (Ctrl+C to detach)...\n`,
  );
  let since = 0;
  let finished = false;

  while (!finished) {
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

        console.log(`[${time}] ${type.padEnd(14)} ${detail}`);
      }
    }

    const run = await api(`/runs/${encodeURIComponent(runId)}`);
    if (run && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) {
      // Not `finished = true`: the `break` below exits the loop directly, so
      // the while(!finished) condition is never re-evaluated after this branch.
      console.log(
        `\n==> Run ${runId} settled: ${run.state} (${run.reasonCode || "ok"})`,
      );
      if (run.state !== "COMPLETED") {
        process.exit(1);
      }
      break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function findRunForEvent(source, eventId, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await api(`/proposals`);
    const proposal = (res.proposals || []).find(
      (p) => p.eventSource === source && p.eventId === eventId,
    );
    if (proposal?.runId) {
      return proposal.runId;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
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

  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.log(`✓ Admitted event ${res.eventId} (type: ${eventType})`);
  console.log(`  Source:  ${envelope.source}`);
  console.log(`  Subject: ${envelope.subject}`);
  console.log(`  Payload: ${JSON.stringify(payload)}`);

  if (values.watch) {
    console.log(`\nWaiting for planner to assign proposal and run...`);
    const runId = await findRunForEvent(envelope.source, envelope.eventId);
    if (runId) {
      await streamTrace(runId);
    } else {
      console.log(
        `Event admitted. Check status via: factory events ps or web UI http://127.0.0.1:${port}`,
      );
    }
  } else {
    console.log(`\nView live status: http://127.0.0.1:${port}/#/events`);
  }
}

if (import.meta.main) {
  main().catch((e) => die(e.message));
}
