import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES } from "./cli/commands.mjs";
import { renderInspect } from "./cli/inspect.mjs";
import { CLI, freePort, runCli } from "./cli/test-helpers.mjs";

const EXPECTED_COMMANDS = [
  "serve",
  "work",
  "supervise",
  "status",
  "doctor",
  "events",
  "runs",
  "ps",
  "proposals",
  "inbox",
  "agents",
  "adapters",
  "workers",
  "schedule",
  "repos",
  "sandbox",
  "approve",
  "reject",
  "inject",
  "requeue",
  "cancel",
  "retry",
  "extend",
  "inspect",
  "trace",
  "update-pins",
];

describe("cli routing", () => {
  test("no command → usage text listing all verbs, non-zero exit", () => {
    const r = runCli([]);
    expect(r.status).not.toBe(0);
    for (const verb of [
      "serve",
      "status",
      "doctor",
      "ps",
      "runs",
      "proposals",
      "adapters",
      "approve",
      "reject",
      "inject",
      "cancel",
      "retry",
      "inspect",
      "update-pins",
      "supervise",
    ]) {
      expect(r.all).toContain(verb);
    }
    expect(r.all).toContain("usage:");
    expect(r.all).toContain("adapters [--json]");
    expect(r.all).toContain("--watch");
    expect(r.all).toContain("--reload-on-change");
    expect(r.all).toContain("--workers min:max");
  });

  test("adapters is routed through COMMANDS and lists locally", () => {
    expect(COMMAND_NAMES).toContain("adapters");
    const r = runCli(["adapters", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.adapters)).toBe(true);
    expect(parsed.adapters.length).toBeGreaterThan(0);
    expect(parsed.adapters[0]).toHaveProperty("name");
    expect(parsed.adapters[0]).toHaveProperty("source");
    expect(parsed.adapters[0]).toHaveProperty("sandboxSupport");
  });

  test("unknown command → usage text, non-zero exit", () => {
    const r = runCli(["frobnicate"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("usage:");
  });

  test("registered command set is unchanged", () => {
    expect(COMMAND_NAMES).toEqual(EXPECTED_COMMANDS);
  });

  test("inspect fetches run detail once when adding presentation", async () => {
    let runRequests = 0;
    const detail = {
      run: {
        runId: "run-1289",
        state: "COMPLETED",
        attempts: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:01:00.000Z",
        spec: {
          agent: "worker",
          adapter: "fake",
          outputContract: "factory.agent-result/v1",
          maxAttempts: 1,
        },
      },
      workspace: "/tmp/run-1289",
      lifecycle: [],
      result: {
        terminalState: "COMPLETED",
        presentation: {
          schemaVersion: "factory.presentation/v1",
          blocks: [{ type: "heading", text: "cached presentation" }],
        },
      },
    };
    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/runs/run-1289") {
          runRequests++;
          return Response.json(detail);
        }
        if (pathname === "/agents") return Response.json({ agents: [] });
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const child = Bun.spawn(["bun", CLI, "inspect", "run-1289"], {
        env: {
          ...process.env,
          FACTORY_EVENT_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0);
      expect(`${stdout}${stderr}`).toContain("# cached presentation");
    } finally {
      server.stop(true);
    }

    expect(runRequests).toBe(1);
  });

  test("inspect without presentation matches the shared detail renderer", async () => {
    const detail = {
      run: {
        runId: "run-1301",
        state: "COMPLETED",
        attempts: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:01:00.000Z",
        spec: {
          agent: "worker",
          adapter: "fake",
          outputContract: "factory.agent-result/v1",
          maxAttempts: 1,
        },
      },
      workspace: "/tmp/run-1301",
      lifecycle: [],
      result: { terminalState: "COMPLETED" },
    };
    const lines = [];
    const originalLog = console.log;
    console.log = (...values) => lines.push(values.join(" "));
    try {
      await renderInspect(detail, {});
    } finally {
      console.log = originalLog;
    }

    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        if (new URL(request.url).pathname === "/runs/run-1301")
          return Response.json(detail);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const child = Bun.spawn(["bun", CLI, "inspect", "run-1301"], {
        env: {
          ...process.env,
          FACTORY_EVENT_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(status).toBe(0);
      expect(stdout.trimEnd().split("\n")).toEqual(
        lines.flatMap((line) => line.split("\n")),
      );
    } finally {
      server.stop(true);
    }
  });

  test("inspect without a run ID reports usage", () => {
    const result = runCli(["inspect"]);
    expect(result.status).not.toBe(0);
    expect(result.all).toContain("usage: inspect <run-id>");
  });
});
