import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRepos } from "../event-runtime/lib/repos.mjs";
import { loadConfigYaml } from "../lib/schedule.mjs";
import {
  acquireClaimLock,
  observeChildTermination,
  preflightDispatchRepo,
} from "./tick.mjs";

const NOW = 1_750_000_000_000;
const SRC = readFileSync(new URL("./tick.mjs", import.meta.url), "utf8");
const TICK = new URL("./tick.mjs", import.meta.url).pathname;

function withLock(content, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-tick-lock-"));
  const lock = path.join(dir, "repo.dispatch.lock");
  writeFileSync(lock, content);
  try {
    return run(lock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withDispatchRepo(toolchain, run) {
  const root = mkdtempSync(path.join(tmpdir(), "factory-tick-toolchain-"));
  mkdirSync(path.join(root, "config"));
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n  - name: dispatch-fixture\n    path: /tmp/dispatch-fixture\n${toolchain}`,
  );
  try {
    return await run({ name: "dispatch-fixture" }, () => loadRepos({ root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("observeChildTermination", () => {
  test("handles an asynchronous spawn error and settles only once", async () => {
    const child = new EventEmitter();
    const spawnError = Object.assign(new Error("spawn agent ENOENT"), {
      code: "ENOENT",
    });
    const outcomes = [];

    observeChildTermination(child, async (outcome) => {
      outcomes.push(outcome);
    });

    expect(() => child.emit("error", spawnError)).not.toThrow();
    await Promise.resolve();
    child.emit("close", -2);
    await Promise.resolve();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({ error: spawnError, code: null });
  });

  test("handles a real failed spawn without an uncaught exception", async () => {
    const child = spawn("/definitely-not-a-factory-agent-binary", []);
    const outcome = await new Promise((resolve) => {
      observeChildTermination(child, resolve);
    });

    expect(outcome.code).toBeNull();
    expect(outcome.error?.code).toBe("ENOENT");
  });

  test("settles normal child closure without an error", async () => {
    const child = new EventEmitter();
    const outcomes = [];

    observeChildTermination(child, async (outcome) => {
      outcomes.push(outcome);
    });

    child.emit("close", 0);
    await Promise.resolve();

    expect(outcomes).toEqual([{ error: null, code: 0 }]);
  });
});

describe("acquireClaimLock", () => {
  test.each([
    ["empty", ""],
    ["corrupted", "not a lock"],
    ["non-numeric PID", `abc ${NOW}`],
    ["zero PID", `0 ${NOW}`],
    ["negative PID", `-10 ${NOW}`],
    ["fractional PID", `1.5 ${NOW}`],
    ["non-finite timestamp", "123 Infinity"],
  ])("replaces a %s lock without probing its PID", (_name, content) => {
    withLock(content, (lock) => {
      const probed = [];
      const acquired = acquireClaimLock(lock, {
        currentPid: 43210,
        now: () => NOW,
        isProcessAlive: (pid) => {
          probed.push(pid);
          return true;
        },
      });

      expect(acquired).toBe(true);
      expect(probed).toEqual([]);
      expect(readFileSync(lock, "utf8")).toBe(`43210 ${NOW}\n`);
    });
  });

  test("preserves a recent lock held by a live positive integer PID", () => {
    withLock(`123 ${NOW}\n`, (lock) => {
      const probed = [];
      const acquired = acquireClaimLock(lock, {
        currentPid: 43210,
        now: () => NOW + 1_000,
        isProcessAlive: (pid) => {
          probed.push(pid);
          return true;
        },
      });

      expect(acquired).toBe(false);
      expect(probed).toEqual([123]);
      expect(readFileSync(lock, "utf8")).toBe(`123 ${NOW}\n`);
    });
  });
});

// ------------------------------------------- control-plane selection (#880) ---
// The dispatcher read its queue from the repo's control plane and then claimed
// on the WORKSPACE DEFAULT, because the --apply block created a second, bare
// `loadControlPlane()`. After the WM-1006 cutover that meant reading GitHub and
// claiming against Linear with a GitHub identifier:
//   Entity not found: Issue — Could not find referenced Issue.
// It failed safe, but no ticket on a non-default plane could ever dispatch.
describe("tick resolves its control plane from the repo (#880)", () => {
  test("there is no bare loadControlPlane() call", () => {
    // A bare call silently resolves to the workspace default. Two handles in
    // one file is the defect; one handle, built from the repo, is the fix.
    const calls = SRC.split("\n").filter(
      (l) =>
        /loadControlPlane\(\s*\)/.test(l) &&
        !l.trim().startsWith("*") &&
        !l.trim().startsWith("//"),
    );
    expect(calls).toEqual([]);
  });

  test("every loadControlPlane call passes repoName", () => {
    const calls = [...SRC.matchAll(/loadControlPlane\(\{([^}]*)\}/g)].map(
      (m) => m[1],
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toContain("repoName");
  });

  test("the apply path issues no tracker-native GraphQL", () => {
    // viewer / team.states / issueLabels / issueUpdate are Linear-shaped and
    // unanswerable by any other adapter. unclaim() is the rollback that stops a
    // dead run holding a cap slot, so it has to work on every plane.
    for (const shape of [
      "issueLabels(",
      "issueUpdate(",
      "team(id:",
      "query{ viewer{",
    ]) {
      expect(SRC).not.toContain(shape);
    }
  });
});

describe("tick toolchain preflight (#1096)", () => {
  test("normalizes a map-form constraint and refuses before dispatch when it fails", async () => {
    await withDispatchRepo(
      '    toolchain:\n      node: ">=22 <25"\n',
      async (configuredRepo, loadReposFn) => {
        const { repo, gate } = await preflightDispatchRepo(configuredRepo, {
          loadReposFn,
          node: "mac-mini",
          which: async () => "/usr/bin/node",
          spawn: async () => ({
            exitCode: 0,
            stdout: "v18.19.1\n",
            stderr: "",
          }),
        });

        expect(repo.toolchain).toEqual([
          { executable: "node", constraint: ">=22 <25" },
        ]);
        expect(gate.ready).toBe(false);
        expect(gate.refusal).toContain("node >=22 <25 (observed 18.19.1)");
        expect(gate.reasons.map((reason) => reason.reason)).toEqual([
          "repo_toolchain_mismatch",
        ]);
      },
    );
  });

  test("admits a repo whose normalized constraint passes", async () => {
    await withDispatchRepo(
      '    toolchain:\n      bun: ">=1.3 <2"\n',
      async (configuredRepo, loadReposFn) => {
        const { gate } = await preflightDispatchRepo(configuredRepo, {
          loadReposFn,
          node: "runner",
          which: async () => "/opt/bun",
          spawn: async () => ({
            exitCode: 0,
            stdout: "1.3.14\n",
            stderr: "",
          }),
        });

        expect(gate.ready).toBe(true);
        expect(gate.reasons).toEqual([]);
      },
    );
  });

  test("does not probe a repo with no declared toolchain", async () => {
    await withDispatchRepo("", async (configuredRepo, loadReposFn) => {
      const { gate } = await preflightDispatchRepo(configuredRepo, {
        loadReposFn,
        which: async () => {
          throw new Error("a no-toolchain repo must not resolve executables");
        },
        spawn: async () => {
          throw new Error("a no-toolchain repo must not spawn probes");
        },
      });

      expect(gate).toMatchObject({ ready: true, attested: false, reasons: [] });
    });
  });
});

// ------------------------------------------- preflight runs before any claim ---
// The dispatcher is driven as a real child here: the seam test above proves
// the gate's verdict, this proves `main()` honours it before touching a
// control plane. Neither child has a tracker token or a runtime home, so any
// path past the preflight surfaces as "Dispatch error" / exit 1 rather than
// the typed refusal / exit 2 asserted below.
describe("tick preflight refuses before any claim (#1096)", () => {
  // The scheduler entry (`--repo`) comes from the checkout's own repos.yaml;
  // the registry the preflight resolves through comes from FACTORY_REPOS_ROOT.
  // Pointing the latter at a fixture keeps the child hermetic.
  const dispatchable = (loadConfigYaml("repos", { warn: () => {} }).repos ?? [])
    .filter((r) => r?.name && !r.report_only)
    .map((r) => r.name);

  function runTick(registryYaml, repoName) {
    const root = mkdtempSync(path.join(tmpdir(), "factory-tick-preflight-"));
    const home = mkdtempSync(path.join(tmpdir(), "factory-tick-home-"));
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config", "repos.yaml"), registryYaml);
    const env = { ...process.env };
    for (const k of [
      "FACTORY_ROOT",
      "FACTORY_CONTROL_API_TOKEN",
      "FACTORY_WEB_URL",
      "LINEAR_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      delete env[k];
    }
    env.FACTORY_REPOS_ROOT = root;
    env.FACTORY_EVENT_HOME = home;
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [TICK, "--repo", repoName, "--apply", "--max", "1"],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        resolve({ code, stdout, stderr });
      });
    });
  }

  test.skipIf(dispatchable.length === 0)(
    "a failing toolchain constraint exits 2 with the typed refusal",
    async () => {
      const name = dispatchable[0];
      const { code, stdout, stderr } = await runTick(
        `repos:\n  - name: ${name}\n    path: /tmp/${name}-preflight-fixture\n    toolchain:\n      factory-1096-missing-tool: ">=1"\n`,
        name,
      );
      expect(code).toBe(2);
      expect(stderr).toContain("repo_toolchain_missing");
      expect(stderr).not.toContain("Dispatch error");
      // Nothing was read from a queue or claimed: the dispatcher never got to
      // print its banner or a single ticket line.
      expect(stdout).toBe("");
    },
    20_000,
  );

  test.skipIf(dispatchable.length === 0)(
    "a registry that cannot resolve the repo refuses with the RepoError, not a stack",
    async () => {
      const name = dispatchable[0];
      const { code, stdout, stderr } = await runTick(
        "repos:\n  - name: somebody-else\n    path: /tmp/somebody-else\n",
        name,
      );
      expect(code).toBe(2);
      expect(stderr).toContain("dispatch refused");
      expect(stderr).toContain(`repo "${name}" is not in config/repos.yaml`);
      expect(stderr).not.toContain("Dispatch error");
      expect(stderr).not.toMatch(/^\s+at /m);
      expect(stdout).toBe("");
    },
    20_000,
  );

  test("main() keeps `repo` bound to the raw scheduler entry after the preflight", () => {
    // The preflight's normalized registry entry is camelCase; the dispatcher
    // body reads snake_case. Rebinding `repo` to the preflight result broke
    // worktree creation for every dispatch, so only the gate may be taken.
    const mainSrc = SRC.slice(SRC.indexOf("export async function main("));
    expect(mainSrc).toContain("const repo = configuredRepo;");
    expect(mainSrc).not.toMatch(
      /const \{\s*repo\b[^}]*\}\s*=\s*await preflightDispatchRepo/,
    );
    for (const field of [
      "repo.worktree_up",
      "repo.worktree_root",
      "repo.worktree_warm",
      "repo.max_in_flight",
    ]) {
      expect(mainSrc).toContain(field);
    }
    expect(mainSrc).not.toMatch(
      /\brepo\.(worktreeUp|worktreeRoot|worktreeWarm|maxInFlight)\b/,
    );
  });
});
