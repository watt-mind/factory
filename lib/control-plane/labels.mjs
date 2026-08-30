/**
 * Tracker-neutral label and description helpers for the ControlPlane
 * (WM-797). Copied from the protocol `tools/linear.mjs` already enforces so
 * the Linear adapter and the memory fake share one implementation. The
 * call-site migration will import these from here instead of carrying a
 * second copy in the CLI.
 */

/** The eight values that resolve; `type:chore` fails the mutation. */
export const TYPE_LABELS = [
  "bug",
  "feature",
  "ui-ux",
  "security",
  "performance",
  "maintenance",
  "docs",
  "a11y",
];
export const SOURCE_LABELS = ["agent", "human", "sentry", "client-support"];

/** The tier keys `config/policy.yaml` accepts (docs/event-runtime-dispatch.md §"Per-ticket model tier"). */
export const TIER_LABELS = ["light", "standard", "strong"];

export const AGENT_READY_LABEL = "ai:agent-ready";
export const IN_PROGRESS_LABEL = "ai:in-progress";
export const BLOCKED_LABEL = "ai:blocked";

/** GitHub rejects issue and comment bodies above this many characters. */
export const GITHUB_BODY_MAX_LENGTH = 65_536;

const TRUNCATION_MARKER = (count) => `… [truncated ${count} chars]`;

/**
 * Return the last safe character boundary at or before `limit`.
 *
 * A truncation marker must not be emitted inside a fenced code block: it
 * would turn the remainder of a report into code and hide the marker. When a
 * limit falls in a fence, discard that fence from its opening delimiter.
 */
function markdownFenceBoundary(text, limit) {
  const beforeLimit = text.slice(0, limit);
  const fences = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*/g;
  let openAt = null;
  let openChar = null;
  let openLength = 0;
  let match;
  while ((match = fences.exec(beforeLimit))) {
    const marker = match[2];
    const markerStart = match.index + match[1].length;
    if (openAt === null) {
      openAt = markerStart;
      openChar = marker[0];
      openLength = marker.length;
    } else if (marker[0] === openChar && marker.length >= openLength) {
      openAt = null;
      openChar = null;
      openLength = 0;
    }
  }
  return openAt === null ? limit : openAt;
}

/**
 * Clamp a Markdown body for GitHub without losing the optional run stamp.
 *
 * The marker's count is the number of source characters removed from the
 * report (the retained `run:` trailer is not counted). The helper deliberately
 * backs up to a fence opening rather than emitting an unterminated code fence.
 */
export function clampGithubBody(body, { max = GITHUB_BODY_MAX_LENGTH } = {}) {
  const text = String(body ?? "");
  if (text.length <= max) return text;

  // stampRun() appends this exact trailer. Keep it outside the truncatable
  // report so long logs cannot erase the attribution that identifies a run.
  const trailerMatch = /\n\nrun:[^\n]+$/.exec(text);
  const trailer = trailerMatch?.[0] ?? "";
  const report = trailer ? text.slice(0, -trailer.length) : text;

  let cut = Math.min(report.length, max - trailer.length);
  for (let attempt = 0; attempt < 4; attempt++) {
    cut = markdownFenceBoundary(report, Math.max(0, cut));
    const prefix = report.slice(0, cut);
    const separator =
      prefix.length === 0 ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
    const marker = TRUNCATION_MARKER(report.length - cut);
    const candidate = `${prefix}${separator}${marker}${trailer}`;
    if (candidate.length <= max) return candidate;
    cut -= candidate.length - max;
  }

  // A normal GitHub-sized limit always accommodates the marker. This fallback
  // keeps the helper total for callers that supply a deliberately tiny max.
  return `${TRUNCATION_MARKER(report.length)}${trailer}`.slice(0, max);
}

/** Reject label typos before the tracker does, with a useful message. */
export function validateLabels(names) {
  const bad = [];
  for (const n of names) {
    if (n.startsWith("type:") && !TYPE_LABELS.includes(n.slice(5))) {
      bad.push(`${n} — type:* must be one of ${TYPE_LABELS.join(" ")}`);
    }
    if (n.startsWith("source:") && !SOURCE_LABELS.includes(n.slice(7))) {
      bad.push(`${n} — source:* must be one of ${SOURCE_LABELS.join(" ")}`);
    }
    if (n.startsWith("tier:") && !TIER_LABELS.includes(n.slice(5))) {
      bad.push(`${n} — tier:* must be one of ${TIER_LABELS.join(" ")}`);
    }
  }
  return bad;
}

