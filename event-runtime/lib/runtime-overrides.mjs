/**
 * Machine-local operational overlay (WM-887).
 *
 * Git remains the declared fleet default (`event-types.json` adapter,
 * `agents/*.json` model_tier / model). This module stores a last-wins patch
 * in runtime.db and the planner applies it at plan time. Packs cannot shadow
 * built-ins (WM-470); this is not a pack.
 */
import path from "node:path";
import { builtinAdapters } from "./adapters/index.mjs";
import { hashJson } from "./canonical.mjs";
import { txImmediate } from "./db.mjs";
import { agentDefinitionFile } from "./registry.mjs";
import { reposRoot } from "./repos.mjs";

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

/*
 * Overlay promotion (gh-860).
 *
 * Operators run a fast machine-local overlay; promotion is the explicit,
 * reviewable path that turns selected effective overrides into a tracked Git
 * default. It is deliberately fenced:
 *   - `buildPromotionPreview` snapshots the live override rows against the
 *     tracked definitions and returns stable selectable keys plus a digest.
 *   - `applyPromotion` refuses unless the caller echoes that digest and names a
 *     non-empty subset of keys, then drives injected tracker/worktree/git/forge
 *     seams to write the tracked defaults in an ISOLATED checkout and open a PR.
 * Serve never edits, commits, or checks out the live `FACTORY_ROOT`; the only
 * live-root access is the read-only drift check before any worktree exists.
 * First version promotes event-type `adapter` and agent `modelTier`/`model`.
 */

const EVENT_TYPES_FILE = "event-types.json";

/** Repo-relative path of the built-in pack's event-types map. */
function eventTypesFile(registry, root) {
  const pack =
    registry.packs?.find((p) => p.name === "event-runtime") ??
    registry.packs?.[0];
  if (!pack?.root) {
    throw new OverlayError(500, "no pack root to resolve event-types.json");
  }
  const file = path.relative(
    path.resolve(root),
    path.join(pack.root, EVENT_TYPES_FILE),
  );
  if (file.startsWith("..") || path.isAbsolute(file)) {
    throw new OverlayError(
      500,
      "event-types.json is outside the registry root",
    );
  }
  return file;
}

/**
 * Snapshot the current override rows against tracked definitions. Every row is
 * a selectable promotion candidate with a stable key, the tracked `before` and
 * overlay `effective` values, the exact target file, and whether it still
 * diverges (`current`). Only event-type adapter and agent modelTier/model are
 * supported; unsupported overlay shapes and rows whose target is no longer
 * registered are skipped rather than offered.
 *
 * @returns {{ digest: string, selections: Array<{
 *   key: string, kind: "eventType"|"agent", ref: string, field: string,
 *   target: { file: string, path: string }, before: unknown, effective: unknown,
 *   current: boolean }> }}
 */
export function buildPromotionPreview({ db, registry, root = reposRoot() }) {
  const overrides = listOverrides(db);
  const selections = [];
  const etFile = (() => {
    try {
      return eventTypesFile(registry, root);
    } catch {
      return null;
    }
  })();

  for (const [type, patch] of Object.entries(overrides.eventTypes)) {
    if (!patch || typeof patch.adapter !== "string") continue;
    const mapping = registry.eventTypes?.[type];
    if (!mapping || etFile === null) continue;
    const before = mapping.adapter ?? null;
    const effective = patch.adapter;
    selections.push({
      key: `eventType:${type}:adapter`,
      kind: KIND_EVENT_TYPE,
      ref: type,
      field: "adapter",
      target: { file: etFile, path: `["${type}"].adapter` },
      before,
      effective,
      current: effective !== before,
    });
  }

  for (const [ref, patch] of Object.entries(overrides.agents)) {
    const def = registry.agents?.get(ref);
    if (!def || !patch) continue;
    let file;
    try {
      file = agentDefinitionFile(registry, ref, { root }).file;
    } catch {
      continue;
    }
    if (Object.hasOwn(patch, "modelTier")) {
      const before = def.model_tier ?? null;
      const effective = patch.modelTier ?? null;
      selections.push({
        key: `agent:${ref}:modelTier`,
        kind: KIND_AGENT,
        ref,
        field: "modelTier",
        target: { file, path: "model_tier" },
        before,
        effective,
        current: effective !== before,
      });
    }
    if (Object.hasOwn(patch, "model")) {
      const before = def.model ?? null;
      const effective = patch.model ?? null;
      selections.push({
        key: `agent:${ref}:model`,
        kind: KIND_AGENT,
        ref,
        field: "model",
        target: { file, path: "model" },
        before,
        effective,
        current: effective !== before,
      });
    }
  }

  selections.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const digest = hashJson(
    selections.map((s) => ({
      key: s.key,
      before: s.before,
      effective: s.effective,
    })),
  );
  return { digest, selections };
}

