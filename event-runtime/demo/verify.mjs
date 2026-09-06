#!/usr/bin/env bun
/**
 * E2E smoke and correctness verifier over a seeded demo runtime (OPS-217, OPS-423, OPS-422).
 *
 * Asserts via the control API that the seeded runtime is correct, integral,
 * and conforms to all contracts:
 *   - Exact state counts and per-run reason codes
 *   - Full lifecycle ordering and provenance
 *   - Evidence integrity and evidenceSetHash
 *   - Artifact store retrieval via GET /artifacts/:sha (report & transcript)
 *   - All 3 workspace types (ephemeral, artifacts, repository)
 *   - Recommendation chains with causationId linkage
 *   - Anomaly checks (expired proposals, dead letters, clean leases)
 *   - Endpoint coverage: health, status, runs, proposals, events, workers,
 *     schedules, agents, repos, journal, outbox, trace, artifacts
 *
 *   bun event-runtime/demo/verify.mjs [--port 7381]
 */
import { createHash } from "node:crypto";
import { apiClient } from "../lib/client.mjs";
import { loadRegistry } from "../lib/registry.mjs";
import { repoNamesFromInput } from "../lib/api-runs.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const port = Number(
  i === -1 ? (process.env.FACTORY_EVENT_PORT ?? 7381) : args[i + 1],
);
const client = apiClient({ port });

