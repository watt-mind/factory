import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_ROOT } from "./config.mjs";
import {
  ARTIFACT_VIEW_SCHEMA,
  ARTIFACT_VIEW_SCHEMA_VERSION,
  FORMATS,
  SECTION_KINDS,
  TONES,
  parsePointer,
  resolvePointer,
  resolveSchemaPointer,
  validateArtifactView,
} from "./artifact-view.mjs";
import { validate } from "./schema.mjs";

/** A small output schema shaped like the real scans: enum status, array of objects, nested array. */
const OUTPUT_SCHEMA = {
  type: "object",
  required: ["recommendation", "plan", "summary"],
  additionalProperties: false,
  properties: {
    recommendation: { enum: ["GO", "NOOP"] },
    repo: { type: "string" },
    summary: { type: "string" },
    "a/b": { type: "string" },
    "t~e": { type: "string" },
    plan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          action: { enum: ["one", "two"] },
          reason: { type: "string" },
          criteria: {
            type: "array",
            items: { type: "object", properties: { text: { type: "string" } } },
          },
        },
      },
    },
    log: { type: "string" },
  },
};

const VIEW = {
  schemaVersion: ARTIFACT_VIEW_SCHEMA_VERSION,
  title: "Plan",
  summary: "/summary",
  status: { path: "/recommendation", tone: { GO: "ok", NOOP: "neutral" } },
  sections: [
    {
      path: "/plan",
      as: "table",
      label: "Plan",
      columns: ["issueId", "action", "reason"],
      groupBy: "action",
      formats: { issueId: "issue" },
      tone: { action: { one: "ok", two: "warn" } },
      expand: ["criteria"],
    },
    { path: "/repo", as: "keyvalue", label: "Repo", formats: { "": "repo" } },
    { path: "/plan", as: "list", itemLabel: "/reason", formats: { issueId: "issue" } },
    { path: "/recommendation", as: "badge", tone: { GO: "ok" } },
    { path: "/log", as: "code", language: "text" },
    { path: "/summary", as: "prose" },
  ],
};

const clone = (v) => JSON.parse(JSON.stringify(v));

