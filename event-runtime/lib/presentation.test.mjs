import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FORMATS, TONES } from "./artifact-view.mjs";
import {
  BLOCK_TYPES,
  CODE_MAX_BYTES,
  HEADING_MAX_CHARS,
  MARKDOWN_MAX_BYTES,
  MAX_DOC_BYTES,
  PRESENTATION_SCHEMA,
  PRESENTATION_SCHEMA_VERSION,
  resolveRefs,
  validatePresentation,
} from "./presentation.mjs";
import { validate } from "./schema.mjs";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/presentation-cases.json", import.meta.url),
    "utf8",
  ),
);

const ARTIFACT = {
  recommendation: "DISPATCH",
  count: 58,
  ok: true,
  nested: { value: 14 },
  plan: [{ issueId: "WM-101" }, { issueId: "WM-102" }, { issueId: "WM-118" }],
};

/** A one-block presentation of the given block, for focused pass/fail checks. */
function doc(block) {
  return { schemaVersion: PRESENTATION_SCHEMA_VERSION, blocks: [block] };
}

describe("presentation schema keywords", () => {
  test("uses only the keywords lib/schema.mjs supports (fails closed otherwise)", () => {
    // A self-referential guard: validating any object against the presentation
    // schema must not raise "unsupported schema keyword".
    const check = validate(PRESENTATION_SCHEMA, {
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      blocks: [{ type: "heading", text: "hi" }],
    });
    expect(check.errors.join("\n")).not.toContain("unsupported schema keyword");
    expect(check.valid).toBe(true);
  });

  test("format and tone vocabularies are identical to factory.artifact-view/v1", () => {
    const view = JSON.parse(
      readFileSync(
        new URL("../schemas/factory.artifact-view.v1.json", import.meta.url),
        "utf8",
      ),
    );
    const viewFormats =
      view.properties.sections.items.properties.formats.additionalProperties
        .enum;
    const viewTones =
      view.properties.status.properties.tone.additionalProperties.enum;
    expect(FORMATS).toEqual(viewFormats);
    expect(TONES).toEqual(viewTones);
  });
});

describe("validatePresentation — envelope", () => {
  test("valid minimal document", () => {
    const out = validatePresentation(doc({ type: "heading", text: "hi" }), {});
    expect(out).toEqual({ valid: true, errors: [] });
  });

  test("wrong schemaVersion fails closed", () => {
    const out = validatePresentation(
      { schemaVersion: "nope", blocks: [{ type: "heading", text: "hi" }] },
      {},
    );
    expect(out.valid).toBe(false);
  });

  test("blocks required and 1–40", () => {
    expect(
      validatePresentation(
        { schemaVersion: PRESENTATION_SCHEMA_VERSION, blocks: [] },
        {},
      ).valid,
    ).toBe(false);
    const many = Array.from({ length: 41 }, () => ({
      type: "heading",
      text: "x",
    }));
    expect(
      validatePresentation(
        { schemaVersion: PRESENTATION_SCHEMA_VERSION, blocks: many },
        {},
      ).valid,
    ).toBe(false);
  });

  test("serialised size ceiling (≤ 16 KiB)", () => {
    const big = "x".repeat(MAX_DOC_BYTES);
    const out = validatePresentation(doc({ type: "markdown", text: big }), {});
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.includes("serialised presentation"))).toBe(
      true,
    );
  });

  test("BLOCK_TYPES matches the schema enum", () => {
    expect(BLOCK_TYPES).toEqual(
      PRESENTATION_SCHEMA.properties.blocks.items.properties.type.enum,
    );
  });
});

