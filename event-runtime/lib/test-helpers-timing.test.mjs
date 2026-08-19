import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-test-helpers-timing-test-mjs";
import {
  TIMING_TEST_SUBSTRINGS,
  classifyTimingFailures,
  escapeRegex,
  formatTimingClassifyAnnotation,
  freePort,
  isTimingTestName,
  parseFailingTests,
  timingExcludePattern,
  timingIncludePattern,
  until,
} from "./test-helpers-timing.mjs";

const HELPER = fileURLToPath(
  new URL("./test-helpers-timing.mjs", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("timing-test registry (WM-918)", () => {
  test("every timing substring still appears in the tree (rename = update the list)", () => {
    const files = [
      "event-runtime/cli/work.test.mjs",
      "event-runtime/cli/supervise.test.mjs",
      "event-runtime/demo/seed.test.mjs",
      "bin/factory.test.mjs",
      "event-runtime/lib/adapters/cursor.test.mjs",
    ];
    const haystack = files
      .map((rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8"))
      .join("\n");
    for (const substring of TIMING_TEST_SUBSTRINGS) {
      expect(haystack.includes(substring), substring).toBe(true);
    }
  });

  test("include pattern matches each substring and exclude pattern matches none of them", () => {
    const include = new RegExp(timingIncludePattern());
    const exclude = new RegExp(timingExcludePattern());
    for (const substring of TIMING_TEST_SUBSTRINGS) {
      const full = `suite > ${substring}`;
      expect(include.test(full)).toBe(true);
      expect(exclude.test(full)).toBe(false);
    }
    expect(
      exclude.test(
        "doctor against a healthy live serve outputs anomalies none and exits 0",
      ),
    ).toBe(true);
    expect(include.test("a purely deterministic unit test name")).toBe(false);
  });

  test("escapeRegex keeps literal parentheses from becoming capturing groups", () => {
    const re = new RegExp(
      escapeRegex("seed & re-seed deduplication (OPS-464)"),
    );
    expect(re.test("seed & re-seed deduplication (OPS-464)")).toBe(true);
    expect(re.test("seed & re-seed deduplication OPS-464")).toBe(false);
  });

  test("parseFailingTests reads bun (fail) and ✗ lines", () => {
    const log = [
      "(fail) event-runtime/cli/work.test.mjs > work --drain-file (WM-226) > a drain-signalled worker holding a lease finishes its run first, then exits 0",
      "  ✗ surplus idle workers drain back to workers.min, and the pool is not respawned past target [20000.00ms]",
      "(fail) event-runtime/lib/notify.test.mjs > notify (WM-65) > a hanging notifier is killed at the timeout and never delays the caller",
    ].join("\n");
    expect(parseFailingTests(log)).toEqual([
      "a drain-signalled worker holding a lease finishes its run first, then exits 0",
      "surplus idle workers drain back to workers.min, and the pool is not respawned past target",
      "a hanging notifier is killed at the timeout and never delays the caller",
    ]);
  });

  test("classifyTimingFailures flags an all-timing log and mixed failures separately", () => {
    const allTiming = classifyTimingFailures(
      "(fail) x > a drain-signalled worker holding a lease finishes its run first, then exits 0\n",
    );
    expect(allTiming.allTiming).toBe(true);
    expect(allTiming.other).toEqual([]);
    expect(formatTimingClassifyAnnotation(allTiming)).toContain(
      "title=timing-flake",
    );

    const mixed = classifyTimingFailures(
      [
        "(fail) x > a drain-signalled worker holding a lease finishes its run first, then exits 0",
        "(fail) y > zero-pack merged-view digest matches the develop baseline",
      ].join("\n"),
    );
    expect(mixed.allTiming).toBe(false);
    expect(mixed.other).toEqual([
      "zero-pack merged-view digest matches the develop baseline",
    ]);
    expect(formatTimingClassifyAnnotation(mixed)).toContain(
      "title=non-timing-fail",
    );
    expect(isTimingTestName("unrelated")).toBe(false);
  });

  test("CLI prints exclude/include patterns and classify annotation", () => {
    const exclude = spawnSync("bun", [HELPER, "exclude-pattern"], {
      encoding: "utf8",
    });
    expect(exclude.status).toBe(0);
    expect(exclude.stdout.trim()).toBe(timingExcludePattern());

    const include = spawnSync("bun", [HELPER, "include-pattern"], {
      encoding: "utf8",
    });
    expect(include.status).toBe(0);
    expect(include.stdout.trim()).toBe(timingIncludePattern());

    const dir = tmpDir("evrt-timing-cli-");
    const logFile = path.join(dir, "bun-test.log");
    writeFileSync(
      logFile,
      "(fail) x > factory notify posts a structured inbox item when serve is reachable\n",
    );
    const classified = spawnSync("bun", [HELPER, "classify", logFile], {
      encoding: "utf8",
    });
    expect(classified.status).toBe(0);
    expect(classified.stdout).toContain("title=timing-flake");
    expect(classified.stdout).toContain("all failures are in the timing group");
  });
});

describe("until and freePort (WM-918)", () => {
  test("until returns the first truthy value and throws when the ceiling elapses", async () => {
    let n = 0;
    expect(
      await until("counter", () => ++n >= 3, { timeoutMs: 1000, everyMs: 1 }),
    ).toBe(true);
    expect(n).toBe(3);

    let caught = null;
    try {
      await until("never", () => false, { timeoutMs: 20, everyMs: 5 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught.message)).toContain("never did not become true");
  });

  test("freePort returns a bindable loopback port", async () => {
    const port = Number(freePort());
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    const server = Bun.serve({
      port,
      fetch: () => new Response("ok"),
    });
    try {
      expect(server.port).toBe(port);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("ok");
    } finally {
      server.stop(true);
    }
  });
});
