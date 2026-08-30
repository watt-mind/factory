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
import { tx } from "./db.mjs";

export const CHAIN_SOURCE = "chain";

/**
 * How many passes a run may fail *transiently* (SQLITE_BUSY, disk I/O, an
 * unexpected throw) before the resolver stops retrying it and records
 * `chain_gave_up`. Deterministic failures never consume a pass: they resolve
 * on first sight. Overridable per call via `maxTransientPasses`.
 */
export const CHAIN_MAX_TRANSIENT_PASSES = 5;

/** `attempt_trace` markers (kind `lifecycle`) the resolver writes per run. */
export const CHAIN_RESOLVED_NOTE = "chain_resolved";
export const CHAIN_TRANSIENT_NOTE = "chain_transient_error";

/**
 * A failure that is a pure function of the persisted run/result/edges and
 * would therefore recur identically on every later tick. Only these resolve
 * the chain step on sight; anything else is treated as transient.
 */
export class ChainTerminalError extends Error {
  constructor(message, reason = "invalid_chain_data") {
    super(message);
    this.name = "ChainTerminalError";
    this.reason = reason;
  }
}

function isTerminalError(err) {
  return err instanceof ChainTerminalError || err instanceof SyntaxError;
}

/**
 * The only chain-provenance admission path. The source is assigned here after
 * the resolver has derived the edge; no envelope supplied by a caller can
 * select it through the public API.
 */
export function admitChainEvent(db, registry, envelope, options = {}) {
  return admitEvent(
    db,
    registry,
    { ...envelope, source: CHAIN_SOURCE },
    options,
  );
}

/** Resolve a "$.input.x" / "$.artifact.x.y" path against the chain context. */
function resolvePath(expr, context) {
  if (typeof expr !== "string" || !expr.startsWith("$.")) return expr; // literal
  const [root, ...segments] = expr.slice(2).split(".");
  if (!(root in context))
    throw new ChainTerminalError(
      `chain input path "${expr}": unknown root "${root}"`,
    );
  let value = context[root];
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || !(segment in value)) {
      throw new ChainTerminalError(
        `chain input path "${expr}" resolves to nothing`,
      );
    }
    value = value[segment];
  }
  if (value === undefined)
    throw new ChainTerminalError(
      `chain input path "${expr}" resolves to nothing`,
    );
  return value;
}

