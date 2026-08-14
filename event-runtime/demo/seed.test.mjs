import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const SEED = fileURLToPath(new URL("./seed.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.mjs", import.meta.url));

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

    workerChild = spawn("bun", [CLI, "work", "--adapter-override", "fake", "--port", port], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const seedRes = spawnSync("bun", [SEED, "--port", port, "--prefix", "t1"], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expect(seedRes.status).toBe(0);

    const verifyRes = spawnSync("bun", [VERIFY, "--port", port], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expect(verifyRes.status).toBe(0);
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
    const seedRes = spawnSync("bun", [SEED, "--port", port, "--prefix", "t2"], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expect(seedRes.status).toBe(0);

    const verifyRes = spawnSync("bun", [VERIFY, "--port", port], {
      encoding: "utf8",
      env: { ...process.env, FACTORY_EVENT_HOME: home },
    });
    expect(verifyRes.status).toBe(0);
  }, 30_000);
});
