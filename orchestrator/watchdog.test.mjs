import { test, expect } from "bun:test";
import {
  fetchRecentSandboxRefusals,
  formatWatchdogReport,
  recentSandboxRefusals,
  runWatchdogCheck,
} from "./watchdog.mjs";

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

test("recentSandboxRefusals joins recent typed journal entries to agents", () => {
  const now = Date.parse("2026-08-29T20:00:00Z");
  const refusals = recentSandboxRefusals(
    {
      entries: [
        {
          runId: "run_recent",
          to: "REFUSED",
          reason:
            "work-scan@1: sandbox_unavailable:qemu — qemu-system-x86_64 is not on PATH",
          at: "2026-08-29T19:45:00Z",
        },
        {
          runId: "run_old",
          to: "REFUSED",
          reason: "sandbox_unavailable:qemu",
          at: "2026-08-29T18:00:00Z",
        },
        {
          runId: "run_other",
          to: "REFUSED",
          reason: "permission_denied",
          at: "2026-08-29T19:50:00Z",
        },
      ],
    },
    {
      runs: [
        { runId: "run_recent", agent: "work-scan@1" },
        { runId: "run_old", agent: "triage-scan@1" },
        { runId: "run_other", agent: "factory-status-report@1" },
      ],
    },
    { now },
  );

  expect(refusals).toEqual([
    {
      runId: "run_recent",
      agent: "work-scan@1",
      reason:
        "work-scan@1: sandbox_unavailable:qemu — qemu-system-x86_64 is not on PATH",
      at: "2026-08-29T19:45:00Z",
    },
  ]);
});

test("fetchRecentSandboxRefusals paginates the terminal window and ignores non-scan agents", async () => {
  const requests = [];
  const fetchFn = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname === "/runs/run_scan") {
      return Response.json({
        lifecycle: [
          {
            to_state: "REFUSED",
            reason: "ci-doctor@2: sandbox_unavailable:qemu",
            at: "2026-08-29T19:50:00Z",
          },
        ],
      });
    }
    if (!url.searchParams.has("before")) {
      return Response.json({
        runs: Array.from({ length: 200 }, (_, index) => ({
          runId: `run_other_${index}`,
          agent: "factory-status-report@1",
        })),
        nextBefore: "page-2",
      });
    }
    return Response.json({
      runs: [{ runId: "run_scan", agent: "ci-doctor@2" }],
      nextBefore: null,
    });
  };

  await expect(
    fetchRecentSandboxRefusals({
      fetchFn,
      now: Date.parse("2026-08-29T20:00:00Z"),
    }),
  ).resolves.toEqual([
    {
      runId: "run_scan",
      agent: "ci-doctor@2",
      reason: "ci-doctor@2: sandbox_unavailable:qemu",
      at: "2026-08-29T19:50:00Z",
    },
  ]);
  expect(requests.filter((url) => url.pathname === "/runs")).toHaveLength(2);
  expect(requests[0].searchParams.get("population")).toBe("terminal");
  expect(requests[1].searchParams.get("before")).toBe("page-2");
});

test("runWatchdogCheck surfaces sandbox-unavailable scan refusals", async () => {
  const at = new Date().toISOString();
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname === "/status") {
        return Response.json({ runs: { byState: {} }, anomalies: {} });
      }
      if (url.pathname === "/workers") {
        return Response.json({
          workers: [{ workerId: "worker_1", state: "idle" }],
        });
      }
      if (url.pathname === "/runs/run_scan") {
        return Response.json({
          lifecycle: [
            {
              to_state: "REFUSED",
              reason: "work-scan@1: sandbox_unavailable:qemu",
              at,
            },
          ],
        });
      }
      if (url.pathname === "/runs") {
        return Response.json(
          url.searchParams.get("state") === "REFUSED"
            ? {
                runs: [{ runId: "run_scan", agent: "work-scan@1" }],
                nextBefore: null,
              }
            : { runs: [] },
        );
      }
      return new Response("ok");
    },
  });

  try {
    const result = await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      checkShadowFleet: false,
    });
    expect(result.ok).toBe(false);
    expect(result.metrics.sandboxRefusals).toHaveLength(1);
    expect(result.issues).toContainEqual({
      severity: "CRITICAL",
      code: "SCAN_SANDBOX_UNAVAILABLE",
      message: "Scan loops refused: sandbox unavailable (work-scan@1)",
    });
  } finally {
    server.stop(true);
  }
});

test("runWatchdogCheck detects unreachable API as critical", async () => {
  // A hardcoded port assumes nothing else is listening on it, which a
  // stranger process (or a concurrent worktree) can invalidate (#876).
  // Bind loopback:0 to get OS-assigned ports, then release them
  // immediately so they are unreachable when runWatchdogCheck fetches them.
  const apiProbe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = apiProbe.port;
  apiProbe.stop(true);

  const webProbe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const webPort = webProbe.port;
  webProbe.stop(true);

  const result = await runWatchdogCheck({
    port,
    webPort,
    checkShadowFleet: false,
  });

  expect(result.ok).toBe(false);
  expect(result.issues.some((i) => i.code === "API_DOWN")).toBe(true);
});
