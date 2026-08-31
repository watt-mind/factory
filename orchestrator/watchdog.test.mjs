import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assessServeHealth,
  controlApiFailureCode,
  fetchRecentSandboxRefusals,
  formatWatchdogReport,
  idleApprovalGateReason,
  idleTickFailureCode,
  inFlightFromByState,
  isScanLoopAgent,
  liveIdleWatchdogDeps,
  runIdleWatchdogTick,
  runWatchdogCheck,
  FLEET_CHECK_TIMEOUT_MS,
  SANDBOX_REFUSAL_MAX_PAGES,
  SANDBOX_REFUSAL_MAX_RUNS,
  SCAN_LOOP_AGENTS,
} from "./watchdog.mjs";

test("assessServeHealth flags a served stale registry and reload error", () => {
  const result = assessServeHealth(
    {
      registry: {
        stamp: "files:old",
        loadedAt: "2026-08-30T12:00:00.000Z",
        lastReloadError: {
          at: "2026-08-30T12:01:00.000Z",
          message: "invalid agent pin",
        },
      },
    },
    { expectedRegistryStamp: "files:current" },
  );

  expect(result.ok).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toEqual([
    "REGISTRY_STALE",
    "REGISTRY_RELOAD_ERROR",
  ]);
});

test("assessServeHealth tolerates an absent planner block", () => {
  const result = assessServeHealth(
    { registry: { stamp: "files:current", lastReloadError: null } },
    { expectedRegistryStamp: "files:current", queuedEvents: 4 },
  );

  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
});

test("assessServeHealth rejects a stale planner while admitted events wait", () => {
  const result = assessServeHealth(
    {
      registry: { stamp: "files:current", lastReloadError: null },
      planner: { lastPlannedAt: "2026-08-30T11:45:00.000Z" },
    },
    {
      expectedRegistryStamp: "files:current",
      queuedEvents: 2,
      now: Date.parse("2026-08-30T12:00:00.000Z"),
    },
  );

  expect(result.ok).toBe(false);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "PLANNER_STALE" }),
  );
});

