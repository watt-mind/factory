import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const UP = path.resolve(import.meta.dir, "worktree-up.sh");
const DOWN = path.resolve(import.meta.dir, "worktree-down.sh");
const COMMON = path.resolve(import.meta.dir, "worktree-common.sh");

function sh(body, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", `source "${COMMON}"\n${body}`],
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

function createTempProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "bun-pkg-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test-pkg", version: "1.0.0" }));
  Bun.spawnSync({ cmd: ["bun", "install"], cwd: dir });
  return dir;
}

function makeTestTicket(prefix = "TEST") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${process.pid}-${rand}`;
}

function makeTestLockDir(prefix = "test-lock") {
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(tmpdir(), `${prefix}-${Date.now()}-${process.pid}-${rand}.lock`);
}

test("locked_bun_install executes real bun install under lock and releases lock", () => {
  const testDir = createTempProject();
  const lockDir = makeTestLockDir("test-lock");
  try {
    const r = sh(`locked_bun_install "${testDir}"`, { FACTORY_LOCK_DIR: lockDir });
    expect(r.status).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("locked_bun_install reclaims stale lock with dead PID and succeeds", () => {
  const testDir = createTempProject();
  const lockDir = makeTestLockDir("test-stale-lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "pid"), "999999");

  try {
    const r = sh(`locked_bun_install "${testDir}"`, { FACTORY_LOCK_DIR: lockDir });
    expect(r.status).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("locked_bun_install reclaims a stale pid-less lock directory", () => {
  const testDir = createTempProject();
  const lockDir = makeTestLockDir("test-pidless-lock");
  mkdirSync(lockDir, { recursive: true });

  try {
    const r = sh(`locked_bun_install "${testDir}"`, {
      FACTORY_LOCK_DIR: lockDir,
      FACTORY_LOCK_STALE_AFTER: "0",
      FACTORY_LOCK_MAX_WAIT: "2",
    });
    expect(r.status).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("locked_bun_install preserves live locks and times out when lock held", () => {
  const testDir = createTempProject();
  const lockDir = makeTestLockDir("test-live-lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "pid"), String(process.pid));

  try {
    const r = sh(`locked_bun_install "${testDir}"`, {
      FACTORY_LOCK_DIR: lockDir,
      FACTORY_LOCK_MAX_WAIT: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("timed out waiting for bun install lock");
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(path.join(lockDir, "pid"))).toBe(true);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("concurrent locked_bun_install invocations serialize without colliding", async () => {
  const testDir1 = createTempProject();
  const testDir2 = createTempProject();
  const lockDir = makeTestLockDir("test-conc-lock");

  try {
    const [p1, p2] = await Promise.all([
      Bun.spawn(["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${testDir1}"`], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_LOCK_DIR: lockDir },
      }).exited,
      Bun.spawn(["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${testDir2}"`], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_LOCK_DIR: lockDir },
      }).exited,
    ]);
    expect(p1).toBe(0);
    expect(p2).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(testDir1, { recursive: true, force: true });
    rmSync(testDir2, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("locked_bun_install restores prior EXIT/INT/TERM traps upon clean return", () => {
  const testDir = createTempProject();
  const lockDir = makeTestLockDir("test-trap-restore");
  try {
    const script = `
      trap 'echo CUSTOM_EXIT_TRIGGERED' EXIT
      trap 'echo CUSTOM_INT_TRIGGERED' INT
      trap 'echo CUSTOM_TERM_TRIGGERED' TERM
      locked_bun_install "${testDir}"
      echo "INSTALL_COMPLETED"
    `;
    const r = sh(script, { FACTORY_LOCK_DIR: lockDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("INSTALL_COMPLETED");
    expect(r.stdout).toContain("CUSTOM_EXIT_TRIGGERED");
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("old holder cleanup preserves a new holder before pid publication", () => {
  const lockDir = makeTestLockDir("test-release-generation");
  mkdirSync(lockDir, { recursive: true });

  try {
    const oldCleanup = sh(`release_bun_install_lock "${lockDir}" "12345"`);
    expect(oldCleanup.status).toBe(0);
    expect(existsSync(lockDir)).toBe(true);

    writeFileSync(path.join(lockDir, "pid"), "67890");
    expect(existsSync(lockDir)).toBe(true);

    const newCleanup = sh(`release_bun_install_lock "${lockDir}" "67890"`);
    expect(newCleanup.status).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("locked_bun_install composes prior INT/TERM/EXIT traps on interruption", async () => {
  for (const { trapName, exitCode } of [
    { trapName: "INT", exitCode: 130 },
    { trapName: "TERM", exitCode: 143 },
  ]) {
    const testDir = createTempProject();
    const lockDir = makeTestLockDir(`test-${trapName.toLowerCase()}-trap`);
    const mockBinDir = mkdtempSync(path.join(tmpdir(), "mock-bun-"));
    const readyFile = path.join(mockBinDir, "ready.txt");

    const mockBun = path.join(mockBinDir, "bun");
    writeFileSync(mockBun, `#!/usr/bin/env bash
if [[ "$1" == "install" ]]; then
  touch "${readyFile}"
  sleep 1
  exit 0
fi
exec bun "$@"
`, { mode: 0o755 });

    try {
      const proc = Bun.spawn([
        "bash",
        "-c",
        `source "${COMMON}"
trap 'echo PRIOR_EXIT_TRIGGERED' EXIT
trap 'echo PRIOR_${trapName}_TRIGGERED' ${trapName}
(
  for _ in {1..200}; do
    if [[ -e "${readyFile}" ]]; then
      kill -${trapName} "$$"
      exit 0
    fi
    sleep 0.01
  done
  echo "timed out waiting for mock bun" >&2
) &
locked_bun_install "${testDir}"`,
      ], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${mockBinDir}${path.delimiter}${process.env.PATH}`,
          FACTORY_LOCK_DIR: lockDir,
        },
      });
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      const [status, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
      expect(stderr).toBe("");
      expect(stdout).toContain(`PRIOR_${trapName}_TRIGGERED`);
      expect(stdout).toContain("PRIOR_EXIT_TRIGGERED");
      expect(status).toBe(exitCode);
      expect(existsSync(readyFile)).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(mockBinDir, { recursive: true, force: true });
    }
  }
});

