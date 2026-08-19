import { describe, expect, test } from "bun:test";
import {
  agentFamily,
  agentVerb,
  primaryInput,
  proposalDecisionContext,
  proposalQuestion,
  proposalReasonPlain,
  proposalSubject,
} from "./proposal-subject.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const emptyRegistry = { views: new Map() };

const dispatchSpec = {
  agent: "dispatch@1",
  model: "cursor-grok-4.6-high",
  input: { ticket: "WM-862", repo: "factory" },
};

describe("proposalSubject (WM-897)", () => {
  test("delegates to the view subject when the agent's sidecar defines one", () => {
    expect(
      proposalSubject(registry, {
        agent: "dispatch@1",
        model: "cursor-grok-4.6-high",
        adapter: "cursor",
        input: { repo: "factory", ticket: "WM-862" },
      }),
    ).toBe("Dispatch WM-862 · factory · cursor-grok-4.6-high");
  });

  test("keeps the dispatch fallback when the view does not define subject", () => {
    expect(
      proposalSubject(emptyRegistry, {
        agent: "dispatch@1",
        model: "sonnet",
        input: { repo: "bj29", ticket: "CLNT-1" },
      }),
    ).toBe("Dispatch CLNT-1 · bj29 · sonnet");
    expect(
      proposalSubject(emptyRegistry, {
        agent: "dispatch@1",
        input: {},
      }),
    ).toBe("Dispatch ? · ? · default");
  });

  test("a non-dispatch agent without a view subject falls through to <verb> <primary input> (WM-896)", () => {
    expect(
      proposalSubject(registry, {
        agent: "merge-scan@2",
        input: { repo: "factory" },
      }),
    ).toBe("Merge-Scan factory");
    expect(proposalSubject(registry, null)).toBeNull();
  });
});

describe("proposalSubject (WM-896)", () => {
  test("dispatch is ticket · repo · model, with an em-dash title when evidence has one", () => {
    expect(proposalSubject(dispatchSpec)).toBe(
      "Dispatch WM-862 · factory · cursor-grok-4.6-high",
    );
    expect(
      proposalSubject({
        ...dispatchSpec,
        approvalPolicy: {
          dispatchEvidence: { ticket: { title: "feat(forge): add prChecks" } },
        },
      }),
    ).toBe(
      "Dispatch WM-862 · factory · cursor-grok-4.6-high — feat(forge): add prChecks",
    );
    expect(
      proposalSubject({
        ...dispatchSpec,
        approvalPolicy: { dispatchEvidence: { ticket: {} } },
      }),
    ).toBe("Dispatch WM-862 · factory · cursor-grok-4.6-high");
  });

  test("other agents use <verb> <primary input>", () => {
    expect(agentFamily("triage-scan@1")).toBe("triage-scan");
    expect(agentVerb("triage-scan@1")).toBe("Triage-Scan");
    expect(agentVerb("ci-doctor@2")).toBe("Ci-Doctor");
    expect(primaryInput({ repo: "factory" })).toBe("factory");
    expect(
      proposalSubject({
        agent: "triage-scan@1",
        input: { repo: "factory" },
      }),
    ).toBe("Triage-Scan factory");
    expect(
      proposalSubject({
        agent: "merge-scan@2",
        input: { repo: "bj29", prNumbers: [12] },
      }),
    ).toBe("Merge-Scan bj29");
    expect(proposalSubject({ agent: "ci-doctor@2" })).toBe("Ci-Doctor");
    expect(proposalSubject(null)).toBe("Run");
  });
});

describe("proposalQuestion", () => {
  test("dispatch names the agent, ticket, repo, and model", () => {
    expect(proposalQuestion(dispatchSpec)).toBe(
      "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
    );
  });

  test("falls back to the proposal id when the spec is missing", () => {
    expect(proposalQuestion(null, { proposalId: "prop_1" })).toBe(
      "Decide proposal prop_1",
    );
    expect(proposalQuestion({})).toBe(
      "Should this proposal notification be dismissed?",
    );
    expect(
      proposalQuestion({ agent: "ci-doctor@2", input: { repo: "acme/app" } }),
    ).toBe("Run ci-doctor@2 for acme/app?");
  });
});

describe("proposalReasonPlain", () => {
  test("maps known auto-approval codes and passes unknown through", () => {
    expect(
      proposalReasonPlain("auto_approval_ineligible:dispatch_recheck_failed"),
    ).toBe("Auto-approval re-check failed (see proposal)");
    expect(proposalReasonPlain("auto_approval_ineligible:capacity_full")).toBe(
      "Repo at in-flight cap",
    );
    expect(
      proposalReasonPlain(
        "auto_approval_ineligible:evidence_changed_since_plan",
      ),
    ).toBe("Ticket changed since planning");
    expect(proposalReasonPlain("capacity_full")).toBe("Repo at in-flight cap");
    expect(proposalReasonPlain("auto_approval_ineligible:hook_denied")).toBe(
      "auto_approval_ineligible:hook_denied",
    );
    expect(proposalReasonPlain(null)).toBeNull();
  });

  test("decision context is omitted when there is no reason", () => {
    expect(proposalDecisionContext(null)).toBeUndefined();
    expect(
      proposalDecisionContext(
        "auto_approval_ineligible:dispatch_recheck_failed",
      ),
    ).toBe(
      "**Why you're being asked.** Auto-approval re-check failed (see proposal)",
    );
  });
});
