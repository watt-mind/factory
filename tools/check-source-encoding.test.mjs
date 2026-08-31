import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "..");

const TEXT_GLOBS = [
  "*.css",
  "*.html",
  "*.js",
  "*.json",
  "*.md",
  "*.mjs",
  "*.ts",
  "*.tsx",
  "*.sh",
  "*.yaml",
  "*.yml",
];

/** Locate NUL bytes in a buffer, reporting 1-based line numbers. */
function findNulHits(relPath, bytes) {
  const hits = [];
  let line = 1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) hits.push({ path: relPath, line });
    if (bytes[i] === 0x0a) line += 1;
  }
  return hits;
}

function formatHits(hits) {
  return hits.map((hit) => `${hit.path}:${hit.line}`).join("\n");
}

function trackedTextSources(repoRoot) {
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", repoRoot, "ls-files", "--", ...TEXT_GLOBS],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const detail = (proc.stderr.toString() || proc.stdout.toString()).trim();
    throw new Error(`git ls-files failed${detail ? `: ${detail}` : ""}`);
  }
  return proc.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("NUL hits name the offending path and line", () => {
  const bytes = Buffer.from("ok\nconst key = `a\x00b`;\n");
  expect(formatHits(findNulHits("fixture.mjs", bytes))).toBe("fixture.mjs:2");
});

test("tracked text sources contain no NUL bytes", () => {
  const files = trackedTextSources(ROOT);
  expect(files.length).toBeGreaterThan(0);
  const hits = [];
  for (const rel of files) {
    hits.push(...findNulHits(rel, readFileSync(path.join(ROOT, rel))));
  }
  if (hits.length > 0) {
    throw new Error(`NUL byte in ${formatHits(hits).replaceAll("\n", ", ")}`);
  }
});
