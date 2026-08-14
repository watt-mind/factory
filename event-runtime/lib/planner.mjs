/**
 * Deterministic planner (docs/event-runtime.md §4, §5.2, §5.4, §13).
 *
 * Everything here is code, not model: an admitted event maps to exactly one
 * registered agent, its payload is schema-checked, and the run's idempotency
 * key is derived from declared scope fields so the same fact can never spawn
 * two runs. Planning is idempotent — re-planning an already-planned event
 * returns the recorded outcome — and a poison event that keeps throwing is
 * dead-lettered instead of wedging the sweep or silently vanishing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { liveWorkerLeases } from "../../lib/worker-leases.mjs";
// Imported as a library, never copied (docs/event-runtime-dispatch.md §4):
// one collision oracle for both mutation paths, with its safety biases —
// missing Owned Paths owns everything, ambiguous overlap errs to collision.
import { effectiveOwnedPaths, pathsCollide } from "../../orchestrator/owned-paths.mjs";
import { findArtifact, pinRunArtifact } from "./artifacts.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { artifactsRoot, DEAD_LETTER_AFTER, DEFAULT_PROPOSAL_TTL_SECONDS, FACTORY_ROOT } from "./config.mjs";
import { isBusyError, tx, txImmediate } from "./db.mjs";
import { newProposalId, newRunId } from "./ids.mjs";
import { createRun, resolveIdempotency } from "./lifecycle.mjs";
import { getAgent, getEventType, resolveModel } from "./registry.mjs";
import { getRepo, loadRepos, reposRoot } from "./repos.mjs";
import { pinRepo } from "./repository.mjs";
import { validate } from "./schema.mjs";
import { loopInFlight } from "./schedules.mjs";
import { resolveInputRef } from "./workspace.mjs";

/**
 * §5.4 idempotency key: agent ref, output contract, then the event type's
 * declared scope fields in declared order. Unknown scope fields fail closed —
 * a typo in a mapping must not silently widen or narrow dedup.
 */
export function idempotencyKeyFor(mapping, def, envelope, inputHash) {
  const parts = mapping.idempotencyScope.map((field) => {
    switch (field) {
      case "correlationId":
        return envelope.correlationId ?? envelope.eventId;
      case "subject":
        return envelope.subject ?? "";
      case "inputHash":
        return inputHash;
      default:
        throw new Error(`unknown idempotency scope field "${field}" (docs/event-runtime.md §5.4 — fail closed)`);
    }
  });
  return `${def.ref}:${def.output_contract}:${parts.join(":")}`;
}

/**
 * Per-agent repo scoping (WM-64), the repo analogue of the actions adapter's
 * host allowlist: a definition that declares `repos` may only run over those
 * repos. Applies to any input carrying a `repo` field, whatever the workspace
 * or adapter. Returns the typed refusal reason, or null when in scope (no
 * `repos` declared, or no `repo` in the payload, or a member of the set).
 */
export function repoNotAllowed(def, payload) {
  if (!Array.isArray(def.repos) || typeof payload?.repo !== "string") return null;
  if (def.repos.includes(payload.repo)) return null;
  return `repo_not_allowed: ${def.ref} may not run over ${payload.repo} (allowed: ${def.repos.join(", ")})`;
}

/**
 * Pure assembly of the §5.2 RunSpec from a registered mapping. No I/O, no
 * clock reads beyond the injected `now` — same inputs, same spec, always.
 */
