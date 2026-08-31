/** Read fail-safe runtime policy values without depending on the planner. */
import { existsSync, readFileSync } from "node:fs";

import { resolveConfigPath } from "./config.mjs";
import { reposRoot } from "./repos.mjs";

export function loadRuntimePolicy(root = reposRoot(), snapshot = null) {
  if (snapshot) return snapshot.policy;
  const file = resolveConfigPath("policy", { root });
  if (!existsSync(file)) return null;
  try {
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a `type:security` ticket may enter the dispatch loop (WM-1060).
 * `excluded` is the fail-closed default; `auto` still leaves merge escalation
 * and sensitive-path controls in place.
 */
export const DEFAULT_DISPATCH_SECURITY = "excluded";
export function policyDispatchSecurity(root = reposRoot(), snapshot = null) {
  const value = loadRuntimePolicy(root, snapshot)?.dispatch?.security_tickets;
  return value === "auto" ? "auto" : DEFAULT_DISPATCH_SECURITY;
}
