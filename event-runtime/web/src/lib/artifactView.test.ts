import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactView } from "../types";
import {
  formatBytes,
  formatForColumn,
  formatValue,
  githubOf,
  groupRows,
  headerFor,
  inputViewOf,
  parsePointer,
  resolvePointer,
  resolveRelative,
  sectionsFor,
  toneFor,
  viewApplies,
} from "./artifactView";

const AGENTS = path.resolve(import.meta.dir, "../../../agents");
const readView = (name: string): ArtifactView =>
  JSON.parse(readFileSync(path.join(AGENTS, `${name}.view.json`), "utf8"));

const triageView = readView("triage-scan");
const mergeView = readView("merge-scan");

const triageArtifact = {
  recommendation: "TRIAGE",
  repo: "factory",
  summary: "Three issues moved; one needs a human.",
  plan: [
    { issueId: "WM-1", action: "label-agent-ready", reason: "Complete spec." },
    {
      issueId: "WM-2",
      action: "needs-human",
      reason: "Scope unclear.",
      detail: "## Acceptance Criteria\n- x",
    },
    {
      issueId: "WM-3",
      action: "label-agent-ready",
      reason: "Ready.",
      ownedPaths: ["a.ts", "b.ts"],
    },
  ],
};

const mergeArtifact = {
  recommendation: "ESCALATE",
  repo: "factory",
  github: "watt-mind/factory",
  base: "develop",
  deployBranch: "main",
  plan: [],
  fix: [
    {
      pr: 12,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      headRef: "feat/x",
      ticket: "WM-12",
      finding: "lint",
      findingHash: "h1",
      round: 1,
      mechanical: true,
      withinOwnedPaths: false,
      ownedPaths: ["src/a.ts"],
    },
  ],
  escalate: [
    {
      pr: 471,
      ticket: "WM-210",
      headSha: "c".repeat(40),
      reason: "Draft hold.",
    },
  ],
  summary: "One escalation.",
};

describe("resolvePointer (RFC 6901, mirrors lib/artifact-view.mjs)", () => {
  test("walks objects and arrays, unescapes ~0/~1, and returns undefined for anything absent", () => {
    const doc = { a: { "b/c": [10, { "~": 1 }] }, "": "empty" };
    expect(resolvePointer(doc, "")).toBe(doc);
    expect(resolvePointer(doc, "/a/b~1c/0")).toBe(10);
    expect(resolvePointer(doc, "/a/b~1c/1/~0")).toBe(1);
    expect(resolvePointer(doc, "/")).toBe("empty");
    expect(resolvePointer(doc, "/a/b~1c/2")).toBeUndefined();
    expect(resolvePointer(doc, "/a/b~1c/01")).toBeUndefined();
    expect(resolvePointer(doc, "/a/b~1c/-")).toBeUndefined();
    expect(resolvePointer(doc, "/nope")).toBeUndefined();
    expect(resolvePointer(doc, "a")).toBeUndefined();
    expect(resolvePointer(doc, 42)).toBeUndefined();
    expect(resolvePointer("scalar", "/x")).toBeUndefined();
    expect(parsePointer("/x/y")).toEqual(["x", "y"]);
    expect(parsePointer("x")).toBeNull();
  });

  test("resolveRelative takes plain names and slash paths, like the runtime's relativeNode", () => {
    const item = { a: { b: [1, 2] }, "": "blank" };
    expect(resolveRelative(item, "a/b/1")).toBe(2);
    expect(resolveRelative(item, "/a/b/0")).toBe(1);
    expect(resolveRelative(item, "a")).toEqual({ b: [1, 2] });
    expect(resolveRelative(item, "")).toBe(item);
    expect(resolveRelative(item, "zzz")).toBeUndefined();
  });
});

