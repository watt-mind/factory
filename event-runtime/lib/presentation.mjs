/**
 * Agent-authored presentations — `factory.presentation/v1`
 * (docs/event-runtime-artifact-views.md §3).
 *
 * Presentations are bounded, view-only block documents beside an accepted
 * artifact. Their JSON shape goes through the runtime's closed-keyword schema
 * validator; the conditional rules that JSON Schema subset cannot express are
 * checked here. Invalid presentations are data errors, never exceptions.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { TONES, resolvePointer } from "./artifact-view.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { validate } from "./schema.mjs";

export const PRESENTATION_SCHEMA_VERSION = "factory.presentation/v1";
export const PRESENTATION_MAX_BYTES = 16 * 1024;
export const PRESENTATION_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory.presentation.v1.json"),
    "utf8",
  ),
);

export const PRESENTATION_BLOCK_TYPES = [
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

const BLOCK_KEYS = {
  heading: new Set(["type", "text"]),
  markdown: new Set(["type", "text"]),
  keyvalue: new Set(["type", "items"]),
  table: new Set(["type", "label", "columns", "rows", "formats", "tone"]),
  list: new Set(["type", "label", "items"]),
  badge: new Set(["type", "text", "tone"]),
  code: new Set(["type", "text", "language"]),
  section: new Set(["type", "label", "collapsed", "blocks"]),
  links: new Set(["type", "items"]),
};

const REQUIRED_KEYS = {
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

const ITEM_KEYS = {
  keyvalue: new Set(["label", "value", "format", "tone"]),
  list: new Set(["text", "ref", "tone"]),
  links: new Set(["label", "issue", "pr", "run", "url"]),
};

const ITEM_REQUIRED = {
  keyvalue: ["label", "value"],
  list: ["text"],
  links: ["label"],
};

const LINK_TARGETS = ["issue", "pr", "run", "url"];

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) =>
  isObject(value) && Object.prototype.hasOwnProperty.call(value, key);

function byteLength(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function requiredKeyErrors(value, required, at, kind) {
  const errors = [];
  for (const key of required) {
    if (!hasOwn(value, key))
      errors.push(`${at}: type=${kind} requires "${key}"`);
  }
  return errors;
}

function itemErrors(item, kind, at) {
  if (!isObject(item)) return [];
  const errors = [];
  const allowed = ITEM_KEYS[kind];
  for (const key of Object.keys(item)) {
    if (!allowed.has(key))
      errors.push(`${at}.${key}: not allowed for type=${kind}`);
  }
  errors.push(...requiredKeyErrors(item, ITEM_REQUIRED[kind], at, kind));

  if (kind === "links") {
    const targets = LINK_TARGETS.filter((target) => hasOwn(item, target));
    if (targets.length !== 1) {
      errors.push(
        `${at}: links item must carry exactly one target (${LINK_TARGETS.join("|")}); got ${targets.length}`,
      );
    }
  }
  return errors;
}

function blockErrors(block, at, depth) {
  if (!isObject(block) || !BLOCK_KEYS[block.type]) return [];
  const errors = [];
  const kind = block.type;

  if (kind === "section" && depth > 0) {
    errors.push(`${at}: section nesting depth must not exceed 1`);
    return errors;
  }

  for (const key of Object.keys(block)) {
    if (!BLOCK_KEYS[kind].has(key))
      errors.push(`${at}.${key}: not a key of type=${kind}`);
  }
  errors.push(...requiredKeyErrors(block, REQUIRED_KEYS[kind], at, kind));

  if (kind === "heading" && block.text?.length > 120) {
    errors.push(`${at}.text: heading text exceeds 120 characters`);
  }
  if (kind === "markdown" && byteLength(block.text) > 2 * 1024) {
    errors.push(
      `${at}.text: markdown text exceeds 2048 bytes when UTF-8 encoded`,
    );
  }
  if (kind === "code" && byteLength(block.text) > 4 * 1024) {
    errors.push(`${at}.text: code text exceeds 4096 bytes when UTF-8 encoded`);
  }
  if (
    kind === "badge" &&
    hasOwn(block, "tone") &&
    !TONES.includes(block.tone)
  ) {
    errors.push(`${at}.tone: badge tone must be one of ${TONES.join("|")}`);
  }

  if (kind === "keyvalue" && block.items?.length > 16) {
    errors.push(`${at}.items: keyvalue items exceed 16`);
  }
  if (kind === "list" && block.items?.length > 30) {
    errors.push(`${at}.items: list items exceed 30`);
  }
  if (kind === "links" && block.items?.length > 12) {
    errors.push(`${at}.items: links items exceed 12`);
  }
  if (ITEM_KEYS[kind] && Array.isArray(block.items)) {
    block.items.forEach((item, index) => {
      errors.push(...itemErrors(item, kind, `${at}.items[${index}]`));
    });
  }

  if (kind === "table") {
    if (block.columns?.length > 6)
      errors.push(`${at}.columns: table columns exceed 6`);
    if (block.rows?.length > 50)
      errors.push(`${at}.rows: table rows exceed 50`);
    if (
      Array.isArray(block.columns) &&
      new Set(block.columns).size !== block.columns.length
    ) {
      errors.push(`${at}.columns: table column labels must be unique`);
    }
    if (Array.isArray(block.columns) && Array.isArray(block.rows)) {
      block.rows.forEach((row, index) => {
        if (Array.isArray(row) && row.length !== block.columns.length) {
          errors.push(
            `${at}.rows[${index}]: row must have ${block.columns.length} cells for ${block.columns.length} columns; got ${row.length}`,
          );
        }
      });
    }
    if (isObject(block.formats) && Array.isArray(block.columns)) {
      for (const column of Object.keys(block.formats)) {
        if (!block.columns.includes(column))
          errors.push(`${at}.formats: unknown table column "${column}"`);
      }
    }
    if (isObject(block.tone) && Array.isArray(block.columns)) {
      for (const column of Object.keys(block.tone)) {
        if (!block.columns.includes(column))
          errors.push(`${at}.tone: unknown table column "${column}"`);
      }
    } else if (hasOwn(block, "tone")) {
      errors.push(`${at}.tone: table tone must be a column tone map`);
    }
  }

  if (kind === "section" && Array.isArray(block.blocks)) {
    if (block.blocks.length > 20)
      errors.push(`${at}.blocks: section child blocks exceed 20`);
    block.blocks.forEach((child, index) => {
      errors.push(...blockErrors(child, `${at}.blocks[${index}]`, depth + 1));
    });
  }

  return errors;
}

function serializedSizeErrors(presentation) {
  try {
    const json = JSON.stringify(presentation);
    if (typeof json !== "string") return [];
    const bytes = Buffer.byteLength(json, "utf8");
    return bytes > PRESENTATION_MAX_BYTES
      ? [
          `$: serialized presentation is ${bytes} bytes; maximum is ${PRESENTATION_MAX_BYTES} bytes`,
        ]
      : [];
  } catch (error) {
    return [`$: presentation is not serializable: ${error.message}`];
  }
}

function countBlocks(blocks) {
  if (!Array.isArray(blocks)) return 0;
  return blocks.reduce(
    (total, block) =>
      total +
      1 +
      (isObject(block) && block.type === "section"
        ? countBlocks(block.blocks)
        : 0),
    0,
  );
}

function referenceErrors(value, artifact, at, blockAt) {
  const errors = [];
  const pending = [{ value, at }];
  const seen = new WeakSet();
  while (pending.length > 0) {
    const current = pending.pop();
    const node = current.value;
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);

    if (
      isObject(node) &&
      Object.keys(node).length === 1 &&
      typeof node.$ref === "string"
    ) {
      if (
        node.$ref !== "" &&
        (!node.$ref.startsWith("/") || /~(?:[^01]|$)/.test(node.$ref))
      ) {
        errors.push(
          `${blockAt}: invalid RFC 6901 $ref "${node.$ref}" at ${current.at}`,
        );
      } else if (resolvePointer(artifact, node.$ref) === undefined) {
        errors.push(
          `${blockAt}: unresolved $ref "${node.$ref}" at ${current.at}`,
        );
      }
      continue;
    }

    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        pending.push({ value: node[index], at: `${current.at}[${index}]` });
      }
    } else {
      const entries = Object.entries(node);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        pending.push({ value: child, at: `${current.at}.${key}` });
      }
    }
  }
  return errors;
}

/**
 * Validate schema shape, byte/structural bounds, and every artifact pointer.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePresentation(presentation, artifact) {
  const errors = [];
  const shape = validate(PRESENTATION_SCHEMA, presentation);
  errors.push(...shape.errors);
  errors.push(...serializedSizeErrors(presentation));

  if (isObject(presentation) && Array.isArray(presentation.blocks)) {
    const totalBlocks = countBlocks(presentation.blocks);
    if (totalBlocks > 40) {
      errors.push(
        `$.blocks: total block count is ${totalBlocks}; maximum is 40`,
      );
    }
    presentation.blocks.forEach((block, index) => {
      const at = `$.blocks[${index}]`;
      errors.push(...blockErrors(block, at, 0));
      errors.push(...referenceErrors(block, artifact, at, at));
    });
  }

  return { valid: errors.length === 0, errors };
}

function resolveValue(value, artifact, seen) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (
    isObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value.$ref === "string"
  ) {
    return { value: resolvePointer(artifact, value.$ref), ref: value.$ref };
  }

  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  if (Array.isArray(value)) {
    for (const item of value) copy.push(resolveValue(item, artifact, seen));
  } else {
    for (const [key, child] of Object.entries(value))
      copy[key] = resolveValue(child, artifact, seen);
  }
  return copy;
}

/** Return an independent renderer copy with `$ref` values expanded to `{ value, ref }`. */
export function resolveRefs(presentation, artifact) {
  return resolveValue(presentation, artifact, new WeakMap());
}
