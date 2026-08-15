import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FACTORY = path.resolve(import.meta.dir, "factory");

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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
  const result = runNotify({ args: ["-"], stdin: "CI RED LAB-176: test failure\n", exitCode: "7" });
  try {
    expect(result.status).toBe(7);
    expect(result.args).toBe("-\n");
    expect(result.stdin).toBe("CI RED LAB-176: test failure\n");
  } finally {
    result.cleanup();
  }
});

test("factory notify posts a structured inbox item when serve is reachable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-inbox-server-"));
  const requestFile = path.join(dir, "request.json");
  const serverScript = path.join(dir, "server.py");
  const port = 31000 + (process.pid % 10000);
  writeFileSync(serverScript, `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        with open(${JSON.stringify(requestFile)}, "w") as f:
            f.write(self.rfile.read(length).decode())
        body = json.dumps({"delivery": {"ok": True}}).encode()
        self.send_response(201)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_): pass
server = HTTPServer(("127.0.0.1", ${port}), Handler)
print("ready", flush=True)
server.handle_request()
`);
  const server = Bun.spawn({ cmd: ["python3", serverScript], stdout: "pipe", stderr: "pipe" });
  const reader = server.stdout.getReader();
  await reader.read();

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
    server.kill();
    await server.exited;
    result.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
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
  expect(result.stderr.toString()).toContain('usage: reject <proposal-id> "<reason>"');
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
