import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HARNES_BLOCK,
  ensureHarnessGitignore,
  harnessGitignoreIsCurrent,
  spliceHarnessGitignore,
} from "./factory-gitignore.mjs";

test("appends harness block to empty gitignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-gitignore-"));
  writeFileSync(path.join(dir, ".gitignore"), "", "utf8");
  expect(ensureHarnessGitignore(dir)).toBe("added");
  const out = readFileSync(path.join(dir, ".gitignore"), "utf8");
  expect(out).toContain(".claude/commands/factory-*.md");
  expect(harnessGitignoreIsCurrent(out)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("is idempotent when block already present", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-gitignore-"));
  writeFileSync(path.join(dir, ".gitignore"), `${HARNES_BLOCK}\n`, "utf8");
  expect(ensureHarnessGitignore(dir)).toBe("ok");
  rmSync(dir, { recursive: true, force: true });
});

test("accepts legalease-style hand-written rule as current", () => {
  const body = ".env\n.claude/commands/factory-*.md\n";
  expect(harnessGitignoreIsCurrent(body)).toBe(true);
});

test("splice replaces stale marked block", () => {
  const stale = `# FACTORY:HARNES:BEGIN\n.old\n# FACTORY:HARNES:END\n`;
  const out = spliceHarnessGitignore(stale);
  expect(out).toContain(".cursor/commands/factory-*.md");
  expect(harnessGitignoreIsCurrent(out)).toBe(true);
});

// The block above is a promise the index can silently break: gitignore does
// not untrack what is already staged. Twelve of these symlinks were committed
// before the block existed, with macOS-absolute targets, so every non-macOS
// checkout got a dangling link that `factory emit --link-repos` could only fix
// by leaving the tree permanently dirty — and headless dispatch, which reads
// <repo>/.claude/commands directly, could not resolve /factory-* at all
// (WM-652, same failure shape as OPS-69). Nothing else notices the drift.
test("this repo tracks no factory command symlinks", () => {
  const root = path.resolve(import.meta.dir, "..");
  const tracked = execFileSync("git", ["ls-files", "--", ".claude/commands", ".cursor/commands"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  expect(tracked).toBe("");
});
