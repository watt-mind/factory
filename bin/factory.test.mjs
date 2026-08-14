import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runNotify({ args, stdin = "", exitCode = "0" }) {
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
    },
  });
  return {
    status: result.exitCode,
    args: readFileSync(argsFile, "utf8"),
    stdin: readFileSync(stdinFile, "utf8"),
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