test("formatWatchdogReport formats clean watchdog status", () => {
  const cleanResult = {
    ok: true,
    issues: [],
    metrics: {
      apiOk: true,
      webOk: true,
      workersCount: 3,
      inFlightRuns: 1,
      leasedRuns: 0,
      runningRuns: 1,
      verifyingRuns: 0,
      wedgedRuns: 0,
      queuedRuns: 0,
      anomalies: [],
    },
  };

  const formatted = formatWatchdogReport(cleanResult);
  expect(formatted).toContain("WATCHDOG OK");
  expect(formatted).toContain("Workers: 3");
  expect(formatted).toContain(
    "In flight: 1 (running 1, verifying 0, leased 0)",
  );
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
      inFlightRuns: 1,
      leasedRuns: 0,
      runningRuns: 1,
      verifyingRuns: 0,
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

test("formatWatchdogReport keeps the fleet metrics line on warning/critical", () => {
  const formatted = formatWatchdogReport({
    ok: false,
    issues: [
      {
        severity: "CRITICAL",
        code: "FLEET_OFFLINE",
        message: "5 CI runs queued with 0 online shadow runners",
      },
    ],
    metrics: {
      apiOk: true,
      webOk: true,
      workersCount: 1,
      inFlightRuns: 0,
      leasedRuns: 0,
      runningRuns: 0,
      verifyingRuns: 0,
      wedgedRuns: 0,
      queuedRuns: 0,
      anomalies: [],
      fleetQueued: 5,
      fleetOnlineShadows: 0,
    },
  });
  expect(formatted).toContain("FLEET_OFFLINE");
  expect(formatted).toContain("Fleet: queued 5 | online shadows 0");
});

test("SCAN_LOOP_AGENTS is exactly the set the confinement gate can refuse", () => {
  // Derive from the shipped definitions: a new non-mutating workspace-only
  // agent must be added here, or its refusals go unnoticed the way #1250's
  // did with a three-agent hardcoded regex.
  const agentsDir = path.join(import.meta.dir, "..", "event-runtime", "agents");
  const derived = readdirSync(agentsDir)
    .filter((file) => file.endsWith(".json") && !file.includes(".view."))
    .map((file) => JSON.parse(readFileSync(path.join(agentsDir, file), "utf8")))
    .filter(
      (def) =>
        def?.mutating === false &&
        def?.capabilities?.filesystem === "workspace-only",
    )
    .map((def) => def.id)
    .sort();

  expect([...SCAN_LOOP_AGENTS].sort()).toEqual(derived);
  expect(isScanLoopAgent("work-scan@1")).toBe(true);
  expect(isScanLoopAgent("acme/work-scan@1")).toBe(true);
  expect(isScanLoopAgent("dispatch@1")).toBe(false);
  expect(isScanLoopAgent("label-guard@1")).toBe(false);
  expect(isScanLoopAgent(undefined)).toBe(false);
});

test("fetchRecentSandboxRefusals is bounded in pages, runs, and wall clock", async () => {
  const listings = [];
  let details = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const fetchFn = async (input) => {
    const url = new URL(input);
    if (url.pathname.startsWith("/runs/")) {
      details += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Bun.sleep(1);
      inFlight -= 1;
      return Response.json({
        lifecycle: [
          {
            to_state: "REFUSED",
            reason: "work-scan@1: sandbox_unavailable:qemu",
            at: "2026-08-29T19:50:00Z",
          },
        ],
      });
    }
    listings.push(url);
    // An unbounded scan would follow this cursor forever.
    return Response.json({
      runs: Array.from({ length: 400 }, (_, index) => ({
        runId: `run_${listings.length}_${index}`,
        agent: "work-scan@1",
      })),
      nextBefore: `page-${listings.length + 1}`,
    });
  };

  const refusals = await fetchRecentSandboxRefusals({ fetchFn });

  expect(listings.length).toBeLessThanOrEqual(SANDBOX_REFUSAL_MAX_PAGES);
  expect(listings[0].searchParams.get("limit")).toBe(
    String(SANDBOX_REFUSAL_MAX_RUNS),
  );
  expect(details).toBe(SANDBOX_REFUSAL_MAX_RUNS);
  expect(refusals).toHaveLength(SANDBOX_REFUSAL_MAX_RUNS);
  expect(peakInFlight).toBeLessThanOrEqual(4);
});

test("fetchRecentSandboxRefusals abandons the scan when its time budget is spent", async () => {
  let clock = 0;
  const fetchFn = async (input) => {
    const url = new URL(input);
    clock += 100;
    if (url.pathname.startsWith("/runs/")) {
      return Response.json({
        lifecycle: [
          {
            to_state: "REFUSED",
            reason: "work-scan@1: sandbox_unavailable:qemu",
            at: "2026-08-29T19:50:00Z",
          },
        ],
      });
    }
    return Response.json({
      runs: [
        { runId: "run_a", agent: "work-scan@1" },
        { runId: "run_b", agent: "work-scan@1" },
        { runId: "run_c", agent: "work-scan@1" },
      ],
      nextBefore: null,
    });
  };

  // Budget covers the listing plus one detail read; the rest is abandoned
  // rather than allowed to run long on a busy box.
  const refusals = await fetchRecentSandboxRefusals({
    fetchFn,
    budgetMs: 150,
    concurrency: 1,
    clock: () => clock,
  });
  expect(refusals).toHaveLength(1);
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
        runs: Array.from({ length: 40 }, (_, index) => ({
          runId: `run_other_${index}`,
          agent: "dispatch@1",
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

async function runWatchdogWithInFlightRuns({
  leased = [],
  running = [],
  verifying = [],
  queued = 0,
  failDetailFor = [],
} = {}) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/status") {
        return Response.json({
          runs: {
            byState: {
              QUEUED: queued,
              LEASED: leased.length,
              RUNNING: running.length,
              VERIFYING: verifying.length,
            },
          },
        });
      }
      if (url.pathname === "/workers") {
        return Response.json({
          workers: [{ workerId: "worker_1", state: "idle" }],
        });
      }
      if (url.pathname === "/runs") {
        const byState = {
          LEASED: leased,
          RUNNING: running,
          VERIFYING: verifying,
        };
        return Response.json({
          runs: byState[url.searchParams.get("state")] ?? [],
        });
      }
      const runId = url.pathname.match(/^\/runs\/([^/]+)$/)?.[1];
      if (runId) {
        if (failDetailFor.includes(runId)) {
          return new Response("gone", { status: 404 });
        }
        const run = [...leased, ...running, ...verifying].find(
          (entry) => entry.runId === runId,
        );
        if (run) {
          return Response.json({
            attempts: [{ lease_expires_at: run.lease_expires_at ?? null }],
          });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    return await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      stuckMinutes: 45,
      checkShadowFleet: false,
    });
  } finally {
    server.stop(true);
  }
}

test("runWatchdogCheck detects stale active runs", async () => {
  const result = await runWatchdogWithInFlightRuns({
    leased: [
      {
        runId: "run_leased",
        agent: "dispatch@1",
        state: "LEASED",
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
    running: [
      {
        runId: "run_running",
        agent: "dispatch@1",
        state: "RUNNING",
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
  });

  expect(result.metrics).toMatchObject({
    inFlightRuns: 2,
    leasedRuns: 1,
    runningRuns: 1,
    verifyingRuns: 0,
  });
  expect(
    result.issues.filter((issue) => issue.code === "WEDGED_RUN"),
  ).toHaveLength(2);
});

test("runWatchdogCheck does not wedge an old VERIFYING run with a fresh lease", async () => {
  const result = await runWatchdogWithInFlightRuns({
    verifying: [
      {
        runId: "run_verifying_fresh_lease",
        agent: "dispatch@1",
        state: "VERIFYING",
        created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    ],
  });

  expect(result.metrics).toMatchObject({
    inFlightRuns: 1,
    leasedRuns: 0,
    runningRuns: 0,
    verifyingRuns: 1,
  });
  expect(result.issues.some((issue) => issue.code === "WEDGED_RUN")).toBe(
    false,
  );
});

test("runWatchdogCheck wedges an old RUNNING run despite a fresh lease", async () => {
  const result = await runWatchdogWithInFlightRuns({
    running: [
      {
        runId: "run_running_fresh_lease",
        agent: "dispatch@1",
        state: "RUNNING",
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    ],
  });

  expect(result.issues).toContainEqual(
    expect.objectContaining({
      code: "WEDGED_RUN",
      message: expect.stringContaining("in RUNNING"),
    }),
  );
});

test("runWatchdogCheck wedges a VERIFYING run past the absolute ceiling even with a fresh lease", async () => {
  const result = await runWatchdogWithInFlightRuns({
    verifying: [
      {
        runId: "run_verifying_ceiling",
        agent: "dispatch@1",
        state: "VERIFYING",
        created_at: new Date(Date.now() - 140 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 140 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    ],
  });

  expect(result.issues).toContainEqual(
    expect.objectContaining({
      code: "WEDGED_RUN",
      message: expect.stringContaining("in VERIFYING"),
    }),
  );
});

test("runWatchdogCheck detects a stale VERIFYING run without a lease", async () => {
  const result = await runWatchdogWithInFlightRuns({
    verifying: [
      {
        runId: "run_verifying",
        agent: "dispatch@1",
        state: "VERIFYING",
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
  });

  expect(result.metrics.verifyingRuns).toBe(1);
  expect(result.issues).toContainEqual(
    expect.objectContaining({
      code: "WEDGED_RUN",
      message: expect.stringContaining("in VERIFYING"),
    }),
  );
});

test("runWatchdogCheck keeps reporting when one run detail fetch fails", async () => {
  const stale = (runId, state) => ({
    runId,
    agent: "dispatch@1",
    state,
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const result = await runWatchdogWithInFlightRuns({
    running: [stale("run_a", "RUNNING"), stale("run_b", "RUNNING")],
    verifying: [
      {
        ...stale("run_c", "VERIFYING"),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    ],
    failDetailFor: ["run_a"],
  });

  expect(result.metrics.inFlightRuns).toBe(3);
  expect(result.metrics.wedgedRuns).toBe(2);
  expect(
    result.issues
      .filter((issue) => issue.code === "WEDGED_RUN")
      .map((i) => i.message),
  ).toEqual([
    expect.stringContaining("run_a"),
    expect.stringContaining("run_b"),
  ]);
  expect(
    result.issues.some((issue) => issue.code === "STATUS_FETCH_ERROR"),
  ).toBe(false);
});

test("runWatchdogCheck does not report IDLE_STALL with a VERIFYING run", async () => {
  const result = await runWatchdogWithInFlightRuns({
    queued: 1,
    verifying: [
      {
        runId: "run_verifying",
        agent: "dispatch@1",
        state: "VERIFYING",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  });

  expect(result.issues.some((issue) => issue.code === "IDLE_STALL")).toBe(
    false,
  );
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

test("runWatchdogCheck reports control API 401 instead of an empty fleet", async () => {
  const token = "watchdog-control-token";
  const authorization = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response("web");
      authorization.push(req.headers.get("authorization"));
      if (url.pathname === "/health") return Response.json({ ok: true });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    },
  });
  const previous = process.env.FACTORY_CONTROL_API_TOKEN;
  process.env.FACTORY_CONTROL_API_TOKEN = token;

  try {
    const result = await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      checkShadowFleet: false,
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: "CRITICAL",
        code: "API_UNAUTHORIZED",
      }),
    );
    expect(authorization).toEqual(
      Array(authorization.length).fill(`Bearer ${token}`),
    );
  } finally {
    if (previous === undefined) delete process.env.FACTORY_CONTROL_API_TOKEN;
    else process.env.FACTORY_CONTROL_API_TOKEN = previous;
    server.stop(true);
  }
});

function watchdogCheckServer() {
  return Bun.serve({
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
      if (url.pathname === "/runs") return Response.json({ runs: [] });
      return new Response("ok");
    },
  });
}

test("runWatchdogCheck warns when the shadow fleet forge check fails", async () => {
  const server = watchdogCheckServer();
  const forge = {
    runList(_repo, options) {
      expect(options.timeout).toBe(FLEET_CHECK_TIMEOUT_MS);
      throw new Error("gh: HTTP 401");
    },
  };

  try {
    const result = await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      forge,
    });
    expect(result.ok).toBe(true);
    expect(result.metrics.fleetCheck).toBe("error");
    expect(result.issues).toContainEqual({
      severity: "WARNING",
      code: "FLEET_CHECK_ERROR",
      message: "Shadow fleet check failed: gh: HTTP 401",
    });
  } finally {
    server.stop(true);
  }
});

test("runWatchdogCheck survives a throwing loadForge as FLEET_CHECK_ERROR", async () => {
  // A forge that throws on construction (bad config, missing gh) must not
  // kill the whole watchdog: steps 1-3 still report and the fleet check is
  // a WARNING, not an uncaught exception.
  const server = watchdogCheckServer();
  const forge = new Proxy(
    {},
    {
      get() {
        throw new Error("forge config: no host configured");
      },
    },
  );

  try {
    const result = await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      forge,
    });
    expect(result.ok).toBe(true);
    expect(result.metrics.apiOk).toBe(true);
    expect(result.metrics.webOk).toBe(true);
    expect(result.metrics.fleetCheck).toBe("error");
    expect(result.issues).toContainEqual({
      severity: "WARNING",
      code: "FLEET_CHECK_ERROR",
      message: "Shadow fleet check failed: forge config: no host configured",
    });
  } finally {
    server.stop(true);
  }
});

test("runWatchdogCheck reports an offline shadow fleet with queued CI runs", async () => {
  const server = watchdogCheckServer();
  const forge = {
    runList(_repo, options) {
      expect(options.timeout).toBe(FLEET_CHECK_TIMEOUT_MS);
      return [{ status: "queued" }, { status: "queued" }, { status: "queued" }];
    },
    apiRaw(_path, options) {
      expect(options.timeout).toBe(FLEET_CHECK_TIMEOUT_MS);
      return "0";
    },
  };

  try {
    const result = await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      forge,
    });
    expect(result.metrics.fleetQueued).toBe(3);
    expect(result.metrics.fleetOnlineShadows).toBe(0);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "CRITICAL", code: "FLEET_OFFLINE" }),
    );
  } finally {
    server.stop(true);
  }
});

test("runWatchdogCheck records online shadow runners without a fleet issue", async () => {
  const server = watchdogCheckServer();
  const forge = {
    runList() {
      return [{ status: "queued" }, { status: "queued" }, { status: "queued" }];
    },
    apiRaw() {
      return "2";
    },
  };

  try {
    const result = await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      forge,
    });
    expect(result.ok).toBe(true);
    expect(result.metrics.fleetQueued).toBe(3);
    expect(result.metrics.fleetOnlineShadows).toBe(2);
    expect(result.issues.some((issue) => issue.code === "FLEET_OFFLINE")).toBe(
      false,
    );
  } finally {
    server.stop(true);
  }
});

/* ---------------- idle watchdog (#1063) ---------------- */

const openProposal = (over = {}) => ({
  id: "prop_1",
  status: "open",
  decision: "run",
  expired: false,
  agent: "work-scan@1",
  created_at: "2026-08-29T10:00:00.000Z",
  ...over,
});

/** A fake factory: every observation and effect the tick can reach. */
function fakeFactory(over = {}) {
  const calls = {
    approved: [],
    injected: [],
    logs: [],
    notified: [],
    supplyReads: 0,
  };
  const state = {};
  const deps = {
    repo: "factory",
    serveOk: async () => true,
    inFlight: async () => 0,
    proposals: async () => [],
    supply: async () => {
      calls.supplyReads += 1;
      return 0;
    },
    approve: async (id) => calls.approved.push(id),
    inject: async (env) => calls.injected.push(env),
    // The live gate reads config/policy.yaml and the spend log; tests state
    // the gate's answer instead of depending on the operator's machine.
    approvalGate: () => null,
    readState: () => state,
    writeState: (next) => Object.assign(state, next),
    notify: (message) => {
      calls.notified.push(message);
      return true;
    },
    log: (line) => calls.logs.push(line),
    now: () => Date.parse("2026-08-29T12:00:00.000Z"),
    ...over,
  };
  return { deps, calls };
}

test("inFlightFromByState counts only non-terminal states, null on garbage", () => {
  expect(
    inFlightFromByState({ RUNNING: 2, LEASED: 1, COMPLETED: 90, PROPOSED: 4 }),
  ).toBe(3);
  expect(inFlightFromByState({ COMPLETED: 12, FAILED: 3 })).toBe(0);
  expect(inFlightFromByState(null)).toBeNull();
  expect(inFlightFromByState({ RUNNING: "many" })).toBeNull();
});

test("idle with dispatchable supply injects one work-scan", async () => {
  const { deps, calls } = fakeFactory({ supply: async () => 3 });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("inject");
  expect(decision.reason).toBe("idle_with_supply");
  expect(calls.injected).toHaveLength(1);
  expect(calls.injected[0].type).toBe("factory.work.requested");
  expect(calls.injected[0].payload).toEqual({
    repo: "factory",
    reason: "idle-watchdog",
  });
  expect(calls.logs).toHaveLength(1);
});

test("busy factory takes no action and never reads the tracker", async () => {
  const { deps, calls } = fakeFactory({
    inFlight: async () => 2,
    supply: async () => 5,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("none");
  expect(decision.reason).toBe("busy");
  expect(calls.injected).toHaveLength(0);
  expect(calls.approved).toHaveLength(0);
  // The expensive read is skipped entirely when the cheap one already answered.
  expect(calls.supplyReads).toBe(0);
});

test("idle with an empty queue takes no action", async () => {
  const { deps, calls } = fakeFactory({ supply: async () => 0 });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("none");
  expect(decision.reason).toBe("no_supply");
  expect(calls.injected).toHaveLength(0);
});

test("an open dispatch proposal is approved instead of injecting a second scan", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "newer", created_at: "2026-08-29T11:00:00.000Z" }),
      openProposal({ id: "older", agent: "dispatch@1" }),
    ],
    supply: async () => 4,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("approve");
  // Oldest first: the proposal that has waited longest is the stall.
  expect(calls.approved).toEqual(["older"]);
  expect(calls.injected).toHaveLength(0);
});

test("only one proposal is approved per tick — no claim-lock burst", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "p1" }),
      openProposal({ id: "p2", created_at: "2026-08-29T10:30:00.000Z" }),
      openProposal({ id: "p3", created_at: "2026-08-29T10:45:00.000Z" }),
    ],
  });
  await runIdleWatchdogTick(deps);
  expect(calls.approved).toEqual(["p1"]);
});

