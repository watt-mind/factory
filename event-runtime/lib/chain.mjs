/**
 * Discovered chains (docs/event-runtime-workers.md §5; OPS-223).
 *
 * Agents never spawn agents. When a run completes, its accepted artifact may
 * carry a typed recommendation; a registered edge (edges.json) maps that
 * value to a follow-up event type and an input built from declared paths.
 * The chain emits an **internal event through the same intake as a webhook**
 * — same dedup, same planner, same watched approval — with:
 *
 *   eventId       chain-<runId>            (one chain event per run, ever)
 *   correlationId inherited from the originating event
 *   causationId   the source runId
 *
 * Everything here is code: an unregistered recommendation value simply does
 * not chain, and a hallucinated one costs a rejected proposal, not a run.
 * Per-edge earned automation layers on later; today every chain proposal is
 * watched like any other.
 */
import { admitEvent } from "./intake.mjs";

export const CHAIN_SOURCE = "chain";

/** Resolve a "$.input.x" / "$.artifact.x.y" path against the chain context. */
function resolvePath(expr, context) {
  if (typeof expr !== "string" || !expr.startsWith("$.")) return expr; // literal
  const [root, ...segments] = expr.slice(2).split(".");
  if (!(root in context)) throw new Error(`chain input path "${expr}": unknown root "${root}"`);
  let value = context[root];
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || !(segment in value)) {
      throw new Error(`chain input path "${expr}" resolves to nothing`);
    }
    value = value[segment];
  }
  if (value === undefined) throw new Error(`chain input path "${expr}" resolves to nothing`);
  return value;
}

export function buildChainInput(mapping, context) {
  const input = {};
  for (const [field, expr] of Object.entries(mapping)) {
    input[field] = resolvePath(expr, context);
  }
  return input;
}

/** Completed runs whose agent has registered edges and no chain event yet. */
function chainCandidates(db, edges) {
  const agents = Object.keys(edges);
  if (agents.length === 0) return [];
  const placeholders = agents.map(() => "?").join(", ");
  return db
    .query(
      `SELECT r.run_id, r.spec_json, res.result_json,
              e.correlation_id, e.event_id AS origin_event_id, e.source AS origin_source
       FROM runs r
       JOIN results res ON res.run_id = r.run_id AND res.attempt = r.attempts
       JOIN proposals p ON p.run_id = r.run_id AND p.decision = 'run'
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE r.state = 'COMPLETED'
         AND json_extract(r.spec_json, '$.agent') IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM events ce
           WHERE ce.source = '${CHAIN_SOURCE}' AND ce.event_id = 'chain-' || r.run_id
         )`,
    )
    .all(...agents);
}

/**
 * One deterministic pass: emit the chain event for every eligible completed
 * run. Idempotent — the derived eventId dedups at intake, and candidates
 * with an existing chain event are excluded up front.
 *
 * @returns {{ emitted: number, skipped: number, errors: string[] }}
 */
export function resolveChains(db, registry, { now = Date.now() } = {}) {
  const edges = registry.edges ?? {};
  const outcome = { emitted: 0, skipped: 0, errors: [] };

  for (const row of chainCandidates(db, edges)) {
    const spec = JSON.parse(row.spec_json);
    const result = JSON.parse(row.result_json);
    const rule = edges[spec.agent];
    try {
      const recommendation = result.artifact?.[rule.recommendationField];
      const edge = rule.edges[recommendation];
      if (edge === undefined) {
        // An unmapped value is a legitimate terminal — record nothing, chain nothing.
        outcome.skipped += 1;
        continue;
      }
      // A chain may pass an artifact by content hash — `$.artifactHash.<kind>`
      // resolves against the accepted result's stored artifacts (OPS-372).
      // Values, not bytes, travel through events; the downstream workspace
      // materializes the bytes from the store.
      const artifactHash = {};
      for (const entry of result.artifacts ?? []) {
        if (entry.kind && entry.sha256 && artifactHash[entry.kind] === undefined) {
          artifactHash[entry.kind] = entry.sha256;
        }
      }
      const envelope = {
        schemaVersion: "factory.event/v1",
        eventId: `chain-${row.run_id}`,
        type: edge.eventType,
        source: CHAIN_SOURCE,
        subject: spec.agent,
        occurredAt: new Date(now).toISOString(),
        correlationId: row.correlation_id ?? row.origin_event_id,
        causationId: row.run_id,
        payload: buildChainInput(edge.input, {
          input: spec.input,
          artifact: result.artifact ?? {},
          artifactHash,
        }),
      };
      const admitted = admitEvent(db, registry, envelope, { now });
      if (admitted.admitted) outcome.emitted += 1;
      else if (admitted.duplicate) outcome.skipped += 1;
      else outcome.errors.push(`chain-${row.run_id}: ${admitted.errors.join("; ")}`);
    } catch (err) {
      outcome.errors.push(`chain-${row.run_id}: ${err.message}`);
    }
  }
  return outcome;
}
