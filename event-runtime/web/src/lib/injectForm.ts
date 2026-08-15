/**
 * Pure helpers for the Inject dialog's schema-driven Form view (WM-76):
 * field classification over the closed keyword subset of lib/schema.ts,
 * name-convention detection (repo picker, Now/Generate buttons), and
 * validation-error → field routing. No DOM, fully unit-testable.
 */
import type { RepoItem } from "../types";

/** Planner-injected fields (lib/planner.mjs) — never shown in the form. */
export const PLANNER_FIELDS = new Set(["repoPin", "runPin"]);

export type FieldKind =
  | "const" // read-only pill
  | "enum" // select
  | "boolean" // checkbox
  | "number" // numeric input
  | "string" // text input (also string|integer unions)
  | "string-array" // chip list
  | "json"; // nested object / array of objects → JSON sub-editor

export interface FieldSpec {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
  kind: FieldKind;
  description: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function typesOf(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.type)) return schema.type as string[];
  if (typeof schema.type === "string") return [schema.type];
  return [];
}

export function kindOf(schema: unknown): FieldKind {
  if (!isPlainObject(schema)) return "json";
  if ("const" in schema) return "const";
  if (Array.isArray(schema.enum)) return "enum";
  const types = typesOf(schema);
  if (types.length === 1) {
    const t = types[0];
    if (t === "boolean") return "boolean";
    if (t === "number" || t === "integer") return "number";
    if (t === "string") return "string";
    if (t === "array") {
      const items = schema.items;
      if (isPlainObject(items) && typesOf(items).length === 1 && typesOf(items)[0] === "string" && !Array.isArray(items.enum)) {
        return "string-array";
      }
      return "json";
    }
    return "json"; // object, null, …
  }
  // Union types: string|integer (e.g. ci-doctor runId) edits fine as text.
  if (types.length > 1 && types.every((t) => t === "string" || t === "integer" || t === "number")) {
    return "string";
  }
  return "json";
}

/**
 * A renderable object schema's fields, required first. Returns null when the
 * schema cannot drive a form (not an object schema).
 */
export function schemaFields(schema: unknown): FieldSpec[] | null {
  if (!isPlainObject(schema)) return null;
  const types = typesOf(schema);
  if (types.length > 0 && !types.includes("object")) return null;
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const specs: FieldSpec[] = Object.entries(props)
    .filter(([name]) => !PLANNER_FIELDS.has(name))
    .map(([name, propSchema]) => ({
      name,
      schema: isPlainObject(propSchema) ? propSchema : {},
      required: required.includes(name),
      kind: kindOf(propSchema),
      description:
        isPlainObject(propSchema) && typeof propSchema.description === "string"
          ? propSchema.description
          : null,
    }));
  return [...specs.filter((s) => s.required), ...specs.filter((s) => !s.required)];
}

/** Name conventions from templates.ts seedFor — never keyed off `format`. */
export const isAtField = (name: string): boolean =>
  name === "at" || /(?:[a-z0-9](?:At|_at|-at))$/.test(name);

export const isIdField = (name: string): boolean =>
  name === "id" || name === "ID" || /(?:[a-z0-9](?:Id|_id|-id)|ID)$/.test(name);

/**
 * Repo picker suggestions (WM-76 decision 4). String field named `repo`:
 * a pattern containing "/" wants owner/name → github slugs (nulls filtered);
 * otherwise short configured names. Array field `repos`: short names.
 */
export function repoSuggestions(
  name: string,
  schema: Record<string, unknown>,
  kind: FieldKind,
  repos: RepoItem[],
): string[] | null {
  if (name === "repo" && kind === "string") {
    if (typeof schema.pattern === "string" && schema.pattern.includes("/")) {
      return repos.map((r) => r.github).filter((g): g is string => typeof g === "string" && g.length > 0);
    }
    return repos.map((r) => r.name);
  }
  if (name === "repos" && kind === "string-array") return repos.map((r) => r.name);
  return null;
}

/**
 * Human-readable example for a string field's placeholder (WM-76 critique r1).
 * Mirrors the pattern heuristics templates.ts seedFor used to seed as values:
 * examples belong in the placeholder, never pre-filled — and never show the
 * raw regex source.
 */
export function placeholderFor(name: string, schema: Record<string, unknown>): string | null {
  if (typeof schema.pattern !== "string") return null;
  // Order matters: a path pattern ("^/…") also contains a slash.
  if (schema.pattern.startsWith("^/")) return "/absolute/path";
  if (schema.pattern.includes("/")) return name === "repo" ? "watt-mind/factory" : "owner/name";
  return null;
}

/**
 * Route validator errors ("$.host: …", `$: missing required property "x"`)
 * to field names; unrouteable errors land under "" (form-level).
 * Pattern mismatches never include the raw regex — they reuse placeholderFor
 * when the field schema is known (WM-86).
 */
export function errorsByField(errors: string[], fields?: FieldSpec[]): Map<string, string[]> {
  const byName = new Map((fields ?? []).map((f) => [f.name, f]));
  const out = new Map<string, string[]>();
  const push = (key: string, msg: string) => {
    const list = out.get(key) ?? [];
    list.push(msg);
    out.set(key, list);
  };
  const humanize = (name: string, msg: string): string => {
    if (!/does not match pattern/.test(msg)) return msg;
    const spec = byName.get(name);
    const example = spec ? placeholderFor(name, spec.schema) : null;
    const hint = example ? ` (e.g. ${example})` : "";
    return msg.replace(/does not match pattern[\s\S]*$/, `does not match expected format${hint}`);
  };
  for (const err of errors) {
    const missing = err.match(/^\$: missing required property "([^"]+)"$/);
    if (missing) {
      push(missing[1], "missing required value");
      continue;
    }
    const fielded = err.match(/^\$\.([A-Za-z0-9_$-]+)((?:[.[])[^:]*)?: (.*)$/);
    if (fielded) {
      const name = fielded[1];
      const rest = `${fielded[2] ?? ""}${fielded[2] ? ": " : ""}${fielded[3]}`.trim();
      push(name, humanize(name, rest));
      continue;
    }
    push("", humanize("", err.replace(/^\$: /, "")));
  }
  return out;
}

/** Field-level errors stay hidden until the control is touched or submit is attempted. */
export function fieldErrorVisible(
  name: string,
  touched: Record<string, boolean>,
  submitAttempted: boolean,
): boolean {
  return submitAttempted || !!touched[name];
}

/** Payload keys the schema does not declare — kept, surfaced, never dropped. */
export function unknownKeys(schema: unknown, payload: Record<string, unknown>): string[] {
  if (!isPlainObject(schema)) return [];
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  return Object.keys(payload).filter((k) => !(k in props));
}
