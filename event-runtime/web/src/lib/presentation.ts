/** Browser port of the presentation contract in `lib/presentation.mjs`. */
import type {
  ArtifactFormat,
  ArtifactTone,
  Presentation,
  PresentationBlock,
} from "../types";
import { resolvePointer } from "./artifactView";

export const PRESENTATION_SCHEMA_VERSION = "factory.presentation/v1";
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
] as const;
const FORMATS: ArtifactFormat[] = [
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
const TONES: ArtifactTone[] = ["ok", "warn", "error", "muted", "neutral"];
const LIMITS = {
  bytes: 16 * 1024,
  blocks: 40,
  heading: 120,
  markdown: 2 * 1024,
  code: 4 * 1024,
  keyvalue: 16,
  list: 30,
  links: 12,
  columns: 6,
  rows: 50,
  section: 20,
};

export interface PresentationValidation {
  valid: boolean;
  errors: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: unknown, key: string): boolean =>
  object(value) && Object.prototype.hasOwnProperty.call(value, key);
const ref = (value: unknown): value is { $ref: string } =>
  object(value) &&
  Object.keys(value).length === 1 &&
  typeof value.$ref === "string";
const scalarOrRef = (value: unknown): boolean =>
  value === null ||
  ["string", "number", "boolean"].includes(typeof value) ||
  ref(value);
const bytes = (value: string): number => new TextEncoder().encode(value).length;

function stringField(
  value: unknown,
  at: string,
  errors: string[],
  { min = 0, max = Infinity }: { min?: number; max?: number } = {},
): value is string {
  if (typeof value !== "string") {
    errors.push(`${at}: expected string`);
    return false;
  }
  if (value.length < min) errors.push(`${at}: shorter than ${min}`);
  if (value.length > max) errors.push(`${at}: longer than ${max}`);
  return true;
}

function keys(
  value: Record<string, unknown>,
  allowed: string[],
  required: string[],
  at: string,
  errors: string[],
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) errors.push(`${at}: unknown property "${key}"`);
  for (const key of required)
    if (!own(value, key))
      errors.push(`${at}: missing required property "${key}"`);
}

function checkValue(
  value: unknown,
  at: string,
  artifact: unknown,
  errors: string[],
) {
  if (!scalarOrRef(value)) {
    errors.push(`${at}: expected scalar, null, or $ref`);
    return;
  }
  if (ref(value)) {
    if (value.$ref.length === 0) errors.push(`${at}.$ref: shorter than 1`);
    else if (resolvePointer(artifact, value.$ref) === undefined)
      errors.push(
        `${at}: $ref "${value.$ref}" does not resolve in the artifact`,
      );
  }
}

function checkTone(
  value: unknown,
  at: string,
  errors: string[],
  nested = false,
) {
  if (typeof value === "string") {
    if (!TONES.includes(value as ArtifactTone))
      errors.push(`${at}: invalid tone`);
    return;
  }
  if (!object(value)) {
    // The server's deliberately small schema constrains the outer value to an
    // object but does not constrain nested leaves. Keep parity with its
    // defensive recursion: only string leaves can be invalid tones.
    if (!nested) errors.push(`${at}: invalid tone map`);
    return;
  }
  for (const [key, child] of Object.entries(value))
    checkTone(child, `${at}.${key}`, errors, true);
}

