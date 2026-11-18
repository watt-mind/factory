import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildHarnessInvocation,
  loadArenaConfig,
  normalizeVendor,
  resolveRunnerPlan,
  sanitizedChildEnv,
  selectCrossJudge,
} from "./arena.mjs";

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

describe("normalizeVendor", () => {
  test("maps fable and claude to anthropic, sol/codex to openai, carbon/argon to google", () => {
    expect(normalizeVendor("claude-fable-5-2")).toBe("anthropic");
    expect(normalizeVendor("fable")).toBe("anthropic");
    expect(normalizeVendor("claude-opus-5-5")).toBe("anthropic");
    expect(normalizeVendor("gpt-6.2-sol")).toBe("openai");
    expect(normalizeVendor("codex")).toBe("openai");
    expect(normalizeVendor("gemini-4-carbon-high")).toBe("google");
    expect(normalizeVendor("gemini-4-argon-high")).toBe("google");
  });
});

describe("loadArenaConfig", () => {
  test("prefers ~/.factory/arena.yaml over config/arena.example.yaml", () => {
    const home = makeTempDir("arena-home-");
    const root = makeTempDir("arena-root-");
    mkdirSync(path.join(home, ".factory"), { recursive: true });
    mkdirSync(path.join(root, "config"), { recursive: true });

    writeFileSync(
      path.join(root, "config", "arena.example.yaml"),
      "defaults:\n  profile: default\nrunners:\n  a:\n    harness: claude\n    model: opus\nprofiles:\n  default: [a]\n",
    );
    writeFileSync(
      path.join(home, ".factory", "arena.yaml"),
      "defaults:\n  profile: full\nrunners:\n  b:\n    harness: agy\n    model: gemini-4-carbon-high\nprofiles:\n  full: [b]\n",
    );

    const cfg = loadArenaConfig({ homeDir: home, root, configPath: null });
    expect(cfg.isExampleFallback).toBe(false);
    expect(cfg.defaults.profile).toBe("full");
    expect(Object.keys(cfg.runners)).toEqual(["b"]);
  });

  test("falls back to config/arena.example.yaml when ~/.factory/arena.yaml is absent", () => {
    const home = makeTempDir("arena-home-");
    const root = path.resolve(import.meta.dir, "..");
    const cfg = loadArenaConfig({ homeDir: home, root, configPath: null });
    expect(cfg.isExampleFallback).toBe(true);
    expect(cfg.profiles.default).toEqual(["gpt-sol", "fable", "carbon"]);
    expect(cfg.profiles.full).toEqual([
      "gpt-sol",
      "fable",
      "opus",
      "carbon",
      "argon",
    ]);
  });
});

describe("resolveRunnerPlan and selectCrossJudge", () => {
  test("uses fallback harness when primary CLI is missing", () => {
    const home = makeTempDir("arena-home-");
    const root = path.resolve(import.meta.dir, "..");
    const cfg = loadArenaConfig({ homeDir: home, root, configPath: null });
    const fakeWhich = (cmd) =>
      ({ pi: "/usr/bin/pi", claude: "/usr/bin/claude", agy: "/usr/bin/agy" })[
        cmd
      ] || null;

    const plan = resolveRunnerPlan(cfg, {
      profile: "default",
      which: fakeWhich,
    });
    expect(plan[0]).toMatchObject({
      name: "gpt-sol",
      status: "ready",
      harness: "pi",
      model: "openai-codex/gpt-6.1-sol",
      fallbackUsed: true,
    });
    expect(plan[1]).toMatchObject({
      name: "fable",
      status: "ready",
      harness: "claude",
      fallbackUsed: false,
    });
  });

  test("selectCrossJudge skips same vendor family (fable counts as anthropic)", () => {
    const home = makeTempDir("arena-home-");
    const root = path.resolve(import.meta.dir, "..");
    const cfg = loadArenaConfig({ homeDir: home, root, configPath: null });
    const fakeWhich = (cmd) => `/usr/bin/${cmd}`;

    const judge = selectCrossJudge(cfg, {
      callerVendor: "fable",
      which: fakeWhich,
    });
    expect(judge).toMatchObject({
      name: "carbon",
      vendor: "google",
      vendorCheckApplied: true,
    });
  });
});

describe("buildHarnessInvocation and sanitizedChildEnv", () => {
  test("builds expected flags for codex, claude, and agy", () => {
    expect(
      buildHarnessInvocation({
        harness: "codex",
        model: "gpt-6.2-sol",
        workDir: "/tmp/cand-1",
      }),
    ).toEqual({
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-m",
        "gpt-6.2-sol",
        "-C",
        "/tmp/cand-1",
        "-s",
        "workspace-write",
        "-",
      ],
    });

    expect(
      buildHarnessInvocation({
        harness: "agy",
        model: "gemini-4-carbon-high",
        effort: "high",
        workDir: "/tmp/cand-2",
        readOnly: true,
      }),
    ).toEqual({
      command: "agy",
      args: [
        "-p",
        "-",
        "--output-format",
        "stream-json",
        "--model",
        "gemini-4-carbon-high",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/cand-2",
        "--print-timeout",
        "595s",
        "--mode",
        "plan",
      ],
    });
  });

  test("strips API keys and Claude nested session env vars", () => {
    const env = sanitizedChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      GEMINI_API_KEY: "gk",
      CLAUDECODE: "1",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });
});
