import { describe, expect, test } from "bun:test";
import type { ScheduleItem } from "./api";
import {
  buildChainTimeline,
  chainNeedsRevisit,
  chainViewModeFromQuery,
  coveringSchedule,
  formatDelta,
  formatUntil,
  humanizeRunReason,
  loadChainViewMode,
  saveChainViewMode,
  specInputRefs,
  CHAIN_VIEW_STORAGE_KEY,
} from "./chainTimeline";
import type { ChainView, InboxItem, LifecycleEvent, Proposal, RunDetail } from "./types";

// Fixture: the real 2026-08-17 19:06 case from the ticket — a merge sweep
// (origin clock tick → merge-scan run) that emitted a merge-fix request for
// PR #541 / WM-627, planned into run_643c2c35, auto-approved by chain
// policy, claimed by a worker and refused `merge_fix_pr_moved`.
const CORR = "clock:merge-factory:2026-08-17T18:45:00.000Z";
const SCAN_RUN = "run_30f0f8b7-9635-403a-8f83-b17e8d87bfa1";
const FIX_RUN = "run_643c2c35-838d-47fd-ae37-4051214269ba";
const FIX_EVENT = "chain-run_30f0f8b7-fix-541-93230d81";
const FIX_PROPOSAL = "prop_2149ec46-e661-446b-996d-fc38762b57a4";

function chain(overrides?: Partial<ChainView>): ChainView {
  return {
    correlationId: CORR,
    events: [
      {
        source: "clock",
        eventId: CORR,
        type: "factory.merge.requested",
        subject: "factory",
        status: "planned",
        occurredAt: "2026-08-17T18:45:00.000Z",
        receivedAt: "2026-08-17T18:45:00.400Z",
        admittedAt: "2026-08-17T18:45:00.445Z",
        correlationId: CORR,
        causationId: null,
        proposalId: "prop_scan",
        proposalStatus: "approved",
        proposalDecision: "run",
        runId: SCAN_RUN,
        repos: ["factory"],
      },
      {
        source: "chain",
        eventId: FIX_EVENT,
        type: "factory.merge-fix.requested",
        subject: "factory",
        status: "planned",
        occurredAt: "2026-08-17T19:05:58.000Z",
        receivedAt: "2026-08-17T19:05:58.100Z",
        admittedAt: "2026-08-17T19:05:58.283Z",
        correlationId: CORR,
        causationId: SCAN_RUN,
        proposalId: FIX_PROPOSAL,
        proposalStatus: "approved",
        proposalDecision: "run",
        runId: FIX_RUN,
        repos: ["factory"],
      },
    ],
    runs: [
      {
        runId: SCAN_RUN,
        state: "COMPLETED",
        attempts: 1,
        agent: "merge-scan@2",
        adapter: "pi",
        reasonCode: "ok",
        eventId: CORR,
        eventSource: "clock",
        created_at: "2026-08-17T18:45:00.445Z",
        updated_at: "2026-08-17T19:05:57.939Z",
        startedAt: "2026-08-17T18:45:06.198Z",
        finishedAt: "2026-08-17T19:05:57.939Z",
        repos: ["factory"],
      },
      {
        runId: FIX_RUN,
        state: "REFUSED",
        attempts: 1,
        agent: "merge-fix@1",
        adapter: "pi",
        reasonCode: "merge_fix_pr_moved",
        eventId: FIX_EVENT,
        eventSource: "chain",
        created_at: "2026-08-17T19:06:04.284Z",
        updated_at: "2026-08-17T19:06:07.657Z",
        startedAt: "2026-08-17T19:06:05.105Z",
        finishedAt: "2026-08-17T19:06:07.657Z",
        repos: ["factory"],
      },
    ],
    ...overrides,
  };
}

function lc(seq: number, from: string | null, to: string, actor: string, reason: string | null, at: string, attempt: number | null = null): LifecycleEvent {
  return { seq, run_id: FIX_RUN, from_state: from, to_state: to, actor, reason, attempt, at };
}

