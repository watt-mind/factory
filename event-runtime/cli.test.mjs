import { describe, expect, test } from "bun:test";
import path from "node:path";
import { COMMAND_NAMES } from "./cli/commands.mjs";
import { events } from "./cli/events.mjs";
import { inbox as legacyInbox } from "./cli/inbox.mjs";
import { renderInspect } from "./cli/inspect.mjs";
import { ps } from "./cli/ps.mjs";
import {
  RUN_LIST_MAX_PAGES,
  dispatchOnlyPredicate,
  runs,
  runsCommand,
} from "./cli/runs.mjs";
import {
  CLI,
  DEAD_PORT,
  freePort,
  runCli,
  throwawayRunDir,
} from "./cli/test-helpers.mjs";
import { apiClient } from "./lib/client.mjs";
import { tmpDir } from "./test-support/tmp.mjs?file=event-runtime-cli-test-mjs";

const FACTORY = path.resolve(import.meta.dir, "../bin/factory");

const DECIDE_ITEM = { id: "item-target", decision: { fields: [] } };

/**
 * One stub control API answering every top-level remote-target verb, so the
 * loopback pin and the plaintext refusal can be asserted for each of them
 * against identical routing (#2197).
 */
function stubControlApi(onRequest = () => {}) {
  return Bun.serve({
    port: Number(freePort()),
    fetch(request) {
      const url = new URL(request.url);
      onRequest(request, url);
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /inbox") return Response.json({ items: [] });
      if (route === `GET /inbox/${DECIDE_ITEM.id}`)
        return Response.json({ item: DECIDE_ITEM });
      if (route === `POST /inbox/${DECIDE_ITEM.id}/decide`)
        return Response.json({
          item: DECIDE_ITEM,
          effect: { kind: "approve_proposal", outcome: "applied" },
        });
      if (route === "GET /memos") return Response.json({ memos: [] });
      if (route === "POST /proposals/prop-target/approve")
        return Response.json({ approved: true, runId: "run-target" });
      return new Response("not found", { status: 404 });
    },
  });
}

