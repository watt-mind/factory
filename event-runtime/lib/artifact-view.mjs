/**
 * Artifact views — `factory.artifact-view/v1` (docs/event-runtime-artifact-views.md §2).
 *
 * A sidecar `agents/<name>.view.json` (or a contract-keyed fallback under
 * `agents/views/`) annotates JSON pointers into an agent's output — and
 * optionally input — schema with a closed hint vocabulary so a generic
 * renderer can draw the document. Two checks, both fail closed and both here
 * rather than in the renderer: the document must match the v1 schema
 * (lib/schema.mjs, the same validator every contract goes through), and every
 * pointer it names must resolve to a property of the matching schema — a view
 * cannot drift from the contract it describes (§2.3). Pointer resolution
 * against a concrete document (`resolvePointer`) is shared with the
 * presentation layer (WM-456).
 *
 * `subject` is a one-line template over input-schema pointers (`{/ticket}`)
 * plus the fixed RunSpec fields `agent`, `model`, `adapter`, `repo`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_ROOT } from "./config.mjs";
import { validate } from "./schema.mjs";

export const ARTIFACT_VIEW_SCHEMA_VERSION = "factory.artifact-view/v1";
export const ARTIFACT_VIEW_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory.artifact-view.v1.json"),
    "utf8",
  ),
);

export const SECTION_KINDS = [
  "table",
  "keyvalue",
  "list",
  "badge",
  "code",
  "prose",
];
export const FORMATS = [
  "issue",
  "pr",
  "url",
  "sha",
  "repo",
  "run",
  "duration",
  "datetime",
  "state",
  "bytes",
  "count",
];
export const TONES = ["ok", "warn", "error", "muted", "neutral"];

/** Fixed RunSpec fields a `subject` template may name without a leading `/`. */
export const SUBJECT_FIELDS = ["agent", "model", "adapter", "repo"];

/**
 * `factory.command-result/v1` → `agents/views/factory.command-result.v1.view.json`.
 * Slashes become dots so the contract id is a single path segment.
 */
export function contractViewRel(outputContract) {
  if (typeof outputContract !== "string" || !outputContract) return null;
  return `agents/views/${outputContract.replaceAll("/", ".")}.view.json`;
}

/** `{/ticket}` and `{model}` tokens, in template order. Empty / nested braces are not tokens. */
export function subjectPlaceholders(template) {
  if (typeof template !== "string") return [];
  const out = [];
  const re = /\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(template)) !== null) out.push(m[1]);
  return out;
}

/** Keys every section may carry, plus the per-`as` keys (design §2.2 `as` row). */
const COMMON_SECTION_KEYS = new Set(["path", "as", "label"]);
const KEYS_BY_KIND = {
  table: new Set(["columns", "groupBy", "expand", "formats", "tone"]),
  keyvalue: new Set(["keys", "formats", "tone"]),
  list: new Set(["itemLabel", "formats", "tone"]),
  badge: new Set(["tone"]),
  code: new Set(["language"]),
  prose: new Set(),
};
const REQUIRED_BY_KIND = { table: ["columns"] };

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (obj, key) =>
  isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);

/** RFC 6901: split a pointer into unescaped reference tokens; null when malformed. */
export function parsePointer(pointer) {
  if (typeof pointer !== "string") return null;
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Resolve an RFC 6901 pointer against a document. Returns `undefined` when
 * the pointer is malformed or any step is absent — never throws, never
 * invents a value.
 */
export function resolvePointer(doc, pointer) {
  const tokens = parsePointer(pointer);
  if (tokens === null) return undefined;
  let node = doc;
  for (const token of tokens) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const index = Number(token);
      if (index >= node.length) return undefined;
      node = node[index];
    } else if (isObject(node)) {
      if (!hasOwn(node, token)) return undefined;
      node = node[token];
    } else {
      return undefined;
    }
  }
  return node;
}

/**
 * Walk a JSON Schema (the subset lib/schema.mjs supports) along a pointer's
 * tokens: an object step follows `properties.<token>`, an array step (an
 * index token or `-`) follows `items`. Returns the schema node or `undefined`.
 */
export function resolveSchemaPointer(schema, pointer) {
  const tokens = parsePointer(pointer);
  if (tokens === null) return undefined;
  return walkSchema(schema, tokens);
}

function walkSchema(schema, tokens) {
  let node = schema;
  for (const token of tokens) {
    if (!isObject(node)) return undefined;
    if (isObject(node.properties) && hasOwn(node.properties, token)) {
      node = node.properties[token];
    } else if (
      hasOwn(node, "items") &&
      isObject(node.items) &&
      /^(0|[1-9][0-9]*|-)$/.test(token)
    ) {
      node = node.items;
    } else {
      return undefined;
    }
  }
  return node;
}

