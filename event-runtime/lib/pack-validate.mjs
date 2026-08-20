/** Validate one data-only filesystem pack through the production registry loader. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadRegistry } from "./registry.mjs";
import { assertPackName } from "./pack-init.mjs";

function readManifest(root) {
  const file = path.join(root, "pack.json");
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("top level must be an object");
    }
    return manifest;
  } catch (err) {
    throw new Error(`${file}: invalid JSON — ${err.message}`, { cause: err });
  }
}

/**
 * Run the same loader that admits an allow-listed pack. The direct descriptor
 * makes this a safe authoring check: it does not edit policy.yaml or discover
 * neighbouring directories.
 */
export function validatePack(target) {
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("pack path must be a non-empty string");
  }
  const root = path.resolve(target);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`pack directory does not exist: ${root}`);
  }
  const manifest = readManifest(root);
  assertPackName(manifest.name);
  if (
    typeof manifest.namespace !== "string" ||
    manifest.namespace.trim() === ""
  ) {
    throw new Error(
      `${path.join(root, "pack.json")}: namespace must be a non-empty string`,
    );
  }
  const registry = loadRegistry({
    packRoots: [
      {
        kind: "fs",
        name: manifest.name,
        path: root,
        namespace: manifest.namespace,
      },
    ],
  });
  const pack = registry.packs.find((entry) => entry.name === manifest.name);
  return {
    name: manifest.name,
    root,
    namespace: manifest.namespace,
    agents: [...registry.agents.values()].filter(
      (agent) => agent.pack === manifest.name,
    ).length,
    pack,
  };
}
