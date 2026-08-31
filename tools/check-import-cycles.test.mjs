import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  assertNoImportCycles,
  findImportCycles,
  resolveRelativeImport,
  SOURCE_ROOT,
} from "./check-import-cycles.mjs";

function withFixture(callback) {
  const fixture = mkdtempSync(
    path.join(tmpdir(), "factory-import-cycle-test-"),
  );
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("assertNoImportCycles rejects allowlist entries that no longer match", () => {
  withFixture((fixture) => {
    writeFileSync(path.join(fixture, "first.mjs"), 'import "./second.mjs";\n');
    writeFileSync(path.join(fixture, "second.mjs"), 'import "./first.mjs";\n');

    expect(() =>
      assertNoImportCycles(
        fixture,
        new Set([
          "first.mjs -> second.mjs -> first.mjs",
          "stale.mjs -> entry.mjs -> stale.mjs",
        ]),
      ),
    ).toThrow(
      "Import cycle allowlist is stale:\n  stale.mjs -> entry.mjs -> stale.mjs",
    );
  });
});

test("resolveRelativeImport keeps a real empty module", () => {
  withFixture((fixture) => {
    const importer = path.join(fixture, "importer.mjs");
    const emptyModule = path.join(fixture, "empty.mjs");
    writeFileSync(importer, 'import "./empty.mjs";\n');
    writeFileSync(emptyModule, "");

    expect(resolveRelativeImport(importer, "./empty.mjs")).toBe(emptyModule);
  });
});

test("cycle discovery does not depend on directory entry order", () => {
  // The detector reports one cycle per multi-cycle SCC, so which cycle it
  // reports follows the DFS start order. sourceFiles() sorts for that reason:
  // without it the discovered set (and therefore the staleness check) varies
  // with filesystem order, and the baseline fails on some machines.
  const modules = {
    "alpha.mjs": 'import "./beta.mjs";\n',
    "beta.mjs": 'import "./gamma.mjs";\n',
    "gamma.mjs": 'import "./alpha.mjs";\nimport "./beta.mjs";\n',
  };
  const discover = (creationOrder) =>
    withFixture((fixture) => {
      for (const name of creationOrder)
        writeFileSync(path.join(fixture, name), modules[name]);
      return findImportCycles(fixture)
        .map((cycle) => cycle.map((file) => path.basename(file)).join(" -> "))
        .sort();
    });

  const names = Object.keys(modules);
  expect(discover(names)).toEqual(discover([...names].reverse()));
});

test("the repository baseline matches the cycles found under sorted order", () => {
  expect(() => assertNoImportCycles(SOURCE_ROOT)).not.toThrow();
});
