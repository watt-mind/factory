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
  // Records every process-group signal instead of letting the shared helper
  // reach process.kill(-pid, …) — a fake pid must never signal a live group.
  child.killFn = (pid, signal) => {
    expect(pid).toBe(-child.pid);
    child.signals.push(signal);
    child.emit("signal", signal);
  };
  child.kill = (signal) => {
    throw new Error(
      `child.kill(${signal}) must not be reached: killFn was injected`,
    );
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
    killFn: child.killFn,
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
    // Abort and timeout both escalate, yet exactly one TERM and one KILL land.
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signals).toHaveLength(2);

    child.emit("close", 1);
    await pending;
  });
});
