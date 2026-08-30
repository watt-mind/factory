import { expect, test } from "bun:test";
import path from "node:path";
import { DEFAULT_PORT, resolvePort } from "./dispatch.mjs";

const DISPATCH = path.join(import.meta.dir, "dispatch.mjs");

test("defaults to the standard event-runtime port", () => {
  expect(DEFAULT_PORT).toBe(7381);
  expect(resolvePort({})).toBe(7381);
});

test("FACTORY_EVENT_PORT overrides the default port", () => {
  expect(resolvePort({ FACTORY_EVENT_PORT: "8123" })).toBe(8123);
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
