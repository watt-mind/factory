/**
 * apiClient() credential handling (#1132, follow-up to #1152/#956): the bearer
 * goes on the wire when a token is configured, stays off when it is not, and a
 * 401 comes back as an actionable message that never carries the token value.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  apiClient,
  resolveControlApiTarget,
  unauthorizedMessage,
} from "./client.mjs";

const TOKEN = "test-secret-token-1132";
let server;
let port;
let lastAuthorization;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      lastAuthorization = req.headers.get("authorization");
      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/runs") {
        if (lastAuthorization !== `Bearer ${TOKEN}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ runs: [] });
      }
      if (url.pathname.startsWith("/artifacts/")) {
        if (lastAuthorization !== `Bearer ${TOKEN}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return new Response("fake report body", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.pathname === "/agents") {
        return Response.json(
          { error: "control_api_token_unset" },
          { status: 503 },
        );
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  port = server.port;
});

afterAll(() => {
  server?.stop(true);
});

test("sends the bearer when a token is passed", async () => {
  const client = apiClient({ port, token: TOKEN });
  lastAuthorization = undefined;
  await expect(client.runs()).resolves.toEqual({ runs: [] });
  expect(lastAuthorization).toBe(`Bearer ${TOKEN}`);
});

test("an explicit target outranks environment and local config", () => {
  expect(
    resolveControlApiTarget({
      target: "https://flag.example.test/api",
      env: {
        FACTORY_EVENT_HOST: "env.example.test:7444",
        FACTORY_CONTROL_API_URL: "https://control.example.test",
      },
      localConfig: { url: "https://config.example.test:7555" },
    }),
  ).toEqual({
    baseUrl: "https://flag.example.test/api",
    host: "flag.example.test",
    port: 443,
    source: "explicit",
  });
});

test("normalizes a configured bare host and preserves its non-default port", () => {
  expect(
    resolveControlApiTarget({
      env: {},
      localConfig: { host: "runner.whale-pike.ts.net:7389" },
      allowInsecure: true,
    }),
  ).toEqual({
    baseUrl: "http://runner.whale-pike.ts.net:7389",
    host: "runner.whale-pike.ts.net",
    port: 7389,
    source: "config",
  });
});

test("uses the documented environment order before local config", () => {
  const localConfig = { url: "https://config.example.test:7555" };
  expect(
    resolveControlApiTarget({
      env: {
        FACTORY_EVENT_HOST: "event-host.example.test:7444",
        FACTORY_CONTROL_API_URL: "https://control-url.example.test",
      },
      localConfig,
      allowInsecure: true,
    }).baseUrl,
  ).toBe("http://event-host.example.test:7444");
  expect(
    resolveControlApiTarget({
      env: { FACTORY_CONTROL_API_URL: "https://control-url.example.test" },
      localConfig,
    }).baseUrl,
  ).toBe("https://control-url.example.test");
  expect(resolveControlApiTarget({ env: {}, localConfig }).baseUrl).toBe(
    "https://config.example.test:7555",
  );
});

// FACTORY_EVENT_URL already names the handoff event URL (tools/handoff.mjs,
// docs/remote-handoff.md). Honouring it here would silently redirect a handoff
// operator's control bearer, so #2188's AC was narrowed to exclude it.
test("ignores FACTORY_EVENT_URL — it belongs to remote handoff", () => {
  expect(
    resolveControlApiTarget({
      env: { FACTORY_EVENT_URL: "https://event-url.example.test" },
      localConfig: {},
      defaultPort: 7381,
    }),
  ).toEqual({
    baseUrl: "http://127.0.0.1:7381",
    host: "127.0.0.1",
    port: 7381,
    source: "default",
  });
});

test("refuses to send the bearer in plaintext to a non-loopback host", () => {
  expect(() =>
    resolveControlApiTarget({
      env: { FACTORY_EVENT_HOST: "runner.example.test:7381" },
      localConfig: {},
    }),
  ).toThrow(/refusing to send the control API bearer in plaintext/);
  expect(() =>
    resolveControlApiTarget({
      env: { FACTORY_EVENT_HOST: "runner.example.test:7381" },
      localConfig: {},
    }),
  ).toThrow(/FACTORY_CONTROL_API_ALLOW_INSECURE=1/);

  // https is always fine, and so is plaintext that never leaves the box.
  expect(
    resolveControlApiTarget({
      env: { FACTORY_EVENT_HOST: "https://runner.example.test" },
      localConfig: {},
    }).baseUrl,
  ).toBe("https://runner.example.test");
  for (const loopback of [
    "127.0.0.1:7381",
    "localhost:7381",
    "127.9.9.9:7000",
  ]) {
    expect(
      resolveControlApiTarget({
        env: { FACTORY_EVENT_HOST: loopback },
        localConfig: {},
      }).baseUrl,
    ).toBe(`http://${loopback}`);
  }

  // The explicit opt-in is honoured, so a trusted tailnet stays reachable.
  expect(
    resolveControlApiTarget({
      env: {
        FACTORY_EVENT_HOST: "runner.example.test:7381",
        FACTORY_CONTROL_API_ALLOW_INSECURE: "1",
      },
      localConfig: {},
    }).baseUrl,
  ).toBe("http://runner.example.test:7381");
});

// The reviewer's blocking concern on #2192: a library that reads ambient state
// would retarget every existing caller. Only a caller that names no target at
// all resolves; `{ port }` keeps the historic loopback pin (§14).
test("apiClient({ port }) stays pinned to loopback whatever the environment says", () => {
  const saved = process.env.FACTORY_EVENT_HOST;
  process.env.FACTORY_EVENT_HOST = "https://elsewhere.example.test";
  try {
    const client = apiClient({ port: 7999, token: null });
    expect(client.host).toBe("127.0.0.1");
    expect(client.port).toBe(7999);
    expect(client.baseUrl).toBe("http://127.0.0.1:7999");
  } finally {
    if (saved === undefined) delete process.env.FACTORY_EVENT_HOST;
    else process.env.FACTORY_EVENT_HOST = saved;
  }
});

test("apiClient with no target resolves the environment target", () => {
  const saved = process.env.FACTORY_EVENT_HOST;
  process.env.FACTORY_EVENT_HOST = "https://elsewhere.example.test";
  try {
    expect(apiClient({ token: null }).baseUrl).toBe(
      "https://elsewhere.example.test",
    );
  } finally {
    if (saved === undefined) delete process.env.FACTORY_EVENT_HOST;
    else process.env.FACTORY_EVENT_HOST = saved;
  }
});

test("uses the resolved URL while preserving bearer propagation", async () => {
  lastAuthorization = undefined;
  const client = apiClient({
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
  });
  await expect(client.runs()).resolves.toEqual({ runs: [] });
  expect(client.host).toBe("127.0.0.1");
  expect(client.port).toBe(port);
  expect(lastAuthorization).toBe(`Bearer ${TOKEN}`);
});

test("sends no authorization header when the token is unset", async () => {
  const client = apiClient({ port, token: null });
  lastAuthorization = undefined;
  await client.health();
  expect(lastAuthorization).toBeNull();
});

test("401 without a token maps to the actionable message", async () => {
  const client = apiClient({ port, token: null });
  let err;
  await client.runs().catch((e) => (err = e));
  expect(err).toBeInstanceOf(Error);
  expect(err.status).toBe(401);
  expect(err.message).toBe(
    "control API requires FACTORY_CONTROL_API_TOKEN; set it in ~/.factory/secrets.env",
  );
  expect(err.message).toBe(unauthorizedMessage(false));
});

test("401 with a rejected token names the variable, never the value", async () => {
  const wrong = "wrong-token-value-1132";
  const client = apiClient({ port, token: wrong });
  let err;
  await client.runs().catch((e) => (err = e));
  expect(err.status).toBe(401);
  expect(err.message).toBe("control API rejected FACTORY_CONTROL_API_TOKEN");
  expect(err.message).toBe(unauthorizedMessage(true));
  expect(err.message).not.toContain(wrong);
  expect(String(err.stack)).not.toContain(wrong);
});

test("503 token-unset response maps to the same actionable setup message", async () => {
  const client = apiClient({ port, token: null });
  let err;
  await client.agents().catch((e) => (err = e));
  expect(err.status).toBe(503);
  expect(err.message).toBe(unauthorizedMessage(false));
  expect(err.message).toContain("FACTORY_CONTROL_API_TOKEN");
  expect(err.message).toContain("~/.factory/secrets.env");
});

test("non-401 errors keep the server's message and status", async () => {
  const client = apiClient({ port, token: TOKEN });
  let err;
  await client.repos().catch((e) => (err = e));
  expect(err.status).toBe(404);
  expect(err.message).toBe("not found");
});

test("artifact() presents the bearer on GET /artifacts/:sha and returns the raw body", async () => {
  const res = await apiClient({ port, token: TOKEN }).artifact("a".repeat(64));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("fake report body");
  expect(lastAuthorization).toBe(`Bearer ${TOKEN}`);
});

test("artifact() without a token gets the gate's 401 (regression: worktree-up verify)", async () => {
  const res = await apiClient({ port, token: null }).artifact("a".repeat(64));
  expect(res.status).toBe(401);
  expect(lastAuthorization).toBeNull();
});
