import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FORMATS, TONES } from "./artifact-view.mjs";
import {
  PRESENTATION_MAX_BYTES,
  PRESENTATION_SCHEMA,
  PRESENTATION_SCHEMA_VERSION,
  resolveRefs,
  validatePresentation,
} from "./presentation.mjs";
import { validate } from "./schema.mjs";

const SHARED_CASES = JSON.parse(
  readFileSync(
    new URL("./fixtures/presentation-cases.json", import.meta.url),
    "utf8",
  ),
).cases;

const artifact = {
  outcome: "PR_OPEN",
  count: 7,
  ok: true,
  empty: null,
  issue: "WM-456",
  rows: [{ issue: "WM-1", state: "Todo" }],
};

const value = (pointer = "/outcome") => ({ $ref: pointer });
const presentation = (...blocks) => ({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  blocks,
});
const clone = (input) => JSON.parse(JSON.stringify(input));

const ALL_BLOCKS = [
  { type: "heading", text: "Result" },
  { type: "markdown", text: "**Verified** summary." },
  {
    type: "keyvalue",
    items: [
      { label: "Outcome", value: value(), format: "state", tone: "ok" },
      { label: "Literal", value: 3 },
    ],
  },
  {
    type: "table",
    label: "Issues",
    columns: ["Issue", "State"],
    rows: [[value("/rows/0/issue"), value("/rows/0/state")]],
    formats: { Issue: "issue", State: "state" },
    tone: { State: { Todo: "neutral" } },
  },
  {
    type: "list",
    label: "Details",
    items: [{ text: "Accepted artifact", ref: value(), tone: "ok" }],
  },
  { type: "badge", text: "Passed", tone: "ok" },
  { type: "code", text: "bun test", language: "bash" },
  {
    type: "section",
    label: "Method",
    collapsed: true,
    blocks: [{ type: "markdown", text: "Checked independently." }],
  },
  {
    type: "links",
    items: [
      { label: "Issue", issue: value("/issue") },
      { label: "PR", pr: 42 },
      { label: "Run", run: "run_123" },
      { label: "Docs", url: "https://example.test/docs" },
    ],
  },
];

function expectInvalid(document, ...needles) {
  const result = validatePresentation(document, artifact);
  expect(result.valid).toBe(false);
  const joined = result.errors.join("\n");
  for (const needle of needles) expect(joined).toContain(needle);
}

describe("factory.presentation/v1 schema", () => {
  test("uses the closed schema subset and the Layer A format/tone vocabularies", () => {
    const document = presentation(...ALL_BLOCKS);
    expect(validate(PRESENTATION_SCHEMA, document)).toEqual({
      valid: true,
      errors: [],
    });
    expect(PRESENTATION_SCHEMA.properties.schemaVersion.const).toBe(
      "factory.presentation/v1",
    );
    expect(PRESENTATION_SCHEMA.properties.blocks.minItems).toBe(1);
    expect(PRESENTATION_SCHEMA.properties.blocks.maxItems).toBe(40);
    expect(PRESENTATION_SCHEMA.additionalProperties).toBe(false);

    const block = PRESENTATION_SCHEMA.properties.blocks.items;
    expect(block.additionalProperties).toBe(false);
    expect(block.properties.type.enum).toEqual([
      "heading",
      "markdown",
      "keyvalue",
      "table",
      "list",
      "badge",
      "code",
      "section",
      "links",
    ]);
    expect(block.properties.items.items.properties.format.enum).toEqual(
      FORMATS,
    );
    expect(
      block.properties.tone.additionalProperties.additionalProperties.enum,
    ).toEqual(TONES);
    expect(block.properties.formats.additionalProperties.enum).toEqual(FORMATS);
  });

  test.each(ALL_BLOCKS.map((block) => [block.type, block]))(
    "%s block passes",
    (_type, block) => {
      expect(validatePresentation(presentation(block), artifact)).toEqual({
        valid: true,
        errors: [],
      });
    },
  );

  test("accepts every literal value type and rejects arbitrary objects", () => {
    const values = ["text", 1, 1.5, true, false, null, value("/empty")];
    for (const itemValue of values) {
      expect(
        validatePresentation(
          presentation({
            type: "keyvalue",
            items: [{ label: "Value", value: itemValue }],
          }),
          artifact,
        ).valid,
      ).toBe(true);
    }
    expectInvalid(
      presentation({
        type: "keyvalue",
        items: [{ label: "Value", value: { invented: true } }],
      }),
      "unknown property",
    );
  });

  test("the shared renderer fixture has stable valid/invalid expectations", () => {
    for (const item of SHARED_CASES) {
      const result = validatePresentation(item.presentation, item.artifact);
      expect(result.valid).toBe(item.valid);
      for (const needle of item.errors ?? []) {
        expect(result.errors.join("\n")).toContain(needle);
      }
    }
  });
});

