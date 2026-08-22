/**
 * Content pins for harness packs (`contributes.harness`, WM-849) — the floor
 * doc plus every command/skill/subagent file a harness root contributes.
 * Mirrors the per-agent `PINNED_FIELDS` mechanism in registry.mjs: content
 * drifting from its pin fails loudly rather than silently shipping an
 * unreviewed prompt change (WM-855).
 *
 * Operates on plain `roots` arrays shaped like `harnessRootFor()`'s output
 * (event-runtime/lib/extensions.mjs) — this module has no dependency on
 * extensions.mjs itself, so callers (the `update-pins` CLI, registry.mjs)
 * supply whichever roots are in scope.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "./canonical.mjs";
import { RUNTIME_ROOT } from "./config.mjs";

export class HarnessPinError extends Error {
  constructor(message) {
    super(message);
    this.name = "HarnessPinError";
  }
}

export const HARNESS_PINS_FILE = path.join(RUNTIME_ROOT, "pins.json");

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(path.join(dir, entry.name))
      : [path.join(dir, entry.name)],
  );
}

/** Every file one harness root contributes: the floor doc plus everything under commands/skills/subagents. */
function harnessFiles(root) {
  const files = [];
  if (root.floor) files.push(root.floor);
  if (root.commands) files.push(...listFiles(root.commands));
  if (root.skills) files.push(...listFiles(root.skills));
  if (root.subagents) files.push(...listFiles(root.subagents));
  return files;
}

/**
 * Hash every harness-content file each root contributes, keyed by plugin
 * name (unique per docs/kernel-and-packs.md's harness-root rules) with
 * `dir`-relative paths so pins survive a checkout moving.
 */
export function hashHarnessRoots(roots) {
  const pins = {};
  for (const root of roots) {
    const files = {};
    for (const file of harnessFiles(root).sort()) {
      files[path.relative(root.dir, file)] = hashBytes(readFileSync(file));
    }
    pins[root.plugin] = {
      origin: root.origin,
      name: root.name,
      version: root.version,
      files,
    };
  }
  return pins;
}

export function loadHarnessPins(file = HARNESS_PINS_FILE) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Recompute harness pins for `roots` and write them to `file` (default
 * `event-runtime/pins.json`) unless `check`. Returns the plugin names whose
 * pins changed (new, removed, or drifted) — `[]` when already current.
 */
export function updateHarnessPins({
  roots,
  file = HARNESS_PINS_FILE,
  check = false,
} = {}) {
  const computed = hashHarnessRoots(roots);
  const serialized = `${JSON.stringify(computed, null, 2)}\n`;
  const existingSerialized = existsSync(file)
    ? readFileSync(file, "utf8")
    : null;
  if (existingSerialized === serialized) return [];
  const existing = existingSerialized ? JSON.parse(existingSerialized) : {};
  const changed = Array.from(
    new Set([...Object.keys(computed), ...Object.keys(existing)]),
  ).filter(
    (name) => JSON.stringify(computed[name]) !== JSON.stringify(existing[name]),
  );
  if (!check) writeFileSync(file, serialized, "utf8");
  return changed;
}

/**
 * Validate `roots`' current content against the pins on disk. Throws
 * `HarnessPinError` on the first missing or drifted pin — closed exactly
 * like the per-agent `PINNED_FIELDS` check in registry.mjs.
 */
export function verifyHarnessPins(roots, { file = HARNESS_PINS_FILE } = {}) {
  const pinned = loadHarnessPins(file);
  const computed = hashHarnessRoots(roots);
  for (const [plugin, { files }] of Object.entries(computed)) {
    const expected = pinned[plugin];
    if (!expected) {
      throw new HarnessPinError(
        `harness pack "${plugin}" has no pin — run: bun event-runtime/cli.mjs update-pins`,
      );
    }
    for (const [rel, actual] of Object.entries(files)) {
      const expectedHash = expected.files?.[rel];
      if (!expectedHash) {
        throw new HarnessPinError(
          `harness pack "${plugin}": "${rel}" has no pin — run: bun event-runtime/cli.mjs update-pins`,
        );
      }
      if (expectedHash !== actual) {
        throw new HarnessPinError(
          `harness pack "${plugin}": "${rel}" content ${actual} does not match pin ${expectedHash} — bump the version (and re-pin) instead of editing in place`,
        );
      }
    }
    // Fail closed on deletions too: a pinned file missing from the current
    // content is drift, not silence (WM-855 — verification must not pass
    // trivially when a harness root shrinks or a manifest stops declaring
    // a contributed dir).
    for (const rel of Object.keys(expected.files ?? {})) {
      if (!(rel in files)) {
        throw new HarnessPinError(
          `harness pack "${plugin}": pinned file "${rel}" is missing — re-pin instead of deleting in place`,
        );
      }
    }
  }
  // A plugin that was pinned but no longer appears in the computed roots
  // (root removed, or its manifest stopped declaring a contributed dir) is
  // the same drift as a missing file — catch it here rather than passing
  // silently because the loop above only iterates `computed`.
  for (const plugin of Object.keys(pinned)) {
    if (!(plugin in computed)) {
      throw new HarnessPinError(
        `harness pack "${plugin}" is pinned but no longer contributes harness content — run: bun event-runtime/cli.mjs update-pins`,
      );
    }
  }
}
