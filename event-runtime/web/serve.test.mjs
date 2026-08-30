import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.join(WEB_DIR, "dist", "index.html");

let api;
let apiPort;
let proxy;
let webPort;
let createdDistIndex = false;
const received = [];

function reservePort() {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function requestProxy(
  method,
  pathname,
  body,
  extraHeaders = {},
  port = webPort,
) {
  return new Promise((resolve, reject) => {
    const headers = {
      "x-proxy-test": `${method.toLowerCase()}-marker`,
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers["content-type"] = "text/plain";
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: `/api${pathname}`,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  if (!existsSync(DIST_INDEX)) {
    mkdirSync(path.dirname(DIST_INDEX), { recursive: true });
    writeFileSync(DIST_INDEX, "<!doctype html><title>proxy test</title>");
    createdDistIndex = true;
  }

  // Start the proxy while its upstream port is deliberately closed. The
  // recovery test opens an API on this same port after proving a failed fetch
  // neither escapes nor kills the static server.
  apiPort = reservePort();
  webPort = reservePort();
  proxy = Bun.spawn(["bun", path.join(WEB_DIR, "serve.mjs")], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      FACTORY_EVENT_PORT: String(apiPort),
      FACTORY_EVENT_WEB_PORT: String(webPort),
      FACTORY_EVENT_WEB_ALLOWED_HOSTS: "",
      FACTORY_CONTROL_API_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proxy.stdout.getReader();
  const startup = await reader.read();
  reader.releaseLock();
  if (startup.done) {
    throw new Error(
      `proxy exited during startup: ${await new Response(proxy.stderr).text()}`,
    );
  }
  expect(new TextDecoder().decode(startup.value)).toContain(
    `http://127.0.0.1:${webPort}`,
  );
});

afterAll(async () => {
  proxy?.kill();
  await proxy?.exited;
  api?.stop(true);
  if (createdDistIndex) {
    unlinkSync(DIST_INDEX);
    try {
      rmdirSync(path.dirname(DIST_INDEX));
    } catch {
      // Keep a non-empty dist directory created by another process.
    }
  }
});

describe("event-runtime web static files", () => {
  test("returns an honest 404 for a stale content-hashed asset", async () => {
    const response = await fetch(
      `http://127.0.0.1:${webPort}/assets/Proposals-stale.js`,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("asset not found");
  });

  test("keeps the SPA fallback for client-side routes", async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/proposals`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

describe("event-runtime web API proxy", () => {
  test("returns 503 while the API is down, stays alive, then recovers", async () => {
    const unavailable = await requestProxy("GET", "/health");

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(unavailable.body)).toEqual({
      error: "event runtime temporarily unavailable",
    });
    expect(proxy.exitCode).toBe(null);

    api = Bun.serve({
      hostname: "127.0.0.1",
      port: apiPort,
      async fetch(req) {
        const url = new URL(req.url);
        received.push({
          method: req.method,
          pathname: url.pathname,
          body: await req.text(),
          marker: req.headers.get("x-proxy-test"),
        });
        return new Response("forwarded", {
          status: url.pathname === "/health" ? 200 : 201,
          headers: { "x-upstream-method": req.method },
        });
      },
    });

    const recovered = await requestProxy("GET", "/health");
    expect(recovered.status).toBe(200);
    expect(recovered.body).toBe("forwarded");
    expect(proxy.exitCode).toBe(null);
  });

  test.each([
    ["GET", undefined],
    ["GET", "ignored get payload"],
    ["HEAD", undefined],
    ["HEAD", "ignored head payload"],
  ])(
    "forwards %s without a request body even when the client sends one",
    async (method, body) => {
      const pathname = `/bodyless-${method.toLowerCase()}-${body === undefined ? "empty" : "supplied"}`;
      const response = await requestProxy(method, pathname, body);

      expect(response.status).toBe(201);
      expect(response.headers["x-upstream-method"]).toBe(method);
      const forwarded = received.find((entry) => entry.pathname === pathname);
      expect(forwarded).toEqual({
        method,
        pathname,
        body: "",
        marker: `${method.toLowerCase()}-marker`,
      });
    },
  );

  test.each([
    ["POST", "post payload"],
    ["PUT", "put payload"],
  ])("forwards the %s payload and headers intact", async (method, body) => {
    const pathname = `/payload-${method.toLowerCase()}`;
    const response = await requestProxy(method, pathname, body);

    expect(response.status).toBe(201);
    expect(response.body).toBe("forwarded");
    expect(received.find((entry) => entry.pathname === pathname)).toEqual({
      method,
      pathname,
      body,
      marker: `${method.toLowerCase()}-marker`,
    });
  });
});

// WM-973: FACTORY_EVENT_WEB_ALLOWED_HOSTS — tailnet hosts without weakening
// the API loopback guard. The env var is read at import time, so these tests
// exercise the helper behavior through subprocess-free direct requests using
// the already-running server (loopback) plus Host-header variation.
describe("allowed hosts (WM-973)", () => {
  test("unlisted non-loopback Host is rejected at the web layer", async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/`, {
      headers: { host: "attacker.example" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("invalid_host");
  });

  test("cross-site Origin is rejected even on a loopback Host", async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/health`, {
      headers: { origin: "https://attacker.example" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("cross_origin_rejected");
  });

  test("loopback Origin still passes", async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/health`, {
      headers: { origin: `http://127.0.0.1:${webPort}` },
    });
    expect(res.status).not.toBe(403);
  });
});

describe("tailnet write authentication", () => {
  test("non-loopback writes require the browser bearer and replace it upstream", async () => {
    const token = "tailnet-control-token";
    const tailHost = "runner.example.ts.net";
    const isolatedApiPort = reservePort();
    const isolatedWebPort = reservePort();
    const upstream = [];
    const isolatedApi = Bun.serve({
      hostname: "127.0.0.1",
      port: isolatedApiPort,
      async fetch(req) {
        upstream.push({
          method: req.method,
          authorization: req.headers.get("authorization"),
          body: await req.text(),
        });
        return new Response("forwarded", { status: 200 });
      },
    });
    const isolatedProxy = Bun.spawn(["bun", path.join(WEB_DIR, "serve.mjs")], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        FACTORY_EVENT_PORT: String(isolatedApiPort),
        FACTORY_EVENT_WEB_PORT: String(isolatedWebPort),
        FACTORY_EVENT_WEB_ALLOWED_HOSTS: tailHost,
        FACTORY_CONTROL_API_TOKEN: token,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const startup = await isolatedProxy.stdout.getReader().read();
      expect(new TextDecoder().decode(startup.value)).toContain(
        `http://127.0.0.1:${isolatedWebPort}`,
      );

      const missing = await requestProxy(
        "POST",
        "/inbox/x/decide",
        "{}",
        { host: tailHost },
        isolatedWebPort,
      );
      expect(missing.status).toBe(401);
      expect(JSON.parse(missing.body)).toEqual({ error: "unauthorized" });
      expect(upstream).toHaveLength(0);

      const wrong = await requestProxy(
        "POST",
        "/inbox/x/decide",
        "{}",
        { host: tailHost, authorization: "Bearer wrong" },
        isolatedWebPort,
      );
      expect(wrong.status).toBe(401);
      expect(upstream).toHaveLength(0);

      const accepted = await requestProxy(
        "POST",
        "/inbox/x/decide",
        "{}",
        { host: tailHost, authorization: `Bearer ${token}` },
        isolatedWebPort,
      );
      expect(accepted.status).toBe(200);
      expect(upstream.at(-1)).toEqual({
        method: "POST",
        authorization: `Bearer ${token}`,
        body: "{}",
      });

      const readable = await requestProxy(
        "GET",
        "/status",
        undefined,
        { host: tailHost },
        isolatedWebPort,
      );
      expect(readable.status).toBe(200);
      expect(upstream.at(-1)).toEqual({
        method: "GET",
        authorization: `Bearer ${token}`,
        body: "",
      });
    } finally {
      isolatedProxy.kill();
      await isolatedProxy.exited;
      isolatedApi.stop(true);
    }
  });

  test("allowed hosts with no configured token fail writes closed from loopback", async () => {
    const isolatedWebPort = reservePort();
    const isolatedProxy = Bun.spawn(["bun", path.join(WEB_DIR, "serve.mjs")], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        FACTORY_EVENT_PORT: String(reservePort()),
        FACTORY_EVENT_WEB_PORT: String(isolatedWebPort),
        FACTORY_EVENT_WEB_ALLOWED_HOSTS: "runner.example.ts.net",
        FACTORY_CONTROL_API_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await isolatedProxy.stdout.getReader().read();
      const response = await requestProxy(
        "POST",
        "/inbox/x/decide",
        "{}",
        {},
        isolatedWebPort,
      );
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual({
        error: "control_api_token_unset",
      });
    } finally {
      isolatedProxy.kill();
      await isolatedProxy.exited;
    }
  });

  test("upstream timeout returns 504 with api_busy payload", async () => {
    const slowApiPort = reservePort();
    const slowWebPort = reservePort();
    const slowApi = Bun.serve({
      hostname: "127.0.0.1",
      port: slowApiPort,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const timeoutProxy = Bun.spawn(["bun", path.join(WEB_DIR, "serve.mjs")], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        FACTORY_EVENT_PORT: String(slowApiPort),
        FACTORY_EVENT_WEB_PORT: String(slowWebPort),
        FACTORY_WEB_PROXY_TIMEOUT_MS: "100",
        FACTORY_EVENT_WEB_ALLOWED_HOSTS: "",
        FACTORY_CONTROL_API_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await timeoutProxy.stdout.getReader().read();
      const response = await requestProxy(
        "GET",
        "/status",
        undefined,
        {},
        slowWebPort,
      );
      expect(response.status).toBe(504);
      expect(response.headers["retry-after"]).toBe("5");
      expect(JSON.parse(response.body)).toEqual({
        error: "api_busy",
        message: "event runtime is busy",
      });
    } finally {
      timeoutProxy.kill();
      await timeoutProxy.exited;
      slowApi.stop(true);
    }
  });
});