describe("validatePresentation — each block type pass/fail", () => {
  test("heading: passes, and fails over the char bound", () => {
    expect(
      validatePresentation(doc({ type: "heading", text: "ok" }), {}).valid,
    ).toBe(true);
    const long = "x".repeat(HEADING_MAX_CHARS + 1);
    const out = validatePresentation(doc({ type: "heading", text: long }), {});
    expect(out.valid).toBe(false);
    expect(out.errors[0]).toContain("heading text is");
  });

  test("markdown: passes, and fails over the byte bound", () => {
    expect(
      validatePresentation(doc({ type: "markdown", text: "hello" }), {}).valid,
    ).toBe(true);
    const long = "x".repeat(MARKDOWN_MAX_BYTES + 1);
    const out = validatePresentation(doc({ type: "markdown", text: long }), {});
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.includes("markdown text is"))).toBe(true);
  });

  test("code: passes with language, and fails over the byte bound", () => {
    expect(
      validatePresentation(
        doc({ type: "code", text: "{}", language: "json" }),
        {},
      ).valid,
    ).toBe(true);
    const long = "x".repeat(CODE_MAX_BYTES + 1);
    const out = validatePresentation(doc({ type: "code", text: long }), {});
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.includes("code text is"))).toBe(true);
  });

  test("badge: passes with a tone, fails on an unknown tone", () => {
    expect(
      validatePresentation(doc({ type: "badge", text: "OK", tone: "ok" }), {})
        .valid,
    ).toBe(true);
    expect(
      validatePresentation(
        doc({ type: "badge", text: "OK", tone: "purple" }),
        {},
      ).valid,
    ).toBe(false);
  });

  test("keyvalue: passes; caps at 16 items; rejects a stray key", () => {
    expect(
      validatePresentation(
        doc({
          type: "keyvalue",
          items: [{ label: "R", value: "x", format: "state", tone: "ok" }],
        }),
        {},
      ).valid,
    ).toBe(true);
    const many = Array.from({ length: 17 }, () => ({ label: "l", value: "v" }));
    const out = validatePresentation(
      doc({ type: "keyvalue", items: many }),
      {},
    );
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.includes("> 16"))).toBe(true);
    // value is required on a keyvalue item
    expect(
      validatePresentation(
        doc({ type: "keyvalue", items: [{ label: "l" }] }),
        {},
      ).valid,
    ).toBe(false);
  });

  test("list: passes; caps at 30 items", () => {
    expect(
      validatePresentation(
        doc({
          type: "list",
          label: "L",
          items: [{ text: "a", tone: "warn" }],
        }),
        {},
      ).valid,
    ).toBe(true);
    const many = Array.from({ length: 31 }, () => ({ text: "t" }));
    const out = validatePresentation(doc({ type: "list", items: many }), {});
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.includes("> 30"))).toBe(true);
  });

  test("table: passes; caps columns×rows; row width must match columns", () => {
    expect(
      validatePresentation(
        doc({
          type: "table",
          columns: ["A", "B"],
          rows: [["1", "2"]],
          formats: ["issue", "count"],
        }),
        {},
      ).valid,
    ).toBe(true);
    const wideCols = validatePresentation(
      doc({
        type: "table",
        columns: ["a", "b", "c", "d", "e", "f", "g"],
        rows: [],
      }),
      {},
    );
    expect(wideCols.valid).toBe(false);
    const tooManyRows = validatePresentation(
      doc({
        type: "table",
        columns: ["A"],
        rows: Array.from({ length: 51 }, () => ["x"]),
      }),
      {},
    );
    expect(tooManyRows.valid).toBe(false);
    expect(tooManyRows.errors.some((e) => e.includes("rows"))).toBe(true);
    const misaligned = validatePresentation(
      doc({ type: "table", columns: ["A", "B"], rows: [["only-one"]] }),
      {},
    );
    expect(misaligned.valid).toBe(false);
    expect(misaligned.errors.some((e) => e.includes("cells"))).toBe(true);
  });

  test("section: passes with a child; caps at 20 children; rejects a nested section", () => {
    expect(
      validatePresentation(
        doc({
          type: "section",
          label: "M",
          collapsed: true,
          blocks: [{ type: "markdown", text: "x" }],
        }),
        {},
      ).valid,
    ).toBe(true);
    const many = Array.from({ length: 21 }, () => ({
      type: "markdown",
      text: "x",
    }));
    expect(
      validatePresentation(
        doc({ type: "section", label: "M", blocks: many }),
        {},
      ).valid,
    ).toBe(false);
    // one level of nesting only — a section inside a section is rejected
    expect(
      validatePresentation(
        doc({
          type: "section",
          label: "outer",
          blocks: [
            {
              type: "section",
              label: "inner",
              blocks: [{ type: "markdown", text: "x" }],
            },
          ],
        }),
        {},
      ).valid,
    ).toBe(false);
  });

  test("links: passes with exactly one target; fails on zero or two", () => {
    expect(
      validatePresentation(
        doc({
          type: "links",
          items: [{ label: "Repo", issue: null, url: "https://x.test" }],
        }),
        {},
      ).valid,
    ).toBe(true);
    const none = validatePresentation(
      doc({ type: "links", items: [{ label: "x", issue: null }] }),
      {},
    );
    expect(none.valid).toBe(false);
    const two = validatePresentation(
      doc({
        type: "links",
        items: [{ label: "x", issue: "WM-1", url: "https://x.test" }],
      }),
      {},
    );
    expect(two.valid).toBe(false);
    expect(
      two.errors.some((e) => e.includes("exactly one non-null target")),
    ).toBe(true);
  });

  test("a key that does not belong to the block type is rejected", () => {
    const out = validatePresentation(
      doc({ type: "heading", text: "hi", tone: "ok" }),
      {},
    );
    expect(out.valid).toBe(false);
    expect(
      out.errors.some((e) => e.includes("is not a key of type=heading")),
    ).toBe(true);
  });
});

