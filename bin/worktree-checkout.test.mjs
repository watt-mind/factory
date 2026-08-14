import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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

