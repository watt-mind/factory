import { expect, test } from "bun:test";
import path from "node:path";
import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  resolvePort,
  resolveTimeoutMs,
} from "./dispatch.mjs";

const DISPATCH = path.join(import.meta.dir, "dispatch.mjs");

async function runDispatch(server, args, extraEnv = {}) {
  const child = Bun.spawn(["bun", DISPATCH, ...args], {
    env: {
      ...process.env,
      FACTORY_EVENT_PORT: String(server.port),
      FACTORY_CONTROL_API_TOKEN: "dispatch-test-token",
      FACTORY_DISPATCH_POLL_MS: "1",
      FACTORY_DISPATCH_WATCH_TIMEOUT_MS: "20",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function watchServer({ state, reasonCode = "needs_human" } = {}) {
  let eventId = null;
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/replay") {
        const event = await request.json();
        eventId = event.eventId;
        return Response.json({ admitted: true, eventId });
      }
      if (url.pathname === "/proposals") {
        if (url.searchParams.get("status") !== "all")
          return Response.json(
            { error: "expected ?status=all" },
            { status: 400 },
          );
        return Response.json({
          proposals: [
            { eventSource: "factory-cli", eventId, runId: "run-watch-test" },
          ],
        });
      }
      if (url.pathname === "/runs/run-watch-test/trace")
        return Response.json({ entries: [] });
      if (url.pathname === "/runs/run-watch-test")
        return Response.json({ state, reasonCode });
      return new Response("not found", { status: 404 });
    },
  });
}

test("defaults to the standard event-runtime port", () => {
  expect(DEFAULT_PORT).toBe(7381);
  expect(resolvePort({})).toBe(7381);
});

test("FACTORY_EVENT_PORT overrides the default port", () => {
  expect(resolvePort({ FACTORY_EVENT_PORT: "8123" })).toBe(8123);
});

test("FACTORY_DISPATCH_TIMEOUT_MS overrides the default timeout", () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
  expect(resolveTimeoutMs({ FACTORY_DISPATCH_TIMEOUT_MS: "1234" })).toBe(1234);
  expect(resolveTimeoutMs({ FACTORY_DISPATCH_TIMEOUT_MS: "nope" })).toBe(
    DEFAULT_TIMEOUT_MS,
  );
  expect(resolveTimeoutMs({ FACTORY_DISPATCH_TIMEOUT_MS: "0" })).toBe(
    DEFAULT_TIMEOUT_MS,
  );
});

test("dispatch sends FACTORY_CONTROL_API_TOKEN as a bearer", async () => {
  const token = "dispatch-control-token";
  let authorization;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      authorization = request.headers.get("authorization");
      return Response.json({ admitted: true, eventId: "dispatch-test" });
    },
  });
  try {
    const child = Bun.spawn(["bun", DISPATCH, "status", "--json"], {
      env: {
        ...process.env,
        FACTORY_EVENT_PORT: String(server.port),
        FACTORY_CONTROL_API_TOKEN: token,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(authorization).toBe(`Bearer ${token}`);
  } finally {
    server.stop(true);
  }
});

test.each([
  [401, "unauthorized"],
  [503, "control_api_token_unset"],
])(
  "dispatch gives actionable token text for HTTP %i",
  async (status, error) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    try {
      const child = Bun.spawn(["bun", DISPATCH, "status", "--json"], {
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

test("dispatch fails fast with the request path and configured timeout", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise(() => {}),
  });
  try {
    const child = Bun.spawn(["bun", DISPATCH, "status", "--json"], {
      env: {
        ...process.env,
        FACTORY_EVENT_PORT: String(server.port),
        FACTORY_CONTROL_API_TOKEN: "dispatch-secret-token",
        FACTORY_DISPATCH_TIMEOUT_MS: "50",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/control API request to \/\S+ timed out after 50ms/);
    expect(`${stdout}${stderr}`).not.toContain("dispatch-secret-token");
  } finally {
    server.stop(true);
  }
});

test.each(["REFUSED", "TIMED_OUT"])(
  "dispatch --watch settles on %s and exits as a failed run",
  async (state) => {
    const server = watchServer({ state, reasonCode: "typed_refusal" });
    try {
      const { exitCode, stdout } = await runDispatch(server, [
        "status",
        "--watch",
      ]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain(`settled: ${state}`);
      expect(stdout).toContain("typed_refusal");
    } finally {
      server.stop(true);
    }
  },
);

test("dispatch --json --watch emits only its final settled object on stdout", async () => {
  const server = watchServer({ state: "COMPLETED", reasonCode: "ok" });
  try {
    const { exitCode, stdout, stderr } = await runDispatch(server, [
      "status",
      "--json",
      "--watch",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      runId: "run-watch-test",
      state: "COMPLETED",
      reasonCode: "ok",
    });
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stderr).toContain("Streaming live trace");
  } finally {
    server.stop(true);
  }
});

test("dispatch --watch reports a planner NOOP with the documented exit code", async () => {
  let eventId = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/replay") {
        const event = await request.json();
        eventId = event.eventId;
        return Response.json({ admitted: true, eventId });
      }
      if (url.pathname === "/proposals") {
        if (url.searchParams.get("status") !== "all")
          return Response.json(
            { error: "expected ?status=all" },
            { status: 400 },
          );
        return Response.json({ proposals: [] });
      }
      if (url.pathname === "/events")
        return Response.json({
          events: [
            {
              source: "factory-cli",
              eventId,
              status: "noop",
              lastPlanError: "ticket_not_todo",
            },
          ],
        });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const { exitCode, stdout } = await runDispatch(server, [
      "status",
      "--watch",
    ]);
    expect(exitCode).toBe(3);
    expect(stdout).toContain("settled: NOOP");
    expect(stdout).toContain("ticket_not_todo");
    expect(stdout.match(/ticket_not_todo/g)).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});

test("dispatch --watch reports AWAITING_APPROVAL when the proposal has no run yet", async () => {
  let eventId = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/replay") {
        const event = await request.json();
        eventId = event.eventId;
        return Response.json({ admitted: true, eventId });
      }
      if (url.pathname === "/proposals") {
        if (url.searchParams.get("status") !== "all")
          return Response.json(
            { error: "expected ?status=all" },
            { status: 400 },
          );
        return Response.json({
          proposals: [
            {
              id: "prop-42",
              eventSource: "factory-cli",
              eventId,
              status: "open",
              runId: null,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const { exitCode, stdout } = await runDispatch(server, [
      "status",
      "--json",
      "--watch",
    ]);
    expect(exitCode).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({
      runId: null,
      state: "AWAITING_APPROVAL",
      reasonCode: "awaiting_approval",
      proposalId: "prop-42",
      proposalStatus: "open",
    });
  } finally {
    server.stop(true);
  }
});

test("dispatch --watch exits 2 with WATCH_TIMEOUT when the run never settles", async () => {
  const server = watchServer({ state: "RUNNING", reasonCode: null });
  try {
    const { exitCode, stdout } = await runDispatch(
      server,
      ["status", "--json", "--watch"],
      { FACTORY_DISPATCH_WATCH_MAX_MS: "30" },
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      runId: "run-watch-test",
      state: "WATCH_TIMEOUT",
      reasonCode: "watch_timeout",
    });
  } finally {
    server.stop(true);
  }
});