describe("formatValue", () => {
  test("issue / pr / run become chips; pr links only when the artifact names its repo", () => {
    expect(formatValue("WM-455", "issue")).toEqual({
      kind: "chip",
      chip: "issue",
      id: "WM-455",
      text: "WM-455",
      href: "https://linear.app/watt-mind/issue/WM-455",
    });
    expect(formatValue(471, "pr", { github: "watt-mind/factory" })).toEqual({
      kind: "chip",
      chip: "pr",
      id: "471",
      text: "#471",
      href: "https://github.com/watt-mind/factory/pull/471",
    });
    expect(formatValue("#9", "pr")).toMatchObject({
      kind: "chip",
      text: "#9",
      href: null,
    });
    expect(
      formatValue("run_44fa5716-0304-49b1-8b65-a45500d0d784", "run"),
    ).toMatchObject({
      kind: "chip",
      chip: "run",
      id: "run_44fa5716-0304-49b1-8b65-a45500d0d784",
      text: "run_44fa5716",
    });
  });

  test("state / sha / url / duration / datetime / bytes / count use the app's formatters", () => {
    expect(formatValue("COMPLETED", "state")).toEqual({
      kind: "state",
      state: "COMPLETED",
    });
    expect(formatValue("c".repeat(40), "sha")).toEqual({
      kind: "text",
      text: "c".repeat(12),
      mono: true,
      title: "c".repeat(40),
    });
    expect(formatValue("https://x.test/a", "url")).toEqual({
      kind: "link",
      href: "https://x.test/a",
      text: "https://x.test/a",
    });
    expect(formatValue(90, "duration")).toMatchObject({
      kind: "text",
      text: "1:30",
      title: "90s",
    });
    expect(formatValue(1536, "bytes")).toMatchObject({
      kind: "text",
      text: "1.5 KB",
    });
    expect(formatValue(1234567, "count")).toMatchObject({
      kind: "text",
      text: (1234567).toLocaleString(),
      mono: true,
    });
    const dt = formatValue("2026-08-17T10:00:00.000Z", "datetime");
    expect(dt.kind).toBe("text");
    if (dt.kind === "text") expect(dt.title).toBe("2026-08-17T10:00:00.000Z");
    expect(formatValue("not a date", "datetime")).toEqual({
      kind: "text",
      text: "not a date",
      mono: false,
    });
  });

  test("no format: prose is proportional, identifiers and numbers are mono, nested values are json, absent is empty", () => {
    expect(formatValue("Scope unclear.")).toEqual({
      kind: "text",
      text: "Scope unclear.",
      mono: false,
    });
    expect(formatValue("feat/x")).toEqual({
      kind: "text",
      text: "feat/x",
      mono: true,
    });
    expect(formatValue(true)).toEqual({
      kind: "text",
      text: "true",
      mono: true,
    });
    expect(formatValue({ a: 1 })).toEqual({ kind: "json", value: { a: 1 } });
    expect(formatValue(undefined)).toEqual({ kind: "empty" });
    expect(formatValue(null, "issue")).toEqual({ kind: "empty" });
    expect(formatValue("")).toEqual({ kind: "empty" });
  });

  test("formatBytes keeps the Artifacts view's units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 ** 2)).toBe("3.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });
});

describe("toneFor / githubOf", () => {
  test("matches by string form, ignores unknown tones and non-maps", () => {
    const map = { true: "ok", false: "warn", weird: "purple" };
    expect(toneFor(true, map)).toBe("ok");
    expect(toneFor("false", map)).toBe("warn");
    expect(toneFor("weird", map)).toBeUndefined();
    expect(toneFor("x", map)).toBeUndefined();
    expect(toneFor("x", "ok")).toBeUndefined();
    expect(toneFor(null, map)).toBeUndefined();
  });
  test("githubOf accepts only owner/repo at the root", () => {
    expect(githubOf(mergeArtifact)).toBe("watt-mind/factory");
    expect(githubOf({ github: "not a repo" })).toBeNull();
    expect(githubOf(triageArtifact)).toBeNull();
    expect(githubOf("nope")).toBeNull();
  });
});

describe("headerFor", () => {
  test("summary prose, status with the last pointer token as label, title from the view then the schema", () => {
    const h = headerFor(triageView, triageArtifact, { title: "schema title" });
    expect(h.title).toBe("Triage plan");
    expect(h.summary).toBe("Three issues moved; one needs a human.");
    expect(h.status).toEqual({
      label: "recommendation",
      value: "TRIAGE",
      tone: "ok",
    });
    const bare = headerFor(
      { schemaVersion: "factory.artifact-view/v1", sections: [] },
      {},
      { title: "schema title" },
    );
    expect(bare).toEqual({
      title: "schema title",
      summary: null,
      status: null,
    });
    const noStatus = headerFor(mergeView, { summary: "s" });
    expect(noStatus.status).toBeNull();
    expect(noStatus.summary).toBe("s");
  });
});

