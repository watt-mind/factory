/**
 * Blocked-by relation gating.
 *
 * Owned Paths answers "can these two tickets run *simultaneously*" — a spatial
 * check on the files each may modify. It says nothing about *order*: when
 * ticket B consumes a helper that ticket A is still building, their path sets
 * are disjoint, both dispatch in the same tick, and B's agent implements
 * against code that does not exist on its base branch. The concurrency cap in
 * config/policy.yaml makes that less likely; it does not make it impossible.
 *
 * Linear already models the missing fact as a `blocks` relation. This module
 * reads it. A ticket with an unresolved blocker never enters the ready set —
 * ordering then falls out of rolling dispatch on its own, with no topological
 * planner (a planner would reintroduce the stale-snapshot problem `selectable()`
 * exists to avoid). The check is live: the blocker's *current* state is fetched
 * with the queue on every selection round, so a blocker reaching Done or
 * Canceled releases its dependents on the next pass with no sweep.
 *
 * The failure mode this introduces — a wrong or forgotten relation quietly
 * starving a ticket that holds no slot and raises no error — is why queue.mjs
 * reports held tickets as their own line instead of folding them into READY.
 *
 * Deliberately dependency-free, same as owned-paths.mjs: runs from launchd
 * with the system runtime and must not require an install step.
 */

/**
 * GraphQL selection both consumers splice into their issue queries.
 *
 * For issue X, `inverseRelations` are the relations where X is the
 * `relatedIssue`; on a node of type `"blocks"` the blocker is `node.issue`.
 * (`relations` would give what X blocks — the wrong direction.) State `type`
 * rather than name: workflow state names are per-team configuration, the types
 * (`completed`, `canceled`, ...) are Linear's own enum.
 */
export const BLOCKING_RELATIONS_GQL =
  "inverseRelations(first: 250) { nodes { type issue { identifier state { type } } } }";

/**
 * Identifiers of the issues that block `issue` and are not finished.
 * Empty array means dispatchable (no relations fetched counts as unblocked —
 * callers that never asked for relations keep today's behaviour).
 * `duplicate`/`related` relation types are ignored; only `blocks` gates.
 */
export function openBlockers(issue) {
  // WM-1008: the control-plane adapter resolves this and hands back a plain
  // `blockedBy` array, so prefer it. The raw-relations path below stays for
  // callers still reading Linear GraphQL directly; it is the fallback, not
  // the contract.
  if (Array.isArray(issue?.blockedBy)) return [...issue.blockedBy];
  return (issue?.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === "blocks")
    .map((r) => r.issue)
    .filter((b) => b && !["completed", "canceled"].includes(b.state?.type))
    .map((b) => b.identifier);
}