/** Serialize a tracked definition object deterministically (2-space, LF). */
function serializeTracked(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Apply one selection's effective value onto a parsed tracked object. */
function writeSelectionValue(obj, selection) {
  const { effective } = selection;
  if (selection.kind === KIND_EVENT_TYPE) {
    const mapping = obj[selection.ref];
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new OverlayError(
        409,
        `target drift: ${selection.ref} is not an object in ${selection.target.file}`,
      );
    }
    mapping.adapter = effective;
    return;
  }
  // agent modelTier -> model_tier ; model -> model. null clears the tracked key.
  const jsonField = selection.field === "modelTier" ? "model_tier" : "model";
  if (effective === null) delete obj[jsonField];
  else obj[jsonField] = effective;
}

/** The tracked value a parsed object currently carries for a selection. */
function readSelectionValue(obj, selection) {
  if (selection.kind === KIND_EVENT_TYPE) {
    const mapping = obj?.[selection.ref];
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new OverlayError(
        409,
        `target drift: ${selection.ref} is not an object in ${selection.target.file}`,
      );
    }
    return mapping.adapter ?? null;
  }
  const jsonField = selection.field === "modelTier" ? "model_tier" : "model";
  return obj?.[jsonField] ?? null;
}

function requireSeam(seams, dotted) {
  let node = seams;
  for (const part of dotted.split(".")) {
    node = node?.[part];
  }
  if (typeof node !== "function") {
    throw new OverlayError(501, `promotion seam ${dotted} is not configured`);
  }
  return node;
}

/**
 * Promote a non-empty subset of preview keys into a PR against the configured
 * base. Fails closed before touching any seam when the preview digest is stale,
 * a key is unknown, a selection no longer diverges, tracked JSON is invalid, or
 * the tracked value drifted from the preview. An empty selection is a typed
 * no-op that touches nothing.
 *
 * All mutation is driven through injected seams so nothing here can reach the
 * live checkout: `tracker.ensure`, `worktree.up` (checkout-only, from the
 * configured base), `readWorktree`/`writeWorktree`, `git.commit`, `git.push`,
 * and `forge.openPr`. There is deliberately no merge or delete seam.
 *
 * @param {object} args
 * @param {import("bun:sqlite").Database} args.db
 * @param {object} args.registry
 * @param {{ base: string, github: string, worktreeUp: string, path: string, name: string }} args.target
 * @param {string} args.digest        preview digest the operator confirmed
 * @param {string[]} args.keys        selected selection keys (non-empty)
 * @param {object} args.seams         injected tracker/worktree/git/forge seams
 * @param {string} [args.root]        live checkout root (never written)
 */
