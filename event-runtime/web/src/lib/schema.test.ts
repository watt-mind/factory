import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SCHEMA_FORMATS, validate } from "./schema";

interface SharedCase {
  name: string;
  schema: unknown;
  value: unknown;
  valid: boolean;
  errors: string[];
}

const sharedCases = (
  JSON.parse(
    readFileSync(
      new URL("./fixtures/schema-validation-cases.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: SharedCase[] }
).cases;

// Drift guard (#823): event-runtime/lib/schema.test.mjs reads this exact same
// matrix. If the runtime validator and this browser port ever disagree on a
// case, one of the two suites turns red instead of the drift shipping silently.
describe("shared fixture schema-validation-cases.json", () => {
  test("the matrix is non-empty", () => {
    expect(sharedCases.length).toBeGreaterThan(20);
  });

  test.each(sharedCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const result = validate(c.schema, c.value);
    expect(result.valid, `${c.name}: ${result.errors.join("; ")}`).toBe(
      c.valid,
    );
    expect(result.errors, c.name).toEqual(c.errors);
  });
});

// Representative cases ported from event-runtime/lib/schema.test.mjs (WM-76)
// so the browser port provably matches the runtime validator's behavior.
describe("validate (web port of lib/schema.mjs)", () => {
  test("accepts a conforming object", () => {
    const schema = {
      type: "object",
      required: ["name", "count"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 0 },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    expect(
      validate(schema, { name: "bj29", count: 2, tags: ["a"] }).valid,
    ).toBe(true);
  });

  test("rejects unknown properties when additionalProperties is false", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    };
    const { valid, errors } = validate(schema, { a: "x", extra: 1 });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('"extra"');
  });

  test("integer is a number, but number is not an integer", () => {
    expect(validate({ type: "number" }, 1).valid).toBe(true);
    expect(validate({ type: "integer" }, 1.5).valid).toBe(false);
  });

  test("supports type arrays (nullable fields)", () => {
    expect(validate({ type: ["string", "null"] }, null).valid).toBe(true);
    expect(validate({ type: ["string", "null"] }, 5).valid).toBe(false);
  });

  test("const, enum, pattern, bounds", () => {
    expect(
      validate({ const: "factory.event/v1" }, "factory.event/v1").valid,
    ).toBe(true);
    expect(validate({ enum: ["a", "b"] }, "c").valid).toBe(false);
    expect(validate({ type: "string", pattern: "^run_" }, "prop_1").valid).toBe(
      false,
    );
    expect(validate({ type: "array", minItems: 1 }, []).valid).toBe(false);
    expect(
      validate({ type: "number", minimum: 0, maximum: 100 }, 150).valid,
    ).toBe(false);
  });

  test("empty schema accepts anything", () => {
    expect(validate({}, { any: ["thing", 1, null] }).valid).toBe(true);
  });

  test("unsupported keywords fail closed", () => {
    const { valid, errors } = validate({ anyOf: [{ type: "string" }] }, "x");
    expect(valid).toBe(false);
    expect(errors[0]).toContain("unsupported schema keyword");
  });

  test("nested errors carry a path", () => {
    const schema = {
      type: "object",
      properties: {
        repos: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    };
    const { errors } = validate(schema, { repos: [{}] });
    expect(errors[0]).toContain("$.repos[0]");
  });

  test("rejects prototype-inherited keys when additionalProperties is false", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    };
    expect(validate(schema, { a: "x", toString: "evil" }).valid).toBe(false);
  });

  // #1282: the message carries the pattern on both sides so the runtime and
  // web validators stay byte-for-byte aligned on the shared fixture.
  test("pattern validation error names the pattern", () => {
    const { valid, errors } = validate(
      { type: "string", pattern: "^[0-9a-f]{40}$" },
      "invalid",
    );
    expect(valid).toBe(false);
    expect(errors[0]).toBe("$: does not match pattern ^[0-9a-f]{40}$");
  });

  // #823: the dialog calls validate() on the render path. A malformed pattern
  // that reaches the browser (persisted contract, hand-edited schema) must
  // surface as a bounded validation error, never as a thrown SyntaxError.
  test("a malformed pattern fails closed instead of throwing", () => {
    expect(() =>
      validate({ type: "string", pattern: "[" }, "value"),
    ).not.toThrow();
    expect(validate({ type: "string", pattern: "[" }, "value")).toEqual({
      valid: false,
      errors: ["$: invalid pattern"],
    });
  });

  test("a malformed pattern error is bounded and hides the raw pattern", () => {
    const raw = "^(?<dupe>a)(?<dupe>b)[";
    const { valid, errors } = validate({ type: "string", pattern: raw }, "x");
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("$: invalid pattern");
    expect(errors[0]).not.toContain(raw);
    expect(errors[0]!.length).toBeLessThan(64);
  });

  test("a malformed pattern nested in a property keeps its path", () => {
    expect(
      validate(
        {
          type: "object",
          properties: { sha: { type: "string", pattern: "(?<=" } },
        },
        { sha: "deadbeef" },
      ),
    ).toEqual({ valid: false, errors: ["$.sha: invalid pattern"] });
  });

  test("a malformed pattern does not stop a non-string value validating", () => {
    expect(validate({ pattern: "[" }, 12)).toEqual({ valid: true, errors: [] });
  });

  test("matches the runtime format behavior", () => {
    expect(SCHEMA_FORMATS).toEqual([
      "secret",
      "uri",
      "channel-id",
      "ticket",
      "duration",
      "multiline",
      "email",
    ]);
    expect(validate({ type: "string", format: "uri" }, "not a url").valid).toBe(
      false,
    );
    expect(validate({ type: "string", format: "duration" }, "30s").valid).toBe(
      true,
    );
  });
});
