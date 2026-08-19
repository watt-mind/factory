import { describe, expect, test } from "bun:test";
import { validateDecisionRequest } from "./decision.mjs";
import {
  replannedProposalContext,
  templateFor,
} from "./decision-templates.mjs";

describe("default decision templates (WM-390)", () => {
  const cases = [
    [
      "ESCALATED",
      "escalation",
      { issue: "WM-1", repo: "factory", runId: "run_1" },
    ],
    ["BLOCKED", "parked", { eventSource: "linear", eventId: "evt_1" }],
    ["decision_needed", "triage-question", { issue: "WM-2", repo: "factory" }],
    [
      "ESCALATED",
      "merge-escalation",
      { issue: "WM-3", repo: "factory", pr: "42" },
    ],
    ["decision_needed", "proposal", { proposalId: "prop_1" }],
  ];

  for (const [kind, producer, refs] of cases) {
    test(`${producer} is valid against its representative refs`, () => {
      const request = templateFor(kind, { producer, refs });
      expect(validateDecisionRequest(request, { refs })).toEqual({
        valid: true,
        errors: [],
      });
      expect(request.options.at(-1).effect).toBe("dismiss");
    });
  }

  test("templates are newly allocated and fail closed on unknown producers", () => {
    const refs = { eventSource: "x", eventId: "y" };
    expect(templateFor("BLOCKED", { producer: "parked", refs })).not.toBe(
      templateFor("BLOCKED", { producer: "parked", refs }),
    );
    expect(() => templateFor("BLOCKED", { producer: "mystery", refs })).toThrow(
      "unknown decision template producer",
    );
  });

  test("a dispatch proposal names the ticket, repo, model, and why-line (WM-896)", () => {
    const refs = {
      proposalId: "prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
      issue: "WM-862",
      repo: "factory",
    };
    const spec = {
      agent: "dispatch@1",
      model: "cursor-grok-4.6-high",
      input: { ticket: "WM-862", repo: "factory" },
    };
    const request = templateFor("decision_needed", {
      producer: "proposal",
      refs,
      spec,
      reason: "auto_approval_ineligible:dispatch_recheck_failed",
    });
    expect(validateDecisionRequest(request, { refs })).toEqual({
      valid: true,
      errors: [],
    });
    expect(request.question).toBe(
      "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
    );
    expect(request.context).toBe(
      "**Why you're being asked.** Auto-approval re-check failed (see proposal)",
    );
  });

  test("a re-planned proposal reuses the proposal template with a re-review context (WM-714)", () => {
    const refs = { proposalId: "prop_2" };
    const context = replannedProposalContext("prop_1", "prop_2");
    expect(context).toContain("prop_1");
    expect(context).toContain("prop_2");
    expect(context).toContain("re-planned after expiry");
    expect(context).toContain("please re-review");

    const request = templateFor("proposal_expired", {
      producer: "proposal",
      refs,
      context,
    });
    expect(validateDecisionRequest(request, { refs })).toEqual({
      valid: true,
      errors: [],
    });
    expect(request.context).toBe(context);
    expect(request.question).toContain("prop_2");
    expect(request.options.map((option) => option.effect)).toEqual([
      "approve_proposal",
      "reject_proposal",
      "dismiss",
    ]);
  });

  test("context is omitted when absent and refused when unusable", () => {
    const refs = { proposalId: "prop_2" };
    expect(
      "context" in
        templateFor("decision_needed", { producer: "proposal", refs }),
    ).toBe(false);
    expect(() =>
      templateFor("decision_needed", {
        producer: "proposal",
        refs,
        context: "",
      }),
    ).toThrow("context must be a non-empty string");
    expect(() =>
      templateFor("decision_needed", {
        producer: "proposal",
        refs,
        context: 7,
      }),
    ).toThrow("context must be a non-empty string");
  });
});
