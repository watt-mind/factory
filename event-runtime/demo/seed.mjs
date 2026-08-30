#!/usr/bin/env bun
/**
 * Seed a fake-adapter event runtime with one of everything (OPS-217, OPS-422).
 *
 * Drives real state through the real surfaces — intake, planner, watched
 * approval, worker, verifier — with rich fixture coverage across agents,
 * workspace types, recommendation chains, artifacts, and lifecycle edges.
 * Requires `serve --adapter-override fake` running on the target port; refuses
 * to seed a runtime whose adapter is real (approving would spawn real agents).
 *
 * Scenarios & terminal states produced:
 *
 *   COMPLETED   status-report (repos:["ok"])             result + receipt + evidence
 *   COMPLETED   status-report (repos:["with-artifact"])   declared report.txt + transcript
 *   COMPLETED   status-report (repos:["trace-flood"])     >100 live trace events
 *   REFUSED     status-report (repos:["refuse"])          typed refusal (needs_human)
 *   FAILED      status-report (repos:["crash"])           attempt: 2 (multi-attempt retry)
 *   FAILED      status-report (repos:["invalid-artifact"]) output-contract violation
 *   CANCELLED   rejected proposal                         closed via reject verb
 *   CANCELLED   operator cancelled                        cancelled via cancel verb
 *
 *   CI Chain (3 hops with causationId & artifacts workspace):
 *     COMPLETED ci-log-capture@1                          captured ci-log artifact
 *     COMPLETED ci-doctor@2                               artifacts workspace, verdict FLAKE
 *     COMPLETED ci-rerun@1                                command adapter follow-up
 *
 *   Triage Chain (repository workspace with repoPin):
 *     COMPLETED triage-scan@1                             repository workspace, pinned sha
 *     COMPLETED triage-apply@1                            chain auto-approved closed plan
 *
 *   Open watched proposals:
 *     - direct operator approvable (`run`)
 *     - merge-apply and ship-apply (human watched)
 *     - human_needed (empty repos fails schema minItems), surfaced in the
 *       Inbox as a `BLOCKED` item with the `parked` decision request
 *     - TTL-expired proposal
 *
 *   Admitted & anomaly events:
 *     - dead-lettered event (lastPlanError present)
 *     - duplicate delivery suppression
 *
 *   RUNNING     repos:["hang"] (approved LAST — single worker holds until 600s timeout)
 *
 *   bun event-runtime/demo/seed.mjs [--port 7381] [--prefix demo] [--poll-ms 300]
 */
import { apiClient } from "../lib/client.mjs";
import { openDb } from "../lib/db.mjs";
import { dbPath, runtimeHome } from "../lib/config.mjs";
import { createRun, transition } from "../lib/lifecycle.mjs";
import { hashJson } from "../lib/canonical.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const port = Number(flag("--port") ?? process.env.FACTORY_EVENT_PORT ?? 7381);
const prefix = flag("--prefix") ?? "demo";
const pollMs = Number(flag("--poll-ms") ?? 300);
if (!Number.isInteger(pollMs) || pollMs < 25 || pollMs > 5_000) {
  console.error("seed: --poll-ms must be an integer between 25 and 5000");
  process.exit(2);
}
const rawClient = apiClient({ port });
const client = new Proxy(rawClient, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value !== "function") return value;
    if (["approve", "cancel", "reject", "replay", "retry"].includes(prop)) {
      return (...args) =>
        retryDatabaseLock(`${prop} ${args[0] ?? ""}`, () => value(...args));
    }
    return value;
  },
});

