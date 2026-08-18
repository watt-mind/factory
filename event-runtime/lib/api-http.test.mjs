import { trackTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-http-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GH_SECRET,
  PV,
  SECRET,
  apiClient,
  deregisterWorker,
  envelope,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  makeServer as makeApiServer,
  mkdirSync,
  observedModelFromTranscript,
  openDb,
  os,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  rejection,
  repoNamesFromInput,
  registry,
  runOnce,
  sign,
  startApi,
  utimesSync,
  writeFileSync,
} from "./api-test-helpers.mjs";

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

describe("Host and Origin header security confinement (OPS-408)", () => {
  let s;
  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  function rawRequest({
    host = "127.0.0.1",
    path = "/",
    method = "GET",
    headers = {},
    body,
  } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: s.port,
          path,
          method,
          headers: { host, ...headers },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* intentionally ignored */
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json,
              text,
            });
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  test("isLoopbackHost accepts loopback variants and rejects remote/malformed hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:7381")).toBe(true);
    expect(isLoopbackHost("127.0.0.2:7381")).toBe(true);
    expect(isLoopbackHost("0.0.0.0:7381")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost:7381")).toBe(true);
    expect(isLoopbackHost("app.localhost:7381")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::1]:7381")).toBe(true);

    expect(isLoopbackHost("my-mac.local")).toBe(false);
    expect(isLoopbackHost("device.local:7381")).toBe(false);
    expect(isLoopbackHost("evil.com")).toBe(false);
    expect(isLoopbackHost("evil.com:7381")).toBe(false);
    expect(isLoopbackHost("192.168.1.100")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  test("isLoopbackOrigin accepts loopback origins and rejects foreign/malformed origins", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:7382")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.2:7382")).toBe(true);
    expect(isLoopbackOrigin("http://0.0.0.0:7382")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:7382")).toBe(true);
    expect(isLoopbackOrigin("http://localhost")).toBe(true);
    expect(isLoopbackOrigin("http://app.localhost:7382")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:7382")).toBe(true);

    expect(isLoopbackOrigin("http://my-mac.local:7382")).toBe(false);
    expect(isLoopbackOrigin("http://attacker.local")).toBe(false);
    expect(isLoopbackOrigin("http://evil.com")).toBe(false);
    expect(isLoopbackOrigin("https://evil.com:7382")).toBe(false);
    expect(isLoopbackOrigin("http://192.168.1.100:7382")).toBe(false);
    expect(isLoopbackOrigin("")).toBe(false);
    expect(isLoopbackOrigin(null)).toBe(false);
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin("not-a-valid-url")).toBe(false);
  });

  test("rejects request with non-loopback Host header", async () => {
    const res = await rawRequest({ host: "attacker.com", path: "/health" });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("invalid_host");
  });

  test("rejects request with an mDNS .local Host header", async () => {
    const res = await rawRequest({
      host: "device.local:7381",
      path: "/health",
    });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("invalid_host");
  });

  test("new metrics routes inherit Host and Origin confinement", async () => {
    const badHost = await rawRequest({
      host: "attacker.com",
      path: "/metrics?window=24h&bucket=1h&series=runs.outcomes",
    });
    expect(badHost.status).toBe(403);
    expect(badHost.json?.error).toBe("invalid_host");

    const badOrigin = await rawRequest({
      path: "/metrics/breakdown?window=24h&by=agent&metric=runs",
      headers: { origin: "http://evil.com" },
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.json?.error).toBe("cross_origin_rejected");
  });

  test("rejects mutating request carrying a foreign Origin header", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/replay",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.com",
      },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("cross_origin_rejected");
  });

  test("rejects mutating request carrying an mDNS .local Origin header", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/replay",
      headers: {
        "content-type": "application/json",
        origin: "http://attacker.local:7382",
      },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("cross_origin_rejected");
  });

  test("rejects janitor apply carrying a foreign Origin header", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/repos/watched/janitor",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.com",
      },
      body: JSON.stringify({ apply: true }),
    });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("cross_origin_rejected");
  });

  test("allows loopback mutating requests from Web UI Origin header (WM-61)", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/replay",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:7382",
      },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(200);
    expect(res.json?.admitted).toBe(true);
  });

  test("allows normal loopback mutating requests without Origin header", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/replay",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(200);
    expect(res.json?.admitted).toBe(true);
  });

  test("collection endpoints return ETags and 304 for matching If-None-Match", async () => {
    for (const path of [
      "/runs",
      "/events",
      "/proposals",
      "/workers",
      "/agents",
      "/status",
      "/repos",
      "/artifacts",
    ]) {
      const first = await rawRequest({ path });
      expect(first.status).toBe(200);
      expect(first.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);

      const cached = await rawRequest({
        path,
        headers: { "if-none-match": first.headers.etag },
      });
      expect(cached.status).toBe(304);
      expect(cached.headers.etag).toBe(first.headers.etag);
      expect(cached.text).toBe("");

      const stale = await rawRequest({
        path,
        headers: { "if-none-match": '"stale"' },
      });
      expect(stale.status).toBe(200);
      expect(stale.headers.etag).toBe(first.headers.etag);
      expect(stale.text).toBe(first.text);
    }
  });
});
