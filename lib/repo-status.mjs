/** Helpers for the read-only `factory status` command. */

export const DEFAULT_REVISION_FIELDS = [
  "revision",
  "commit",
  "git_sha",
  "gitSha",
  "sha",
];

/** Resolve status branches using the same defaults as the repository loader. */
export function resolveStatusBranches(repoConfig = {}) {
  const baseBranch = repoConfig.base ?? "main";
  const deployBranch = repoConfig.deploy_branch ?? null;
  const metadataBranch =
    repoConfig.deployment?.branch ?? deployBranch ?? baseBranch;
  return { baseBranch, deployBranch, metadataBranch };
}

export function deployedRevision(payload, configuredField) {
  if (!payload || typeof payload !== "object") return null;
  const fields = configuredField
    ? [configuredField, ...DEFAULT_REVISION_FIELDS]
    : DEFAULT_REVISION_FIELDS;
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim())
      return { field, value: value.trim() };
  }
  return null;
}

/** A configured deployment URL may be either the full metadata endpoint or an origin. */
export function metadataUrl(url) {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.pathname === "/" || parsed.pathname === "")
    parsed.pathname = "/version.json";
  return parsed.toString();
}

export function deploymentState({ deployed, remoteSha, localContains = null }) {
  if (!deployed)
    return { state: "unknown", message: "endpoint did not expose a revision" };
  if (!remoteSha)
    return { state: "unknown", message: "could not read the remote branch" };
  if (deployed === remoteSha)
    return { state: "current", message: "matches the remote branch tip" };
  if (localContains === true)
    return { state: "stale", message: "is behind the remote branch tip" };
  if (localContains === false)
    return {
      state: "diverged",
      message: "does not occur in the local remote-branch history",
    };
  return { state: "different", message: "differs from the remote branch tip" };
}

export function formatAge(ms, now = Date.now()) {
  if (ms == null) return "never recorded";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
