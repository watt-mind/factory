import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parsePs,
  parseLsof,
  extractTicket,
  extractPortFlag,
  extractAdapterOverride,
  extractWorktreePath,
  categorizeProcess,
  isPidAlive,
  scanWorktrees,
  collectFactoryPsSnapshot,
  formatFactoryPsReport,
} from "../lib/ps.mjs";

const FIXTURE_PS = `
  PID  PPID  %CPU %MEM     ELAPSED COMMAND
  101     1   0.1  0.2       01:23 bun event-runtime/cli.mjs serve --port 7404 --adapter-override fake
  102     1   0.0  0.1       01:23 bun event-runtime/cli.mjs work --adapter-override fake
  103     1   0.0  0.0       01:23 bun event-runtime/web/serve.mjs --port 7405
  201   500   1.2  0.5    12:34:56 bash runners/run-agent.sh --repo bj29 --ticket CLNT-616
  202   500   0.5  0.4    01:10:00 claude -p /factory-ticket
  301     1   0.0  0.1       10:00 node /Users/hdkiller/Develop/.worktrees/bj29/CLNT-616/node_modules/.bin/vite --port 3000
  401     1   0.0  0.1       05:00 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper
`;

const FIXTURE_LSOF = `
COMMAND     PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
bun         101 hdkiller   12u  IPv4 0xd8ab2a49ff842cbf      0t0  TCP 127.0.0.1:7404 (LISTEN)
bun         103 hdkiller    5u  IPv4 0x2a2cdb8a7b286e8a      0t0  TCP 127.0.0.1:7405 (LISTEN)
node        301 hdkiller   31u  IPv6 0x2e2a667e702cda4a      0t0  TCP *:3000 (LISTEN)
1Password   752 hdkiller   51u  IPv4 0x3ef0e58c7a3caa5c      0t0  TCP 127.0.0.1:39127 (LISTEN)
`;

describe("ps parser", () => {
  test("parsePs parses raw ps table into structured objects", () => {
    const procs = parsePs(FIXTURE_PS);
    expect(procs.length).toBe(7);
    expect(procs[0]).toEqual({
      pid: 101,
      ppid: 1,
      cpu: 0.1,
      mem: 0.2,
      etime: "01:23",
      command: "bun event-runtime/cli.mjs serve --port 7404 --adapter-override fake",
    });
  });

  test("parsePs handles empty input", () => {
    expect(parsePs("")).toEqual([]);
    expect(parsePs(null)).toEqual([]);
  });
});

describe("lsof parser", () => {
  test("parseLsof parses listening ports", () => {
    const ports = parseLsof(FIXTURE_LSOF);
    expect(ports.length).toBe(4);
    expect(ports[0]).toEqual({
      command: "bun",
      pid: 101,
      port: 7404,
      host: "127.0.0.1",
      raw: "bun         101 hdkiller   12u  IPv4 0xd8ab2a49ff842cbf      0t0  TCP 127.0.0.1:7404 (LISTEN)",
    });
    expect(ports[2].port).toBe(3000);
    expect(ports[2].host).toBe("*");
  });

  test("parseLsof handles process names containing spaces", () => {
    const ports = parseLsof(`
COMMAND          PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
Google Chrome   1234 hdkiller   42u  IPv4 0x3ef0e58c7a3caa5c      0t0  TCP 127.0.0.1:9222 (LISTEN)
Electron Helper 5678 hdkiller   18u  IPv6 0x2e2a667e702cda4a      0t0  TCP *:5173 (LISTEN)
`);

    expect(ports).toEqual([
      {
        command: "Google Chrome",
        pid: 1234,
        port: 9222,
        host: "127.0.0.1",
        raw: "Google Chrome   1234 hdkiller   42u  IPv4 0x3ef0e58c7a3caa5c      0t0  TCP 127.0.0.1:9222 (LISTEN)",
      },
      {
        command: "Electron Helper",
        pid: 5678,
        port: 5173,
        host: "*",
        raw: "Electron Helper 5678 hdkiller   18u  IPv6 0x2e2a667e702cda4a      0t0  TCP *:5173 (LISTEN)",
      },
    ]);
  });

  test("parseLsof preserves numeric words in command names and still picks PID", () => {
    const ports = parseLsof(`
COMMAND          PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
Google 2024 Chrome 1234 hdkiller   42u  IPv4 0x3ef0e58c7a3caa5c      0t0  TCP 127.0.0.1:9222 (LISTEN)
`);

    expect(ports).toEqual([
      {
        command: "Google 2024 Chrome",
        pid: 1234,
        port: 9222,
        host: "127.0.0.1",
        raw: "Google 2024 Chrome 1234 hdkiller   42u  IPv4 0x3ef0e58c7a3caa5c      0t0  TCP 127.0.0.1:9222 (LISTEN)",
      },
    ]);
  });

  test("parseLsof handles empty input", () => {
    expect(parseLsof("")).toEqual([]);
    expect(parseLsof(null)).toEqual([]);
  });
});