export async function applyPromotion({
  db,
  registry,
  target,
  digest,
  keys,
  seams,
  root = reposRoot(),
  actor = "operator",
}) {
  if (!Array.isArray(keys)) {
    throw new OverlayError(422, "keys must be an array");
  }
  if (keys.length === 0) {
    // Typed no-op: an empty selection promotes nothing and drives no seam.
    return { status: "noop", promoted: [], ticket: null, pr: null };
  }
  if (new Set(keys).size !== keys.length) {
    throw new OverlayError(422, "keys must be unique");
  }
  if (typeof digest !== "string" || digest === "") {
    throw new OverlayError(422, "preview digest is required");
  }
  if (!target?.base) {
    throw new OverlayError(422, "promotion target base is not configured");
  }

  const preview = buildPromotionPreview({ db, registry, root });
  if (preview.digest !== digest) {
    throw new OverlayError(
      409,
      "promotion preview is stale; refresh the preview and retry",
    );
  }
  const byKey = new Map(preview.selections.map((s) => [s.key, s]));
  const selected = [];
  for (const key of keys) {
    const selection = byKey.get(key);
    if (!selection) throw new OverlayError(422, `unknown promotion key ${key}`);
    if (!selection.current) {
      throw new OverlayError(
        409,
        `${key} no longer diverges from its tracked default`,
      );
    }
    selected.push(selection);
  }

  // Read-only drift check against the LIVE checkout before any worktree exists:
  // parse each target file and confirm the tracked value still equals the
  // preview `before`. Invalid JSON or drift fails closed here.
  const readTracked = requireSeam(seams, "readTracked");
  const byFile = new Map();
  for (const selection of selected) {
    const file = selection.target.file;
    if (!byFile.has(file)) {
      let text;
      try {
        text = readTracked(file);
      } catch (err) {
        throw new OverlayError(
          409,
          `cannot read tracked ${file}: ${err.message}`,
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new OverlayError(
          422,
          `tracked ${file} is not valid JSON: ${err.message}`,
        );
      }
      byFile.set(file, { parsed });
    }
    const current = readSelectionValue(byFile.get(file).parsed, selection);
    if (current !== (selection.before ?? null)) {
      throw new OverlayError(
        409,
        `target drift on ${selection.key}: tracked value changed since preview`,
      );
    }
  }

  // Everything validated. Create the ticket and the ISOLATED checkout.
  const ticket = await requireSeam(seams, "tracker.ensure")({ actor, keys });
  if (!ticket?.ticket) {
    throw new OverlayError(500, "tracker did not return a ticket");
  }
  const worktree = await requireSeam(
    seams,
    "worktree.up",
  )({
    base: target.base,
    ticket: ticket.ticket,
    checkoutOnly: true,
  });
  const dir = worktree?.dir;
  const branch = worktree?.branch;
  if (typeof dir !== "string" || dir === "") {
    throw new OverlayError(500, "worktree_up did not return a directory");
  }
  if (path.resolve(dir) === path.resolve(root)) {
    throw new OverlayError(
      500,
      "refusing to promote: worktree resolved to the live checkout root",
    );
  }
  if (typeof branch !== "string" || branch === "") {
    throw new OverlayError(500, "worktree_up did not return a branch");
  }

  try {
    const readWorktree = requireSeam(seams, "readWorktree");
    const writeWorktree = requireSeam(seams, "writeWorktree");
    const written = [];
    for (const file of byFile.keys()) {
      const parsed = JSON.parse(readWorktree(dir, file));
      for (const selection of selected) {
        if (selection.target.file !== file) continue;
        writeSelectionValue(parsed, selection);
      }
      writeWorktree(dir, file, serializeTracked(parsed));
      written.push(file);
    }

    const promoted = selected.map((s) => ({
      key: s.key,
      target: s.target,
      before: s.before ?? null,
      after: s.effective ?? null,
    }));
    const message = promotionCommitMessage(ticket.ticket, promoted);
    const body = promotionPrBody(ticket.ticket, promoted);
    await requireSeam(seams, "git.commit")({ dir, message, files: written });
    await requireSeam(seams, "git.push")({ dir, branch });
    const pr = await requireSeam(
      seams,
      "forge.openPr",
    )({
      base: target.base,
      head: branch,
      title: `feat(overlay): promote ${promoted.length} runtime override${
        promoted.length === 1 ? "" : "s"
      }`,
      body,
    });
    return {
      status: "opened",
      ticket: ticket.ticket,
      worktree: dir,
      branch,
      files: written,
      promoted,
      pr: pr ?? null,
    };
  } catch (err) {
    // Preserve the worktree/branch for operator cleanup; nothing was merged.
    const wrapped =
      err instanceof OverlayError
        ? err
        : new OverlayError(
            500,
            `promotion failed after checkout: ${err.message}`,
          );
    wrapped.evidence = { worktree: dir, branch, ticket: ticket.ticket };
    throw wrapped;
  }
}

function promotionCommitMessage(ticket, promoted) {
  const lines = promoted.map(
    (p) =>
      `- ${p.key}: ${JSON.stringify(p.before)} -> ${JSON.stringify(p.after)}`,
  );
  return `feat(overlay): promote runtime overrides to tracked defaults\n\n${lines.join(
    "\n",
  )}\n\nFixes ${ticket}`;
}

function promotionPrBody(ticket, promoted) {
  const rows = promoted
    .map(
      (p) =>
        `| \`${p.key}\` | \`${p.target.file}\` | ${JSON.stringify(
          p.before,
        )} | ${JSON.stringify(p.after)} |`,
    )
    .join("\n");
  return [
    "## What",
    "Promote selected machine-local runtime overrides into tracked fleet defaults.",
    "",
    "| Override key | Target | Tracked before | Effective after |",
    "| --- | --- | --- | --- |",
    rows,
    "",
    "## Verification",
    "Values written from a deterministic preview digest into an isolated worktree; no merge performed.",
    "Promotion does not clear the runtime overrides — clearing is a separate explicit action after deployment.",
    "",
    `Fixes ${ticket}`,
  ].join("\n");
}
