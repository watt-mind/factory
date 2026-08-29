#!/usr/bin/env bun
/**
 * `extensions pack` (WM-922) — validate an extension then run `npm pack
 * --dry-run` so the operator sees what a publish would ship.
 *
 * `extensions list` / `validate` stay in event-runtime/cli.mjs. Validate
 * already accepts a package name because lib/extensions.mjs resolves it.
 * Wiring `pack` into cli.mjs is outside this ticket's Owned Paths.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateExtensionManifest } from "../lib/extensions.mjs";

/**
 * Normalize `npm pack --dry-run --json` into a flat list of report entries,
 * tolerant of the shape differences between npm versions:
 *   - older npm returns an array of report objects `[{ name, files, ... }]`;
 *   - newer npm (>=12) returns an object keyed by package name
 *     `{ "@scope/name": { name, files, ... } }`;
 *   - a bare single report object `{ name, files, ... }` is also accepted.
 * Each returned entry carries `name`/`version`/`files` when npm provides them.
 *
 * @param {unknown} report
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizePackReport(report) {
  if (Array.isArray(report)) return report;
  if (report && typeof report === "object") {
    // A single report object exposes its own file list at the top level;
    // the keyed-by-name shape does not — its entries live under each key.
    if (Array.isArray(report.files) || "filename" in report || "id" in report) {
      return [report];
    }
    const entries = Object.values(report).filter(
      (value) => value && typeof value === "object",
    );
    if (entries.length) return entries;
  }
  return [report];
}

/**
 * Validate `dir` (filesystem path or package name) and list the files
 * `npm pack --dry-run` would include.
 *
 * @param {string} dir
 * @param {{ spawn?: typeof spawnSync, exit?: (code: number) => never, log?: (message: string) => void, error?: (message: string) => void }} [options]
 */
export function packExtension(
  dir,
  {
    spawn = spawnSync,
    exit = (code) => process.exit(code),
    log = console.log,
    error = console.error,
  } = {},
) {
  const checked = validateExtensionManifest(dir);
  for (const warning of checked.warnings) console.error(`warning: ${warning}`);
  if (!checked.valid) {
    for (const error of checked.errors) console.error(`error: ${error}`);
    return exit(1);
  }
  const cwd = path.dirname(checked.file);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch (err) {
    error(`npm_pack_metadata_invalid: package.json: ${err.message}`);
    return exit(1);
  }
  if (
    typeof pkg?.name !== "string" ||
    pkg.name === "" ||
    typeof pkg?.version !== "string" ||
    pkg.version === ""
  ) {
    error("npm_pack_metadata_invalid: package.json needs name and version");
    return exit(1);
  }

  // npm's shared cache produced another fixture's package metadata twice on a
  // busy self-hosted runner (#1161). One private cache plus an explicit target
  // keeps concurrent pack probes independent and makes the inspected package
  // unambiguous.
  const cache = mkdtempSync(path.join(os.tmpdir(), "factory-npm-pack-"));
  let packed;
  try {
    packed = spawn(
      "npm",
      [
        "pack",
        ".",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--cache",
        cache,
      ],
      { cwd, encoding: "utf8" },
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  if (packed.status !== 0) {
    const detail = String(packed.stderr || packed.stdout || "").trim();
    error(detail || "npm pack --dry-run failed");
    return exit(packed.status === null ? 1 : packed.status);
  }

  let report;
  try {
    report = JSON.parse(packed.stdout);
  } catch (err) {
    error(`npm_pack_metadata_invalid: invalid JSON: ${err.message}`);
    return exit(1);
  }
  // Tolerate npm's shape differences via the shared normalizer (older npm
  // returns an array, newer npm a `{ "package-name": metadata }` map, and a
  // bare single object is also accepted); every identity is still revalidated
  // strictly below against the package we asked npm to inspect.
  const entries = normalizePackReport(report);
  if (entries.length !== 1) {
    error(
      `npm_pack_metadata_invalid: expected one package, got ${Array.isArray(report) ? report.length : typeof report}`,
    );
    return exit(1);
  }
  const [item] = entries;
  if (item?.name !== pkg.name || item?.version !== pkg.version) {
    const shape =
      item && typeof item === "object"
        ? `keys=${Object.keys(item).sort().join(",") || "<none>"}${item.error?.code ? ` error=${item.error.code}` : ""}`
        : `type=${typeof item}`;
    error(
      `npm_pack_metadata_invalid: expected ${pkg.name}@${pkg.version}, got ${String(item?.name)}@${String(item?.version)} (${shape})`,
    );
    return exit(1);
  }
  if (
    !Array.isArray(item.files) ||
    item.files.length === 0 ||
    !item.files.every(
      (file) =>
        typeof file === "string" ||
        (file && typeof file.path === "string" && file.path !== ""),
    )
  ) {
    error(
      `npm_pack_metadata_invalid: ${pkg.name}@${pkg.version} returned no valid files`,
    );
    return exit(1);
  }

  log(`${item.name}@${item.version}: would pack ${item.files.length} files`);
  for (const file of item.files) log(`  ${file.path ?? file}`);
  return { ...checked, pack: entries };
}

export async function extensionsCommand(args = []) {
  const [sub, ...rest] = args;
  if (sub === "pack") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) {
      console.error("usage: extensions pack <dir>");
      process.exit(1);
    }
    return packExtension(target);
  }
  if (sub === "validate") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) {
      console.error("usage: extensions validate <dir|package>");
      process.exit(1);
    }
    const out = validateExtensionManifest(target);
    for (const warning of out.warnings) console.error(`warning: ${warning}`);
    if (!out.valid) {
      for (const error of out.errors) console.error(`error: ${error}`);
      process.exit(1);
    }
    const contributes = out.manifest.contributes ?? {};
    const packs = (contributes.packs ?? []).length;
    const adapters = Object.keys(contributes.adapters ?? {}).length;
    const namespace = contributes.config?.namespace;
    const counts = `${packs} pack${packs === 1 ? "" : "s"}, ${adapters} adapter${adapters === 1 ? "" : "s"}`;
    const configBit =
      typeof namespace === "string" && namespace !== ""
        ? `, config namespace ${namespace}`
        : "";
    console.log(
      `${out.manifest.name}@${out.manifest.version}: valid (${counts}${configBit})`,
    );
    return out;
  }
  console.error(
    "usage: extensions pack <dir> | extensions validate <dir|package>",
  );
  process.exit(1);
}

export default function extensions(args = []) {
  return extensionsCommand(args);
}

if (import.meta.main) {
  await extensionsCommand(process.argv.slice(2));
}
