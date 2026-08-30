/**
 * apiClient() credential handling (#1132, follow-up to #1152/#956): the bearer
 * goes on the wire when a token is configured, stays off when it is not, and a
 * 401 comes back as an actionable message that never carries the token value.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { apiClient, unauthorizedMessage } from "./client.mjs";

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