function checkBlock(
  value: unknown,
  at: string,
  artifact: unknown,
  errors: string[],
  depth: number,
) {
  if (!object(value) || typeof value.type !== "string") {
    errors.push(`${at}: block requires a type`);
    return;
  }
  if (!BLOCK_TYPES.includes(value.type as (typeof BLOCK_TYPES)[number])) {
    errors.push(`${at}.type: value not in enum`);
    return;
  }
  const type = value.type;
  const textBlock = (limit: number, byteLimit = false) => {
    keys(value, ["type", "text"], ["text"], at, errors);
    if (
      stringField(value.text, `${at}.text`, errors) &&
      (byteLimit ? bytes(value.text) : value.text.length) > limit
    )
      errors.push(`${at}: ${type} text is over ${limit}`);
  };
  if (type === "heading") return textBlock(LIMITS.heading);
  if (type === "markdown") return textBlock(LIMITS.markdown, true);
  if (type === "code") {
    keys(value, ["type", "text", "language"], ["text"], at, errors);
    if (
      stringField(value.text, `${at}.text`, errors) &&
      bytes(value.text) > LIMITS.code
    )
      errors.push(`${at}: code text is over ${LIMITS.code}`);
    if (value.language !== undefined)
      stringField(value.language, `${at}.language`, errors, {
        min: 1,
        max: 40,
      });
    return;
  }
  if (type === "badge") {
    keys(value, ["type", "text", "tone"], ["text", "tone"], at, errors);
    stringField(value.text, `${at}.text`, errors);
    if (!TONES.includes(value.tone as ArtifactTone))
      errors.push(`${at}.tone: invalid tone`);
    return;
  }
  if (type === "keyvalue" || type === "list" || type === "links") {
    const allowed =
      type === "list" ? ["type", "label", "items"] : ["type", "items"];
    keys(value, allowed, ["items"], at, errors);
    if (type === "list" && value.label !== undefined)
      stringField(value.label, `${at}.label`, errors, {
        min: 1,
        max: 120,
      });
    if (!Array.isArray(value.items)) {
      errors.push(`${at}.items: expected array`);
      return;
    }
    const limit = LIMITS[type];
    if (value.items.length > limit) errors.push(`${at}.items: too many items`);
    value.items.forEach((item, index) => {
      const itemAt = `${at}.items[${index}]`;
      if (!object(item)) return errors.push(`${itemAt}: expected object`);
      if (type === "keyvalue") {
        keys(
          item,
          ["label", "value", "format", "tone"],
          ["label", "value"],
          itemAt,
          errors,
        );
        stringField(item.label, `${itemAt}.label`, errors, {
          min: 1,
          max: 120,
        });
        if (own(item, "value"))
          checkValue(item.value, `${itemAt}.value`, artifact, errors);
        if (
          item.format !== undefined &&
          !FORMATS.includes(item.format as ArtifactFormat)
        )
          errors.push(`${itemAt}.format: invalid format`);
        if (
          item.tone !== undefined &&
          !TONES.includes(item.tone as ArtifactTone)
        )
          errors.push(`${itemAt}.tone: invalid tone`);
      } else if (type === "list") {
        keys(item, ["text", "ref", "tone"], ["text"], itemAt, errors);
        stringField(item.text, `${itemAt}.text`, errors, {
          min: 1,
          max: 2048,
        });
        if (item.ref !== undefined) {
          if (
            stringField(item.ref, `${itemAt}.ref`, errors, { min: 1 }) &&
            resolvePointer(artifact, item.ref) === undefined
          )
            errors.push(
              `${itemAt}: ref "${item.ref}" does not resolve in the artifact`,
            );
        }
        if (
          item.tone !== undefined &&
          !TONES.includes(item.tone as ArtifactTone)
        )
          errors.push(`${itemAt}.tone: invalid tone`);
      } else {
        keys(item, ["label", "issue", "pr", "run", "url"], [], itemAt, errors);
        if (item.label !== undefined)
          stringField(item.label, `${itemAt}.label`, errors, {
            min: 1,
            max: 120,
          });
        const targets = ["issue", "pr", "run", "url"].filter(
          (key) => own(item, key) && item[key] !== null,
        );
        if (targets.length !== 1)
          errors.push(
            `${itemAt}: a links item needs exactly one non-null target`,
          );
        for (const target of ["issue", "pr", "run", "url"])
          if (own(item, target))
            checkValue(item[target], `${itemAt}.${target}`, artifact, errors);
      }
    });
    return;
  }
  if (type === "table") {
    keys(
      value,
      ["type", "label", "columns", "rows", "formats", "tone"],
      ["columns", "rows"],
      at,
      errors,
    );
    if (value.label !== undefined)
      stringField(value.label, `${at}.label`, errors, {
        min: 1,
        max: 120,
      });
    if (
      !Array.isArray(value.columns) ||
      value.columns.length < 1 ||
      value.columns.length > LIMITS.columns
    )
      errors.push(`${at}.columns: expected 1-${LIMITS.columns} columns`);
    else
      value.columns.forEach((column, index) =>
        stringField(column, `${at}.columns[${index}]`, errors, {
          min: 1,
          max: 120,
        }),
      );
    if (!Array.isArray(value.rows))
      return errors.push(`${at}.rows: expected array`);
    if (value.rows.length > LIMITS.rows)
      errors.push(`${at}.rows: too many rows`);
    value.rows.forEach((row, r) => {
      if (!Array.isArray(row))
        return errors.push(`${at}.rows[${r}]: expected array`);
      if (Array.isArray(value.columns) && row.length !== value.columns.length)
        errors.push(
          `${at}.rows[${r}]: ${row.length} cells != ${value.columns.length} columns`,
        );
      row.forEach((cell, c) =>
        checkValue(cell, `${at}.rows[${r}][${c}]`, artifact, errors),
      );
    });
    if (value.formats !== undefined) {
      if (
        !Array.isArray(value.formats) ||
        value.formats.some(
          (format) => !FORMATS.includes(format as ArtifactFormat),
        )
      )
        errors.push(`${at}.formats: invalid formats`);
      else if (
        Array.isArray(value.columns) &&
        value.formats.length > value.columns.length
      )
        errors.push(`${at}.formats: more formats than columns`);
    }
    if (value.tone !== undefined) checkTone(value.tone, `${at}.tone`, errors);
    return;
  }
  if (type === "section") {
    keys(
      value,
      ["type", "label", "collapsed", "blocks"],
      ["label", "blocks"],
      at,
      errors,
    );
    if (depth > 0) errors.push(`${at}: section nesting exceeds one level`);
    stringField(value.label, `${at}.label`, errors, {
      min: 1,
      max: 120,
    });
    if (value.collapsed !== undefined && typeof value.collapsed !== "boolean")
      errors.push(`${at}.collapsed: expected boolean`);
    if (!Array.isArray(value.blocks))
      return errors.push(`${at}.blocks: expected array`);
    if (value.blocks.length > LIMITS.section)
      errors.push(`${at}.blocks: too many blocks`);
    value.blocks.forEach((block, index) =>
      checkBlock(block, `${at}.blocks[${index}]`, artifact, errors, depth + 1),
    );
  }
}

