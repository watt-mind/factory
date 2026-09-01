import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-demo-seed-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus as osCpus } from "node:os";
import { fileURLToPath } from "node:url";
import { loadAdjustedTimeout } from "../cli/test-helpers.mjs";
import { validate } from "../lib/schema.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const SEED = fileURLToPath(new URL("./seed.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const TRIAGE_SCAN_OUTPUT_SCHEMA = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../schemas/triage-scan.output.json", import.meta.url),
    ),
    "utf8",
  ),
);
// A liveness bound, not a performance target (WM-503). The two assertions that
// use it exist to catch a seed that waits on the WRONG causal edge — reusing a
// prior terminal triage-apply proposal instead of following the new scan's edge
// — which blocks indefinitely rather than merely running slow.
//
// At 10s it was baseline-red on every run: the seed measures 10.1-10.5s on a
// developer workstation, so the bound sat ~2% under the real cost and failed
// 3/3 sampled runs (10164ms, 10130ms, 10545ms). That single failure failed the
// whole-suite verification gate for EVERY dispatched ticket, since the gate is
// all-or-nothing — the factory could not complete a ticket cleanly, and at
// least one agent discarded a correct fix because of it.
//
// 20s is ~2x the observed cost, and it is the floor: an unloaded machine keeps
// exactly today's bound. CI run 33558811006 (OPS-464) measured 22,518ms against
// it under self-hosted runner load. That run already had the CI_LOAD_FACTOR
// wiring active and it computed a factor of 1 — the workflow takes
// ceil(runnable/cpus) = ceil(16/32) = 1, so genuine contention reads as
// "unloaded", and it samples at job start, ~28s before this assertion runs and
// before bun install and the concurrent lanes create the load. Trusting the env
// factor alone therefore cannot fix this flake.
//
// So the budget measures contention itself, here, when the assertion runs:
// /proc/loadavg's runnable count (and the 1-min average) against the CPU count
// as a FRACTIONAL multiplier, maxed with CI_LOAD_FACTOR when CI supplies a
// larger one. Floor 20s, ceiling 28s — the timing lane runs
// `bun test --timeout 30000`, so any budget at or above 30s is unreachable and
// the old 4x clamp was theatre above that. A genuine wrong-edge hang blocks
// indefinitely and still fails here (and, failing that, at the test timeout).
// Rediscovered as WM-487, WM-492, WM-499 and WM-90 before WM-503.
const SEED_BUDGET_BASE_MS = 20_000;
const SEED_BUDGET_CEILING_MS = 28_000;

/** Clamp a load multiplier into the [base, ceiling] wall-clock budget. */
export function seedBudgetMs(
  factor,
  { baseMs = SEED_BUDGET_BASE_MS, ceilingMs = SEED_BUDGET_CEILING_MS } = {},
) {
  const multiplier = Number.isFinite(factor) && factor > 1 ? factor : 1;
  return Math.min(Math.ceil(baseMs * multiplier), ceilingMs);
}

/**
 * Fractional contention multiplier from /proc/loadavg text.
 * Field 4 is "runnable/total" (e.g. "16/1024"); field 1 is the 1-min average.
 * 1 + busy/cpus: idle ~1.0, half-saturated 1.5, fully saturated 2.0+.
 */
export function procLoadFactor(loadavgText, cpuCount) {
  const cpus = Number(cpuCount);
  if (!Number.isFinite(cpus) || cpus <= 0) return 1;
  const fields = String(loadavgText ?? "")
    .trim()
    .split(/\s+/);
  const oneMinute = Number.parseFloat(fields[0]);
  const runnable = Number.parseInt(String(fields[3] ?? "").split("/")[0], 10);
  const busy = Math.max(
    Number.isFinite(oneMinute) ? oneMinute : 0,
    Number.isFinite(runnable) ? runnable : 0,
  );
  if (busy <= 0) return 1;
  return 1 + busy / cpus;
}

/** Never throw at module load: no /proc/loadavg (macOS, sandboxes) → 1. */
function measuredLoadFactor() {
  try {
    return procLoadFactor(
      readFileSync("/proc/loadavg", "utf8"),
      osCpus()?.length ?? 0,
    );
  } catch {
    return 1;
  }
}

function envLoadFactor() {
  const parsed = Number.parseFloat(process.env.CI_LOAD_FACTOR ?? "1");
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}

// Sampled once at module load so a machine already busy before the suite starts
// is accounted for, and re-sampled at each assertion (below) so load created
// during the run counts too.
const SEED_LOAD_FACTOR_AT_LOAD = Math.max(
  measuredLoadFactor(),
  envLoadFactor(),
);

/** The wall-clock budget for a seed, measured at the moment it is asserted. */
function seedTimeoutMs() {
  return seedBudgetMs(
    Math.max(SEED_LOAD_FACTOR_AT_LOAD, measuredLoadFactor(), envLoadFactor()),
  );
}

