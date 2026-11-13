import { describe, expect, test } from "bun:test";
import { CANCEL_MAX_PAGES, cancelWithClient, stateRunIds } from "./cancel.mjs";

function captureConsole() {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values) => out.push(values.join(" "));
  console.error = (...values) => err.push(values.join(" "));
  return {
    out,
    err,
    restore: () => ((console.log = log), (console.error = error)),
  };
}

describe("cancel", () => {
  test("cancels every ID in a multi-page state selection", async () => {
    const runCalls = [];
    const cancelled = [];
    const client = {
      runs: async (options) => {
        runCalls.push(options);
        return options.before
          ? { runs: [{ runId: "run-2" }], nextBefore: null }
          : { runs: [{ runId: "run-1" }], nextBefore: "cursor-1" };
      },
      cancel: async (runId, reason) => cancelled.push([runId, reason]),
    };
    const consoleCapture = captureConsole();
    try {
      await cancelWithClient(client, ["--state", "proposed", "--yes"]);
    } finally {
      consoleCapture.restore();
    }

    expect(runCalls).toEqual([
      { state: "PROPOSED" },
      { state: "PROPOSED", before: "cursor-1" },
    ]);
    expect(cancelled.sort()).toEqual([
      ["run-1", undefined],
      ["run-2", undefined],
    ]);
    expect(consoleCapture.out).toEqual([
      "run-1",
      "run-2",
      "cancelled run-1",
      "cancelled run-2",
    ]);
  });

  test("dry-run prints every multi-page target without cancelling", async () => {
    const runCalls = [];
    const client = {
      runs: async (options) => {
        runCalls.push(options);
        return options.before
          ? { runs: [{ runId: "run-2" }], nextBefore: null }
          : { runs: [{ runId: "run-1" }], nextBefore: "cursor-1" };
      },
      cancel: async () => {
        throw new Error("dry-run must not cancel");
      },
    };
    const consoleCapture = captureConsole();
    try {
      await cancelWithClient(client, [
        "--state",
        "PROPOSED",
        "--agent",
        "worker@1",
        "--dry-run",
      ]);
    } finally {
      consoleCapture.restore();
    }

    expect(runCalls).toEqual([
      { state: "PROPOSED", agent: "worker@1" },
      { state: "PROPOSED", agent: "worker@1", before: "cursor-1" },
    ]);
    expect(consoleCapture.out).toEqual(["run-1", "run-2"]);
  });

  test("preserves explicit-ID cancellation", async () => {
    const cancelled = [];
    const client = {
      runs: async () => {
        throw new Error("explicit IDs must not list runs");
      },
      cancel: async (runId, reason) => cancelled.push([runId, reason]),
    };

    await cancelWithClient(client, ["run-1", "run-2", "--reason", "cleanup"]);

    expect(cancelled.sort()).toEqual([
      ["run-1", "cleanup"],
      ["run-2", "cleanup"],
    ]);
  });

  test("rejects an unbounded state selection before cancelling targets", async () => {
    let calls = 0;
    const client = {
      runs: async () => {
        calls += 1;
        return {
          runs: [{ runId: `run-${calls}` }],
          nextBefore: `cursor-${calls}`,
        };
      },
    };

    await expect(stateRunIds(client, { state: "PROPOSED" })).rejects.toThrow(
      `${CANCEL_MAX_PAGES} page cap`,
    );
    expect(calls).toBe(CANCEL_MAX_PAGES);
  });
});
