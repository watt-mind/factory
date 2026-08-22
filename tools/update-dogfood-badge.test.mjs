/**
 * bun test — dogfood-in-public badge metrics (WM-958).
 *
 * Window math and the Fixes-ticket heuristic are the whole product: a badge
 * that counts human-only PRs, or that silently includes merges from 31 days
 * ago, is a trust-signal lie. Tests drive a memory forge; they never talk to
 * GitHub.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, test } from "bun:test";
import { memoryForge } from "../lib/forge/memory.mjs";
import {
  WINDOW_DAYS,
  BADGE_START,
  BADGE_END,
  isAutonomousPr,
  inRollingWindow,
  countAutonomousMerges,
  applyBadgeToReadme,
  renderBadgeBlock,
  shieldsEndpointPayload,
  shieldsBadgeUrl,
  collectMetrics,
  parseCliArgs,
  runUpdate,
} from "./update-dogfood-badge.mjs";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const dayAgo = (n) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function pr({ number, body, mergedAt, title = "feat: x" }) {
  return {
    number,
    title,
    body,
    mergedAt,
    state: "MERGED",
    url: `https://github.com/watt-mind/factory/pull/${number}`,
    headRefName: `feat/WM-${number}-x`,
  };
}

function forgeWith(prs) {
  return memoryForge({
    repos: { "watt-mind/factory": { prs } },
  });
}

// -------------------------------------------------------- heuristic ---
test("Fixes <TICKET> in the body is autonomous", () => {
  expect(isAutonomousPr({ body: "Fixes WM-958\n\nrun:abc" })).toBe(true);
  expect(isAutonomousPr({ body: "See also Fixes CLNT-12." })).toBe(true);
});

test("human or protocol-less bodies are not autonomous", () => {
  expect(isAutonomousPr({ body: "this PR fixes a bug" })).toBe(false);
  expect(isAutonomousPr({ body: "Fixes wm-958" })).toBe(false);
  expect(isAutonomousPr({ body: "" })).toBe(false);
  expect(isAutonomousPr({})).toBe(false);
  expect(
    isAutonomousPr({ title: "Fixes WM-958", body: "no ticket line" }),
  ).toBe(false);
});

// -------------------------------------------------------- window ---
test("rolling window includes a merge 29 days ago and excludes 31", () => {
  expect(inRollingWindow({ mergedAt: dayAgo(0) }, NOW)).toBe(true);
  expect(inRollingWindow({ mergedAt: dayAgo(29) }, NOW)).toBe(true);
  expect(inRollingWindow({ mergedAt: dayAgo(30) }, NOW)).toBe(true);
  expect(inRollingWindow({ mergedAt: dayAgo(31) }, NOW)).toBe(false);
});

test("missing or future mergedAt is outside the window", () => {
  expect(inRollingWindow({ mergedAt: null }, NOW)).toBe(false);
  expect(inRollingWindow({}, NOW)).toBe(false);
  expect(inRollingWindow({ mergedAt: "2026-09-01T00:00:00.000Z" }, NOW)).toBe(
    false,
  );
  expect(inRollingWindow({ mergedAt: "not-a-date" }, NOW)).toBe(false);
});

test("countAutonomousMerges applies both filters", () => {
  const prs = [
    pr({ number: 1, body: "Fixes WM-1", mergedAt: dayAgo(1) }),
    pr({ number: 2, body: "human review notes", mergedAt: dayAgo(1) }),
    pr({ number: 3, body: "Fixes WM-3", mergedAt: dayAgo(40) }),
    pr({ number: 4, body: "Fixes OPS-9", mergedAt: dayAgo(15) }),
  ];
  expect(countAutonomousMerges(prs, { now: NOW })).toBe(2);
});

// -------------------------------------------------------- README ---
test("applyBadgeToReadme inserts a marker block after the H1", () => {
  const next = applyBadgeToReadme("# factory\n\nA runtime.\n", 7);
  expect(next).toContain(BADGE_START);
  expect(next).toContain(BADGE_END);
  expect(next).toContain(shieldsBadgeUrl(7));
  expect(next.startsWith("# factory\n")).toBe(true);
  expect(next).toContain("A runtime.");
});

test("applyBadgeToReadme replaces an existing marker block in place", () => {
  const first = applyBadgeToReadme("# factory\n\nbody\n", 1);
  const second = applyBadgeToReadme(first, 9);
  expect(second.split(BADGE_START).length).toBe(2);
  expect(second).toContain(shieldsBadgeUrl(9));
  expect(second).not.toContain(shieldsBadgeUrl(1));
});

test("applyBadgeToReadme is idempotent for the same count", () => {
  const once = applyBadgeToReadme("# factory\n\nbody\n", 4);
  expect(applyBadgeToReadme(once, 4)).toBe(once);
});

test("the rewritten README survives prettier untouched (WM-1031)", async () => {
  const prettier = (await import("prettier")).default;
  const readme = applyBadgeToReadme(
    "# factory\n\n**A tagline.**\n\nBody paragraph.\n",
    742,
  );
  const options = { ...(await prettier.resolveConfig(import.meta.dir)) };
  expect(
    await prettier.format(readme, { ...options, parser: "markdown" }),
  ).toBe(readme);
});

test("shields payload matches the endpoint schema", () => {
  const payload = shieldsEndpointPayload(12);
  expect(payload).toEqual({
    schemaVersion: 1,
    label: "Maintained by the factory",
    message: "12 PRs merged autonomously this month",
    color: "0B6E4F",
  });
  expect(shieldsBadgeUrl(12)).toContain("img.shields.io/static/v1");
  expect(renderBadgeBlock(12)).toContain("watt-mind/factory/pulls");
});

// -------------------------------------------------------- forge ---
test("collectMetrics reads merged PRs from the forge and counts the window", () => {
  const forge = forgeWith([
    pr({ number: 10, body: "Fixes WM-10", mergedAt: dayAgo(2) }),
    pr({
      number: 11,
      body: "Fixes WM-11",
      mergedAt: dayAgo(WINDOW_DAYS + 2),
    }),
    pr({ number: 12, body: "no protocol", mergedAt: dayAgo(2) }),
    {
      number: 13,
      title: "open",
      body: "Fixes WM-13",
      state: "OPEN",
      mergedAt: null,
    },
  ]);
  const metrics = collectMetrics(forge, "watt-mind/factory", { now: NOW });
  expect(metrics.autonomousMerges).toBe(1);
  expect(metrics.mergedInWindow).toBe(2);
  expect(metrics.scanned).toBe(3); // memory forge drops OPEN when state=merged
  expect(metrics.windowDays).toBe(30);
  expect(metrics.repo).toBe("watt-mind/factory");
});

test("collectMetrics refuses a truncated window rather than under-count", () => {
  const forge = forgeWith([
    pr({ number: 1, body: "Fixes WM-1", mergedAt: dayAgo(1) }),
    pr({ number: 2, body: "Fixes WM-2", mergedAt: dayAgo(1) }),
  ]);
  expect(() =>
    collectMetrics(forge, "watt-mind/factory", { now: NOW, limit: 2 }),
  ).toThrow(/--limit of 2/);
});

test("parseCliArgs accepts dry-run, json, repo, readme, limit", () => {
  expect(
    parseCliArgs([
      "--dry-run",
      "--json",
      "--repo",
      "acme/x",
      "--readme",
      "docs/README.md",
      "--limit",
      "10",
    ]),
  ).toEqual({
    dryRun: true,
    json: true,
    help: false,
    repo: "acme/x",
    readme: "docs/README.md",
    limit: 10,
  });
});

test("parseCliArgs rejects unknown flags", () => {
  expect(() => parseCliArgs(["--commit"])).toThrow(/unknown argument/);
});

// -------------------------------------------------------- runUpdate ---
test("--dry-run prints metrics and does not write README", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dogfood-badge-"));
  const readme = path.join(dir, "README.md");
  const original = "# factory\n\nhello\n";
  writeFileSync(readme, original);
  let out = "";
  const result = runUpdate({
    argv: ["--dry-run", "--readme", readme, "--repo", "watt-mind/factory"],
    forge: forgeWith([
      pr({ number: 20, body: "Fixes WM-20", mergedAt: dayAgo(3) }),
      pr({ number: 21, body: "Fixes WM-21", mergedAt: dayAgo(3) }),
    ]),
    now: NOW,
    cwd: dir,
    stdout: { write: (s) => (out += s) },
    stderr: { write: () => {} },
  });
  expect(result.dryRun).toBe(true);
  expect(result.count).toBe(2);
  expect(readFileSync(readme, "utf8")).toBe(original);
  expect(out).toContain("autonomousMerges: 2");
  expect(out).toContain(BADGE_START);
});

test("default path writes the README badge and --json emits the endpoint", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dogfood-badge-"));
  const readme = path.join(dir, "README.md");
  writeFileSync(readme, "# factory\n\nhello\n");
  let jsonOut = "";
  const written = runUpdate({
    argv: ["--readme", readme, "--repo", "watt-mind/factory"],
    forge: forgeWith([
      pr({ number: 30, body: "Fixes WM-30", mergedAt: dayAgo(1) }),
    ]),
    now: NOW,
    cwd: dir,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  expect(written.changed).toBe(true);
  expect(existsSync(readme)).toBe(true);
  const after = readFileSync(readme, "utf8");
  expect(after).toContain(shieldsBadgeUrl(1));

  const jsonResult = runUpdate({
    argv: [
      "--json",
      "--dry-run",
      "--readme",
      readme,
      "--repo",
      "watt-mind/factory",
    ],
    forge: forgeWith([
      pr({ number: 30, body: "Fixes WM-30", mergedAt: dayAgo(1) }),
    ]),
    now: NOW,
    cwd: dir,
    stdout: { write: (s) => (jsonOut += s) },
    stderr: { write: () => {} },
  });
  const parsed = JSON.parse(jsonOut);
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.count).toBe(1);
  expect(parsed.message).toBe("1 PRs merged autonomously this month");
  expect(jsonResult.dryRun).toBe(true);
  // dry-run after a write must not revert the file
  expect(readFileSync(readme, "utf8")).toBe(after);
});
