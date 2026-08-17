/**
 * The factory entry in config/repos.yaml is an enabled dispatch target
 * (OPS-463): report_only removed, worktree lifecycle scripts declared and
 * actually present on disk, WM / Factory routing, max_in_flight 20.
 *
 * Read through loadRepos rather than raw YAML so the assertions hold against
 * the exact field names the dispatcher consumes (reportOnly, worktreeUp,
 * maxInFlight, …) — a renamed key in the config would fail here the same way
 * it would fail the planner's gate.
 */
import { test, expect } from "bun:test";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { loadRepos } from "../event-runtime/lib/repos.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const factory = loadRepos({ root: ROOT }).get("factory");

test("factory is a dispatch target, not report_only (OPS-463)", () => {
  expect(factory).toBeDefined();
  expect(factory.reportOnly).toBe(false);
});

test("factory declares its worktree lifecycle and the scripts exist, executable", () => {
  expect(factory.worktreeUp).toBe("bin/worktree-up.sh");
  expect(factory.worktreeDown).toBe("bin/worktree-down.sh");
  expect(factory.worktreeRoot).toBe(path.join(process.env.HOME ?? "", "Develop/.worktrees/factory"));
  for (const script of [factory.worktreeUp, factory.worktreeDown]) {
    // Throws (failing the test) if the declared script is missing or not
    // executable — config must never point dispatch at tooling that isn't there.
    accessSync(path.join(ROOT, script), constants.X_OK);
  }
});

test("no worktree_warm — the script does not exist and the field is optional (OPS-463 AC deviation)", () => {
  // The ticket's AC named bin/worktree-warm.sh, but no such script ships in
  // this repo. The field is optional (loadRepos reads it as null when absent);
  // inventing the reference would send tick.mjs at a script that isn't there.
  expect(factory.worktreeWarm).toBeNull();
  expect(existsSync(path.join(ROOT, "bin/worktree-warm.sh"))).toBe(false);
});

test("factory routes to WM / Factory and caps in-flight at 20", () => {
  expect(factory.team).toBe("WM");
  expect(factory.project).toBe("Factory");
  expect(factory.maxInFlight).toBe(20);
});

test("factory branches are unchanged by OPS-463; verify is the fast lib-only gate (WM-528)", () => {
  expect(factory.base).toBe("develop");
  expect(factory.deployBranch).toBe("main");
  // The local VERIFYING gate is deliberately a strict subset of CI: unit-only
  // event-runtime/lib (no daemons/ports/demo seed) plus the emit contract check.
  // The full `bun test` stays in .github/workflows/ci.yml, the real merge gate.
  expect(factory.verify).toBe(
    "bun test event-runtime/lib && bun build/emit.mjs --check",
  );
});