/**
 * The label set after an add/remove, as ids.
 *
 * Trackers that take the COMPLETE label set (Linear's issueUpdate) silently
 * drop every other label if you pass only the ones you want added. That is
 * the sharp edge this function exists to blunt.
 */
export function resolveLabelIds(
  currentNames,
  { add = [], remove = [] },
  allLabels,
) {
  const idOf = (n) => allLabels.find((l) => l.name === n)?.id;
  const dropped = new Set(remove);
  const kept = currentNames.filter((n) => !dropped.has(n));
  return [...new Set([...kept, ...add].map(idOf).filter(Boolean))];
}

/**
 * Harness name -> the `agent:*` label that exists in the workspace.
 *
 * The Claude harness is `claude` on the command line but `agent:claude-code`
 * in Linear, and nothing enforces that they agree. A wrong name just means
 * the ticket never says which harness holds it.
 */
export const agentLabel = (harness) =>
  `agent:${harness === "claude" ? "claude-code" : harness}`;

/**
 * Claiming drops `ai:agent-ready` and adds `ai:in-progress` + the agent label.
 * agent-ready means "waiting to be picked up" — keeping it alongside
 * ai:in-progress leaves the ticket asserting two lifecycle states at once.
 */
export function claimLabels(currentNames, harness) {
  const mine = agentLabel(harness);
  return {
    add: [IN_PROGRESS_LABEL, mine],
    remove: [
      AGENT_READY_LABEL,
      ...currentNames.filter((n) => n.startsWith("agent:") && n !== mine),
    ],
  };
}

/**
 * The exact inverse of {@link claimLabels}: give the ticket back (WM-1024).
 *
 * `to: "Todo"` must produce a **dispatchable** ticket — `Todo` + no assignee
 * is not enough, the dispatchable predicate (docs/protocol.md §4) also
 * requires `ai:agent-ready`. Releasing without it does not re-queue the
 * ticket, it makes it invisible: the board still shows `Todo`, every view
 * looks healthy, and no dispatcher will ever pick it up again. Three tickets
 * (WM-1008, WM-1015, WM-534) were lost this way in one night, each after a
 * transient test failure.
 *
 * `to: "Blocked"` is the opposite requirement: `ai:blocked` and explicitly
 * NOT `ai:agent-ready`, or a ticket a human must look at re-enters the queue
 * and loops.
 *
 * Both drop every `agent:*` label. A stale one claims a harness still holds
 * work it has already given up, which is what made the casualties look
 * claimed rather than dropped.
 *
 * @param {string[]} currentNames
 * @param {{ to?: "Todo"|"Blocked" }} [opts]
 * @returns {{ add: string[], remove: string[] }}
 */
export function releaseLabels(currentNames, { to = "Todo" } = {}) {
  const staleAgents = currentNames.filter((n) => n.startsWith("agent:"));
  if (to === "Blocked") {
    return {
      add: [BLOCKED_LABEL],
      remove: [IN_PROGRESS_LABEL, AGENT_READY_LABEL, ...staleAgents],
    };
  }
  return {
    add: [AGENT_READY_LABEL],
    remove: [IN_PROGRESS_LABEL, BLOCKED_LABEL, ...staleAgents],
  };
}

/** Build an idempotent description update for `appendDetail`. */
export function appendIssueDetail(currentDescription, rawDetail) {
  const detail = String(rawDetail ?? "").trim();
  if (!detail) throw new Error("detail must not be empty");

  const current = currentDescription ?? "";
  if (current.includes(detail))
    return { description: current, appended: false };

  const separator =
    current.length === 0 || current.endsWith("\n\n")
      ? ""
      : current.endsWith("\n")
        ? "\n"
        : "\n\n";
  return { description: `${current}${separator}${detail}\n`, appended: true };
}

/**
 * Attribution stamp (OPS-76). Factory spawns set FACTORY_RUN_ID to the
 * transcript basename; stamping it here makes every comment and filed issue
 * joinable back to the exact run that wrote it. Skipped when the id is
 * already in the body and when unset (interactive human use stays clean).
 *
 * Off by default so the public tracker timeline stays clean: run→ticket
 * attribution already lives in the runtime DB (lifecycle_events), so the
 * visible `run:<id>` tail on every comment is redundant noise. Opt back in
 * with FACTORY_COMMENT_ATTRIBUTION=1 when a deployment wants it in-band.
 */
export function stampRun(body) {
  if (process.env.FACTORY_COMMENT_ATTRIBUTION !== "1") return body;
  const id = process.env.FACTORY_RUN_ID;
  if (!id || !body || body.includes(`run:${id}`)) return body;
  return `${body}\n\nrun:${id}`;
}