function fixRunDetail(): RunDetail {
  return {
    run: {
      runId: FIX_RUN,
      state: "REFUSED",
      attempts: 1,
      idempotencyKey: "idem",
      specHash: "sha256:spec",
      created_at: "2026-08-17T19:06:04.284Z",
      updated_at: "2026-08-17T19:06:07.657Z",
      spec: {
        schemaVersion: "factory.run/v1",
        runId: FIX_RUN,
        agent: "merge-fix@1",
        input: { github: "watt-mind/factory", pr: 541, ticket: "WM-627", headSha: "6dbaab46a7f362ea66f907b630e57849e2631915", repo: "factory" },
        inputHash: "sha256:in",
        workspace: { type: "worktree" },
        adapter: "pi",
        promptVersion: "1",
        policyVersion: "git:f1ec757",
        outputContract: "factory.merge-fix-result/v1",
        capabilities: [],
        timeoutSeconds: 600,
        maxAttempts: 1,
        idempotencyKey: "idem",
      },
    },
    lifecycle: [
      lc(4749, null, "PROPOSED", "planner", "planned", "2026-08-17T19:06:04.284Z"),
      lc(4755, "PROPOSED", "APPROVED", "chain-auto-approval", "auto_approved:chain-policy@1", "2026-08-17T19:06:04.284Z"),
      lc(4756, "APPROVED", "QUEUED", "chain-auto-approval", "auto_approved:chain-policy@1", "2026-08-17T19:06:04.284Z"),
      lc(4765, "QUEUED", "LEASED", "worker_30596_69", "claimed", "2026-08-17T19:06:05.102Z", 1),
      lc(4766, "LEASED", "RUNNING", "worker_30596_69", "started", "2026-08-17T19:06:05.105Z", 1),
      lc(4772, "RUNNING", "VERIFYING", "worker_30596_69", "merge_fix_pr_moved", "2026-08-17T19:06:07.657Z", 1),
      lc(4773, "VERIFYING", "REFUSED", "worker_30596_69", "merge_fix_pr_moved", "2026-08-17T19:06:07.657Z", 1),
    ],
    attempts: [],
    result: { terminalState: "refused", reasonCode: "merge_fix_pr_moved" },
    receipt: null,
    workspace: null,
    observedModel: null,
  };
}

function proposal(overrides?: Partial<Proposal>): Proposal {
  return {
    id: FIX_PROPOSAL,
    decision: "run",
    status: "approved",
    expired: false,
    created_at: "2026-08-17T19:06:04.284Z",
    ttl_seconds: 1800,
    decided_at: "2026-08-17T19:06:04.284Z",
    decided_by: "chain-auto-approval",
    reason: null,
    runId: FIX_RUN,
    eventId: FIX_EVENT,
    eventSource: "chain",
    agent: "merge-fix@1",
    spec: null,
    repos: ["factory"],
    ...overrides,
  };
}

