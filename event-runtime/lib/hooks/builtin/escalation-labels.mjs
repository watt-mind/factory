/**
 * Built-in `approve.before` hook: refuse to auto-approve a dispatch whose
 * ticket carries an escalation or security label (WM-842, WM-865).
 *
 * This is the check `dispatchSafe` in lib/auto-approval.mjs used to run
 * inline (`hasSecurityOrEscalation`), moved onto the hook seam: the same
 * labels are refused by default, with the same reason, at the same point of
 * the guard order — after the dispatch evidence hash is confirmed and before
 * the escalate-path intersection check. It reads only the recheck evidence
 * the chain approval already gathered (`ctx.evidence.ticket.labels`), so a
 * proposal without dispatch evidence (a merge, a ship, a triage apply) is
 * simply allowed, as it was before.
 *
 * The label list is configurable (WM-865). Pass `{ labels }` as the second
 * argument to `hasSecurityOrEscalation`, or set `ctx.config.labels` (also
 * `escalationLabels`). Each entry is an exact name, or a `/pattern/flags`
 * regex literal (and a `RegExp` is accepted on the options object). When
 * unconfigured — missing options, missing `labels`, or a non-array — the
 * defaults below preserve the original three checks. An explicit empty
 * array means "match nothing".
 */

export const id = "factory:escalation-labels";

/** The refusal reason, unchanged from the inline check. */
export const REASON = "escalated_or_security";

/**
 * Default list: the two exact labels the inline check named, plus the
 * case-insensitive `/security/i` pattern that also caught `type:security`
 * and labels like `area:Security-review`.
 */
export const DEFAULT_ESCALATION_LABELS = Object.freeze([
  "ai:escalated",
  "type:security",
  "/security/i",
]);

const REGEXP_LITERAL = /^\/(.+)\/([gimsuy]*)$/;

/**
 * Turn one list entry into a predicate. Exact strings, `/pattern/flags`
 * literals, and `RegExp` values; anything else is ignored.
 *
 * @param {unknown} entry
 * @returns {((label: string) => boolean)|null}
 */
export function parseLabelMatcher(entry) {
  if (entry instanceof RegExp) return (label) => entry.test(label);
  if (typeof entry !== "string" || entry === "") return null;
  const literal = entry.match(REGEXP_LITERAL);
  if (literal) {
    try {
      const re = new RegExp(literal[1], literal[2]);
      return (label) => re.test(label);
    } catch {
      // Invalid regex: treat the original string as an exact label name.
    }
  }
  return (label) => label === entry;
}

/**
 * Resolve the configured list. `undefined`/`null`/non-array → defaults;
 * an array (including empty) is used as-is.
 *
 * @param {{ labels?: unknown, escalationLabels?: unknown }|null|undefined} options
 * @returns {readonly unknown[]}
 */
export function resolveEscalationLabels(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return DEFAULT_ESCALATION_LABELS;
  }
  const raw = Object.hasOwn(options, "labels")
    ? options.labels
    : options.escalationLabels;
  if (raw === undefined || raw === null) return DEFAULT_ESCALATION_LABELS;
  if (!Array.isArray(raw)) return DEFAULT_ESCALATION_LABELS;
  return raw;
}

/**
 * @param {string[]} [labels]
 * @param {{ labels?: unknown, escalationLabels?: unknown }|null|undefined} [options]
 * @returns {boolean}
 */
export function hasSecurityOrEscalation(labels = [], options) {
  const matchers = resolveEscalationLabels(options)
    .map(parseLabelMatcher)
    .filter(Boolean);
  return labels.some((label) => matchers.some((match) => match(label)));
}

/**
 * @param {{
 *   evidence?: { ticket?: { labels?: string[] } } | null,
 *   config?: { labels?: unknown, escalationLabels?: unknown } | null,
 * }} ctx
 * @returns {{ decision: "allow" } | { decision: "deny", reason: string }}
 */
export default function escalationLabels(ctx) {
  const labels = ctx?.evidence?.ticket?.labels ?? [];
  return hasSecurityOrEscalation(labels, ctx?.config)
    ? { decision: "deny", reason: REASON }
    : { decision: "allow" };
}