const redact = (text) =>
  String(text ?? "")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]");

/**
 * Long-lived suite fixtures (serve/work) are spawned directly with node's
 * child_process rather than the shared lib/test-helpers-process.mjs
 * spawnTracked() helper (OPS-464 regression, root-caused for gh-875).
 *
 * That helper's afterEach/afterAll hooks are registered once, at ES module
 * load time, against whichever test FILE happens to import it first in the
 * process — bun's module cache means every other importing file's hooks
 * never fire per-file. Several unrelated files in the timing-bound-tests
 * group (cli/work.test.mjs, cli/supervise.test.mjs, lib/adapters/*.test.mjs)
 * import the same module, so its process-wide `afterAll` fires when the
 * FIRST of those files finishes — often seconds in, while this file's
 * ~20-30s seed/verify run is still mid-flight — and SIGKILLs every tracked
 * process globally, including this suite's serve/work children. That is the
 * "Unable to connect" failure: the runtime under test was killed out from
 * under it by an unrelated file's cleanup, not a real readiness or network
 * problem. Spawning here keeps this suite's process lifecycle local to this
 * file, immune to that cross-file collision.
 */
function spawnSuiteProcess(command, args, options) {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
  });
}

function killSuiteProcess(child) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* intentionally ignored: already exited */
  }
}

// The control API fails closed (WM-956): every non-intake route needs the
// bearer, so the suite's serve, worker, seed, and verify processes all share
// one token and the bare status/worker polls present it too.
const CONTROL_API_TOKEN = "seed-suite-control-token";

function suiteEnv(home) {
  return {
    ...process.env,
    FACTORY_EVENT_HOME: home,
    FACTORY_CONTROL_API_TOKEN: CONTROL_API_TOKEN,
  };
}

function controlAuthHeaders() {
  return { authorization: `Bearer ${CONTROL_API_TOKEN}` };
}

/** Distinguish "runtime unreachable" from "runtime rejected the request" on failure. */
async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok ? "reachable" : `reachable, HTTP ${res.status}`;
  } catch (err) {
    return `unreachable (${err.message})`;
  }
}

async function expectSuccess(label, result, port) {
  if (result.status === 0) return;
  const health = await probeHealth(port);
  const diagnostic = [
    `${label} exited ${result.status ?? "null"}${result.signal ? ` (signal ${result.signal})` : ""}`,
    `runtime on port ${port} at failure time: ${health}`,
    `stdout:\n${redact(result.stdout)}`,
    `stderr:\n${redact(result.stderr)}`,
  ].join("\n");
  expect(result.status, diagnostic).toBe(0);
}

async function waitForPublishedOutbox(port) {
  const timeoutMs = loadAdjustedTimeout(5_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: controlAuthHeaders(),
      });
      const status = await response.json();
      if (response.ok && status.anomalies?.unpublishedOutbox === 0) return;
    } catch {
      /* intentionally ignored */
    }
    await Bun.sleep(50);
  }
  expect.fail(
    `seeded runtime did not publish its outbox within ${timeoutMs}ms`,
  );
}

describe("seed wall-clock budget math (OPS-464 load sensitivity)", () => {
  test("an unloaded machine keeps exactly the 20s floor", () => {
    expect(seedBudgetMs(1)).toBe(20_000);
    // Anything at or below 1x — including a missing/garbage factor — floors.
    expect(seedBudgetMs(0.5)).toBe(20_000);
    expect(seedBudgetMs(Number.NaN)).toBe(20_000);
    expect(seedBudgetMs(undefined)).toBe(20_000);
    expect(procLoadFactor("0.00 0.01 0.05 1/1024 4242", 32)).toBeCloseTo(
      1 + 1 / 32,
      5,
    );
  });

  test("fractional load stretches the budget and clamps below the 30s test timeout", () => {
    // 1.5x would be 30_000 — unreachable under `bun test --timeout 30000`.
    expect(seedBudgetMs(1.5)).toBe(28_000);
    expect(seedBudgetMs(1.2)).toBe(24_000);
    expect(seedBudgetMs(4)).toBe(28_000);
    expect(seedBudgetMs(1000)).toBe(28_000);
    // The failing run's own reading: 16 runnable on 32 CPUs → 1.5x, not the
    // ceil(16/32) = 1 the workflow computed.
    expect(procLoadFactor("8.00 6.00 5.00 16/1024 4242", 32)).toBeCloseTo(
      1.5,
      5,
    );
    expect(
      seedBudgetMs(procLoadFactor("8.00 6.00 5.00 16/1024 4242", 32)),
    ).toBe(28_000);
  });

  test("CI_LOAD_FACTOR still applies when /proc/loadavg reads idle", () => {
    const idle = procLoadFactor("0.00 0.00 0.00 1/512 7", 64);
    expect(seedBudgetMs(Math.max(idle, 2))).toBe(28_000);
    expect(seedBudgetMs(Math.max(idle, 1.1))).toBe(22_000);
  });

  test("a missing or unreadable /proc/loadavg falls back to 1x", () => {
    expect(procLoadFactor("", 32)).toBe(1);
    expect(procLoadFactor(undefined, 32)).toBe(1);
    expect(procLoadFactor("garbage", 32)).toBe(1);
    expect(procLoadFactor("0.5 0.5 0.5 2/100 7", 0)).toBe(1);
    expect(procLoadFactor("0.5 0.5 0.5 2/100 7", undefined)).toBe(1);
  });
});

