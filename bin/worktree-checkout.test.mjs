import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const UP = path.resolve(import.meta.dir, "worktree-up.sh");
const DOWN = path.resolve(import.meta.dir, "worktree-down.sh");
const COMMON = path.resolve(import.meta.dir, "worktree-common.sh");
// The handoff sandbox intentionally mounts the shared Git directory read-only.
// Nested-worktree integration cases cannot run there; focused helpers still do.
const handoffSandbox = process.env.FACTORY_HANDOFF_SANDBOX === "1";

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
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-pkg", version: "1.0.0" }),
  );
  Bun.spawnSync({ cmd: ["bun", "install"], cwd: dir });
  return dir;
}

function makeTestTicket(prefix = "TEST") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${process.pid}-${rand}`;
}

function makeTestLockDir(prefix = "test-lock") {
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(
    tmpdir(),
    `${prefix}-${Date.now()}-${process.pid}-${rand}.lock`,
  );
}

function cwdForPid(pid) {
  if (process.platform === "linux") {
    const result = Bun.spawnSync({
      cmd: ["readlink", `/proc/${pid}/cwd`],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) return result.stdout.toString().trim();
  }
  const result = Bun.spawnSync({
    cmd: ["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.stdout
    .toString()
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

test("locked_bun_install executes real bun install under lock and releases lock", () => {
  const testDir = createTempProject();
  const lockDir = makeTestLockDir("test-lock");
  try {
    const r = sh(`locked_bun_install "${testDir}"`, {
      FACTORY_LOCK_DIR: lockDir,
    });
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
    const r = sh(`locked_bun_install "${testDir}"`, {
      FACTORY_LOCK_DIR: lockDir,
    });
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
      Bun.spawn(
        ["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${testDir1}"`],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FACTORY_LOCK_DIR: lockDir },
        },
      ).exited,
      Bun.spawn(
        ["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${testDir2}"`],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FACTORY_LOCK_DIR: lockDir },
        },
      ).exited,
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
    writeFileSync(
      mockBun,
      `#!/usr/bin/env bash
if [[ "$1" == "install" ]]; then
  touch "${readyFile}"
  sleep 1
  exit 0
fi
exec bun "$@"
`,
      { mode: 0o755 },
    );

    try {
      const proc = Bun.spawn(
        [
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
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PATH: `${mockBinDir}${path.delimiter}${process.env.PATH}`,
            FACTORY_LOCK_DIR: lockDir,
          },
        },
      );
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      const [status, stdout, stderr] = await Promise.all([
        proc.exited,
        stdoutPromise,
        stderrPromise,
      ]);
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

test("multiple contenders race to reclaim a stale pid-less lock and none crash", async () => {
  // Contract (gh-1373): exactly one contender owns the lock at a time; every
  // contender either wins the reclaim (exit 0) or reports the documented
  // "lock held" timeout. No contender may crash on a half-reclaimed lock.
  const testDirs = [
    createTempProject(),
    createTempProject(),
    createTempProject(),
    createTempProject(),
  ];
  const lockDir = makeTestLockDir("test-pidless-race");
  mkdirSync(lockDir, { recursive: true });
  const deadlineMs = 30_000;

  try {
    const runContender = async (dir) => {
      const proc = Bun.spawn(
        ["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${dir}"`],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            FACTORY_LOCK_DIR: lockDir,
            FACTORY_LOCK_STALE_AFTER: "0",
            FACTORY_LOCK_MAX_WAIT: "10",
          },
        },
      );
      const stderrPromise = new Response(proc.stderr).text();
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve("deadline"), deadlineMs);
      });
      const outcome = await Promise.race([proc.exited, deadline]);
      clearTimeout(timer);
      if (outcome === "deadline") {
        proc.kill("SIGKILL");
        await proc.exited;
        return { code: "deadline", stderr: await stderrPromise };
      }
      return { code: outcome, stderr: await stderrPromise };
    };

    const results = await Promise.all(testDirs.map(runContender));
    for (const { code, stderr } of results) {
      expect(code).not.toBe("deadline");
      if (code !== 0) {
        // The only permitted non-zero outcome is the documented lock-held
        // timeout; anything else is a crash on a half-reclaimed lock.
        expect(stderr).toContain("timed out waiting for bun install lock");
      }
      expect(stderr).not.toContain("No such file or directory");
    }
    expect(results.filter(({ code }) => code === 0).length).toBeGreaterThan(0);
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
      Bun.spawn(
        ["bash", "-c", `source "${COMMON}"\nlocked_bun_install "${dir}"`],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            FACTORY_LOCK_DIR: lockDir,
            FACTORY_LOCK_MAX_WAIT: "30",
          },
        },
      ).exited;

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
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-root-"));
  const ticketId = makeTestTicket("TEST");

  try {
    const upRes = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_SKIP_FETCH: "1",
      },
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
  if (handoffSandbox) return;
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
  const git = (args) =>
    Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

  try {
    const staleSha = git(["rev-parse", "HEAD"]).stdout.toString().trim();
    expect(staleSha).toMatch(/^[0-9a-f]{40}$/);
    const commitTree = git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit-tree",
      `${staleSha}^{tree}`,
      "-p",
      staleSha,
      "-m",
      "synthetic base for stale re-dispatch test",
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
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_BASE_BRANCH: baseBranch,
      },
    });
    expect(upRes.exitCode).toBe(0);
    expect(
      git(["-C", path.join(tempWtRoot, ticketId), "rev-parse", "HEAD"])
        .stdout.toString()
        .trim(),
    ).toBe(baseSha);
  } finally {
    Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    rmSync(tempWtRoot, { recursive: true, force: true });
    git(["branch", "-D", branch]);
    git(["update-ref", "-d", baseRef]);
  }
});

