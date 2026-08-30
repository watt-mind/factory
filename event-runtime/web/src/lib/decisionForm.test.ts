import { describe, expect, test } from "bun:test";
import type { DecisionRequest } from "../types";
import { applicableFields, fieldErrors, initialValues } from "./decisionForm";

const request: DecisionRequest = {
  schemaVersion: "factory.decision-request/v1",
  question: "Choose",
  options: [
    { id: "go", label: "Go", effect: "dismiss" },
    { id: "stop", label: "Stop", effect: "dismiss" },
  ],
  fields: [
    { id: "note", kind: "text", label: "Note" },
    {
      id: "paths",
      kind: "multi-choice",
      label: "Paths",
      choices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      minItems: 1,
      maxItems: 2,
      whenOption: ["go"],
    },
    {
      id: "confirm",
      kind: "confirm",
      label: "Confirm",
      required: true,
      whenOption: ["go"],
    },
    {
      id: "count",
      kind: "number",
      label: "Count",
      minimum: 2,
      maximum: 4,
      integer: true,
    },
  ],
};

describe("decision form helpers", () => {
  test("gates fields by whenOption while preserving declaration order", () => {
    expect(applicableFields(request, "go").map((field) => field.id)).toEqual([
      "note",
      "paths",
      "confirm",
      "count",
    ]);
    expect(applicableFields(request, "stop").map((field) => field.id)).toEqual([
      "note",
      "count",
    ]);
  });

  test("seeds a value appropriate to every widget", () => {
    expect(initialValues(request)).toEqual({
      note: "",
      paths: [],
      confirm: false,
      count: "",
    });
  });

  test("requires true confirmation and enforces multi-choice min/max", () => {
    const values = initialValues(request);
    expect(fieldErrors(request, "go", values)).toMatchObject({
      paths: expect.any(String),
      confirm: expect.any(String),
    });
    values.paths = ["a", "b", "c"];
    values.confirm = true;
    expect(fieldErrors(request, "go", values).paths).toContain(
      "no more than 2",
    );
    values.paths = ["a"];
    expect(fieldErrors(request, "go", values)).toEqual({});
  });

  test("treats whitespace-only required text as empty", () => {
    const requiredTextRequest: DecisionRequest = {
      ...request,
      fields: [{ id: "note", kind: "text", label: "Note", required: true }],
    };
    expect(fieldErrors(requiredTextRequest, "go", { note: " \n\t " })).toEqual({
      note: "Note is required.",
    });
    expect(fieldErrors(requiredTextRequest, "go", { note: " note " })).toEqual(
      {},
    );
  });

  test("enforces number bounds and integer values", () => {
    const values = initialValues(request);
    values.count = 1;
    expect(fieldErrors(request, "stop", values).count).toContain("at least 2");
    values.count = 5;
    expect(fieldErrors(request, "stop", values).count).toContain("at most 4");
    values.count = 2.5;
    expect(fieldErrors(request, "stop", values).count).toContain(
      "whole number",
    );
    values.count = 3;
    expect(fieldErrors(request, "stop", values)).toEqual({});
  });
});
