import { describe, expect, test } from "bun:test";
import {
  EVENT_FACETS,
  PROPOSAL_FACETS,
  RUN_FACETS,
  chipHelp,
  chipLabel,
  filterHint,
  getActiveFilterToken,
  getFilterSuggestions,
  matchesFilterQuery,
  parseFilterQuery,
  proposalRunState,
  removeFilterToken,
} from "./filterQuery";
import type { AdmittedEvent, Proposal, RunListItem } from "./types";

const run = (over: Partial<RunListItem> = {}): RunListItem => ({
  runId: "run_48ac91",
  state: "FAILED",
  attempts: 1,
  maxAttempts: 3,
  agent: "factory/ci-doctor@2",
  adapter: "claude",
  reasonCode: "verify_failed",
  eventId: "evt_7719",
  eventSource: "keephq",
  created_at: "2026-08-14T09:00:00.000Z",
  updated_at: "2026-08-14T09:05:00.000Z",
  repos: ["watt-mind/factory"],
  ...over,
});

const event = (over: Partial<AdmittedEvent> = {}): AdmittedEvent => ({
  source: "keephq",
  eventId: "evt_7719",
  type: "alert.disk_pressure",
  subject: "shadow / var full",
  status: "planned",
  occurredAt: "2026-08-14T09:00:00.000Z",
  receivedAt: "2026-08-14T09:00:01.000Z",
  correlationId: null,
  planFailures: 0,
  lastPlanError: null,
  admittedAt: "2026-08-14T09:00:02.000Z",
  proposalId: "prop_8f12",
  runId: "run_48ac91",
  envelope: {},
  repos: ["watt-mind/factory"],
  ...over,
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "prop_8f12",
  decision: "run",
  status: "open",
  expired: false,
  created_at: "2026-08-14T09:00:00.000Z",
  ttl_seconds: 900,
  decided_at: null,
  decided_by: null,
  reason: "disk pressure on shadow",
  runId: "run_48ac91",
  eventId: "evt_7719",
  eventSource: "keephq",
  agent: "factory/ci-doctor@2",
  spec: null,
  repos: ["watt-mind/factory"],
  ...over,
});

const noStale = { staleRuns: new Set<string>() };
const matchRun = (input: string, row = run(), ctx = noStale) =>
  matchesFilterQuery(row, parseFilterQuery(input, RUN_FACETS), RUN_FACETS, ctx);
const matchEvent = (input: string, row = event()) =>
  matchesFilterQuery(row, parseFilterQuery(input, EVENT_FACETS), EVENT_FACETS, undefined);
const matchProposal = (input: string, row = proposal(), runStates = new Map<string, string>()) =>
  matchesFilterQuery(row, parseFilterQuery(input, PROPOSAL_FACETS), PROPOSAL_FACETS, { runStates });

