/**
 * ControlPlane connector entry point (WM-797).
 *
 *   import { loadControlPlane } from "../lib/control-plane/index.mjs";
 *   const cp = loadControlPlane();              // kind from config/policy.yaml
 *   const ready = await cp.listDispatchable({ team: "WM" });
 *
 * Selection lives in `config/policy.yaml`:
 *
 *   controlPlane:
 *     kind: linear     # default when the stanza is absent
 *
 * `memory` is the in-process fake for tests and the demo. Anything else is a
 * configuration error and throws — a tracker the factory cannot reach must
 * never be silently downgraded to "no tickets". GitHub Issues is WM-798.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linearControlPlane } from "./linear.mjs";
import { memoryControlPlane } from "./memory.mjs";
import { CONTROL_PLANE_KINDS } from "./types.mjs";

export { linearControlPlane } from "./linear.mjs";
export { memoryControlPlane } from "./memory.mjs";
export { ControlPlaneError, CONTROL_PLANE_KINDS } from "./types.mjs";
export {
  TYPE_LABELS,
  SOURCE_LABELS,
  AGENT_READY_LABEL,
  IN_PROGRESS_LABEL,
  validateLabels,
  resolveLabelIds,
  agentLabel,
  claimLabels,
  appendIssueDetail,
  stampRun,
} from "./labels.mjs";

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** `controlPlane.kind` from `<root>/config/policy.yaml`; `linear` when unset. */
export function controlPlaneKindFromPolicy(root = DEFAULT_ROOT) {
  let policy;
  try {
    policy = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    );
  } catch (err) {
    if (err?.code === "ENOENT") return "linear";
    throw err;
  }
  const kind = policy?.controlPlane?.kind ?? "linear";
  if (!CONTROL_PLANE_KINDS.includes(kind)) {
    throw new Error(
      `config/policy.yaml controlPlane.kind=${JSON.stringify(kind)} is not one of ${CONTROL_PLANE_KINDS.join(", ")}`,
    );
  }
  return kind;
}

/**
 * @param {{
 *   root?: string,
 *   kind?: "linear"|"memory",
 *   gql?: Function,     // linear: GraphQL runner (tests)
 *   seed?: object,      // memory: initial workspace fixture
 * }} [options]
 * @returns {import("./types.mjs").ControlPlane}
 */
export function loadControlPlane({
  root = DEFAULT_ROOT,
  kind,
  gql,
  seed,
} = {}) {
  const selected = kind ?? controlPlaneKindFromPolicy(root);
  switch (selected) {
    case "linear":
      return linearControlPlane(gql ? { gql } : {});
    case "memory":
      return memoryControlPlane(seed);
    default:
      throw new Error(`unknown control-plane kind ${JSON.stringify(selected)}`);
  }
}