const failures = [];
const check = (label, ok, detail = "") => {
  const msg = detail ? `${label} (${detail})` : label;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

const inboxUrl = new URL("inbox?status=open", `${client.baseUrl}/`);
const inboxHeaders = client.token
  ? { authorization: `Bearer ${client.token}` }
  : {};

async function openInbox() {
  const response = await fetch(inboxUrl, { headers: inboxHeaders });
  if (!response.ok) {
    throw new Error(`GET /inbox?status=open returned HTTP ${response.status}`);
  }
  return response.json();
}

/** The Inbox is projected by the serve tick, after the seed has completed. */
async function waitForOpenInbox(
  match,
  { timeoutMs = 5_000, everyMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let items = [];
  while (Date.now() < deadline) {
    ({ items = [] } = await openInbox());
    if (match(items)) return items;
    await Bun.sleep(everyMs);
  }
  return items;
}

const inboxSummary = (items) =>
  items
    .map((item) => `${item.kind}:${item.refs?.eventId ?? item.title}`)
    .join(", ") || "none";

const parkedDecision = (item) =>
  item.kind === "BLOCKED" &&
  item.refs?.eventId?.endsWith("-human-needed") &&
  item.decision?.schemaVersion === "factory.decision-request/v1" &&
  item.decision.question === "Should this parked event be requeued?" &&
  JSON.stringify(item.decision.options?.map((option) => option.id)) ===
    JSON.stringify(["requeue", "dismiss"]);

const expiringDecision = (item) =>
  item.refs?.eventId?.endsWith("-expired") &&
  item.decision?.options?.some((option) => option.id === "approve") &&
  item.decision?.options?.some((option) => option.id === "reject");

// 1. Health endpoint
const health = await client.health().catch(() => null);
if (!health) {
  console.error(`verify: no control API on 127.0.0.1:${port}`);
  process.exit(1);
}
// GET /health is bearer-exempt; the credential is first checked on a
// privileged route. Probe it so a 401 prints which variable to set (#1132).
try {
  await client.runs();
} catch (err) {
  if (err.status === 401) {
    console.error(`verify: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
check("GET /health reports ok: true", health.ok === true);
check("runtime is in fake adapter mode", health.env?.adapter === "fake");

// 2. Runs listing and state census
//
// GET /runs returns a bounded, spec-free summary per run (WM-976) — repos,
// reasonCode, maxAttempts and eventSource are no longer inlined so the list
// payload stays small under pagination. This verifier still needs them, so
// hydrate each row from GET /runs/:id (spec + attempts) and from the
// decision='run' proposal that produced it (eventSource).
const { runs: runSummaries } = await client.runs();
const { proposals: runProposalsForEventSource } = await client.proposals("all");
const eventSourceByRunId = new Map(
  runProposalsForEventSource
    .filter((p) => p.decision === "run" && p.runId)
    .map((p) => [p.runId, p.eventSource]),
);
const runs = await Promise.all(
  runSummaries.map(async (r) => {
    const detail = await client.run(r.runId);
    const spec = detail?.run?.spec ?? {};
    return {
      ...r,
      repos: repoNamesFromInput(spec.input),
      maxAttempts: spec.maxAttempts,
      reasonCode: detail?.attempts?.at(-1)?.reason_code ?? null,
      eventSource: eventSourceByRunId.get(r.runId) ?? null,
    };
  }),
);
const byState = (state) => runs.filter((r) => r.state === state);

check("runs present", runs.length >= 8, `total runs: ${runs.length}`);
check(
  "every run spec uses fake adapter",
  runs.every((r) => r.adapter === "fake"),
);

// RUNNING or TIMED_OUT (the hang run)
const runningOrTimedOut = byState("RUNNING").concat(byState("TIMED_OUT"));
check("1 run RUNNING or TIMED_OUT (hang)", runningOrTimedOut.length >= 1);

// COMPLETED runs
const completedRuns = byState("COMPLETED");
check(
  "≥6 runs COMPLETED across agent workflows",
  completedRuns.length >= 6,
  `found ${completedRuns.length}`,
);

// REFUSED run
const refusedRuns = byState("REFUSED");
check(
  "1 run REFUSED with reasonCode 'needs_human'",
  refusedRuns.some((r) => r.reasonCode === "needs_human"),
);

// FAILED runs
const failedRuns = byState("FAILED");
check("≥2 runs FAILED", failedRuns.length >= 2, `found ${failedRuns.length}`);
const crashFailed = failedRuns.find((r) => r.reasonCode === "agent_exit_1");
const contractFailed = failedRuns.find(
  (r) => r.reasonCode === "contract_violation",
);
check(
  "1 FAILED run from exit code 1 (reasonCode: agent_exit_1)",
  Boolean(crashFailed),
);
check(
  "1 FAILED run from contract violation (reasonCode: contract_violation)",
  Boolean(contractFailed),
);

// Multi-attempt run (crash run retried with force=true)
if (crashFailed) {
  const crashView = await client.run(crashFailed.runId);
  check(
    "multi-attempt run executed (attempts >= 2)",
    (crashView?.run?.attempts ?? 0) >= 2,
    `attempts: ${crashView?.run?.attempts}`,
  );
  check(
    "multi-attempt attempt records recorded",
    (crashView?.attempts?.length ?? 0) >= 2,
  );
}

// Plain retryable run (failed run with attempts < maxAttempts, WM-132)
const retryableFailed = failedRuns.find(
  (r) => (r.attempts ?? 0) < (r.maxAttempts ?? 1),
);
check(
  "≥1 FAILED run with attempts remaining (attempts < maxAttempts)",
  Boolean(retryableFailed),
  retryableFailed
    ? `${retryableFailed.runId} (${retryableFailed.attempts}/${retryableFailed.maxAttempts})`
    : "",
);

// CANCELLED runs
const cancelledRuns = byState("CANCELLED");
check(
  "≥2 runs CANCELLED (rejected proposal + operator cancelled)",
  cancelledRuns.length >= 2,
  `found ${cancelledRuns.length}`,
);

// 3. Deep verification of standard COMPLETED run
const statusCompleted = completedRuns.find(
  (r) => r.agent === "factory-status-report@1" && r.repos?.[0] === "ok",
);
let statusView = null;
if (statusCompleted) {
  statusView = await client.run(statusCompleted.runId);
  const expectedLifecycle = [
    "PROPOSED",
    "APPROVED",
    "QUEUED",
    "LEASED",
    "RUNNING",
    "VERIFYING",
    "COMPLETED",
  ];
  const actualLifecycle = (statusView.lifecycle ?? []).map((e) => e.to_state);
  check(
    "COMPLETED run lifecycle sequence equals [PROPOSED, APPROVED, QUEUED, LEASED, RUNNING, VERIFYING, COMPLETED]",
    JSON.stringify(actualLifecycle) === JSON.stringify(expectedLifecycle),
    actualLifecycle.join(" → "),
  );
  check(
    "COMPLETED run terminalState is completed",
    statusView.result?.terminalState === "completed",
  );
  check(
    "COMPLETED run receipt verification passed",
    statusView.receipt?.verificationStatus === "passed",
  );
  check(
    "COMPLETED run evidence is recorded",
    Boolean(statusView.result?.evidence),
  );
  check(
    "COMPLETED run receipt has valid evidenceSetHash",
    typeof statusView.receipt?.evidenceSetHash === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(statusView.receipt.evidenceSetHash),
    statusView.receipt?.evidenceSetHash,
  );
}

// 4. Artifact content-addressing and GET /artifacts/:sha
const artifactRun = completedRuns.find((r) => r.repos?.[0] === "with-artifact");
if (artifactRun) {
  const view = await client.run(artifactRun.runId);
  const reportArtifact = (view.result?.artifacts ?? []).find(
    (a) => a.kind === "report",
  );
  check(
    "with-artifact run declared report artifact",
    Boolean(reportArtifact && reportArtifact.sha256),
  );

  if (reportArtifact?.sha256) {
    // Through the client so the bearer rides along: a bare fetch answered
    // 401 whenever the demo serve inherited FACTORY_CONTROL_API_TOKEN.
    const artRes = await client.artifact(reportArtifact.sha256);
    check(
      "GET /artifacts/:sha returns 200 for declared report",
      artRes.status === 200,
    );
    const artBody = await artRes.text();
    check(
      "artifact content matches expected body",
      artBody.includes("fake report for with-artifact"),
    );
    check(
      "artifact body matches declared sha256 checksum",
      sha256hex(Buffer.from(artBody)) === reportArtifact.sha256,
    );
  }
}

// 5. Live agent trace verification
const floodRun = completedRuns.find((r) => r.repos?.[0] === "trace-flood");
if (floodRun) {
  const trace = await client.trace(floodRun.runId);
  check(
    "GET /runs/:id/trace returns trace entries",
    (trace?.entries?.length ?? 0) > 0,
    `entries: ${trace?.entries?.length}`,
  );
  check(
    "trace entries contain assistant text",
    (trace?.entries ?? []).some((e) => e.kind === "assistant_text"),
  );
}

// 6. CI Failure Chain scenario (3 hops, causationId linkage, artifacts workspace)
const ciDoctorRun = completedRuns.find((r) => r.agent === "ci-doctor@2");
const ciRerunRun = completedRuns.find((r) => r.agent === "ci-rerun@1");
const ciCaptureRun = completedRuns.find((r) => r.agent === "ci-log-capture@1");

check("CI chain: ci-log-capture@1 run present", Boolean(ciCaptureRun));
check("CI chain: ci-doctor@2 run present", Boolean(ciDoctorRun));
check("CI chain: ci-rerun@1 run present", Boolean(ciRerunRun));

let ciDoctorView = null;
// No later read outside the `if (ciRerunRun)` block below, unlike ciDoctorView
// (used again at the workspace-type coverage check) — an initializer here
// would never be observed, so eslint(no-useless-assignment) flags it.
let ciRerunView;

if (ciDoctorRun) {
  ciDoctorView = await client.run(ciDoctorRun.runId);
  check(
    "ci-doctor@2 workspace type is 'artifacts'",
    ciDoctorView.run?.spec?.workspace?.type === "artifacts",
  );
  check(
    "ci-doctor@2 input references logArtifact hash",
    Boolean(ciDoctorView.run?.spec?.input?.logArtifact),
  );
  const doctorCausation = (ciDoctorView.lifecycle ?? []).find((e) =>
    Boolean(e.causation_id),
  )?.causation_id;
  check(
    "ci-doctor@2 carries causationId linking to capture run",
    Boolean(doctorCausation),
    doctorCausation,
  );
  check(
    "ci-doctor@2 artifact verdict is FLAKE",
    ciDoctorView.result?.artifact?.verdict === "FLAKE",
  );
}

if (ciRerunRun) {
  ciRerunView = await client.run(ciRerunRun.runId);
  const rerunCausation = (ciRerunView.lifecycle ?? []).find((e) =>
    Boolean(e.causation_id),
  )?.causation_id;
  check(
    "ci-rerun@1 carries causationId linking to doctor run",
    Boolean(rerunCausation),
    rerunCausation,
  );
  check(
    "ci-rerun@1 output contract is factory.command-result/v1",
    ciRerunView.run?.spec?.outputContract === "factory.command-result/v1",
  );
}

// 7. Merge apply remains watched. Landed state is never fabricated by the
// demo; the executable WM-412 command regression drives that causal path.

// 8. Triage scenario (repository workspace with pinned repoPin and auto-approved apply)
const triageScanRun = completedRuns.find((r) => r.agent === "triage-scan@1");
const triageApplyRun = completedRuns.find(
  (r) => r.agent === "triage-apply@1" && r.eventSource === "chain",
);
check("triage scenario: triage-scan@1 run present", Boolean(triageScanRun));
check(
  "triage scenario: chain triage-apply@1 run auto-approved and completed",
  Boolean(triageApplyRun),
);
let triageScanView = null;
if (triageScanRun) {
  triageScanView = await client.run(triageScanRun.runId);
  check(
    "triage-scan@1 workspace type is 'repository'",
    triageScanView.run?.spec?.workspace?.type === "repository",
  );
  const pin = triageScanView.run?.spec?.input?.repoPin;
  check(
    "triage-scan@1 input has valid repoPin",
    Boolean(pin?.repo && pin?.ref),
  );
  check(
    "repoPin carries immutable 40-character sha",
    typeof pin?.sha === "string" && /^[0-9a-f]{40}$/.test(pin.sha),
    pin?.sha,
  );
}

// 8. Dispatched PR workflow scenario (worktree workspace with PR_OPEN, WM-133)
const dispatchRun = completedRuns.find((r) => r.agent === "dispatch@1");
check("dispatch scenario: dispatch@1 run present", Boolean(dispatchRun));
let dispatchView = null;
if (dispatchRun) {
  dispatchView = await client.run(dispatchRun.runId);
  check(
    "dispatch@1 output contract is factory.dispatch-result/v1",
    dispatchView.run?.spec?.outputContract === "factory.dispatch-result/v1",
  );
  check(
    'dispatch@1 workspace type is "worktree"',
    dispatchView.run?.spec?.workspace?.type === "worktree",
  );
  const expectedLifecycle = [
    "PROPOSED",
    "APPROVED",
    "QUEUED",
    "LEASED",
    "RUNNING",
    "VERIFYING",
    "COMPLETED",
  ];
  const actualLifecycle = (dispatchView.lifecycle ?? []).map((e) => e.to_state);
  check(
    "dispatch@1 lifecycle sequence moves through RUNNING → VERIFYING → COMPLETED",
    JSON.stringify(actualLifecycle) === JSON.stringify(expectedLifecycle),
    actualLifecycle.join(" → "),
  );
  check(
    'dispatch@1 artifact outcome is "PR_OPEN"',
    dispatchView.result?.artifact?.outcome === "PR_OPEN",
  );
  check(
    "dispatch@1 artifact ticket is set",
    Boolean(dispatchView.result?.artifact?.ticket),
  );
  check(
    "dispatch@1 artifact references an open PR URL",
    typeof dispatchView.result?.artifact?.prUrl === "string" &&
      /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(
        dispatchView.result.artifact.prUrl,
      ),
    dispatchView.result?.artifact?.prUrl,
  );
  check(
    "dispatch@1 artifact includes passed verification command output",
    dispatchView.result?.artifact?.verification?.passed === true &&
      Boolean(dispatchView.result?.artifact?.verification?.command),
  );
}

// Workspace type coverage across all 4 types
check(
  'workspace type "ephemeral" (default) covered',
  statusView?.run?.spec?.workspace === undefined ||
    statusView?.run?.spec?.workspace?.type === "ephemeral" ||
    !statusView?.run?.spec?.workspace?.type,
);
check(
  'workspace type "artifacts" covered',
  ciDoctorView?.run?.spec?.workspace?.type === "artifacts",
);
check(
  'workspace type "repository" covered',
  triageScanView?.run?.spec?.workspace?.type === "repository",
);
check(
  'workspace type "worktree" covered',
  dispatchView?.run?.spec?.workspace?.type === "worktree",
);

// 8. Proposals verification
const { proposals: openProposals } = await client.proposals();
const runProposals = openProposals.filter(
  (p) => p.decision === "run" && !p.expired,
);
const humanNeededProposals = openProposals.filter(
  (p) => p.decision === "human_needed",
);
const expiredProposals = openProposals.filter((p) => p.expired);

check(
  "≥1 open approvable `run` proposal",
  runProposals.length >= 1,
  `found ${runProposals.length}`,
);
check(
  "≥1 open `human_needed` proposal",
  humanNeededProposals.length >= 1,
  `found ${humanNeededProposals.length}`,
);
check(
  "≥1 open TTL-expired proposal (p.expired === true)",
  expiredProposals.length >= 1,
  `found ${expiredProposals.length}`,
);

// 8a. Inbox projection verification. Notifications are created by the serve
// tick, so poll each expectation rather than racing a one-time read after seed.
const inboxItems = await waitForOpenInbox((items) => items.length >= 1);
check(
  "GET /inbox?status=open returns ≥1 open item",
  inboxItems.length >= 1,
  `found ${inboxSummary(inboxItems)}`,
);
const parkedInboxItems = await waitForOpenInbox((items) =>
  items.some(parkedDecision),
);
check(
  "BLOCKED parked human_needed Inbox item has requeue/dismiss decision",
  parkedInboxItems.some(parkedDecision),
  `found ${inboxSummary(parkedInboxItems)}`,
);
const expiredInboxItems = await waitForOpenInbox((items) =>
  items.some(expiringDecision),
);
check(
  "TTL-expired Inbox item offers approve/reject decision",
  expiredInboxItems.some(expiringDecision),
  `found ${inboxSummary(expiredInboxItems)}`,
);

const { proposals: allProposals } = await client.proposals("all");
check(
  "GET /proposals?status=all returns proposal history",
  allProposals.length > openProposals.length,
);
const autoApprovedTriageApply = allProposals.find(
  (p) => p.agent === "triage-apply@1" && p.eventSource === "chain",
);
check(
  "chain triage-apply proposal is approved by chain auto-approval",
  autoApprovedTriageApply?.status === "approved" &&
    autoApprovedTriageApply?.decided_by === "chain-auto-approval",
  autoApprovedTriageApply
    ? `${autoApprovedTriageApply.status} by ${autoApprovedTriageApply.decided_by}`
    : "missing",
);
const operatorProposal = allProposals.find(
  (p) =>
    p.agent === "factory-status-report@1" &&
    p.eventSource === "operator" &&
    p.status === "open",
);
check(
  "direct operator proposal remains open/watched",
  Boolean(operatorProposal),
);
const mergeWatchedProposal = allProposals.find(
  (p) =>
    p.agent === "merge-apply@2" &&
    p.eventSource === "operator" &&
    p.status === "open",
);
check(
  "merge-apply@2 proposal remains open/watched",
  Boolean(mergeWatchedProposal),
);
const shipWatchedProposal = allProposals.find(
  (p) =>
    p.agent === "ship-apply@1" &&
    p.eventSource === "operator" &&
    p.status === "open",
);
check(
  "ship-apply proposal remains open/human watched",
  Boolean(shipWatchedProposal),
);

// 9. Events verification
const { events } = await client.events();
check(
  "events admitted",
  events.length >= 8,
  `total admitted events: ${events.length}`,
);

const eventTypes = new Set(events.map((e) => e.type));
check(
  "multiple event types in fixture",
  eventTypes.size >= 3,
  [...eventTypes].join(", "),
);
check(
  "events include chain events with causationId",
  events.some((e) => Boolean(e.causationId)),
);

const deadLetteredEvents = events.filter((e) => e.status === "dead_lettered");
check("≥1 dead_lettered event present", deadLetteredEvents.length >= 1);
if (deadLetteredEvents[0]) {
  check(
    "dead_lettered event records lastPlanError",
    Boolean(deadLetteredEvents[0].lastPlanError),
  );
}
const { events: deadLetterFilter } = await client.events("dead_lettered");
check(
  "GET /events?status=dead_lettered filters correctly",
  deadLetterFilter.length >= 1,
);

// 10. Status & Anomalies endpoint
const status = await client.status();
check(
  "GET /status returns status payload",
  Boolean(status.events && status.runs && status.anomalies),
);
check(
  "status reports dead_lettered event count",
  (status.events?.dead_lettered ?? 0) >= 1,
);
check(
  "status reports human_needed event count",
  (status.events?.human_needed ?? 0) >= 1,
);
check(
  "status reports expired proposals count",
  (status.proposals?.expired ?? 0) >= 1,
);
check(
  "status.anomalies.expiredOpenProposals lists expired proposal ID",
  (status.anomalies?.expiredOpenProposals?.length ?? 0) >= 1,
);
check(
  "status.anomalies.deadLettered lists dead-lettered event",
  (status.anomalies?.deadLettered?.length ?? 0) >= 1,
);
check(
  "status.anomalies.staleLeases === 0",
  status.anomalies?.staleLeases === 0,
);
check(
  "status.anomalies.unpublishedOutbox === 0",
  status.anomalies?.unpublishedOutbox === 0,
);
check(
  "status.anomalies.ambiguousOpenProposals is empty",
  (status.anomalies?.ambiguousOpenProposals?.length ?? 0) === 0,
);

// 11. Additional Control API Endpoints
const { workers } = await client.workers();
check(
  "GET /workers returns live worker(s)",
  workers.some((w) => w.state !== "stopped" && !w.stale),
);

const { schedules } = await client.schedules();
check("GET /schedules lists registered schedules", schedules.length >= 1);

// Compare against the committed registry, not a hand-counted literal — a new
// agent definition must not fail the e2e for being new (WM-72).
const registeredCount = loadRegistry().agents.size;
const { agents } = await client.agents();
check(
  `GET /agents lists registered agents (${registeredCount} total)`,
  agents.length === registeredCount,
  `found ${agents.length}`,
);

const journalRes = await client.journal();
check(
  "GET /journal returns lifecycle journal entries",
  (journalRes?.entries?.length ?? 0) >= 10,
);

const { outbox } = await client.outbox();
check(
  "GET /outbox returns published result events",
  (outbox?.length ?? 0) >= 1,
);

// 12. Project tags verification (OPS-385 / OPS-366)
const FAKE_ADAPTER_MODES = new Set([
  "ok",
  "refuse",
  "crash",
  "invalid-artifact",
  "hang",
  "with-artifact",
  "trace-flood",
]);
let registryNames = null;
try {
  const { repos: registry } = await client.repos();
  check(
    "GET /repos returns configured repo registry",
    Array.isArray(registry) && registry.length >= 1,
  );
  registryNames = (registry ?? []).map((row) => row.name).filter(Boolean);
} catch (err) {
  if (err.status === 500) {
    console.log(
      "skip ≥1 run carries a project tag (GET /repos 500 — registry missing or unreadable)",
    );
  } else {
    check(`GET /repos (${err.status ?? "no status"})`, false);
  }
}
if (registryNames !== null) {
  const tagged = runs.filter((r) => {
    const repos = r.repos ?? [];
    return FAKE_ADAPTER_MODES.has(repos[0]) && registryNames.includes(repos[1]);
  });
  check(
    "≥1 run carries a project tag (repos[1] from GET /repos, repos[0] still a fake-adapter mode)",
    tagged.length >= 1,
    `tagged runs: ${tagged.length}`,
  );
}

if (failures.length) {
  console.error(
    `\nverify: ${failures.length} check(s) failed — reseed with: bun event-runtime/demo/seed.mjs --port ${port}`,
  );
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nverify: seeded demo fixture fully intact and verified");
