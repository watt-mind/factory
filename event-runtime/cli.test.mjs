import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES } from "./cli/commands.mjs";
import { runCli } from "./cli/test-helpers.mjs";

const EXPECTED_COMMANDS = [
  "serve",
  "work",
  "supervise",
  "status",
  "doctor",
  "events",
  "runs",
  "ps",
  "proposals",
  "inbox",
  "agents",
  "adapters",
  "workers",
  "schedule",
  "repos",
  "sandbox",
  "approve",
  "reject",
  "inject",
  "requeue",
  "cancel",
  "retry",
  "extend",
  "inspect",
  "trace",
  "update-pins",
];

describe("cli routing", () => {
  test("no command → usage text listing all verbs, non-zero exit", () => {
    const r = runCli([]);
    expect(r.status).not.toBe(0);
    for (const verb of [
      "serve",
      "status",
      "doctor",
      "ps",
      "runs",
      "proposals",
      "adapters",
      "approve",
      "reject",
      "inject",
      "cancel",
      "retry",
      "inspect",
      "update-pins",
      "supervise",
    ]) {
      expect(r.all).toContain(verb);
    }
    expect(r.all).toContain("usage:");
    expect(r.all).toContain("adapters [--json]");
    expect(r.all).toContain("--watch");
    expect(r.all).toContain("--reload-on-change");
    expect(r.all).toContain("--workers min:max");
  });

  test("adapters is routed through COMMANDS and lists locally", () => {
    expect(COMMAND_NAMES).toContain("adapters");
    const r = runCli(["adapters", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.adapters)).toBe(true);
    expect(parsed.adapters.length).toBeGreaterThan(0);
    expect(parsed.adapters[0]).toHaveProperty("name");
    expect(parsed.adapters[0]).toHaveProperty("source");
    expect(parsed.adapters[0]).toHaveProperty("sandboxSupport");
  });

  test("unknown command → usage text, non-zero exit", () => {
    const r = runCli(["frobnicate"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("usage:");
  });

  test("registered command set is unchanged", () => {
    expect(COMMAND_NAMES).toEqual(EXPECTED_COMMANDS);
  });
});
