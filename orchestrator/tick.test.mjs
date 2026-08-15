import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { observeChildTermination } from "./tick.mjs";

describe("observeChildTermination", () => {
  test("handles an asynchronous spawn error and settles only once", async () => {
    const child = new EventEmitter();
    const spawnError = Object.assign(new Error("spawn agent ENOENT"), { code: "ENOENT" });
    const outcomes = [];

    observeChildTermination(child, async (outcome) => {
      outcomes.push(outcome);
    });

    expect(() => child.emit("error", spawnError)).not.toThrow();
    await Promise.resolve();
    child.emit("close", -2);
    await Promise.resolve();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({ error: spawnError, code: null });
  });

  test("handles a real failed spawn without an uncaught exception", async () => {
    const child = spawn("/definitely-not-a-factory-agent-binary", []);
    const outcome = await new Promise((resolve) => {
      observeChildTermination(child, resolve);
    });

    expect(outcome.code).toBeNull();
    expect(outcome.error?.code).toBe("ENOENT");
  });

  test("settles normal child closure without an error", async () => {
    const child = new EventEmitter();
    const outcomes = [];

    observeChildTermination(child, async (outcome) => {
      outcomes.push(outcome);
    });

    child.emit("close", 0);
    await Promise.resolve();

    expect(outcomes).toEqual([{ error: null, code: 0 }]);
  });
});