describe("validatePresentation bounds and structural rules", () => {
  const tooMany = (count, item) => Array.from({ length: count }, () => item);

  test("document blocks are bounded 1–40", () => {
    expectInvalid(presentation(), "minItems 1");
    expectInvalid(
      presentation(...tooMany(41, { type: "heading", text: "x" })),
      "maxItems 40",
    );
  });

  test("heading is at most 120 characters", () => {
    expect(
      validatePresentation(
        presentation({ type: "heading", text: "x".repeat(120) }),
        artifact,
      ).valid,
    ).toBe(true);
    expectInvalid(
      presentation({ type: "heading", text: "x".repeat(121) }),
      "heading text",
      "120",
    );
  });

  test("markdown is at most 2 KiB when UTF-8 encoded", () => {
    expect(
      validatePresentation(
        presentation({ type: "markdown", text: "é".repeat(1024) }),
        artifact,
      ).valid,
    ).toBe(true);
    expectInvalid(
      presentation({ type: "markdown", text: "é".repeat(1025) }),
      "markdown text",
      "2048 bytes",
    );
  });

  test("keyvalue is bounded to 16 items", () => {
    expectInvalid(
      presentation({
        type: "keyvalue",
        items: tooMany(17, { label: "x", value: null }),
      }),
      "keyvalue items",
      "16",
    );
  });

  test("table is bounded to 6 columns × 50 rows with rectangular rows", () => {
    expectInvalid(
      presentation({
        type: "table",
        columns: tooMany(7, "Column"),
        rows: [],
      }),
      "columns",
      "6",
    );
    expectInvalid(
      presentation({
        type: "table",
        columns: ["Column"],
        rows: tooMany(51, [null]),
      }),
      "rows",
      "50",
    );
    expectInvalid(
      presentation({
        type: "table",
        columns: ["One", "Two"],
        rows: [[1]],
      }),
      "rows[0]",
      "2 columns",
    );
    expectInvalid(
      presentation({
        type: "table",
        columns: ["One", "Two"],
        rows: [[1, 2]],
        formats: { Missing: "count" },
      }),
      "formats",
      "Missing",
    );
    expectInvalid(
      presentation({
        type: "table",
        columns: ["One", "One"],
        rows: [[1, 2]],
      }),
      "columns",
      "unique",
    );
    expectInvalid(
      presentation({
        type: "table",
        columns: ["One"],
        rows: [[1]],
        tone: "ok",
      }),
      "tone",
      "column tone map",
    );
  });

  test("list is bounded to 30 items", () => {
    expectInvalid(
      presentation({
        type: "list",
        items: tooMany(31, { text: "x" }),
      }),
      "list items",
      "30",
    );
  });

  test("code is at most 4 KiB when UTF-8 encoded", () => {
    expect(
      validatePresentation(
        presentation({ type: "code", text: "é".repeat(2048) }),
        artifact,
      ).valid,
    ).toBe(true);
    expectInvalid(
      presentation({ type: "code", text: "é".repeat(2049) }),
      "code text",
      "4096 bytes",
    );
  });

  test("section has at most 20 children and cannot nest a section", () => {
    expectInvalid(
      presentation({
        type: "section",
        label: "Too much",
        blocks: tooMany(21, { type: "markdown", text: "x" }),
      }),
      "blocks",
      "20",
    );
    expectInvalid(
      presentation({
        type: "section",
        label: "Outer",
        blocks: [
          {
            type: "section",
            label: "Inner",
            blocks: [{ type: "markdown", text: "x" }],
          },
        ],
      }),
      "depth",
      "1",
    );
    expectInvalid(
      presentation(
        ...tooMany(21, {
          type: "section",
          label: "Group",
          blocks: [{ type: "markdown", text: "x" }],
        }),
      ),
      "total block count",
      "40",
    );
  });

  test("links have at most 12 items and exactly one target", () => {
    expectInvalid(
      presentation({
        type: "links",
        items: tooMany(13, { label: "Docs", url: "https://example.test" }),
      }),
      "links items",
      "12",
    );
    expectInvalid(
      presentation({ type: "links", items: [{ label: "Missing" }] }),
      "exactly one target",
    );
    expectInvalid(
      presentation({
        type: "links",
        items: [
          {
            label: "Ambiguous",
            issue: "WM-1",
            url: "https://example.test",
          },
        ],
      }),
      "exactly one target",
    );
  });

  test("per-type keys are closed and required keys are enforced", () => {
    expectInvalid(
      presentation({ type: "heading", text: "x", label: "wrong" }),
      "not a key of type=heading",
    );
    expectInvalid(presentation({ type: "badge", text: "x" }), "requires");
    expectInvalid(
      presentation({ type: "badge", text: "x", tone: "purple" }),
      "tone",
      "ok|warn|error|muted|neutral",
    );
    expectInvalid(
      presentation({ type: "table", columns: ["x"] }),
      "requires",
      "rows",
    );
  });

  test("whole document is at most 16 KiB serialized", () => {
    const document = presentation({
      type: "markdown",
      text: "x".repeat(2048),
    });
    while (Buffer.byteLength(JSON.stringify(document), "utf8") <= 16 * 1024) {
      document.blocks.push(clone(document.blocks[0]));
    }
    expect(document.blocks.length).toBeLessThanOrEqual(40);
    expectInvalid(document, `${PRESENTATION_MAX_BYTES} bytes`);
  });

  test("never throws on garbage input", () => {
    for (const input of [null, undefined, 3, "x", [], {}, { blocks: [] }]) {
      expect(() => validatePresentation(input, artifact)).not.toThrow();
      expect(validatePresentation(input, artifact).valid).toBe(false);
    }
  });
});