describe("sectionsFor with the shipped triage-scan view", () => {
  test("renders the plan as a table grouped by action with issue chips, tones, and expand cells", () => {
    const sections = sectionsFor(triageView, triageArtifact);
    expect(sections.map((s) => s.as)).toEqual(["table", "keyvalue"]);
    const table = sections[0];
    if (table.as !== "table") throw new Error("expected table");
    expect(table.label).toBe("Plan");
    expect(table.columns).toEqual(["issueId", "action", "reason"]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0].cells[0].value).toMatchObject({
      kind: "chip",
      chip: "issue",
      id: "WM-1",
    });
    expect(table.rows[0].cells[1].tone).toBe("ok");
    expect(table.rows[1].cells[1].tone).toBe("warn");
    expect(table.rows[0].expand).toEqual([]);
    expect(table.rows[1].expand.map((c) => c.key)).toEqual(["detail"]);
    expect(table.rows[2].expand[0]).toMatchObject({
      key: "ownedPaths",
      value: { kind: "json", value: ["a.ts", "b.ts"] },
    });
    expect(table.hasExpand).toBe(true);
    // Grouped in first-seen order, group tone from the column's tone map.
    expect(table.groups?.map((g) => [g.label, g.rows.length, g.tone])).toEqual([
      ["label-agent-ready", 2, "ok"],
      ["needs-human", 1, "warn"],
    ]);
    // Rows keep their source index across grouping so React keys stay stable.
    expect(table.groups?.[0].rows.map((r) => r.index)).toEqual([0, 2]);

    const repo = sections[1];
    if (repo.as !== "keyvalue") throw new Error("expected keyvalue");
    expect(repo.entries).toEqual([
      {
        key: "Repo",
        value: { kind: "text", text: "factory", mono: true },
        tone: undefined,
      },
    ]);
  });

  test("a section whose pointer is absent in this artifact is dropped, not invented", () => {
    const sections = sectionsFor(triageView, {
      recommendation: "NOOP",
      summary: "Nothing to do.",
      repo: "factory",
    });
    expect(sections.map((s) => s.as)).toEqual(["keyvalue"]);
    expect(sectionsFor(triageView, { plan: "not-an-array" })).toEqual([]);
    expect(sectionsFor(triageView, null)).toEqual([]);
  });

  test("groupRows parks rows without the property under — at the end", () => {
    const sections = sectionsFor(triageView, {
      plan: [
        { issueId: "WM-9", reason: "r" },
        { issueId: "WM-8", action: "move-to-todo", reason: "r" },
      ],
    });
    const table = sections[0];
    if (table.as !== "table") throw new Error("expected table");
    expect(table.groups?.map((g) => g.label)).toEqual(["move-to-todo", "—"]);
    expect(groupRows(table.rows, "action").map((g) => g.rows.length)).toEqual([
      1, 1,
    ]);
  });
});

describe("sectionsFor with the shipped merge-scan view", () => {
  test("empty tables stay (as empty), pr chips link to the artifact's github, keyvalue over the whole artifact keeps only present keys", () => {
    const sections = sectionsFor(mergeView, mergeArtifact);
    expect(sections.map((s) => s.label)).toEqual([
      "Merge",
      "Fix",
      "Escalate",
      "Repo",
    ]);
    const [plan, fix, escalate, repo] = sections;
    if (
      plan.as !== "table" ||
      fix.as !== "table" ||
      escalate.as !== "table" ||
      repo.as !== "keyvalue"
    )
      throw new Error("shape");
    expect(plan.rows).toEqual([]);
    expect(plan.groups).toBeNull();
    expect(fix.rows[0].cells.map((c) => c.key)).toEqual([
      "pr",
      "ticket",
      "round",
      "mechanical",
      "finding",
    ]);
    expect(fix.rows[0].cells[0].value).toMatchObject({
      kind: "chip",
      chip: "pr",
      href: "https://github.com/watt-mind/factory/pull/12",
    });
    expect(fix.rows[0].cells[3]).toMatchObject({
      tone: "ok",
      value: { kind: "text", text: "true" },
    });
    expect(
      fix.rows[0].expand.find((c) => c.key === "withinOwnedPaths")?.tone,
    ).toBe("error");
    expect(
      fix.rows[0].expand.find((c) => c.key === "headSha")?.value,
    ).toMatchObject({ kind: "text", text: "a".repeat(12) });
    expect(escalate.rows[0].cells[1].value).toMatchObject({
      kind: "chip",
      chip: "issue",
      id: "WM-210",
    });
    expect(repo.entries.map((e) => e.key)).toEqual([
      "repo",
      "github",
      "base",
      "deployBranch",
    ]);
  });

  test("viewApplies gates the Artifacts inspector: a merge plan yes, a transcript-shaped object no", () => {
    expect(viewApplies(mergeView, mergeArtifact)).toBe(true);
    expect(viewApplies(mergeView, { type: "assistant", message: "hi" })).toBe(
      false,
    );
    expect(viewApplies(mergeView, "string")).toBe(false);
    expect(viewApplies(null, mergeArtifact)).toBe(false);
    expect(viewApplies(undefined, mergeArtifact)).toBe(false);
  });
});

