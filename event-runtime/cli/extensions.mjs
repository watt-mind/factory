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
import path from "node:path";
import { validateExtensionManifest } from "../lib/extensions.mjs";

/**
 * Validate `dir` (filesystem path or package name) and list the files
 * `npm pack --dry-run` would include.
 *
 * @param {string} dir
 * @param {{ spawn?: typeof spawnSync, exit?: (code: number) => never }} [options]
 */
export function packExtension(
  dir,
  { spawn = spawnSync, exit = (code) => process.exit(code) } = {},
) {
  const checked = validateExtensionManifest(dir);
  for (const warning of checked.warnings) console.error(`warning: ${warning}`);
  if (!checked.valid) {
    for (const error of checked.errors) console.error(`error: ${error}`);
    return exit(1);
  }
  const cwd = path.dirname(checked.file);
  const packed = spawn("npm", ["pack", "--dry-run", "--json"], {
    cwd,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    const detail = String(packed.stderr || packed.stdout || "").trim();
    console.error(detail || "npm pack --dry-run failed");
    return exit(packed.status === null ? 1 : packed.status);
  }
  let report;
  try {
    report = JSON.parse(packed.stdout);
  } catch {
    console.log(packed.stdout);
    return checked;
  }
  const entries = Array.isArray(report) ? report : [report];
  for (const item of entries) {
    const files = item.files ?? [];
    const name = item.name ?? checked.manifest.name;
    const version = item.version ?? checked.manifest.version;
    console.log(`${name}@${version}: would pack ${files.length} files`);
    for (const file of files) {
      console.log(`  ${file.path ?? file}`);
    }
  }
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
