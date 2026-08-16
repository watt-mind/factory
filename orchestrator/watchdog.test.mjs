import { test, expect } from "bun:test";
import { formatWatchdogReport, runWatchdogCheck } from "./watchdog.mjs";

test("formatWatchdogReport formats clean watchdog status", () => {
  const cleanResult = {
    ok: true,
    issues: [],
    metrics: {
      apiOk: true,
      webOk: true,
      workersCount: 3,
      runningRuns: 1,
      wedgedRuns: 0,
      queuedRuns: 0,
      anomalies: [],
    },
  };

  const formatted = formatWatchdogReport(cleanResult);
  expect(formatted).toContain("WATCHDOG OK");
  expect(formatted).toContain("Workers: 3");
  expect(formatted).toContain("Running: 1");
});

test("formatWatchdogReport formats critical issues", () => {
  const badResult = {
    ok: false,
    issues: [
      {
        severity: "CRITICAL",
        code: "WEDGED_RUN",
        message: "Run run_test_123 in RUNNING for 55m without progress",
      },
      {
        severity: "WARNING",
        code: "WEB_DOWN",
        message: "Web UI on :7382 unreachable",
      },
    ],
    metrics: {
      apiOk: true,
      webOk: false,
      workersCount: 2,
      runningRuns: 1,
      wedgedRuns: 1,
      queuedRuns: 0,
      anomalies: [],
    },
  };

  const formatted = formatWatchdogReport(badResult);
  expect(formatted).toContain("WATCHDOG CRITICAL");
  expect(formatted).toContain("[CRITICAL]");
  expect(formatted).toContain("WEDGED_RUN");
  expect(formatted).toContain("[WARNING]");
  expect(formatted).toContain("WEB_DOWN");
});

test("runWatchdogCheck detects unreachable API as critical", async () => {
  const result = await runWatchdogCheck({
    port: 59998, // unreachable
    webPort: 59997,
    checkShadowFleet: false,
  });

  expect(result.ok).toBe(false);
  expect(result.issues.some((i) => i.code === "API_DOWN")).toBe(true);
});
