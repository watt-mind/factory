import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const SCRIPT = path.resolve(import.meta.dir, "check-commit-msg.sh");

const WORK_DIR = mkdtempSync(path.join(tmpdir(), "wm-609-check-commit-msg-"));
let fileCount = 0;

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

function run(message, extraEnv = {}) {
  const file = path.join(WORK_DIR, `msg-${fileCount++}.txt`);
  writeFileSync(file, message);
  const result = Bun.spawnSync({
    cmd: ["bash", SCRIPT, file],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("valid conventional commit with ticket ref passes", () => {
  const r = run("fix(scope): thing (WM-1)\n");
  expect(r.status).toBe(0);
});

test("missing type is rejected", () => {
  const r = run("random text (WM-1)\n");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("does not match conventional commit format");
});

test("missing ticket ref is rejected", () => {
  const r = run("fix: thing\n");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("missing a ticket reference");
  expect(r.stderr).toContain("FACTORY_NO_TICKET=1");
});

test("missing ticket ref passes with FACTORY_NO_TICKET=1 and warns on stderr", () => {
  const r = run("fix: thing\n", { FACTORY_NO_TICKET: "1" });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("warning");
  expect(r.stderr).toContain("FACTORY_NO_TICKET=1");
});

test("merge commit is skipped", () => {
  const r = run("Merge branch 'feature/x' into develop\n");
  expect(r.status).toBe(0);
});

test("revert commit is skipped", () => {
  const r = run('Revert "fix(scope): thing (WM-1)"\n');
  expect(r.status).toBe(0);
});

test("fixup and squash commits are skipped", () => {
  expect(run("fixup! fix(scope): thing (WM-1)\n").status).toBe(0);
  expect(run("squash! fix(scope): thing (WM-1)\n").status).toBe(0);
});

test("dependabot build(deps commit is skipped by message", () => {
  const r = run("build(deps): bump lodash from 4.17.20 to 4.17.21\n");
  expect(r.status).toBe(0);
});

test("dependabot author is skipped even without a build(deps) subject", () => {
  const r = run("chore: bump some dep\n", {
    GIT_AUTHOR_NAME: "dependabot[bot]",
    GIT_AUTHOR_EMAIL: "49699333+dependabot[bot]@users.noreply.github.com",
  });
  expect(r.status).toBe(0);
});

test("scope with slash and dot characters is accepted", () => {
  const r = run("chore(event-runtime/web): x (OPS-12)\n");
  expect(r.status).toBe(0);
});

test("breaking-change marker before the colon is accepted", () => {
  const r = run("feat(api)!: x (WM-2)\n");
  expect(r.status).toBe(0);
});

test("comment lines above the subject are skipped", () => {
  const r = run("# Please enter the commit message for your changes.\n# Lines starting with '#' will be ignored.\nfix(scope): thing (WM-1)\n#\n# On branch develop\n");
  expect(r.status).toBe(0);
});

test("every allowed type is accepted with a ticket ref", () => {
  const types = ["feat", "fix", "chore", "docs", "test", "refactor", "perf", "ci", "build", "style", "revert", "sec", "maint", "ui", "ui-ux", "spike", "epic"];
  for (const type of types) {
    const r = run(`${type}: something (WM-1)\n`);
    expect(r.status).toBe(0);
  }
});

test("unknown ticket prefix is rejected", () => {
  const r = run("fix(scope): thing (XX-1)\n");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("missing a ticket reference");
});
