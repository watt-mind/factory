/**
 * Keyed list filters (webui UX doc Proposal 4) — `agent:ci-doctor`,
 * `state:failed`, `source:keephq`, `is:stale`, plus whatever bare words are
 * left over.
 *
 * One parser and one matcher, shared by Runs, Events and Proposals. Each view
 * hands in a facet table naming the fields its rows actually carry, and that is
 * what makes a keyed token honest: `agent:run` is only ever tested against the
 * agent field, so a run id that happens to contain "run" can never satisfy it.
 * Bare words keep the old behaviour — a plain substring over the columns the
 * view already searched — because that is what pasting an id expects to do.
 */

import type { AdmittedEvent, InboxItem, Proposal, RunListItem } from "./types";

/** What a field accessor may return: one value, several, or nothing. */
export type FieldValue = string | null | undefined | readonly (string | null | undefined)[];

export interface FilterFacets<T, C = undefined> {
  /**
   * `key:value` fields these rows have, by canonical key — the row property to
   * read, or a function when the value is not one property.
   */
  fields: Record<string, Extract<keyof T, string> | ((row: T) => FieldValue)>;
  /** `is:flag` questions these rows can answer, with the copy that explains them. */
  flags: Record<string, { help: string; test: (row: T, ctx: C) => boolean }>;
  /** What a bare word searches. */
  text: (row: T) => FieldValue;
  /** Spellings that mean a canonical key — an operator reaches for both. */
  aliases?: Record<string, string>;
  /** Available enum suggestions per field. */
  values?: Record<string, readonly string[]>;
}

export interface FilterSuggestion {
  id: string;
  kind: "facet" | "value" | "flag";
  label: string;
  insertText: string;
  description?: string;
  field?: string;
  hue?: string;
}

const RUN_STATES = ["proposed", "approved", "queued", "leased", "running", "verifying", "completed", "refused", "failed", "timed_out", "cancelled"] as const;
const ADAPTERS = ["claude", "codex", "fake", "actions", "command"] as const;
const EVENT_STATUSES = ["admitted", "planned", "noop", "human_needed", "dead_lettered"] as const;
const PROPOSAL_STATUSES = ["open", "approved", "rejected", "superseded", "resolved"] as const;
const DECISIONS = ["run", "human_needed", "noop"] as const;

export const DEFAULT_FIELD_VALUES: Record<string, readonly string[]> = {
  state: RUN_STATES,
  decision: DECISIONS,
  adapter: ADAPTERS,
  status: [...PROPOSAL_STATUSES, ...EVENT_STATUSES],
};

/**
 * Every key any list understands. A word whose key is in here was meant as a
 * filter, so a view without that field says so — an "impossible" chip that
 * matches nothing — instead of quietly searching for the literal text. A key
 * outside the set (`linear:OPS-1`, `https://…`) was never a filter and stays
 * free text, which is why this list is closed rather than "anything with a colon".
 */
const FILTER_KEYS = new Set([
  "is",
  "id",
  "run",
  "state",
  "status",
  "agent",
  "adapter",
  "reason",
  "source",
  "event",
  "type",
  "subject",
  "proposal",
  "decision",
  "repo",
]);

interface Span {
  /** The word as typed, including any quotes — what dismissal cuts back out. */
  raw: string;
  start: number;
  end: number;
}

export type FilterToken =
  | ({ kind: "text"; value: string } & Span)
  | ({ kind: "field"; key: string; typedKey: string; value: string; supported: boolean } & Span)
  | ({ kind: "flag"; flag: string; help: string; supported: boolean } & Span);

/** The tokens that get a chip: everything the operator spelled as a filter. */
export type FilterChipToken = Extract<FilterToken, { kind: "field" } | { kind: "flag" }>;

export interface FilterQuery {
  tokens: FilterToken[];
  /** Keyed tokens and flags, in the order typed — what the chip bar renders. */
  chips: FilterChipToken[];
  isEmpty: boolean;
  /** Canonical field keys this list supports, for the chip and input help. */
  fields: string[];
  /** `is:` flags this list supports. */
  flags: string[];
}

const KEYED = /^([A-Za-z][A-Za-z0-9_-]*):([\s\S]*)$/;