describe("the other section kinds", () => {
  const view: ArtifactView = {
    schemaVersion: "factory.artifact-view/v1",
    sections: [
      {
        path: "/verdict",
        as: "badge",
        label: "Verdict",
        tone: { PASS: "ok", FAIL: "error" },
      },
      { path: "/log", as: "code", label: "Log", language: "text" },
      { path: "/notes", as: "prose" },
      { path: "/files", as: "list", label: "Files" },
      {
        path: "/checks",
        as: "list",
        label: "Checks",
        itemLabel: "name",
        tone: { name: { lint: "ok" } },
      },
      {
        path: "/count",
        as: "keyvalue",
        label: "Count",
        formats: { "": "count" },
      },
      { path: "/blob", as: "code" },
    ],
  };
  test("badge, code, prose, list (scalars and itemLabel), scalar keyvalue, object code", () => {
    const sections = sectionsFor(view, {
      verdict: "FAIL",
      log: "line 1\nline 2",
      notes: "All good.",
      files: ["a.ts", "b.ts"],
      checks: [{ name: "lint" }, { name: "typecheck" }],
      count: 4200,
      blob: { k: 1 },
    });
    expect(sections).toEqual([
      { as: "badge", label: "Verdict", value: "FAIL", tone: "error" },
      { as: "code", label: "Log", text: "line 1\nline 2", language: "text" },
      { as: "prose", label: undefined, text: "All good." },
      {
        as: "list",
        label: "Files",
        items: [
          {
            key: "0",
            value: { kind: "text", text: "a.ts", mono: true },
            tone: undefined,
          },
          {
            key: "1",
            value: { kind: "text", text: "b.ts", mono: true },
            tone: undefined,
          },
        ],
      },
      {
        as: "list",
        label: "Checks",
        items: [
          {
            key: "0",
            value: { kind: "text", text: "lint", mono: true },
            tone: "ok",
          },
          {
            key: "1",
            value: { kind: "text", text: "typecheck", mono: true },
            tone: undefined,
          },
        ],
      },
      {
        as: "keyvalue",
        label: undefined,
        entries: [
          {
            key: "Count",
            value: { kind: "text", text: (4200).toLocaleString(), mono: true },
            tone: undefined,
          },
        ],
      },
      {
        as: "code",
        label: undefined,
        text: JSON.stringify({ k: 1 }, null, 2),
        language: "json",
      },
    ]);
  });
});

describe("inputViewOf + formatForColumn (WM-897)", () => {
  const dispatchView = readView("dispatch");

  test("inputViewOf lifts the input body so the same renderer can draw spec.input", () => {
    const inputView = inputViewOf(dispatchView);
    expect(inputView).not.toBeNull();
    expect(inputView?.sections?.[0].formats?.ticket).toBe("issue");
    const input = { repo: "factory", ticket: "WM-862" };
    expect(viewApplies(inputView, input)).toBe(true);
    const sections = sectionsFor(inputView!, input);
    expect(sections).toHaveLength(1);
    expect(sections[0].as).toBe("keyvalue");
    if (sections[0].as === "keyvalue") {
      expect(sections[0].entries.map((e) => e.key)).toEqual(["repo", "ticket"]);
      expect(sections[0].entries[1].value).toMatchObject({
        kind: "chip",
        chip: "issue",
        id: "WM-862",
      });
    }
    expect(inputViewOf(triageView)).toBeNull();
    expect(inputViewOf(null)).toBeNull();
  });

  test("formatForColumn reads the closed format from the active view", () => {
    expect(formatForColumn(mergeView, "ticket")).toBe("issue");
    expect(formatForColumn(mergeView, "pr")).toBe("pr");
    expect(formatForColumn(dispatchView, "ticket")).toBe("issue");
    expect(formatForColumn(dispatchView, "repo")).toBe("repo");
    expect(formatForColumn(triageView, "nope")).toBeUndefined();
    expect(formatForColumn(null, "ticket")).toBeUndefined();
  });
});
