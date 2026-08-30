/**
 * Presentation contract — `factory.presentation/v1`
 * (docs/event-runtime-artifact-views.md §3.1–3.3).
 *
 * Layer B: an agent may emit a bounded block document (`presentation`) beside
 * its `artifact` in result.json. A value (a `keyvalue` value, a `table` cell, a
 * `links` target) is a scalar/null literal or `{ "$ref": "<pointer>" }` into
 * the artifact, and a `list` item may cite the artifact through a bare pointer
 * `ref` — the narrative points at its evidence. Everything the runtime's
 * deliberately small JSON Schema subset (lib/schema.mjs, no conditional
 * keywords) cannot express lives here, exactly as lib/artifact-view.mjs does
 * for views and lib/decision.mjs for decisions: per-type key applicability and
 * bounds, one-level `section` nesting, the exactly-one-`links`-target rule, the
 * serialised size ceiling, and — the point of the layer — that every `$ref`
 * resolves against the accepted artifact. Pure and fail-closed:
 * `{ valid, errors }`, never throws on data, `resolvePointer` (shared with
 * WM-454) the only dependency beyond loading the schema once.
 *
 * `format` and `tone` reuse the Layer A (`factory.artifact-view/v1`)
 * vocabularies verbatim — one set of hues and formatters across both layers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolvePointer, TONES } from "./artifact-view.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { validate } from "./schema.mjs";

export const PRESENTATION_SCHEMA_VERSION = "factory.presentation/v1";
export const PRESENTATION_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory.presentation.v1.json"),
    "utf8",
  ),
);

/** §3.1 block vocabulary — closed. */
export const BLOCK_TYPES = [
  "heading",
  "markdown",
  "keyvalue",
  "table",
  "list",
  "badge",
  "code",
  "section",
  "links",
];

/** §3.1 "Whole document ≤ 40 blocks, ≤ 16 KiB serialised." Size is a byte count. */
export const MAX_DOC_BYTES = 16 * 1024;
/** Per-type text bounds (§3.1). `heading` counts characters; the KiB ones are byte sizes. */
export const HEADING_MAX_CHARS = 120;
export const MARKDOWN_MAX_BYTES = 2 * 1024;
export const CODE_MAX_BYTES = 4 * 1024;

/** Per-type item counts (§3.1). */
const MAX_KEYVALUE_ITEMS = 16;
const MAX_LIST_ITEMS = 30;
const MAX_LINKS_ITEMS = 12;
const MAX_TABLE_COLUMNS = 6;
const MAX_TABLE_ROWS = 50;
const MAX_SECTION_CHILDREN = 20;
const LINK_TARGETS = ["issue", "pr", "run", "url"];

const TONE_SET = new Set(TONES);

/** The keys each block `type` may carry beyond `type` (§3.1 table). */
const KEYS_BY_TYPE = {
  heading: new Set(["text"]),
  markdown: new Set(["text"]),
  keyvalue: new Set(["items"]),
  table: new Set(["label", "columns", "rows", "formats", "tone"]),
  list: new Set(["label", "items"]),
  badge: new Set(["text", "tone"]),
  code: new Set(["text", "language"]),
  section: new Set(["label", "collapsed", "blocks"]),
  links: new Set(["items"]),
};

/** The keys each block `type` must carry (§3.1 table). */
const REQUIRED_BY_TYPE = {
  heading: ["text"],
  markdown: ["text"],
  keyvalue: ["items"],
  table: ["columns", "rows"],
  list: ["items"],
  badge: ["text", "tone"],
  code: ["text"],
  section: ["label", "blocks"],
  links: ["items"],
};

/** The keys each item-bearing block's items may carry, and must carry. */
const ITEM_KEYS_BY_TYPE = {
  keyvalue: new Set(["label", "value", "format", "tone"]),
  list: new Set(["text", "ref", "tone"]),
  links: new Set(["label", "issue", "pr", "run", "url"]),
};
const ITEM_REQUIRED_BY_TYPE = {
  keyvalue: ["label", "value"],
  list: ["text"],
  links: [],
};

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (obj, key) =>
  isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
const isRef = (v) =>
  isObject(v) && Object.keys(v).length === 1 && typeof v.$ref === "string";

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/**
 * A "value" slot (keyvalue value, table cell, links target): a scalar/null
 * literal, or a `{ "$ref": pointer }` that must resolve in the artifact. A
 * pointer that does not resolve names the block index and the pointer (§3.2).
 */
function checkValue(value, at, artifact, errors) {
  if (!isRef(value)) return;
  if (resolvePointer(artifact, value.$ref) === undefined) {
    errors.push(`${at}: $ref "${value.$ref}" does not resolve in the artifact`);
  }
}