test("multiple contenders race to reclaim a stale pid-less lock and all succeed", async () => {
  const testDirs = [createTempProject(), createTempProject(), createTempProject(), createTempProject()];
  const lockDir = makeTestLockDir("test-pidless-race");
  mkdirSync(lockDir, { recursive: true });

  try {
    const runContender = (dir) =>
      Bun.spawn(["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${dir}"`], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FACTORY_LOCK_DIR: lockDir,
          FACTORY_LOCK_STALE_AFTER: "0",
          FACTORY_LOCK_MAX_WAIT: "10",
        },
      }).exited;

    const results = await Promise.all(testDirs.map(runContender));
    for (const code of results) {
      expect(code).toBe(0);
    }
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    for (const d of testDirs) rmSync(d, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("high concurrency race of 8 parallel locked_bun_install processes serializes cleanly", async () => {
  const testDirs = Array.from({ length: 8 }, () => createTempProject());
  const lockDir = makeTestLockDir("test-high-conc-lock");

  try {
    const runContender = (dir) =>
      Bun.spawn(["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${dir}"`], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FACTORY_LOCK_DIR: lockDir,
          FACTORY_LOCK_MAX_WAIT: "30",
        },
      }).exited;

    const results = await Promise.all(testDirs.map(runContender));
    for (const code of results) {
      expect(code).toBe(0);
    }
    expect(existsSync(lockDir)).toBe(false);
  } finally {
    for (const d of testDirs) rmSync(d, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("worktree-up --checkout-only creates checkout without daemons and worktree-down removes it", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-root-"));
  const ticketId = makeTestTicket("TEST");

  try {
    const upRes = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot, FACTORY_SKIP_FETCH: "1" },
    });
    expect(upRes.exitCode).toBe(0);
    const expectedPath = path.join(tempWtRoot, ticketId);
    expect(upRes.stdout.toString().trim()).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Verify no daemons or .factory/run created
    expect(existsSync(path.join(expectedPath, ".factory", "run"))).toBe(false);

    // Down should clean it up
    const downRes = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downRes.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(false);
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", `feat/${ticketId}`] });
  }
});