test("human_needed, expired, and foreign-agent proposals are never approved", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "ask", decision: "human_needed" }),
      openProposal({ id: "stale", expired: true }),
      openProposal({ id: "other", agent: "merge-scan@2" }),
      openProposal({ id: "closed", status: "approved" }),
    ],
    supply: async () => 2,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(calls.approved).toHaveLength(0);
  expect(decision.action).toBe("inject");
});

test("serve unreachable skips — an unreadable factory is not an idle one", async () => {
  const { deps, calls } = fakeFactory({
    serveOk: async () => false,
    supply: async () => 9,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("serve_unreachable");
  expect(calls.injected).toHaveLength(0);
  expect(calls.supplyReads).toBe(0);
});

test("a throwing runtime read skips rather than reading zero as idle", async () => {
  const { deps, calls } = fakeFactory({
    inFlight: async () => {
      throw new Error("database is locked");
    },
    supply: async () => 9,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("runtime_state_unreadable");
  expect(calls.injected).toHaveLength(0);
});

test("a failed supply read skips instead of guessing", async () => {
  const { deps, calls } = fakeFactory({
    supply: async () => {
      throw new Error("tracker timeout");
    },
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("supply_unreadable");
  expect(calls.injected).toHaveLength(0);
});

test("injects are rate-limited to one a minute across one-shot ticks", async () => {
  const persisted = {};
  const base = Date.parse("2026-08-29T12:00:00.000Z");
  let clock = base;
  const { deps, calls } = fakeFactory({
    supply: async () => 3,
    readState: () => ({ ...persisted }),
    writeState: (next) => Object.assign(persisted, next),
    now: () => clock,
  });

  expect((await runIdleWatchdogTick(deps)).decision.action).toBe("inject");
  clock = base + 30_000;
  const throttled = await runIdleWatchdogTick(deps);
  expect(throttled.decision.action).toBe("none");
  expect(throttled.decision.reason).toBe("inject_rate_limited");
  clock = base + 61_000;
  expect((await runIdleWatchdogTick(deps)).decision.action).toBe("inject");
  expect(calls.injected).toHaveLength(2);
});

test("a failed effect is logged on the decision, not swallowed", async () => {
  const { deps, calls } = fakeFactory({
    supply: async () => 1,
    inject: async () => {
      throw new Error("HTTP 503");
    },
  });
  const { decision, acted } = await runIdleWatchdogTick(deps);
  expect(acted).toBe(false);
  expect(decision.error).toBe("HTTP 503");
  expect(calls.logs[0]).toContain("error=HTTP 503");
});

test("every tick logs exactly one decision line", async () => {
  const { deps, calls } = fakeFactory({ supply: async () => 2 });
  await runIdleWatchdogTick(deps);
  expect(calls.logs).toHaveLength(1);
  expect(calls.logs[0]).toContain("idle-watchdog action=inject");
  expect(calls.logs[0]).toContain("inFlight=0");
  expect(calls.logs[0]).toContain("supply=2");
});

/* --- the budget/policy gate (#1063 post-review) --- */

test("a refusing budget gate skips instead of approving as operator", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [openProposal({ id: "waiting" })],
    supply: async () => 4,
    approvalGate: () => "budget_exhausted",
  });
  const { decision, acted } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("budget_gate:budget_exhausted");
  expect(acted).toBe(false);
  expect(calls.approved).toHaveLength(0);
  // Never a fall-through to inject: that would only manufacture another
  // proposal nobody is allowed to approve.
  expect(calls.injected).toHaveLength(0);
});

test("a refusing gate also blocks the inject path", async () => {
  const { deps, calls } = fakeFactory({
    supply: async () => 2,
    approvalGate: () => "runtime_policy_unavailable",
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("skip");
  expect(decision.reason).toBe("budget_gate:runtime_policy_unavailable");
  expect(calls.injected).toHaveLength(0);
});

test("a throwing gate is a refusal, never an approval", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [openProposal({ id: "waiting" })],
    approvalGate: () => {
      throw new Error("policy unreadable");
    },
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.reason).toBe("budget_gate:gate_check_failed");
  expect(calls.approved).toHaveLength(0);
});

test("proposals auto-approval refused on resource grounds are never approved", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({
        id: "budget",
        reason: "auto_approval_ineligible:budget_exhausted",
      }),
      openProposal({
        id: "capacity",
        reason: "auto_approval_ineligible:worker_cap_full",
      }),
      openProposal({
        id: "expired",
        reason: "auto_approval_ineligible:proposal_expired",
      }),
      openProposal({
        id: "policy",
        reason: "auto_approval_ineligible:runtime_policy_unavailable",
      }),
    ],
    supply: async () => 1,
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(calls.approved).toHaveLength(0);
  expect(decision.action).toBe("inject");
});

test("a proposal deferred only because work was in flight is still approvable", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({
        id: "deferred",
        reason: "auto_approval_ineligible:dispatch_recheck_deferred",
      }),
    ],
  });
  const { decision } = await runIdleWatchdogTick(deps);
  expect(decision.action).toBe("approve");
  expect(calls.approved).toEqual(["deferred"]);
});