/** Quotes group a value with spaces (`subject:"deploy failed"`); they are not data. */
const unquote = (text: string) => text.replace(/"/g, "");

/**
 * Split on whitespace, but not inside quotes, keeping each word's offsets — a
 * chip can only be dismissed by cutting exactly the word it came from back out
 * of the raw query, which stays the single source of truth.
 */
export function splitWords(input: string): Span[] {
  const words: Span[] = [];
  let start = -1;
  let quoted = false;
  for (let i = 0; i <= input.length; i++) {
    const ch: string | undefined = input[i];
    if (start < 0) {
      if (ch === undefined || /\s/.test(ch)) continue;
      start = i;
      quoted = false;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === undefined || (!quoted && /\s/.test(ch))) {
      words.push({ raw: input.slice(start, i), start, end: i });
      start = -1;
    }
  }
  return words;
}

/**
 * Finds the token under cursor for autocomplete inspection.
 * Returns the word span if cursor is on/at the boundary of a word, or an empty span at cursor.
 */
export function getActiveFilterToken(input: string, cursorPos: number): Span {
  const safeCursor = Math.max(0, Math.min(cursorPos, input.length));
  const words = splitWords(input);
  for (const word of words) {
    if (safeCursor >= word.start && safeCursor <= word.end) {
      return word;
    }
  }
  return { raw: "", start: safeCursor, end: safeCursor };
}

export function parseFilterQuery<T, C>(input: string, facets: FilterFacets<T, C>): FilterQuery {
  const tokens: FilterToken[] = [];
  for (const span of splitWords(input)) {
    const keyed = KEYED.exec(span.raw);
    const typedKey = keyed ? keyed[1].toLowerCase() : "";
    const key = facets.aliases?.[typedKey] ?? typedKey;
    const value = keyed ? unquote(keyed[2]).trim() : "";

    if (keyed && (key === "is" || FILTER_KEYS.has(key) || key in facets.fields)) {
      // `agent:` with nothing after it is half-typed, not a filter that matches
      // nothing: the list must not blank out between `agent:` and `agent:c`.
      if (!value) continue;
      if (key === "is") {
        const flag = value.toLowerCase();
        const known = facets.flags[flag];
        tokens.push({
          kind: "flag",
          flag,
          help: known?.help ?? "",
          supported: !!known,
          ...span,
        });
      } else {
        tokens.push({
          kind: "field",
          key,
          typedKey,
          value: value.toLowerCase(),
          supported: key in facets.fields,
          ...span,
        });
      }
      continue;
    }

    const text = unquote(span.raw).trim();
    if (text) tokens.push({ kind: "text", value: text.toLowerCase(), ...span });
  }

  return {
    tokens,
    chips: tokens.filter((t): t is FilterChipToken => t.kind !== "text"),
    isEmpty: tokens.length === 0,
    fields: Object.keys(facets.fields),
    flags: Object.keys(facets.flags),
  };
}

const read = <T,>(field: Extract<keyof T, string> | ((row: T) => FieldValue), row: T): FieldValue =>
  typeof field === "function" ? field(row) : (row[field] as FieldValue);

const asList = (value: FieldValue): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && v !== "");

/**
 * A keyed value matches its field whole or at a word start inside it:
 * `agent:ci-doctor` finds `factory/ci-doctor@2`, `status:human` finds
 * `human_needed`, `state:fail` finds `FAILED` — and `state:ail` finds nothing.
 * An anywhere-substring is what makes a filter feel haunted.
 */
function valueMatches(value: string, needle: string): boolean {
  for (let i = 0; i + needle.length <= value.length; i++) {
    if (i > 0 && /[a-z0-9]/.test(value[i - 1])) continue;
    if (value.startsWith(needle, i)) return true;
  }
  return false;
}

const fieldMatches = (value: FieldValue, needle: string) =>
  asList(value).some((v) => valueMatches(v.toLowerCase(), needle));

const textMatches = (value: FieldValue, needle: string) =>
  asList(value).some((v) => v.toLowerCase().includes(needle));

/**
 * Same key twice is an either/or (`state:failed state:refused`); different keys
 * narrow. A token this list cannot answer matches nothing at all, so an
 * impossible query reads as an empty list next to a flagged chip rather than
 * silently filtering on less than the operator asked for.
 */
export function matchesFilterQuery<T, C = undefined>(
  row: T,
  query: FilterQuery,
  facets: FilterFacets<T, C>,
  ctx: C,
): boolean {
  if (query.isEmpty) return true;
  const byKey = new Map<string, string[]>();
  for (const token of query.tokens) {
    if (token.kind === "text") {
      if (!textMatches(facets.text(row), token.value)) return false;
    } else if (token.kind === "flag") {
      const flag = facets.flags[token.flag];
      if (!flag || !flag.test(row, ctx)) return false;
    } else {
      const group = byKey.get(token.key);
      if (group) group.push(token.value);
      else byKey.set(token.key, [token.value]);
    }
  }
  for (const [key, needles] of byKey) {
    const field = facets.fields[key];
    if (!field) return false;
    const value = read(field, row);
    if (!needles.some((needle) => fieldMatches(value, needle))) return false;
  }
  return true;
}

