import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNotifyRefs, safeRepos } from "./notify-refs.mjs";

const repos = new Map([
  ["factory", { github: "watt-mind/factory" }],
  ["bj29", { github: "watt-mind/bakonszegi-coaching" }],
]);

const parse = (prefix) => parseNotifyRefs(prefix, { repos });

test("parses Linear issue, PR, and documented repo/run notification forms", () => {
  expect(parse("PR#42 (WM-7)")).toEqual({
    issue: "WM-7",
    pr: "PR#42",
  });
  expect(parse("factory run run_123")).toEqual({
    repo: "factory",
    runId: "run_123",
  });
  expect(parse("factory")).toEqual({ repo: "factory" });
  expect(parse("merge factory")).toEqual({ repo: "factory" });
});

test("separates a configured GitHub issue from its repository ref", () => {
  expect(parse("watt-mind/factory#1")).toEqual({
    issue: "watt-mind/factory#1",
    repo: "factory",
  });
});

test("preserves an unconfigured GitHub repository slug", () => {
  expect(parse("other-owner/other-repo#2")).toEqual({
    issue: "other-owner/other-repo#2",
    repo: "other-owner/other-repo",
  });
});

test("expands a bare GitHub issue only when its repository is inferable", () => {
  expect(parse("factory #3")).toEqual({
    issue: "watt-mind/factory#3",
    repo: "factory",
  });
  expect(parse("#3")).toEqual({});
});

test("fails open to an empty registry when no repos config is available", () => {
  expect(parseNotifyRefs("watt-mind/factory#1", { repos: new Map() })).toEqual({
    issue: "watt-mind/factory#1",
    repo: "watt-mind/factory",
  });
  expect(parseNotifyRefs("factory #3", { repos: new Map() })).toEqual({
    repo: "factory",
  });
});

test("a throwing repos loader does not abort notification parsing", () => {
  const load = () => {
    throw new Error("no repos config");
  };
  expect(safeRepos({ load })).toEqual(new Map());
  expect(
    parseNotifyRefs("watt-mind/factory#1", { repos: safeRepos({ load }) }),
  ).toEqual({ issue: "watt-mind/factory#1", repo: "watt-mind/factory" });
});

test("factory notify posts separate GitHub issue and repository refs", async () => {
  let payload;
  // Point the CLI at a fixture registry so the assertion does not depend on
  // the ambient config/repos.yaml of whichever checkout runs the tests.
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "notify-refs-"));
  mkdirSync(path.join(fixtureRoot, "config"));
  writeFileSync(
    path.join(fixtureRoot, "config", "repos.yaml"),
    "repos:\n  - { name: factory, path: /nonexistent, github: watt-mind/factory }\n",
  );
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      payload = await request.json();
      return Response.json({ delivery: { ok: true } }, { status: 201 });
    },
  });
  try {
    const child = Bun.spawn({
      cmd: [
        "bash",
        path.resolve(import.meta.dir, "../bin/factory"),
        "notify",
        "BLOCKED",
        "watt-mind/factory#1:",
        "x",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_EVENT_PORT: String(server.port),
        FACTORY_REPOS_ROOT: fixtureRoot,
      },
    });
    expect(await child.exited).toBe(0);
    expect(payload).toMatchObject({
      refs: { issue: "watt-mind/factory#1", repo: "factory" },
    });
  } finally {
    server.stop(true);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