test("idleApprovalGateReason refuses without a runtime policy on disk", () => {
  expect(idleApprovalGateReason({ runtimePolicy: null })).toBe(
    "runtime_policy_unavailable",
  );
  expect(
    idleApprovalGateReason({
      runtimePolicy: { budget: { per_day_usd: 200 } },
      budgetCheck: () => "day budget spent",
    }),
  ).toBe("budget_exhausted");
  expect(
    idleApprovalGateReason({
      runtimePolicy: { budget: { per_day_usd: 200 } },
      budgetCheck: () => {
        throw new Error("no log dir");
      },
    }),
  ).toBe("budget_check_failed");
  expect(
    idleApprovalGateReason({
      runtimePolicy: { budget: { per_day_usd: 200 } },
      budgetCheck: () => null,
    }),
  ).toBeNull();
});

/* --- repeated-failure alert --- */

test("idleTickFailureCode counts blind ticks, not deliberate refusals", () => {
  expect(
    idleTickFailureCode({ action: "skip", reason: "serve_unreachable" }),
  ).toBe("serve_unreachable");
  expect(idleTickFailureCode({ action: "approve", error: "HTTP 401" })).toBe(
    "effect_failed",
  );
  expect(
    idleTickFailureCode({
      action: "skip",
      reason: "budget_gate:budget_exhausted",
    }),
  ).toBeNull();
  expect(idleTickFailureCode({ action: "none", reason: "busy" })).toBeNull();
});