describe("parseFilterQuery", () => {
  test("keyed tokens, flags and leftover words, each keeping its offsets", () => {
    const q = parseFilterQuery("agent:ci-doctor is:stale 48ac", RUN_FACETS);
    expect(q.tokens).toEqual([
      {
        kind: "field",
        key: "agent",
        typedKey: "agent",
        value: "ci-doctor",
        supported: true,
        raw: "agent:ci-doctor",
        start: 0,
        end: 15,
      },
      {
        kind: "flag",
        flag: "stale",
        help: RUN_FACETS.flags.stale.help,
        supported: true,
        raw: "is:stale",
        start: 16,
        end: 24,
      },
      { kind: "text", value: "48ac", raw: "48ac", start: 25, end: 29 },
    ]);
    expect(q.chips.map(chipLabel)).toEqual(["agent:ci-doctor", "is:stale"]);
    expect(q.isEmpty).toBe(false);
  });

  test("an empty query has no tokens and nothing to render", () => {
    const q = parseFilterQuery("   ", RUN_FACETS);
    expect(q.isEmpty).toBe(true);
    expect(q.chips).toEqual([]);
  });

  test("aliases resolve to the canonical key; the chip still reads as typed", () => {
    const q = parseFilterQuery("STATUS:Failed", RUN_FACETS);
    expect(q.tokens[0]).toMatchObject({ kind: "field", key: "state", typedKey: "status", value: "failed" });
    expect(chipLabel(q.chips[0])).toBe("status:failed");
  });

  test("a half-typed key is not yet a filter", () => {
    expect(parseFilterQuery("agent:", RUN_FACETS).isEmpty).toBe(true);
    expect(parseFilterQuery("is:", RUN_FACETS).isEmpty).toBe(true);
    expect(matchRun("agent:")).toBe(true);
  });

  test("quotes hold a value together and are not part of it", () => {
    const q = parseFilterQuery('subject:"var full" plain', EVENT_FACETS);
    expect(q.tokens[0]).toMatchObject({ kind: "field", key: "subject", value: "var full" });
    expect(q.tokens[1]).toMatchObject({ kind: "text", value: "plain" });
  });

  test("a colon that was never a filter key stays free text", () => {
    const q = parseFilterQuery("https://linear.app/watt-mind", RUN_FACETS);
    expect(q.tokens).toHaveLength(1);
    expect(q.tokens[0]).toMatchObject({ kind: "text", value: "https://linear.app/watt-mind" });
  });

  test("a known key this list has no field for is flagged, not silently dropped", () => {
    const q = parseFilterQuery("agent:ci-doctor", EVENT_FACETS);
    expect(q.chips[0]).toMatchObject({ kind: "field", key: "agent", supported: false });
    expect(matchEvent("agent:ci-doctor")).toBe(false);
  });

  test("an is: flag this list cannot answer is flagged the same way", () => {
    const q = parseFilterQuery("is:expired", RUN_FACETS);
    expect(q.chips[0]).toMatchObject({ kind: "flag", flag: "expired", supported: false });
    expect(matchRun("is:expired")).toBe(false);
  });
});