export function buildChainInput(mapping, context) {
  const input = {};
  for (const [field, expr] of Object.entries(mapping)) {
    input[field] = Array.isArray(expr)
      ? expr.map((item) => resolvePath(item, context))
      : resolvePath(expr, context);
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

/** Completed edge-agent runs that have not reached a durable chain terminal. */
function chainCandidates(db, edges) {
  const agents = Object.keys(edges);
  if (agents.length === 0) return [];
  const placeholders = agents.map(() => "?").join(", ");
  return db
    .query(
      `SELECT r.run_id, r.attempts, r.spec_json, res.result_json,
              e.correlation_id, e.event_id AS origin_event_id, e.source AS origin_source
       FROM runs r
       JOIN results res ON res.run_id = r.run_id AND res.attempt = r.attempts
       JOIN proposals p ON p.run_id = r.run_id AND p.decision = 'run'
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE r.state = 'COMPLETED'
         AND r.chain_resolved_at IS NULL
         AND json_extract(r.spec_json, '$.agent') IN (${placeholders})`,
    )
    .all(...agents);
}

/**
 * Fetch every existing child for this tick's unresolved edge-agent population
 * in one indexed statement. Keeping this outside the candidate loop is the
 * important bound: historical fan-out is one events lookup, not one per run.
 */
function existingChainEvents(db, edges) {
  const agents = Object.keys(edges);
  if (agents.length === 0) return new Map();
  const placeholders = agents.map(() => "?").join(", ");
  const byRun = new Map();
  const rows = db
    .query(
      `SELECT child.causation_id, child.event_id
         FROM runs r
         JOIN events child
           ON child.causation_id = r.run_id AND child.source = ?
        WHERE r.state = 'COMPLETED'
          AND r.chain_resolved_at IS NULL
          AND json_extract(r.spec_json, '$.agent') IN (${placeholders})`,
    )
    .all(CHAIN_SOURCE, ...agents);
  for (const row of rows) {
    const ids = byRun.get(row.causation_id) ?? new Set();
    ids.add(row.event_id);
    byRun.set(row.causation_id, ids);
  }
  return byRun;
}

/**
 * One deterministic pass: emit chain events for eligible completed runs.
 * Supports legacy recommendation routing, multi-emit fan-out, and opt-in
 * independent edges selected by non-empty artifact arrays (OPS-223, WM-119,
 * WM-430). Idempotent — derived event IDs dedup at intake, fully emitted sets
 * are zero-ops, and partially emitted sets resume with only missing siblings.
 *
 * Failure classification (#1458): a run's chain step is marked resolved only
 * for *deterministic* outcomes — invalid chain data (`ChainTerminalError`,
 * malformed spec/result JSON), intake refusals, and foreign-causation
 * duplicates — because re-attempting those on every tick would only repeat
 * the same report. Anything else (SQLITE_BUSY, disk I/O, an unexpected
 * throw) leaves `chain_resolved_at` NULL so the run is retried on a later
 * pass, with only the siblings that are still missing re-admitted; after
 * `maxTransientPasses` such passes the run resolves with `chain_gave_up`.
 * Every resolution writes an `attempt_trace` marker
 * `{ note: "chain_resolved", reason, ... }` so an operator can see why no
 * child event fired.
 *
 * @returns {{ emitted: number, skipped: number, errors: string[] }}
 */
export function resolveChains(
  db,
  registry,
  { now = Date.now(), maxTransientPasses = CHAIN_MAX_TRANSIENT_PASSES } = {},
) {
  const edges = registry.edges ?? {};
  const outcome = { emitted: 0, skipped: 0, errors: [] };
  const candidates = chainCandidates(db, edges);
  if (candidates.length === 0) return outcome;
  const existingByRun = existingChainEvents(db, edges);
  /** @type {Array<{ row: object, reason: string, detail?: object }>} */
  const resolved = [];
  /** @type {Array<{ row: object, error: string }>} */
  const transient = [];
  const resolvedAt = new Date(now).toISOString();

  for (const row of candidates) {
    try {
      const spec = JSON.parse(row.spec_json);
      const result = JSON.parse(row.result_json);
      const rule = edges[spec.agent];
      const recommendation = result.artifact?.[rule.recommendationField];
      const artifact = result.artifact ?? {};
      const selectionContext = { input: spec.input, artifact };
      const selectedEdges = rule.independent
        ? Object.entries(rule.edges).filter(([, candidate]) => {
            const items = resolveItems(
              candidate.whenItemsField,
              selectionContext,
            );
            if (items == null) return false;
            if (!Array.isArray(items)) {
              throw new ChainTerminalError(
                `independent chain selector "${candidate.whenItemsField}" is not an array`,
              );
            }
            return items.length > 0;
          })
        : (() => {
            const primary = rule.edges[recommendation];
            if (primary === undefined) return [];
            const additionalKeys = primary.also ?? [];
            if (
              !Array.isArray(additionalKeys) ||
              additionalKeys.some((key) => typeof key !== "string")
            ) {
              throw new ChainTerminalError(
                `chain edge "${recommendation}" also must be an array of edge keys`,
              );
            }
            return [recommendation, ...additionalKeys]
              .map((key) => {
                const candidate = rule.edges[key];
                if (candidate === undefined) {
                  throw new ChainTerminalError(
                    `chain edge "${recommendation}" references unknown sibling "${key}"`,
                  );
                }
                return [key, candidate];
              })
              .filter(([, candidate]) => {
                if (candidate.whenPath === undefined) return true;
                try {
                  return (
                    resolvePath(candidate.whenPath, selectionContext) !== null
                  );
                } catch {
                  return false;
                }
              });
          })();
      if (selectedEdges.length === 0) {
        // An unmapped value or an independent result with no actionable items
        // is a legitimate terminal — record nothing, chain nothing, and do
        // not re-parse the same accepted result on every later tick.
        outcome.skipped += 1;
        resolved.push({ row, reason: "no_edge_selected" });
        continue;
      }

      // A chain may pass an artifact by content hash — `$.artifactHash.<kind>`
      // resolves against the accepted result's stored artifacts (OPS-372).
      const artifactHash = {};
      for (const entry of result.artifacts ?? []) {
        if (
          entry.kind &&
          entry.sha256 &&
          artifactHash[entry.kind] === undefined
        ) {
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
            if (typeof item === "object" && item !== null)
              return itemKey ? item[itemKey] : undefined;
            if (typeof item === "string" || typeof item === "number")
              return String(item);
            return undefined;
          });
          const duplicateFallback =
            new Set(fallbackIds.map(String)).size !== fallbackIds.length;

          for (const [index, item] of items.entries()) {
            const itemKeyVal = fallbackIds[index];
            if (
              itemKeyVal === undefined ||
              itemKeyVal === null ||
              String(itemKeyVal).trim() === ""
            ) {
              throw new ChainTerminalError(
                `multi-emit chain item missing key "${itemKey}"`,
              );
            }
            const itemContext = {
              input: spec.input,
              artifact,
              artifactHash,
              item,
            };
            const payload = buildChainInput(edge.input ?? {}, itemContext);
            if (itemKey && payload[itemKey] === undefined)
              payload[itemKey] = itemKeyVal;
            if (edge.perItem)
              Object.assign(
                payload,
                buildChainInput(edge.perItem, itemContext),
              );

            envelopes.push({
              schemaVersion: "factory.event/v1",
              eventId: chainEventId(
                edge,
                row,
                itemContext,
                `chain-${row.run_id}-${itemKeyVal}`,
                {
                  mixed: mixed || duplicateFallback,
                },
              ),
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
            eventId: chainEventId(
              edge,
              row,
              eventContext,
              `chain-${row.run_id}`,
              { mixed },
            ),
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
        throw new ChainTerminalError(
          `chain event IDs are not unique: ${ids.join(", ")}`,
        );
      }

      // A prior process may have stopped after admitting only part of a mixed
      // set. Reconstruct the full set and admit only the missing siblings. An
      // event from an older routing configuration is a durable completion
      // marker, not permission to backfill stale actions under today's edges.
      const existingIds = existingByRun.get(row.run_id) ?? new Set();
      if ([...existingIds].some((eventId) => !ids.includes(eventId))) {
        resolved.push({
          row,
          reason: "stale_children",
          detail: { existing: [...existingIds], expected: ids },
        });
        continue;
      }
      const pending = envelopes.filter(
        (envelope) => !existingIds.has(envelope.eventId),
      );
      // Admit each missing sibling independently: a deterministic refusal
      // resolves the run, but a transient throw on one sibling must neither
      // resolve the run nor abandon the siblings that are still pending —
      // the next pass re-admits exactly the ones that did not land.
      const terminalErrors = [];
      const transientErrors = [];
      for (const envelope of pending) {
        let admitted;
        try {
          admitted = admitChainEvent(db, registry, envelope, { now });
        } catch (err) {
          if (isTerminalError(err)) throw err;
          transientErrors.push(`${envelope.eventId}: ${err.message}`);
          continue;
        }
        if (admitted.admitted) {
          outcome.emitted += 1;
          existingIds.add(envelope.eventId);
        } else if (admitted.duplicate) {
          if (admitted.event?.causation_id === row.run_id) {
            outcome.skipped += 1;
            existingIds.add(envelope.eventId);
          } else {
            terminalErrors.push(
              `${envelope.eventId}: duplicate chain event belongs to ${admitted.event?.causation_id ?? "an unknown run"}`,
            );
          }
        } else {
          terminalErrors.push(
            `${envelope.eventId}: ${admitted.errors.join("; ")}`,
          );
        }
      }
      outcome.errors.push(...terminalErrors, ...transientErrors);
      if (terminalErrors.length > 0) {
        resolved.push({
          row,
          reason: "intake_refused",
          detail: { errors: terminalErrors },
        });
      } else if (transientErrors.length > 0) {
        transient.push({ row, error: transientErrors.join("; ") });
      } else if (
        envelopes.every((envelope) => existingIds.has(envelope.eventId))
      ) {
        resolved.push({ row, reason: "emitted", detail: { events: ids } });
      }
    } catch (err) {
      outcome.errors.push(`chain-${row.run_id}: ${err.message}`);
      if (isTerminalError(err)) {
        resolved.push({
          row,
          reason: err.reason ?? "invalid_chain_data",
          detail: { error: err.message },
        });
      } else {
        transient.push({ row, error: err.message });
      }
    }
  }

  if (resolved.length === 0 && transient.length === 0) return outcome;
  const markResolved = db.query(
    `UPDATE runs
        SET chain_resolved_at = ?
      WHERE run_id = ? AND chain_resolved_at IS NULL`,
  );
  const insertMarker = db.query(
    `INSERT INTO attempt_trace (run_id, attempt, ts, kind, payload_json)
     VALUES (?, ?, ?, 'lifecycle', ?)`,
  );
  const countTransient = db.query(
    `SELECT COUNT(*) AS n FROM attempt_trace
      WHERE run_id = ? AND kind = 'lifecycle'
        AND json_extract(payload_json, '$.note') = ?`,
  );
  const record = (row, note, payload) =>
    insertMarker.run(
      row.run_id,
      row.attempts,
      resolvedAt,
      JSON.stringify({ note, ...payload }),
    );
  tx(db, () => {
    for (const { row, error } of transient) {
      const passes = countTransient.get(row.run_id, CHAIN_TRANSIENT_NOTE).n + 1;
      record(row, CHAIN_TRANSIENT_NOTE, { pass: passes, error });
      if (passes >= maxTransientPasses) {
        outcome.errors.push(
          `chain-${row.run_id}: gave up after ${passes} transient failure(s)`,
        );
        resolved.push({
          row,
          reason: "chain_gave_up",
          detail: { passes, error },
        });
      }
    }
    for (const { row, reason, detail } of resolved) {
      markResolved.run(resolvedAt, row.run_id);
      record(row, CHAIN_RESOLVED_NOTE, { reason, ...detail });
    }
  });
  return outcome;
}

/**
 * The persisted `{ note: "chain_resolved", reason, ... }` marker for a run,
 * or null while the chain step is still open. Operator-facing: answers "why
 * did no child event fire for this run".
 */
export function chainResolution(db, runId) {
  const row = db
    .query(
      `SELECT payload_json FROM attempt_trace
        WHERE run_id = ? AND kind = 'lifecycle'
          AND json_extract(payload_json, '$.note') = ?
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(runId, CHAIN_RESOLVED_NOTE);
  return row ? JSON.parse(row.payload_json) : null;
}
