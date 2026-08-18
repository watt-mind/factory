import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { withTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-tmp-hygiene-test-mjs";

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
});