/** Validate the document and every artifact citation. Never throws. */
export function validatePresentation(
  value: unknown,
  artifact: unknown,
): PresentationValidation {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ["$: expected object"] };
  keys(
    value,
    ["schemaVersion", "blocks"],
    ["schemaVersion", "blocks"],
    "$",
    errors,
  );
  if (value.schemaVersion !== PRESENTATION_SCHEMA_VERSION)
    errors.push("$.schemaVersion: expected factory.presentation/v1");
  if (!Array.isArray(value.blocks)) errors.push("$.blocks: expected array");
  else {
    if (value.blocks.length < 1 || value.blocks.length > LIMITS.blocks)
      errors.push(`$.blocks: expected 1-${LIMITS.blocks} blocks`);
    value.blocks.forEach((block, index) =>
      checkBlock(block, `blocks[${index}]`, artifact ?? {}, errors, 0),
    );
  }
  if (bytes(JSON.stringify(value)) > LIMITS.bytes)
    errors.push(`$: serialised presentation is over ${LIMITS.bytes} bytes`);
  return { valid: errors.length === 0, errors };
}

/** Deep-copy a presentation, replacing `$ref` values with value+source pairs. */
export function resolveRefs(
  presentation: Presentation,
  artifact: unknown,
): Presentation {
  const map = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(map);
    if (ref(value))
      return {
        value: resolvePointer(artifact ?? {}, value.$ref),
        ref: value.$ref,
      };
    if (object(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, map(child)]),
      );
    return value;
  };
  return map(presentation) as Presentation;
}

export type { Presentation, PresentationBlock };