/** A bare pointer citation (`list` item `ref`) that must resolve in the artifact. */
function checkPointer(pointer, at, artifact, errors) {
  if (typeof pointer !== "string") return;
  if (resolvePointer(artifact, pointer) === undefined) {
    errors.push(`${at}: ref "${pointer}" does not resolve in the artifact`);
  }
}

function checkItemKeys(item, type, at, errors) {
  const allowed = ITEM_KEYS_BY_TYPE[type];
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      errors.push(`${at}: "${key}" is not a key of a ${type} item`);
    }
  }
  for (const key of ITEM_REQUIRED_BY_TYPE[type]) {
    if (!hasOwn(item, key)) {
      errors.push(`${at}: a ${type} item requires "${key}"`);
    }
  }
}

/**
 * Validate one block: the per-type key applicability and bounds the schema
 * cannot express, plus every `$ref`/`ref` resolution against `artifact`.
 * `depth` is 0 for a top-level block and 1 for a `section` child; a `section`
 * at depth > 0 is the one-level-nesting violation (§3.1).
 */
function checkBlock(block, at, artifact, errors, depth) {
  const type = block.type;

  const allowed = KEYS_BY_TYPE[type];
  for (const key of Object.keys(block)) {
    if (key === "type") continue;
    if (!allowed.has(key)) {
      errors.push(`${at}: "${key}" is not a key of type=${type}`);
    }
  }
  for (const key of REQUIRED_BY_TYPE[type]) {
    if (!hasOwn(block, key)) {
      errors.push(`${at}: type=${type} requires "${key}"`);
    }
  }

  if (type === "heading" && typeof block.text === "string") {
    if (block.text.length > HEADING_MAX_CHARS) {
      errors.push(
        `${at}: heading text is ${block.text.length} chars > ${HEADING_MAX_CHARS}`,
      );
    }
    return;
  }
  if (type === "markdown" && typeof block.text === "string") {
    const bytes = utf8Bytes(block.text);
    if (bytes > MARKDOWN_MAX_BYTES) {
      errors.push(
        `${at}: markdown text is ${bytes} bytes > ${MARKDOWN_MAX_BYTES}`,
      );
    }
    return;
  }
  if (type === "code" && typeof block.text === "string") {
    const bytes = utf8Bytes(block.text);
    if (bytes > CODE_MAX_BYTES) {
      errors.push(`${at}: code text is ${bytes} bytes > ${CODE_MAX_BYTES}`);
    }
    return;
  }
  if (type === "badge") {
    if (typeof block.tone === "string" && !TONE_SET.has(block.tone)) {
      errors.push(`${at}.tone: badge tone must be one of ${TONES.join("|")}`);
    } else if (block.tone !== undefined && typeof block.tone !== "string") {
      errors.push(`${at}.tone: badge tone must be a single tone string`);
    }
    return;
  }

  if (type === "keyvalue") {
    const items = Array.isArray(block.items) ? block.items : [];
    if (items.length > MAX_KEYVALUE_ITEMS) {
      errors.push(`${at}.items: ${items.length} items > ${MAX_KEYVALUE_ITEMS}`);
    }
    items.forEach((item, i) => {
      const itemAt = `${at}.items[${i}]`;
      checkItemKeys(item, "keyvalue", itemAt, errors);
      if (hasOwn(item, "value")) {
        checkValue(item.value, `${itemAt}.value`, artifact, errors);
      }
    });
    return;
  }

  if (type === "list") {
    const items = Array.isArray(block.items) ? block.items : [];
    if (items.length > MAX_LIST_ITEMS) {
      errors.push(`${at}.items: ${items.length} items > ${MAX_LIST_ITEMS}`);
    }
    items.forEach((item, i) => {
      const itemAt = `${at}.items[${i}]`;
      checkItemKeys(item, "list", itemAt, errors);
      if (hasOwn(item, "ref")) {
        checkPointer(item.ref, `${itemAt}.ref`, artifact, errors);
      }
    });
    return;
  }

  if (type === "links") {
    const items = Array.isArray(block.items) ? block.items : [];
    if (items.length > MAX_LINKS_ITEMS) {
      errors.push(`${at}.items: ${items.length} items > ${MAX_LINKS_ITEMS}`);
    }
    items.forEach((item, i) => {
      const itemAt = `${at}.items[${i}]`;
      checkItemKeys(item, "links", itemAt, errors);
      const present = LINK_TARGETS.filter(
        (key) => hasOwn(item, key) && item[key] !== null,
      );
      if (present.length !== 1) {
        errors.push(
          `${itemAt}: a links item needs exactly one non-null target of ${LINK_TARGETS.join("|")} (found ${present.length})`,
        );
      }
      for (const key of LINK_TARGETS) {
        if (hasOwn(item, key)) {
          checkValue(item[key], `${itemAt}.${key}`, artifact, errors);
        }
      }
    });
    return;
  }

  if (type === "table") {
    const columns = Array.isArray(block.columns) ? block.columns : [];
    const rows = Array.isArray(block.rows) ? block.rows : [];
    if (columns.length > MAX_TABLE_COLUMNS) {
      errors.push(
        `${at}.columns: ${columns.length} columns > ${MAX_TABLE_COLUMNS}`,
      );
    }
    if (rows.length > MAX_TABLE_ROWS) {
      errors.push(`${at}.rows: ${rows.length} rows > ${MAX_TABLE_ROWS}`);
    }
    if (Array.isArray(block.formats) && block.formats.length > columns.length) {
      errors.push(
        `${at}.formats: ${block.formats.length} formats > ${columns.length} columns`,
      );
    }
    rows.forEach((row, r) => {
      if (Array.isArray(row) && row.length !== columns.length) {
        errors.push(
          `${at}.rows[${r}]: ${row.length} cells != ${columns.length} columns`,
        );
      }
      if (Array.isArray(row)) {
        row.forEach((cell, c) => {
          checkValue(cell, `${at}.rows[${r}][${c}]`, artifact, errors);
        });
      }
    });
    checkTableTone(block.tone, `${at}.tone`, errors);
    return;
  }

  if (type === "section") {
    // One level of nesting only (§3.1). The v1 schema already forbids a
    // `section` among a section's child blocks, so a schema-valid document
    // never reaches this branch; it is kept as defense in depth so the rule
    // still holds if the schema is ever relaxed.
    if (depth > 0) {
      errors.push(`${at}: section nesting exceeds one level`);
    }
    const children = Array.isArray(block.blocks) ? block.blocks : [];
    if (children.length > MAX_SECTION_CHILDREN) {
      errors.push(
        `${at}.blocks: ${children.length} child blocks > ${MAX_SECTION_CHILDREN}`,
      );
    }
    children.forEach((child, i) => {
      checkBlock(child, `${at}.blocks[${i}]`, artifact, errors, depth + 1);
    });
  }
}