/** Dismiss one chip by cutting its word back out of the raw query. */
export function removeFilterToken(input: string, token: FilterToken): string {
  return `${input.slice(0, token.start)} ${input.slice(token.end)}`.replace(/\s+/g, " ").trim();
}

/** What the chip says — the key as typed, so chip and input never disagree. */
export const chipLabel = (token: FilterChipToken): string =>
  token.kind === "flag" ? `is:${token.flag}` : `${token.typedKey}:${token.value}`;

/** Why this chip does (or cannot) narrow anything, on hover and for screen readers. */
export function chipHelp(token: FilterChipToken, query: FilterQuery): string {
  if (token.kind === "flag") {
    if (token.supported) return token.help;
    const flags = query.flags.map((f) => `is:${f}`).join(", ");
    return `Unknown is:${token.flag}. ${flags || "none"}.`;
  }
  if (token.supported) return `Matches ${token.key} at a word start.`;
  return `No ${token.key} field. ${query.fields.join(", ")}.`;
}

/** The syntax, on the input itself — cheaper than a help dialog nobody opens. */
export function filterHint(query: FilterQuery): string {
  const keys = query.fields.map((f) => `${f}:`).join(" ");
  const flags = query.flags.map((f) => `is:${f}`).join(" ");
  return `${keys}${flags ? ` ${flags}` : ""}. Esc clears.`;
}

/**
 * An open proposal whose run already left PROPOSED was raced (cancelled from
 * Runs, say) and can never be approved — the list calls that stale, and the
 * `is:stale` facet has to agree with the row wash that shows it. Decided proposals
 * (status !== "open") are audit records whose runs are naturally terminal, so
 * they are never stale.
 */
export function proposalRunState(
  proposal: { runId: string | null; status?: string },
  runStates: ReadonlyMap<string, string>,
): string | null {
  if (proposal.status && proposal.status !== "open") return null;
  const state = proposal.runId ? runStates.get(proposal.runId) : undefined;
  return state && state !== "PROPOSED" ? state : null;
}

/** Runs: which runs a stale worker is still holding (GET /status anomalies). */
export interface RunFilterContext {
  staleRuns: ReadonlySet<string>;
}

export const RUN_FACETS: FilterFacets<RunListItem, RunFilterContext> = {
  fields: {
    run: (r) => r.runId,
    state: (r) => r.state,
    agent: (r) => r.agent,
    adapter: (r) => r.adapter,
    reason: (r) => r.reasonCode,
    source: (r) => r.eventSource,
    event: (r) => r.eventId,
    repo: (r) => r.repos,
  },
  flags: {
    stale: {
      help: "Stale worker heartbeat.",
      test: (r, ctx) => ctx.staleRuns.has(r.runId),
    },
  },
  text: (r) => [r.runId, r.state, r.agent, r.adapter, r.reasonCode, r.eventId],
  aliases: { id: "run", status: "state" },
  values: {
    state: RUN_STATES,
    adapter: ADAPTERS,
  },
};

export const INBOX_FACETS: FilterFacets<InboxItem, undefined> = {
  fields: {
    kind: (item) => item.kind,
    repo: (item) => item.refs.repo,
    issue: (item) => item.refs.issue,
  },
  flags: {
    open: {
      help: "Not acknowledged or resolved.",
      test: (item) => !item.ackedAt && !item.resolvedAt,
    },
    acked: {
      help: "Acknowledged but not resolved.",
      test: (item) => !!item.ackedAt && !item.resolvedAt,
    },
    resolved: {
      help: "Resolved inbox item.",
      test: (item) => !!item.resolvedAt,
    },
  },
  text: (item) => [item.title, item.body],
  values: {
    kind: [
      "decision_needed", "proposal_expired", "BLOCKED", "ESCALATED", "human_needed",
      "CI RED", "SMOKE RED", "CIRCUIT BREAKER", "RC READY",
    ],
  },
};

/**
 * An event row as the Events view filters it: the admitted event plus the
 * planner's reason for it (WM-594), joined on the client from the proposal /
 * refused run — the events API does not carry it, so it is optional here.
 */
export type EventFilterRow = AdmittedEvent & { decisionReason?: string | null };

export const EVENT_FACETS: FilterFacets<EventFilterRow, undefined> = {
  fields: {
    event: (e) => e.eventId,
    source: (e) => e.source,
    type: (e) => e.type,
    subject: (e) => e.subject,
    status: (e) => e.status,
    proposal: (e) => e.proposalId,
    run: (e) => e.runId,
    repo: (e) => e.repos,
    reason: (e) => e.decisionReason,
  },
  flags: {
    stale: {
      help: "Admitted, no proposal or run.",
      test: (e) => e.status === "admitted" && !e.proposalId && !e.runId,
    },
  },
  text: (e) => [e.eventId, e.source, e.type, e.subject],
  aliases: { id: "event", state: "status" },
  values: {
    status: EVENT_STATUSES,
  },
};