test("re-dispatch preserves an abandoned dirty zero-ahead worktree on a conventional wip branch", () => {
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(
    path.join(tmpdir(), "factory-wt-abandoned-dirty-"),
  );
  const mockBin = mkdtempSync(
    path.join(tmpdir(), "factory-wt-abandoned-dirty-bin-"),
  );
  const ticketId = `WM-${Date.now()}${process.pid}${Math.floor(Math.random() * 10000)}`;
  const branch = `feat/${ticketId}`;
  const expectedPath = path.join(tempWtRoot, ticketId);
  const reportPath = path.join(tempWtRoot, "preservation.json");
  let wipBranch = null;

  try {
    expect(
      Bun.spawnSync({
        cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exitCode,
    ).toBe(0);
    writeFileSync(
      path.join(expectedPath, "abandoned.txt"),
      "preserve this work\n",
    );

    const realGit = Bun.which("git");
    writeFileSync(
      path.join(mockBin, "git"),
      `#!/usr/bin/env bash
if [[ "$*" == *" push -u origin wip/${ticketId}-"* ]]; then
  echo "simulated push failure" >&2
  exit 1
fi
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );

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
    expect(recovered.stdout.toString()).toContain(
      "preserved abandoned worktree changes on wip/",
    );
    expect(recovered.stderr.toString()).toContain("keeping it locally");

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    wipBranch = report.ref;
    expect(wipBranch).toMatch(
      new RegExp(`^wip/${ticketId}-\\d{8}T\\d{6}Z(?:-\\d+)?$`),
    );
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.push).toBe("local_only");
    expect(
      Bun.spawnSync({
        cmd: ["git", "branch", "--show-current"],
        cwd: expectedPath,
      })
        .stdout.toString()
        .trim(),
    ).toBe(branch);
    expect(
      Bun.spawnSync({
        cmd: ["git", "status", "--porcelain"],
        cwd: expectedPath,
      }).stdout.toString(),
    ).toBe("");
    expect(
      Bun.spawnSync({
        cmd: ["git", "show", `${wipBranch}:abandoned.txt`],
        cwd: expectedPath,
      }).stdout.toString(),
    ).toBe("preserve this work\n");
    expect(
      Bun.spawnSync({
        cmd: ["git", "log", "-1", "--format=%s", wipBranch],
        cwd: expectedPath,
      })
        .stdout.toString()
        .trim(),
    ).toBe(`chore(wip): preserve ${ticketId} worktree changes (${ticketId})`);
  } finally {
    Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", branch, ...(wipBranch ? [wipBranch] : [])],
      cwd: path.resolve(import.meta.dir, ".."),
    });
  }
}, 20_000);

test("re-dispatch refuses a dirty worktree with typed worktree_in_use when a live owner exists", () => {
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-live-dirty-"));
  const ticketId = makeTestTicket("LIVEOWNER");
  const branch = `feat/${ticketId}`;
  const expectedPath = path.join(tempWtRoot, ticketId);
  const reportPath = path.join(tempWtRoot, "must-not-exist.json");
  const leasePath = path.join(tempWtRoot, "live-owner-lease.json");

  try {
    expect(
      Bun.spawnSync({
        cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exitCode,
    ).toBe(0);
    writeFileSync(path.join(expectedPath, "live-owner.txt"), "still in use\n");
    writeFileSync(
      leasePath,
      JSON.stringify({ owner: "new-live-owner", pid: 42 }),
    );

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
    expect(
      readFileSync(path.join(expectedPath, "live-owner.txt"), "utf8"),
    ).toBe("still in use\n");
    expect(existsSync(reportPath)).toBe(false);
  } finally {
    Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", branch],
      cwd: path.resolve(import.meta.dir, ".."),
    });
  }
});

test("merge-fix re-dispatch resumes a committed PR branch as-is", () => {
  if (handoffSandbox) return;
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
    writeFileSync(
      path.join(expectedPath, "merge-fix.txt"),
      "resolved conflict\n",
    );
    expect(
      Bun.spawnSync({ cmd: ["git", "add", "merge-fix.txt"], cwd: expectedPath })
        .exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync({
        cmd: [
          "git",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "test(worktree): preserve merge fix branch (WM-1)",
        ],
        cwd: expectedPath,
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
    ).toBe(0);
    const committedSha = Bun.spawnSync({
      cmd: ["git", "rev-parse", "HEAD"],
      cwd: expectedPath,
    })
      .stdout.toString()
      .trim();
    expect(
      Bun.spawnSync({
        cmd: ["bash", DOWN, ticketId],
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
    ).toBe(0);

    writeFileSync(
      path.join(mockBin, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" > "${ghArgs}"
printf '1\\n'
`,
      { mode: 0o755 },
    );
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
    expect(
      Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: expectedPath })
        .stdout.toString()
        .trim(),
    ).toBe(committedSha);
    expect(readFileSync(ghArgs, "utf8")).toBe(
      `pr list --head ${branch} --state open --json number --limit 1 --jq length\n`,
    );
  } finally {
    Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", branch],
      cwd: path.resolve(import.meta.dir, ".."),
    });
  }
});

