import { describe, expect, test } from "bun:test";
import { applyDecisionEffect } from "./decision-effects.mjs";

describe("decision effect seam (WM-390)", () => {
  const item = {
    decision: {
      options: [
        { id: "later", effect: "dismiss" },
        { id: "go", effect: "authorise" },
      ],
    },
  };

  test("dismiss is applied and other effects remain explicitly unsupported", () => {
    expect(applyDecisionEffect(null, item, { optionId: "later" })).toEqual({
      kind: "dismiss",
      outcome: "applied",
    });
    expect(applyDecisionEffect(null, item, { optionId: "go" })).toEqual({
      kind: "authorise",
      outcome: "unsupported",
    });
  });
});
