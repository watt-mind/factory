#!/usr/bin/env bun
/**
 * Validate the forkable Factory instance template, then show what an npm
 * package dry-run would contain. This command never writes or publishes.
 *
 *   bun tools/publish-starter.mjs --dry-run
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTER = path.join(ROOT, "templates", "starter");
const EXACT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REQUIRED_FILES = [
  "package.json",
  "AGENTS.md",
  "README.md",
  "config/repos.yaml",
  "config/policy.yaml",
  "config/schedule.yaml",
  "packs/README.md",
  "scripts/check.mjs",
  ".github/workflows/ci.yml",
];

function usage() {
  return "usage: bun tools/publish-starter.mjs --dry-run";
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === "--dry-run") return { dryRun: true };
  throw new Error(usage());
}

export function validateStarter(dir = STARTER) {
  const missing = REQUIRED_FILES.filter(
    (file) => !existsSync(path.join(dir, file)),
  );
  if (missing.length) {
    throw new Error(`starter template is missing: ${missing.join(", ")}`);
  }

  const manifest = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf8"),
  );
  const kernel = manifest.dependencies?.["@watt-mind/factory"];
  if (typeof kernel !== "string" || !EXACT_SEMVER_RE.test(kernel)) {
    throw new Error(
      "starter package.json must pin @watt-mind/factory to an exact SemVer version (no ranges)",
    );
  }
  return { dir, manifest, kernel, requiredFiles: REQUIRED_FILES };
}

export function dryRunPackage(dir = STARTER, spawn = spawnSync) {
  const packed = spawn("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    const detail = String(packed.stderr || packed.stdout || "").trim();
    throw new Error(detail || "npm pack --dry-run failed");
  }
  try {
    return JSON.parse(packed.stdout);
  } catch {
    throw new Error("npm pack --dry-run returned invalid JSON");
  }
}

export function run(args = process.argv.slice(2), { log = console.log } = {}) {
  parseArgs(args);
  const checked = validateStarter();
  const report = dryRunPackage(checked.dir);
  const item = Array.isArray(report) ? report[0] : report;
  const files = item?.files ?? [];
  log(
    `factory-starter: valid (${checked.requiredFiles.length} required files)`,
  );
  log(`kernel: ${checked.kernel}`);
  log(
    `dry-run package: ${item?.name ?? checked.manifest.name}@${item?.version ?? checked.manifest.version} (${files.length} files)`,
  );
  for (const file of files) log(`  ${file.path ?? file}`);
  return { checked, package: item };
}

if (import.meta.main) {
  try {
    run();
  } catch (error) {
    console.error(`publish-starter: ${error.message}`);
    process.exit(1);
  }
}
