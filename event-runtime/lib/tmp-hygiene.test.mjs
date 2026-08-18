import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { withTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-tmp-hygiene-test-mjs";
import { commandFixture } from "../test-support/command-fixture.mjs";
import { TMP_PREFIXES } from "../../orchestrator/chrome-sweep.mjs";

describe("temporary-directory test hygiene", () => {
  test("event-runtime tests use the tracked tmpDir helper", () => {
    const root = path.resolve(import.meta.dir, "..");
    const pending = [root];
    const offenders = [];
    const forbiddenCall = ["mkdtemp", "Sync("].join("");
    const trackedCall = ["tmp", "Dir("].join("");

    while (pending.length) {
      const dir = pending.pop();
      for (const entry of readdirSync(dir)) {
        const candidate = path.join(dir, entry);
        const stat = statSync(candidate);
        if (stat.isDirectory()) {
          if (entry !== "node_modules" && entry !== "dist")
            pending.push(candidate);
        } else if (entry.endsWith(".test.mjs")) {
          const source = readFileSync(candidate, "utf8");
          if (
            source.includes(forbiddenCall) ||
            (source.includes(trackedCall) && !source.includes("tmp.mjs?file="))
          )
            offenders.push(path.relative(root, candidate));
        }
      }
    }

    expect(offenders.sort()).toEqual([]);
  });

  test("withTmpDir removes the directory after synchronous work", () => {
    let dir;
    const value = withTmpDir("evrt-scoped-", (candidate) => {
      dir = candidate;
      expect(existsSync(candidate)).toBe(true);
      return "done";
    });

    expect(value).toBe("done");
    expect(existsSync(dir)).toBe(false);
  });

  test("withTmpDir removes the directory after asynchronous work", async () => {
    let dir;
    await withTmpDir("evrt-scoped-", async (candidate) => {
      dir = candidate;
      expect(existsSync(candidate)).toBe(true);
    });

    expect(existsSync(dir)).toBe(false);
  });

  test("commandFixture creates directories under a sweep-matched prefix (WM-760)", () => {
    // commandFixture() is used by merge.test.mjs / merge-apply.test.mjs with
    // caller-supplied prefixes ("merge-apply-linear-", "branch-guard-", ...)
    // that don't themselves appear in the CI sweep / chrome-sweep janitor
    // prefix lists. The helper must force every fixture root under a prefix
    // those sweeps do match, regardless of what the caller passes, or the
    // directories leak forever instead of just until the next sweep.
    const fixture = commandFixture("some-caller-supplied-prefix-");
    try {
      const base = path.basename(fixture.root);
      expect(TMP_PREFIXES.some((prefix) => base.startsWith(prefix))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