test("explicit resume flag and environment preserve committed branches without querying PRs", () => {
  if (handoffSandbox) return;
  for (const mode of ["flag", "environment"]) {
    const tempWtRoot = mkdtempSync(
      path.join(tmpdir(), `factory-wt-resume-${mode}-`),
    );
    const mockBin = mkdtempSync(
      path.join(tmpdir(), `factory-wt-resume-${mode}-bin-`),
    );
    const ticketId = makeTestTicket(
      mode === "flag" ? "RESUMEFLAG" : "RESUMEENV",
    );
    const branch = `feat/${ticketId}`;
    const expectedPath = path.join(tempWtRoot, ticketId);
    const ghCalled = path.join(mockBin, "gh-called.txt");

    try {
      expect(
        Bun.spawnSync({
          cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
        }).exitCode,
      ).toBe(0);
      writeFileSync(path.join(expectedPath, "resume.txt"), `${mode}\n`);
      expect(
        Bun.spawnSync({ cmd: ["git", "add", "resume.txt"], cwd: expectedPath })
          .exitCode,
      ).toBe(0);
      expect(
        Bun.spawnSync({
          cmd: [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            `test(worktree): exercise explicit ${mode} resume (WM-1)`,
          ],
          cwd: expectedPath,
          stdout: "pipe",
          stderr: "pipe",
        }).exitCode,
      ).toBe(0);
      const committedSha = Bun.spawnSync({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: expectedPath,
      })
        .stdout.toString()
        .trim();
      expect(
        Bun.spawnSync({
          cmd: ["bash", DOWN, ticketId],
          env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
          stdout: "pipe",
          stderr: "pipe",
        }).exitCode,
      ).toBe(0);

      writeFileSync(
        path.join(mockBin, "gh"),
        `#!/usr/bin/env bash
touch "${ghCalled}"
exit 99
`,
        { mode: 0o755 },
      );
      const resumeArgs = mode === "flag" ? ["--resume"] : [];
      const resumed = Bun.spawnSync({
        cmd: [
          "bash",
          UP,
          ticketId,
          "--checkout-only",
          "--no-fetch",
          ...resumeArgs,
        ],
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
      expect(
        Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: expectedPath })
          .stdout.toString()
          .trim(),
      ).toBe(committedSha);
      expect(existsSync(ghCalled)).toBe(false);
    } finally {
      Bun.spawnSync({
        cmd: ["bash", DOWN, ticketId, "--force"],
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      });
      rmSync(tempWtRoot, { recursive: true, force: true });
      rmSync(mockBin, { recursive: true, force: true });
      Bun.spawnSync({
        cmd: ["git", "branch", "-D", branch],
        cwd: path.resolve(import.meta.dir, ".."),
      });
    }
  }
}, 15_000);