/** The node a section's relative keys are resolved against: an array's `items`, else the node itself. */
function itemNode(node) {
  if (isObject(node) && hasOwn(node, "items") && isObject(node.items))
    return node.items;
  return node;
}

function relativeNode(base, key) {
  // Keys are plain property names or pointer-ish paths ("a/b", "/a/b").
  const tokens = key.startsWith("/") ? parsePointer(key) : key.split("/");
  if (!tokens || tokens.length === 0) return undefined;
  return walkSchema(base, tokens);
}

function hasOutputBody(view) {
  return (
    hasOwn(view, "summary") ||
    hasOwn(view, "status") ||
    (Array.isArray(view.sections) && view.sections.length > 0)
  );
}

function hasInputBody(body) {
  return (
    isObject(body) &&
    (hasOwn(body, "summary") ||
      hasOwn(body, "status") ||
      (Array.isArray(body.sections) && body.sections.length > 0) ||
      hasOwn(body, "formats") ||
      hasOwn(body, "tone") ||
      hasOwn(body, "title"))
  );
}

function subjectErrors(template, inputSchema, at) {
  const errors = [];
  if (typeof template !== "string" || !template.trim()) {
    errors.push(`${at}: must be a non-empty template string`);
    return errors;
  }
  const tokens = subjectPlaceholders(template);
  if (tokens.length === 0) return errors;
  const needsInput = tokens.some((t) => t.startsWith("/"));
  if (needsInput && !isObject(inputSchema)) {
    errors.push(
      `${at}: input schema is missing — nothing to resolve placeholders against`,
    );
    return errors;
  }
  for (const token of tokens) {
    if (token.startsWith("/")) {
      if (resolveSchemaPointer(inputSchema, token) === undefined) {
        errors.push(
          `${at}: placeholder "{${token}}" does not resolve in the input schema`,
        );
      }
    } else if (!SUBJECT_FIELDS.includes(token)) {
      errors.push(
        `${at}: unknown placeholder "{${token}}" (input pointer or ${SUBJECT_FIELDS.join("|")})`,
      );
    }
  }
  return errors;
}

/** The per-`as` key checks the schema cannot express (design §2.2 `as` row). */
function sectionKeyErrors(section, at) {
  const errors = [];
  const kind = section.as;
  const allowed = KEYS_BY_KIND[kind];
  for (const key of Object.keys(section)) {
    if (!COMMON_SECTION_KEYS.has(key) && !allowed.has(key)) {
      errors.push(`${at}: "${key}" is not a key of as=${kind}`);
    }
  }
  for (const key of REQUIRED_BY_KIND[kind] ?? []) {
    if (!hasOwn(section, key))
      errors.push(`${at}: as=${kind} requires "${key}"`);
  }
  if (kind === "badge" && isObject(section.tone)) {
    for (const [key, value] of Object.entries(section.tone)) {
      if (!TONES.includes(value)) {
        errors.push(
          `${at}.tone.${key}: badge tone must be one of ${TONES.join("|")}`,
        );
      }
    }
  }
  return errors;
}

/**
 * Pointer and per-`as` checks for one view body (the output side, or
 * `view.input`) against one schema. `at` prefixes every error (`view` /
 * `view.input`). A pointer that does not resolve names `schemaLabel`
 * ("output schema" / "input schema").
 */