describe("matchesFilterQuery", () => {
  test("a keyed token only ever sees its own field", () => {
    // Every needle here does occur on the row — in a different column. The old
    // substring filter said yes to all of them.
    expect(matchRun("agent:keephq")).toBe(false);
    expect(matchRun("source:ci-doctor")).toBe(false);
    expect(matchRun("reason:48ac")).toBe(false);
    expect(matchRun("state:claude")).toBe(false);
    expect(matchRun("agent:ci-doctor")).toBe(true);
    expect(matchRun("run:48ac")).toBe(true);
  });

  test("values match whole, or at a word start — never mid-word", () => {
    expect(matchRun("agent:factory/ci-doctor@2")).toBe(true);
    expect(matchRun("agent:ci-doctor@2")).toBe(true);
    expect(matchRun("agent:doctor")).toBe(true);
    expect(matchRun("agent:octor")).toBe(false);
    expect(matchRun("state:fail")).toBe(true);
    expect(matchRun("state:ail")).toBe(false);
    expect(matchEvent("status:human", event({ status: "human_needed" }))).toBe(true);
    expect(matchEvent("status:needed", event({ status: "human_needed" }))).toBe(true);
  });

  test("case never matters", () => {
    expect(matchRun("STATE:failed")).toBe(true);
    expect(matchRun("state:FAILED")).toBe(true);
  });

  test("the same key twice is an either/or; different keys narrow", () => {
    expect(matchRun("state:failed state:refused")).toBe(true);
    expect(matchRun("state:refused state:cancelled")).toBe(false);
    expect(matchRun("state:failed adapter:claude")).toBe(true);
    expect(matchRun("state:failed adapter:codex")).toBe(false);
  });

  test("leftover words stay the substring search the lists always had", () => {
    expect(matchRun("48ac")).toBe(true);
    expect(matchRun("erify_fail")).toBe(true);
    expect(matchRun("keephq")).toBe(false); // eventSource is not a text column
    expect(matchRun("source:keephq")).toBe(true);
    expect(matchRun("48ac nothing")).toBe(false);
  });

  test("an empty field can never be matched by a keyed token", () => {
    expect(matchRun("reason:verify", run({ reasonCode: null }))).toBe(false);
    expect(matchRun("source:keephq", run({ eventSource: null }))).toBe(false);
  });

  test("repo: reads the whole repos list", () => {
    expect(matchRun("repo:watt-mind/factory")).toBe(true);
    expect(matchRun("repo:factory")).toBe(true);
    expect(matchRun("repo:bj29")).toBe(false);
  });

  test("Runs is:stale is the stalled-worker projection, not a guess", () => {
    expect(matchRun("is:stale")).toBe(false);
    expect(matchRun("is:stale", run(), { staleRuns: new Set(["run_48ac91"]) })).toBe(true);
    expect(matchRun("is:stale state:completed", run({ state: "COMPLETED" }), {
      staleRuns: new Set(["run_48ac91"]),
    })).toBe(true);
  });

  test("Events is:stale is an admitted event with nothing behind it", () => {
    expect(matchEvent("is:stale")).toBe(false);
    expect(
      matchEvent("is:stale", event({ status: "admitted", proposalId: null, runId: null })),
    ).toBe(true);
    expect(matchEvent("is:stale", event({ status: "admitted" }))).toBe(false);
  });

  test("Proposals is:stale and is:expired answer the two ways an open row is dead", () => {
    expect(matchProposal("is:stale")).toBe(false);
    expect(matchProposal("is:stale", proposal(), new Map([["run_48ac91", "CANCELLED"]]))).toBe(true);
    expect(matchProposal("is:stale", proposal(), new Map([["run_48ac91", "PROPOSED"]]))).toBe(false);
    expect(matchProposal("is:expired")).toBe(false);
    expect(matchProposal("is:expired", proposal({ expired: true }))).toBe(true);
  });

  test("Proposals is:stale only flags open proposals whose run left PROPOSED, not decided history rows", () => {
    expect(matchProposal("is:stale", proposal({ status: "open" }), new Map([["run_48ac91", "CANCELLED"]]))).toBe(true);
    expect(matchProposal("is:stale", proposal({ status: "open" }), new Map([["run_48ac91", "PROPOSED"]]))).toBe(false);
    expect(matchProposal("is:stale", proposal({ status: "approved" }), new Map([["run_48ac91", "COMPLETED"]]))).toBe(false);
    expect(matchProposal("is:stale", proposal({ status: "rejected" }), new Map([["run_48ac91", "FAILED"]]))).toBe(false);
    expect(matchProposal("is:stale", proposal({ status: "expired" }), new Map([["run_48ac91", "CANCELLED"]]))).toBe(false);
  });

  test("Proposals keyed fields cover the columns the list shows", () => {
    expect(matchProposal("agent:ci-doctor decision:run status:open")).toBe(true);
    expect(matchProposal("decision:human_needed")).toBe(false);
    expect(matchProposal("source:keephq event:evt_7719")).toBe(true);
    expect(matchProposal("proposal:prop_8f12")).toBe(true);
  });

  test("Events keyed fields cover the columns the inbox shows", () => {
    expect(matchEvent("source:keephq type:alert status:planned")).toBe(true);
    expect(matchEvent("type:disk_pressure")).toBe(true);
    expect(matchEvent("id:evt_7719")).toBe(true);
    expect(matchEvent("subject:shadow")).toBe(true);
    expect(matchEvent("subject:full")).toBe(true);
    expect(matchEvent("subject:hadow")).toBe(false);
  });
});

describe("removeFilterToken", () => {
  test("cuts exactly the word the chip came from", () => {
    const input = "agent:ci-doctor is:stale 48ac";
    const q = parseFilterQuery(input, RUN_FACETS);
    expect(removeFilterToken(input, q.tokens[0])).toBe("is:stale 48ac");
    expect(removeFilterToken(input, q.tokens[1])).toBe("agent:ci-doctor 48ac");
    expect(removeFilterToken(input, q.tokens[2])).toBe("agent:ci-doctor is:stale");
  });

  test("a quoted value is one word, and removal leaves no double space", () => {
    const input = 'a subject:"var full" b';
    const q = parseFilterQuery(input, EVENT_FACETS);
    expect(removeFilterToken(input, q.chips[0])).toBe("a b");
  });

  test("removing the only token empties the query", () => {
    const q = parseFilterQuery("  is:stale  ", RUN_FACETS);
    expect(removeFilterToken("  is:stale  ", q.chips[0])).toBe("");
  });
});