const log = (line) => console.log(`seed: ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real project names for the tags, from the serve process's GET /repos — the
 * same list the UI's project tabs offer. Optional by design: a missing or
 * unreadable registry (HTTP 500) must still seed a full demo set, so it
 * costs the tags, not the run.
 */
async function projectNames() {
  try {
    const { repos: registry } = await client.repos();
    return (registry ?? []).map((row) => row.name).filter(Boolean);
  } catch (err) {
    log(`no repo registry (${err.message}) — seeding without project tags`);
    return [];
  }
}

/** repos[0] must stay the fake adapter's mode — the project name only trails it. */
const tag = (mode, project) => (project ? [mode, project] : [mode]);

function envelope(
  id,
  repos,
  type = "factory.status-report.requested",
  source = "demo-seed",
) {
  return {
    schemaVersion: "factory.event/v1",
    eventId: `${prefix}-${id}`,
    type,
    source,
    subject: "factory",
    occurredAt: new Date().toISOString(),
    correlationId: `${prefix}-${id}`,
    payload: { repos },
  };
}

/**
 * Replay an envelope, exiting immediately (<1s) if intake detects a duplicate
 * event id/prefix instead of timing out downstream in until() (OPS-464).
 */
async function retryDatabaseLock(label, operation) {
  let last;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      last = err;
      if (!/database is locked/i.test(String(err?.message))) throw err;
      await sleep(25 * (attempt + 1));
    }
  }
  throw new Error(
    `${label}: database remained locked after 20 retries (${last?.message ?? "unknown error"})`,
  );
}

async function replay(env) {
  const res = await client.replay(env);
  if (res.duplicate) {
    console.error(
      `seed: duplicate prefix "${prefix}" — event "${env.eventId}" already exists in runtime database.\n` +
        `This runtime was already seeded under prefix "${prefix}".\n` +
        `To re-seed under a fresh prefix: bun event-runtime/demo/seed.mjs --port ${port} --prefix demo-$(date +%s)\n` +
        `Or use: bin/worktree-up.sh --reseed`,
    );
    process.exit(1);
  }
  return res;
}

/** Poll until `fn` returns truthy, or die loudly — a seed must not half-run. */
async function until(what, fn, { timeoutMs = 30_000, everyMs = pollMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function proposalFor(eventId, { agent, status = "open" } = {}) {
  return until(`proposal for ${agent ?? eventId}`, async () => {
    const { proposals } = await client.proposals(
      status === "open" ? undefined : "all",
    );
    return proposals.find((p) => {
      if (status !== "all" && p.status !== status) return false;
      const eventMatches =
        p.spec?.idempotencyKey?.includes(eventId) ||
        p.reason?.includes(eventId) ||
        p.eventId === eventId ||
        (p.spec?.input && JSON.stringify(p.spec.input).includes(eventId));
      if (agent) {
        const agentMatches = p.spec?.agent === agent || p.agent === agent;
        return agentMatches && eventMatches;
      }
      return eventMatches;
    });
  });
}

async function openProposalFor(eventId, options = {}) {
  return proposalFor(eventId, { ...options, status: "open" });
}

/** human_needed proposals carry no spec — match via their admitted event. */
async function humanNeededProposal(eventId) {
  return until(
    `human_needed proposal${eventId ? ` for ${eventId}` : ""}`,
    async () => {
      const { proposals } = await client.proposals();
      return proposals.find(
        (p) =>
          p.status === "open" &&
          p.decision === "human_needed" &&
          (!eventId ||
            p.eventId?.includes(eventId) ||
            p.reason?.includes(eventId)),
      );
    },
  );
}

async function runTerminal(runId, wanted) {
  return until(`run ${runId} → ${wanted}`, async () => {
    const view = await client.run(runId);
    if (view.run.state === wanted) return view;
    const TERMINAL = [
      "COMPLETED",
      "REFUSED",
      "FAILED",
      "TIMED_OUT",
      "CANCELLED",
    ];
    if (TERMINAL.includes(view.run.state)) {
      throw new Error(
        `run ${runId} terminated ${view.run.state}, expected ${wanted}`,
      );
    }
    return null;
  });
}

// --------------------------------------------------------------------------

const health = await client.health().catch(() => null);
if (!health) {
  console.error(`seed: no control API on 127.0.0.1:${port} — start it with:
  FACTORY_EVENT_PORT=${port} bun event-runtime/cli.mjs serve --adapter-override fake`);
  process.exit(1);
}

// GET /health is bearer-exempt, so the credential is only checked on the
// first privileged call. Probe it here to fail with an actionable message
// (which variable, which file) instead of a stack trace mid-seed (#1132).
try {
  await client.runs();
} catch (err) {
  if (err.status === 401) {
    console.error(`seed: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Guard: never seed a real-adapter runtime. The adapter lands in each spec at
// planning time, so probe with a throwaway event and inspect its proposal.
const probeId = `${prefix}-adapter-probe`;
await replay(envelope("adapter-probe", ["ok"]));
const probe = await openProposalFor(probeId);
if (probe.spec?.adapter !== "fake") {
  await client.reject(
    probe.id,
    "seed aborted: runtime is not in fake-adapter mode",
  );
  console.error(
    `seed: refusing — this runtime plans with adapter "${probe.spec?.adapter}", not "fake". ` +
      `Restart it with --adapter-override fake.`,
  );
  process.exit(1);
}
await client.reject(probe.id, "adapter probe — not part of the demo set");

// Clean up any stale in-flight work or open proposals from prior seeds (OPS-464)
// so the single worker is unblocked and open proposal counts match fixture assertions.
try {
  const { proposals: priorProposals } = await client.proposals();
  for (const p of priorProposals ?? []) {
    try {
      await client.reject(p.id, "cancelled by demo re-seed");
    } catch {
      /* intentionally ignored */
    }
  }
  const { runs: priorRuns } = await client.runs();
  for (const r of priorRuns ?? []) {
    if (r.state === "RUNNING" || r.state === "QUEUED") {
      try {
        await client.cancel(r.runId, "cancelled by demo re-seed");
      } catch {
        /* intentionally ignored */
      }
    }
  }
  await until(
    "worker idle after re-seed cleanup",
    async () => {
      const { runs } = await client.runs();
      const busy = (runs ?? []).filter(
        (r) => r.state === "RUNNING" || r.state === "QUEUED",
      );
      return busy.length === 0;
    },
    { timeoutMs: 5_000, everyMs: 100 },
  );
} catch (err) {
  log(`re-seed cleanup warning: ${err.message}`);
}

const [projectA, projectB = projectA] = await projectNames();
const primaryProject = projectA || "factory";
log(
  projectA
    ? `project tags: ${[...new Set([projectA, projectB])].join(", ")}`
    : "project tags: none (fallback: factory)",
);

// 1. Quick terminals for status-report (ephemeral workspace)
const terminals = [
  { id: "completed", repos: tag("ok", projectA), wanted: "COMPLETED" },
  {
    id: "with-artifact",
    repos: tag("with-artifact", projectA),
    wanted: "COMPLETED",
  },
  { id: "trace-flood", repos: ["trace-flood"], wanted: "COMPLETED" },
  { id: "refused", repos: ["refuse"], wanted: "REFUSED" },
  { id: "failed-crash", repos: ["crash"], wanted: "FAILED" },
  { id: "failed-contract", repos: ["invalid-artifact"], wanted: "FAILED" },
];
for (const t of terminals) {
  await replay(envelope(t.id, t.repos));
  const proposal = await openProposalFor(`${prefix}-${t.id}`);
  await client.approve(proposal.id);
  await runTerminal(proposal.runId, t.wanted);
  log(`${proposal.runId} → ${t.wanted} (${t.id})`);
}

// 2. Multi-attempt run: retry the failed-crash run (attempt: 2)
const failedCrashProposal = await until(
  "failed-crash run for retry",
  async () => {
    // GET /runs returns a bounded, spec-free summary per run (WM-976) — it no
    // longer inlines reasonCode, so look it up from each candidate's latest
    // attempt via GET /runs/:id.
    const { runs } = await client.runs("FAILED");
    for (const r of runs) {
      const detail = await client.run(r.runId);
      if (detail?.attempts?.at(-1)?.reason_code === "agent_exit_1") return r;
    }
    return undefined;
  },
);
if (failedCrashProposal) {
  log(
    `retrying ${failedCrashProposal.runId} with force=true to create attempt 2`,
  );
  await client.retry(failedCrashProposal.runId, { force: true });
  await runTerminal(failedCrashProposal.runId, "FAILED");
  log(`${failedCrashProposal.runId} → FAILED (attempt 2 completed)`);
}

// 3. CANCELLED via proposal rejection
await replay(envelope("rejected", tag("ok", projectB)));
const rejected = await openProposalFor(`${prefix}-rejected`);
await client.reject(rejected.id, "demo: rejected on purpose");
await runTerminal(rejected.runId, "CANCELLED");
log(`${rejected.runId} → CANCELLED (proposal rejected)`);

// 4. CANCELLED via operator cancel
await replay(envelope("cancel-op", tag("ok", projectA)));
const toCancel = await openProposalFor(`${prefix}-cancel-op`);
await client.cancel(toCancel.runId, "demo: operator cancelled");
await runTerminal(toCancel.runId, "CANCELLED");
log(`${toCancel.runId} → CANCELLED (operator cancelled)`);

// 5. CI Failure Chain scenario: github.workflow-run.failed → ci-log-capture → ci-doctor → ci-rerun
const ciRunId = 12345;
const ciEventId = `${prefix}-ci-failed`;
await client.replay({
  schemaVersion: "factory.event/v1",
  eventId: ciEventId,
  type: "github.workflow-run.failed",
  source: "github",
  subject: "ci",
  occurredAt: new Date().toISOString(),
  correlationId: ciEventId,
  payload: { repo: `wm/${primaryProject}`, runId: ciRunId },
});
const ciCaptureProposal = await openProposalFor(ciEventId, {
  agent: "ci-log-capture@1",
});
await client.approve(ciCaptureProposal.id);
await runTerminal(ciCaptureProposal.runId, "COMPLETED");
log(
  `${ciCaptureProposal.runId} → COMPLETED (ci-log-capture@1, emitted ci-log artifact)`,
);

// Hop 2: ci-doctor@2 (artifacts workspace type with $.artifactHash.ci-log)
const ciDoctorProposal = await openProposalFor(ciEventId, {
  agent: "ci-doctor@2",
});
await client.approve(ciDoctorProposal.id);
await runTerminal(ciDoctorProposal.runId, "COMPLETED");
log(
  `${ciDoctorProposal.runId} → COMPLETED (ci-doctor@2, verdict FLAKE, artifacts workspace)`,
);

// Hop 3: ci-rerun@1 (command adapter follow-up with causationId)
const ciRerunProposal = await openProposalFor(ciEventId, {
  agent: "ci-rerun@1",
});
await client.approve(ciRerunProposal.id);
await runTerminal(ciRerunProposal.runId, "COMPLETED");
log(`${ciRerunProposal.runId} → COMPLETED (ci-rerun@1, command adapter)`);

// 6. Triage scan scenario: factory.triage.requested (repository workspace type with repoPin)
const triageEventId = `${prefix}-triage`;
await client.replay({
  schemaVersion: "factory.event/v1",
  eventId: triageEventId,
  type: "factory.triage.requested",
  source: "operator",
  subject: primaryProject,
  occurredAt: new Date().toISOString(),
  correlationId: triageEventId,
  payload: { repo: primaryProject },
});
const triageScanProposal = await openProposalFor(triageEventId, {
  agent: "triage-scan@1",
});
await client.approve(triageScanProposal.id);
await runTerminal(triageScanProposal.runId, "COMPLETED");
log(
  `${triageScanProposal.runId} → COMPLETED (triage-scan@1, repository workspace)`,
);

// Follow-up triage-apply run from this scan's exact causal edge. Matching only
// by agent can reuse a terminal proposal from a prior seed while the fresh edge
// has not even been emitted yet.
const triageApplyEventId = `chain-${triageScanProposal.runId}`;
const triageApplyProposal = await proposalFor(triageApplyEventId, {
  agent: "triage-apply@1",
  status: "all",
});
await runTerminal(triageApplyProposal.runId, "COMPLETED");
log(
  `${triageApplyProposal.runId} → COMPLETED (triage-apply@1 chain auto-approved closed plan; event ${triageApplyEventId})`,
);

// 7. Duplicate delivery suppression
const dupOutcome = await client.replay(
  envelope("completed", tag("ok", projectA)),
);
log(`duplicate admission test: duplicate=${dupOutcome.duplicate}`);

// 8. Open watched proposals: direct/operator, merge/ship, human_needed, and TTL-expired
await replay(envelope("open", tag("ok", projectA), undefined, "operator"));
const open = await openProposalFor(`${prefix}-open`);
log(`${open.id} left open (direct operator approvable → instant COMPLETED)`);

const fixtureSha = "a".repeat(40);
const mergeEventId = `${prefix}-merge-watched`;
await client.replay({
  schemaVersion: "factory.event/v1",
  eventId: mergeEventId,
  type: "factory.merge-apply.requested",
  source: "operator",
  subject: primaryProject,
  occurredAt: new Date().toISOString(),
  correlationId: mergeEventId,
  payload: {
    repo: primaryProject,
    github: "watt-mind/factory",
    base: "develop",
    deployBranch: "master",
    plan: [
      {
        pr: 42,
        headSha: fixtureSha,
        baseSha: "b".repeat(40),
        headRef: "feat/WM-400",
        ticket: "WM-400",
        action: "merge_pr",
        reason: "demo: independently reviewed ordinary develop PR",
        checksGreen: true,
        mergeable: true,
        ownedPathsValid: true,
        handoffValid: true,
        testsFalsifiable: true,
        policySafe: true,
        sensitive: false,
        ambiguous: false,
      },
    ],
  },
});
const mergeWatched = await openProposalFor(mergeEventId, {
  agent: "merge-apply@2",
});
log(`${mergeWatched.id} left open (merge-apply@2 watched)`);

// A landed event is deliberately not fabricated by the demo. The executable
// WM-412 command fixture covers the real apply → internally admitted landed →
// verify path; this seed keeps only the watched pre-merge proposal.

const shipEventId = `${prefix}-ship-watched`;
await client.replay({
  schemaVersion: "factory.event/v1",
  eventId: shipEventId,
  type: "factory.ship-apply.requested",
  source: "operator",
  subject: primaryProject,
  occurredAt: new Date().toISOString(),
  correlationId: shipEventId,
  payload: {
    repo: primaryProject,
    github: "watt-mind/factory",
    base: "develop",
    deployBranch: "main",
    headSha: fixtureSha,
    deployHeadSha: fixtureSha,
    changelog: [
      { sha: fixtureSha, subject: "fixture release", ticket: "WM-400" },
    ],
    plan: [{ action: "open_rc_pr" }],
  },
});
const shipWatched = await openProposalFor(shipEventId, {
  agent: "ship-apply@1",
});
log(`${shipWatched.id} left open (ship-apply@1 human watched)`);

await replay(envelope("human-needed", []));
const human = await humanNeededProposal(`${prefix}-human-needed`);
log(`${human.id} left open (human_needed: ${human.reason})`);

// TTL-expired proposal
await replay(envelope("expired", tag("ok", projectA)));
const expiredProposal = await openProposalFor(`${prefix}-expired`);

// 9. Database state for anomaly fixtures (dead-lettered event & expired proposal timestamp)
const home = health.env?.home || runtimeHome();
try {
  const db = openDb(dbPath(home));
  // Set expired proposal created_at to 2 hours ago
  db.query(
    "UPDATE proposals SET created_at = datetime('now', '-2 hours') WHERE id = ?",
  ).run(expiredProposal.id);
  log(
    `${expiredProposal.id} timestamp updated to 2h ago (TTL-expired proposal anomaly)`,
  );

  // Insert a dead-lettered event directly into events table
  const deadEventId = `${prefix}-dead-letter`;
  const deadEnvelope = envelope("dead-letter", tag("ok", projectA));
  const nowStr = new Date().toISOString();
  db.query(
    `INSERT INTO events
       (source, event_id, type, subject, occurred_at, received_at,
        correlation_id, causation_id, envelope_json, payload_hash, status, plan_failures, last_plan_error, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dead_lettered', 3, 'simulated planning failure: poison payload', ?)
     ON CONFLICT(source, event_id) DO UPDATE SET
       status = 'dead_lettered', plan_failures = 3, last_plan_error = 'simulated planning failure: poison payload'`,
  ).run(
    deadEnvelope.source,
    deadEventId,
    deadEnvelope.type,
    deadEnvelope.subject,
    deadEnvelope.occurredAt,
    nowStr,
    deadEnvelope.correlationId,
    null,
    JSON.stringify(deadEnvelope),
    "none",
    nowStr,
  );
  log(`${deadEventId} inserted as dead_lettered (dead-letter anomaly)`);

  // WM-132: Update failed-contract run spec to have maxAttempts = 2 so plain Retry is exercisable (attempts < maxAttempts)
  const contractRow = db
    .query(
      "SELECT p.run_id, r.spec_json FROM proposals p JOIN runs r ON r.run_id = p.run_id WHERE p.idempotency_key LIKE ?",
    )
    .get(`%${prefix}-failed-contract%`);
  if (contractRow) {
    const spec = JSON.parse(contractRow.spec_json);
    spec.maxAttempts = 2;
    const updatedSpecJson = JSON.stringify(spec);
    db.query("UPDATE runs SET spec_json = ? WHERE run_id = ?").run(
      updatedSpecJson,
      contractRow.run_id,
    );
    db.query("UPDATE proposals SET spec_json = ? WHERE run_id = ?").run(
      updatedSpecJson,
      contractRow.run_id,
    );
    log(
      `${contractRow.run_id} spec updated to maxAttempts=2 (attempts: 1/2, plain retry exercisable)`,
    );
  }

  // WM-133: Working PR workflow scenario (dispatch@1 run moving through RUNNING → VERIFYING → COMPLETED with PR_OPEN)
  const dispatchEventId = `${prefix}-dispatch-wm100`;
  const dispatchTicket = "WM-100";
  const dispatchRunId = `run_${prefix}_dispatch_wm100`;
  const dispatchPropId = `prop_${prefix}_dispatch_wm100`;
  const dispatchEnvelope = {
    schemaVersion: "factory.event/v1",
    eventId: dispatchEventId,
    type: "factory.dispatch.requested",
    source: "operator",
    subject: dispatchTicket,
    occurredAt: nowStr,
    correlationId: dispatchEventId,
    payload: { repo: primaryProject, ticket: dispatchTicket },
  };
  const dispatchSpec = {
    agent: "dispatch@1",
    adapter: "fake",
    outputContract: "factory.dispatch-result/v1",
    workspace: { type: "worktree", checkoutDir: "repo", retainOnFailure: true },
    input: { repo: primaryProject, ticket: dispatchTicket },
    timeoutSeconds: 2700,
    maxAttempts: 1,
    budgetUsd: 15,
    idempotencyKey: dispatchRunId,
    policyVersion: "v1",
  };
  const dispatchSpecJson = JSON.stringify(dispatchSpec);
  const dispatchSpecHash = hashJson(dispatchSpec);

  db.query(
    `INSERT INTO events
       (source, event_id, type, subject, occurred_at, received_at,
        correlation_id, causation_id, envelope_json, payload_hash, status, plan_failures, last_plan_error, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "resolved", 0, null, ?)
     ON CONFLICT(source, event_id) DO UPDATE SET status = "resolved"`,
  ).run(
    dispatchEnvelope.source,
    dispatchEventId,
    dispatchEnvelope.type,
    dispatchEnvelope.subject,
    dispatchEnvelope.occurredAt,
    nowStr,
    dispatchEnvelope.correlationId,
    null,
    JSON.stringify(dispatchEnvelope),
    hashJson(dispatchEnvelope.payload),
    nowStr,
  );

  db.query(
    `INSERT INTO proposals
       (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
        idempotency_key, status, reason, created_at, ttl_seconds, decided_at, decided_by)
     VALUES (?, ?, ?, ?, "run", ?, ?, ?, "approved", null, ?, 1800, ?, "operator")
     ON CONFLICT(id) DO UPDATE SET status = "approved", run_id = excluded.run_id`,
  ).run(
    dispatchPropId,
    dispatchEnvelope.source,
    dispatchEventId,
    dispatchRunId,
    dispatchSpecJson,
    dispatchSpecHash,
    dispatchRunId,
    nowStr,
    nowStr,
  );

  createRun(db, {
    runId: dispatchRunId,
    idempotencyKey: dispatchRunId,
    spec: dispatchSpec,
    specJson: dispatchSpecJson,
    specHash: dispatchSpecHash,
    actor: "operator",
    correlationId: dispatchEventId,
    policyVersion: "v1",
    now: () => nowStr,
  });
  transition(db, {
    runId: dispatchRunId,
    to: "APPROVED",
    expectFrom: "PROPOSED",
    actor: "operator",
    reason: "approved",
    policyVersion: "v1",
    now: () => nowStr,
  });
  transition(db, {
    runId: dispatchRunId,
    to: "QUEUED",
    expectFrom: "APPROVED",
    actor: "worker-demo",
    reason: "queued",
    policyVersion: "v1",
    now: () => nowStr,
  });
  transition(db, {
    runId: dispatchRunId,
    to: "LEASED",
    expectFrom: "QUEUED",
    actor: "worker-demo",
    reason: "leased",
    policyVersion: "v1",
    now: () => nowStr,
  });
  transition(db, {
    runId: dispatchRunId,
    to: "RUNNING",
    expectFrom: "LEASED",
    actor: "worker-demo",
    reason: "started",
    attempt: 1,
    policyVersion: "v1",
    now: () => nowStr,
  });
  transition(db, {
    runId: dispatchRunId,
    to: "VERIFYING",
    expectFrom: "RUNNING",
    actor: "worker-demo",
    reason: "finished",
    attempt: 1,
    policyVersion: "v1",
    now: () => nowStr,
  });
  transition(db, {
    runId: dispatchRunId,
    to: "COMPLETED",
    expectFrom: "VERIFYING",
    actor: "worker-demo",
    reason: "verified",
    attempt: 1,
    policyVersion: "v1",
    now: () => nowStr,
  });

  db.query(
    'UPDATE runs SET state = "COMPLETED", attempts = 1, updated_at = ? WHERE run_id = ?',
  ).run(nowStr, dispatchRunId);

  db.query(
    `INSERT INTO attempts
       (run_id, attempt, fencing_token, lease_owner, lease_expires_at, started_at, finished_at, terminal_state, reason_code, workspace_path)
     VALUES (?, 1, 1, "worker-demo", datetime("now", "+1 hour"), ?, ?, "COMPLETED", "ok", ?)
     ON CONFLICT(run_id, attempt) DO UPDATE SET terminal_state = "COMPLETED", reason_code = "ok"`,
  ).run(
    dispatchRunId,
    nowStr,
    nowStr,
    `/tmp/worktrees/${primaryProject}/${dispatchTicket}`,
  );

  const prUrl = `https://github.com/watt-mind/${primaryProject}/pull/42`;
  const dispatchArtifact = {
    outcome: "PR_OPEN",
    repo: primaryProject,
    ticket: dispatchTicket,
    prUrl,
    verification: {
      command: "bun test",
      passed: true,
      output: "3 pass\n0 fail\nRan 3 tests across 1 file.",
    },
    summary: `fake dispatch completed with PR open for ${dispatchTicket}`,
  };
  const dispatchEvidence = {
    commands: ["bun test", "gh pr create"],
    prUrl,
    ticket: dispatchTicket,
  };
  const dispatchResult = {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: "ok",
    artifact: dispatchArtifact,
    evidence: dispatchEvidence,
  };
  const resultJson = JSON.stringify(dispatchResult);
  const artifactHash = hashJson(dispatchArtifact);
  const evidenceSetHash = hashJson(dispatchEvidence);
  const verificationJson = JSON.stringify({
    verificationStatus: "passed",
    checks: ["schema_valid", "evidence_recorded"],
    verifiedAt: nowStr,
  });
  const receiptJson = JSON.stringify({
    runId: dispatchRunId,
    attempt: 1,
    terminalState: "COMPLETED",
    verificationStatus: "passed",
    evidenceSetHash,
    acceptedAt: nowStr,
  });
  db.query(
    `INSERT INTO results
       (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, attempt) DO UPDATE SET
       result_json = excluded.result_json, artifact_hash = excluded.artifact_hash,
       evidence_set_hash = excluded.evidence_set_hash, verification_json = excluded.verification_json,
       receipt_json = excluded.receipt_json, accepted_at = excluded.accepted_at`,
  ).run(
    dispatchRunId,
    resultJson,
    artifactHash,
    evidenceSetHash,
    verificationJson,
    receiptJson,
    nowStr,
  );
  log(
    `${dispatchRunId} → COMPLETED (dispatch@1, simulated working PR workflow with PR_OPEN)`,
  );

  db.close();
} catch (err) {
  log(`warning: could not write direct db anomalies (${err.message})`);
}

// 10. RUNNING, last: occupies worker until 600s timeout
await replay(envelope("running", tag("hang", projectB)));
const hang = await openProposalFor(`${prefix}-running`);
await client.approve(hang.id);
await until(`run ${hang.runId} → RUNNING`, async () => {
  const view = await client.run(hang.runId);
  return view.run.state === "RUNNING" ? view : null;
});
log(`${hang.runId} → RUNNING (hang mode; TIMED_OUT after 600s timeout)`);

log("done — seeded comprehensive fixture across all agents & states:");
const { runs } = await client.runs();
for (const r of runs) log(`  ${r.runId}  ${r.state}  agent:${r.agent}`);
const { proposals } = await client.proposals();
for (const p of proposals)
  log(
    `  ${p.id}  ${p.decision} (open)  agent:${p.agent ?? p.spec?.agent}  expired:${p.expired}`,
  );
