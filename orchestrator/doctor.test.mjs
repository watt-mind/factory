/**
 * bun test orchestrator/doctor.test.mjs
 *
 * WM-670: the UX critic's browser gate was silently dead for a day because
 * pi's chrome-devtools extension launched Chrome headed on a display-less
 * Linux runner. These tests pin the two doctor checks that make that visible:
 * the headless wrapper really binds a DevTools port, and the extension is
 * pointed at it. Fakes stand in for Chrome wherever the outcome must be
 * deterministic; the one real launch is skipped when no browser is installed
 * or when headless Chrome does not bind a DevTools port in time (WM-861:
 * unbounded spawnSync of the real macOS app bundle hung `bun test` forever).
 */
import { test, expect, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browserLaunchCheck,
  browserMissingDependency,
  piChromeDevtoolsCheck,
  CHROME_HEADLESS_WRAPPER,
} from "./doctor-browser.mjs";
import {
  BASE_BRANCH_CI_AGGREGATE_TIMEOUT_MS,
  BASE_BRANCH_CI_RUN_LIMIT,
  BASE_BRANCH_CI_TIMEOUT_MS,
  baseBranchCiDiagnostics,
  compareCliVersions,
  chainAutoApprovalPolicyDiagnostic,
  defaultControlApiProbe,
  MIN_BUN_VERSION,
  MIN_GIT_VERSION,
  ossOnboardingDiagnostics,
  parseCliVersion,
  repoToolchainDiagnostics,
  stackDaemonDiagnostics,
  factoryCommandLinkDiagnostic,
} from "./doctor.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
// The wrapper from THIS checkout, not the installed factory root — a worktree
// must test its own copy of the script.
const WRAPPER = path.join(HERE, "..", "bin", "chrome-headless.sh");

const scratch = () => mkdtempSync(path.join(tmpdir(), "doctor-test-"));
const fakeChrome = (dir, body) => {
  const p = path.join(dir, "chrome");
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

test("imports exported helpers without materialized instance config", () => {
  const root = scratch();
  mkdirSync(path.join(root, "tools"), { recursive: true });
  // `doctor.mjs` calls `factoryRoot()`, which recognizes FACTORY_ROOT only
  // when its `tools/ticket.mjs` marker resolves. This empty marker lets the
  // import use this deliberately config-less root; no Linear exports execute
  // while importing doctor, so fixture content is unnecessary.
  writeFileSync(path.join(root, "tools", "ticket.mjs"), "");

  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `import(${JSON.stringify(new URL("./doctor.mjs", import.meta.url).href)})`,
    ],
    cwd: root,
    env: { ...process.env, FACTORY_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stderr)).not.toContain(
    "instance_config_missing",
  );
});

describe("base branch CI diagnostics (#1928)", () => {
  const repo = {
    name: "factory",
    github: "watt-mind/factory",
    base: "develop",
  };

  test("reports a successful latest completed run with the bounded shared reader", () => {
    const calls = [];
    const rows = baseBranchCiDiagnostics({
      repos: [repo],
      runList: (name, options) => {
        calls.push({ name, options });
        return [
          { status: "queued" },
          {
            status: "completed",
            conclusion: "success",
            databaseId: 42,
            workflowName: "CI",
            url: "https://github.com/watt-mind/factory/actions/runs/42",
          },
        ];
      },
    });

    expect(calls).toEqual([
      {
        name: "watt-mind/factory",
        options: {
          branch: "develop",
          limit: BASE_BRANCH_CI_RUN_LIMIT,
          timeout: BASE_BRANCH_CI_TIMEOUT_MS,
        },
      },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        ok: true,
        label: "base branch CI",
        detail: expect.stringContaining("CI succeeded"),
      }),
    ]);
  });

  test("warns with workflow and run URL when the latest completed run is red", () => {
    const rows = baseBranchCiDiagnostics({
      repos: [repo],
      runList: () => [
        {
          status: "completed",
          conclusion: "failure",
          workflowName: "CI",
          url: "https://github.com/watt-mind/factory/actions/runs/99",
        },
      ],
    });

    expect(rows[0]).toMatchObject({ ok: "warn", label: "base branch CI" });
    expect(rows[0].detail).toContain("CI failure");
    expect(rows[0].detail).toContain("actions/runs/99");
  });

  test.each(["skipped", "neutral"])(
    "reports a %s latest completed run as informational",
    (conclusion) => {
      const rows = baseBranchCiDiagnostics({
        repos: [repo],
        runList: () => [
          {
            status: "completed",
            conclusion,
            workflowName: "CI",
            databaseId: 99,
          },
        ],
      });

      expect(rows).toEqual([
        expect.objectContaining({
          ok: "info",
          detail: expect.stringContaining(`CI ${conclusion}`),
          fix: null,
        }),
      ]);
    },
  );

  test("does not start a read after the shared aggregate deadline", () => {
    const calls = [];
    const rows = baseBranchCiDiagnostics({
      repos: [repo],
      deadlineMs: 1_000,
      now: () => 1_000,
      runList: (...args) => calls.push(args),
    });

    expect(calls).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({
        ok: "info",
        detail: expect.stringContaining("aggregate GitHub Actions deadline"),
      }),
    ]);
  });

  test("gives a later repository a CI signal after a slow earlier read", () => {
    const laterRepo = {
      name: "later",
      github: "watt-mind/later",
      base: "main",
    };
    let elapsedMs = 0;
    const calls = [];
    const rows = baseBranchCiDiagnostics({
      repos: [repo, laterRepo],
      deadlineMs: BASE_BRANCH_CI_AGGREGATE_TIMEOUT_MS,
      now: () => elapsedMs,
      runList: (name, options) => {
        calls.push({ name, options });
        if (name === repo.github) {
          elapsedMs += BASE_BRANCH_CI_TIMEOUT_MS;
          return [];
        }
        return [
          {
            status: "completed",
            conclusion: "success",
            workflowName: "CI",
            databaseId: 42,
          },
        ];
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({ name: repo.github }),
      expect.objectContaining({
        name: laterRepo.github,
        options: expect.objectContaining({
          timeout: BASE_BRANCH_CI_TIMEOUT_MS,
        }),
      }),
    ]);
    expect(rows[1]).toEqual(
      expect.objectContaining({
        ok: true,
        detail: expect.stringContaining("CI succeeded"),
      }),
    );
  });

  test("keeps the aggregate budget above the per-repository cap", () => {
    expect(BASE_BRANCH_CI_AGGREGATE_TIMEOUT_MS).toBeGreaterThan(
      BASE_BRANCH_CI_TIMEOUT_MS,
    );
  });

  test("skips without failing when Actions has no completed history", () => {
    const rows = baseBranchCiDiagnostics({ repos: [repo], runList: () => [] });

    expect(rows).toEqual([
      expect.objectContaining({
        ok: "info",
        detail: "develop — skipped, no completed Actions history",
      }),
    ]);
  });
});