test("three failed ticks in a row alert once, and notify at most hourly", async () => {
  const base = Date.parse("2026-08-29T12:00:00.000Z");
  let clock = base;
  const persisted = {};
  const { deps, calls } = fakeFactory({
    proposals: async () => [openProposal({ id: "waiting" })],
    approve: async () => {
      throw new Error("HTTP 401");
    },
    readState: () => ({ ...persisted }),
    writeState: (next) => Object.assign(persisted, next),
    now: () => clock,
  });

  const first = await runIdleWatchdogTick(deps);
  expect(first.alerted).toBe(false);
  clock = base + 300_000;
  expect((await runIdleWatchdogTick(deps)).alerted).toBe(false);
  expect(calls.logs.filter((l) => l.includes("ALERT"))).toHaveLength(0);

  clock = base + 600_000;
  const third = await runIdleWatchdogTick(deps);
  expect(third.alerted).toBe(true);
  expect(calls.logs.at(-1)).toContain(
    "idle-watchdog ALERT repeated_failures=3",
  );
  expect(calls.notified).toHaveLength(1);

  // A fourth failure still logs the alert but does not re-notify inside the hour.
  clock = base + 900_000;
  const fourth = await runIdleWatchdogTick(deps);
  expect(fourth.alerted).toBe(false);
  expect(calls.logs.at(-1)).toContain("repeated_failures=4");
  expect(calls.notified).toHaveLength(1);

  // An hour later it is allowed to shout again.
  clock = base + 3_600_000 + 700_000;
  expect((await runIdleWatchdogTick(deps)).alerted).toBe(true);
  expect(calls.notified).toHaveLength(2);
});

