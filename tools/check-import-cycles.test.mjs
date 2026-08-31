import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  assertNoImportCycles,
  resolveRelativeImport,
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
