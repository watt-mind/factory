import { test, expect, describe } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "workers.mjs");

describe("orchestrator/workers CLI", () => {
  test("factory workers --help exits 0 with usage banner", () => {
    const res = Bun.spawnSync({
      cmd: ["bun", SCRIPT, "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode).toBe(0);
    const text = res.stdout.toString();
    expect(text).toContain("factory workers");
    expect(text).toContain("USAGE");
    expect(text).toContain("deploy");
    expect(text).toContain("update");
  });

  test("factory workers --json returns empty array when no nodes are configured", () => {
    const emptyConfig = path.join(tmpdir(), `empty-nodes-${Date.now()}.yaml`);
    writeFileSync(emptyConfig, "nodes: {}\n");

    try {
      const res = Bun.spawnSync({
        cmd: ["bun", SCRIPT, "--json"],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FACTORY_NODES_CONFIG: emptyConfig,
        },
      });
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout.toString());
      expect(data.count).toBe(0);
      expect(Array.isArray(data.nodes)).toBe(true);
    } finally {
      rmSync(emptyConfig, { force: true });
    }
  });

  test("factory workers returns warning when no nodes configured in plain text mode", () => {
    const emptyConfig = path.join(tmpdir(), `empty-nodes-txt-${Date.now()}.yaml`);
    writeFileSync(emptyConfig, "nodes: {}\n");

    try {
      const res = Bun.spawnSync({
        cmd: ["bun", SCRIPT],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FACTORY_NODES_CONFIG: emptyConfig,
        },
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString()).toContain("No remote worker nodes configured");
    } finally {
      rmSync(emptyConfig, { force: true });
    }
  });
});
