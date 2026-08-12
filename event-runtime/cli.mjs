#!/usr/bin/env bun
/**
 * Event-runtime CLI (docs/event-runtime.md §12–§13, §15).
 *
 *   bun event-runtime/cli.mjs serve          # control API + planner + one worker
 *   bun event-runtime/cli.mjs status         # ... and the other operator verbs
 *
 * `serve` is the runtime: the explicit foreground start (§3 — no timer, no
 * daemon) that binds the loopback control API and runs the watched
 * plan → propose → approve → execute loop with a single worker. Every other
 * verb except update-pins is a client of that API via lib/client.mjs — the
 * database is never a client interface (§12). update-pins is the one
 * deliberate exception: it edits agent definition files in the repo, not
 * runtime state.
 */
import { readFileSync } from "node:fs";
import * as claude from "./lib/adapters/claude.mjs";
import * as command from "./lib/adapters/command.mjs";
import * as fake from "./lib/adapters/fake.mjs";
import { apiClient } from "./lib/client.mjs";
import {
  API_HOST, DEFAULT_PORT, dbPath, ensureHome, environmentName, policyVersion, runtimeHome, workspacesRoot,
} from "./lib/config.mjs";
import { openDb } from "./lib/db.mjs";
import { newWorkerId } from "./lib/ids.mjs";
import { publishOutbox } from "./lib/outbox.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { loadRegistry, updatePins } from "./lib/registry.mjs";
import { startApi } from "./lib/api.mjs";
import { reapExpiredLeases, runOnce } from "./lib/worker.mjs";

const USAGE = `event-runtime — watched event → agent runtime (docs/event-runtime.md)

usage: bun event-runtime/cli.mjs <command>

  serve [--port N] [--adapter-override fake]
                                 start the control API (loopback), planner,
                                 and one worker in the foreground
  status                         events, proposals, runs, anomalies
  events [status]                admitted events, optionally filtered by status
  proposals                      open proposals with TTL age
  agents                         registered agent definitions and event routing
  approve <proposal-id>          approve an open proposal
  reject <proposal-id> <reason>  reject an open proposal
  inject <envelope.json|->       replay an event envelope (same intake as the webhook)
  requeue <source> <event-id>    re-plan a dead-lettered or human_needed event
  cancel <run-id> [reason]       cancel a run before it is RUNNING
  retry <run-id> [--force]       re-queue a FAILED run (--force past maxAttempts)
  inspect <run-id>               spec, lifecycle journal, result, receipt, workspace
  update-pins                    re-pin agent definition content hashes (edits repo files)

All commands except serve and update-pins are clients of the control API and
need serve running on ${API_HOST}:${DEFAULT_PORT} (FACTORY_EVENT_PORT to change).`;

const stamp = () => new Date().toISOString();
const log = (line) => console.log(`[${stamp()}] ${line}`);
const pad = (value, width) => String(value ?? "-").padEnd(width);

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Run one client verb; connection refusal names the fix, exactly (§12). */
async function withClient(fn) {
  const client = apiClient();
  try {
    await fn(client);
  } catch (err) {
    if (err.status === undefined) {
      fail(`control API not reachable on ${client.host}:${client.port} — start it with: bun event-runtime/cli.mjs serve`);
    }
    fail(err.message);
  }
}

// ---------------------------------------------------------------------------
// serve — the runtime itself (§3: explicit foreground start, one worker)
// ---------------------------------------------------------------------------

