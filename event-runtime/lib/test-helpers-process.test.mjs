import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const HELPER_URL = new URL("./test-helpers-process.mjs", import.meta.url).href;

function runIsolated(script) {
  return spawnSync("bun", ["-e", script], {
    detached: true,
    encoding: "utf8",
  });
}

describe("tracked test process safety (WM-1982)", () => {
  test("retries runner PGID lookup after ps is unavailable at module load", () => {
    const result = runIsolated(`
      import { spawnSync } from "node:child_process";

      const originalPath = process.env.PATH;
      process.env.PATH = "/definitely-missing";
      const { trackProcess } = await import(${JSON.stringify(HELPER_URL)});
      process.env.PATH = originalPath;

      const lookup = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
      });
      const pgid = Number(lookup.stdout?.trim());
      if (lookup.status !== 0 || !Number.isInteger(pgid) || pgid <= 0) {
        throw new Error("could not resolve isolated runner process group");
      }
      try {
        trackProcess(pgid);
      } catch (error) {
        if (error.message.includes("refusing to track the test runner process group")) {
          process.exit(0);
        }
        throw error;
      }
      throw new Error("registered the isolated runner process group");
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
  });

  test("refuses the runner PID when runner PGID lookup remains unavailable", () => {
    const result = runIsolated(`
      process.env.PATH = "/definitely-missing";
      const { trackProcess } = await import(${JSON.stringify(HELPER_URL)});
      try {
        trackProcess(process.pid);
      } catch (error) {
        if (error.message.includes("refusing to track the test runner process group")) {
          process.exit(0);
        }
        throw error;
      }
      throw new Error("registered the isolated runner PID");
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
  });
});
