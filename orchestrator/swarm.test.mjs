import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildHarnessInvocation,
  buildSwarmPlan,
  loadSwarmConfig,
  resolveWorkerSpec,
  sanitizedChildEnv,
} from "./swarm.mjs";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("loadSwarmConfig", () => {
  test("prefers ~/.factory/swarm.yaml over config/swarm.example.yaml", () => {
    const home = makeTempDir("swarm-home-");
    const root = makeTempDir("swarm-root-");
    mkdirSync(path.join(home, ".factory"), { recursive: true });
    mkdirSync(path.join(root, "config"), { recursive: true });

    writeFileSync(
      path.join(root, "config", "swarm.example.yaml"),
      "defaults:\n  worker: opus\nworkers:\n  opus:\n    harness: claude\n    model: claude-opus-5-5\n",
    );
    writeFileSync(
      path.join(home, ".factory", "swarm.yaml"),
      "defaults:\n  worker: carbon\nworkers:\n  carbon:\n    harness: agy\n    model: gemini-4-carbon-high\n",
    );

    const cfg = loadSwarmConfig({ homeDir: home, root, configPath: null });
    expect(cfg.isExampleFallback).toBe(false);
    expect(cfg.defaults.worker).toBe("carbon");
    expect(Object.keys(cfg.workers)).toEqual(["carbon"]);
  });

  test("falls back to config/swarm.example.yaml when ~/.factory/swarm.yaml is absent", () => {
    const home = makeTempDir("swarm-home-");
    const root = path.resolve(import.meta.dir, "..");
    const cfg = loadSwarmConfig({ homeDir: home, root, configPath: null });
    expect(cfg.isExampleFallback).toBe(true);
    expect(cfg.defaults.worker).toBe("opus");
    expect(cfg.profiles.race).toEqual(["gpt-sol", "fable", "carbon"]);
  });
});

describe("resolveWorkerSpec and buildSwarmPlan", () => {
  test("falls back to pi when codex CLI is absent", () => {
    const home = makeTempDir("swarm-home-");
    const root = path.resolve(import.meta.dir, "..");
    const cfg = loadSwarmConfig({ homeDir: home, root, configPath: null });
    const fakeWhich = (cmd) => (cmd === "pi" ? "/usr/bin/pi" : null);

    const resolved = resolveWorkerSpec(cfg, "gpt-sol", fakeWhich);
    expect(resolved).toMatchObject({
      name: "gpt-sol",
      status: "ready",
      harness: "pi",
      model: "openai-codex/gpt-6.1-sol",
      fallbackUsed: true,
    });
  });

  test("requires --rule for race shape and builds cross-harness race arms", () => {
    const home = makeTempDir("swarm-home-");
    const root = path.resolve(import.meta.dir, "..");
    const cfg = loadSwarmConfig({ homeDir: home, root, configPath: null });
    const fakeWhich = (cmd) => `/usr/bin/${cmd}`;

    expect(() =>
      buildSwarmPlan(cfg, {
        shape: "race",
        promptText: "audit",
        which: fakeWhich,
      }),
    ).toThrow("--rule");

    const plan = buildSwarmPlan(cfg, {
      shape: "race",
      rule: "best-of",
      promptText: "audit",
      which: fakeWhich,
    });
    expect(plan.map((p) => p.slotId)).toEqual([
      "arm-gpt-sol",
      "arm-fable",
      "arm-carbon",
    ]);
  });

  test("builds partition plan preserving SHAs and measurement method", () => {
    const home = makeTempDir("swarm-home-");
    const root = path.resolve(import.meta.dir, "..");
    const cfg = loadSwarmConfig({ homeDir: home, root, configPath: null });
    const fakeWhich = (cmd) => `/usr/bin/${cmd}`;

    const plan = buildSwarmPlan(cfg, {
      shape: "partition",
      tasks: [
        {
          id: "api",
          brief: "Inspect API routes",
          readOnly: true,
          shas: ["abc1234"],
          method: "3 cold runs",
        },
      ],
      which: fakeWhich,
    });
    expect(plan[0]).toMatchObject({
      slotId: "api",
      readOnly: true,
      shas: ["abc1234"],
      method: "3 cold runs",
      harness: "claude",
    });
  });
});

describe("buildHarnessInvocation and sanitizedChildEnv", () => {
  test("strips provider keys and builds read-only claude flags", () => {
    const inv = buildHarnessInvocation({
      harness: "claude",
      model: "claude-opus-5-5",
      readOnly: true,
    });
    expect(inv).toEqual({
      command: "claude",
      args: [
        "-p",
        "-",
        "--output-format",
        "text",
        "--model",
        "claude-opus-5-5",
        "--allowedTools",
        "Read,Grep,Glob,LS",
      ],
    });
    const env = sanitizedChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "x",
      CLAUDECODE: "1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });
});
