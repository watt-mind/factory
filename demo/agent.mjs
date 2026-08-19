/**
 * Deterministic fake harness for the bundled DEMO-1 ticket.
 * Copies the canned greet() implementation into the worktree — no model.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

export function applyStarterPatch(worktreeDir, fixturesDir = FIXTURES) {
  const src = path.join(worktreeDir, "src");
  mkdirSync(src, { recursive: true });
  copyFileSync(
    path.join(fixturesDir, "greet.mjs"),
    path.join(src, "greet.mjs"),
  );
  copyFileSync(
    path.join(fixturesDir, "greet.test.mjs"),
    path.join(src, "greet.test.mjs"),
  );
  const indexPath = path.join(src, "index.mjs");
  const current = readFileSync(indexPath, "utf8");
  if (!current.includes('from "./greet.mjs"')) {
    writeFileSync(
      indexPath,
      `${current.trimEnd()}\nexport { greet } from "./greet.mjs";\n`,
      "utf8",
    );
  }
}