test("one healthy tick clears the failure streak", async () => {
  const base = Date.parse("2026-08-29T12:00:00.000Z");
  let clock = base;
  const persisted = {};
  let up = false;
  const { deps, calls } = fakeFactory({
    serveOk: async () => up,
    readState: () => ({ ...persisted }),
    writeState: (next) => Object.assign(persisted, next),
    now: () => clock,
  });

  await runIdleWatchdogTick(deps);
  clock = base + 60_000;
  await runIdleWatchdogTick(deps);
  expect(persisted.failureStreak).toBe(2);

  up = true;
  clock = base + 120_000;
  await runIdleWatchdogTick(deps);
  expect(persisted.failureStreak).toBe(0);

  up = false;
  clock = base + 180_000;
  await runIdleWatchdogTick(deps);
  expect(persisted.failureStreak).toBe(1);
  expect(calls.logs.filter((l) => l.includes("ALERT"))).toHaveLength(0);
});

/* --- ordering over the full open set --- */

test("the oldest approvable proposal wins however the API ordered the page", async () => {
  const { deps, calls } = fakeFactory({
    proposals: async () => [
      openProposal({ id: "c", created_at: "2026-08-29T11:30:00.000Z" }),
      openProposal({ id: "a", created_at: "2026-08-29T09:00:00.000Z" }),
      openProposal({ id: "b", created_at: "2026-08-29T10:15:00.000Z" }),
    ],
  });
  await runIdleWatchdogTick(deps);
  expect(calls.approved).toEqual(["a"]);
});