describe("string extraction helpers", () => {
  test("extractTicket finds ticket IDs in branches and commands", () => {
    expect(extractTicket("feat/OPS-402-factory-ps")).toBe("OPS-402");
    expect(extractTicket("/Users/dev/.worktrees/bj29/CLNT-1393")).toBe("CLNT-1393");
    expect(extractTicket("runners/run-agent.sh --ticket LAB-176")).toBe("LAB-176");
    expect(extractTicket("no ticket here")).toBe(null);
  });

  test("extractPortFlag extracts --port or -p", () => {
    expect(extractPortFlag("serve --port 7404")).toBe(7404);
    expect(extractPortFlag("vite -p 5173")).toBe(5173);
    expect(extractPortFlag("serve")).toBe(null);
  });

  test("extractAdapterOverride extracts adapter name", () => {
    expect(extractAdapterOverride("serve --adapter-override fake")).toBe("fake");
    expect(extractAdapterOverride("work --adapter-override claude")).toBe("claude");
    expect(extractAdapterOverride("work")).toBe(null);
  });

  test("extractWorktreePath resolves worktree root paths", () => {
    expect(extractWorktreePath("/Users/hdkiller/Develop/.worktrees/factory/OPS-402/app")).toBe(
      "/Users/hdkiller/Develop/.worktrees/factory/OPS-402",
    );
  });
});

describe("process categorization", () => {
  test("categorizes control plane serve, work, and web", () => {
    const serveProc = { pid: 101, ppid: 1, cpu: 0.1, mem: 0.2, etime: "01:00", command: "bun event-runtime/cli.mjs serve --port 7404" };
    const cat = categorizeProcess(serveProc);
    expect(cat.kind).toBe("control-plane");
    expect(cat.service).toBe("serve");
    expect(cat.port).toBe(7404);

    const workProc = { pid: 102, ppid: 1, cpu: 0.1, mem: 0.2, etime: "01:00", command: "bun event-runtime/cli.mjs work" };
    expect(categorizeProcess(workProc).service).toBe("worker");

    const webProc = { pid: 103, ppid: 1, cpu: 0.1, mem: 0.2, etime: "01:00", command: "bun event-runtime/web/serve.mjs" };
    expect(categorizeProcess(webProc).service).toBe("web");
  });

  test("categorizes agent runners and ignores desktop electron apps", () => {
    const runner = { pid: 201, ppid: 1, cpu: 0, mem: 0, etime: "10:00", command: "bash runners/run-agent.sh --ticket OPS-123" };
    const catRunner = categorizeProcess(runner);
    expect(catRunner.kind).toBe("agent");
    expect(catRunner.ticket).toBe("OPS-123");

    const helper = { pid: 401, ppid: 1, cpu: 0, mem: 0, etime: "10:00", command: "/Applications/Claude.app/Contents/Frameworks/Claude Helper" };
    expect(categorizeProcess(helper).kind).toBe("ignored");
  });
});

