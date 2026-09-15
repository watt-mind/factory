import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "..");

test("check runs the formatting gate", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );

  expect(manifest.scripts.check).toContain("bun run format:check");
});