describe("validatePresentation — $ref resolution into the artifact", () => {
  test("resolving refs pass in keyvalue value, table cell, links target, list ref", () => {
    const out = validatePresentation(
      {
        schemaVersion: PRESENTATION_SCHEMA_VERSION,
        blocks: [
          {
            type: "keyvalue",
            items: [
              { label: "Rec", value: { $ref: "/recommendation" } },
              { label: "N", value: { $ref: "/nested/value" } },
            ],
          },
          {
            type: "table",
            columns: ["Issue"],
            rows: [[{ $ref: "/plan/0/issueId" }]],
          },
          {
            type: "list",
            items: [{ text: "cite", ref: "/plan/2" }],
          },
          {
            type: "links",
            items: [{ label: "x", url: { $ref: "/recommendation" } }],
          },
        ],
      },
      ARTIFACT,
    );
    expect(out).toEqual({ valid: true, errors: [] });
  });

  test("an unresolved $ref names the block index and the pointer", () => {
    const out = validatePresentation(
      doc({
        type: "keyvalue",
        items: [{ label: "x", value: { $ref: "/missing/path" } }],
      }),
      ARTIFACT,
    );
    expect(out.valid).toBe(false);
    expect(out.errors[0]).toContain("blocks[0]");
    expect(out.errors[0]).toContain("/missing/path");
    expect(out.errors[0]).toContain("does not resolve");
  });

  test("an unresolved bare list ref pointer is an error", () => {
    const out = validatePresentation(
      doc({ type: "list", items: [{ text: "x", ref: "/plan/99" }] }),
      ARTIFACT,
    );
    expect(out.valid).toBe(false);
    expect(out.errors[0]).toContain("/plan/99");
  });

  test("a literal value (not a $ref) is left alone", () => {
    const out = validatePresentation(
      doc({
        type: "keyvalue",
        items: [{ label: "x", value: "a literal string" }],
      }),
      ARTIFACT,
    );
    expect(out.valid).toBe(true);
  });
});

describe("resolveRefs", () => {
  test("replaces every $ref with { value, ref } and leaves literals and list refs", () => {
    const presentation = {
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      blocks: [
        {
          type: "keyvalue",
          items: [
            { label: "Rec", value: { $ref: "/recommendation" } },
            { label: "Lit", value: "plain" },
          ],
        },
        { type: "list", items: [{ text: "cite", ref: "/plan/0" }] },
      ],
    };
    const resolved = resolveRefs(presentation, ARTIFACT);
    expect(resolved.blocks[0].items[0].value).toEqual({
      value: "DISPATCH",
      ref: "/recommendation",
    });
    expect(resolved.blocks[0].items[1].value).toBe("plain");
    // the bare list ref citation is untouched
    expect(resolved.blocks[1].items[0].ref).toBe("/plan/0");
    // input is not mutated
    expect(presentation.blocks[0].items[0].value).toEqual({
      $ref: "/recommendation",
    });
  });

  test("an unresolved $ref becomes { value: undefined, ref }", () => {
    const resolved = resolveRefs(
      doc({
        type: "keyvalue",
        items: [{ label: "x", value: { $ref: "/nope" } }],
      }),
      ARTIFACT,
    );
    const cell = resolved.blocks[0].items[0].value;
    expect(cell.ref).toBe("/nope");
    expect(cell.value).toBeUndefined();
  });
});

describe("shared fixture presentation-cases.json", () => {
  test("every case validates as its fixture declares (server test reads the same file)", () => {
    for (const c of FIXTURE.cases) {
      const out = validatePresentation(c.presentation, FIXTURE.artifact);
      expect(out.valid, `${c.name}: expected valid=${c.valid}`).toBe(c.valid);
      for (const substring of c.errors ?? []) {
        expect(
          out.errors.some((e) => e.includes(substring)),
          `${c.name}: expected an error containing "${substring}" in ${JSON.stringify(out.errors)}`,
        ).toBe(true);
      }
    }
  });
});
