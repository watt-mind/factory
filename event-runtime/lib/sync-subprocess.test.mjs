import { test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.join(path.dirname(LIB_DIR), "cli");
const ROOT_DIR = path.dirname(path.dirname(LIB_DIR));

/**
 * Recursively find all local dependencies imported by entrypoints.
 */
function traceImports(entrypoints) {
  const visited = new Set();
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current) || !existsSync(current)) continue;
    visited.add(current);

    const content = readFileSync(current, "utf8");
    const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(current), specifier);
        if (existsSync(resolved) && !visited.has(resolved)) {
          queue.push(resolved);
        } else if (
          existsSync(`${resolved}.mjs`) &&
          !visited.has(`${resolved}.mjs`)
        ) {
          queue.push(`${resolved}.mjs`);
        } else if (
          existsSync(`${resolved}.js`) &&
          !visited.has(`${resolved}.js`)
        ) {
          queue.push(`${resolved}.js`);
        }
      }
    }
  }

  return visited;
}

test("no synchronous subprocess calls on the serve or tick import tree (WM-1208)", () => {
  const readdir = readdirSync(LIB_DIR)
    .filter(
      (f) =>
        f.startsWith("api-") && f.endsWith(".mjs") && !f.endsWith(".test.mjs"),
    )
    .map((f) => path.join(LIB_DIR, f));

  const serveRequestAndTickFiles = [
    path.join(CLI_DIR, "serve.mjs"),
    path.join(LIB_DIR, "api.mjs"),
    ...readdir,
    path.join(LIB_DIR, "config.mjs"),
    path.join(LIB_DIR, "nodes-config.mjs"),
    path.join(LIB_DIR, "db.mjs"),
    path.join(LIB_DIR, "registry.mjs"),
    path.join(LIB_DIR, "schedules.mjs"),
    path.join(LIB_DIR, "auto-approval.mjs"),
    path.join(LIB_DIR, "reaper.mjs"),
    path.join(LIB_DIR, "outbox.mjs"),
    path.join(LIB_DIR, "inbox.mjs"),
    path.join(LIB_DIR, "notify.mjs"),
    path.join(LIB_DIR, "chain.mjs"),
    path.join(LIB_DIR, "artifacts.mjs"),
    path.join(LIB_DIR, "memos.mjs"),
    path.join(LIB_DIR, "planner-worker.mjs"),
    path.join(LIB_DIR, "planner-loop.mjs"),
  ];

  expect(serveRequestAndTickFiles.length).toBeGreaterThan(15);

  const forbiddenPatterns = [
    /\bexecFileSync\s*\(/,
    /\bspawnSync\s*\(/,
    /\bexecSync\s*\(/,
    /\bBun\.spawnSync\s*\(/,
  ];

  const violations = [];

  for (const file of serveRequestAndTickFiles) {
    expect(existsSync(file)).toBe(true);
    const relPath = path.relative(ROOT_DIR, file);
    const content = readFileSync(file, "utf8");
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(content)) {
        violations.push(`${relPath} matches ${pattern}`);
      }
    }
  }

  expect(violations).toEqual([]);
});
