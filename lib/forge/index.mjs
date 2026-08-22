/**
 * Forge connector entry point (WM-836).
 *
 *   import { loadForge } from "../lib/forge/index.mjs";
 *   const forge = loadForge();                 // kind from config/policy.yaml
 *   const prs = forge.prList("watt-mind/factory", { state: "open", fields: ["number"] });
 *
 * Selection lives in `config/policy.yaml`:
 *
 *   forge:
 *     kind: github     # default when the stanza is absent
 *
 * `memory` is the in-process fake for tests and the demo. Anything else is a
 * configuration error and throws — a forge the factory cannot reach must never
 * be silently downgraded to "no PRs".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "../../event-runtime/lib/config.mjs";
import { githubForge } from "./github.mjs";
import { memoryForge } from "./memory.mjs";
import { FORGE_KINDS } from "./types.mjs";

export { githubForge } from "./github.mjs";
export { memoryForge } from "./memory.mjs";
export { ForgeError, FORGE_KINDS } from "./types.mjs";

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * `forge.kind` from local-first `config/policy.yaml` (falling back to the
 * tracked `config/policy.example.yaml`); `github` when the stanza is absent.
 * Fails closed when neither file exists at all.
 */
export function forgeKindFromPolicy(root = DEFAULT_ROOT) {
  const policy = Bun.YAML.parse(
    readFileSync(resolveConfigPath("policy", { root }), "utf8"),
  );
  const kind = policy?.forge?.kind ?? "github";
  if (!FORGE_KINDS.includes(kind)) {
    throw new Error(
      `config/policy.yaml forge.kind=${JSON.stringify(kind)} is not one of ${FORGE_KINDS.join(", ")}`,
    );
  }
  return kind;
}

/**
 * @param {{
 *   root?: string,          // factory checkout holding config/policy.yaml
 *   kind?: "github"|"memory", // override the policy selection (tests)
 *   exec?: Function,        // github: spawnSync-shaped runner (tests)
 *   seed?: object,          // memory: initial repos/api fixture
 * }} [options]
 * @returns {import("./types.mjs").Forge}
 */
export function loadForge({ root = DEFAULT_ROOT, kind, exec, seed } = {}) {
  const selected = kind ?? forgeKindFromPolicy(root);
  switch (selected) {
    case "github":
      return githubForge(exec ? { exec } : {});
    case "memory":
      return memoryForge(seed);
    default:
      throw new Error(`unknown forge kind ${JSON.stringify(selected)}`);
  }
}
