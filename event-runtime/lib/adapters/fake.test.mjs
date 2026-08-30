import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-fake-test-mjs";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  HOLD_PREFIX,
  execute,
  holdMarkerFile,
  holdUntilReleased,
} from "./fake.mjs";
import { until } from "../test-helpers-timing.mjs";

const def = { ref: "factory-status-report@1" };
const spec = (mode) => ({
  agent: "factory-status-report@1",
  outputContract: "factory.status-report/v1",
  input: { repos: [mode] },
});

/** A pending promise's state, without racing a timer against it. */
async function settled(promise) {
  const marker = Symbol("pending");
  const winner = await Promise.race([promise, Promise.resolve(marker)]);
  return winner !== marker;
}

describe("fake adapter hold/release (gh-1423)", () => {
  test("hold:<file> stays in flight until the release file exists, then completes", async () => {
    const dir = tmpDir("evrt-fake-hold-");
    const ws = tmpDir("evrt-fake-hold-ws-");
    const releaseFile = path.join(dir, "release");
    const run = execute({
      spec: spec(`${HOLD_PREFIX}${releaseFile}`),
      def,
      workspaceDir: ws,
      timeoutMs: 30_000,
      env: {},
    });

    // The marker is the positive signal that the adapter is inside the hold.
    await until("hold marker to appear", () =>
      existsSync(holdMarkerFile(releaseFile)),
    );
    expect(await settled(run)).toBe(false);
    expect(existsSync(path.join(ws, "result.json"))).toBe(false);

    writeFileSync(releaseFile, "go\n", "utf8");
    const outcome = await run;
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const result = JSON.parse(
      readFileSync(path.join(ws, "result.json"), "utf8"),
    );
    expect(result.terminalState).toBe("completed");
    expect(result.artifact.repos[0].name).toBe("hold");
  });

  test("a held run times out when never released", async () => {
    const dir = tmpDir("evrt-fake-hold-timeout-");
    const ws = tmpDir("evrt-fake-hold-timeout-ws-");
    const outcome = await execute({
      spec: spec(`${HOLD_PREFIX}${path.join(dir, "never")}`),
      def,
      workspaceDir: ws,
      timeoutMs: 60,
      env: {},
    });
    expect(outcome).toEqual({ exitCode: null, timedOut: true });
    expect(existsSync(path.join(ws, "result.json"))).toBe(false);
  });

  test("abort releases a held run immediately, and is not a timeout", async () => {
    const dir = tmpDir("evrt-fake-hold-abort-");
    const ws = tmpDir("evrt-fake-hold-abort-ws-");
    const controller = new AbortController();
    const run = execute({
      spec: spec(`${HOLD_PREFIX}${path.join(dir, "never")}`),
      def,
      workspaceDir: ws,
      timeoutMs: 30_000,
      env: {},
      abortSignal: controller.signal,
    });
    await until("hold marker to appear", () =>
      existsSync(holdMarkerFile(path.join(dir, "never"))),
    );
    controller.abort();
    expect(await run).toEqual({ exitCode: null, timedOut: false });
  });

  test("holdUntilReleased resolves aborted at once on an already-aborted signal", async () => {
    const dir = tmpDir("evrt-fake-hold-preaborted-");
    const releaseFile = path.join(dir, "release");
    const controller = new AbortController();
    controller.abort();
    expect(
      await holdUntilReleased({
        releaseFile,
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    ).toBe("aborted");
    expect(existsSync(holdMarkerFile(releaseFile))).toBe(false);
  });

  test("hold mode refuses an empty release path", async () => {
    expect(
      holdUntilReleased({ releaseFile: "", timeoutMs: 10 }),
    ).rejects.toThrow("hold mode needs a release file path");
  });
});