export function buildRunSpec(registry, envelope, mapping, { runId, policyVersion, adapterOverride, now = Date.now() } = {}) {
  const def = getAgent(registry, mapping.agent);
  let payload = envelope.payload;
  if (def.workspace?.type === "repository" && payload?.repo) {
    try {
      payload = { ...payload, repoPin: pinRepo(payload.repo, payload.ref ?? undefined) };
    } catch (err) {
      if (!payload?.repoPin) throw err;
    }
  }
  const inputHash = hashJson(payload);
  const placement = def.placement ?? mapping.placement ?? undefined;
  const specEnvelope = payload === envelope.payload ? envelope : { ...envelope, payload };
  let idempotencyKey = idempotencyKeyFor(mapping, def, specEnvelope, inputHash);
  const correlation = envelope.correlationId ?? envelope.eventId ?? null;
  if (correlation && !mapping.idempotencyScope.includes("correlationId") && !mapping.idempotencyScope.includes("eventId")) {
    idempotencyKey = `${idempotencyKey}:${correlation}`;
  }
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: mapping.agent,
    input: payload,
    inputHash,
    workspace: def.workspace,
    adapter: adapterOverride ?? mapping.adapter,
    promptVersion: policyVersion,
    policyVersion,
    outputContract: def.output_contract,
    capabilities: def.capabilities.services,
    // Declared repo scope (WM-64) rides in the spec so the proposal the
    // operator approves names it, same as capabilities.
    ...(def.repos ? { repos: def.repos } : {}),
    // Model-tier routing (WM-135), the house repoPin pattern: the tier is
    // resolved HERE, at plan time, and the concrete value is pinned so the
    // proposal, receipt, and inspect output all name the exact model. Fields
    // appear only when the definition declares intent — an undeclared
    // definition's spec is byte-identical to before (regression contract).
    // Resolution keys off the REGISTERED adapter (mapping.adapter), not the
    // override: `--adapter-override fake` substitutes execution, and the fake
    // ignores the model; the spec still records what was routed. A null model
    // means the routed adapter takes none (not applicable).
    ...(def.model_tier !== undefined || def.model !== undefined
      ? { modelTier: def.model_tier ?? null, model: resolveModel(def, mapping.adapter, registry.modelTiers) }
      : {}),
    timeoutSeconds: def.limits.timeout_seconds,
    maxAttempts: def.limits.attempts,
    idempotencyKey,
    ...(placement ? { placement } : {}),
  };
}

/** policy.yaml's per-repo cap fallback, read from the same root as repos.yaml. */
export const DEFAULT_MAX_IN_FLIGHT = 3;

function policyMaxInFlight(root = reposRoot()) {
  const file = path.join(root, "config", "policy.yaml");
  if (!existsSync(file)) return DEFAULT_MAX_IN_FLIGHT;
  try {
    const n = Bun.YAML.parse(readFileSync(file, "utf8"))?.concurrency?.max_in_flight_per_repo;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IN_FLIGHT;
  } catch {
    return DEFAULT_MAX_IN_FLIGHT;
  }
}

/**
 * Plan-time Linear reads for the dispatch gate, through the factory's own
 * Linear surface (tools/linear.mjs — gql retries, backoff, and key loading
 * live there; a second client would be a second set of bugs). Synchronous
 * subprocesses because the planner is synchronous code; planEvent calls the
 * gate BEFORE its write transaction so these round trips never hold the
 * SQLite write lock. A transport failure throws — planAdmittedEvents turns
 * that into plan_failures with retry and eventual dead-letter (§13), which is
 * the right shape for a transient outage, unlike a one-shot refusal.
 */
const linearCli = () => path.join(FACTORY_ROOT, "tools", "linear.mjs");

