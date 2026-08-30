#!/usr/bin/env bun
/**
 * Validate the kernel's publishable package.json and show what
 * `npm publish` would upload. This command never publishes or writes files.
 *
 *   bun tools/publish.mjs --dry-run
 *
 * Semver policy (SemVer 2.0.0; the kernel is pre-1.0 while its public
 * contract is still settling):
 *   - PATCH: bug fixes, docs, internal refactors with no contract change.
 *   - MINOR: backward-compatible additions to the kernel's public surface
 *     (CLI subcommands, extension/pack contracts, event-runtime APIs).
 *   - MAJOR (or, pre-1.0, the MINOR that SemVer §4 allows to break): a
 *     change to a documented contract that an instance's package.json pin
 *     or an extension depends on. docs/instances.md is the upgrade guidance
 *     that must move in the same PR as a breaking change.
 *
 * A release is a `vX.Y.Z` tag on the `deploy_branch` (`main`) with GitHub
 * Release notes generated from the merged PRs since the previous tag. This
 * script does not cut the tag or the release; it only gates the package
 * `npm publish` would upload, so it can run as a pre-publish check.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const USAGE = "usage: bun tools/publish.mjs --dry-run";

class UsageError extends Error {}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

// Paths that must never appear in a published tarball, even if a future
// edit to the `files` allowlist widens it by accident.
const DENYLIST_PATTERNS = [
  // Any config/*.yaml that is not an .example file is instance-local state
  // (repos, policy, schedule, nodes with operator PATs) and must never ship.
  /^config\/(?!.*\.example\.yaml$)[^/]+\.yaml$/,
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)node_modules\//,
  /\.test\.(mjs|ts|tsx)$/,
  /(^|\/)test-support\//,
];

export function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length === 1 && args[0] === "--dry-run") return { dryRun: true };
  throw new UsageError(USAGE);
}

export function validatePackage(dir = ROOT) {
  const manifest = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf8"),
  );

  if (manifest.name !== "@watt-mind/factory") {
    throw new Error(
      `package.json name must be "@watt-mind/factory", got ${JSON.stringify(manifest.name)}`,
    );
  }
  if (
    typeof manifest.version !== "string" ||
    !SEMVER_RE.test(manifest.version)
  ) {
    throw new Error(
      `package.json version must be valid SemVer, got ${JSON.stringify(manifest.version)}`,
    );
  }
  if (manifest.private) {
    throw new Error("package.json must not be private to publish");
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error('package.json publishConfig.access must be "public"');
  }
  if (manifest.bin?.factory !== "bin/factory") {
    throw new Error('package.json bin.factory must be "bin/factory"');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("package.json files allowlist must not be empty");
  }
  return { dir, manifest };
}

export function dryRunPackage(dir = ROOT, spawn = spawnSync) {
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

export function assertNoLeaks(report) {
  const item = Array.isArray(report) ? report[0] : report;
  const files = (item?.files ?? []).map((file) => file.path ?? file);
  const leaked = files.filter((file) =>
    DENYLIST_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (leaked.length) {
    throw new Error(
      `package would publish disallowed paths: ${leaked.join(", ")}`,
    );
  }
  return { item, files };
}

export function run(args = process.argv.slice(2), { log = console.log } = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) return { help: true };
  const { manifest } = validatePackage();
  const report = dryRunPackage();
  const { item, files } = assertNoLeaks(report);
  log(
    `@watt-mind/factory: package.json valid for publish (version ${manifest.version})`,
  );
  log(
    `dry-run package: ${item?.name ?? manifest.name}@${item?.version ?? manifest.version} (${files.length} files)`,
  );
  return { manifest, package: item };
}

if (import.meta.main) {
  try {
    const result = run();
    if (result.help) console.log(USAGE);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      console.error(`publish: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
