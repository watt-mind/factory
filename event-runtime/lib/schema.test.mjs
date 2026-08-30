import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SCHEMA_FORMATS, validate } from "./schema.mjs";

const sharedCases = JSON.parse(
  readFileSync(
    new URL("./fixtures/schema-validation-cases.json", import.meta.url),
    "utf8",
  ),
).cases;
const runtimeFixture = new URL(
  "./fixtures/schema-validation-cases.json",
  import.meta.url,
);
const webFixture = new URL(
  "../web/src/lib/fixtures/schema-validation-cases.json",
  import.meta.url,
);

// Drift guard (#823): event-runtime/web/src/lib/schema.test.ts reads this exact
// same matrix, so a semantic change to one validator that is not mirrored in
// the other turns red here or there. The runtime copy is the source of truth;
// the web copy is deliberately checked in and must be recopied after edits.
describe("shared fixture schema-validation-cases.json", () => {
  test("the web copy is byte-for-byte identical", () => {
    expect(
      Buffer.compare(readFileSync(webFixture), readFileSync(runtimeFixture)),
      "Copy event-runtime/lib/fixtures/schema-validation-cases.json to event-runtime/web/src/lib/fixtures/schema-validation-cases.json after editing the source fixture",
    ).toBe(0);
  });

  test("the matrix is non-empty and every case is well-formed", () => {
    expect(sharedCases.length).toBeGreaterThan(20);
    for (const c of sharedCases) {
      expect(typeof c.name, JSON.stringify(c)).toBe("string");
      expect(typeof c.valid, c.name).toBe("boolean");
      expect(Object.hasOwn(c, "schema"), c.name).toBe(true);
      expect(Object.hasOwn(c, "value"), c.name).toBe(true);
      expect(Array.isArray(c.errors), c.name).toBe(true);
      // #1282: errors is the exact contract; the old errorContains hint is
      // dead and must not creep back in.
      expect(Object.hasOwn(c, "errorContains"), c.name).toBe(false);
      if (c.valid) {
        expect(c.errors, c.name).toEqual([]);
      } else {
        expect(c.errors.length, c.name).toBeGreaterThan(0);
      }
    }
  });

  test.each(sharedCases.map((c) => [c.name, c]))("%s", (_name, c) => {
    const result = validate(c.schema, c.value);
    expect(result.valid, `${c.name}: ${result.errors.join("; ")}`).toBe(
      c.valid,
    );
    expect(result.errors, c.name).toEqual(c.errors);
  });
});