test("re-dispatch fast-forwards a deliberately stale branch to the current base", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-stale-"));
  const ticketId = makeTestTicket("STALE");
  const branch = `feat/${ticketId}`;
  // Build the stale/base pair locally instead of relying on `origin/develop~1`:
  // CI checkouts are shallow (fetch-depth 1), so the real base has no
  // reachable parent there (WM-531). Synthesize a base commit on top of HEAD,
  // publish it as a temporary remote-tracking ref, and point the stale branch
  // at its parent; worktree-up is aimed at it via FACTORY_BASE_BRANCH.
  const baseBranch = `test-base-${ticketId}`;
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  const git = (args) => Bun.spawnSync({ cmd: ["git", ...args], cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });

  try {
    const staleSha = git(["rev-parse", "HEAD"]).stdout.toString().trim();
    expect(staleSha).toMatch(/^[0-9a-f]{40}$/);
    const commitTree = git([
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit-tree", `${staleSha}^{tree}`, "-p", staleSha, "-m", "synthetic base for stale re-dispatch test",
    ]);
    expect(commitTree.exitCode).toBe(0);
    const baseSha = commitTree.stdout.toString().trim();
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(staleSha).not.toBe(baseSha);
    expect(git(["update-ref", baseRef, baseSha]).exitCode).toBe(0);
    expect(git(["branch", branch, staleSha]).exitCode).toBe(0);

    const upRes = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot, FACTORY_BASE_BRANCH: baseBranch },
    });
    expect(upRes.exitCode).toBe(0);
    expect(git(["-C", path.join(tempWtRoot, ticketId), "rev-parse", "HEAD"]).stdout.toString().trim()).toBe(baseSha);
  } finally {
    Bun.spawnSync({ cmd: ["bash", DOWN, ticketId, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
    rmSync(tempWtRoot, { recursive: true, force: true });
    git(["branch", "-D", branch]);
    git(["update-ref", "-d", baseRef]);
  }
});

test("re-dispatch preserves an abandoned dirty zero-ahead worktree on a conventional wip branch", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-abandoned-dirty-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "factory-wt-abandoned-dirty-bin-"));
  const ticketId = `WM-${Date.now()}${process.pid}${Math.floor(Math.random() * 10000)}`;
  const branch = `feat/${ticketId}`;
  const expectedPath = path.join(tempWtRoot, ticketId);
  const reportPath = path.join(tempWtRoot, "preservation.json");
  let wipBranch = null;

  try {
    expect(Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    }).exitCode).toBe(0);
    writeFileSync(path.join(expectedPath, "abandoned.txt"), "preserve this work\n");

    const realGit = Bun.which("git");
    writeFileSync(path.join(mockBin, "git"), `#!/usr/bin/env bash
if [[ "$*" == *" push -u origin wip/${ticketId}-"* ]]; then
  echo "simulated push failure" >&2
  exit 1
fi
exec "${realGit}" "$@"
`, { mode: 0o755 });

    const recovered = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_WORKTREE_PRESERVE_ABANDONED: "1",
        FACTORY_WORKTREE_PRESERVATION_REPORT: reportPath,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout.toString()).toContain("preserved abandoned worktree changes on wip/");
    expect(recovered.stderr.toString()).toContain("keeping it locally");

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    wipBranch = report.ref;
    expect(wipBranch).toMatch(new RegExp(`^wip/${ticketId}-\\d{8}T\\d{6}Z(?:-\\d+)?$`));
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.push).toBe("local_only");
    expect(Bun.spawnSync({ cmd: ["git", "branch", "--show-current"], cwd: expectedPath }).stdout.toString().trim()).toBe(branch);
    expect(Bun.spawnSync({ cmd: ["git", "status", "--porcelain"], cwd: expectedPath }).stdout.toString()).toBe("");
    expect(Bun.spawnSync({ cmd: ["git", "show", `${wipBranch}:abandoned.txt`], cwd: expectedPath }).stdout.toString()).toBe("preserve this work\n");
    expect(Bun.spawnSync({ cmd: ["git", "log", "-1", "--format=%s", wipBranch], cwd: expectedPath }).stdout.toString().trim())
      .toBe(`chore(wip): preserve ${ticketId} worktree changes (${ticketId})`);
  } finally {
    Bun.spawnSync({ cmd: ["bash", DOWN, ticketId, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", branch, ...(wipBranch ? [wipBranch] : [])], cwd: path.resolve(import.meta.dir, "..") });
  }
}, 20_000);

test("re-dispatch refuses a dirty worktree with typed worktree_in_use when a live owner exists", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-live-dirty-"));
  const ticketId = makeTestTicket("LIVEOWNER");
  const branch = `feat/${ticketId}`;
  const expectedPath = path.join(tempWtRoot, ticketId);
  const reportPath = path.join(tempWtRoot, "must-not-exist.json");
  const leasePath = path.join(tempWtRoot, "live-owner-lease.json");

  try {
    expect(Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    }).exitCode).toBe(0);
    writeFileSync(path.join(expectedPath, "live-owner.txt"), "still in use\n");
    writeFileSync(leasePath, JSON.stringify({ owner: "new-live-owner", pid: 42 }));

    const refused = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_WORKTREE_PRESERVE_ABANDONED: "1",
        FACTORY_WORKTREE_PRESERVATION_REPORT: reportPath,
        FACTORY_WORKTREE_EXPECTED_LEASE_FILE: leasePath,
        FACTORY_WORKTREE_EXPECTED_LEASE_PID: String(process.pid),
      },
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("worktree_in_use");
    expect(readFileSync(path.join(expectedPath, "live-owner.txt"), "utf8")).toBe("still in use\n");
    expect(existsSync(reportPath)).toBe(false);
  } finally {
    Bun.spawnSync({ cmd: ["bash", DOWN, ticketId, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", branch], cwd: path.resolve(import.meta.dir, "..") });
  }
});

test("merge-fix re-dispatch resumes a committed PR branch as-is", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-merge-fix-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "factory-wt-open-pr-bin-"));
  const ticketId = makeTestTicket("MERGEFIX");
  const branch = `fix/${ticketId}`;
  const expectedPath = path.join(tempWtRoot, ticketId);
  const ghArgs = path.join(mockBin, "gh-args.txt");

  try {
    const firstUp = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "fix", "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(firstUp.exitCode).toBe(0);
    writeFileSync(path.join(expectedPath, "merge-fix.txt"), "resolved conflict\n");
    expect(Bun.spawnSync({ cmd: ["git", "add", "merge-fix.txt"], cwd: expectedPath }).exitCode).toBe(0);
    expect(Bun.spawnSync({
      cmd: ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "test(worktree): preserve merge fix branch (WM-1)"],
      cwd: expectedPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode).toBe(0);
    const committedSha = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: expectedPath }).stdout.toString().trim();
    expect(Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode).toBe(0);

    writeFileSync(path.join(mockBin, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" > "${ghArgs}"
printf '1\\n'
`, { mode: 0o755 });
    const resumed = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "fix", "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(resumed.exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: expectedPath }).stdout.toString().trim()).toBe(committedSha);
    expect(readFileSync(ghArgs, "utf8")).toBe(`pr list --head ${branch} --state open --json number --limit 1 --jq length\n`);
  } finally {
    Bun.spawnSync({ cmd: ["bash", DOWN, ticketId, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", branch], cwd: path.resolve(import.meta.dir, "..") });
  }
});

test("explicit resume flag and environment preserve committed branches without querying PRs", () => {
  for (const mode of ["flag", "environment"]) {
    const tempWtRoot = mkdtempSync(path.join(tmpdir(), `factory-wt-resume-${mode}-`));
    const mockBin = mkdtempSync(path.join(tmpdir(), `factory-wt-resume-${mode}-bin-`));
    const ticketId = makeTestTicket(mode === "flag" ? "RESUMEFLAG" : "RESUMEENV");
    const branch = `feat/${ticketId}`;
    const expectedPath = path.join(tempWtRoot, ticketId);
    const ghCalled = path.join(mockBin, "gh-called.txt");

    try {
      expect(Bun.spawnSync({
        cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exitCode).toBe(0);
      writeFileSync(path.join(expectedPath, "resume.txt"), `${mode}\n`);
      expect(Bun.spawnSync({ cmd: ["git", "add", "resume.txt"], cwd: expectedPath }).exitCode).toBe(0);
      expect(Bun.spawnSync({
        cmd: ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", `test(worktree): exercise explicit ${mode} resume (WM-1)`],
        cwd: expectedPath,
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode).toBe(0);
      const committedSha = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: expectedPath }).stdout.toString().trim();
      expect(Bun.spawnSync({
        cmd: ["bash", DOWN, ticketId],
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode).toBe(0);

      writeFileSync(path.join(mockBin, "gh"), `#!/usr/bin/env bash
touch "${ghCalled}"
exit 99
`, { mode: 0o755 });
      const resumeArgs = mode === "flag" ? ["--resume"] : [];
      const resumed = Bun.spawnSync({
        cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch", ...resumeArgs],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FACTORY_WT_ROOT: tempWtRoot,
          FACTORY_WORKTREE_RESUME: mode === "environment" ? "1" : "0",
          FACTORY_BASE_BRANCH: `missing-base-${ticketId}`,
          PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
        },
      });
      expect(resumed.exitCode).toBe(0);
      expect(Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: expectedPath }).stdout.toString().trim()).toBe(committedSha);
      expect(existsSync(ghCalled)).toBe(false);
    } finally {
      Bun.spawnSync({ cmd: ["bash", DOWN, ticketId, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
      rmSync(tempWtRoot, { recursive: true, force: true });
      rmSync(mockBin, { recursive: true, force: true });
      Bun.spawnSync({ cmd: ["git", "branch", "-D", branch], cwd: path.resolve(import.meta.dir, "..") });
    }
  }
}, 15_000);

test("re-dispatch keeps unique-commit refusal ahead of dirty-worktree preservation", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-unique-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "factory-wt-no-pr-bin-"));
  const ticketId = makeTestTicket("UNIQUE");
  const branch = `feat/${ticketId}`;
  const expectedPath = path.join(tempWtRoot, ticketId);

  try {
    const firstUp = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(firstUp.exitCode).toBe(0);
    writeFileSync(path.join(expectedPath, "unique.txt"), "ticket work\n");
    expect(Bun.spawnSync({ cmd: ["git", "add", "unique.txt"], cwd: expectedPath }).exitCode).toBe(0);
    expect(Bun.spawnSync({
      cmd: ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "test(worktree): create unique ticket commit (WM-1)"],
      cwd: expectedPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode).toBe(0);
    writeFileSync(path.join(expectedPath, "still-dirty.txt"), "uncommitted after unique commit\n");

    writeFileSync(path.join(mockBin, "gh"), "#!/usr/bin/env bash\nprintf '0\\n'\n", { mode: 0o755 });
    const secondUp = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_WORKTREE_PRESERVE_ABANDONED: "1",
        FACTORY_WORKTREE_PRESERVATION_REPORT: path.join(tempWtRoot, "must-not-preserve.json"),
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(secondUp.exitCode).not.toBe(0);
    expect(secondUp.stderr.toString()).toContain("worktree_branch_has_commits");
    expect(secondUp.stderr.toString()).toContain(branch);
    expect(secondUp.stderr.toString()).toContain("re-run with --resume");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(path.join(expectedPath, "still-dirty.txt"), "utf8")).toBe("uncommitted after unique commit\n");
    expect(existsSync(path.join(tempWtRoot, "must-not-preserve.json"))).toBe(false);
  } finally {
    Bun.spawnSync({ cmd: ["bash", DOWN, ticketId, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", branch], cwd: path.resolve(import.meta.dir, "..") });
  }
});

test("worktree-down --prune removes only clean terminal worktrees and preserves dirty or live trees", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-prune-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "factory-wt-prune-bin-"));
  const tickets = [makeTestTicket("TERMINAL"), makeTestTicket("DIRTY"), makeTestTicket("LIVE")];
  const [terminalTicket, dirtyTicket, liveTicket] = tickets;

  try {
    for (const ticket of tickets) {
      const up = Bun.spawnSync({
        cmd: ["bash", UP, ticket, "--checkout-only", "--no-fetch"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      });
      expect(up.exitCode).toBe(0);
    }
    writeFileSync(path.join(tempWtRoot, dirtyTicket, "uncommitted.txt"), "do not remove\n");
    mkdirSync(path.join(tempWtRoot, liveTicket, ".factory", "run"), { recursive: true });
    writeFileSync(path.join(tempWtRoot, liveTicket, ".factory", "run", "worker.pid"), `${process.pid}\n`);

    writeFileSync(path.join(mockBin, "bun"), "#!/usr/bin/env bash\nprintf '{\"state\":{\"name\":\"Done\"}}\\n'\n", { mode: 0o755 });
    const pruned = Bun.spawnSync({
      cmd: ["bash", DOWN, "--prune"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(pruned.exitCode).toBe(0);
    expect(existsSync(path.join(tempWtRoot, terminalTicket))).toBe(false);
    expect(existsSync(path.join(tempWtRoot, dirtyTicket))).toBe(true);
    expect(existsSync(path.join(tempWtRoot, liveTicket))).toBe(true);
    expect(pruned.stdout.toString()).toContain("pruned 1 terminal worktree");
  } finally {
    rmSync(path.join(tempWtRoot, dirtyTicket, "uncommitted.txt"), { force: true });
    rmSync(path.join(tempWtRoot, liveTicket, ".factory"), { recursive: true, force: true });
    for (const ticket of tickets) {
      Bun.spawnSync({ cmd: ["bash", DOWN, ticket, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
    }
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", ...tickets.map((ticket) => `feat/${ticket}`)],
      cwd: path.resolve(import.meta.dir, ".."),
    });
  }
});

test("worktree-down --prune recognizes a merged PR for the worktree branch", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-prune-merged-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "factory-wt-prune-merged-bin-"));
  const ticketId = makeTestTicket("MERGED");
  const branch = `feat/${ticketId}`;

  try {
    const up = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(up.exitCode).toBe(0);

    writeFileSync(path.join(mockBin, "bun"), "#!/usr/bin/env bash\nprintf '{\"state\":{\"name\":\"In Review\"}}\\n'\n", { mode: 0o755 });
    writeFileSync(path.join(mockBin, "gh"), `#!/usr/bin/env bash\n[[ "$*" == *"--head ${branch}"* ]] && printf '1\\n' || printf '0\\n'\n`, { mode: 0o755 });
    const pruned = Bun.spawnSync({
      cmd: ["bash", DOWN, "--prune"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(pruned.exitCode).toBe(0);
    expect(existsSync(path.join(tempWtRoot, ticketId))).toBe(false);
  } finally {
    Bun.spawnSync({ cmd: ["bash", DOWN, ticketId, "--force"], env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot } });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", branch], cwd: path.resolve(import.meta.dir, "..") });
  }
});

test("concurrent worktree-up --checkout-only succeed in parallel", async () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-conc-"));
  const ticket1 = makeTestTicket("CONCA");
  const ticket2 = makeTestTicket("CONCB");

  // Keep each child's stderr: a losing `git worktree add` reports the reason
  // (lock contention, etc.) only there, and a bare exit-1 in the CI log is
  // undiagnosable (WM-113).
  const runUp = async (ticket) => {
    const proc = Bun.spawn(["bash", UP, ticket, "--checkout-only"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot, FACTORY_SKIP_FETCH: "1" },
    });
    const [stderr, status] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ticket, status, stderr };
  };

  try {
    const [r1, r2] = await Promise.all([runUp(ticket1), runUp(ticket2)]);
    for (const r of [r1, r2]) {
      if (r.status !== 0) {
        console.error(`worktree-up ${r.ticket} exited ${r.status}; stderr:\n${r.stderr}`);
      }
      expect(r.status).toBe(0);
    }
    expect(existsSync(path.join(tempWtRoot, ticket1))).toBe(true);
    expect(existsSync(path.join(tempWtRoot, ticket2))).toBe(true);

    // Clean up both
    await Promise.all([
      Bun.spawn(["bash", DOWN, ticket1], {
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exited,
      Bun.spawn(["bash", DOWN, ticket2], {
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exited,
    ]);
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", `feat/${ticket1}`, `feat/${ticket2}`] });
  }
});

test("high concurrency worktree-up --checkout-only with 4 parallel bring-ups succeeds", async () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-4conc-"));
  const tickets = [
    makeTestTicket("PARA"),
    makeTestTicket("PARB"),
    makeTestTicket("PARC"),
    makeTestTicket("PARD"),
  ];

  const runUp = async (ticket) => {
    const proc = Bun.spawn(["bash", UP, ticket, "--checkout-only", "--no-fetch"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    const [stderr, status] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ticket, status, stderr };
  };

  try {
    const results = await Promise.all(tickets.map(runUp));
    for (const r of results) {
      if (r.status !== 0) {
        console.error(`worktree-up ${r.ticket} exited ${r.status}; stderr:\n${r.stderr}`);
      }
      expect(r.status).toBe(0);
      expect(existsSync(path.join(tempWtRoot, r.ticket))).toBe(true);
    }

    await Promise.all(
      tickets.map((t) =>
        Bun.spawn(["bash", DOWN, t], {
          env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
        }).exited
      )
    );
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", ...tickets.map((t) => `feat/${t}`)],
    });
  }
});