function schedule(overrides?: Partial<ScheduleItem>): ScheduleItem {
  return {
    loop: "merge-factory",
    repo: "factory",
    every: "15m",
    cadenceSeconds: 900,
    eventType: "factory.merge.requested",
    approval: "auto",
    catchUp: "last",
    singleton: true,
    enabled: true,
    lastSlot: "2026-08-17T19:00:00.000Z",
    lastCompletedSlot: "2026-08-17T19:00:00.000Z",
    neverCompleted: false,
    nextDue: "2026-08-17T19:15:00.000Z",
    intervalsLate: 0,
    stopped: false,
    error: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-17T19:06:30.000Z");

function build(extra?: Partial<Parameters<typeof buildChainTimeline>[0]>) {
  return buildChainTimeline({
    chain: chain(),
    runDetails: { [FIX_RUN]: fixRunDetail() },
    proposals: [proposal()],
    schedules: [schedule()],
    inbox: [],
    now: NOW,
    ...extra,
  });
}

describe("buildChainTimeline", () => {
  test("orders oldest first, one row per step, with a Δ gutter and the refusal humanized", () => {
    const { rows } = build();
    const badges = rows.map((r) => `${r.badge}${r.at ? "" : ""}`);
    // origin admitted → planned scan → scan LEASED (fallback rows: no detail
    // loaded for the scan run) → scan COMPLETED → fix admitted → fix planned
    // → fix LEASED → fix REFUSED → next
    expect(badges).toEqual(["admitted", "planned", "RUNNING", "COMPLETED", "admitted", "planned", "LEASED", "REFUSED", "next"]);
    const ats = rows.filter((r) => r.kind !== "next").map((r) => Date.parse(r.at!));
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);

    const admitted = rows[4];
    expect(admitted.actor).toBe("chain");
    expect(admitted.what).toBe("factory.merge-fix.requested (PR #541, WM-627)");
    expect(admitted.refs.map((r) => r.kind)).toEqual(["event", "pr", "ticket"]);
    expect(admitted.refs.find((r) => r.kind === "pr")?.href).toBe("https://github.com/watt-mind/factory/pull/541");

    const planned = rows[5];
    expect(planned.actor).toBe("planner");
    expect(planned.what).toBe("merge-fix@1 → run_643c2c35 (auto-approved: chain-policy@1)");
    expect(planned.nodeId).toBe(`run:${FIX_RUN}`);
    expect(planned.refs.map((r) => r.kind)).toEqual(["proposal", "run", "agent"]);
    expect(rows[6].refs.map((r) => r.kind)).toEqual(["run"]);
    expect(rows[7].refs.map((r) => r.kind)).toEqual(["run", "pr", "ticket"]);
    expect(formatDelta(planned.deltaMs)).toBe("+6s");

    const leased = rows[6];
    expect(leased.actor).toBe("worker_30596_69");
    expect(formatDelta(leased.deltaMs)).toBe("+<1s");

    const refused = rows[7];
    expect(refused.badge).toBe("REFUSED");
    expect(refused.actor).toBe("merge-fix@1");
    expect(refused.reason).toEqual({ text: "PR head moved after the plan (planned at 6dbaab4)", raw: "merge_fix_pr_moved" });
    expect(formatDelta(refused.deltaMs)).toBe("+3s");
    // APPROVED / QUEUED / RUNNING(+3ms) / VERIFYING(same instant as REFUSED) are folded.
    expect(rows.filter((r) => ["APPROVED", "QUEUED", "RUNNING", "VERIFYING"].includes(r.badge) && r.nodeId === `run:${FIX_RUN}`)).toEqual([]);
  });

  test("first row has no Δ; the next-step row carries none", () => {
    const { rows } = build();
    expect(rows[0].deltaMs).toBeNull();
    expect(rows.at(-1)!.kind).toBe("next");
    expect(rows.at(-1)!.deltaMs).toBeNull();
  });

  test("next-step row names the covering schedule and its nextDue", () => {
    const { rows } = build();
    const next = rows.at(-1)!;
    expect(next.kind).toBe("next");
    expect(next.actor).toBe("merge-factory");
    expect(next.what).toMatch(/^re-examines at \d{2}:\d{2} \(in 8m 30s\)$/);
    expect(next.refs).toEqual([{ kind: "schedule", label: "merge-factory", id: "merge-factory" }]);
    expect(next.muted).toBe(true);
  });

  test("uncovered chain: no automatic retry, linking the open inbox item when one references it", () => {
    const item: InboxItem = {
      id: "inbox_1",
      kind: "decision_needed",
      severity: "warn",
      title: "merge-fix refused for PR #541",
      body: null,
      refs: { runId: FIX_RUN },
      source: "cli",
      createdAt: "2026-08-17T19:06:10.000Z",
      ackedAt: null,
      resolvedAt: null,
      resolvedBy: null,
      delivery: {},
    };
    const disabled = build({ schedules: [schedule({ enabled: false })], inbox: [item] });
    const next = disabled.rows.at(-1)!;
    expect(next.kind).toBe("next");
    expect(next.what).toBe("no automatic retry — needs a decision");
    expect(next.refs).toEqual([{ kind: "inbox", label: item.title, id: "inbox_1" }]);

    const otherRepo = build({ schedules: [schedule({ repo: "cashsaas" })] });
    expect(otherRepo.rows.at(-1)!.what).toBe("no automatic retry — needs a decision");
    expect(otherRepo.rows.at(-1)!.refs).toEqual([]);
  });

  test("no next-step row when the chain completed or is still running", () => {
    const completed = chain();
    completed.runs[1] = { ...completed.runs[1], state: "COMPLETED", reasonCode: "ok" };
    expect(chainNeedsRevisit(completed)).toBe(false);
    expect(build({ chain: completed, runDetails: {} }).rows.some((r) => r.kind === "next")).toBe(false);

    const running = chain();
    running.runs[1] = { ...running.runs[1], state: "RUNNING", finishedAt: null, reasonCode: null };
    expect(chainNeedsRevisit(running)).toBe(false);
    expect(build({ chain: running, runDetails: {} }).rows.some((r) => r.kind === "next")).toBe(false);
  });

  test("noop decisions render the planner's reason humanized with the raw code in title", () => {
    const view = chain();
    view.events[1] = { ...view.events[1], status: "noop", proposalDecision: "noop", proposalStatus: "resolved", runId: null };
    view.runs = [view.runs[0]];
    const { rows } = build({
      chain: view,
      runDetails: {},
      proposals: [proposal({ decision: "noop", status: "resolved", reason: "ticket_assigned", runId: null, decided_at: null })],
    });
    const noop = rows.find((r) => r.badge === "noop")!;
    expect(noop.actor).toBe("planner");
    expect(noop.what).toBe("the ticket is already assigned");
    expect(noop.reason).toEqual({ text: "the ticket is already assigned", raw: "ticket_assigned" });
    expect(noop.nodeId).toBe(`event:chain:${FIX_EVENT}`);
    expect(rows.at(-1)!.kind).toBe("next");
  });

  test("falls back to chain summary rows while a run's lifecycle is loading and flags partial", () => {
    const { rows, partial } = build({ runDetails: {} });
    expect(partial).toBe(true);
    const refused = rows.find((r) => r.badge === "REFUSED")!;
    expect(refused.reason?.text).toBe("PR head moved after the plan");
    // Without the spec input the event row cannot name the PR / ticket.
    expect(rows[4].what).toBe("factory.merge-fix.requested");
  });

  test("nodeOrder lists distinct nodes in narrative order for j/k", () => {
    const { nodeOrder } = build();
    expect(nodeOrder).toEqual([`event:clock:${CORR}`, `run:${SCAN_RUN}`, `event:chain:${FIX_EVENT}`, `run:${FIX_RUN}`]);
  });
});

describe("helpers", () => {
  test("humanizeRunReason keeps the suffix and de-snakes unknown codes", () => {
    expect(humanizeRunReason("auto_approved:chain-policy@1")).toEqual({ text: "auto-approved: chain-policy@1", raw: "auto_approved:chain-policy@1" });
    expect(humanizeRunReason("some_new_code")).toEqual({ text: "some new code", raw: "some_new_code" });
    expect(humanizeRunReason(null)).toBeNull();
  });

  test("formatDelta / formatUntil", () => {
    expect(formatDelta(null)).toBe("");
    expect(formatDelta(0)).toBe("+0s");
    expect(formatDelta(400)).toBe("+<1s");
    expect(formatDelta(6_000)).toBe("+6s");
    expect(formatDelta(65_000)).toBe("+1m 5s");
    expect(formatUntil(NOW + 9 * 60_000, NOW)).toBe("in 9m");
    expect(formatUntil(NOW - 3 * 60_000, NOW)).toBe("overdue by 3m");
    expect(formatUntil(NOW + 5_000, NOW)).toBe("now");
  });

  test("specInputRefs picks PR + ticket out of a merge-fix input", () => {
    expect(specInputRefs({ github: "watt-mind/factory", pr: 541, ticket: "WM-627" })).toEqual([
      { kind: "pr", label: "PR #541", id: "https://github.com/watt-mind/factory/pull/541", href: "https://github.com/watt-mind/factory/pull/541" },
      { kind: "ticket", label: "WM-627", id: "WM-627" },
    ]);
    expect(specInputRefs(null)).toEqual([]);
  });

  test("coveringSchedule ignores disabled/stopped loops and matches repo", () => {
    const origin = chain().events[0];
    expect(coveringSchedule(origin, [schedule({ stopped: true })])).toBeNull();
    expect(coveringSchedule(origin, [schedule({ repo: null })])?.loop).toBe("merge-factory");
    expect(coveringSchedule(origin, [schedule({ eventType: "factory.work.requested" })])).toBeNull();
  });

  test("view mode persists and ?view= parses", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadChainViewMode(storage)).toBe("graph");
    saveChainViewMode("timeline", storage);
    expect(store.get(CHAIN_VIEW_STORAGE_KEY)).toBe("timeline");
    expect(loadChainViewMode(storage)).toBe("timeline");
    store.set(CHAIN_VIEW_STORAGE_KEY, "bogus");
    expect(loadChainViewMode(storage)).toBe("graph");
    expect(chainViewModeFromQuery(new URLSearchParams("view=timeline&node=x"))).toBe("timeline");
    expect(chainViewModeFromQuery(new URLSearchParams("view=nope"))).toBeNull();
    expect(chainViewModeFromQuery(new URLSearchParams(""))).toBeNull();
  });
});
