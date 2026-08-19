import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DecisionRequest, DecisionResponse } from "../types";
import {
  checkRequest,
  decisionRequestHash,
  validateDecisionResponse,
} from "./decision";

interface SharedCase {
  name: string;
  request: DecisionRequest;
  hash: string;
  requestValid?: boolean;
  responses: { name: string; valid: boolean; value: DecisionResponse }[];
}

const cases = JSON.parse(
  readFileSync(
    new URL("../../../lib/fixtures/decision-cases.json", import.meta.url),
    "utf8",
  ),
).cases as SharedCase[];

describe("browser decision port", () => {
  test("agrees with the server fixture hashes and response verdicts", () => {
    for (const fixture of cases) {
      expect(decisionRequestHash(fixture.request), fixture.name).toBe(
        fixture.hash,
      );
      if (fixture.requestValid !== undefined) {
        expect(
          checkRequest(fixture.request).valid,
          `${fixture.name}/request`,
        ).toBe(fixture.requestValid);
      }
      if (fixture.name === "answer-without-required-text") {
        expect(checkRequest(fixture.request).errors).toContain(
          "option_requires_text:answer",
        );
      }
      for (const response of fixture.responses) {
        expect(
          validateDecisionResponse(response.value, fixture.request).valid,
          `${fixture.name}/${response.name}`,
        ).toBe(response.valid);
      }
    }
  });

  test("canonical key ordering does not change the hash", () => {
    const request = cases[0].request;
    const reordered = {
      options: request.options,
      question: request.question,
      fields: request.fields,
      recommended: request.recommended,
      context: request.context,
      schemaVersion: request.schemaVersion,
    } as DecisionRequest;
    expect(decisionRequestHash(reordered)).toBe(decisionRequestHash(request));
  });

  test("malformed choice fields return invalid instead of throwing", () => {
    const malformed = structuredClone(cases[0].request) as unknown as {
      fields: Record<string, unknown>[];
    };
    malformed.fields[1] = {
      id: "paths",
      kind: "multi-choice",
      label: "Paths",
    };
    const response = cases[0].responses[0].value;
    expect(() =>
      validateDecisionResponse(
        response,
        malformed as unknown as DecisionRequest,
      ),
    ).not.toThrow();
    expect(
      validateDecisionResponse(
        response,
        malformed as unknown as DecisionRequest,
      ).valid,
    ).toBe(false);
  });

  test("answer and reject_proposal require an applicable required text field", () => {
    for (const effect of ["answer", "reject_proposal"] as const) {
      const request: DecisionRequest = {
        schemaVersion: "factory.decision-request/v1",
        question: "Need a reason",
        options: [{ id: "choice", label: "Choice", effect }],
      };
      expect(checkRequest(request).errors).toContain(
        "option_requires_text:choice",
      );

      const withRequiredText: DecisionRequest = {
        ...request,
        fields: [
          {
            id: "reason",
            kind: "text",
            label: "Reason",
            required: true,
          },
        ],
      };
      expect(checkRequest(withRequiredText).valid).toBe(true);

      const optionalOnly: DecisionRequest = {
        ...request,
        fields: [
          {
            id: "reason",
            kind: "text",
            label: "Reason",
            required: false,
          },
        ],
      };
      expect(checkRequest(optionalOnly).errors).toContain(
        "option_requires_text:choice",
      );

      const gatedElsewhere: DecisionRequest = {
        schemaVersion: "factory.decision-request/v1",
        question: "Need a reason",
        options: [
          { id: "choice", label: "Choice", effect },
          { id: "other", label: "Other", effect: "dismiss" },
        ],
        fields: [
          {
            id: "reason",
            kind: "text",
            label: "Reason",
            required: true,
            whenOption: ["other"],
          },
        ],
      };
      expect(checkRequest(gatedElsewhere).errors).toContain(
        "option_requires_text:choice",
      );
    }
  });
});