async function serve(args) {
  const port = flagValue(args, "--port") ? Number(flagValue(args, "--port")) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0) fail(`serve: invalid --port ${flagValue(args, "--port")}`);
  const adapterOverride = flagValue(args, "--adapter-override") ?? undefined;
  const adapters = { claude, command, fake };
  if (adapterOverride && !adapters[adapterOverride]) {
    fail(`serve: unknown --adapter-override "${adapterOverride}" (have: ${Object.keys(adapters).join(", ")})`);
  }

  ensureHome();
  const db = openDb();
  const registry = loadRegistry();
  const pv = policyVersion();
  const owner = newWorkerId();

  const seenProposals = new Set();
  let lastSeq = db.query(`SELECT MAX(seq) AS m FROM lifecycle_events`).get().m ?? 0;

  /** Print any open proposal not yet announced — §12: proposals render here. */
  function announceProposals() {
    for (const p of db.query(`SELECT * FROM proposals WHERE status = 'open' ORDER BY created_at, rowid`).all()) {
      if (seenProposals.has(p.id)) continue;
      seenProposals.add(p.id);
      const spec = p.spec_json ? JSON.parse(p.spec_json) : null;
      if (p.decision === "run") {
        log(`proposal ${p.id}  agent ${spec?.agent}  ttl ${p.ttl_seconds}s`);
        log(`  approve with: bun event-runtime/cli.mjs approve ${p.id}`);
      } else {
        log(`proposal ${p.id}  decision ${p.decision}  reason ${p.reason ?? "-"}`);
      }
    }
  }

  /** Narrate approvals, cancellations, and terminal states from the journal. */
  function announceTransitions() {
    const rows = db.query(`SELECT * FROM lifecycle_events WHERE seq > ? ORDER BY seq`).all(lastSeq);
    for (const row of rows) {
      lastSeq = row.seq;
      if (["APPROVED", "CANCELLED", "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT"].includes(row.to_state)) {
        log(`run ${row.run_id} → ${row.to_state} (${row.reason ?? "-"}) by ${row.actor}`);
      }
    }
  }

  let busy = false;
  async function tick() {
    if (busy) return; // runOnce is async — never overlap the single worker (§3)
    busy = true;
    try {
      const nowMs = Date.now();
      planAdmittedEvents(db, registry, { now: nowMs, policyVersion: pv, adapterOverride });
      announceProposals();
      announceTransitions();
      reapExpiredLeases(db, { now: nowMs, policyVersion: pv });
      await runOnce(db, registry, adapters, {
        workspacesRoot: workspacesRoot(), owner, now: Date.now(), policyVersion: pv,
      });
      announceTransitions();
      // Watched-mode outbox sink (§15): display the result event, stamp it published.
      publishOutbox(db, {
        sink: (e) => log(`result event ${e.type} (${e.eventId}) artifact ${e.payload?.artifactHash ?? "-"}`),
        now: Date.now(),
      });
      // Discovered chains (OPS-223): a completed run with a registered
      // recommendation edge emits an internal event through the same intake;
      // the next planning pass proposes the follow-up, watched like anything.
      const chains = resolveChains(db, registry, { now: Date.now() });
      if (chains.emitted > 0) log(`chain: emitted ${chains.emitted} follow-up event(s) — planning`);
      for (const err of chains.errors) log(`chain error: ${err}`);
    } catch (err) {
      log(`tick error: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  const env = { name: environmentName(), home: runtimeHome(), adapter: adapterOverride ?? null };
  const server = startApi({
    db, registry, policyVersion: pv, port, env,
    onEvent: (kind) => {
      log(`event ${kind} — planning`);
      tick();
    },
  });
  server.on("listening", () => {
    log(`environment "${env.name}" — control API on http://${API_HOST}:${port} (db ${dbPath()}, policy ${pv})`);
    if (adapterOverride) log(`adapter override: all new run specs use "${adapterOverride}"`);
  });
  server.on("error", (err) => fail(`serve: ${err.message}`));

  // The watched loop starts ONLY once the API actually owns its port. A serve
  // that lost the bind race must die, not keep planning and working the same
  // database as the serve that won — that is a second unmanaged worker and a
  // straight violation of the §3 single-worker cap. (Observed live: a portless
  // serve raced the real one and executed its runs with stale code.)
  let timer = null;
  server.on("listening", () => {
    announceProposals();
    timer = setInterval(tick, 1000);
  });

  process.on("SIGINT", () => {
    log("shutting down");
    if (timer) clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref?.();
  });
}

// ---------------------------------------------------------------------------
// operator verbs — clients of the control API (§12–§13)
// ---------------------------------------------------------------------------

