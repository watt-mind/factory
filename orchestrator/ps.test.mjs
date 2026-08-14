import { test, expect, describe } from "bun:test";
import path from "node:path";
import {
  parsePs,
  parseLsof,
  extractTicket,
  extractPortFlag,
  extractAdapterOverride,
  extractWorktreePath,
  categorizeProcess,
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