/** A table's optional `tone` object maps a column/value to a hue; leaves must be tones. */
function checkTableTone(tone, at, errors) {
  if (tone === undefined) return;
  if (typeof tone === "string") {
    if (!TONE_SET.has(tone)) {
      errors.push(`${at}: tone must be one of ${TONES.join("|")}`);
    }
    return;
  }
  if (!isObject(tone)) return;
  for (const [key, value] of Object.entries(tone)) {
    checkTableTone(value, `${at}.${key}`, errors);
  }
}

/**
 * Validate a `factory.presentation/v1` document against the v1 schema, its
 * bounds, one-level section nesting, the exactly-one-`links`-target rule, the
 * serialised size ceiling, and — the point of the layer — that every `$ref`
 * (and every `list` item `ref`) resolves in `artifact` (§3.1–3.3). Never
 * throws.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePresentation(presentation, artifact) {
  const shape = validate(PRESENTATION_SCHEMA, presentation);
  if (!shape.valid) return shape;

  const errors = [];
  const bytes = utf8Bytes(JSON.stringify(presentation));
  if (bytes > MAX_DOC_BYTES) {
    errors.push(
      `$: serialised presentation is ${bytes} bytes > ${MAX_DOC_BYTES}`,
    );
  }
  presentation.blocks.forEach((block, i) => {
    checkBlock(block, `blocks[${i}]`, artifact ?? {}, errors, 0);
  });
  return { valid: errors.length === 0, errors };
}

/**
 * A deep copy of `presentation` with every `{ "$ref": pointer }` value replaced
 * by `{ value, ref }` — the resolved value plus the pointer it came from — so a
 * renderer can show the value and, on hover, the artifact path it came from
 * ("show source", §3.2). A pointer that does not resolve yields
 * `value: undefined`; callers gate rendering on `validatePresentation` first.
 * Bare `list` item `ref` citations are left as-is (they annotate, they are not
 * value slots). Pure.
 */
export function resolveRefs(presentation, artifact) {
  const doc = artifact ?? {};
  const map = (node) => {
    if (Array.isArray(node)) return node.map(map);
    if (isRef(node)) {
      return { value: resolvePointer(doc, node.$ref), ref: node.$ref };
    }
    if (isObject(node)) {
      const out = {};
      for (const [key, value] of Object.entries(node)) out[key] = map(value);
      return out;
    }
    return node;
  };
  return map(presentation);
}