describe("chip and input copy", () => {
  test("a supported chip explains what it narrows", () => {
    const q = parseFilterQuery("agent:ci-doctor is:stale", RUN_FACETS);
    expect(chipHelp(q.chips[0], q)).toBe("Matches agent at a word start.");
    expect(chipHelp(q.chips[1], q)).toBe(RUN_FACETS.flags.stale.help);
  });

  test("an impossible chip says so and names what this list does have", () => {
    const q = parseFilterQuery("agent:ci-doctor is:expired", EVENT_FACETS);
    expect(chipHelp(q.chips[0], q)).toBe(
      "No agent field. event, source, type, subject, status, proposal, run, repo, reason.",
    );
    expect(chipHelp(q.chips[1], q)).toBe("Unknown is:expired. is:stale.");
  });

  test("the input hint names every key this list answers", () => {
    const hint = filterHint(parseFilterQuery("", PROPOSAL_FACETS));
    expect(hint).toContain("agent:");
    expect(hint).toContain("is:stale");
    expect(hint).toContain("is:expired");
    expect(hint).toContain("Esc clears");
  });
});

describe("proposalRunState", () => {
  test("only a run that left PROPOSED is stale; an unknown run is not", () => {
    expect(proposalRunState({ runId: "r1" }, new Map([["r1", "PROPOSED"]]))).toBeNull();
    expect(proposalRunState({ runId: "r1" }, new Map([["r1", "RUNNING"]]))).toBe("RUNNING");
    expect(proposalRunState({ runId: "r1" }, new Map())).toBeNull();
    expect(proposalRunState({ runId: null }, new Map([["r1", "RUNNING"]]))).toBeNull();
  });

  test("decided proposals (status !== 'open') are never stale even if run is terminal", () => {
    expect(proposalRunState({ runId: "r1", status: "open" }, new Map([["r1", "COMPLETED"]]))).toBe("COMPLETED");
    expect(proposalRunState({ runId: "r1", status: "approved" }, new Map([["r1", "COMPLETED"]]))).toBeNull();
    expect(proposalRunState({ runId: "r1", status: "rejected" }, new Map([["r1", "FAILED"]]))).toBeNull();
    expect(proposalRunState({ runId: "r1", status: "expired" }, new Map([["r1", "CANCELLED"]]))).toBeNull();
  });
});

describe("getActiveFilterToken", () => {
  test("finds active token under cursor when typing inside a word", () => {
    const input = "state:failed agent:ci";
    expect(getActiveFilterToken(input, 5)).toMatchObject({ raw: "state:failed", start: 0, end: 12 });
    expect(getActiveFilterToken(input, 12)).toMatchObject({ raw: "state:failed", start: 0, end: 12 });
    expect(getActiveFilterToken(input, 13)).toMatchObject({ raw: "agent:ci", start: 13, end: 21 });
    expect(getActiveFilterToken(input, 21)).toMatchObject({ raw: "agent:ci", start: 13, end: 21 });
  });

  test("returns empty token when cursor is in whitespace", () => {
    const input = "state:failed  agent:ci";
    expect(getActiveFilterToken(input, 13)).toMatchObject({ raw: "", start: 13, end: 13 });
    expect(getActiveFilterToken("   ", 1)).toMatchObject({ raw: "", start: 1, end: 1 });
    expect(getActiveFilterToken("", 0)).toMatchObject({ raw: "", start: 0, end: 0 });
  });

  test("handles quotes properly", () => {
    const input = 'subject:"disk pressure" state:fail';
    expect(getActiveFilterToken(input, 10)).toMatchObject({ raw: 'subject:"disk pressure"', start: 0, end: 23 });
    expect(getActiveFilterToken(input, 30)).toMatchObject({ raw: "state:fail", start: 24, end: 34 });
  });
});

