import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { callClaude } from "./grader.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 999_999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    child.emit("signal", signal);
  };
  return child;
}

function waitForSignal(child, signal) {
  if (child.signals.includes(signal)) return Promise.resolve();
  return new Promise((resolve) => {
    child.on("signal", (received) => {
      if (received === signal) resolve();
    });
  });
}

function graderCall(child, options = {}) {
  return callClaude({
    prompt: "grade this",
    model: "test-model",
    cwd: process.cwd(),
    timeoutMs: 10,
    budgetUsd: 1,
    killGraceMs: 10,
    spawnFn: () => child,
    ...options,
  });
}

describe("grader process termination", () => {
  test("sends TERM then KILL after the configured grace period", async () => {
    const child = fakeChild();
    const pending = graderCall(child);

    await waitForSignal(child, "SIGKILL");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    child.emit("close", 1);
    await pending;
  });

  test("deduplicates abort and timeout termination", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const pending = graderCall(child, { signal: controller.signal });
    controller.abort();

    await waitForSignal(child, "SIGKILL");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    child.emit("close", 1);
    await pending;
  });
});
