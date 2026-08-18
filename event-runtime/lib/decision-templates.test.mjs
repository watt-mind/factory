import { describe, expect, test } from "bun:test";
import { validateDecisionRequest } from "./decision.mjs";
import { templateFor } from "./decision-templates.mjs";

describe("default decision templates (WM-390)", () => {
  const cases = [
    ["ESCALATED", "escalation", { issue: "WM-1", repo: "factory", runId: "run_1" }],
    ["BLOCKED", "parked", { eventSource: "linear", eventId: "evt_1" }],
    ["decision_needed", "triage-question", { issue: "WM-2", repo: "factory" }],
    ["ESCALATED", "merge-escalation", { issue: "WM-3", repo: "factory", pr: "42" }],
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
});
