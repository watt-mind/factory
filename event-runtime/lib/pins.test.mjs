import { withTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-pins-test-mjs";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  HarnessPinError,
  hashHarnessRoots,
  loadHarnessPins,
  updateHarnessPins,
  verifyHarnessPins,
} from "./pins.mjs";

function makeRoot(dir, { plugin = "core", origin = "builtin" } = {}) {
  mkdirSync(path.join(dir, "commands"), { recursive: true });
  mkdirSync(path.join(dir, "skills", "widget"), { recursive: true });
  writeFileSync(path.join(dir, "floor.md"), "floor v1\n");
  writeFileSync(path.join(dir, "commands", "hello.md"), "# hello\n");
  writeFileSync(path.join(dir, "skills", "widget", "SKILL.md"), "# widget\n");
  return {
    dir,
    name: "factory/core",
    version: "0.1.0",
    builtin: origin === "builtin",
    origin,
    plugin,
    prefix: null,
    floor: path.join(dir, "floor.md"),
    commands: path.join(dir, "commands"),
    skills: path.join(dir, "skills"),
    subagents: null,
  };
}

describe("hashHarnessRoots", () => {
  test("hashes the floor doc and every command/skill file, keyed by plugin", () => {
    withTmpDir("pins-hash-", (dir) => {
      const root = makeRoot(dir);
      const pins = hashHarnessRoots([root]);
      expect(Object.keys(pins)).toEqual(["core"]);
      expect(pins.core.origin).toBe("builtin");
      expect(Object.keys(pins.core.files).sort()).toEqual([
        "commands/hello.md",
        "floor.md",
        "skills/widget/SKILL.md",
      ]);
      expect(pins.core.files["floor.md"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });
});

describe("updateHarnessPins / verifyHarnessPins", () => {
  test("writes pins, then a second update reports no change", () => {
    withTmpDir("pins-update-", (dir) => {
      const root = makeRoot(dir);
      const file = path.join(dir, "pins.json");
      const first = updateHarnessPins({ roots: [root], file });
      expect(first).toEqual(["core"]);
      const second = updateHarnessPins({ roots: [root], file });
      expect(second).toEqual([]);
      expect(() => verifyHarnessPins([root], { file })).not.toThrow();
    });
  });

  test("check mode reports drift without writing", () => {
    withTmpDir("pins-check-", (dir) => {
      const root = makeRoot(dir);
      const file = path.join(dir, "pins.json");
      const changed = updateHarnessPins({ roots: [root], file, check: true });
      expect(changed).toEqual(["core"]);
      expect(loadHarnessPins(file)).toEqual({});
    });
  });

  test("verifyHarnessPins throws when a pinned file has no pin on disk", () => {
    withTmpDir("pins-missing-", (dir) => {
      const root = makeRoot(dir);
      const file = path.join(dir, "pins.json");
      expect(() => verifyHarnessPins([root], { file })).toThrow(
        HarnessPinError,
      );
      expect(() => verifyHarnessPins([root], { file })).toThrow(
        /has no pin — run: bun event-runtime\/cli\.mjs update-pins/,
      );
    });
  });

  test("verifyHarnessPins throws when content drifts from its pin", () => {
    withTmpDir("pins-drift-", (dir) => {
      const root = makeRoot(dir);
      const file = path.join(dir, "pins.json");
      updateHarnessPins({ roots: [root], file });
      writeFileSync(path.join(dir, "commands", "hello.md"), "# hello v2\n");
      expect(() => verifyHarnessPins([root], { file })).toThrow(
        /does not match pin/,
      );
    });
  });

  test("verifyHarnessPins throws when a pinned file is deleted, not just changed", () => {
    withTmpDir("pins-deleted-file-", (dir) => {
      const root = makeRoot(dir);
      const file = path.join(dir, "pins.json");
      updateHarnessPins({ roots: [root], file });
      rmSync(path.join(dir, "commands", "hello.md"));
      expect(() => verifyHarnessPins([root], { file })).toThrow(
        /pinned file "commands\/hello\.md" is missing/,
      );
    });
  });

  test("verifyHarnessPins throws when a whole root's content disappears", () => {
    withTmpDir("pins-removed-root-", (dir) => {
      const root = makeRoot(dir);
      const file = path.join(dir, "pins.json");
      updateHarnessPins({ roots: [root], file });
      // Simulate a manifest that stopped declaring a contributed dir, or a
      // root removed entirely — verifyHarnessPins is called with an empty
      // roots list, but the pin on disk still names the plugin.
      expect(() => verifyHarnessPins([], { file })).toThrow(
        /"core" is pinned but no longer contributes harness content/,
      );
    });
  });
});
