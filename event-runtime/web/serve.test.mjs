import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
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
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function requestProxy(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const headers = { "x-proxy-test": `${method.toLowerCase()}-marker` };
    if (body !== undefined) {
      headers["content-type"] = "text/plain";
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    const req = http.request(
      { hostname: "127.0.0.1", port: webPort, method, path: `/api${pathname}`, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proxy.stdout.getReader();
  const startup = await reader.read();
  reader.releaseLock();
  if (startup.done) {
    throw new Error(`proxy exited during startup: ${await new Response(proxy.stderr).text()}`);
  }
  expect(new TextDecoder().decode(startup.value)).toContain(`http://127.0.0.1:${webPort}`);
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
    const response = await fetch(`http://127.0.0.1:${webPort}/assets/Proposals-stale.js`);

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
  ])("forwards %s without a request body even when the client sends one", async (method, body) => {
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
  });

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