describe("presentation references", () => {
  test("every reference resolves, including escaped pointers and null values", () => {
    const docArtifact = { "a/b": { "m~n": null } };
    const document = presentation({
      type: "keyvalue",
      items: [
        {
          label: "Escaped",
          value: value("/a~1b/m~0n"),
        },
      ],
    });
    expect(validatePresentation(document, docArtifact)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("an unresolved ref names the top-level block index and pointer", () => {
    expectInvalid(
      presentation({
        type: "section",
        label: "Nested",
        blocks: [
          {
            type: "list",
            items: [{ text: "Missing", ref: value("/gone") }],
          },
        ],
      }),
      "blocks[0]",
      "/gone",
    );
  });

  test("rejects malformed RFC 6901 escapes even when the literal key exists", () => {
    const document = presentation({
      type: "keyvalue",
      items: [{ label: "Bad escape", value: value("/bad~2escape") }],
    });
    const result = validatePresentation(document, { "bad~2escape": true });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("invalid RFC 6901");
  });

  test("resolveRefs returns an independent copy with source provenance", () => {
    const original = presentation(
      {
        type: "keyvalue",
        items: [
          { label: "Outcome", value: value() },
          { label: "False", value: value("/ok") },
        ],
      },
      {
        type: "table",
        columns: ["Issue"],
        rows: [[value("/rows/0/issue")]],
      },
    );
    const resolved = resolveRefs(original, artifact);
    expect(resolved).toEqual({
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      blocks: [
        {
          type: "keyvalue",
          items: [
            {
              label: "Outcome",
              value: { value: "PR_OPEN", ref: "/outcome" },
            },
            { label: "False", value: { value: true, ref: "/ok" } },
          ],
        },
        {
          type: "table",
          columns: ["Issue"],
          rows: [[{ value: "WM-1", ref: "/rows/0/issue" }]],
        },
      ],
    });
    expect(original.blocks[0].items[0].value).toEqual(value());
    resolved.blocks[0].items[0].label = "Changed";
    expect(original.blocks[0].items[0].label).toBe("Outcome");
  });
});
