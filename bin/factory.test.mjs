import { test, expect } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FACTORY = path.resolve(import.meta.dir, "factory");

function makeServeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-serve-"));
  const webDir = path.join(root, "event-runtime", "web");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(webDir, { recursive: true });
  copyFileSync(FACTORY, path.join(root, "bin", "factory"));
  writeFileSync(
    path.join(webDir, "serve.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.WEB_STARTED, String(process.pid));
process.on("SIGTERM", () => {
  writeFileSync(process.env.WEB_STOPPED, "stopped");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
  );
  writeFileSync(
    path.join(root, "event-runtime", "cli.mjs"),
    `if (process.env.RUNTIME_EXIT_CODE)
  process.exit(Number(process.env.RUNTIME_EXIT_CODE));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await Bun.sleep(25);
  }
  return false;
}

test("factory help documents every dispatcher verb", () => {
  const source = readFileSync(FACTORY, "utf8");
  const dispatcher = source.match(/case "\$cmd" in([\s\S]*?)\nesac/);
  expect(dispatcher).not.toBeNull();

  const verbs = [...dispatcher[1].matchAll(/^ {2}([a-z][a-z-]*)\)/gm)].map(
    ([, verb]) => verb,
  );
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "help"],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  const help = result.stdout.toString();
  for (const verb of verbs) {
    expect(help).toMatch(new RegExp(`^  ${verb}\\s`, "m"));
  }
});

test("factory serve --web stops the web server when the runtime receives SIGTERM", async () => {
  const fixture = makeServeFixture();
  const webStarted = path.join(fixture.root, "web-started");
  const webStopped = path.join(fixture.root, "web-stopped");
  let webPid = null;
  const proc = Bun.spawn({
    cmd: ["bash", path.join(fixture.root, "bin", "factory"), "serve", "--web"],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WEB_STARTED: webStarted,
      WEB_STOPPED: webStopped,
    },
  });
  try {
    expect(await waitForFile(webStarted)).toBe(true);
    webPid = Number(readFileSync(webStarted, "utf8"));

    proc.kill("SIGTERM");
    await proc.exited;

    expect(existsSync(webStopped)).toBe(true);
    expect(
      Bun.spawnSync({ cmd: ["kill", "-0", String(webPid)] }).exitCode,
    ).not.toBe(0);
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
    if (Number.isInteger(webPid) && webPid > 0)
      Bun.spawnSync({ cmd: ["kill", "-TERM", String(webPid)] });
    fixture.cleanup();
  }
}, 10_000);

test("factory serve --web propagates the runtime exit code", () => {
  const fixture = makeServeFixture();
  try {
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        path.join(fixture.root, "bin", "factory"),
        "serve",
        "--web",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RUNTIME_EXIT_CODE: "23" },
    });

    expect(result.exitCode).toBe(23);
  } finally {
    fixture.cleanup();
  }
});

function makeNotifier(dir) {
  const notifier = path.join(dir, "notify_stub.py");
  writeFileSync(
    notifier,
    `import os
import sys
from pathlib import Path

Path(os.environ["FACTORY_NOTIFY_TEST_ARGS"]).write_text("\\n".join(sys.argv[1:]) + "\\n")
Path(os.environ["FACTORY_NOTIFY_TEST_STDIN"]).write_text(sys.stdin.read())
sys.exit(int(os.environ.get("FACTORY_NOTIFY_TEST_EXIT", "0")))
`,
  );
  return notifier;
}

function runNotify({ args, stdin = "", exitCode = "0", env = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-notify-"));
  const argsFile = path.join(dir, "args");
  const stdinFile = path.join(dir, "stdin");
  const notifier = makeNotifier(dir);
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "notify", ...args],
    cwd: dir,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FACTORY_NOTIFY_SCRIPT: notifier,
      FACTORY_NOTIFY_TEST_ARGS: argsFile,
      FACTORY_NOTIFY_TEST_STDIN: stdinFile,
      FACTORY_NOTIFY_TEST_EXIT: exitCode,
      FACTORY_EVENT_PORT: "1", // deterministic unreachable-runtime fallback
      ...env,
    },
  });
  return {
    status: result.exitCode,
    args: existsSync(argsFile) ? readFileSync(argsFile, "utf8") : null,
    stdin: existsSync(stdinFile) ? readFileSync(stdinFile, "utf8") : null,
    stderr: result.stderr.toString(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withInboxStub(response, fn, status = 201) {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-inbox-server-"));
  const requestFile = path.join(dir, "request.json");
  const headersFile = path.join(dir, "headers.json");
  const serverScript = path.join(dir, "server.py");
  writeFileSync(
    serverScript,
    `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        with open(${JSON.stringify(requestFile)}, "w") as f:
            f.write(self.rfile.read(length).decode())
        with open(${JSON.stringify(headersFile)}, "w") as f:
            f.write(json.dumps({k.lower(): v for k, v in self.headers.items()}))
        body = json.dumps(json.loads(${JSON.stringify(JSON.stringify(response))})).encode()
        self.send_response(${status})
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_): pass
server = HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.handle_request()
`,
  );
  const server = Bun.spawn({
    cmd: ["python3", serverScript],
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = server.stdout.getReader();
  const { value } = await reader.read();
  const port = Number(new TextDecoder().decode(value).trim());
  try {
    return await fn({ port, requestFile, headersFile });
  } finally {
    server.kill();
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("factory notify delegates argv to the notifier from any cwd", () => {
  const result = runNotify({ args: ["BLOCKED", "LAB-176:", "need approval"] });
  try {
    expect(result.status).toBe(0);
    expect(result.args).toBe("BLOCKED\nLAB-176:\nneed approval\n");
    expect(result.stdin).toBe("");
  } finally {
    result.cleanup();
  }
});

test("factory notify preserves stdin mode and the notifier exit code", () => {
  const result = runNotify({
    args: ["-"],
    stdin: "CI RED LAB-176: test failure\n",
    exitCode: "7",
  });
  try {
    expect(result.status).toBe(7);
    expect(result.args).toBe("-\n");
    expect(result.stdin).toBe("CI RED LAB-176: test failure\n");
  } finally {
    result.cleanup();
  }
});

test("factory notify posts a structured inbox item when serve is reachable", async () => {
  await withInboxStub(
    { delivery: { ok: true } },
    async ({ port, requestFile }) => {
      const result = runNotify({
        args: ["BLOCKED", "WM-1:", "choose policy"],
        env: { FACTORY_EVENT_PORT: String(port), FACTORY_RUN_ID: "run_test" },
      });
      try {
        expect(result.status).toBe(0);
        expect(result.args).toBeNull();
        const body = JSON.parse(readFileSync(requestFile, "utf8"));
        expect(body).toEqual({
          kind: "BLOCKED",
          title: "BLOCKED WM-1: choose policy",
          refs: { issue: "WM-1" },
          source: "agent:run_test",
        });
      } finally {
        result.cleanup();
      }
    },
  );
});

// #1132: the durable /inbox POST must present the operator credential when
// FACTORY_CONTROL_API_TOKEN is configured (#1152), and stay header-free when
// it is not. Note that runNotify spreads process.env, so the unset case has to
// override any token the operator's shell carries.
test("factory notify sends the bearer on /inbox when FACTORY_CONTROL_API_TOKEN is set", async () => {
  const token = "notify-test-token-1132";
  await withInboxStub(
    { delivery: { ok: true } },
    async ({ port, headersFile }) => {
      const result = runNotify({
        args: ["BLOCKED", "WM-1:", "choose policy"],
        env: {
          FACTORY_EVENT_PORT: String(port),
          FACTORY_CONTROL_API_TOKEN: token,
        },
      });
      try {
        expect(result.status).toBe(0);
        const headers = JSON.parse(readFileSync(headersFile, "utf8"));
        expect(headers.authorization).toBe(`Bearer ${token}`);
        expect(result.stderr).not.toContain(token);
      } finally {
        result.cleanup();
      }
    },
  );
});

test("factory notify sends no authorization header when FACTORY_CONTROL_API_TOKEN is unset", async () => {
  await withInboxStub(
    { delivery: { ok: true } },
    async ({ port, headersFile }) => {
      const result = runNotify({
        args: ["BLOCKED", "WM-1:", "choose policy"],
        env: {
          FACTORY_EVENT_PORT: String(port),
          FACTORY_CONTROL_API_TOKEN: "",
        },
      });
      try {
        expect(result.status).toBe(0);
        const headers = JSON.parse(readFileSync(headersFile, "utf8"));
        expect(headers.authorization).toBeUndefined();
      } finally {
        result.cleanup();
      }
    },
  );
});

test("factory notify diagnoses a rejected inbox response before exiting terminally", async () => {
  await withInboxStub(
    { error: "inbox validation failed" },
    async ({ port }) => {
      const result = runNotify({
        args: ["BLOCKED", "WM-1:", "choose policy"],
        env: { FACTORY_EVENT_PORT: String(port) },
      });
      try {
        expect(result.status).toBe(10);
        expect(result.stderr).toContain(
          "notify: control API POST /inbox failed: HTTP 500 inbox validation failed",
        );
      } finally {
        result.cleanup();
      }
    },
    500,
  );
});

test("factory notify falls back to direct transport when durable record succeeds but serve push fails", async () => {
  await withInboxStub(
    {
      item: { id: "inbox_wm759" },
      delivery: { ok: false, exitCode: 9, error: "telegram unavailable" },
    },
    async ({ port, requestFile }) => {
      const result = runNotify({
        args: ["BLOCKED", "WM-1:", "choose policy"],
        env: { FACTORY_EVENT_PORT: String(port) },
      });
      try {
        expect(result.status).toBe(0);
        expect(result.args).toBe("BLOCKED\nWM-1:\nchoose policy\n");
        expect(result.stderr).toContain("inbox item inbox_wm759 stored");
        expect(result.stderr).toContain("telegram unavailable");
        expect(result.stderr).toContain("falling back to direct transport");
        const body = JSON.parse(readFileSync(requestFile, "utf8"));
        expect(body.kind).toBe("BLOCKED");
      } finally {
        result.cleanup();
      }
    },
  );
});

test("factory notify prints why when durable-ok push-failed and the fallback also fails", async () => {
  await withInboxStub(
    {
      item: { id: "inbox_undeliverable" },
      delivery: { ok: false, exitCode: 9, error: "telegram unavailable" },
    },
    async ({ port }) => {
      const result = runNotify({
        args: ["ESCALATED", "WM-1:", "need a human"],
        exitCode: "7",
        env: { FACTORY_EVENT_PORT: String(port) },
      });
      try {
        expect(result.status).toBe(7);
        expect(result.args).toBe("ESCALATED\nWM-1:\nneed a human\n");
        expect(result.stderr).toContain("telegram unavailable");
      } finally {
        result.cleanup();
      }
    },
  );
});

test("factory ps executes orchestrator/ps.mjs via CLI", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "ps", "--json"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout.toString());
  expect(data.timestamp).toBeDefined();
  expect(data.summary).toBeDefined();
  expect(Array.isArray(data.controlPlane)).toBe(true);
});

test("factory workers executes orchestrator/workers.mjs via CLI", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "workers", "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("factory workers");
});

test("factory logs rotate delegates to live-stack with logs rotate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-logs-"));
  const argsFile = path.join(root, "args");
  const factory = path.join(root, "bin", "factory");
  const liveStack = path.join(root, "bin", "live-stack.sh");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  copyFileSync(FACTORY, factory);
  writeFileSync(
    liveStack,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FACTORY_LOGS_TEST_ARGS"
`,
  );
  chmodSync(liveStack, 0o755);

  try {
    const result = Bun.spawnSync({
      cmd: ["bash", factory, "logs", "rotate"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_LOGS_TEST_ARGS: argsFile },
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(argsFile, "utf8")).toBe("logs\nrotate\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("factory approve delegates to event-runtime/cli.mjs", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "approve"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("usage: approve <proposal-id>");
});

test("factory reject delegates to event-runtime/cli.mjs", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "reject"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    'usage: reject <proposal-id> "<reason>"',
  );
});

test("factory inject delegates to event-runtime/cli.mjs", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "inject"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("usage: inject <envelope.json|->");
});

test("factory pulse executes via CLI", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "pulse", "--json"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(result.stdout.toString());
  expect(json).toHaveProperty("stack");
  expect(json).toHaveProperty("supply");
  expect(json).toHaveProperty("workspace");
});

test("factory watchdog executes via CLI", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", FACTORY, "watchdog", "--json", "--once"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stdout.toString().length).toBeGreaterThan(0);
  const json = JSON.parse(result.stdout.toString());
  expect(json).toHaveProperty("ok");
  expect(json).toHaveProperty("issues");
  expect(json).toHaveProperty("metrics");
});
