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
    expect(r.all).toContain("--watch");
    expect(r.all).toContain("--reload-on-change");
    expect(r.all).toContain("--workers min:max");
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
