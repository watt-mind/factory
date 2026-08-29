// Hermetic FACTORY_EVENT_HOME is a property of the test process (#1285).
//
// This file deliberately does NOT import ../test-helpers.mjs: it asserts that
// bunfig.toml's `[test] preload` establishes the isolated home for every test
// file, whatever order bun walks the tree in.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("hermetic test home (#1285)", () => {
  test("a test file that imports no helper still has an isolated FACTORY_EVENT_HOME", () => {
    const home = process.env.FACTORY_EVENT_HOME;
    expect(typeof home).toBe("string");
    expect(home).not.toBe("");
    expect(home.startsWith(path.join(homedir(), ".factory"))).toBe(false);
  });

  test("bun test is hermetic from a scrubbed environment, not from file order", () => {
    // The handoff verify gate runs the suite under `env -i` with every
    // FACTORY_* variable scrubbed (verify.mjs, HANDOFF_SANDBOX_SETUP). HOME
    // points at a throwaway directory so a regression cannot reach the
    // operator's real ~/.factory even if the guard were removed.
    const guestHome = path.join(
      process.env.FACTORY_EVENT_HOME,
      "hermetic-probe-home",
    );
    const child = spawnSync(
      process.execPath,
      ["test", "event-runtime/lib/trace.test.mjs", "--timeout", "20000"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: guestHome,
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          LANG: "C.UTF-8",
        },
      },
    );
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    expect(output).not.toContain("refusing to use the default runtime home");
    expect(child.status).toBe(0);
  });
});