/** Proposals: the run states the open list is watching, for `is:stale`. */
export interface ProposalFilterContext {
  runStates: ReadonlyMap<string, string>;
}

export const PROPOSAL_FACETS: FilterFacets<Proposal, ProposalFilterContext> = {
  fields: {
    id: (p) => p.id,
    agent: (p) => p.agent,
    decision: (p) => p.decision,
    status: (p) => p.status,
    reason: (p) => p.reason,
    source: (p) => p.eventSource,
    event: (p) => p.eventId,
    run: (p) => p.runId,
    repo: (p) => p.repos,
  },
  flags: {
    stale: {
      help: "Run left PROPOSED.",
      test: (p, ctx) => proposalRunState(p, ctx.runStates) !== null,
    },
    expired: {
      help: "TTL expired.",
      test: (p) => p.expired,
    },
  },
  text: (p) => [p.id, p.agent, p.decision, p.status, p.eventId, p.reason],
  aliases: { proposal: "id", state: "status" },
  values: {
    decision: DECISIONS,
    status: PROPOSAL_STATUSES,
  },
};

/**
 * Computes autocomplete suggestions based on the active token and provided facets or query.
 */
export function getFilterSuggestions<T, C>(
  tokenRaw: string,
  facets?: FilterFacets<T, C>,
  query?: FilterQuery,
  customHues?: (field: string, val: string) => string | undefined,
): FilterSuggestion[] {
  const fields = facets ? Object.keys(facets.fields) : (query?.fields ?? []);
  const flags = facets ? Object.keys(facets.flags) : (query?.flags ?? []);
  const aliases = facets?.aliases ?? {};
  const values = facets?.values ?? {};

  const suggestions: FilterSuggestion[] = [];
  const colonIdx = tokenRaw.indexOf(":");

  if (colonIdx === -1) {
    const prefix = tokenRaw.toLowerCase();
    // 1. Facet fields
    for (const field of fields) {
      if (!prefix || field.toLowerCase().startsWith(prefix)) {
        suggestions.push({
          id: `facet:${field}`,
          kind: "facet",
          label: `${field}:`,
          insertText: `${field}:`,
          description: `Filter by ${field}`,
        });
      }
    }
    // Facet aliases
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (!fields.includes(alias) && (!prefix || alias.toLowerCase().startsWith(prefix))) {
        suggestions.push({
          id: `facet:${alias}`,
          kind: "facet",
          label: `${alias}:`,
          insertText: `${alias}:`,
          description: `Filter by ${canonical}`,
        });
      }
    }
    // 2. Flags (e.g. is:stale)
    for (const flag of flags) {
      const flagLabel = `is:${flag}`;
      if (!prefix || flagLabel.startsWith(prefix) || flag.toLowerCase().startsWith(prefix) || "is:".startsWith(prefix)) {
        suggestions.push({
          id: `flag:${flag}`,
          kind: "flag",
          label: flagLabel,
          insertText: `${flagLabel} `,
          description: facets?.flags?.[flag]?.help ?? `Filter by is:${flag}`,
        });
      }
    }
  } else {
    const rawKey = tokenRaw.slice(0, colonIdx).toLowerCase();
    const valPrefix = tokenRaw.slice(colonIdx + 1).toLowerCase();
    const canonicalKey = aliases[rawKey] ?? rawKey;

    if (canonicalKey === "is") {
      for (const flag of flags) {
        if (!valPrefix || flag.toLowerCase().startsWith(valPrefix)) {
          suggestions.push({
            id: `flag:${flag}`,
            kind: "flag",
            label: `is:${flag}`,
            insertText: `is:${flag} `,
            description: facets?.flags?.[flag]?.help ?? `Filter by is:${flag}`,
          });
        }
      }
    } else {
      const enumVals = values[canonicalKey] ?? values[rawKey] ?? DEFAULT_FIELD_VALUES[canonicalKey] ?? [];
      for (const val of enumVals) {
        if (!valPrefix || val.toLowerCase().startsWith(valPrefix)) {
          const hue = customHues?.(canonicalKey, val);
          suggestions.push({
            id: `value:${rawKey}:${val}`,
            kind: "value",
            field: rawKey,
            label: val,
            insertText: `${rawKey}:${val} `,
            hue,
            description: `${rawKey}:${val}`,
          });
        }
      }
    }
  }

  return suggestions;
}