describe("factory command link diagnostic (#1950)", () => {
  const expectedCommands = () =>
    readdirSync(path.join(HERE, "..", "shared", "commands"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.basename(file, ".md"));

  const setupLinkedCommands = (dir, names) => {
    const commandsDir = path.join(dir, ".claude", "commands");
    mkdirSync(commandsDir, { recursive: true });
    for (const name of names) {
      symlinkSync(
        path.join(HERE, "..", "shared", "commands", `${name}.md`),
        path.join(commandsDir, `${name}.md`),
      );
    }
    return commandsDir;
  };

  test("passes when every expected command is linked", () => {
    const dir = scratch();
    const names = expectedCommands();
    const commandsDir = setupLinkedCommands(dir, names);

    expect(
      factoryCommandLinkDiagnostic({ commandsDir, expectedCommands: names }),
    ).toEqual({
      ok: true,
      label: "/factory-* commands linked",
      detail: `${names.length} commands`,
      fix: null,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  test("warns with the existing emit hint when a command link is missing", () => {
    const dir = scratch();
    const names = expectedCommands();
    const commandsDir = setupLinkedCommands(dir, names);
    const missing = names[0];
    unlinkSync(path.join(commandsDir, `${missing}.md`));

    expect(
      factoryCommandLinkDiagnostic({ commandsDir, expectedCommands: names }),
    ).toEqual({
      ok: "warn",
      label: "/factory-* commands linked",
      detail: `1/${names.length} missing or broken: ${missing}`,
      fix: "factory emit",
    });

    rmSync(dir, { recursive: true, force: true });
  });

  test("warns with the existing emit hint when a command link is dangling", () => {
    const dir = scratch();
    const names = expectedCommands();
    const commandsDir = setupLinkedCommands(dir, names);
    const broken = names[0];
    const target = path.join(commandsDir, `${broken}.md`);
    unlinkSync(target);
    symlinkSync(path.join(dir, "missing-target.md"), target);

    expect(
      factoryCommandLinkDiagnostic({ commandsDir, expectedCommands: names }),
    ).toEqual({
      ok: "warn",
      label: "/factory-* commands linked",
      detail: `1/${names.length} missing or broken: ${broken}`,
      fix: "factory emit",
    });

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("OSS onboarding diagnostics (WM-957)", () => {
  test("parses and compares ordinary CLI versions", () => {
    expect(parseCliVersion("bun 1.1.4")).toEqual([1, 1, 4]);
    expect(parseCliVersion("git version 2.40")).toEqual([2, 40, 0]);
    expect(parseCliVersion("unknown")).toBeNull();
    expect(compareCliVersions("1.1.0", MIN_BUN_VERSION)).toBe(0);
    expect(compareCliVersions("2.39.9", MIN_GIT_VERSION)).toBe(-1);
    expect(compareCliVersions("2.40.1", MIN_GIT_VERSION)).toBe(1);
  });

  test("reports versions, GitHub authentication, harnesses, and Docker", () => {
    const commands = {
      "bun --version": { status: 0, stdout: "1.1.8\n" },
      "git --version": { status: 0, stdout: "git version 2.40.1\n" },
      "gh --version": { status: 0, stdout: "gh version 2.70.0\n" },
      "gh auth status": { status: 0, stderr: "github.com\n  ✓ Logged in\n" },
      "claude --version": { status: 0, stdout: "2.0.1\n" },
      "codex --version": { status: 1 },
      "gemini --version": { status: 1 },
      "cursor --version": { status: 1 },
      "pi --version": { status: 0, stdout: "pi 0.48.0\n" },
      "docker info --format '{{.ServerVersion}}'": {
        status: 0,
        stdout: "28.0.1\n",
      },
      "colima status": { status: 1 },
      "command -v tart || command -v vfkit || command -v limactl": {
        status: 1,
      },
    };
    const diagnostics = ossOnboardingDiagnostics({
      run: (command) => commands[command] ?? { status: 1 },
      controlPlaneKind: "github",
    });
    expect(diagnostics.find((d) => d.label === "bun")?.ok).toBe(true);
    expect(diagnostics.find((d) => d.label === "git")?.ok).toBe(true);
    expect(
      diagnostics.find((d) => d.label === "GitHub authentication")?.ok,
    ).toBe(true);
    expect(
      diagnostics.find((d) => d.label === "GitHub control plane")?.ok,
    ).toBe(true);
    expect(diagnostics.find((d) => d.label === "harness: pi")?.detail).toBe(
      "pi 0.48.0",
    );
    expect(diagnostics.find((d) => d.label === "harness: codex")?.ok).toBe(
      "warn",
    );
    expect(
      diagnostics.find((d) => d.label === "worktree isolation")?.detail,
    ).toBe("Docker engine 28.0.1");
  });

  test("supplies actionable remediation for old tools, missing auth, Linear, and isolation", () => {
    const diagnostics = ossOnboardingDiagnostics({
      run: (command) => {
        if (command === "bun --version") return { status: 0, stdout: "1.0.0" };
        if (command === "git --version")
          return { status: 0, stdout: "git version 2.39.0" };
        return { status: 1, stderr: "missing" };
      },
      controlPlaneKind: "linear",
      linearConfigured: false,
    });
    expect(diagnostics.find((d) => d.label === "bun")).toMatchObject({
      ok: false,
    });
    expect(
      diagnostics.find((d) => d.label === "GitHub authentication")?.fix,
    ).toContain("gh auth login");
    expect(
      diagnostics.find((d) => d.label === "Linear control plane")?.fix,
    ).toContain("LINEAR_API_KEY");
    expect(diagnostics.find((d) => d.label === "worktree isolation")?.ok).toBe(
      "warn",
    );
  });
});

describe("repo toolchain diagnostics (#1097)", () => {
  test("declared-and-passing: map-form toolchain prints constraint and observed version", async () => {
    let probes = 0;
    const rows = await repoToolchainDiagnostics({
      repos: [{ name: "demo", toolchain: { bun: ">=1.3 <2", git: ">=2.40" } }],
      which: async (executable) => {
        probes += 1;
        return { bun: "/opt/bun", git: "/usr/bin/git" }[executable] ?? null;
      },
      spawn: async ([resolved]) => {
        probes += 1;
        return {
          exitCode: 0,
          stdout:
            {
              "/opt/bun": "1.3.14\n",
              "/usr/bin/git": "git version 2.45.1\n",
            }[resolved] ?? "",
          stderr: "",
        };
      },
    });
    expect(probes).toBeGreaterThan(0);
    expect(rows).toEqual([
      {
        ok: true,
        label: "toolchain bun",
        detail: ">=1.3 <2  observed 1.3.14",
        fix: null,
      },
      {
        ok: true,
        label: "toolchain git",
        detail: ">=2.40  observed 2.45.1",
        fix: null,
      },
    ]);
  });

  test("declared-and-mismatched: missing and out-of-range are doctor problems with the reason's action", async () => {
    const rows = await repoToolchainDiagnostics({
      repos: [{ name: "demo", toolchain: { bun: ">=1.3 <2", uv: ">=0.5" } }],
      which: async (executable) => (executable === "bun" ? "/opt/bun" : null),
      spawn: async () => ({ exitCode: 0, stdout: "1.1.45\n", stderr: "" }),
    });
    expect(rows).toHaveLength(2);
    const bun = rows.find((r) => r.label === "toolchain bun");
    const uv = rows.find((r) => r.label === "toolchain uv");
    expect(bun).toMatchObject({
      ok: false,
      detail: ">=1.3 <2  observed 1.1.45",
    });
    expect(bun.fix).toContain("make bun >=1.3 <2");
    expect(uv).toMatchObject({
      ok: false,
      label: "toolchain uv",
      detail: ">=0.5  missing",
    });
    expect(uv.fix).toContain("install uv >=0.5");
  });

  test("a throwing version probe yields a red row and later tools are still diagnosed", async () => {
    const rows = await repoToolchainDiagnostics({
      repos: [{ name: "demo", toolchain: { broken: ">=1", bun: ">=1.3 <2" } }],
      which: async (executable) => `/opt/${executable}`,
      spawn: async ([resolved]) => {
        if (resolved === "/opt/broken") throw new Error("permission denied");
        return { exitCode: 0, stdout: "1.3.14\n", stderr: "" };
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        ok: false,
        label: "toolchain broken",
        detail: ">=1  observed permission denied",
      }),
      expect.objectContaining({
        ok: true,
        label: "toolchain bun",
      }),
    ]);
  });

  test("not-declared: no new rows and no probe is spawned", async () => {
    let probes = 0;
    const counted = {
      which: async () => {
        probes += 1;
        return "/opt/bun";
      },
      spawn: async () => {
        probes += 1;
        return { exitCode: 0, stdout: "1.3.14\n", stderr: "" };
      },
    };
    const absent = await repoToolchainDiagnostics({
      repos: [{ name: "bare", path: "/tmp/bare" }],
      ...counted,
    });
    const emptyBlock = await repoToolchainDiagnostics({
      repos: [{ name: "empty", toolchain: {} }],
      ...counted,
    });
    expect(absent).toEqual([]);
    expect(emptyBlock).toEqual([]);
    expect(probes).toBe(0);
  });

  test("malformed block: yields a red toolchain check instead of throwing", async () => {
    let probes = 0;
    const rows = await repoToolchainDiagnostics({
      repos: [
        { name: "broken", toolchain: "bun>=1.3" },
        { name: "fine", toolchain: { bun: ">=1.0" } },
      ],
      which: async () => "/opt/bun",
      spawn: async () => {
        probes += 1;
        return { exitCode: 0, stdout: "1.3.14\n", stderr: "" };
      },
    });
    expect(rows[0]).toMatchObject({ ok: false, label: "toolchain" });
    expect(rows[0].detail).toContain("repo broken toolchain must be a map");
    expect(rows[0].fix).toContain("broken");
    // Doctor keeps going: the next repo is still probed.
    expect(rows[1]).toMatchObject({ ok: true, label: "toolchain bun" });
    expect(probes).toBe(1);
  });
});

describe("stack daemon diagnostics (#1868)", () => {
  const root = "/factory/stack";
  const appEnv = {
    FACTORY_GH_APP_ID: "123",
    FACTORY_GH_APP_INSTALLATION_ID: "456",
    FACTORY_GH_APP_PRIVATE_KEY_PATH: "/tmp/app.pem",
  };
  const absentPidFile = () => {
    const error = new Error("not found");
    error.code = "ENOENT";
    throw error;
  };
  const pidFileFor = (pid) => (file) =>
    file.endsWith("gh-app-auth.pid") ? `${pid}\n` : absentPidFile();

  test("fails when configured App auth has no daemon", () => {
    const rows = stackDaemonDiagnostics({
      root,
      env: appEnv,
      listProcesses: () => [],
      readPidFile: absentPidFile,
    });
    expect(rows).toContainEqual({
      ok: false,
      label: "gh-app-auth daemon",
      detail: "GitHub App auth is configured but no daemon is running",
      fix: "run `factory up` to start gh-app-auth.mjs --daemon",
    });
    expect(
      rows.find((row) => row.label === "serve.pid identity"),
    ).toMatchObject({
      ok: "warn",
      detail: expect.stringContaining("not applicable"),
    });
  });

  test("ignores a foreign daemon when this stack's pidfile owns a healthy daemon", () => {
    const rows = stackDaemonDiagnostics({
      root,
      env: appEnv,
      listProcesses: () => [
        {
          pid: 41,
          command:
            "bun /factory/stack/lib/control-plane/gh-app-auth.mjs --daemon",
        },
        {
          pid: 42,
          command:
            "bun /factory/other/lib/control-plane/gh-app-auth.mjs --daemon",
        },
      ],
      readPidFile: pidFileFor(41),
      probeProcess: (pid) => ({
        alive: true,
        command: `bun ${pid === 41 ? root : "/factory/other"}/lib/control-plane/gh-app-auth.mjs --daemon`,
      }),
    });
    expect(rows.find((row) => row.label === "gh-app-auth daemon")).toEqual({
      ok: true,
      label: "gh-app-auth daemon",
      detail: "one daemon running (pid 41)",
      fix: null,
    });
  });

  test("fails when a foreign daemon exists but this stack's daemon is missing", () => {
    const rows = stackDaemonDiagnostics({
      root,
      env: appEnv,
      listProcesses: () => [
        {
          pid: 41,
          command:
            "bun /factory/other/lib/control-plane/gh-app-auth.mjs --daemon",
        },
      ],
      readPidFile: absentPidFile,
    });
    expect(rows.find((row) => row.label === "gh-app-auth daemon")).toEqual({
      ok: false,
      label: "gh-app-auth daemon",
      detail: "GitHub App auth is configured but no daemon is running",
      fix: "run `factory up` to start gh-app-auth.mjs --daemon",
    });
  });

  test("fails when this stack's daemon pidfile points at another process", () => {
    const rows = stackDaemonDiagnostics({
      root,
      env: appEnv,
      listProcesses: () => [],
      readPidFile: pidFileFor(41),
      probeProcess: () => ({
        alive: true,
        command: "bun unrelated-worker.mjs",
      }),
    });
    expect(
      rows.find((row) => row.label === "gh-app-auth daemon"),
    ).toMatchObject({
      ok: false,
      detail:
        "recycled gh-app-auth.pid — PID 41 belongs to bun unrelated-worker.mjs",
    });
  });

  test("fails on duplicate gh-app-auth daemons serving this stack", () => {
    const rows = stackDaemonDiagnostics({
      root,
      env: appEnv,
      listProcesses: () => [
        {
          pid: 41,
          command:
            "bun /factory/stack/lib/control-plane/gh-app-auth.mjs --daemon",
        },
        {
          pid: 42,
          command:
            "bun /factory/stack/lib/control-plane/gh-app-auth.mjs --daemon",
        },
      ],
      readPidFile: pidFileFor(41),
      probeProcess: () => ({
        alive: true,
        command:
          "bun /factory/stack/lib/control-plane/gh-app-auth.mjs --daemon",
      }),
    });
    expect(
      rows.find((row) => row.label === "gh-app-auth daemon"),
    ).toMatchObject({
      ok: false,
      detail: "duplicate daemons — found 2 (41, 42)",
    });
  });

  test("reports a live recycled PID separately from a stopped serve", () => {
    const rows = stackDaemonDiagnostics({
      env: {},
      listProcesses: () => [],
      readPidFile: () => "8080\n",
      probeProcess: () => ({
        alive: true,
        command: "bun unrelated-worker.mjs",
      }),
    });
    expect(
      rows.find((row) => row.label === "serve.pid identity"),
    ).toMatchObject({
      ok: false,
      detail:
        "recycled serve.pid — PID 8080 belongs to bun unrelated-worker.mjs",
    });
  });

  test("reports a stale PID as not running", () => {
    const rows = stackDaemonDiagnostics({
      env: {},
      listProcesses: () => [],
      readPidFile: () => "8080\n",
      probeProcess: () => ({ alive: false }),
    });
    expect(
      rows.find((row) => row.label === "serve.pid identity"),
    ).toMatchObject({
      ok: false,
      detail: "stale serve.pid — PID 8080 is not running",
    });
  });

  test("accepts a live PID only when it owns the serve entrypoint", () => {
    const rows = stackDaemonDiagnostics({
      env: {},
      listProcesses: () => [],
      readPidFile: () => "8080\n",
      probeProcess: () => ({
        alive: true,
        command: "bun /repo/event-runtime/cli.mjs serve --port 7381",
      }),
    });
    expect(rows.find((row) => row.label === "serve.pid identity")).toEqual({
      ok: true,
      label: "serve.pid identity",
      detail: "PID 8080 is event-runtime/cli.mjs serve",
      fix: null,
    });
  });

  test("reports stale registry and planner health from the live control API", () => {
    const rows = stackDaemonDiagnostics({
      root,
      env: {},
      listProcesses: () => [],
      readPidFile: () => "8080\n",
      probeProcess: () => ({
        alive: true,
        command: "bun /factory/stack/event-runtime/cli.mjs serve --port 7381",
      }),
      controlApiProbe: (pathname) => {
        if (pathname === "/status")
          return { ok: true, body: { events: { admitted: 1 } } };
        return {
          ok: true,
          body: {
            registry: {
              stamp: "files:stale",
              loadedAt: "2026-08-30T12:00:00.000Z",
              lastReloadError: { message: "bad schema" },
            },
            planner: { lastPlannedAt: "2026-08-30T11:00:00.000Z" },
          },
        };
      },
      registryStamp: () => "files:current",
      now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    });

    expect(rows).toContainEqual(
      expect.objectContaining({ label: "registry health", ok: false }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ label: "registry reload", ok: "warn" }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ label: "planner health", ok: false }),
    );
  });

  test("control API probe keeps the bearer token out of curl argv", () => {
    const token = "secret-bearer-token";
    const spawned = [];
    const spawn = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { status: 0, stdout: "{}", stderr: "" };
    };

    defaultControlApiProbe("/status", { port: 7381, token, spawn });
    expect(spawned).toHaveLength(1);
    const { args, opts } = spawned[0];
    expect(args.join(" ")).not.toContain(token);
    expect(args).toContain("--config");
    expect(args).toContain("-");
    expect(opts.input).toBe(`header = "Authorization: Bearer ${token}"\n`);

    // /health stays bearer-free: no config stanza, no stdin payload.
    defaultControlApiProbe("/health", { port: 7381, token, spawn });
    expect(spawned[1].args).not.toContain("--config");
    expect(spawned[1].opts.input).toBeUndefined();
    expect(JSON.stringify(spawned[1])).not.toContain(token);
  });
});

describe("chain auto-approval policy diagnostic (#1779)", () => {
  const writePolicy = (root, policy) => {
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config", "policy.yaml"), policy);
  };

  test("reports the four loader outcomes from a temporary instance root", () => {
    const valid = scratch();
    writePolicy(
      valid,
      `chain_auto_approval:
  allowed_event_types:
    - factory.merge.requested
merge:
  max_fix_rounds: 2
  batch_size: 3
escalation:
  auto_merge_base: [develop]
  auto_merge_owners: [watt-mind]
`,
    );
    expect(chainAutoApprovalPolicyDiagnostic({ root: valid })).toEqual({
      ok: true,
      label: "chain auto-approval policy",
      detail:
        "ok (1 allowed event type: factory.merge.requested; merge max_fix_rounds=2, batch_size=3; escalation auto_merge_base=develop, auto_merge_owners=watt-mind)",
      fix: null,
    });

    const missing = scratch();
    expect(chainAutoApprovalPolicyDiagnostic({ root: missing })).toEqual({
      ok: "warn",
      label: "chain auto-approval policy",
      detail: "policy_missing — every chain proposal is watched",
      fix: "add config/policy.yaml chain_auto_approval.allowed_event_types to opt into safe chain approvals",
    });

    const invalid = scratch();
    writePolicy(invalid, "chain_auto_approval:\n  allowed_event_types: nope\n");
    expect(chainAutoApprovalPolicyDiagnostic({ root: invalid })).toEqual({
      ok: false,
      label: "chain auto-approval policy",
      detail:
        "policy_invalid — chain_auto_approval.allowed_event_types must be an array of strings",
      fix: "compare config/policy.yaml chain_auto_approval.allowed_event_types with CHAIN_AUTO_APPROVAL_EVENT_TYPES",
    });

    const forbidden = scratch();
    writePolicy(
      forbidden,
      "chain_auto_approval:\n  allowed_event_types: [factory.work.requested, factory.ship-apply.requested]\nescalation:\n  auto_merge_base: []\n  auto_merge_owners: []\n",
    );
    expect(chainAutoApprovalPolicyDiagnostic({ root: forbidden })).toEqual({
      ok: false,
      label: "chain auto-approval policy",
      detail:
        "policy_contains_forbidden_event — offending entries: factory.ship-apply.requested",
      fix: "compare config/policy.yaml chain_auto_approval.allowed_event_types with CHAIN_AUTO_APPROVAL_EVENT_TYPES",
    });

    const mergeInvalid = scratch();
    writePolicy(
      mergeInvalid,
      "chain_auto_approval:\n  allowed_event_types: [factory.merge.requested]\nmerge:\n  max_fix_rounds: -1\nescalation:\n  auto_merge_base: [develop]\n  auto_merge_owners: [watt-mind]\n",
    );
    expect(chainAutoApprovalPolicyDiagnostic({ root: mergeInvalid })).toEqual({
      ok: false,
      label: "chain auto-approval policy",
      detail:
        "merge_policy_invalid — merge.max_fix_rounds and escalation.auto_merge_base/auto_merge_owners must be valid when merge events are allowed",
      fix: "repair merge.max_fix_rounds and escalation.auto_merge_base/auto_merge_owners in config/policy.yaml",
    });

    for (const root of [valid, missing, invalid, forbidden, mergeInvalid]) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults to the runtime's reposRoot() so FACTORY_REPOS_ROOT wins over the checkout", () => {
    const reposRootDir = scratch();
    writePolicy(
      reposRootDir,
      "chain_auto_approval:\n  allowed_event_types: [factory.triage.requested]\n",
    );
    const previous = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = reposRootDir;
    try {
      expect(chainAutoApprovalPolicyDiagnostic()).toEqual({
        ok: true,
        label: "chain auto-approval policy",
        detail:
          "ok (1 allowed event type: factory.triage.requested; merge max_fix_rounds=0, batch_size=4; escalation auto_merge_base=none, auto_merge_owners=none)",
        fix: null,
      });
    } finally {
      if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previous;
      rmSync(reposRootDir, { recursive: true, force: true });
    }
  });
});

describe("bin/chrome-headless.sh", () => {
  test("is shipped and executable", () => {
    expect(existsSync(WRAPPER)).toBe(true);
    expect(CHROME_HEADLESS_WRAPPER.endsWith("bin/chrome-headless.sh")).toBe(
      true,
    );
  });

  test("passes every caller argument through after the headless/sandbox flags", () => {
    const dir = scratch();
    const argsFile = path.join(dir, "args");
    const chrome = fakeChrome(dir, `printf '%s\\n' "$@" > ${argsFile}`);
    const r = Bun.spawnSync(
      [WRAPPER, "--remote-debugging-port=0", "about:blank"],
      {
        env: { ...process.env, CHROME_BIN: chrome },
        timeout: 5_000,
      },
    );
    expect(r.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-dev-shm-usage");
    // Caller args come last, so the extension's port/profile/URL survive.
    expect(args.slice(-2)).toEqual([
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("exits 127 with a named cause when no browser exists", () => {
    // CHROME_BIN="" disables PATH *and* /Applications lookup. Starving PATH
    // alone is not enough on macOS: resolve_chrome still finds the app bundle
    // and exec's Chrome, and spawnSync with no timeout hangs the whole suite.
    const r = Bun.spawnSync(["/bin/bash", WRAPPER, "about:blank"], {
      env: { HOME: process.env.HOME, PATH: "/nonexistent", CHROME_BIN: "" },
      stderr: "pipe",
      timeout: 5_000,
    });
    expect(r.exitCode).toBe(127);
    expect(new TextDecoder().decode(r.stderr)).toMatch(
      /no Chromium-family browser found/,
    );
  });

  test("empty CHROME_BIN skips discovery even when a browser is on PATH", () => {
    const dir = scratch();
    fakeChrome(dir, `exit 0`);
    const r = Bun.spawnSync(["/bin/bash", WRAPPER, "about:blank"], {
      env: {
        HOME: process.env.HOME,
        PATH: `${dir}:/usr/bin:/bin`,
        CHROME_BIN: "",
      },
      stderr: "pipe",
      timeout: 5_000,
    });
    expect(r.exitCode).toBe(127);
    expect(new TextDecoder().decode(r.stderr)).toMatch(
      /no Chromium-family browser found/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hanging CHROME_BIN cannot block spawnSync indefinitely", () => {
    const dir = scratch();
    const chrome = fakeChrome(dir, `exec sleep 60`);
    const started = Date.now();
    const r = Bun.spawnSync([WRAPPER, "about:blank"], {
      env: { ...process.env, CHROME_BIN: chrome },
      timeout: 800,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(r.success).toBe(false);
    expect(r.exitCode === 0).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("browserMissingDependency", () => {
  test("names a missing shared library", () => {
    expect(
      browserMissingDependency(
        "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file",
        127,
      ),
    ).toMatch(/^shared library libnss3\.so/);
  });
  test("names the missing display (headed launch on a headless box)", () => {
    expect(
      browserMissingDependency(
        "[1:1:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:257] Missing X server or $DISPLAY\n[1:1:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.",
        1,
      ),
    ).toMatch(/display.*--headless/);
  });
  test("names the sandbox flag", () => {
    expect(
      browserMissingDependency(
        "Failed to move to new namespace: PID namespaces supported",
        1,
      ),
    ).toMatch(/--no-sandbox/);
  });
  test("names a missing browser on exit 127", () => {
    expect(browserMissingDependency("", 127)).toMatch(
      /Chromium-family browser/,
    );
  });
  test("returns null for noise", () => {
    expect(
      browserMissingDependency("Failed to connect to the bus", 0),
    ).toBeNull();
  });
});

describe("browserLaunchCheck", () => {
  test("fails, naming the display, when the launched browser dies like the critic's did", async () => {
    const dir = scratch();
    const chrome = fakeChrome(
      dir,
      `echo '[1:1:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:257] Missing X server or $DISPLAY' >&2; echo '[1:1:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.' >&2; exit 1`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/before DevTools became available/);
    expect(r.missing).toMatch(/display/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails, naming the library, when Chrome cannot load a shared object", async () => {
    const dir = scratch();
    const chrome = fakeChrome(
      dir,
      `echo 'chrome: error while loading shared libraries: libgbm.so.1: cannot open shared object file: No such file or directory' >&2; exit 127`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    // exit 127 from a *found* binary that lacks a library is still a fail with the lib named
    expect(r.missing).toMatch(/libgbm\.so\.1/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips cleanly when no browser is installed", async () => {
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin",
        CHROME_BIN: path.join(scratch(), "missing-chrome"),
      },
    });
    expect(r.status).toBe("skip");
    expect(r.missing).toMatch(/Chromium-family browser/);
  });

  test("passes when the browser writes DevToolsActivePort", async () => {
    // A fake Chrome that behaves like the real one: parses --user-data-dir,
    // writes the port file, then idles until killed.
    const dir = scratch();
    const chrome = fakeChrome(
      dir,
      `for a in "$@"; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}";; esac; done
printf '41234\\n/devtools/browser/x\\n' > "$d/DevToolsActivePort"; exec sleep 30`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    expect(r.status).toBe("pass");
    expect(r.port).toBe(41234);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails when the browser never binds within the timeout", async () => {
    const dir = scratch();
    const pidFile = path.join(dir, "pid");
    const chrome = fakeChrome(
      dir,
      `echo $$ > "${pidFile}"
exec sleep 30`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 800,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not written within 800ms/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    let alive;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = e?.code === "EPERM";
    }
    expect(alive).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails when the wrapper itself is missing", async () => {
    const r = await browserLaunchCheck({
      wrapper: "/nonexistent/chrome-headless.sh",
    });
    expect(r.status).toBe("fail");
    expect(r.missing).toMatch(/chrome-headless\.sh/);
  });

  test("the real browser, when installed, binds a DevTools port headless in under 10s", async () => {
    const started = Date.now();
    const r = await browserLaunchCheck({ wrapper: WRAPPER, timeoutMs: 8000 });
    // No browser, or one that does not become ready in time (macOS Chrome
    // hanging on a permission prompt / GPU process): skip rather than fail
    // or block the runner. Deterministic launch behaviour is pinned above
    // with fake binaries.
    if (r.status !== "pass") return;
    expect(r.port).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});

describe("piChromeDevtoolsCheck", () => {
  const wrapper = WRAPPER;
  test("fails on display-less Linux when the extension is unconfigured, with the exact fix", () => {
    const agentDir = scratch();
    const r = piChromeDevtoolsCheck({
      agentDir,
      wrapper,
      env: {},
      os: "linux",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/Missing X server/);
    expect(r.fix).toContain(path.join(agentDir, "pi-chrome-devtools.json"));
    expect(r.fix).toContain(`"executablePath":"${wrapper}"`);
  });
  test("skips (warns) when unconfigured but a display exists / not Linux", () => {
    const agentDir = scratch();
    expect(
      piChromeDevtoolsCheck({
        agentDir,
        wrapper,
        env: { DISPLAY: ":0" },
        os: "linux",
      }).status,
    ).toBe("skip");
    expect(
      piChromeDevtoolsCheck({ agentDir, wrapper, env: {}, os: "darwin" })
        .status,
    ).toBe("skip");
  });
  test("passes when browser.executablePath points at the wrapper", () => {
    const agentDir = scratch();
    writeFileSync(
      path.join(agentDir, "pi-chrome-devtools.json"),
      JSON.stringify({ browser: { executablePath: wrapper } }),
    );
    const r = piChromeDevtoolsCheck({
      agentDir,
      wrapper,
      env: {},
      os: "linux",
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("browser.executablePath");
  });
  test("passes via PI_CHROME_DEVTOOLS_BROWSER too", () => {
    const r = piChromeDevtoolsCheck({
      agentDir: scratch(),
      wrapper,
      env: { PI_CHROME_DEVTOOLS_BROWSER: wrapper },
      os: "linux",
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("PI_CHROME_DEVTOOLS_BROWSER");
  });
  test("fails when the configured executable does not exist or is not executable", () => {
    const agentDir = scratch();
    writeFileSync(
      path.join(agentDir, "pi-chrome-devtools.json"),
      JSON.stringify({ browser: { executablePath: "/nonexistent/chrome" } }),
    );
    expect(
      piChromeDevtoolsCheck({ agentDir, wrapper, env: {}, os: "linux" }).status,
    ).toBe("fail");
    const notExec = path.join(agentDir, "chrome");
    writeFileSync(notExec, "");
    writeFileSync(
      path.join(agentDir, "pi-chrome-devtools.json"),
      JSON.stringify({ browser: { executablePath: notExec } }),
    );
    const r = piChromeDevtoolsCheck({
      agentDir,
      wrapper,
      env: {},
      os: "linux",
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/chmod \+x/);
  });
  test("fails on an unparsable settings file", () => {
    const agentDir = scratch();
    writeFileSync(path.join(agentDir, "pi-chrome-devtools.json"), "{ not json");
    expect(
      piChromeDevtoolsCheck({ agentDir, wrapper, env: {}, os: "linux" }).status,
    ).toBe("fail");
  });
});

describe("Linear budget line (WM-878)", () => {
  test("formats remaining/limit and UTC reset clock, and warns below 300", async () => {
    const {
      formatLinearBudgetLine,
      linearBudgetStatus,
      parseRateLimitHeaders,
      LINEAR_BUDGET_WARN_REMAINING,
    } = await import("../tools/ticket.mjs");
    expect(formatLinearBudgetLine(null)).toBe(
      "Linear budget: unknown (no recent API call)",
    );
    expect(
      formatLinearBudgetLine({
        remaining: 1842,
        limit: 2500,
        resetAt: "2026-08-19T15:07:00.000Z",
      }),
    ).toBe("Linear budget: 1842/2500 remaining, resets 15:07");
    expect(
      linearBudgetStatus({ remaining: LINEAR_BUDGET_WARN_REMAINING }),
    ).toBe("pass");
    expect(
      linearBudgetStatus({ remaining: LINEAR_BUDGET_WARN_REMAINING - 1 }),
    ).toBe("warn");
    const headers = new Headers({
      "X-RateLimit-Requests-Remaining": "12",
      "X-RateLimit-Requests-Limit": "2500",
      "X-RateLimit-Requests-Reset": "1787150400",
    });
    const parsed = parseRateLimitHeaders(headers);
    expect(parsed.remaining).toBe(12);
    expect(parsed.limit).toBe(2500);
    expect(parsed.resetAt).toBe(new Date(1787150400 * 1000).toISOString());
  });
});
