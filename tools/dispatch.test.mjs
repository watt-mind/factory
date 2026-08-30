import { expect, test } from "bun:test";
import path from "node:path";
import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  resolvePort,
  resolveTimeoutMs,
} from "./dispatch.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DISPATCH = path.join(import.meta.dir, "dispatch.mjs");

async function dispatch(env) {
  const proc = Bun.spawn(["bun", "tools/dispatch.mjs", "triage", "--json"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

test("defaults to the standard event-runtime port", () => {
  expect(DEFAULT_PORT).toBe(7381);
  expect(resolvePort({})).toBe(7381);
});

test("FACTORY_EVENT_PORT overrides the default port", () => {
  expect(resolvePort({ FACTORY_EVENT_PORT: "8123" })).toBe(8123);
});

test("FACTORY_DISPATCH_TIMEOUT_MS overrides the default timeout", () => {
  expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
  expect(resolveTimeoutMs({ FACTORY_DISPATCH_TIMEOUT_MS: "1234" })).toBe(1234);
});

test("sends the bearer only when FACTORY_CONTROL_API_TOKEN is set", async () => {
  const authorizations = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      authorizations.push(req.headers.get("authorization"));
      return Response.json({ eventId: "event-1" });
    },
  });

  try {
    const withToken = await dispatch({
      FACTORY_EVENT_PORT: String(server.port),
      FACTORY_CONTROL_API_TOKEN: "dispatch-test-token",
    });
    expect(withToken.exitCode).toBe(0);

    const withoutToken = await dispatch({
      FACTORY_EVENT_PORT: String(server.port),
      FACTORY_CONTROL_API_TOKEN: "",
    });
    expect(withoutToken.exitCode).toBe(0);
    expect(authorizations).toEqual(["Bearer dispatch-test-token", null]);
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

test("fails fast with the request path and configured timeout", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Promise(() => {});
    },
  });

  try {
    const result = await dispatch({
      FACTORY_EVENT_PORT: String(server.port),
      FACTORY_DISPATCH_TIMEOUT_MS: "50",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "control API request to /replay timed out after 50ms",
    );
  } finally {
    server.stop(true);
  }
});