function validateViewBody(body, schema, at, schemaLabel) {
  const errors = [];
  if (!isObject(body)) {
    errors.push(`${at}: must be an object`);
    return errors;
  }
  if (!isObject(schema)) {
    errors.push(
      `${at}: ${schemaLabel} is missing — nothing to resolve pointers against`,
    );
    return errors;
  }

  if (
    hasOwn(body, "summary") &&
    resolveSchemaPointer(schema, body.summary) === undefined
  ) {
    errors.push(
      `${at}.summary: pointer "${body.summary}" does not resolve in the ${schemaLabel}`,
    );
  }
  if (
    hasOwn(body, "status") &&
    resolveSchemaPointer(schema, body.status.path) === undefined
  ) {
    errors.push(
      `${at}.status.path: pointer "${body.status.path}" does not resolve in the ${schemaLabel}`,
    );
  }

  const sections = Array.isArray(body.sections) ? body.sections : [];
  sections.forEach((section, i) => {
    const secAt = `${at}.sections[${i}]`;
    const kind = section.as;
    errors.push(...sectionKeyErrors(section, secAt));

    const node = resolveSchemaPointer(schema, section.path);
    if (node === undefined) {
      errors.push(
        `${secAt}.path: pointer "${section.path}" does not resolve in the ${schemaLabel}`,
      );
      return;
    }
    if (
      (kind === "table" || kind === "list") &&
      !(hasOwn(node, "items") && isObject(node.items))
    ) {
      errors.push(
        `${secAt}.path: as=${kind} needs an array schema at "${section.path}"`,
      );
    }
    const base = itemNode(node);
    const checkKey = (field, key) => {
      if (key === "") return;
      if (relativeNode(base, key) === undefined) {
        errors.push(
          `${secAt}.${field}: "${key}" does not resolve under "${section.path}" in the ${schemaLabel}`,
        );
      }
    };
    for (const field of ["columns", "expand", "keys"]) {
      if (Array.isArray(section[field]))
        for (const key of section[field]) checkKey(field, key);
    }
    if (typeof section.groupBy === "string")
      checkKey("groupBy", section.groupBy);
    if (typeof section.itemLabel === "string")
      checkKey("itemLabel", section.itemLabel);
    if (isObject(section.formats))
      for (const key of Object.keys(section.formats)) checkKey("formats", key);

    if (isObject(section.tone)) {
      for (const [key, value] of Object.entries(section.tone)) {
        if (kind === "badge") continue; // checked by sectionKeyErrors
        checkKey("tone", key);
        if (!isObject(value)) {
          errors.push(
            `${secAt}.tone.${key}: as=${kind} tone maps a column/key to a (value → tone) object`,
          );
          continue;
        }
        for (const [v, tone] of Object.entries(value)) {
          if (!TONES.includes(tone)) {
            errors.push(
              `${secAt}.tone.${key}.${v}: tone must be one of ${TONES.join("|")}`,
            );
          }
        }
      }
    }
  });
  return errors;
}

/**
 * Validate a view document's *shape* only: the v1 schema plus the per-`as`
 * key rules, with no output schema to resolve pointers against. This is the
 * check a panel (`factory.panel-view/v1`, lib/panel-view.mjs) gets — its data
 * comes from an API endpoint that has no published schema — and the first
 * half of `validateArtifactView`. Never throws.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateArtifactViewShape(view) {
  const schemaCheck = validate(ARTIFACT_VIEW_SCHEMA, view, "view");
  if (!schemaCheck.valid) return { valid: false, errors: schemaCheck.errors };
  const errors = [];
  if (
    !hasOutputBody(view) &&
    !hasOwn(view, "subject") &&
    !hasInputBody(view.input)
  ) {
    errors.push(
      "view: needs sections, input, or subject — an empty sidecar is not a view",
    );
  }
  (view.sections ?? []).forEach((section, i) => {
    errors.push(...sectionKeyErrors(section, `view.sections[${i}]`));
  });
  (view.input?.sections ?? []).forEach((section, i) => {
    errors.push(...sectionKeyErrors(section, `view.input.sections[${i}]`));
  });
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a view document against the v1 schema AND against the agent's
 * schemas (pointer drift). Output pointers (`summary`, `status`, `sections`)
 * resolve in `outputSchema`; `input.*` and `subject` placeholders resolve in
 * `inputSchema` (plus the fixed spec field list). Never throws.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateArtifactView(view, outputSchema, inputSchema) {
  const shape = validateArtifactViewShape(view);
  if (!shape.valid) return shape;
  const errors = [];

  if (hasOutputBody(view)) {
    errors.push(
      ...validateViewBody(view, outputSchema, "view", "output schema"),
    );
  }
  if (hasOwn(view, "input")) {
    if (!hasInputBody(view.input)) {
      errors.push(
        "view.input: needs summary, status, or sections — an empty input body is not a view",
      );
    } else {
      errors.push(
        ...validateViewBody(
          view.input,
          inputSchema,
          "view.input",
          "input schema",
        ),
      );
    }
  }
  if (hasOwn(view, "subject")) {
    errors.push(...subjectErrors(view.subject, inputSchema, "view.subject"));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The lines `cli.mjs inspect` prints first in its result section when the
 * run's agent ships a view (design §2.4): the `summary` prose, then the
 * status as `<label>: <value>` where the label is the last token of
 * `status.path` (`recommendation: ESCALATE`). Pure; a pointer that does not
 * resolve in this artifact contributes nothing, and no view means no lines.
 * @returns {string[]}
 */
export function inspectHeader(view, artifact) {
  if (!isObject(view)) return [];
  const lines = [];
  if (typeof view.summary === "string") {
    const summary = resolvePointer(artifact, view.summary);
    if (typeof summary === "string" && summary.trim())
      lines.push(summary.trim());
  }
  if (isObject(view.status) && typeof view.status.path === "string") {
    const value = resolvePointer(artifact, view.status.path);
    if (value !== undefined && value !== null && typeof value !== "object") {
      const tokens = parsePointer(view.status.path) ?? [];
      const label = tokens.length ? tokens[tokens.length - 1] : "status";
      lines.push(`${label}: ${String(value)}`);
    }
  }
  return lines;
}