test("git_fetch skips when FACTORY_SKIP_FETCH is set and base ref exists", () => {
  const repo = path.resolve(import.meta.dir, "..");
  const r = sh(`git_fetch "${repo}" origin develop`, { FACTORY_SKIP_FETCH: "1" });
  expect(r.status).toBe(0);
});

test("git_fetch falls back to existing ref on remote failure", () => {
  const repo = path.resolve(import.meta.dir, "..");
  // Non-existent remote should fail network fetch but fall back if ref exists
  const r = sh(`git_fetch "${repo}" non_existent_remote develop`, { FACTORY_SKIP_FETCH: "0" });
  // Since non_existent_remote doesn't have develop in refs/remotes/non_existent_remote, it should die
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("could not fetch");
});

test("worktree-up CLI argument parsing error paths", () => {
  // 1. Missing ticket and missing --here
  const missingArg = Bun.spawnSync({
    cmd: ["bash", UP],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(missingArg.exitCode).not.toBe(0);
  expect(missingArg.stderr.toString()).toContain("usage: worktree-up.sh");

  // 2. Conflicting --here and ticket argument
  const hereWithTicket = Bun.spawnSync({
    cmd: ["bash", UP, "--here", "OPS-123"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(hereWithTicket.exitCode).not.toBe(0);
  expect(hereWithTicket.stderr.toString()).toContain("--here takes no ticket");

  const ticketWithHere = Bun.spawnSync({
    cmd: ["bash", UP, "OPS-123", "--here"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(ticketWithHere.exitCode).not.toBe(0);
  expect(ticketWithHere.stderr.toString()).toContain("--here takes no ticket");

  // 3. Invalid ticket regex
  const invalidTickets = ["invalid-ticket", "ops-123", "OPS_123", "123", "OPS-"];
  for (const t of invalidTickets) {
    const res = Bun.spawnSync({
      cmd: ["bash", UP, t],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toString()).toContain("ticket must look like OPS-123");
  }

  // 4. Unknown flag
  const unknownFlag = Bun.spawnSync({
    cmd: ["bash", UP, "--bogus-flag"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(unknownFlag.exitCode).not.toBe(0);
  expect(unknownFlag.stderr.toString()).toContain("unknown option '--bogus-flag'");

  // 5. Excess arguments
  const excessArgs = Bun.spawnSync({
    cmd: ["bash", UP, "OPS-123", "feat", "my-slug", "extra-arg"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(excessArgs.exitCode).not.toBe(0);
  expect(excessArgs.stderr.toString()).toContain("too many arguments (got 'extra-arg')");

  // 6. Help option displays usage and exits 0
  const helpRes = Bun.spawnSync({
    cmd: ["bash", UP, "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(helpRes.exitCode).toBe(0);
  expect(helpRes.stdout.toString()).toContain("bin/worktree-up.sh OPS-123");
});

test("worktree-down CLI argument parsing error paths", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-down-test-"));

  try {
    // 1. Missing ticket and missing --here
    const missingArg = Bun.spawnSync({
      cmd: ["bash", DOWN],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missingArg.exitCode).not.toBe(0);
    expect(missingArg.stderr.toString()).toContain("usage: worktree-down.sh");

    // 2. Unknown flag
    const unknownFlag = Bun.spawnSync({
      cmd: ["bash", DOWN, "--invalid-flag"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unknownFlag.exitCode).not.toBe(0);
    expect(unknownFlag.stderr.toString()).toContain("unknown option '--invalid-flag'");

    // 3. Excess arguments
    const excessArgs = Bun.spawnSync({
      cmd: ["bash", DOWN, "OPS-123", "extra-arg"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(excessArgs.exitCode).not.toBe(0);
    expect(excessArgs.stderr.toString()).toContain("too many arguments");

    // 4. Conflicting --here with ticket
    const hereWithTicket = Bun.spawnSync({
      cmd: ["bash", DOWN, "--here", "OPS-123"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(hereWithTicket.exitCode).not.toBe(0);
    expect(hereWithTicket.stderr.toString()).toContain("--here takes no ticket");

    // 5. Help option displays usage and exits 0
    const helpRes = Bun.spawnSync({
      cmd: ["bash", DOWN, "-h"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout.toString()).toContain("bin/worktree-down.sh OPS-123");

    // 6. Non-existent worktree
    const nonExistent = Bun.spawnSync({
      cmd: ["bash", DOWN, "OPS-99999"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(nonExistent.exitCode).not.toBe(0);
    expect(nonExistent.stderr.toString()).toContain("no worktree at");
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
  }
});

test("worktree-down refuses dirty worktree without --force and cleans up with --force", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-down-dirty-"));
  const ticketId = makeTestTicket("DIRTY");
  const expectedPath = path.join(tempWtRoot, ticketId);

  try {
    // 1. Create worktree
    const upRes = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot, FACTORY_SKIP_FETCH: "1" },
    });
    expect(upRes.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(true);

    // 2. Make uncommitted change in the worktree
    writeFileSync(path.join(expectedPath, "uncommitted.txt"), "uncommitted work");

    // 3. Attempt teardown without --force -> should fail and preserve worktree
    const downDirty = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downDirty.exitCode).not.toBe(0);
    expect(downDirty.stderr.toString()).toContain("has uncommitted changes — commit/stash them, or re-run with --force");
    expect(existsSync(expectedPath)).toBe(true);

    // 4. Teardown with --force -> should succeed and remove worktree
    const downForce = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downForce.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(false);
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", `feat/${ticketId}`] });
  }
});

