import { describe, expect, test } from "bun:test";
import { validate } from "./schema";

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
    expect(validate(schema, { name: "bj29", count: 2, tags: ["a"] }).valid).toBe(true);
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
    expect(validate({ const: "factory.event/v1" }, "factory.event/v1").valid).toBe(true);
    expect(validate({ enum: ["a", "b"] }, "c").valid).toBe(false);
    expect(validate({ type: "string", pattern: "^run_" }, "prop_1").valid).toBe(false);
    expect(validate({ type: "array", minItems: 1 }, []).valid).toBe(false);
    expect(validate({ type: "number", minimum: 0, maximum: 100 }, 150).valid).toBe(false);
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
          items: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
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
});