describe("factory.artifact-view/v1 schema (WM-454)", () => {
  test("uses only lib/schema.mjs's supported keyword subset — the schema itself validates a document", () => {
    // schema.mjs fails closed on any unsupported keyword; a keyword slip in the
    // contract would surface here as an "unsupported schema keyword" error.
    const { valid, errors } = validate(ARTIFACT_VIEW_SCHEMA, VIEW);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  test("encodes the closed vocabularies from design §2.2", () => {
    expect(ARTIFACT_VIEW_SCHEMA.properties.schemaVersion.const).toBe("factory.artifact-view/v1");
    expect(ARTIFACT_VIEW_SCHEMA.properties.title.maxLength).toBe(60);
    expect(ARTIFACT_VIEW_SCHEMA.properties.sections.minItems).toBe(1);
    expect(ARTIFACT_VIEW_SCHEMA.properties.sections.maxItems).toBe(12);
    const section = ARTIFACT_VIEW_SCHEMA.properties.sections.items;
    expect(section.properties.as.enum).toEqual(SECTION_KINDS);
    expect(SECTION_KINDS).toEqual(["table", "keyvalue", "list", "badge", "code", "prose"]);
    expect(section.properties.columns.minItems).toBe(1);
    expect(section.properties.columns.maxItems).toBe(8);
    expect(section.properties.formats.additionalProperties.enum).toEqual(FORMATS);
    expect(FORMATS).toEqual(["issue", "pr", "url", "sha", "repo", "run", "duration", "datetime", "state", "bytes", "count"]);
    expect(ARTIFACT_VIEW_SCHEMA.properties.status.properties.tone.additionalProperties.enum).toEqual(TONES);
    expect(TONES).toEqual(["ok", "warn", "error", "muted", "neutral"]);
    // additionalProperties: false throughout the object shapes.
    expect(ARTIFACT_VIEW_SCHEMA.additionalProperties).toBe(false);
    expect(ARTIFACT_VIEW_SCHEMA.properties.status.additionalProperties).toBe(false);
    expect(section.additionalProperties).toBe(false);
  });

  test("a well-formed view passes schema and drift checks", () => {
    expect(validateArtifactView(VIEW, OUTPUT_SCHEMA)).toEqual({ valid: true, errors: [] });
  });

  test("schema failures: wrong version, unknown as/format/tone, bounds, unknown keys", () => {
    const fails = (mutate, needle) => {
      const view = clone(VIEW);
      mutate(view);
      const { valid, errors } = validateArtifactView(view, OUTPUT_SCHEMA);
      expect(valid).toBe(false);
      expect(errors.join("\n")).toMatch(needle);
    };
    fails((v) => (v.schemaVersion = "factory.artifact-view/v2"), /schemaVersion: expected const/);
    fails((v) => (v.title = "x".repeat(61)), /title: longer than maxLength 60/);
    fails((v) => (v.sections = []), /fewer than minItems 1/);
    fails((v) => (v.sections = Array.from({ length: 13 }, () => clone(VIEW.sections[5]))), /more than minItems|more than maxItems 12/);
    fails((v) => (v.sections[0].as = "chart"), /as: value not in enum/);
    fails((v) => (v.sections[0].formats.issueId = "money"), /formats.issueId: value not in enum/);
    fails((v) => (v.status.tone.GO = "green"), /status.tone.GO: value not in enum/);
    fails((v) => (v.sections[0].columns = Array.from({ length: 9 }, (_, i) => `c${i}`)), /columns: more than maxItems 8/);
    fails((v) => (v.sections[0].width = 12), /unknown property "width"/);
    fails((v) => (v.extra = true), /unknown property "extra"/);
    fails((v) => delete v.sections[0].path, /missing required property "path"/);
    fails((v) => (v.summary = "summary"), /summary: does not match pattern/);
    // Nested tone values are checked in code (schema.mjs has no conditional keywords).
    fails((v) => (v.sections[0].tone.action.one = "purple"), /tone.action.one: tone must be one of/);
    fails((v) => (v.sections[3].tone.GO = "purple"), /badge tone must be one of/);
    fails((v) => (v.sections[0].tone.action = "ok"), /tone maps a column\/key to a \(value → tone\) object/);
  });

  test("per-as keys: a key from another kind is refused, table requires columns", () => {
    const fails = (mutate, needle) => {
      const view = clone(VIEW);
      mutate(view);
      const { valid, errors } = validateArtifactView(view, OUTPUT_SCHEMA);
      expect(valid).toBe(false);
      expect(errors.join("\n")).toMatch(needle);
    };
    fails((v) => (v.sections[1].columns = ["repo"]), /"columns" is not a key of as=keyvalue/);
    fails((v) => (v.sections[0].language = "json"), /"language" is not a key of as=table/);
    fails((v) => (v.sections[5].tone = { x: "ok" }), /"tone" is not a key of as=prose/);
    fails((v) => (v.sections[3].keys = ["x"]), /"keys" is not a key of as=badge/);
    fails((v) => delete v.sections[0].columns, /as=table requires "columns"/);
    fails((v) => (v.sections[0].path = "/summary"), /as=table needs an array schema/);
  });

  test("drift: every pointer must resolve in the output schema", () => {
    const fails = (mutate, needle) => {
      const view = clone(VIEW);
      mutate(view);
      const { valid, errors } = validateArtifactView(view, OUTPUT_SCHEMA);
      expect(valid).toBe(false);
      expect(errors.join("\n")).toMatch(needle);
    };
    fails((v) => (v.summary = "/gone"), /summary: pointer "\/gone" does not resolve/);
    fails((v) => (v.status.path = "/verdict"), /status.path: pointer "\/verdict" does not resolve/);
    fails((v) => (v.sections[0].path = "/rows"), /sections\[0\].path: pointer "\/rows" does not resolve/);
    fails((v) => v.sections[0].columns.push("owner"), /sections\[0\].columns: "owner" does not resolve under "\/plan"/);
    fails((v) => (v.sections[0].groupBy = "kind"), /groupBy: "kind" does not resolve/);
    fails((v) => v.sections[0].expand.push("detail"), /expand: "detail" does not resolve/);
    fails((v) => (v.sections[0].formats.pr = "pr"), /formats: "pr" does not resolve/);
    fails((v) => (v.sections[0].tone.state = { x: "ok" }), /tone: "state" does not resolve/);
    fails((v) => (v.sections[2].itemLabel = "/title"), /itemLabel: "\/title" does not resolve/);
    fails((v) => (v.sections[1].keys = ["nope"]), /keys: "nope" does not resolve under "\/repo"/);
    // A missing output schema is a validation failure, not a crash.
    expect(validateArtifactView(VIEW, undefined).valid).toBe(false);
    // Section pointers may reach through arrays with an index token, and
    // relative keys may be nested pointers.
    const ok = clone(VIEW);
    ok.sections[2] = { path: "/plan/0/criteria", as: "list", itemLabel: "/text" };
    ok.sections[0].expand = ["criteria/0/text"];
    expect(validateArtifactView(ok, OUTPUT_SCHEMA)).toEqual({ valid: true, errors: [] });
    // ...but an array is not stepped through by a property name.
    const bad = clone(VIEW);
    bad.sections[0].path = "/plan/issueId";
    expect(validateArtifactView(bad, OUTPUT_SCHEMA).valid).toBe(false);
  });

  test("validateArtifactView never throws on garbage input", () => {
    for (const junk of [null, undefined, 42, "view", [], {}, { schemaVersion: 1 }]) {
      const result = validateArtifactView(junk, OUTPUT_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("resolvePointer (RFC 6901)", () => {
  const doc = {
    a: { b: [{ c: 1 }, { c: 2 }] },
    "x/y": "slash",
    "m~n": "tilde",
    "": "empty-key",
    zero: 0,
    nul: null,
  };

  test("resolves objects, arrays and the whole document", () => {
    expect(resolvePointer(doc, "")).toBe(doc);
    expect(resolvePointer(doc, "/a/b/1/c")).toBe(2);
    expect(resolvePointer(doc, "/a/b/0")).toEqual({ c: 1 });
    expect(resolvePointer(doc, "/zero")).toBe(0);
    expect(resolvePointer(doc, "/nul")).toBeNull();
    expect(resolvePointer(doc, "/")).toBe("empty-key");
  });

  test("unescapes ~1 then ~0", () => {
    expect(parsePointer("/x~1y")).toEqual(["x/y"]);
    expect(parsePointer("/m~0n")).toEqual(["m~n"]);
    expect(parsePointer("/~01")).toEqual(["~1"]);
    expect(resolvePointer(doc, "/x~1y")).toBe("slash");
    expect(resolvePointer(doc, "/m~0n")).toBe("tilde");
  });

  test("returns undefined when absent, malformed, or stepping through a scalar", () => {
    expect(resolvePointer(doc, "/a/missing")).toBeUndefined();
    expect(resolvePointer(doc, "/a/b/2")).toBeUndefined();
    expect(resolvePointer(doc, "/a/b/c")).toBeUndefined();
    expect(resolvePointer(doc, "/a/b/01")).toBeUndefined();
    expect(resolvePointer(doc, "/a/b/-")).toBeUndefined();
    expect(resolvePointer(doc, "/zero/x")).toBeUndefined();
    expect(resolvePointer(doc, "a/b")).toBeUndefined();
    expect(resolvePointer(doc, 7)).toBeUndefined();
    expect(resolvePointer(undefined, "/a")).toBeUndefined();
    expect(parsePointer("a")).toBeNull();
  });

  test("resolveSchemaPointer walks properties and items, and unescapes too", () => {
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "/plan/0/criteria/3/text")).toEqual({ type: "string" });
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "/plan/-/issueId")).toEqual({ type: "string" });
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "/a~1b")).toEqual({ type: "string" });
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "/t~0e")).toEqual({ type: "string" });
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "")).toBe(OUTPUT_SCHEMA);
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "/plan/issueId")).toBeUndefined();
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "/summary/x")).toBeUndefined();
    expect(resolveSchemaPointer(OUTPUT_SCHEMA, "nope")).toBeUndefined();
  });
});

