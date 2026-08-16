/**
 * Discovered chains (docs/event-runtime-workers.md §5; OPS-223).
 *
 * Agents never spawn agents. When a run completes, its accepted artifact may
 * carry a typed recommendation; a registered edge (edges.json) maps that
 * value to a follow-up event type and an input built from declared paths.
 * The chain emits an **internal event through the same intake as a webhook**
 * — same dedup, same planner, same watched approval — with:
 *
 *   eventId       chain-<runId>[-<action/item>]
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

/**
 * The only chain-provenance admission path. The source is assigned here after
 * the resolver has derived the edge; no envelope supplied by a caller can
 * select it through the public API.
 */
export function admitChainEvent(db, registry, envelope, options = {}) {
  return admitEvent(db, registry, { ...envelope, source: CHAIN_SOURCE }, options);
}

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

function resolveItems(itemsField, context) {
  if (typeof itemsField === "string" && itemsField.startsWith("$.")) {
    return resolvePath(itemsField, context);
  }
  return context.artifact?.[itemsField] ?? context.input?.[itemsField];
}

function chainEventId(edge, row, context, fallback, { mixed = false } = {}) {
  const template = mixed ? edge.mixedEventId : edge.eventId;
  if (typeof template !== "string") return fallback;
  return template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    if (expr === "runId") return row.run_id;
    if (expr.startsWith("item.")) return context.item?.[expr.slice(5)] ?? "";
    return String(resolvePath(`$.${expr}`, context) ?? "");
  });
}

/** Completed runs whose agent has registered edges and no derived chain event yet. */
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
         AND json_extract(r.spec_json, '$.agent') IN (${placeholders})`,
    )
    .all(...agents);
}

/**
 * One deterministic pass: emit chain events for eligible completed runs.
 * Supports legacy recommendation routing, multi-emit fan-out, and opt-in
 * independent edges selected by non-empty artifact arrays (OPS-223, WM-119,
 * WM-430). Idempotent — derived event IDs dedup at intake, fully emitted sets
 * are zero-ops, and partially emitted sets resume with only missing siblings.
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
      const artifact = result.artifact ?? {};
      const selectionContext = { input: spec.input, artifact };
      const selectedEdges = rule.independent
        ? Object.entries(rule.edges).filter(([, candidate]) => {
            const items = resolveItems(candidate.whenItemsField, selectionContext);
            if (!Array.isArray(items)) {
              throw new Error(`independent chain selector "${candidate.whenItemsField}" is not an array`);
            }
            return items.length > 0;
          })
        : [[recommendation, rule.edges[recommendation]]].filter(([, candidate]) => candidate !== undefined);
      if (selectedEdges.length === 0) {
        // An unmapped value or an independent result with no actionable items
        // is a legitimate terminal — record nothing, chain nothing.
        outcome.skipped += 1;
        continue;
      }

      // A chain may pass an artifact by content hash — `$.artifactHash.<kind>`
      // resolves against the accepted result's stored artifacts (OPS-372).
      const artifactHash = {};
      for (const entry of result.artifacts ?? []) {
        if (entry.kind && entry.sha256 && artifactHash[entry.kind] === undefined) {
          artifactHash[entry.kind] = entry.sha256;
        }
      }

      // Build and validate the complete deterministic emission set before any
      // admission. Independent edges use distinct IDs only for a genuinely
      // mixed result; a sole selected edge preserves the legacy envelope ID.
      const envelopes = [];
      const mixed = selectedEdges.length > 1;
      for (const [, edge] of selectedEdges) {
        const itemsField = edge.itemsField ?? rule.itemsField;
        const itemKey = edge.itemKey ?? rule.itemKey;

        if (itemsField !== undefined) {
          const items = resolveItems(itemsField, {
            input: spec.input,
            artifact,
            artifactHash,
          });
          if (!Array.isArray(items) || items.length === 0) {
            outcome.skipped += 1;
            continue;
          }

          const fallbackIds = items.map((item) => {
            if (typeof item === "object" && item !== null) return itemKey ? item[itemKey] : undefined;
            if (typeof item === "string" || typeof item === "number") return String(item);
            return undefined;
          });
          const duplicateFallback = new Set(fallbackIds.map(String)).size !== fallbackIds.length;

          for (const [index, item] of items.entries()) {
            const itemKeyVal = fallbackIds[index];
            if (itemKeyVal === undefined || itemKeyVal === null || String(itemKeyVal).trim() === "") {
              throw new Error(`multi-emit chain item missing key "${itemKey}"`);
            }
            const itemContext = {
              input: spec.input,
              artifact,
              artifactHash,
              item,
            };
            const payload = buildChainInput(edge.input ?? {}, itemContext);
            if (itemKey && payload[itemKey] === undefined) payload[itemKey] = itemKeyVal;
            if (edge.perItem) Object.assign(payload, buildChainInput(edge.perItem, itemContext));

            envelopes.push({
              schemaVersion: "factory.event/v1",
              eventId: chainEventId(edge, row, itemContext, `chain-${row.run_id}-${itemKeyVal}`, {
                mixed: mixed || duplicateFallback,
              }),
              type: edge.eventType,
              source: CHAIN_SOURCE,
              subject: spec.agent,
              occurredAt: new Date(now).toISOString(),
              correlationId: row.correlation_id ?? row.origin_event_id,
              causationId: row.run_id,
              payload,
            });
          }
        } else {
          const eventContext = {
            input: spec.input,
            artifact,
            artifactHash,
          };
          envelopes.push({
            schemaVersion: "factory.event/v1",
            eventId: chainEventId(edge, row, eventContext, `chain-${row.run_id}`, { mixed }),
            type: edge.eventType,
            source: CHAIN_SOURCE,
            subject: spec.agent,
            occurredAt: new Date(now).toISOString(),
            correlationId: row.correlation_id ?? row.origin_event_id,
            causationId: row.run_id,
            payload: buildChainInput(edge.input, eventContext),
          });
        }
      }

      const ids = envelopes.map((envelope) => envelope.eventId);
      if (new Set(ids).size !== ids.length) {
        throw new Error(`chain event IDs are not unique: ${ids.join(", ")}`);
      }

      // A prior process may have stopped after admitting only part of a mixed
      // set. Reconstruct the full set and admit only the missing siblings. An
      // event from an older routing configuration is a durable completion
      // marker, not permission to backfill stale actions under today's edges.
      const existingIds = new Set(
        db
          .query(`SELECT event_id FROM events WHERE source = ? AND causation_id = ?`)
          .all(CHAIN_SOURCE, row.run_id)
          .map((event) => event.event_id),
      );
      if ([...existingIds].some((eventId) => !ids.includes(eventId))) continue;
      const pending = envelopes.filter((envelope) => !existingIds.has(envelope.eventId));
      for (const envelope of pending) {
        const admitted = admitChainEvent(db, registry, envelope, { now });
        if (admitted.admitted) outcome.emitted += 1;
        else if (admitted.duplicate) outcome.skipped += 1;
        else outcome.errors.push(`${envelope.eventId}: ${admitted.errors.join("; ")}`);
      }
    } catch (err) {
      outcome.errors.push(`chain-${row.run_id}: ${err.message}`);
    }
  }
  return outcome;
}