// WM-680: a unique commit that is already on origin is preserved work (an
// orphaned/blocked run's WIP the orchestrator pushed), not litter. worktree-up
// resumes it without --resume so an unattended re-dispatch does not die on
// worktree_branch_has_commits. The test above keeps the boundary: a unique
// commit that exists ONLY locally still refuses.
test("re-dispatch auto-resumes a branch whose unique commits are already on origin (WM-680)", () => {
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-pushed-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "factory-wt-pushed-bin-"));
  const ticketId = makeTestTicket("PUSHED");
  const branch = `feat/${ticketId}`;
  const expectedPath = path.join(tempWtRoot, ticketId);
  const repo = path.resolve(import.meta.dir, "..");

  try {
    const firstUp = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(firstUp.exitCode).toBe(0);
    writeFileSync(path.join(expectedPath, "wip.txt"), "preserved work\n");
    expect(
      Bun.spawnSync({ cmd: ["git", "add", "wip.txt"], cwd: expectedPath })
        .exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync({
        cmd: [
          "git",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "test(worktree): preserved before re-dispatch (WM-680)",
        ],
        cwd: expectedPath,
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
    ).toBe(0);
    const tip = Bun.spawnSync({
      cmd: ["git", "rev-parse", "HEAD"],
      cwd: expectedPath,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    // Simulate "pushed": stand up the remote-tracking ref at the same SHA.
    expect(
      Bun.spawnSync({
        cmd: ["git", "update-ref", `refs/remotes/origin/${branch}`, tip],
        cwd: repo,
      }).exitCode,
    ).toBe(0);
    // Tear the worktree down (branch stays), as an orphaned run leaves it.
    expect(
      Bun.spawnSync({
        cmd: ["bash", DOWN, ticketId],
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exitCode,
    ).toBe(0);
    expect(existsSync(expectedPath)).toBe(false);

    const realGit = Bun.which("git");
    writeFileSync(
      path.join(mockBin, "gh"),
      "#!/usr/bin/env bash\nprintf '0\\n'\n",
      { mode: 0o755 },
    ); // no open PR
    writeFileSync(
      path.join(mockBin, "git"),
      `#!/usr/bin/env bash
if [[ "$*" == *"ls-remote --heads origin refs/heads/${branch}"* ]]; then
  printf "%s\\trefs/heads/${branch}\\n" "${tip}"
  exit 0
fi
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    const secondUp = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(secondUp.stderr.toString()).not.toContain(
      "worktree_branch_has_commits",
    );
    expect(secondUp.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(true);
    // The preserved commit is what the new worktree is on.
    expect(readFileSync(path.join(expectedPath, "wip.txt"), "utf8")).toBe(
      "preserved work\n",
    );
    expect(
      Bun.spawnSync({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: expectedPath,
        stdout: "pipe",
      })
        .stdout.toString()
        .trim(),
    ).toBe(tip);
  } finally {
    Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "update-ref", "-d", `refs/remotes/origin/${branch}`],
      cwd: repo,
    });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", branch], cwd: repo });
  }
});

test("re-dispatch keeps unique-commit refusal ahead of dirty-worktree preservation", () => {
  if (handoffSandbox) return;
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
    expect(
      Bun.spawnSync({ cmd: ["git", "add", "unique.txt"], cwd: expectedPath })
        .exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync({
        cmd: [
          "git",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "test(worktree): create unique ticket commit (WM-1)",
        ],
        cwd: expectedPath,
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
    ).toBe(0);
    writeFileSync(
      path.join(expectedPath, "still-dirty.txt"),
      "uncommitted after unique commit\n",
    );

    const realGit = Bun.which("git");
    writeFileSync(
      path.join(mockBin, "gh"),
      "#!/usr/bin/env bash\nprintf '0\\n'\n",
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(mockBin, "git"),
      `#!/usr/bin/env bash
if [[ "$*" == *"push origin "* ]]; then
  echo "simulated push failure" >&2
  exit 1
fi
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    const secondUp = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only", "--no-fetch"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_WORKTREE_PRESERVE_ABANDONED: "1",
        FACTORY_WORKTREE_PRESERVATION_REPORT: path.join(
          tempWtRoot,
          "must-not-preserve.json",
        ),
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(secondUp.exitCode).not.toBe(0);
    expect(secondUp.stderr.toString()).toContain("worktree_branch_has_commits");
    expect(secondUp.stderr.toString()).toContain(branch);
    expect(secondUp.stderr.toString()).toContain("re-run with --resume");
    expect(existsSync(expectedPath)).toBe(true);
    expect(
      readFileSync(path.join(expectedPath, "still-dirty.txt"), "utf8"),
    ).toBe("uncommitted after unique commit\n");
    expect(existsSync(path.join(tempWtRoot, "must-not-preserve.json"))).toBe(
      false,
    );
  } finally {
    Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", branch],
      cwd: path.resolve(import.meta.dir, ".."),
    });
  }
});

test("worktree-down --prune removes only clean terminal worktrees and preserves dirty or live trees", () => {
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-prune-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "factory-wt-prune-bin-"));
  const tickets = [
    makeTestTicket("TERMINAL"),
    makeTestTicket("DIRTY"),
    makeTestTicket("LIVE"),
  ];
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
    writeFileSync(
      path.join(tempWtRoot, dirtyTicket, "uncommitted.txt"),
      "do not remove\n",
    );
    mkdirSync(path.join(tempWtRoot, liveTicket, ".factory", "run"), {
      recursive: true,
    });
    writeFileSync(
      path.join(tempWtRoot, liveTicket, ".factory", "run", "worker.pid"),
      `${process.pid}\n`,
    );

    writeFileSync(
      path.join(mockBin, "bun"),
      '#!/usr/bin/env bash\nprintf \'{"state":{"name":"Done"}}\\n\'\n',
      { mode: 0o755 },
    );
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
    rmSync(path.join(tempWtRoot, dirtyTicket, "uncommitted.txt"), {
      force: true,
    });
    rmSync(path.join(tempWtRoot, liveTicket, ".factory"), {
      recursive: true,
      force: true,
    });
    for (const ticket of tickets) {
      Bun.spawnSync({
        cmd: ["bash", DOWN, ticket, "--force"],
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      });
    }
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: [
        "git",
        "branch",
        "-D",
        ...tickets.map((ticket) => `feat/${ticket}`),
      ],
      cwd: path.resolve(import.meta.dir, ".."),
    });
  }
});

