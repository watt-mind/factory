/**
 * Machine-local operational overlay (WM-887).
 *
 * Git remains the declared fleet default (`event-types.json` adapter,
 * `agents/*.json` model_tier / model). This module stores a last-wins patch
 * in runtime.db and the planner applies it at plan time. Packs cannot shadow
 * built-ins (WM-470); this is not a pack.
 */
import { builtinAdapters } from "./adapters/index.mjs";
import { txImmediate } from "./db.mjs";

export const KIND_EVENT_TYPE = "eventType";
export const KIND_AGENT = "agent";
export const MODEL_TIERS = new Set(["strong", "standard", "light"]);

export class OverlayError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "OverlayError";
    this.status = status;
  }
}

export function emptyOverrides() {
  return { eventTypes: {}, agents: {} };
}

/** Adapters the overlay may name: builtins plus any currently routed. */
export function knownAdapters(registry) {
  const names = new Set(Object.keys(builtinAdapters()));
  for (const mapping of Object.values(registry?.eventTypes ?? {})) {
    if (typeof mapping?.adapter === "string" && mapping.adapter !== "") {
      names.add(mapping.adapter);
    }
  }
  return names;
}

export function listOverrides(db) {
  const rows = db
    .query(
      `SELECT kind, key, patch_json, updated_at, updated_by FROM runtime_overrides ORDER BY kind, key`,
    )
    .all();
  const out = emptyOverrides();
  for (const row of rows) {
    const patch = JSON.parse(row.patch_json);
    if (row.kind === KIND_EVENT_TYPE) out.eventTypes[row.key] = patch;
    else if (row.kind === KIND_AGENT) out.agents[row.key] = patch;
  }
  return out;
}

export function listOverrideJournal(db, { limit = 100 } = {}) {
  return db
    .query(
      `SELECT seq, kind, key, before_json, after_json, actor, at
         FROM runtime_override_journal
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      seq: row.seq,
      kind: row.kind,
      key: row.key,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null,
      actor: row.actor,
      at: row.at,
    }));
}

function readRow(db, kind, key) {
  const row = db
    .query(
      `SELECT patch_json, updated_at, updated_by FROM runtime_overrides WHERE kind = ? AND key = ?`,
    )
    .get(kind, key);
  if (!row) return null;
  return {
    patch: JSON.parse(row.patch_json),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function writeJournal(db, { kind, key, before, after, actor, at }) {
  db.query(
    `INSERT INTO runtime_override_journal (kind, key, before_json, after_json, actor, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    kind,
    key,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    actor,
    at,
  );
}

function isoNow(now) {
  return new Date(now ?? Date.now()).toISOString();
}

export function putOverride(
  db,
  { kind, key, patch, actor = "operator", now = Date.now() },
) {
  const at = isoNow(now);
  return txImmediate(db, () => {
    const prev = readRow(db, kind, key);
    const before = prev?.patch ?? null;
    db.query(
      `INSERT INTO runtime_overrides (kind, key, patch_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, key) DO UPDATE SET
         patch_json = excluded.patch_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).run(kind, key, JSON.stringify(patch), at, actor);
    writeJournal(db, { kind, key, before, after: patch, actor, at });
    return { kind, key, patch, updatedAt: at, updatedBy: actor };
  });
}

export function deleteOverride(
  db,
  { kind, key, actor = "operator", now = Date.now() },
) {
  const at = isoNow(now);
  return txImmediate(db, () => {
    const prev = readRow(db, kind, key);
    if (!prev) return { deleted: false };
    db.query(`DELETE FROM runtime_overrides WHERE kind = ? AND key = ?`).run(
      kind,
      key,
    );
    writeJournal(db, {
      kind,
      key,
      before: prev.patch,
      after: null,
      actor,
      at,
    });
    return { deleted: true };
  });
}

export function validateEventTypePatch(registry, type, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new OverlayError(422, "body must be an object");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((k) => k !== "adapter")) {
    throw new OverlayError(422, "event-type overlay accepts only adapter");
  }
  if (typeof patch.adapter !== "string" || patch.adapter.trim() === "") {
    throw new OverlayError(422, "adapter must be a non-empty string");
  }
  const mapping = registry.eventTypes?.[type];
  if (!mapping) {
    throw new OverlayError(422, `unknown event type ${JSON.stringify(type)}`);
  }
  if (mapping.observe === true) {
    throw new OverlayError(
      422,
      `event type ${JSON.stringify(type)} is observe-only and has no adapter`,
    );
  }
  if (!knownAdapters(registry).has(patch.adapter)) {
    throw new OverlayError(
      422,
      `unknown adapter ${JSON.stringify(patch.adapter)}`,
    );
  }
  return { adapter: patch.adapter };
}

export function validateAgentPatch(registry, ref, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new OverlayError(422, "body must be an object");
  }
  const allowed = new Set(["modelTier", "model"]);
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new OverlayError(422, "agent overlay requires modelTier or model");
  }
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new OverlayError(422, `unexpected field ${JSON.stringify(key)}`);
    }
  }
  if (!registry.agents?.has(ref)) {
    throw new OverlayError(422, `unknown agent ${JSON.stringify(ref)}`);
  }
  const out = {};
  if (Object.hasOwn(patch, "modelTier")) {
    if (patch.modelTier !== null && !MODEL_TIERS.has(patch.modelTier)) {
      throw new OverlayError(
        422,
        `modelTier must be strong, standard, light, or null`,
      );
    }
    out.modelTier = patch.modelTier;
  }
  if (Object.hasOwn(patch, "model")) {
    if (patch.model !== null && typeof patch.model !== "string") {
      throw new OverlayError(422, "model must be a string or null");
    }
    if (typeof patch.model === "string" && patch.model.trim() === "") {
      throw new OverlayError(422, "model must be a non-empty string or null");
    }
    out.model = patch.model;
  }
  return out;
}

/**
 * Merge a new agent patch onto whatever is already stored for that ref so
 * tier and exact pin can be saved independently.
 */
export function mergeAgentPatch(existing, incoming) {
  const next = { ...(existing ?? {}) };
  if (Object.hasOwn(incoming, "modelTier")) {
    if (incoming.modelTier === null) delete next.modelTier;
    else next.modelTier = incoming.modelTier;
  }
  if (Object.hasOwn(incoming, "model")) {
    if (incoming.model === null) next.model = null;
    else next.model = incoming.model;
  }
  if (Object.keys(next).length === 0) return null;
  return next;
}

/** Def the planner / GET /agents should resolve models against. */
export function plannedDef(def, { modelTierOverride, modelOverride } = {}) {
  const planned = { ...def };
  if (modelTierOverride !== undefined) {
    if (modelTierOverride === null) delete planned.model_tier;
    else planned.model_tier = modelTierOverride;
  }
  if (modelOverride !== undefined) {
    if (modelOverride === null) delete planned.model;
    else planned.model = modelOverride;
  }
  return planned;
}

export function overlayForEventType(overrides, type) {
  return overrides?.eventTypes?.[type] ?? null;
}

export function overlayForAgent(overrides, ref) {
  return overrides?.agents?.[ref] ?? null;
}

export function effectiveAdapter(mapping, overrides, type) {
  return overlayForEventType(overrides, type)?.adapter ?? mapping.adapter;
}
