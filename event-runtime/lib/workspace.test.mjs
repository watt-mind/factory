import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-workspace-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  assertSandboxWorkspaceSupported,
  PathViolation,
  WorktreeSandboxUnsupportedError,
  WorktreeError,
  createWorkspace,
  destroyWorkspace,
  detectWorktreeOwnershipConflict,
  safeJoin,
} from "./workspace.mjs";

function tmpRoot() {
  return tmpDir("evrt-ws-");
}

describe("safeJoin", () => {
  const ws = tmpRoot();

  test("accepts nested relative paths", () => {
    expect(safeJoin(ws, "result.json")).toBe(path.join(ws, "result.json"));
    expect(safeJoin(ws, "logs/agent/output.log")).toBe(
      path.join(ws, "logs", "agent", "output.log"),
    );
  });

  test("rejects absolute paths", () => {
    expect(() => safeJoin(ws, "/etc/passwd")).toThrow(PathViolation);
  });

  test("rejects ../ escapes", () => {
    expect(() => safeJoin(ws, "../outside.txt")).toThrow(PathViolation);
    expect(() => safeJoin(ws, "logs/../../outside.txt")).toThrow(PathViolation);
  });

  test("rejects empty and non-string paths, and the workspace itself", () => {
    expect(() => safeJoin(ws, "")).toThrow(PathViolation);
    expect(() => safeJoin(ws, undefined)).toThrow(PathViolation);
    expect(() => safeJoin(ws, ".")).toThrow(PathViolation);
  });
});

