import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES } from "./cli/commands.mjs";
import { events } from "./cli/events.mjs";
import { inbox as legacyInbox } from "./cli/inbox.mjs";
import { renderInspect } from "./cli/inspect.mjs";
import { ps } from "./cli/ps.mjs";
import { runs } from "./cli/runs.mjs";
import { CLI, freePort, runCli, throwawayRunDir } from "./cli/test-helpers.mjs";
import { tmpDir } from "./test-support/tmp.mjs?file=event-runtime-cli-test-mjs";

const EXPECTED_COMMANDS = [
  "serve",
  "work",
  "plan",
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
  test("callControl sends the configured bearer", async () => {
    const token = "cli-control-token";
    let authorization;
    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        authorization = request.headers.get("authorization");
        return Response.json({ memos: [] });
      },
    });
    try {
      const child = Bun.spawn(["bun", CLI, "memos", "repo", "factory"], {
        env: {
          ...process.env,
          FACTORY_EVENT_PORT: String(server.port),
          FACTORY_CONTROL_API_TOKEN: token,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(status, stderr).toBe(0);
      expect(authorization).toBe(`Bearer ${token}`);
    } finally {
      server.stop(true);
    }
  });

  test.each([
    [401, "unauthorized"],
    [503, "control_api_token_unset"],
  ])(
    "callControl gives actionable text for HTTP %i",
    async (statusCode, error) => {
      const server = Bun.serve({
        port: Number(freePort()),
        fetch: () => Response.json({ error }, { status: statusCode }),
      });
      try {
        const child = Bun.spawn(["bun", CLI, "memos", "repo", "factory"], {
          env: {
            ...process.env,
            FACTORY_EVENT_PORT: String(server.port),
            FACTORY_CONTROL_API_TOKEN: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode).not.toBe(0);
        expect(`${stdout}${stderr}`).toContain("FACTORY_CONTROL_API_TOKEN");
        expect(`${stdout}${stderr}`).toContain("~/.factory/secrets.env");
      } finally {
        server.stop(true);
      }
    },
  );

  test("split inbox client sends its bearer", async () => {
    const token = "inbox-control-token";
    let authorization;
    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        authorization = request.headers.get("authorization");
        return Response.json({ items: [] });
      },
    });
    const logs = [];
    const originalLog = console.log;
    console.log = (...values) => logs.push(values.join(" "));
    try {
      await legacyInbox({ host: "127.0.0.1", port: server.port, token });
      expect(authorization).toBe(`Bearer ${token}`);
      expect(logs).toEqual(["no open inbox items"]);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

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

  test("unknown command names the verb without dumping usage", () => {
    const r = runCli(["frobnicate"]);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(
      "unknown command: frobnicate (try: cli.mjs help)",
    );
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("usage:");
  });

  test("help, -h, and --help print usage to stdout and exit zero", () => {
    for (const args of [["help"], ["-h"], ["--help"]]) {
      const r = runCli(args);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("usage:");
      expect(r.stderr).toBe("");
    }
  });

  test("state and status filters are uppercased before client calls", async () => {
    const calls = [];
    const client = {
      runs: async (state) => {
        calls.push(["runs", state]);
        return {
          runs: [
            {
              runId: "run-1",
              state: "RUNNING",
              agent: "worker",
              adapter: "fake",
              attempts: 1,
              maxAttempts: 1,
              eventId: null,
              updated_at: "now",
            },
          ],
        };
      },
      events: async (status) => {
        calls.push(["events", status]);
        return { events: [] };
      },
    };
    const lines = [];
    const log = console.log;
    console.log = (...values) => lines.push(values.join(" "));
    try {
      await runs(client, "running");
      await ps(client, "running");
      await events(client, "queued");
    } finally {
      console.log = log;
    }
    expect(calls).toEqual([
      ["runs", "RUNNING"],
      ["runs", "RUNNING"],
      ["events", "QUEUED"],
    ]);
    expect(lines.join("\n")).toContain("RUNNING");
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
          FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
          FACTORY_EVENT_PORT: String(server.port),
          FACTORY_RUN_DIR: throwawayRunDir(),
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
