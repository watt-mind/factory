import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const r = run(
    "# Please enter the commit message for your changes.\n# Lines starting with '#' will be ignored.\nfix(scope): thing (WM-1)\n#\n# On branch develop\n",
  );
  expect(r.status).toBe(0);
});

test("every allowed type is accepted with a ticket ref", () => {
  const types = [
    "feat",
    "fix",
    "chore",
    "docs",
    "test",
    "refactor",
    "perf",
    "ci",
    "build",
    "style",
    "revert",
    "sec",
    "maint",
    "ui",
    "ui-ux",
    "spike",
    "epic",
  ];
  for (const type of types) {
    const r = run(`${type}: something (WM-1)\n`);
    expect(r.status).toBe(0);
  }
});

// WM-1011: the hook no longer enumerates workspace team keys, so an
// unrecognised-but-well-formed prefix like (XX-1) is now ACCEPTED on purpose —
// which tracker a contributor uses is not this workspace's business. What
// still gets rejected is anything not shaped like a ticket reference at all.
test("a malformed ticket reference is still rejected", () => {
  for (const subject of [
    "fix(scope): thing (lower-1)", // not uppercase
    "fix(scope): thing (TOOLONGPREFIX-1)", // over 5 letters
    "fix(scope): thing (WM-)", // no number
    "fix(scope): thing (123)", // no prefix and no #
    "fix(scope): thing WM-1", // not parenthesised
  ]) {
    const r = run(`${subject}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing a ticket reference");
  }
});

test("the default accepts any 2-5 letter tracker prefix, naming no workspace", () => {
  for (const ref of ["(WM-1)", "(XX-1)", "(ENG-42)", "(ABCDE-7)"]) {
    expect(run(`fix(scope): thing ${ref}\n`).status).toBe(0);
  }
});

test("the default accepts the GitHub issue form", () => {
  expect(run("fix(scope): thing (#123)\n").status).toBe(0);
});

test("both forms are accepted at once, for the cutover window", () => {
  // WM-1006 Phase 3 has a period where historical WM-* refs and new #123 refs
  // are both live. Neither should need a hook edit.
  expect(run("fix(scope): historical (WM-999)\n").status).toBe(0);
  expect(run("fix(scope): new work (#12)\n").status).toBe(0);
});

test("no private team key appears in the script or tracked example config", () => {
  const script = readFileSync(SCRIPT, "utf8");
  expect(script).not.toContain("CLNT");
  expect(script).not.toMatch(/\(WM\|OPS/);
  const example = readFileSync(
    path.resolve(import.meta.dir, "..", "config", "policy.example.yaml"),
    "utf8",
  );
  expect(example).not.toContain("CLNT");
});

test("ticketPatterns in policy.yaml replaces the default", () => {
  const cfg = path.join(WORK_DIR, "policy-override.yaml");
  writeFileSync(
    cfg,
    "merge:\n  max_fix_rounds: 2\ncommitMsg:\n  ticketPatterns:\n    - '\\(GH-[0-9]+\\)'\nconcurrency:\n  max_concurrent_merges: 1\n",
  );
  const env = { FACTORY_COMMIT_MSG_CONFIG: cfg };
  expect(run("fix(s): thing (GH-9)\n", env).status).toBe(0);
  // the built-in shapes are replaced, not merged
  expect(run("fix(s): thing (WM-123)\n", env).status).toBe(1);
  expect(run("fix(s): thing (#123)\n", env).status).toBe(1);
  // the error message reports what is actually enforced
  expect(run("fix(s): thing\n", env).stderr).toContain("(GH-123)");
});

test("multiple configured patterns are all accepted", () => {
  const cfg = path.join(WORK_DIR, "policy-multi.yaml");
  writeFileSync(
    cfg,
    "commitMsg:\n  ticketPatterns:\n    - '\\(GH-[0-9]+\\)'\n    - '\\(#[0-9]+\\)'\n",
  );
  const env = { FACTORY_COMMIT_MSG_CONFIG: cfg };
  expect(run("fix(s): thing (GH-9)\n", env).status).toBe(0);
  expect(run("fix(s): thing (#9)\n", env).status).toBe(0);
  expect(run("fix(s): thing (WM-9)\n", env).status).toBe(1);
});

test("a missing or stanza-less config falls back to the default", () => {
  const missing = {
    FACTORY_COMMIT_MSG_CONFIG: path.join(WORK_DIR, "nope.yaml"),
  };
  expect(run("fix(s): thing (WM-1)\n", missing).status).toBe(0);
  expect(run("fix(s): thing (#1)\n", missing).status).toBe(0);

  const cfg = path.join(WORK_DIR, "policy-nostanza.yaml");
  writeFileSync(cfg, "merge:\n  max_fix_rounds: 2\n");
  const env = { FACTORY_COMMIT_MSG_CONFIG: cfg };
  // "no opinion" must not mean "accept nothing" — a config typo must not lock
  // every commit out of the repo.
  expect(run("fix(s): thing (WM-1)\n", env).status).toBe(0);
  expect(run("fix(s): thing\n", env).status).toBe(1);
});

test("FACTORY_NO_TICKET and the exemptions survive the rewrite", () => {
  expect(run("fix(s): thing\n", { FACTORY_NO_TICKET: "1" }).status).toBe(0);
  for (const subject of [
    "Merge branch develop",
    'Revert "fix(s): thing (WM-1)"',
    "fixup! fix(s): thing",
    "squash! fix(s): thing",
    "build(deps): bump thing",
  ]) {
    expect(run(`${subject}\n`).status).toBe(0);
  }
  expect(run("whatever\n", { GIT_AUTHOR_NAME: "dependabot[bot]" }).status).toBe(
    0,
  );
});
