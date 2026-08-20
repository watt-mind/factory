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
 *     # kind: github   # Issues + Projects (WM-798 / WM-955)
 *
 * `memory` is the in-process fake for tests and the demo. `github` is the
 * Issues + Projects adapter (WM-798), selected here (WM-955). Anything else
 * is a configuration error and throws — a tracker the factory cannot reach
 * must never be silently downgraded to "no tickets".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubControlPlane } from "./github.mjs";
import { linearControlPlane } from "./linear.mjs";
import { memoryControlPlane } from "./memory.mjs";
import { CONTROL_PLANE_KINDS } from "./types.mjs";

export { githubControlPlane } from "./github.mjs";
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
 *   kind?: "linear"|"memory"|"github",
 *   gql?: Function,     // linear: GraphQL runner (tests)
 *   seed?: object,      // memory: initial workspace fixture
 *   api?: Function,     // github: gh api seam (tests)
 *   exec?: Function,    // github: spawnSync-shaped runner (tests)
 *   repo?: string,      // github: default owner/name
 *   teams?: Record<string, string>, // github: team key → repository
 *   project?: string,   // github: Projects v2 title
 *   statusField?: string, // github: status single-select name
 * }} [options]
 * @returns {import("./types.mjs").ControlPlane}
 */
export function loadControlPlane({
  root = DEFAULT_ROOT,
  kind,
  gql,
  seed,
  api,
  exec,
  repo,
  teams,
  project,
  statusField,
} = {}) {
  const selected = kind ?? controlPlaneKindFromPolicy(root);
  switch (selected) {
    case "linear":
      return linearControlPlane(gql ? { gql } : {});
    case "memory":
      return memoryControlPlane(seed);
    case "github":
      return githubControlPlane({
        root,
        api,
        exec,
        repo,
        teams,
        project,
        statusField,
      });
    default:
      throw new Error(`unknown control-plane kind ${JSON.stringify(selected)}`);
  }
}
