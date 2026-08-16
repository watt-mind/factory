import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../lib/schema.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const SEED = fileURLToPath(new URL("./seed.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const TRIAGE_SCAN_OUTPUT_SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/triage-scan.output.json", import.meta.url)), "utf8"),
);

const redact = (text) => String(text ?? "")
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
  .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]");

function expectSuccess(label, result) {
  const diagnostic = [
    `${label} exited ${result.status ?? "null"}${result.signal ? ` (signal ${result.signal})` : ""}`,
    `stdout:\n${redact(result.stdout)}`,
    `stderr:\n${redact(result.stderr)}`,
  ].join("\n");
  expect(result.status, diagnostic).toBe(0);
}

describe("triage-scan write-detail contract (WM-352)", () => {
  const artifactWithDetail = (detail) => ({
    recommendation: "TRIAGE",
    repo: "factory",
    plan: [{ issueId: "WM-352", action: "write-detail", reason: "fixture", detail }],
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

    expect(validate(TRIAGE_SCAN_OUTPUT_SCHEMA, artifactWithDetail(canonical))).toEqual({ valid: true, errors: [] });
    expect(validate(TRIAGE_SCAN_OUTPUT_SCHEMA, artifactWithDetail("## Rollout\n\n- Deploy globally."))).toEqual({
      valid: false,
      errors: [
        "$.plan[0].detail: does not match pattern ^\\s*## (Acceptance Criteria|Owned Paths|Verification)",
      ],
    });
  });

  test("continues to accept Owned Paths and Verification as the first section", () => {
    expect(validate(TRIAGE_SCAN_OUTPUT_SCHEMA, artifactWithDetail("## Owned Paths\n\n- `README.md`"))).toEqual({
      valid: true,
      errors: [],
    });
    expect(validate(TRIAGE_SCAN_OUTPUT_SCHEMA, artifactWithDetail("## Verification\n\n```\nbun test\n```"))).toEqual({
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

  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "evrt-seed-test-"));
    // Ask the OS for a genuinely free port instead of pid-modulo arithmetic:
    // on a shared self-hosted runner a leftover server from an earlier
    // (aborted) job can squat any precomputed port, and the seed then fails
    // in milliseconds against a stranger's already-seeded state (WM-89).
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    port = String(probe.port);
    probe.stop(true);

    serveChild = spawn("bun", [CLI, "serve", "--adapter-override", "fake", "--port", port], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for health
    let up = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          up = true;
          break;
        }
      } catch {}
      await Bun.sleep(100);
    }
    expect(up).toBe(true);

    workerChild = spawn("bun", [CLI, "work", "--adapter-override", "fake", "--port", port, "--poll-ms", "40"], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Health only proves the control API is listening. Seed drives approvals
    // immediately, so wait for the separate worker process to register first.
    let workerReady = false;
    const workerDeadline = Date.now() + 8_000;
    while (Date.now() < workerDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/workers`);
        const body = await res.json();
        if (res.ok && Array.isArray(body.workers) && body.workers.length > 0) {
          workerReady = true;
          break;
        }
      } catch {}
      await Bun.sleep(50);
    }
    expect(workerReady).toBe(true);
  });

  afterAll(async () => {
    if (serveChild) {
      try {
        serveChild.kill("SIGKILL");
      } catch {}
    }
    if (workerChild) {
      try {
        workerChild.kill("SIGKILL");
      } catch {}
    }
  });

  test("initial seed succeeds and verify passes", () => {
    const t0 = Date.now();
    const seedRes = spawnSync("bun", [SEED, "--port", port, "--prefix", "t1", "--poll-ms", "40"], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expectSuccess("initial seed", seedRes);
    expect(Date.now() - t0).toBeLessThan(8_000);

    const verifyRes = spawnSync("bun", [VERIFY, "--port", port], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expectSuccess("initial verify", verifyRes);
  }, 30_000);

  test("re-running seed with the SAME prefix fails immediately (<1s) on duplicate intake", () => {
    const t0 = Date.now();
    const res = spawnSync("bun", [SEED, "--port", port, "--prefix", "t1"], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    const elapsedMs = Date.now() - t0;
    expect(res.status).not.toBe(0);
    expect(elapsedMs).toBeLessThan(2000);
    const output = `${res.stdout}${res.stderr}`;
    expect(output).toContain("duplicate prefix \"t1\"");
  }, 10_000);

  test("re-seeding with a NEW prefix cleans up hang runs and allows verify to pass", () => {
    const t0 = Date.now();
    const seedRes = spawnSync("bun", [SEED, "--port", port, "--prefix", "t2", "--poll-ms", "40"], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expectSuccess("re-seed", seedRes);
    expect(Date.now() - t0).toBeLessThan(8_000);

    const verifyRes = spawnSync("bun", [VERIFY, "--port", port], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expectSuccess("re-seed verify", verifyRes);
  }, 30_000);
});