test("live deps page open proposals newest-first and keep every page", async () => {
  const seen = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/proposals") return new Response("{}");
      seen.push(url.search);
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.get("status")).toBe("open");
      const before = url.searchParams.get("before");
      return Response.json(
        before
          ? { proposals: [{ id: "old" }], nextBefore: null }
          : { proposals: [{ id: "new" }], nextBefore: "cursor1" },
      );
    },
  });
  try {
    const { proposals } = liveIdleWatchdogDeps({ port: server.port });
    const rows = await proposals();
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("before=cursor1");
  } finally {
    server.stop(true);
  }
});

test("live serveOk tolerates a stale registry but halts on a stale planner", async () => {
  let plannerLastPlannedAt = new Date().toISOString();
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health")
        return Response.json({
          registry: { stamp: "files:definitely-stale", lastReloadError: null },
          planner: { lastPlannedAt: plannerLastPlannedAt },
        });
      if (url.pathname === "/status")
        return Response.json({ events: { admitted: 3 } });
      return new Response("{}");
    },
  });
  try {
    const { serveOk } = liveIdleWatchdogDeps({ port: server.port });
    // REGISTRY_STALE alone must not stop idle-loop injection: a reachable
    // serve on last-good code still plans and drains admitted work.
    expect(await serveOk()).toBe(true);
    // A planner that has not succeeded within the staleness window does.
    plannerLastPlannedAt = "2020-01-01T00:00:00.000Z";
    expect(await serveOk()).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("controlApiFailureCode distinguishes timeouts as API_BUSY", () => {
  const timeoutErr = new Error("The operation timed out");
  timeoutErr.name = "TimeoutError";
  expect(controlApiFailureCode(timeoutErr)).toBe("API_BUSY");

  const abortErr = new Error("The operation was aborted");
  abortErr.name = "AbortError";
  expect(controlApiFailureCode(abortErr)).toBe("API_BUSY");

  const unauthErr = new Error("Unauthorized");
  unauthErr.status = 401;
  expect(controlApiFailureCode(unauthErr)).toBe("API_UNAUTHORIZED");

  const lockedErr = new Error("Locked");
  lockedErr.status = 503;
  expect(controlApiFailureCode(lockedErr)).toBe("API_LOCKED");

  const downErr = new Error("Connection refused");
  expect(controlApiFailureCode(downErr)).toBe("API_ERROR");
});

test("runWatchdogCheck classifies tick overruns as TICK_OVERRUNS warning", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          tick: { lastMs: 1450, overruns: 3 },
        });
      }
      if (url.pathname === "/status") {
        return Response.json({
          proposals: { open: 0 },
          runs: { byState: { RUNNING: 0, LEASED: 0 } },
          workers: { active: 1, total: 1, list: [] },
          anomalies: {},
        });
      }
      if (url.pathname === "/workers") {
        return Response.json({ workers: [] });
      }
      if (url.pathname === "/runs") {
        return Response.json({ runs: [] });
      }
      return new Response("{}", { status: 200 });
    },
  });

  try {
    const report = await runWatchdogCheck({
      port: server.port,
      webPort: server.port,
      checkShadowFleet: false,
    });
    expect(report.metrics.tick).toEqual({ lastMs: 1450, overruns: 3 });
    const overrunIssue = report.issues.find((i) => i.code === "TICK_OVERRUNS");
    expect(overrunIssue).toBeDefined();
    expect(overrunIssue?.severity).toBe("WARNING");
    expect(overrunIssue?.message).toContain("3 tick overrun(s)");
  } finally {
    server.stop(true);
  }
});