test("worktree-down --prune recognizes a merged PR for the worktree branch", () => {
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(
    path.join(tmpdir(), "factory-wt-prune-merged-"),
  );
  const mockBin = mkdtempSync(
    path.join(tmpdir(), "factory-wt-prune-merged-bin-"),
  );
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

    writeFileSync(
      path.join(mockBin, "bun"),
      '#!/usr/bin/env bash\nprintf \'{"state":{"name":"In Review"}}\\n\'\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(mockBin, "gh"),
      `#!/usr/bin/env bash\n[[ "$*" == *"--head ${branch}"* ]] && printf '1\\n' || printf '0\\n'\n`,
      { mode: 0o755 },
    );
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
    Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    rmSync(tempWtRoot, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", branch],
      cwd: path.resolve(import.meta.dir, ".."),
    });
  }
});

test("concurrent worktree-up --checkout-only succeed in parallel", async () => {
  if (handoffSandbox) return;
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
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_SKIP_FETCH: "1",
      },
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
        console.error(
          `worktree-up ${r.ticket} exited ${r.status}; stderr:\n${r.stderr}`,
        );
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
    Bun.spawnSync({
      cmd: ["git", "branch", "-D", `feat/${ticket1}`, `feat/${ticket2}`],
    });
  }
});

test("worktree_add retries transient worktree metadata read races", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "factory-wt-metadata-race-"));
  const attemptsFile = path.join(tempDir, "attempts");
  const worktreePath = path.join(tempDir, "checkout");

  try {
    const r = sh(
      `
      git() {
        if [[ "$*" == *" show-ref --verify --quiet refs/heads/feat/WM-TEST"* ]]; then
          return 1
        fi
        if [[ "$*" == *" worktree add "* ]]; then
          local attempts=0
          [[ -f "$MOCK_GIT_ATTEMPTS" ]] && attempts=$(cat "$MOCK_GIT_ATTEMPTS")
          attempts=$((attempts + 1))
          printf '%s\n' "$attempts" >"$MOCK_GIT_ATTEMPTS"
          if [[ "$attempts" -eq 1 ]]; then
            printf '%s\n' 'fatal: failed to read .git/worktrees/PARA-123/commondir: Success' >&2
            return 1
          fi
          return 0
        fi
        return 1
      }
      worktree_add "${worktreePath}" "feat/WM-TEST" "origin/develop" "/repo"
    `,
      { MOCK_GIT_ATTEMPTS: attemptsFile },
    );

    expect(r.status).toBe(0);
    expect(readFileSync(attemptsFile, "utf8").trim()).toBe("2");
    expect(r.stderr).toContain(
      "git worktree add hit lock contention (attempt 1/6)",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("high concurrency worktree-up --checkout-only with 4 parallel bring-ups succeeds", async () => {
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-4conc-"));
  const tickets = [
    makeTestTicket("PARA"),
    makeTestTicket("PARB"),
    makeTestTicket("PARC"),
    makeTestTicket("PARD"),
  ];

  const runUp = async (ticket) => {
    const proc = Bun.spawn(
      ["bash", UP, ticket, "--checkout-only", "--no-fetch"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      },
    );
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
        console.error(
          `worktree-up ${r.ticket} exited ${r.status}; stderr:\n${r.stderr}`,
        );
      }
      expect(r.status).toBe(0);
      expect(existsSync(path.join(tempWtRoot, r.ticket))).toBe(true);
    }

    await Promise.all(
      tickets.map(
        (t) =>
          Bun.spawn(["bash", DOWN, t], {
            env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
          }).exited,
      ),
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
  const r = sh(`git_fetch "${repo}" origin develop`, {
    FACTORY_SKIP_FETCH: "1",
  });
  expect(r.status).toBe(0);
});

test("git_fetch falls back to existing ref on remote failure", () => {
  const repo = path.resolve(import.meta.dir, "..");
  // Non-existent remote should fail network fetch but fall back if ref exists
  const r = sh(`git_fetch "${repo}" non_existent_remote develop`, {
    FACTORY_SKIP_FETCH: "0",
  });
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
  const invalidTickets = [
    "invalid-ticket",
    "ops-123",
    "OPS_123",
    "123",
    "OPS-",
  ];
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
  expect(unknownFlag.stderr.toString()).toContain(
    "unknown option '--bogus-flag'",
  );

  // 5. Excess arguments
  const excessArgs = Bun.spawnSync({
    cmd: ["bash", UP, "OPS-123", "feat", "my-slug", "extra-arg"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(excessArgs.exitCode).not.toBe(0);
  expect(excessArgs.stderr.toString()).toContain(
    "too many arguments (got 'extra-arg')",
  );

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
    expect(unknownFlag.stderr.toString()).toContain(
      "unknown option '--invalid-flag'",
    );

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
    expect(hereWithTicket.stderr.toString()).toContain(
      "--here takes no ticket",
    );

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

test("worktree-down refuses dirty worktree without --force, leaves cwd-bound processes alone, and cleans up with --force", async () => {
  if (handoffSandbox) return;
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-down-dirty-"));
  const ticketId = makeTestTicket("DIRTY");
  const expectedPath = path.join(tempWtRoot, ticketId);
  let fakeServe;

  try {
    // 1. Create worktree
    const upRes = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FACTORY_WT_ROOT: tempWtRoot,
        FACTORY_SKIP_FETCH: "1",
      },
    });
    expect(upRes.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(true);

    // 2. Make uncommitted change in the worktree
    writeFileSync(
      path.join(expectedPath, "uncommitted.txt"),
      "uncommitted work",
    );

    // 3. Park a detached cwd-bound process in the worktree — the shape of an
    //    orphaned fake serve. A refused teardown keeps the checkout, so it
    //    must keep this process too: the cwd sweep (#1379) runs only on the
    //    removal path, after the dirty check.
    fakeServe = spawn("bash", ["-c", "while :; do sleep 1; done"], {
      cwd: expectedPath,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    let fakeExit = null;
    fakeServe.once("exit", (code, signal) => {
      fakeExit = { code, signal };
    });
    const readyDeadline = Date.now() + 5_000;
    while (Date.now() < readyDeadline) {
      if (cwdForPid(fakeServe.pid) === expectedPath) break;
      await Bun.sleep(10);
    }
    expect(cwdForPid(fakeServe.pid)).toBe(expectedPath);

    // 4. Attempt teardown without --force -> should fail and preserve worktree
    const downDirty = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downDirty.exitCode).not.toBe(0);
    expect(downDirty.stderr.toString()).toContain(
      "has uncommitted changes — commit/stash them, or re-run with --force",
    );
    expect(`${downDirty.stdout}${downDirty.stderr}`).not.toContain(
      "stopping cwd-bound",
    );
    expect(existsSync(expectedPath)).toBe(true);
    await Bun.sleep(100);
    expect(fakeExit).toBeNull();
    expect(cwdForPid(fakeServe.pid)).toBe(expectedPath);

    // 5. Teardown with --force -> should succeed, sweep the orphan, and
    //    remove the worktree
    const downForce = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downForce.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(false);
    expect(`${downForce.stdout}${downForce.stderr}`).toContain(
      `stopping cwd-bound process group ${fakeServe.pid}`,
    );
  } finally {
    if (fakeServe) {
      try {
        if (process.platform === "win32") fakeServe.kill("SIGKILL");
        else process.kill(-fakeServe.pid, "SIGKILL");
      } catch {
        /* teardown already killed it */
      }
    }
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", `feat/${ticketId}`] });
  }
});

test("worktree teardown group-kills a cwd-bound fake serve with no pidfile", async () => {
  const expectedPath = mkdtempSync(
    path.join(tmpdir(), "factory-down-cwd-process-"),
  );
  let fakeServe;

  try {
    // This is intentionally the same fake serve shape started by the handoff
    // gate. There is deliberately no pidfile: cwd ownership is teardown's
    // backstop after a parent gate has been aborted or timed out.
    const fakeCli = path.join(expectedPath, "event-runtime", "cli.mjs");
    mkdirSync(path.dirname(fakeCli), { recursive: true });
    writeFileSync(fakeCli, "setInterval(() => {}, 10_000);\n", "utf8");
    fakeServe = spawn("bun", [fakeCli, "serve", "--adapter-override", "fake"], {
      cwd: expectedPath,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });

    const readyDeadline = Date.now() + 5_000;
    while (Date.now() < readyDeadline) {
      const cwd = cwdForPid(fakeServe.pid);
      if (cwd === expectedPath) break;
      await Bun.sleep(10);
    }
    expect(cwdForPid(fakeServe.pid)).toBe(expectedPath);

    const exited = new Promise((resolve) => {
      fakeServe.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const downRes = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `source "${COMMON}"; kill_worktree_cwd_processes "$TARGET"`,
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TARGET: expectedPath },
    });
    expect(downRes.exitCode).toBe(0);
    expect(`${downRes.stdout}${downRes.stderr}`).toContain(
      `stopping cwd-bound process group ${fakeServe.pid}`,
    );
    expect(await exited).not.toEqual({ code: 0, signal: null });
    const survivors = sh(`worktree_cwd_processes "${expectedPath}"`);
    expect(survivors.status).toBe(0);
    expect(survivors.stdout).toBe("");
  } finally {
    if (fakeServe) {
      try {
        if (process.platform === "win32") fakeServe.kill("SIGKILL");
        else process.kill(-fakeServe.pid, "SIGKILL");
      } catch {
        /* teardown already killed it */
      }
    }
    rmSync(expectedPath, { recursive: true, force: true });
  }
});

test("worktree cwd sweep never signals the shell that invoked it from inside the worktree", () => {
  const expectedPath = mkdtempSync(
    path.join(tmpdir(), "factory-down-cwd-caller-"),
  );
  try {
    // An agent session or operator shell commonly runs teardown with its cwd
    // inside the checkout being removed. That caller (and its ancestors) is
    // cwd-bound too, so the sweep must leave it alone rather than SIGKILL the
    // terminal it runs in. `--here` is excluded from the sweep entirely; this
    // covers the removal path with a caller chain rooted in the worktree.
    const res = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `bash -c 'source "${COMMON}"; kill_worktree_cwd_processes "$PWD"' && printf 'caller-survived\n'`,
      ],
      cwd: expectedPath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    expect(res.exitCode).toBe(0);
    const output = `${res.stdout}${res.stderr}`;
    expect(output).toContain("caller-survived");
    expect(output).not.toContain("stopping cwd-bound");
  } finally {
    rmSync(expectedPath, { recursive: true, force: true });
  }
});

// ------------------------------------------------ GitHub ticket ids (#881) ---
// After the WM-1006 cutover the worker passes GitHub identifiers. The scripts
// validated `^[A-Z]+-[0-9]+` only, so a claim landed and then worktree creation
// died — leaving a claimed ticket with no work happening.
describe("ticket id forms", () => {
  const COMMON = path.resolve(import.meta.dir, "worktree-common.sh");
  /** Run a helper from worktree-common.sh and return its stdout. */
  const call = (fn, arg) => {
    const r = Bun.spawnSync({
      cmd: ["bash", "-c", `source "${COMMON}"; ${fn} ${JSON.stringify(arg)}`],
      stdout: "pipe",
      stderr: "pipe",
    });
    return { out: r.stdout.toString().trim(), code: r.exitCode };
  };

  test("accepts tracker-key and GitHub contract forms, rejects bare numbers", () => {
    for (const id of [
      "OPS-123",
      "OPS-123-scratch",
      "watt-mind/factory#881",
      "#881",
    ]) {
      expect(call("ticket_is_valid", id).code).toBe(0);
    }
    expect(call("ticket_is_valid", "not a ticket").code).not.toBe(0);
  });

  test("slugs are filesystem- and ref-safe", () => {
    const slug = call("ticket_slug", "watt-mind/factory#881").out;
    expect(slug).toBe("gh-881");
    expect(slug).not.toContain("/");
    expect(slug).not.toContain("#");
    // Tracker-key ids are unchanged, so existing worktrees keep their paths.
    expect(call("ticket_slug", "OPS-123").out).toBe("OPS-123");
  });

  test("slug is idempotent", () => {
    // The lifecycle lock and the prune loop slugify defensively; a
    // non-idempotent slug would produce gh-gh-881 or die on its own output.
    const once = call("ticket_slug", "watt-mind/factory#881").out;
    expect(call("ticket_slug", once).out).toBe(once);
  });

  test("both GitHub forms agree on slug AND port", () => {
    // They resolve to one directory, so a differing port would be a torn
    // allocation: same worktree, two port leases.
    const a = "watt-mind/factory#881";
    const b = "#881";
    expect(call("ticket_slug", a).out).toBe(call("ticket_slug", b).out);
    expect(call("ticket_api_port", a).out).toBe(call("ticket_api_port", b).out);
  });

  test("distinct tickets do not share a port", () => {
    const p = (id) => call("ticket_api_port", id).out;
    expect(p("OPS-123")).not.toBe(p("watt-mind/factory#123"));
    expect(p("OPS-123")).not.toBe(p("OPS-123-scratch"));
  });

  test("ticket_number extracts the number from every form", () => {
    for (const [id, want] of [
      ["OPS-123", "123"],
      ["watt-mind/factory#881", "881"],
      ["#881", "881"],
      ["gh-881", "881"],
    ]) {
      expect(call("ticket_number", id).out).toBe(want);
    }
  });
});