describe("triage-scan write-detail contract (WM-352)", () => {
  const artifactWithDetail = (detail) => ({
    recommendation: "TRIAGE",
    repo: "factory",
    plan: [
      { issueId: "WM-352", action: "write-detail", reason: "fixture", detail },
    ],
    summary: "fixture",
  });

  test("accepts canonical multi-section detail and rejects unrelated headings", () => {
    const canonical = [
      "## Acceptance Criteria",
      "",
      "- The behavior is covered.",
      "",
      "## Owned Paths",
      "",
      "- `event-runtime/demo/seed.test.mjs`",
      "",
      "## Verification",
      "",
      "```",
      "bun test event-runtime/demo/seed.test.mjs",
      "```",
    ].join("\n");

    expect(
      validate(TRIAGE_SCAN_OUTPUT_SCHEMA, artifactWithDetail(canonical)),
    ).toEqual({ valid: true, errors: [] });
    expect(
      validate(
        TRIAGE_SCAN_OUTPUT_SCHEMA,
        artifactWithDetail("## Rollout\n\n- Deploy globally."),
      ),
    ).toEqual({
      valid: false,
      errors: [
        "$.plan[0].detail: does not match pattern ^\\s*## (Acceptance Criteria|Owned Paths|Verification)",
      ],
    });
  });

  test("continues to accept Owned Paths and Verification as the first section", () => {
    expect(
      validate(
        TRIAGE_SCAN_OUTPUT_SCHEMA,
        artifactWithDetail("## Owned Paths\n\n- `README.md`"),
      ),
    ).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validate(
        TRIAGE_SCAN_OUTPUT_SCHEMA,
        artifactWithDetail("## Verification\n\n```\nbun test\n```"),
      ),
    ).toEqual({
      valid: true,
      errors: [],
    });
  });
});