describe("worktree daemon liveness", () => {
  test("isPidAlive rejects zombie and defunct daemon processes", () => {
    const inspectPid = () => "Z+   [bun] <defunct>";

    expect(isPidAlive(process.pid, "event-runtime/cli.mjs work", { inspectPid })).toBe(false);
  });

  test("isPidAlive rejects a recycled PID whose command does not match the daemon", () => {
    const inspectPid = () => "S+   unrelated-system-process --background";

    expect(isPidAlive(process.pid, "event-runtime/cli.mjs work", { inspectPid })).toBe(false);
  });

  test("isPidAlive accepts a non-zombie process with the expected daemon signature", () => {
    const inspectPid = () => "S+   bun event-runtime/cli.mjs work --adapter-override fake";

    expect(isPidAlive(process.pid, "event-runtime/cli.mjs work", { inspectPid })).toBe(true);
  });

  test("scanWorktrees does not mark a worktree active when its PID was recycled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-ps-"));
    const worktree = path.join(root, "factory", "WM-277");
    const runDir = path.join(worktree, ".factory", "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "worker.pid"), String(process.pid));

    try {
      const result = scanWorktrees({ worktreeRootFallback: root });
      expect(result.worktrees).toHaveLength(1);
      expect(result.worktrees[0].pids).toEqual({});
      expect(result.worktrees[0].active).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("snapshot and reporting", () => {
  test("collectFactoryPsSnapshot builds consistent summary without network calls", async () => {
    const snapshot = await collectFactoryPsSnapshot({
      psOutput: FIXTURE_PS,
      lsofOutput: FIXTURE_LSOF,
      fetchApi: false,
    });

    expect(snapshot.controlPlane.length).toBe(3);
    expect(snapshot.agents.length).toBe(2);
    expect(snapshot.devServers.length).toBe(1);
    expect(snapshot.ports.length).toBe(4);
    expect(snapshot.summary.controlServices).toBe(3);
    expect(snapshot.summary.activeAgents).toBe(2);
  });

  test("formatFactoryPsReport formats clean plaintext table", async () => {
    const snapshot = await collectFactoryPsSnapshot({
      psOutput: FIXTURE_PS,
      lsofOutput: FIXTURE_LSOF,
      fetchApi: false,
    });

    const report = formatFactoryPsReport(snapshot, { colors: false });
    expect(report).toContain("CONTROL PLANE & DAEMONS");
    expect(report).toContain("AGENT HARNESSES & RUNNERS");
    expect(report).toContain("WORKTREE DEV SERVERS & DAEMONS");
    expect(report).toContain("SUMMARY:");
    expect(report).toContain("API Server");
    expect(report).toContain("Event Worker");
    expect(report).toContain("Web UI Server");
    expect(report).toContain("bj29/CLNT-616");
    expect(report).toContain("vite:301");
    expect(report).toContain("3000");
  });

  test("formatFactoryPsReport renders offline status for control plane when serve is unreachable", () => {
    const snapshot = {
      timestamp: "2026-08-14T12:00:00.000Z",
      controlPlane: [
        {
          service: "serve",
          subservice: "API Server",
          pid: 101,
          port: 7404,
          uptime: "01:23",
          cpu: "0.1%",
          mem: "0.2%",
          ticket: null,
          worktree: null,
        },
      ],
      apiProbes: [
        {
          online: false,
          port: 7404,
          host: "127.0.0.1",
          error: "fetch failed",
        },
      ],
      workers: [],
      runs: [],
      agents: [],
      devServers: [],
      worktrees: [],
      ports: [],
      summary: {
        controlServices: 1,
        activeWorkers: 0,
        activeRuns: 0,
        activeAgents: 0,
        activeWorktrees: 0,
        totalWorktrees: 0,
        listeningPorts: 0,
      },
    };

    const report = formatFactoryPsReport(snapshot, { colors: false });
    expect(report).toContain("API Server");
    expect(report).toContain("offline");
    expect(report).not.toContain("starting/busy");
  });

  test("formatFactoryPsReport renders discovered devServers and ports for worktrees", () => {
    const snapshot = {
      timestamp: "2026-08-14T12:00:00.000Z",
      controlPlane: [],
      apiProbes: [],
      workers: [],
      runs: [],
      agents: [],
      devServers: [
        {
          pid: 301,
          service: "vite",
          repo: "bj29",
          ticket: "CLNT-616",
          worktree: "/Users/hdkiller/Develop/.worktrees/bj29/CLNT-616",
          port: 3000,
          uptime: "10:00",
          cpu: "0.0%",
          mem: "0.1%",
          command: "vite --port 3000",
        },
      ],
      worktrees: [
        {
          repo: "bj29",
          name: "CLNT-616",
          path: "/Users/hdkiller/Develop/.worktrees/bj29/CLNT-616",
          branch: "feat/CLNT-616",
          ticket: "CLNT-616",
          pids: {},
          active: false,
        },
      ],
      ports: [{ command: "node", pid: 301, port: 3000, host: "*" }],
      summary: {
        controlServices: 0,
        activeWorkers: 0,
        activeRuns: 0,
        activeAgents: 0,
        activeWorktrees: 1,
        totalWorktrees: 1,
        listeningPorts: 1,
      },
    };

    const report = formatFactoryPsReport(snapshot, { colors: false });
    expect(report).toContain("bj29/CLNT-616");
    expect(report).toContain("vite:301");
    expect(report).toContain("3000");
  });

  test("collectFactoryPsSnapshot probes multiple candidate ports concurrently without stalling", async () => {
    const fakeLsof = [
      "COMMAND     PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "bun         901 hdkiller   12u  IPv4 0xd8ab2a49ff842cbf      0t0  TCP 127.0.0.1:7404 (LISTEN)",
      "bun         902 hdkiller   12u  IPv4 0xd8ab2a49ff842cbf      0t0  TCP 127.0.0.1:7405 (LISTEN)",
      "bun         903 hdkiller   12u  IPv4 0xd8ab2a49ff842cbf      0t0  TCP 127.0.0.1:7406 (LISTEN)",
      "bun         904 hdkiller   12u  IPv4 0xd8ab2a49ff842cbf      0t0  TCP 127.0.0.1:7407 (LISTEN)",
      "bun         905 hdkiller   12u  IPv4 0xd8ab2a49ff842cbf      0t0  TCP 127.0.0.1:7408 (LISTEN)",
    ].join("\n");

    const start = performance.now();
    const snapshot = await collectFactoryPsSnapshot({
      psOutput: "",
      lsofOutput: fakeLsof,
      fetchApi: true,
    });
    const duration = performance.now() - start;

    expect(snapshot.apiProbes.length).toBe(6);
    expect(duration).toBeLessThan(2500);
  });
});

describe("cli integration", () => {
  test("orchestrator/ps.mjs --json outputs valid JSON", () => {
    const psScript = path.resolve(import.meta.dir, "ps.mjs");
    const result = Bun.spawnSync({
      cmd: ["bun", psScript, "--json"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString());
    expect(parsed.summary).toBeDefined();
    expect(Array.isArray(parsed.controlPlane)).toBe(true);
    expect(Array.isArray(parsed.ports)).toBe(true);
  });
});