function countLine(label, counts, order = Object.keys(counts)) {
  const parts = order.map((k) => `${k} ${counts[k] ?? 0}`);
  return `${pad(label, 11)}${parts.join("   ")}`;
}

async function status(client) {
  const s = await client.status();
  if (s.env) {
    console.log(`${pad("env", 11)}${s.env.name}${s.env.adapter ? `   (adapter override: ${s.env.adapter})` : ""}   ${s.env.home}`);
  }
  console.log(countLine("events", s.events, ["admitted", "planned", "noop", "human_needed", "dead_lettered"]));
  console.log(countLine("proposals", s.proposals, ["open", "expired"]));
  const states = Object.keys(s.runs.byState);
  console.log(states.length ? countLine("runs", s.runs.byState, states) : `${pad("runs", 11)}none`);
  const a = s.anomalies;
  const anomalyLines = [];
  for (const id of a.expiredOpenProposals) anomalyLines.push(`expired open proposal ${id}`);
  if (a.staleLeases > 0) anomalyLines.push(`stale leases: ${a.staleLeases}`);
  if (a.unpublishedOutbox > 0) anomalyLines.push(`unpublished outbox rows: ${a.unpublishedOutbox}`);
  for (const d of a.deadLettered) anomalyLines.push(`dead-lettered (${d.source}, ${d.eventId}): ${d.lastError}`);
  if (anomalyLines.length === 0) console.log(`${pad("anomalies", 11)}none`);
  else for (const line of anomalyLines) console.log(`${pad("anomalies", 11)}${line}`);
}

async function events(client, statusFilter) {
  const { events: rows } = await client.events(statusFilter);
  if (rows.length === 0) {
    console.log(statusFilter ? `no events with status ${statusFilter}` : "no events");
    return;
  }
  console.log(`${pad("SOURCE", 16)}${pad("EVENT", 24)}${pad("TYPE", 36)}${pad("STATUS", 14)}${pad("ADMITTED", 26)}ERROR`);
  for (const e of rows) {
    console.log(
      `${pad(e.source, 16)}${pad(e.eventId, 24)}${pad(e.type, 36)}${pad(e.status, 14)}${pad(e.admittedAt, 26)}${e.lastPlanError ?? "-"}`,
    );
  }
}

async function proposals(client) {
  const { proposals: open } = await client.proposals();
  if (open.length === 0) {
    console.log("no open proposals");
    return;
  }
  console.log(`${pad("ID", 42)}${pad("DECISION", 14)}${pad("AGENT", 26)}${pad("TTL", 8)}${pad("EXPIRED", 9)}REASON`);
  for (const p of open) {
    console.log(
      `${pad(p.id, 42)}${pad(p.decision, 14)}${pad(p.agent, 26)}${pad(`${p.ttl_seconds}s`, 8)}${pad(p.expired ? "yes" : "no", 9)}${p.reason ?? "-"}`,
    );
  }
  console.log(`\napprove with: bun event-runtime/cli.mjs approve <id>`);
}

async function inspect(client, runId) {
  const view = await client.run(runId);
  const { run } = view;
  console.log(`run        ${run.runId}`);
  console.log(`state      ${run.state}   attempts ${run.attempts}/${run.spec.maxAttempts}`);
  console.log(`agent      ${run.spec.agent}   adapter ${run.spec.adapter}   contract ${run.spec.outputContract}`);
  console.log(`created    ${run.created_at}   updated ${run.updated_at}`);
  console.log(`workspace  ${view.workspace ?? "-"}`);
  console.log("\nlifecycle");
  for (const e of view.lifecycle) {
    console.log(`  ${pad(e.at, 26)}${pad(`${e.from_state ?? "·"} → ${e.to_state}`, 26)}${pad(e.actor, 24)}${e.reason ?? ""}`);
  }
  if (view.result) {
    console.log("\nresult");
    console.log(`  terminalState ${view.result.terminalState}   reason ${view.result.reasonCode ?? "-"}`);
    if (view.result.artifact !== undefined) console.log(`  artifact ${JSON.stringify(view.result.artifact)}`);
  }
  if (view.receipt) {
    console.log("\nreceipt");
    for (const [k, v] of Object.entries(view.receipt)) console.log(`  ${pad(k, 20)}${v ?? "-"}`);
  }
  if (view.result?.artifacts?.length) {
    console.log("\nartifacts");
    for (const a of view.result.artifacts) {
      console.log(`  ${pad(a.kind, 14)}${pad(a.sizeBytes != null ? `${a.sizeBytes}B` : "-", 10)}${pad(a.sha256, 66)}${a.uri}`);
    }
  }
}