/** The control-API verbs `factory` forwards --host/--remote to. */
const REMOTE_TARGET_VERBS = [
  ["inbox", []],
  ["decide", [DECIDE_ITEM.id, "approve"]],
  ["memos", ["repo", "factory"]],
];

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
    ["--host", (port) => `127.0.0.1:${port}`],
    ["--remote", (port) => `http://127.0.0.1:${port}`],
  ])(
    "top-level inbox and decide honor FACTORY_EVENT_HOST %s",
    async (_flag, targetFor) => {
      const token = "cli-remote-control-token";
      const requests = [];
      const item = { id: "item-remote", decision: { fields: [] } };
      const server = Bun.serve({
        port: Number(freePort()),
        async fetch(request) {
          const url = new URL(request.url);
          requests.push({
            method: request.method,
            pathname: url.pathname,
            search: url.search,
            authorization: request.headers.get("authorization"),
          });
          if (request.method === "GET" && url.pathname === "/inbox") {
            return Response.json({ items: [] });
          }
          if (
            request.method === "GET" &&
            url.pathname === "/inbox/item-remote"
          ) {
            return Response.json({ item });
          }
          if (
            request.method === "POST" &&
            url.pathname === "/inbox/item-remote/decide"
          ) {
            return Response.json({
              item,
              effect: { kind: "approve_proposal", outcome: "applied" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      });
      const env = {
        ...process.env,
        FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
        FACTORY_EVENT_HOST: targetFor(server.port),
        FACTORY_CONTROL_API_TOKEN: token,
        FACTORY_RUN_DIR: throwawayRunDir(),
      };
      try {
        const inbox = Bun.spawn(["bun", CLI, "inbox"], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [inboxStatus, inboxStderr] = await Promise.all([
          inbox.exited,
          new Response(inbox.stderr).text(),
        ]);
        expect(inboxStatus, inboxStderr).toBe(0);

        const decide = Bun.spawn(
          ["bun", CLI, "decide", "item-remote", "approve"],
          { env, stdout: "pipe", stderr: "pipe" },
        );
        const [decideStatus, decideStderr] = await Promise.all([
          decide.exited,
          new Response(decide.stderr).text(),
        ]);
        expect(decideStatus, decideStderr).toBe(0);
        expect(requests).toEqual([
          {
            method: "GET",
            pathname: "/inbox",
            search: "?status=open",
            authorization: `Bearer ${token}`,
          },
          {
            method: "GET",
            pathname: "/inbox/item-remote",
            search: "",
            authorization: `Bearer ${token}`,
          },
          {
            method: "POST",
            pathname: "/inbox/item-remote/decide",
            search: "",
            authorization: `Bearer ${token}`,
          },
        ]);
      } finally {
        server.stop(true);
      }
    },
  );

  test("factory forwards --host to the control-API verbs", async () => {
    const requests = [];
    const server = stubControlApi((request, url) =>
      requests.push(`${request.method} ${url.pathname}${url.search}`),
    );
    const env = {
      ...process.env,
      FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
      FACTORY_RUN_DIR: throwawayRunDir(),
      FACTORY_CONTROL_API_TOKEN: "factory-wrapper-target-token",
    };
    const target = `127.0.0.1:${server.port}`;
    try {
      // approve/reject/inject route through withClient →
      // apiClient({ resolveTarget: true }) in their own command modules, so the
      // wrapper only has to forward the flag; approve stands in for all three.
      for (const args of [
        ["inbox"],
        ["decide", DECIDE_ITEM.id, "approve"],
        ["approve", "prop-target"],
      ]) {
        const child = Bun.spawn(["bash", FACTORY, ...args, "--host", target], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [status, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(status, stderr).toBe(0);
      }
      expect(requests).toEqual([
        "GET /inbox?status=open",
        `GET /inbox/${DECIDE_ITEM.id}`,
        `POST /inbox/${DECIDE_ITEM.id}/decide`,
        "POST /proposals/prop-target/approve",
      ]);
    } finally {
      server.stop(true);
    }
  });

  test.each(REMOTE_TARGET_VERBS)(
    "top-level %s pins a no-target request to loopback",
    async (command, rest) => {
      const hostnames = [];
      const server = stubControlApi((_request, url) =>
        hostnames.push(url.hostname),
      );
      try {
        const child = Bun.spawn(["bun", CLI, command, ...rest], {
          env: {
            ...process.env,
            HOME: tmpDir("evrt-cli-home-"),
            FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
            FACTORY_EVENT_PORT: String(server.port),
            FACTORY_EVENT_HOST: "",
            FACTORY_CONTROL_API_URL: "",
            FACTORY_RUN_DIR: throwawayRunDir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [status, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(status, stderr).toBe(0);
        expect(hostnames.length).toBeGreaterThan(0);
        expect(new Set(hostnames)).toEqual(new Set(["127.0.0.1"]));
      } finally {
        server.stop(true);
      }
    },
  );

  test.each(REMOTE_TARGET_VERBS)(
    "top-level %s refuses a plaintext remote target before any request",
    async (command, rest) => {
      let requests = 0;
      const server = stubControlApi(() => {
        requests++;
      });
      try {
        const child = Bun.spawn(["bun", CLI, command, ...rest], {
          env: {
            ...process.env,
            HOME: tmpDir("evrt-cli-home-"),
            FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
            FACTORY_EVENT_HOST: `example.test:${server.port}`,
            FACTORY_CONTROL_API_URL: "",
            FACTORY_CONTROL_API_ALLOW_INSECURE: "",
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
        expect(status).not.toBe(0);
        expect(`${stdout}${stderr}`).toContain(
          "refusing to send the control API bearer in plaintext",
        );
        expect(requests).toBe(0);
      } finally {
        server.stop(true);
      }
    },
  );

  test.each([
    ["inbox"],
    ["decide", "item-unreachable", "approve"],
    ["memos", "repo", "factory"],
  ])("top-level %s gives a friendly connection failure", async (...args) => {
    const child = Bun.spawn(["bun", CLI, ...args], {
      env: {
        ...process.env,
        HOME: tmpDir("evrt-cli-home-"),
        FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
        FACTORY_EVENT_PORT: DEAD_PORT,
        FACTORY_EVENT_HOST: "",
        FACTORY_CONTROL_API_URL: "",
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
    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain(
      `control API not reachable on 127.0.0.1:${DEAD_PORT}`,
    );
    expect(`${stdout}${stderr}`).not.toContain("at dispatch");
  });

  // A usage error is the CLI's own, not the server's: it must never be
  // reported as an unreachable control API, even when serve is down (#2197).
  test.each([
    [["memos"], "usage: memos"],
    [["inbox", "bogus"], "unknown inbox subcommand: bogus"],
    [["decide"], "usage: decide <item-id> <option-id>"],
    [["inbox", "resolve"], "usage: inbox resolve <item-id>"],
  ])(
    "top-level %s reports its usage error, not a dead control API",
    async (args, expected) => {
      const child = Bun.spawn(["bun", CLI, ...args], {
        env: {
          ...process.env,
          HOME: tmpDir("evrt-cli-home-"),
          FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
          FACTORY_EVENT_PORT: DEAD_PORT,
          FACTORY_EVENT_HOST: "",
          FACTORY_CONTROL_API_URL: "",
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
      const output = `${stdout}${stderr}`;
      expect(status).not.toBe(0);
      expect(output).toContain(expected);
      expect(output).not.toContain("not reachable");
      expect(output).not.toContain("at dispatch");
    },
  );

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

  test("runs forwards its agent filter", async () => {
    const calls = [];
    const client = {
      runs: async (options) => {
        calls.push(options);
        return { runs: [], nextBefore: null };
      },
    };
    const lines = [];
    const log = console.log;
    console.log = (...values) => lines.push(values.join(" "));
    try {
      await runs(client, "running", { agent: "dispatch@1" });
    } finally {
      console.log = log;
    }
    expect(calls).toEqual([
      { state: "RUNNING", agent: "dispatch@1", limit: 200 },
    ]);
    expect(lines).toEqual(["no runs with state RUNNING"]);
  });

  test("runs excludes agents client-side", async () => {
    const client = {
      runs: async () => ({
        runs: [
          {
            runId: "dispatch-run",
            state: "RUNNING",
            agent: "dispatch@1",
            adapter: "cursor",
            attempts: 1,
            maxAttempts: 1,
            updated_at: "now",
          },
          {
            runId: "review-run",
            state: "RUNNING",
            agent: "merge-review@1",
            adapter: "agy",
            attempts: 1,
            maxAttempts: 1,
            updated_at: "now",
          },
        ],
        nextBefore: null,
      }),
    };
    const lines = [];
    const log = console.log;
    console.log = (...values) => lines.push(values.join(" "));
    try {
      await runs(client, "running", { excludeAgents: ["merge-review@1"] });
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("dispatch-run");
    expect(lines.join("\n")).not.toContain("review-run");
  });

  test("runs follows cursors and count writes only the integer", async () => {
    const calls = [];
    const client = {
      runs: async (options) => {
        calls.push(options);
        return options.before
          ? { runs: [{ runId: "run-2" }], nextBefore: null }
          : {
              runs: [{ runId: "run-1" }],
              nextBefore: "cursor-1",
            };
      },
    };
    const lines = [];
    const log = console.log;
    console.log = (...values) => lines.push(values.join(" "));
    try {
      await runs(client, "running", { count: true });
    } finally {
      console.log = log;
    }
    expect(calls).toEqual([
      { state: "RUNNING", limit: 200 },
      { state: "RUNNING", limit: 200, before: "cursor-1" },
    ]);
    expect(lines).toEqual(["2"]);
  });

  test("runs command dispatch-only excludes every non-dispatch registry agent", async () => {
    const calls = [];
    const client = {
      agents: async () => ({
        agents: [
          { id: "dispatch", ref: "dispatch@1" },
          { id: "merge-review", ref: "merge-review@1" },
          { id: "ci-doctor", ref: "ci-doctor@1" },
        ],
      }),
      runs: async (options) => {
        calls.push(options);
        return { runs: [], nextBefore: null };
      },
    };
    const lines = [];
    const log = console.log;
    console.log = (...values) => lines.push(values.join(" "));
    try {
      await runsCommand(["RUNNING", "--dispatch-only", "--count"], client);
    } finally {
      console.log = log;
    }
    expect(calls).toEqual([{ state: "RUNNING", limit: 200 }]);
    expect(lines).toEqual(["0"]);
  });

  test("dispatch-only keeps only explicit dispatch-class agents", () => {
    const keep = dispatchOnlyPredicate([
      { id: "dispatch", ref: "dispatch@1" },
      { id: "dispatch-hotfix", ref: "dispatch-hotfix@2" },
      {
        id: "lander",
        ref: "lander@1",
        outputContract: "factory.dispatch-result/v1",
      },
      { id: "merge-fix", ref: "merge-fix@1" },
      { id: "merge-review", ref: "merge-review@1" },
      { id: "work-scan", ref: "work-scan@1" },
    ]);
    const kept = ["dispatch@1", "dispatch@7"];
    const dropped = [
      "dispatch-hotfix@2",
      "lander@1",
      "worker@1",
      "merge-fix@1",
      "merge-review@1",
      "work-scan@1",
      "ci-doctor@1",
      "retired-agent@1",
    ];
    expect(kept.map((agent) => keep({ agent }))).toEqual(kept.map(() => true));
    expect(dropped.map((agent) => keep({ agent }))).toEqual(
      dropped.map(() => false),
    );
  });

  function captureConsole() {
    const out = [];
    const err = [];
    const log = console.log;
    const error = console.error;
    console.log = (...values) => out.push(values.join(" "));
    console.error = (...values) => err.push(values.join(" "));
    return {
      out,
      err,
      restore: () => ((console.log = log), (console.error = error)),
    };
  }

  test("runs clamps the page size to 200 and stops fetching once --limit is reached", async () => {
    const calls = [];
    const client = {
      runs: async (options) => {
        calls.push(options);
        return {
          runs: [{ runId: `run-${calls.length}` }],
          nextBefore: `cursor-${calls.length}`,
        };
      },
    };
    const c = captureConsole();
    try {
      await runs(client, "running", { limit: 2 });
    } finally {
      c.restore();
    }
    expect(calls.map((o) => o.limit)).toEqual([2, 2]);
    expect(c.out.filter((l) => l.startsWith("run-"))).toHaveLength(2);
    expect(c.err).toEqual(["... 0+ more rows (truncated)"]);

    calls.length = 0;
    const big = captureConsole();
    try {
      await runs(client, "running", { limit: 5000, count: true });
    } finally {
      big.restore();
    }
    expect(calls[0].limit).toBe(200);
    expect(calls).toHaveLength(RUN_LIST_MAX_PAGES);
  });

  test("runs caps the page walk and breaks on a repeated cursor", async () => {
    let calls = 0;
    const endless = {
      runs: async () => {
        calls += 1;
        return { runs: [{ runId: `run-${calls}` }], nextBefore: `c-${calls}` };
      },
    };
    const capped = captureConsole();
    try {
      await runs(endless, "running", { count: true });
    } finally {
      capped.restore();
    }
    expect(calls).toBe(RUN_LIST_MAX_PAGES);
    expect(capped.out).toEqual([String(RUN_LIST_MAX_PAGES)]);
    expect(capped.err[0]).toContain("page cap");

    calls = 0;
    const looping = {
      runs: async () => {
        calls += 1;
        return { runs: [{ runId: `run-${calls}` }], nextBefore: "same" };
      },
    };
    const loop = captureConsole();
    try {
      await runs(looping, "running", {});
    } finally {
      loop.restore();
    }
    expect(calls).toBe(2);
    expect(loop.err[0]).toContain("repeated");
    expect(loop.err.at(-1)).toBe("... 0+ more rows (truncated)");
  });

  test("client.runs accepts options while retaining the state-string form", async () => {
    const paths = [];
    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        paths.push(new URL(request.url).pathname + new URL(request.url).search);
        return Response.json({ runs: [], nextBefore: null });
      },
    });
    try {
      const client = apiClient({ port: server.port });
      await client.runs("RUNNING");
      await client.runs({
        state: "RUNNING",
        agent: "dispatch@1",
        limit: 20,
        before: "cursor-1",
      });
    } finally {
      server.stop(true);
    }
    expect(paths).toEqual([
      "/runs?state=RUNNING",
      "/runs?state=RUNNING&agent=dispatch%401&limit=20&before=cursor-1",
    ]);
  });

  test("cancel attempts every explicit run ID when one cancellation fails", async () => {
    const attempted = [];
    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        const runId = decodeURIComponent(
          new URL(request.url).pathname.split("/")[2],
        );
        attempted.push(runId);
        return runId === "run_fail"
          ? Response.json({ error: "cannot cancel" }, { status: 409 })
          : Response.json({});
      },
    });
    try {
      const child = Bun.spawn(
        [
          "bun",
          CLI,
          "cancel",
          "run_one",
          "run_fail",
          "run_three",
          "--reason",
          "cleanup",
        ],
        {
          env: {
            ...process.env,
            FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
            FACTORY_EVENT_PORT: String(server.port),
            FACTORY_RUN_DIR: throwawayRunDir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [status, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(status).toBe(1);
      expect(stdout).toContain("cancelled run_one");
      expect(stdout).toContain("cancel failed run_fail: cannot cancel");
      expect(stdout).toContain("cancelled run_three");
    } finally {
      server.stop(true);
    }
    expect(attempted.sort()).toEqual(["run_fail", "run_one", "run_three"]);
  });

  test("cancel state selection refuses multiple targets without --yes", async () => {
    const requests = [];
    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        const url = new URL(request.url);
        requests.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/runs")
          return Response.json({
            runs: [{ runId: "run_one" }, { runId: "run_two" }],
          });
        return Response.json({});
      },
    });
    try {
      const child = Bun.spawn(["bun", CLI, "cancel", "--state", "PROPOSED"], {
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
      expect(status).toBe(1);
      expect(stdout).toContain("run_one");
      expect(stdout).toContain("run_two");
      expect(stderr).toContain("--yes");
    } finally {
      server.stop(true);
    }
    expect(requests).toEqual(["/runs?state=PROPOSED"]);
  });

  test("cancel state selection dry-run lists targets without cancellation", async () => {
    const requests = [];
    const server = Bun.serve({
      port: Number(freePort()),
      fetch(request) {
        const url = new URL(request.url);
        requests.push(`${url.pathname}${url.search}`);
        return Response.json({ runs: [{ runId: "run_one" }] });
      },
    });
    try {
      const child = Bun.spawn(
        [
          "bun",
          CLI,
          "cancel",
          "--state",
          "PROPOSED",
          "--agent",
          "worker@1",
          "--dry-run",
        ],
        {
          env: {
            ...process.env,
            FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
            FACTORY_EVENT_PORT: String(server.port),
            FACTORY_RUN_DIR: throwawayRunDir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [status, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(status).toBe(0);
      expect(stdout).toContain("run_one");
    } finally {
      server.stop(true);
    }
    expect(requests).toEqual(["/runs?state=PROPOSED&agent=worker%401"]);
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

  test("decide renders a failed effect's error and says the item remains open", async () => {
    const item = {
      id: "item-9",
      decision: { fields: [] },
    };
    const server = Bun.serve({
      port: Number(freePort()),
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/inbox/item-9") {
          return Response.json({ item });
        }
        if (req.method === "POST" && url.pathname === "/inbox/item-9/decide") {
          return Response.json({
            item: { ...item, response: { effect: { outcome: "failed" } } },
            effect: {
              kind: "approve_proposal",
              outcome: "failed",
              error: "linear_triage_failed: connection refused",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const child = Bun.spawn(["bun", CLI, "decide", "item-9", "approve"], {
        env: {
          ...process.env,
          FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
          FACTORY_EVENT_PORT: String(server.port),
          FACTORY_RUN_DIR: throwawayRunDir(),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(status).toBe(0);
      expect(stdout).toContain("item-9: approve_proposal failed");
      expect(stdout).toContain(
        "error: linear_triage_failed: connection refused",
      );
      expect(stdout).toContain("item-9 remains open");
      expect(stdout).toContain("decision was not applied");
    } finally {
      server.stop(true);
    }
  });

  test("inbox resolve posts the reason and prints the resolved item", async () => {
    let request;
    const server = Bun.serve({
      port: Number(freePort()),
      async fetch(req) {
        request = {
          method: req.method,
          pathname: new URL(req.url).pathname,
          body: await req.json(),
        };
        return Response.json({
          item: { id: "item-1", resolvedReason: request.body.reason },
        });
      },
    });
    try {
      const child = Bun.spawn(
        [
          "bun",
          CLI,
          "inbox",
          "resolve",
          "item-1",
          "--reason",
          "handled by hand",
        ],
        {
          env: {
            ...process.env,
            FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
            FACTORY_EVENT_PORT: String(server.port),
            FACTORY_RUN_DIR: throwawayRunDir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status, stderr).toBe(0);
      expect(stdout).toContain("item-1: resolved (handled by hand)");
    } finally {
      server.stop(true);
    }
    expect(request).toEqual({
      method: "POST",
      pathname: "/inbox/item-1/resolve",
      body: { reason: "handled by hand" },
    });
  });

  test("inbox resolve without --reason reports usage", () => {
    const result = runCli(["inbox", "resolve", "item-1"], {
      FACTORY_EVENT_PORT: DEAD_PORT,
    });
    expect(result.status).not.toBe(0);
    expect(result.all).toContain(
      'usage: inbox resolve <item-id> --reason "<text>"',
    );
  });

  test("inbox resolve without an item ID reports usage", () => {
    const result = runCli(["inbox", "resolve"], {
      FACTORY_EVENT_PORT: DEAD_PORT,
    });
    expect(result.status).not.toBe(0);
    expect(result.all).toContain(
      'usage: inbox resolve <item-id> --reason "<text>"',
    );
  });

  test("inbox resolve on an unknown item renders the control API's 404", async () => {
    const server = Bun.serve({
      port: Number(freePort()),
      fetch() {
        return Response.json(
          { error: "unknown inbox item ghost" },
          { status: 404 },
        );
      },
    });
    try {
      const child = Bun.spawn(
        ["bun", CLI, "inbox", "resolve", "ghost", "--reason", "cleanup"],
        {
          env: {
            ...process.env,
            FACTORY_EVENT_HOME: tmpDir("evrt-cli-"),
            FACTORY_EVENT_PORT: String(server.port),
            FACTORY_RUN_DIR: throwawayRunDir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("unknown inbox item ghost");
    } finally {
      server.stop(true);
    }
  });
});
