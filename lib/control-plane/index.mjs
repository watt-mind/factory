/**
 * ControlPlane connector entry point (WM-797).
 *
 *   import { loadControlPlane } from "../lib/control-plane/index.mjs";
 *   const cp = loadControlPlane();              // kind from config/policy.yaml
 *   const ready = await cp.listDispatchable({ team: "WM" });
 *
 *   loadControlPlane({ repoName: "factory" })   // kind from that repo's entry
 *
 * Selection is per repo, falling back to the workspace default (WM-1007):
 *
 *   1. an explicit `kind` option              (tests, and callers that know)
 *   2. `control_plane:` on the `config/repos.yaml` entry named `repoName`
 *   3. `controlPlane.kind` in `config/policy.yaml`
 *   4. `linear`
 *
 * The per-repo level is what lets one factory instance run its own repo on
 * GitHub Issues while every other repo it manages stays on Linear (WM-1006).
 * Without it the choice is global, and moving one repo moves all of them.
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
// Layering note: lib/ -> event-runtime/lib/ already exists (lib/ps.mjs reads
// config.mjs). No cycle — repos.mjs imports ./types.mjs, never this module.
import { loadRepos } from "../../event-runtime/lib/repos.mjs";

export { githubControlPlane } from "./github.mjs";
export { linearControlPlane } from "./linear.mjs";
export { memoryControlPlane } from "./memory.mjs";
export {
  ControlPlaneError,
  CONTROL_PLANE_KINDS,
  TRUSTED_ASSOCIATIONS,
} from "./types.mjs";
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
 * The kind a `config/repos.yaml` entry asks for, or null when it asks for
 * nothing (WM-1007).
 *
 * An unknown name throws. The tempting alternative — falling back to the
 * policy default — is exactly wrong: a typo'd or stale repo name would
 * quietly run that repo's tickets against another workspace's tracker, and
 * the symptom would be "no tickets", which reads as an empty queue rather
 * than as a mistake. Same reasoning as the unknown-kind throw below.
 *
 * @param {string} repoName  entry name in repos.yaml (e.g. "factory")
 * @param {string} root
 * @returns {"linear"|"memory"|"github"|null}
 */
export function controlPlaneKindFromRepo(repoName, root = DEFAULT_ROOT) {
  const repos = loadRepos({ root });
  const entry = repos.get(repoName);
  if (!entry) {
    throw new Error(
      `unknown repo ${JSON.stringify(repoName)} in ${path.join(root, "config", "repos.yaml")} — known: ${[...repos.keys()].join(", ") || "(none)"}`,
    );
  }
  return entry.controlPlane ?? null;
}

/**
 * @param {{
 *   root?: string,
 *   kind?: "linear"|"memory"|"github",
 *   repoName?: string,  // config/repos.yaml entry whose control_plane decides
 *                       // the kind. Distinct from `repo` below, which is the
 *                       // github adapter's owner/name slug — different things,
 *                       // so deliberately not the same option.
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
  repoName,
  gql,
  seed,
  api,
  exec,
  repo,
  teams,
  project,
  statusField,
} = {}) {
  // Precedence, most specific first. Each level is skipped only when it has
  // nothing to say (undefined / null), so a repo that sets `control_plane`
  // outranks policy, and a repo that omits it inherits rather than defaults.
  // With no repoName this is byte-identical to the pre-WM-1007 behaviour, and
  // the repo registry is never read.
  const selected =
    kind ??
    (repoName != null ? controlPlaneKindFromRepo(repoName, root) : null) ??
    controlPlaneKindFromPolicy(root);
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
