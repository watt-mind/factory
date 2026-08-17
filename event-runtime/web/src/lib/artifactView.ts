/**
 * Artifact views — pure half of the `factory.artifact-view/v1` renderer
 * (docs/event-runtime-artifact-views.md §2.4, WM-455). No DOM, no React:
 * this module turns a view sidecar plus a concrete artifact into renderable
 * section models, and `components/ArtifactView.tsx` only draws them.
 *
 * `resolvePointer` mirrors `event-runtime/lib/artifact-view.mjs` line for
 * line — the runtime already proved every pointer resolves in the output
 * *schema*; here a pointer that resolves to `undefined` in a given artifact
 * simply drops its section (optional fields are optional, §2.2).
 */
import { dur } from "../heartbeat";
import type { ArtifactFormat, ArtifactTone, ArtifactView, ArtifactViewSection } from "../types";

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (obj: unknown, key: string): boolean =>
  isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);

/** RFC 6901: split a pointer into unescaped reference tokens; null when malformed. */
export function parsePointer(pointer: unknown): string[] | null {
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
export function resolvePointer(doc: unknown, pointer: unknown): unknown {
  const tokens = parsePointer(pointer);
  if (tokens === null) return undefined;
  let node: unknown = doc;
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
 * A section-relative key is a plain property name or a pointer-ish path
 * (`a/b`, `/a/b`) — the same rule `relativeNode` applies in the runtime
 * validator, so what validated there resolves here.
 */
export function resolveRelative(base: unknown, key: string): unknown {
  if (key === "") return base;
  const tokens = key.startsWith("/") ? parsePointer(key) : key.split("/");
  if (!tokens || tokens.length === 0) return undefined;
  let node: unknown = base;
  for (const token of tokens) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      node = node[Number(token)];
    } else if (isObject(node)) {
      if (!hasOwn(node, token)) return undefined;
      node = node[token];
    } else {
      return undefined;
    }
    if (node === undefined) return undefined;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

/** Tones map onto the theme's four semantic hues; `neutral` and `muted` share idle. */
export const TONE_HUES: Record<ArtifactTone, string> = {
  ok: "var(--hue-ok)",
  warn: "var(--hue-warn)",
  error: "var(--hue-err)",
  muted: "var(--hue-idle)",
  neutral: "var(--hue-idle)",
};

/**
 * The tone a value earns from a (value → tone) map, or `undefined` when the
 * map names no such value. Values are matched by their string form so a
 * boolean `true` finds the `"true"` key merge-scan's view uses.
 */
export function toneFor(value: unknown, toneMap: unknown): ArtifactTone | undefined {
  if (!isObject(toneMap) || value === undefined || value === null) return undefined;
  const key = typeof value === "string" ? value : String(value);
  const tone = toneMap[key];
  return typeof tone === "string" && tone in TONE_HUES ? (tone as ArtifactTone) : undefined;
}

/** A section's tone map for one column/key — table/keyvalue/list nest one map per key. */
function columnToneMap(section: ArtifactViewSection, key: string): unknown {
  const t = section.tone?.[key];
  return isObject(t) ? t : undefined;
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/**
 * Where the closed formats link to. Issues jump to Linear (the same base the
 * Inbox uses); PRs need the repo, which the artifact itself names at `/github`
 * when the agent reports one (merge-scan does) — no repo, no link, chip only.
 */
export const LINEAR_ISSUE_URL = "https://linear.app/watt-mind/issue/";
export const issueHref = (id: string): string => `${LINEAR_ISSUE_URL}${encodeURIComponent(id)}`;
export const prHref = (n: string | number, github: string | null | undefined): string | null =>
  github ? `https://github.com/${github}/pull/${n}` : null;

export interface FormatContext {
  /** `owner/repo`, from the artifact's own `/github` when present. */
  github?: string | null;
}

/**
 * What a formatted value renders as. Chips are jump targets (`issue`, `pr`,
 * `run`), `state` wears the run-state hue, `link` opens in a new tab, `json`
 * is a nested value the caller draws compactly, everything else is text.
 */
export type Formatted =
  | { kind: "empty" }
  | { kind: "text"; text: string; mono: boolean; title?: string }
  | { kind: "chip"; chip: "issue" | "pr" | "run"; id: string; text: string; href: string | null }
  | { kind: "state"; state: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "json"; value: unknown };

const asText = (v: unknown): string => (typeof v === "string" ? v : String(v));

/** Whether a string reads as prose (spaces) rather than an identifier. */
const looksLikeIdentifier = (s: string): boolean => !/\s/.test(s);

const isScalar = (v: unknown): boolean =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * `formatValue(value, format)` for the closed §2.2 format set. Unknown or
 * absent format falls through to the plain rendering, so a view can only
 * *add* meaning to a value, never hide one.
 */
export function formatValue(value: unknown, format?: ArtifactFormat, ctx: FormatContext = {}): Formatted {
  if (value === undefined || value === null || value === "") return { kind: "empty" };
  if (!isScalar(value)) return { kind: "json", value };
  const text = asText(value);
  switch (format) {
    case "issue":
      return { kind: "chip", chip: "issue", id: text, text, href: issueHref(text) };
    case "pr": {
      const n = text.replace(/^#/, "");
      return { kind: "chip", chip: "pr", id: n, text: `#${n}`, href: prHref(n, ctx.github) };
    }
    case "run":
      return { kind: "chip", chip: "run", id: text, text: shortRunId(text), href: null };
    case "state":
      return { kind: "state", state: text };
    case "url":
      return { kind: "link", href: text, text };
    case "sha":
      return { kind: "text", text: text.slice(0, 12), mono: true, title: text };
    case "repo":
      return { kind: "text", text, mono: true };
    case "duration":
      // Seconds — the runtime's own duration fields are `*Seconds`; `dur` takes ms.
      return typeof value === "number"
        ? { kind: "text", text: dur(value * 1000), mono: true, title: `${value}s` }
        : { kind: "text", text, mono: looksLikeIdentifier(text) };
    case "datetime": {
      const ms = typeof value === "number" ? value : Date.parse(text);
      return Number.isNaN(ms)
        ? { kind: "text", text, mono: false }
        : { kind: "text", text: new Date(ms).toLocaleString(), mono: false, title: new Date(ms).toISOString() };
    }
    case "bytes":
      return typeof value === "number"
        ? { kind: "text", text: formatBytes(value), mono: true, title: `${value} B` }
        : { kind: "text", text, mono: true };
    case "count":
      return typeof value === "number"
        ? { kind: "text", text: value.toLocaleString(), mono: true }
        : { kind: "text", text, mono: true };
    default:
      return typeof value === "string"
        ? { kind: "text", text, mono: looksLikeIdentifier(text) }
        : { kind: "text", text, mono: true };
  }
}

/** `run_ec9c87f9-…` → `run_ec9c87f9`, the app-wide short form (`shortId` in ui.tsx). */
function shortRunId(id: string): string {
  const sep = id.indexOf("_");
  if (sep === -1) return id;
  const body = id.slice(sep + 1);
  return body.length <= 8 ? id : id.slice(0, sep + 1) + body.slice(0, 8);
}

/** Byte counts as the Artifacts view has always shown them (moved here so both stay pure). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Section models
// ---------------------------------------------------------------------------

export interface Cell {
  key: string;
  value: Formatted;
  tone?: ArtifactTone;
}

export interface TableRow {
  /** Index in the source array — stable across grouping, used as the React key. */
  index: number;
  cells: Cell[];
  /** `expand` keys that are present on this row, in view order. */
  expand: Cell[];
  raw: unknown;
}

export interface RowGroup {
  key: string;
  label: string;
  tone?: ArtifactTone;
  rows: TableRow[];
}

export type SectionModel =
  | {
      as: "table";
      label: string | undefined;
      columns: string[];
      rows: TableRow[];
      /** Present only when the view names `groupBy`; rows are then also inside groups. */
      groups: RowGroup[] | null;
      hasExpand: boolean;
    }
  | { as: "keyvalue"; label: string | undefined; entries: Cell[] }
  | { as: "list"; label: string | undefined; items: Cell[] }
  | { as: "badge"; label: string | undefined; value: string; tone?: ArtifactTone }
  | { as: "code"; label: string | undefined; text: string; language?: string }
  | { as: "prose"; label: string | undefined; text: string };

const groupLabel = (v: unknown): string => (v === undefined || v === null || v === "" ? "—" : asText(v));

/**
 * Group table rows by one item property, first-seen order, so the artifact's
 * own ordering (which the agent chose) survives. Rows without the property
 * gather under `—` at the end.
 */
export function groupRows(rows: TableRow[], groupBy: string, toneMap?: unknown): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  let missing: RowGroup | null = null;
  for (const row of rows) {
    const value = resolveRelative(row.raw, groupBy);
    if (value === undefined || value === null || value === "") {
      missing ??= { key: " missing", label: "—", rows: [] };
      missing.rows.push(row);
      continue;
    }
    const key = asText(value);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: groupLabel(value), tone: toneFor(value, toneMap), rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const out = [...groups.values()];
  if (missing) out.push(missing);
  return out;
}

function cellFor(section: ArtifactViewSection, item: unknown, key: string, ctx: FormatContext): Cell {
  const raw = resolveRelative(item, key);
  return {
    key,
    value: formatValue(raw, section.formats?.[key], ctx),
    tone: toneFor(raw, columnToneMap(section, key)),
  };
}

function tableSection(section: ArtifactViewSection, node: unknown, ctx: FormatContext): SectionModel | null {
  if (!Array.isArray(node)) return null;
  const columns = section.columns ?? [];
  const expandKeys = section.expand ?? [];
  const rows: TableRow[] = node.map((item, index) => ({
    index,
    cells: columns.map((c) => cellFor(section, item, c, ctx)),
    expand: expandKeys
      .map((k) => cellFor(section, item, k, ctx))
      .filter((cell) => cell.value.kind !== "empty"),
    raw: item,
  }));
  const groups = section.groupBy ? groupRows(rows, section.groupBy, columnToneMap(section, section.groupBy)) : null;
  return {
    as: "table",
    label: section.label,
    columns,
    rows,
    groups,
    hasExpand: rows.some((r) => r.expand.length > 0),
  };
}

function keyvalueSection(section: ArtifactViewSection, node: unknown, ctx: FormatContext): SectionModel | null {
  if (!isObject(node)) {
    // A scalar keyvalue: one row whose label is the section's — a heading
    // over a single row would just say the same word twice.
    if (!isScalar(node)) return null;
    const value = formatValue(node, section.formats?.[""], ctx);
    if (value.kind === "empty") return null;
    return {
      as: "keyvalue",
      label: undefined,
      entries: [{ key: section.label ?? lastToken(section.path), value, tone: toneFor(node, section.tone?.[""]) }],
    };
  }
  const keys = section.keys ?? Object.keys(node);
  const entries = keys
    .map((k) => cellFor(section, node, k, ctx))
    .filter((cell) => cell.value.kind !== "empty");
  if (entries.length === 0) return null;
  return { as: "keyvalue", label: section.label, entries };
}

function listSection(section: ArtifactViewSection, node: unknown, ctx: FormatContext): SectionModel | null {
  if (!Array.isArray(node)) return null;
  const items: Cell[] = node.map((item, index) => {
    const raw = section.itemLabel ? resolveRelative(item, section.itemLabel) : item;
    return {
      key: String(index),
      value: formatValue(raw, section.formats?.[section.itemLabel ?? ""], ctx),
      tone: toneFor(raw, section.tone?.[section.itemLabel ?? ""]),
    };
  });
  return { as: "list", label: section.label, items };
}

const lastToken = (pointer: string): string => {
  const tokens = parsePointer(pointer) ?? [];
  return tokens.length ? tokens[tokens.length - 1] : "value";
};

/**
 * `sectionsFor(view, artifact)` → renderable section models, in view order.
 * A section whose pointer does not resolve in this artifact is dropped, as
 * is one whose value has the wrong shape for its `as` (a table over a
 * non-array) — the JSON stays one Raw toggle away, so dropping is honest,
 * inventing a rendering is not.
 */
export function sectionsFor(view: ArtifactView, artifact: unknown): SectionModel[] {
  const ctx: FormatContext = { github: githubOf(artifact) };
  const out: SectionModel[] = [];
  for (const section of view.sections ?? []) {
    const node = resolvePointer(artifact, section.path);
    if (node === undefined || node === null) continue;
    let model: SectionModel | null = null;
    switch (section.as) {
      case "table":
        model = tableSection(section, node, ctx);
        break;
      case "keyvalue":
        model = keyvalueSection(section, node, ctx);
        break;
      case "list":
        model = listSection(section, node, ctx);
        break;
      case "badge":
        if (isScalar(node)) {
          model = { as: "badge", label: section.label, value: asText(node), tone: toneFor(node, section.tone) };
        }
        break;
      case "code":
        if (typeof node === "string") model = { as: "code", label: section.label, text: node, language: section.language };
        else if (!isScalar(node)) model = { as: "code", label: section.label, text: JSON.stringify(node, null, 2), language: "json" };
        break;
      case "prose":
        if (isScalar(node)) model = { as: "prose", label: section.label, text: asText(node) };
        break;
    }
    if (model) out.push(model);
  }
  return out;
}

/** The artifact's own `owner/repo` when it reports one — the only place a PR link can come from. */
export function githubOf(artifact: unknown): string | null {
  const g = isObject(artifact) ? artifact.github : undefined;
  return typeof g === "string" && /^[^/\s]+\/[^/\s]+$/.test(g) ? g : null;
}

/** The header: prose summary and status badge (§2.2 `summary`, `status`). */
export interface ViewHeader {
  title: string | null;
  summary: string | null;
  status: { label: string; value: string; tone?: ArtifactTone } | null;
}

export function headerFor(view: ArtifactView, artifact: unknown, schema?: unknown): ViewHeader {
  const schemaTitle = isObject(schema) && typeof schema.title === "string" ? schema.title : null;
  const summary = view.summary !== undefined ? resolvePointer(artifact, view.summary) : undefined;
  const statusValue = view.status ? resolvePointer(artifact, view.status.path) : undefined;
  return {
    title: view.title ?? schemaTitle,
    summary: typeof summary === "string" && summary.trim() ? summary : null,
    status:
      view.status && isScalar(statusValue) && statusValue !== null && statusValue !== ""
        ? { label: lastToken(view.status.path), value: asText(statusValue), tone: toneFor(statusValue, view.status.tone) }
        : null,
  };
}

/**
 * Whether this view says anything at all about this artifact — the gate the
 * Artifacts inspector uses before swapping its text preview for the view
 * (a transcript that happens to parse as JSON must not wear a merge-plan).
 */
export function viewApplies(view: ArtifactView | null | undefined, artifact: unknown): view is ArtifactView {
  if (!view || !isObject(artifact)) return false;
  const h = headerFor(view, artifact);
  return h.summary !== null || h.status !== null || sectionsFor(view, artifact).length > 0;
}