describe("validate", () => {
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
  });

  // #823: a malformed registered pattern is a schema defect, not a crash.
  test("a malformed pattern fails closed instead of throwing", () => {
    expect(() =>
      validate({ type: "string", pattern: "[" }, "value"),
    ).not.toThrow();
    expect(validate({ type: "string", pattern: "[" }, "value")).toEqual({
      valid: false,
      errors: ["$: invalid pattern"],
    });
    expect(
      validate(
        {
          type: "object",
          properties: { sha: { type: "string", pattern: "(?<=" } },
        },
        { sha: "deadbeef" },
      ),
    ).toEqual({ valid: false, errors: ["$.sha: invalid pattern"] });
    expect(validate({ pattern: "[" }, 12)).toEqual({ valid: true, errors: [] });
  });

  test("empty schema accepts anything", () => {
    expect(validate({}, { any: ["thing", 1, null] }).valid).toBe(true);
  });

  test("unsupported keywords fail closed", () => {
    const { valid, errors } = validate({ anyOf: [{ type: "string" }] }, "x");
    expect(valid).toBe(false);
    expect(errors[0]).toContain("unsupported schema keyword");
  });

  describe("format (WM-920)", () => {
    test("the closed enum is accepted as a keyword and unknown values fail closed", () => {
      expect(SCHEMA_FORMATS).toEqual([
        "secret",
        "uri",
        "channel-id",
        "ticket",
        "duration",
        "multiline",
        "email",
      ]);
      for (const format of SCHEMA_FORMATS) {
        expect(validate({ type: "string", format }, "ok").valid).toBe(
          format === "uri" || format === "duration" ? false : true,
        );
      }
      const { valid, errors } = validate(
        { type: "string", format: "uuid" },
        "x",
      );
      expect(valid).toBe(false);
      expect(errors[0]).toContain("unsupported format");
      expect(validate({ type: "string", format: 1 }, "x").errors[0]).toContain(
        "unsupported format",
      );
    });

    test("uri must parse; other formats are hints except duration", () => {
      expect(
        validate({ type: "string", format: "uri" }, "https://example.test/x")
          .valid,
      ).toBe(true);
      const badUri = validate({ type: "string", format: "uri" }, "not a url");
      expect(badUri.valid).toBe(false);
      expect(badUri.errors[0]).toContain("valid URI");
      expect(
        validate({ type: "string", format: "duration" }, "30s").valid,
      ).toBe(true);
      expect(validate({ type: "string", format: "duration" }, "2h").valid).toBe(
        true,
      );
      expect(
        validate({ type: "string", format: "duration" }, "15ms").valid,
      ).toBe(true);
      const badDur = validate(
        { type: "string", format: "duration" },
        "30 seconds",
      );
      expect(badDur.valid).toBe(false);
      expect(badDur.errors[0]).toContain("duration");
      expect(
        validate({ type: "string", format: "email" }, "not-an-email").valid,
      ).toBe(true);
      expect(
        validate({ type: "string", format: "secret" }, "sk-live-anything")
          .valid,
      ).toBe(true);
    });
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

  describe("prototype-inherited keys and pollution (OPS-438)", () => {
    test("rejects prototype-inherited keys when additionalProperties is false", () => {
      const schema = {
        type: "object",
        additionalProperties: false,
        properties: { a: { type: "string" } },
      };
      expect(validate(schema, { a: "x", toString: "evil" }).valid).toBe(false);
      expect(validate(schema, { a: "x", valueOf: "evil" }).valid).toBe(false);
      expect(validate(schema, { a: "x", constructor: "evil" }).valid).toBe(
        false,
      );
      expect(validate(schema, { a: "x", isPrototypeOf: "evil" }).valid).toBe(
        false,
      );
    });

    test("validates additionalProperties schema on prototype-named own keys", () => {
      const schema = {
        type: "object",
        additionalProperties: { type: "integer" },
        properties: { a: { type: "string" } },
      };
      const res = validate(schema, { a: "x", toString: "not-an-int" });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("$.toString");
    });

    test("rejects missing required property even if name matches Object.prototype method", () => {
      const schema = {
        type: "object",
        required: ["toString", "valueOf", "constructor"],
      };
      const res = validate(schema, {});
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBe(3);
      expect(res.errors.some((e) => e.includes('"toString"'))).toBe(true);
      expect(res.errors.some((e) => e.includes('"valueOf"'))).toBe(true);
      expect(res.errors.some((e) => e.includes('"constructor"'))).toBe(true);
    });

    test("does not validate schema against prototype methods when property is absent on value", () => {
      const schema = {
        type: "object",
        properties: {
          toString: { type: "string" },
          valueOf: { type: "string" },
        },
      };
      const res = validate(schema, {});
      expect(res.valid).toBe(true);
    });

    test("validates objects created with Object.create(null)", () => {
      const schema = {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
        },
      };
      const obj = Object.create(null);
      obj.name = "safe";
      expect(validate(schema, obj).valid).toBe(true);

      const invalidObj = Object.create(null);
      invalidObj.extra = "bad";
      expect(validate(schema, invalidObj).valid).toBe(false);
    });

    test("schema does not pick up polluted prototype properties", () => {
      try {
        Object.prototype.unsupportedCustomKeyword = "polluted";
        Object.prototype.minimum = 100;
        const schema = { type: "number" };
        expect(validate(schema, 5).valid).toBe(true);
      } finally {
        delete Object.prototype.unsupportedCustomKeyword;
        delete Object.prototype.minimum;
      }
    });
  });
});