describe("seed & re-seed deduplication (OPS-464)", () => {
  let home;
  let port;
  let serveChild;
  let workerChild;
  let initialTriageApplyRun;

  beforeAll(async () => {
    home = tmpDir("evrt-seed-test-");
    // Ask the OS for a genuinely free port instead of pid-modulo arithmetic:
    // on a shared self-hosted runner a leftover server from an earlier
    // (aborted) job can squat any precomputed port, and the seed then fails
    // in milliseconds against a stranger's already-seeded state (WM-89).
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    port = String(probe.port);
    probe.stop(true);

    serveChild = spawnSuiteProcess(
      "bun",
      [CLI, "serve", "--adapter-override", "fake", "--port", port],
      {
        env: suiteEnv(home),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Wait for health
    let up = false;
    const deadline = Date.now() + loadAdjustedTimeout(8000);
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        /* intentionally ignored */
      }
      await Bun.sleep(100);
    }
    expect(up).toBe(true);

    workerChild = spawnSuiteProcess(
      "bun",
      [
        CLI,
        "work",
        "--adapter-override",
        "fake",
        "--port",
        port,
        "--poll-ms",
        "40",
      ],
      {
        env: suiteEnv(home),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Health only proves the control API is listening. Seed drives approvals
    // immediately, so wait for the separate worker process to register first.
    let workerReady = false;
    const workerDeadline = Date.now() + loadAdjustedTimeout(8_000);
    while (Date.now() < workerDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/workers`, {
          headers: controlAuthHeaders(),
        });
        const body = await res.json();
        if (res.ok && Array.isArray(body.workers) && body.workers.length > 0) {
          workerReady = true;
          break;
        }
      } catch {
        /* intentionally ignored */
      }
      await Bun.sleep(50);
    }
    expect(workerReady).toBe(true);
  });

  afterAll(async () => {
    killSuiteProcess(serveChild);
    killSuiteProcess(workerChild);
  });

  test(
    "initial seed succeeds and verify passes",
    async () => {
      const t0 = Date.now();
      const seedRes = spawnSync(
        "bun",
        [SEED, "--port", port, "--prefix", "t1", "--poll-ms", "40"],
        {
          encoding: "utf8",
          env: suiteEnv(home),
        },
      );
      await expectSuccess("initial seed", seedRes, port);
      expect(seedRes.stdout).toContain("merge-apply@2 watched");
      expect(seedRes.stdout).toContain("structured dispatch handoff");
      expect(seedRes.stdout).not.toContain(
        "merge-verify@1 exact landed lifecycle",
      );
      // The triage chain now waits for its auto-approved apply run to finish.
      expect(Date.now() - t0).toBeLessThan(seedTimeoutMs());
      initialTriageApplyRun = seedRes.stdout.match(
        /^seed: (\S+) → COMPLETED \(triage-apply@1 chain auto-approved/m,
      )?.[1];
      expect(initialTriageApplyRun).toBeTruthy();
      await waitForPublishedOutbox(port);

      const verifyRes = spawnSync("bun", [VERIFY, "--port", port], {
        encoding: "utf8",
        env: suiteEnv(home),
      });
      await expectSuccess("initial verify", verifyRes, port);
      expect(verifyRes.stdout).toContain(
        "GET /inbox?status=open returns ≥1 open item",
      );
      expect(verifyRes.stdout).toContain(
        "BLOCKED parked human_needed Inbox item has requeue/dismiss decision",
      );
      expect(verifyRes.stdout).toContain(
        "TTL-expired Inbox item offers approve/reject decision",
      );

      const inboxResponse = await fetch(
        `http://127.0.0.1:${port}/inbox?status=open`,
        { headers: controlAuthHeaders() },
      );
      expect(inboxResponse.ok).toBe(true);
      const { items } = await inboxResponse.json();
      const fixture = items.find(
        (item) => item.id === "inbox_t1_dispatch_detail",
      );
      expect(
        fixture,
        `seeded inbox refs: ${JSON.stringify(items.map((item) => item.refs))}`,
      ).toBeTruthy();
      expect(fixture).toMatchObject({
        title: "Review seeded dispatch handoff",
        refs: {
          runId: "run_t1_dispatch_wm100",
          eventSource: "demo-seed",
          eventId: "t1-human-needed",
          issue: "DEMO-100",
        },
      });
      expect(fixture.refs.proposalId).toStartWith("prop_");
      expect(fixture.refs.pr).toMatch(
        /^https:\/\/github\.com\/watt-mind\/.+\/pull\/999999$/,
      );
      expect(fixture.refs.repo).toBeTruthy();
      expect(fixture.body).toContain("## Handoff");
      expect(fixture.body).toContain("## References");
      expect(fixture.body).toContain(
        "```\nbun test event-runtime/demo/seed.test.mjs\n```",
      );
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "re-running seed with the SAME prefix stays fast on duplicate intake",
    () => {
      const t0 = Date.now();
      const res = spawnSync("bun", [SEED, "--port", port, "--prefix", "t1"], {
        encoding: "utf8",
        env: suiteEnv(home),
      });
      const elapsedMs = Date.now() - t0;
      expect(res.status).not.toBe(0);
      // Protect the duplicate fast path from regressing into a full seed run;
      // account for shared-runner contention without masking that regression.
      expect(elapsedMs).toBeLessThan(loadAdjustedTimeout(2000));
      const output = `${res.stdout}${res.stderr}`;
      expect(output).toContain('duplicate prefix "t1"');
    },
    loadAdjustedTimeout(10_000),
  );

  test(
    "re-seeding with a NEW prefix cleans up hang runs and allows verify to pass",
    async () => {
      const t0 = Date.now();
      const seedRes = spawnSync(
        "bun",
        [SEED, "--port", port, "--prefix", "t2", "--poll-ms", "40"],
        {
          encoding: "utf8",
          env: suiteEnv(home),
        },
      );
      await expectSuccess("re-seed", seedRes, port);
      expect(seedRes.stdout).toContain("merge-apply@2 watched");
      expect(seedRes.stdout).not.toContain(
        "merge-verify@1 exact landed lifecycle",
      );
      // A fresh prefix must follow the new scan's causal edge, never reuse the
      // prior terminal triage-apply proposal while waiting for that edge.
      expect(Date.now() - t0).toBeLessThan(seedTimeoutMs());
      const reseedTriageApplyRun = seedRes.stdout.match(
        /^seed: (\S+) → COMPLETED \(triage-apply@1 chain auto-approved/m,
      )?.[1];
      expect(reseedTriageApplyRun).toBeTruthy();
      expect(reseedTriageApplyRun).not.toBe(initialTriageApplyRun);
      await waitForPublishedOutbox(port);

      const verifyRes = spawnSync("bun", [VERIFY, "--port", port], {
        encoding: "utf8",
        env: suiteEnv(home),
      });
      await expectSuccess("re-seed verify", verifyRes, port);
    },
    loadAdjustedTimeout(30_000),
  );
});