test("detectWorktreeOwnershipConflict identifies the current run's compound lease", () => {
  const root = tmpRoot();
  const databasePath = path.join(root, "runtime.db");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE runs (run_id TEXT, state TEXT, spec_json TEXT);
    CREATE TABLE attempts (run_id TEXT, attempt INTEGER, lease_owner TEXT);
  `);
  const spec = JSON.stringify({ input: { repo: "factory", ticket: "WM-627" } });
  db.query(`INSERT INTO runs VALUES (?, ?, ?)`).run(
    "run_self",
    "RUNNING",
    spec,
  );
  db.query(`INSERT INTO runs VALUES (?, ?, ?)`).run(
    "run_done",
    "COMPLETED",
    spec,
  );
  db.query(`INSERT INTO attempts VALUES (?, ?, ?)`).run(
    "run_self",
    1,
    "worker_self",
  );
  db.close();

  const ownLease = {
    repo: "factory",
    ticket: "WM-627",
    owner: "worker_self:run_self:7",
    pid: process.pid,
  };
  expect(
    detectWorktreeOwnershipConflict({
      repo: "factory",
      ticket: "WM-627",
      runId: "run_self",
      leaseOwner: ownLease.owner,
      databasePath,
      leases: [ownLease],
    }),
  ).toBeNull();

  // The base attempts owner remains supported, but the encoded run id must
  // match. A later run on the same worker is competing ownership.
  expect(
    detectWorktreeOwnershipConflict({
      repo: "factory",
      ticket: "WM-627",
      runId: "run_self",
      leaseOwner: "worker_self",
      databasePath,
      leases: [ownLease],
    }),
  ).toBeNull();
  expect(
    detectWorktreeOwnershipConflict({
      repo: "factory",
      ticket: "WM-627",
      runId: "run_self",
      leaseOwner: "worker_self",
      databasePath,
      leases: [{ ...ownLease, owner: "worker_self:run_other:8" }],
    })?.leases,
  ).toEqual([{ owner: "worker_self:run_other:8", pid: process.pid }]);

  expect(
    detectWorktreeOwnershipConflict({
      repo: "factory",
      ticket: "WM-627",
      runId: "run_self",
      leaseOwner: ownLease.owner,
      databasePath,
      leases: [{ ...ownLease, pid: process.pid + 1 }],
    })?.leases,
  ).toEqual([{ owner: ownLease.owner, pid: process.pid + 1 }]);

  const competingDb = new Database(databasePath);
  competingDb
    .query(`INSERT INTO runs VALUES (?, ?, ?)`)
    .run("run_other", "FAILED", spec);
  competingDb.close();
  const conflict = detectWorktreeOwnershipConflict({
    repo: "factory",
    ticket: "WM-627",
    runId: "run_self",
    leaseOwner: ownLease.owner,
    databasePath,
    leases: [ownLease],
  });
  expect(conflict).toMatchObject({
    runs: [{ runId: "run_other", state: "FAILED" }],
    leases: [],
  });
});

describe("createWorkspace / destroyWorkspace", () => {
  test("creates <runId>-a<attempt> and writes canonical input.json", () => {
    const root = tmpRoot();
    const { dir } = createWorkspace({
      root,
      runId: "run_x",
      attempt: 1,
      input: { b: 2, a: 1 },
    });
    expect(dir).toBe(path.join(root, "run_x-a1"));
    expect(readFileSync(path.join(dir, "input.json"), "utf8")).toBe(
      '{"a":1,"b":2}\n',
    );
  });

  test("destroy removes the directory; retain leaves it and returns false", () => {
    const root = tmpRoot();
    const { dir } = createWorkspace({
      root,
      runId: "run_y",
      attempt: 1,
      input: {},
    });
    expect(destroyWorkspace(dir, { retain: true })).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});

// Tier-2 delegation (docs/event-runtime-dispatch.md §5, WM-108): the runtime
// never implements worktrees — it shells to the scripts each repo declares in
// config/repos.yaml. These fixtures stand in fake scripts that log every call,
// so the tests prove exactly when up/down ran and when they deliberately did not.
describe("worktree workspaces (WM-108)", () => {
  let factoryRoot;
  let repoDir;
  let wtRoot;
  let callsLog;
  let previousReposRoot;

  const calls = () =>
    existsSync(callsLog)
      ? readFileSync(callsLog, "utf8").trim().split("\n")
      : [];

  beforeAll(() => {
    factoryRoot = tmpDir("evrt-wt-factory-");
    repoDir = realpathSync(tmpDir("evrt-wt-repo-"));
    wtRoot = realpathSync(tmpDir("evrt-wt-trees-"));
    callsLog = path.join(repoDir, "calls.log");

    mkdirSync(path.join(repoDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up.sh"),
      `#!/bin/bash\nset -e\nWT="${wtRoot}/$1"\necho "up $1 cwd=$PWD" >> "${callsLog}"\nif [[ -e "$WT/ports" || -e "$WT/run/serve.pid" || -e "$WT/run/worker.pid" || -e "$WT/run/web.pid" ]]; then\n  echo "stale daemon state for $1" >&2\n  exit 9\nfi\nmkdir -p "$WT/run"\nprintf '7740 7741\\n' > "$WT/ports"\ntouch "$WT/run/serve.pid" "$WT/run/worker.pid" "$WT/run/web.pid"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down.sh"),
      `#!/bin/bash\nset -e\nWT="${wtRoot}/$1"\necho "down $1" >> "${callsLog}"\nrm -f "$WT/ports" "$WT/run/serve.pid" "$WT/run/worker.pid" "$WT/run/web.pid"\nif [[ -f "$WT/debug-change" ]]; then\n  echo "refusing: dirty tree" >&2\n  exit 1\nfi\nrm -rf "$WT"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-broken.sh"),
      `#!/bin/bash\necho "starting worktree setup"\nprintf '\\033[33mwarn:\\033[0m recorded port 7740 is occupied — allocating a free pair\\n' >&2\nprintf '\\033[33mwarn:\\033[0m web port 7741 is occupied — trying next pair\\n' >&2\necho "fatal: template failed to build" >&2\nexit 7\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-warnings-only.sh"),
      `#!/bin/bash\necho "warn: recovered once" >&2\necho "warn: recovered twice" >&2\nexit 8\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-empty.sh"),
      `#!/bin/bash\nexit 0\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-hanging.sh"),
      `#!/bin/bash\nwhile :; do :; done\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down-hanging.sh"),
      `#!/bin/bash\nwhile :; do :; done\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-red-baseline.sh"),
      `#!/bin/bash\nset -e\nmkdir -p "${wtRoot}/$1"\nprintf '%s\\n' '{"status":"red","check":"web_build","command":"bun run build:fast","exitCode":1,"output":"entry chunk exceeds budget"}' > "$FACTORY_WORKTREE_REPORT"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-recovered.sh"),
      `#!/bin/bash\nset -e\necho "up-recovered $1" >> "${callsLog}"\nmkdir -p "${wtRoot}/$1"\nprintf '%s\\n' '{"ref":"wip/WM-13-20260817T183000Z","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","push":"local_only","pushError":"offline"}' > "$FACTORY_WORKTREE_PRESERVATION_REPORT"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down-refuse.sh"),
      `#!/bin/bash\necho "warn: cleanup probe used fallback" >&2\necho "fatal: refusing dirty tree" >&2\nexit 1\n`,
    );

    mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(factoryRoot, "config", "repos.yaml"),
      `repos:\n` +
        `  - name: wtrepo\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo verified\n` +
        `  - name: broken-up\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up-broken.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: warnings-only-up\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up-warnings-only.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: empty-up\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up-empty.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: hanging-up\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up-hanging.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: hanging-down\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down-hanging.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: red-baseline\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up-red-baseline.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: bun test\n` +
        `  - name: recovered-up\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up-recovered.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: bun test\n` +
        `  - name: refusing-down\n    path: ${repoDir}\n    base: develop\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down-refuse.sh\n` +
        `    worktree_root: ${wtRoot}\n` +
        `  - name: noscripts\n    path: ${repoDir}\n    base: develop\n`,
    );
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = factoryRoot;
  });

  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });

  const make = (repo, ticket, runId, extra = {}) =>
    createWorkspace({
      root: tmpRoot(),
      runId,
      attempt: 1,
      input: { repo, ticket },
      workspace: { type: "worktree" },
      ...extra,
    });

  test("up is delegated to the repo's script; the tree is reachable at ./repo; verify rides along", () => {
    const { dir, worktree } = make("wtrepo", "WM-1", "run_wt1");
    expect(calls()).toContainEqual(`up WM-1 cwd=${repoDir}`);
    expect(worktree).toEqual({
      repo: "wtrepo",
      ticket: "WM-1",
      path: path.join(wtRoot, "WM-1"),
      repoPath: repoDir,
      down: "bin/worktree-down.sh",
      verify: "echo verified",
      // WM-718: the handoff gate diffs against `base` and holds the PR by
      // its GitHub slug (null when repos.yaml declares none).
      base: "develop",
      github: null,
    });
    const link = path.join(dir, "repo");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(path.join(wtRoot, "WM-1"));
    expect(
      JSON.parse(readFileSync(path.join(dir, ".worktree.json"), "utf8")).ticket,
    ).toBe("WM-1");
    expect(destroyWorkspace(dir)).toBe(true);
  });

  test("a sandboxed definition is refused when the workspace carries a worktree marker", () => {
    const { dir } = make("wtrepo", "WM-1-SANDBOX", "run_wt1_sandbox");
    expect(() =>
      assertSandboxWorkspaceSupported(dir, {
        sandbox: { provider: "gondolin" },
      }),
    ).toThrow(WorktreeSandboxUnsupportedError);
    try {
      assertSandboxWorkspaceSupported(dir, {
        sandbox: { provider: "gondolin" },
      });
    } catch (err) {
      expect(err.code).toBe("worktree_sandbox_unsupported");
      expect(err.workspaceDir).toBe(dir);
    }
    expect(() => assertSandboxWorkspaceSupported(dir, {})).not.toThrow();
    expect(destroyWorkspace(dir)).toBe(true);
  });

  test("destroy runs worktree_down, then removes the workspace — completion and failure teardown are the same path", () => {
    const { dir } = make("wtrepo", "WM-2", "run_wt2");
    expect(existsSync(path.join(wtRoot, "WM-2"))).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true);
    expect(calls()).toContain("down WM-2");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(wtRoot, "WM-2"))).toBe(false);
  });

  test("retainOnFailure stops daemons and clears ports while dirty worktree files remain inspectable", () => {
    const { dir } = make("wtrepo", "WM-3", "run_wt3");
    const tree = path.join(wtRoot, "WM-3");
    writeFileSync(path.join(tree, "debug-change"), "keep me\n");

    expect(destroyWorkspace(dir, { retain: true })).toBe(false);
    expect(calls()).toContain("down WM-3");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(tree)).toBe(true);
    expect(readFileSync(path.join(tree, "debug-change"), "utf8")).toBe(
      "keep me\n",
    );
    expect(existsSync(path.join(tree, "ports"))).toBe(false);
    expect(existsSync(path.join(tree, "run", "serve.pid"))).toBe(false);
    expect(existsSync(path.join(tree, "run", "worker.pid"))).toBe(false);
    expect(existsSync(path.join(tree, "run", "web.pid"))).toBe(false);
  });

  test("a clean retained failure can be redispatched and its workspace later removed", () => {
    const { dir } = make("wtrepo", "WM-12", "run_wt12");
    expect(destroyWorkspace(dir, { retain: true })).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(dir, ".worktree.json"))).toBe(false);
    expect(existsSync(path.join(wtRoot, "WM-12"))).toBe(false);

    const retry = make("wtrepo", "WM-12", "run_wt12_retry");
    expect(calls().filter((call) => call.startsWith("up WM-12 "))).toHaveLength(
      2,
    );
    expect(destroyWorkspace(retry.dir)).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true);
  });

  test("a refusing worktree_down retains everything, with a filtered reason and raw evidence", () => {
    const { dir } = make("refusing-down", "WM-4", "run_wt4");
    expect(destroyWorkspace(dir, { retain: true })).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(wtRoot, "WM-4"))).toBe(true);
    const { downFailure } = JSON.parse(
      readFileSync(path.join(dir, ".worktree.json"), "utf8"),
    );
    expect(downFailure.reason).toBe("fatal: refusing dirty tree");
    expect(downFailure.reason).not.toContain("warn:");
    expect(downFailure.stderr).toContain("warn: cleanup probe used fallback");
    expect(downFailure.stderr).toContain("fatal: refusing dirty tree");
  });

  test("a timed-out worktree_down retains the workspace without hanging", () => {
    const { dir } = make("hanging-down", "WM-10", "run_wt10");
    const started = Date.now();
    expect(destroyWorkspace(dir, { worktreeTimeoutMs: 25 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(wtRoot, "WM-10"))).toBe(true);
  });

  test("a live competing run or lease refuses an existing tree before worktree_up", () => {
    const tree = path.join(wtRoot, "WM-13");
    mkdirSync(tree, { recursive: true });
    const before = calls().filter((call) =>
      call.startsWith("up WM-13 "),
    ).length;

    expect(() =>
      make("wtrepo", "WM-13", "run_wt13", {
        worktreeOwnershipConflict: () => ({
          reason: "ticket has a non-terminal run or live worker lease",
          runs: [{ runId: "run_other", state: "RUNNING" }],
          leases: [{ owner: "worker_other", pid: 42 }],
        }),
      }),
    ).toThrow(/worktree_in_use/);
    expect(calls().filter((call) => call.startsWith("up WM-13 "))).toHaveLength(
      before,
    );
    expect(existsSync(tree)).toBe(true);
  });

  test("a recovered wip ref is journaled in the workspace marker/input and commented once", () => {
    const comments = [];
    const { dir, worktree } = make(
      "recovered-up",
      "WM-13",
      "run_wt13_recovered",
      {
        worktreeOwnershipConflict: () => null,
        worktreePreservationComment: (entry) => {
          comments.push(entry);
          return { status: "posted" };
        },
      },
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      repo: "recovered-up",
      ticket: "WM-13",
      preservation: { ref: "wip/WM-13-20260817T183000Z", push: "local_only" },
    });
    expect(worktree.preservedWip).toMatchObject({
      ref: "wip/WM-13-20260817T183000Z",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      push: "local_only",
      comment: { status: "posted" },
    });
    expect(
      JSON.parse(readFileSync(path.join(dir, ".worktree.json"), "utf8"))
        .preservedWip,
    ).toEqual(worktree.preservedWip);
    expect(
      JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8"))
        .worktreeRecovery,
    ).toMatchObject({
      ref: "wip/WM-13-20260817T183000Z",
      guidance: expect.stringContaining("abandoned prior attempt"),
    });
    expect(destroyWorkspace(dir)).toBe(true);
  });

  test("a red baseline is recorded in the marker and agent input without aborting workspace creation", () => {
    const { dir, worktree } = make("red-baseline", "WM-5", "run_wt5");
    expect(worktree.baseline).toMatchObject({
      status: "red",
      check: "web_build",
      exitCode: 1,
      output: "entry chunk exceeds budget",
    });
    expect(
      JSON.parse(readFileSync(path.join(dir, ".worktree.json"), "utf8"))
        .baseline,
    ).toEqual(worktree.baseline);
    expect(
      JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8")),
    ).toMatchObject({
      repo: "red-baseline",
      ticket: "WM-5",
      baseline: {
        status: "red",
        check: "web_build",
        output: "entry chunk exceeds budget",
        guidance: expect.stringContaining("already fails at this commit"),
      },
    });
    expect(existsSync(path.join(dir, "repo"))).toBe(true);
    expect(destroyWorkspace(dir)).toBe(true);
  });

  test("a failing worktree_up excludes warnings from its reason and preserves raw evidence", () => {
    const root = tmpRoot();
    const workspaceDir = path.join(root, "run_wt8-a1");
    try {
      createWorkspace({
        root,
        runId: "run_wt8",
        attempt: 1,
        input: { repo: "broken-up", ticket: "WM-8" },
        workspace: { type: "worktree" },
      });
      throw new Error("expected WorktreeError");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeError);
      expect(err.code).toBe("workspace_provisioning_error");
      expect(err.message).toContain("fatal: template failed to build");
      expect(err.message).not.toContain("warn:");
      expect(err.evidence.status).toBe(7);
      expect(err.evidence.stdout).toBe("starting worktree setup\n");
      expect(err.evidence.stderr).toContain("warn:");
      expect(err.evidence.stderr).toContain("recorded port 7740");
      const { upFailure } = JSON.parse(
        readFileSync(path.join(workspaceDir, ".worktree.json"), "utf8"),
      );
      expect(upFailure.reason).toBe("fatal: template failed to build");
      expect(upFailure.status).toBe(7);
      expect(upFailure.stdout).toBe(err.evidence.stdout);
      expect(upFailure.stderr).toBe(err.evidence.stderr);
    }
  });

  test("a worktree_up failure with only warnings reports an explicit no-error fallback", () => {
    try {
      make("warnings-only-up", "WM-12", "run_wt12");
      throw new Error("expected WorktreeError");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeError);
      expect(err.message).toContain("exit 8, no error output");
      expect(err.message).not.toContain("warn:");
      expect(err.evidence.stderr).toContain("warn: recovered once");
    }
  });

  test("a zero-exit script that created no worktree is still a provisioning failure", () => {
    expect(() => make("empty-up", "WM-9", "run_wt9")).toThrow(/did not create/);
  });

  test("a timed-out worktree_up raises a typed error and leaves teardown facts for the janitor", () => {
    const root = tmpRoot();
    const workspaceDir = path.join(root, "run_wt11-a1");
    const previous = process.env.FACTORY_WORKTREE_SCRIPT_TIMEOUT_MS;
    process.env.FACTORY_WORKTREE_SCRIPT_TIMEOUT_MS = "25";
    const started = Date.now();
    try {
      try {
        createWorkspace({
          root,
          runId: "run_wt11",
          attempt: 1,
          input: { repo: "hanging-up", ticket: "WM-11" },
          workspace: { type: "worktree" },
        });
        throw new Error("expected WorktreeError");
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeError);
        expect(err.code).toBe("workspace_provisioning_error");
        expect(err.message).toContain("timed out after 25ms");
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(
          JSON.parse(
            readFileSync(path.join(workspaceDir, ".worktree.json"), "utf8"),
          ),
        ).toMatchObject({
          repo: "hanging-up",
          ticket: "WM-11",
          down: "bin/worktree-down.sh",
        });
      }
    } finally {
      if (previous === undefined)
        delete process.env.FACTORY_WORKTREE_SCRIPT_TIMEOUT_MS;
      else process.env.FACTORY_WORKTREE_SCRIPT_TIMEOUT_MS = previous;
    }
  });

  test("a repo with no declared scripts fails typed, not with a crash mid-spawn", () => {
    expect(() => make("noscripts", "WM-6", "run_wt6")).toThrow(WorktreeError);
    expect(() => make("noscripts", "WM-6", "run_wt6")).toThrow(
      /declares no worktree lifecycle/,
    );
  });

  test("missing input.repo or input.ticket is a typed error", () => {
    expect(() =>
      createWorkspace({
        root: tmpRoot(),
        runId: "run_wt7",
        attempt: 1,
        input: { repo: "wtrepo" },
        workspace: { type: "worktree" },
      }),
    ).toThrow(/input.repo and input.ticket/);
  });
});
