import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODEL_ADAPTERS } from "./model-adapters.mjs";
import { MODEL_ADAPTERS as REGISTRY_MODEL_ADAPTERS } from "./registry.mjs";
import { MODEL_BACKED_ADAPTERS } from "./adapters/sandboxed.mjs";

const LIB = import.meta.dir;
const IMPORT_RE = /^(?:import|export)[^;]*?from\s+["']([^"']+)["']/gms;

/** Static relative imports of one lib module, resolved to absolute paths. */
function staticImports(file) {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(IMPORT_RE)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith("."))
    .map((spec) => path.resolve(path.dirname(file), spec));
}

/** Every lib module reachable from `entry` through static imports. */
function closure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...staticImports(file));
  }
  return seen;
}

describe("model-adapters (GH-1736)", () => {
  test("is a leaf module: no imports at all", () => {
    expect(staticImports(path.join(LIB, "model-adapters.mjs"))).toEqual([]);
  });

  test("registry re-exports the same set instance", () => {
    expect(REGISTRY_MODEL_ADAPTERS).toBe(MODEL_ADAPTERS);
    expect([...MODEL_ADAPTERS].sort()).toEqual([
      "agy",
      "claude",
      "cursor",
      "pi",
    ]);
  });

  test("sandboxed.mjs derives MODEL_BACKED_ADAPTERS from it without registry.mjs", () => {
    expect(MODEL_BACKED_ADAPTERS).toEqual(
      [...new Set([...MODEL_ADAPTERS, "hermes"])].sort(),
    );
    // The sandbox seam is imported by every adapter; if it ever reaches
    // registry.mjs again, any registry dependency touching lib/adapters closes
    // an import cycle and MODEL_ADAPTERS is read in its temporal dead zone.
    const reach = closure(path.join(LIB, "adapters", "sandboxed.mjs"));
    expect(reach.has(path.join(LIB, "registry.mjs"))).toBe(false);
  });
});