function fetchTicketDefault(ticketId) {
  try {
    return JSON.parse(
      execFileSync("bun", [linearCli(), "get", ticketId, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    );
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    if (stderr.includes("no such issue")) return null;
    throw new Error(`linear_read_failed: ${stderr.trim().split("\n").pop() || err.message}`);
  }
}

// The same query shape tick.mjs uses for its in-flight set (dispatch doc §4).
const IN_FLIGHT_QUERY =
  `query($t:String!,$p:String!){ issues(first:250, filter:{ team:{key:{eq:$t}}, project:{name:{eq:$p}}, state:{name:{eq:"In Progress"}} }){ nodes{ identifier description } } }`;

function fetchInFlightDefault(repoConfig) {
  try {
    const out = execFileSync(
      "bun",
      [linearCli(), "raw", IN_FLIGHT_QUERY, "--var", `t=${repoConfig.team}`, "--var", `p=${repoConfig.project}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out)?.issues?.nodes ?? [];
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    throw new Error(`linear_read_failed: ${stderr.trim().split("\n").pop() || err.message}`);
  }
}

/**
 * The dispatch gate (docs/event-runtime-dispatch.md §§2–5, WM-108): may a
 * tier-2 mutating run for {repo, ticket} be PROPOSED right now? Checked
 * cheapest-first — repo config, then the shared lease ledger, then Linear.
 *
 * Refusal semantics follow the doc: durable config states an operator must
 * change (unknown repo, report_only, missing worktree scripts, missing
 * team/project, vanished ticket) are `human_needed` — visible in the inbox
 * and requeue-able after the fix. Transient world states (claimed ticket,
 * full cap, Owned Paths overlap) are typed NOOPs — a false refusal costs one
 * NOOP and the next request re-reads a fresh world; parking them as inbox
 * asks would train the operator to approve stale facts.
 *
 * This is the plan-time half of the doc's "checked twice" rule; the
 * execute-time re-check (claim lock file, lease write, cap and overlap under
 * the approval TTL) belongs to the executor and is NOT implemented here.
 *
 * @returns {null | { decision: "noop" | "human_needed", reason: string }}
 */
export function worktreeDispatchGate(payload, {
  fetchTicket = fetchTicketDefault,
  fetchInFlight = fetchInFlightDefault,
  countLeases = (repoName) => liveWorkerLeases(repoName).length,
  maxInFlightFallback,
} = {}) {
  let repo;
  try {
    repo = getRepo(loadRepos(), payload?.repo);
  } catch (err) {
    return { decision: "human_needed", reason: `repo_unknown: ${err.message}` };
  }
  // report_only repos are never tier-2 targets (dispatch doc §5): safe
  // concurrency of one human, same refusal as tick.mjs.
  if (repo.reportOnly) return { decision: "human_needed", reason: "repo_report_only" };
  if (!repo.worktreeUp || !repo.worktreeDown || !repo.worktreeRoot) {
    return { decision: "human_needed", reason: "no_worktree_scripts" };
  }

  // One budget for both paths (§3): the repo's cap against the dispatcher's
  // own lease ledger — files under ~/.factory/worker-leases that count every
  // live ticket worker, whichever coordinator started it.
  const cap = repo.maxInFlight ?? maxInFlightFallback ?? policyMaxInFlight();
  if (countLeases(repo.name) >= cap) return { decision: "noop", reason: "capacity_full" };

  // The Linear assignee stays the only ticket lock (§2). Stricter than
  // tick.mjs on purpose — any assignee refuses; the asymmetry is recorded in
  // the doc (§2, §9) and collapses when OPS-40 lands. Do not "fix" either
  // side to match the other.
  const ticket = fetchTicket(payload.ticket);
  if (!ticket) return { decision: "human_needed", reason: "ticket_not_found" };
  if (ticket.assignee) return { decision: "noop", reason: "ticket_assigned" };
  if (ticket.state?.name !== "Todo") return { decision: "noop", reason: "ticket_not_todo" };
  if (!(ticket.labels?.nodes ?? []).some((l) => l.name === "ai:agent-ready")) {
    return { decision: "noop", reason: "ticket_not_agent_ready" };
  }

  // One collision oracle (§4): the in-flight set is Linear's In Progress
  // tickets for the repo's team/project, whichever path claimed them.
  if (!repo.team || !repo.project) {
    return { decision: "human_needed", reason: "repo_unconfigured: team/project missing for the in-flight query" };
  }
  const inFlight = fetchInFlight(repo);
  const busy = inFlight
    .filter((i) => i.identifier !== payload.ticket)
    .flatMap((i) => effectiveOwnedPaths(i.description ?? ""));
  if (pathsCollide(effectiveOwnedPaths(ticket.description ?? ""), busy)) {
    return { decision: "noop", reason: "owned_paths_overlap" };
  }
  return null;
}

function insertProposal(db, { id, event, runId = null, decision, specJson = null, specHash = null, idempotencyKey = null, status, reason = null, at, ttlSeconds }) {
  db.query(
    `INSERT INTO proposals
       (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
        idempotency_key, status, reason, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, event.source, event.event_id, runId, decision, specJson, specHash, idempotencyKey, status, reason, at, ttlSeconds);
  return db.query(`SELECT * FROM proposals WHERE id = ?`).get(id);
}

function setEventStatus(db, event, status) {
  db.query(`UPDATE events SET status = ? WHERE source = ? AND event_id = ?`).run(status, event.source, event.event_id);
}

function humanNeeded(db, event, reason, at, ttlSeconds) {
  const proposal = insertProposal(db, {
    id: newProposalId(), event, decision: "human_needed", status: "open", reason, at, ttlSeconds,
  });
  setEventStatus(db, event, "human_needed");
  return { decision: "human_needed", proposal, reason };
}

/** Idempotent path: the event was already planned — report what was decided. */
function existingOutcome(db, event) {
  const proposal = db
    .query(`SELECT * FROM proposals WHERE event_source = ? AND event_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(event.source, event.event_id);
  if (!proposal) return { decision: event.status, reason: event.last_plan_error ?? undefined };
  return {
    decision: proposal.decision,
    proposal,
    runId: proposal.run_id ?? undefined,
    reason: proposal.reason ?? undefined,
  };
}

/**
 * Plan one admitted event: NOOP | HUMAN_NEEDED | RUN (§4). All writes for one
 * plan happen in one transaction; re-planning is idempotent.
 *
 * @returns {{ decision: string, proposal?: object, runId?: string, reason?: string }}
 */
export function planEvent(db, registry, { source, eventId }, { now = Date.now(), policyVersion = "unknown", adapterOverride, artifactStore = artifactsRoot(), dispatch = {} } = {}) {
  // Dispatch gate for tier-2 worktree agents (WM-108), evaluated BEFORE the
  // write transaction: its Linear and lease reads must never hold the SQLite
  // write lock across a network round trip. The verdict is applied inside the
  // transaction only when the event is still admitted there — a raced plan
  // simply discards it via the idempotent early return.
  let worktreeRefusal = null;
  {
    const row = db.query(`SELECT status, envelope_json FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
    if (row?.status === "admitted") {
      const preEnvelope = JSON.parse(row.envelope_json);
      const preMapping = getEventType(registry, preEnvelope.type);
      const preDef = preMapping && preMapping.observe !== true ? registry.agents.get(preMapping.agent) : null;
      // An event already outside the definition's repo scope (WM-64) skips
      // the gate's Linear/lease reads entirely — the transaction below parks
      // it repo_not_allowed before anything else happens.
      if (
        preDef?.workspace?.type === "worktree" &&
        typeof preEnvelope.payload?.repo === "string" &&
        typeof preEnvelope.payload?.ticket === "string" &&
        !repoNotAllowed(preDef, preEnvelope.payload)
      ) {
        worktreeRefusal = worktreeDispatchGate(preEnvelope.payload, dispatch);
      }
    }
  }
  return txImmediate(db, () => {
    const event = db.query(`SELECT * FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
    if (!event) throw new Error(`no admitted event (${source}, ${eventId})`);
    if (event.status !== "admitted") return existingOutcome(db, event);

    const envelope = JSON.parse(event.envelope_json);
    const at = new Date(now).toISOString();

    const mapping = getEventType(registry, envelope.type);
    if (!mapping) return humanNeeded(db, event, "unregistered_event_type", at, DEFAULT_PROPOSAL_TTL_SECONDS);
    const ttlSeconds = mapping.proposalTtlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;

    // Observe-only types (WM-75): the orchestrator reporting its own
    // lifecycle. The event is the deliverable — admitted, journaled,
    // queryable — and the plan is a typed NOOP, never an inbox ask.
    if (mapping.observe === true) {
      const proposal = insertProposal(db, {
        id: newProposalId(), event, decision: "noop", status: "resolved",
        reason: "observed", at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, reason: "observed" };
    }

    const def = getAgent(registry, mapping.agent);

    // Per-agent repo scoping (WM-64): checked before anything else the plan
    // would do for the run — no repo pin, no mirror fetch, no worktree
    // materialization for a repo the definition may never touch. Same idea as
    // the actions adapter's host allowlist, enforced at plan time.
    const scopeRefusal = repoNotAllowed(def, envelope.payload);
    if (scopeRefusal) return humanNeeded(db, event, scopeRefusal, at, ttlSeconds);

    // §5 singleton: a scheduled loop whose previous run is still in flight
    // plans a typed NOOP, never a second queued run. A reaper that takes 70
    // minutes must not accumulate a backlog of reapers.
    const loop = envelope.payload?.loop;
    const schedule = loop ? registry.schedules?.[loop] : null;
    if (schedule && schedule.singleton !== false && loopInFlight(db, mapping.agent)) {
      const proposal = insertProposal(db, {
        id: newProposalId(), event, decision: "noop", status: "resolved",
        reason: "previous_run_in_flight", at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, reason: "previous_run_in_flight" };
    }

    const input = validate(def.inputSchema, envelope.payload);
    if (!input.valid) return humanNeeded(db, event, `invalid_input: ${input.errors[0]}`, at, ttlSeconds);

    // Tier-2 dispatch gate verdict (docs/event-runtime-dispatch.md §§2–5,
    // WM-108), computed above outside this transaction. Refusals are typed
    // and carry their reason; a null verdict means every check passed at the
    // moment of the read — the doc's execute-time re-check owns the TTL gap.
    if (def.workspace?.type === "worktree" && worktreeRefusal) {
      if (worktreeRefusal.decision === "human_needed") {
        return humanNeeded(db, event, worktreeRefusal.reason, at, ttlSeconds);
      }
      const proposal = insertProposal(db, {
        id: newProposalId(), event, decision: "noop", status: "resolved",
        reason: worktreeRefusal.reason, at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, reason: worktreeRefusal.reason };
    }

    // §7 tier 1 (OPS-228): a repository workspace resolves its ref to an
    // immutable SHA *now*, so the pin is inside the spec's input (and its
    // inputHash, and the receipt). A run therefore names the exact tree it
    // read, and dedup distinguishes "same repo, new commit".
    let payload = envelope.payload;
    // A run reference resolves to that run's stored transcript at plan time
    // (OPS-373): the cross-run case, where the bytes come from a run this one
    // has no chain relationship with.
    if (
      def.workspace?.type === "artifacts" &&
      (def.workspace.inputs ?? []).some((i) => typeof i.from === "string" && i.from.startsWith("$.input.runPin."))
    ) {
      try {
        payload = { ...payload, runPin: pinRunArtifact(db, payload.runId) };
      } catch (err) {
        return humanNeeded(db, event, `run_pin_failed: ${err.message}`, at, ttlSeconds);
      }
    }
    // Declared artifact inputs must exist in the store at plan time (OPS-372):
    // proposing a run whose bytes are missing wastes an approval, and the
    // operator should see the failure before deciding, not after.
    if (def.workspace?.type === "artifacts") {
      for (const entry of def.workspace.inputs ?? []) {
        try {
          const sha = resolveInputRef(payload, entry.from);
          if (!findArtifact(artifactStore, sha)) {
            return humanNeeded(db, event, `artifact_missing: ${entry.as} (${sha})`, at, ttlSeconds);
          }
        } catch (err) {
          return humanNeeded(db, event, `artifact_ref_failed: ${err.message}`, at, ttlSeconds);
        }
      }
    }
    if (def.workspace?.type === "repository") {
      try {
        payload = { ...payload, repoPin: pinRepo(payload.repo, payload.ref ?? undefined) };
      } catch (err) {
        return humanNeeded(db, event, `repo_pin_failed: ${err.message}`, at, ttlSeconds);
      }
    }

    const pinnedEnvelope = payload === envelope.payload ? envelope : { ...envelope, payload };
    if (pinnedEnvelope !== envelope) {
      db.query(`UPDATE events SET envelope_json = ? WHERE source = ? AND event_id = ?`)
        .run(canonicalJson(pinnedEnvelope), event.source, event.event_id);
    }
    let idempotencyKey = idempotencyKeyFor(mapping, def, pinnedEnvelope, hashJson(payload));
    const correlation = envelope.correlationId ?? envelope.eventId ?? null;
    if (correlation && !mapping.idempotencyScope.includes("correlationId") && !mapping.idempotencyScope.includes("eventId")) {
      idempotencyKey = `${idempotencyKey}:${correlation}`;
    }
    const existingRun = resolveIdempotency(db, {
      idempotencyKey,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      eventId: envelope.eventId,
    });
    if (existingRun) {
      const proposal = insertProposal(db, {
        id: newProposalId(), event, runId: existingRun.run_id, decision: "noop",
        idempotencyKey, status: "resolved", reason: "duplicate_run", at, ttlSeconds,
      });
      setEventStatus(db, event, "noop");
      return { decision: "noop", proposal, runId: existingRun.run_id, reason: "duplicate_run" };
    }

    const runId = newRunId();
    const spec = buildRunSpec(registry, pinnedEnvelope, mapping, { runId, policyVersion, adapterOverride, now });
    const specJson = canonicalJson(spec);
    const specHash = hashJson(spec);
    createRun(db, {
      runId, idempotencyKey, spec, specJson, specHash,
      actor: "planner",
      correlationId: envelope.correlationId ?? null,
      causationId: envelope.causationId ?? null,
      policyVersion, now,
    });
    const proposal = insertProposal(db, {
      id: newProposalId(), event, runId, decision: "run",
      specJson, specHash, idempotencyKey, status: "open", at, ttlSeconds,
    });
    setEventStatus(db, event, "planned");
    return { decision: "run", proposal, runId };
  });
}

/**
 * Operator recovery for parked events (§13): put a dead-lettered or
 * human_needed event back through planning after the underlying problem is
 * fixed (event type registered, planner bug shipped, …). Any open
 * human_needed proposal for it is superseded so the inbox does not show a
 * stale ask next to a fresh plan.
 */
export function requeueEvent(db, { source, eventId }, { actor = "operator", now = Date.now() } = {}) {
  return txImmediate(db, () => {
    const event = db.query(`SELECT status FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
    if (!event) throw new Error(`unknown event (${source}, ${eventId})`);
    if (!["dead_lettered", "human_needed"].includes(event.status)) {
      throw new Error(`requeue applies to dead_lettered or human_needed events, not ${event.status}`);
    }
    db.query(
      `UPDATE proposals SET status = 'superseded', decided_at = ?, decided_by = ?, reason = 'requeued'
       WHERE event_source = ? AND event_id = ? AND status = 'open'`,
    ).run(new Date(now).toISOString(), actor, source, eventId);
    db.query(
      `UPDATE events SET status = 'admitted', plan_failures = 0, last_plan_error = NULL
       WHERE source = ? AND event_id = ?`,
    ).run(source, eventId);
    return { requeued: true };
  });
}

/**
 * Sweep every 'admitted' event through planEvent. A plan that throws rolls
 * back, increments the event's failure count, and — after DEAD_LETTER_AFTER
 * consecutive failures — parks the event as dead-lettered with its last error
 * (§13), leaving it visible in status and eligible for replay after a fix.
 *
 * @returns {{ planned: number, failed: number, deadLettered: number }}
 */
export function planAdmittedEvents(db, registry, opts = {}) {
  const rows = db.query(`SELECT source, event_id FROM events WHERE status = 'admitted' ORDER BY admitted_at, rowid`).all();
  let planned = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const { source, event_id: eventId } of rows) {
    try {
      planEvent(db, registry, { source, eventId }, opts);
      planned += 1;
    } catch (err) {
      if (isBusyError(err)) {
        continue;
      }
      failed += 1;
      const message = String(err?.message ?? err);
      try {
        const failures = txImmediate(db, () => {
          db.query(
            `UPDATE events SET plan_failures = plan_failures + 1, last_plan_error = ? WHERE source = ? AND event_id = ?`,
          ).run(message, source, eventId);
          const row = db.query(`SELECT plan_failures FROM events WHERE source = ? AND event_id = ?`).get(source, eventId);
          if (row.plan_failures >= DEAD_LETTER_AFTER) {
            db.query(`UPDATE events SET status = 'dead_lettered' WHERE source = ? AND event_id = ?`).run(source, eventId);
          }
          return row.plan_failures;
        });
        if (failures >= DEAD_LETTER_AFTER) deadLettered += 1;
      } catch (innerErr) {
        if (isBusyError(innerErr)) {
          failed -= 1;
          continue;
        }
        throw innerErr;
      }
    }
  }
  return { planned, failed, deadLettered };
}