describe("getFilterSuggestions", () => {
  test("suggests facet names and flags on empty or prefix input", () => {
    const emptySugs = getFilterSuggestions("", RUN_FACETS);
    expect(emptySugs.some((s) => s.label === "state:")).toBe(true);
    expect(emptySugs.some((s) => s.label === "agent:")).toBe(true);
    expect(emptySugs.some((s) => s.label === "repo:")).toBe(true);
    expect(emptySugs.some((s) => s.label === "reason:")).toBe(true);
    expect(emptySugs.some((s) => s.label === "is:stale")).toBe(true);

    const stSugs = getFilterSuggestions("st", RUN_FACETS);
    expect(stSugs.map((s) => s.label)).toContain("state:");
    expect(stSugs.map((s) => s.label)).toContain("status:");
    expect(stSugs.map((s) => s.label)).toContain("is:stale");
    expect(stSugs.map((s) => s.label)).not.toContain("agent:");
  });

  test("suggests enum values with state hues when typing a facet value", () => {
    const stateSugs = getFilterSuggestions("state:", RUN_FACETS, undefined, (_field, val) =>
      val === "failed" ? "var(--hue-err)" : val === "completed" ? "var(--hue-ok)" : undefined,
    );
    expect(stateSugs.length).toBeGreaterThan(0);
    const failedSug = stateSugs.find((s) => s.label === "failed");
    expect(failedSug).toBeDefined();
    expect(failedSug?.insertText).toBe("state:failed ");
    expect(failedSug?.hue).toBe("var(--hue-err)");

    const failedFilter = getFilterSuggestions("state:fa", RUN_FACETS);
    expect(failedFilter.map((s) => s.label)).toEqual(["failed"]);
  });

  test("resolves aliases like status: to canonical state values for Runs", () => {
    const statusSugs = getFilterSuggestions("status:", RUN_FACETS);
    expect(statusSugs.map((s) => s.label)).toContain("failed");
    expect(statusSugs.map((s) => s.label)).toContain("running");
    expect(statusSugs[0].insertText.startsWith("status:")).toBe(true);
  });

  test("suggests flags when typing is:", () => {
    const isSugs = getFilterSuggestions("is:", PROPOSAL_FACETS);
    expect(isSugs.map((s) => s.label)).toContain("is:stale");
    expect(isSugs.map((s) => s.label)).toContain("is:expired");
  });

  test("suggests enum values for Proposals and Events", () => {
    const decisionSugs = getFilterSuggestions("decision:", PROPOSAL_FACETS);
    expect(decisionSugs.map((s) => s.label)).toEqual(["run", "human_needed", "noop"]);

    const eventStatusSugs = getFilterSuggestions("status:", EVENT_FACETS);
    expect(eventStatusSugs.map((s) => s.label)).toEqual([
      "admitted",
      "planned",
      "noop",
      "human_needed",
      "dead_lettered",
    ]);
  });
});


describe("events reason: facet (WM-594)", () => {
  const rows = [
    { ...event({ eventId: "evt_a", status: "noop" }), decisionReason: "owned_paths_overlap" },
    { ...event({ eventId: "evt_b", status: "noop" }), decisionReason: "ticket_dispatch_already_live:run_x:same_ticket_worktree_held" },
    { ...event({ eventId: "evt_c", status: "planned" }), decisionReason: "auto_approval_ineligible:proposal_expired" },
    event({ eventId: "evt_d", status: "admitted" }),
  ];

  test("reason:<code> matches the head code and word starts inside a chained reason", () => {
    const overlap = parseFilterQuery("reason:owned_paths_overlap", EVENT_FACETS);
    expect(rows.filter((r) => matchesFilterQuery(r, overlap, EVENT_FACETS, undefined)).map((r) => r.eventId)).toEqual(["evt_a"]);
    const live = parseFilterQuery("reason:ticket_dispatch_already_live", EVENT_FACETS);
    expect(rows.filter((r) => matchesFilterQuery(r, live, EVENT_FACETS, undefined)).map((r) => r.eventId)).toEqual(["evt_b"]);
    const expired = parseFilterQuery("reason:proposal_expired", EVENT_FACETS);
    expect(rows.filter((r) => matchesFilterQuery(r, expired, EVENT_FACETS, undefined)).map((r) => r.eventId)).toEqual(["evt_c"]);
  });

  test("a row without a decision reason never matches reason:", () => {
    const q = parseFilterQuery("reason:owned", EVENT_FACETS);
    expect(matchesFilterQuery(rows[3], q, EVENT_FACETS, undefined)).toBe(false);
  });

  test("reason: is offered as a facet and takes caller-supplied value suggestions", () => {
    expect(getFilterSuggestions("rea", EVENT_FACETS).map((s) => s.insertText)).toContain("reason:");
    const facets = { ...EVENT_FACETS, values: { ...EVENT_FACETS.values, reason: ["owned_paths_overlap", "ticket_assigned"] } };
    expect(getFilterSuggestions("reason:own", facets).map((s) => s.insertText)).toEqual(["reason:owned_paths_overlap "]);
  });
});