async function agents(client) {
  const { agents: defs } = await client.agents();
  for (const d of defs) {
    console.log(`${d.ref}   contract ${d.outputContract}   mutating ${d.mutating}   timeout ${d.limits.timeout_seconds}s   attempts ${d.limits.attempts}`);
    console.log(`  capabilities  ${d.capabilities.filesystem}; ${(d.capabilities.services ?? []).join(", ") || "-"}`);
    console.log(`  files         ${d.promptFile}, ${d.inputSchemaFile}, ${d.outputSchemaFile}`);
    for (const t of d.eventTypes) {
      console.log(`  event type    ${t.type}   adapter ${t.adapter}   scope ${t.idempotencyScope.join("+")}   ttl ${t.proposalTtlSeconds ?? "-"}s`);
    }
  }
}

async function inject(client, file) {
  const raw = readFileSync(file === "-" ? 0 : file, "utf8");
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    fail(`inject: ${file} is not valid JSON: ${err.message}`);
  }
  const outcome = await client.replay(envelope);
  console.log(outcome.duplicate ? `duplicate — event ${outcome.eventId} was already admitted` : `admitted event ${outcome.eventId}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "serve":
      return serve(args);

    case "status":
      return withClient(status);

    case "events":
      return withClient((client) => events(client, args[0]));

    case "proposals":
      return withClient(proposals);

    case "agents":
      return withClient(agents);

    case "approve": {
      if (!args[0]) fail("usage: approve <proposal-id>");
      return withClient(async (client) => {
        const outcome = await client.approve(args[0]);
        if (outcome.approved) console.log(`approved — run ${outcome.runId} queued`);
        else console.log(`proposal expired and re-planned — review and approve the new proposal ${outcome.proposal.id}`);
      });
    }

    case "reject": {
      if (!args[0] || !args[1]) fail('usage: reject <proposal-id> "<reason>"');
      return withClient(async (client) => {
        await client.reject(args[0], args[1]);
        console.log(`rejected ${args[0]}`);
      });
    }

    case "inject": {
      if (!args[0]) fail("usage: inject <envelope.json|->");
      return withClient((client) => inject(client, args[0]));
    }

    case "requeue": {
      if (!args[0] || !args[1]) fail("usage: requeue <source> <event-id>");
      return withClient(async (client) => {
        await client.requeue(args[0], args[1]);
        console.log(`requeued (${args[0]}, ${args[1]}) — will be re-planned`);
      });
    }

    case "cancel": {
      if (!args[0]) fail("usage: cancel <run-id> [reason]");
      return withClient(async (client) => {
        await client.cancel(args[0], args[1]);
        console.log(`cancelled ${args[0]}`);
      });
    }

    case "retry": {
      if (!args[0]) fail("usage: retry <run-id> [--force]");
      return withClient(async (client) => {
        await client.retry(args[0], { force: args.includes("--force") });
        console.log(`re-queued ${args[0]}`);
      });
    }

    case "inspect": {
      if (!args[0]) fail("usage: inspect <run-id>");
      return withClient((client) => inspect(client, args[0]));
    }

    case "update-pins": {
      const changed = updatePins();
      console.log(changed.length ? `re-pinned: ${changed.join(", ")}` : "pins already current");
      return;
    }

    default:
      console.error(USAGE);
      process.exit(1);
  }
}

await main();