describe("committed views fit their agents' output schemas (drift gate, design §2.3)", () => {
  const agentsDir = path.join(RUNTIME_ROOT, "agents");
  const viewFiles = readdirSync(agentsDir)
    .filter((n) => n.endsWith(".view.json"))
    .sort();

  test("the first two views ship with the contract (§2.5)", () => {
    expect(viewFiles).toEqual(expect.arrayContaining(["merge-scan.view.json", "triage-scan.view.json"]));
  });

  for (const name of viewFiles) {
    test(`agents/${name} resolves every pointer against its output schema`, () => {
      const defFile = path.join(agentsDir, name.replace(/\.view\.json$/, ".json"));
      const def = JSON.parse(readFileSync(defFile, "utf8"));
      const outputSchema = JSON.parse(readFileSync(path.join(RUNTIME_ROOT, def.output_schema), "utf8"));
      const view = JSON.parse(readFileSync(path.join(agentsDir, name), "utf8"));
      expect(validateArtifactView(view, outputSchema)).toEqual({ valid: true, errors: [] });
    });
  }

  test("triage-scan and merge-scan views carry the hints the operator reads first", () => {
    const triage = JSON.parse(readFileSync(path.join(agentsDir, "triage-scan.view.json"), "utf8"));
    expect(triage.summary).toBe("/summary");
    expect(triage.status.path).toBe("/recommendation");
    const plan = triage.sections.find((s) => s.path === "/plan");
    expect(plan.as).toBe("table");
    expect(plan.groupBy).toBe("action");
    expect(plan.formats.issueId).toBe("issue");
    expect(plan.expand).toEqual(["detail", "ownedPaths", "verificationCommand", "acceptanceCriteria"]);

    const merge = JSON.parse(readFileSync(path.join(agentsDir, "merge-scan.view.json"), "utf8"));
    expect(merge.status.path).toBe("/recommendation");
    for (const p of ["/plan", "/fix", "/escalate"]) {
      const section = merge.sections.find((s) => s.path === p);
      expect(section.as).toBe("table");
      expect(section.formats.pr).toBe("pr");
      expect(section.columns).toContain("pr");
    }
    expect(merge.sections.find((s) => s.path === "/escalate").columns).toContain("reason");
    expect(merge.sections.find((s) => s.path === "/plan").columns).toContain("reason");
    expect(merge.sections.find((s) => s.path === "/fix").columns).toContain("finding");
  });
});
