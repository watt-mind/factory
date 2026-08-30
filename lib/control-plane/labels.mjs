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

/**
 * GitHub rejects issue and comment bodies above this many characters. The
 * clamp budgets in UTF-8 bytes, which is never smaller than the character
 * count, so a body that fits the byte budget fits GitHub either way.
 */
export const GITHUB_BODY_MAX_LENGTH = 65_536;

const TRUNCATION_MARKER = (count) => `… [truncated ${count} chars]`;

const byteLength = (text) => Buffer.byteLength(text, "utf8");

const isHighSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit) => unit >= 0xdc00 && unit <= 0xdfff;

const utf8Size = (codePoint) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/**
 * The longest prefix of `text` that fits `budget` UTF-8 bytes, as a UTF-16
 * index on a code-point boundary (a surrogate pair is never split).
 */
function cutToBytes(text, budget) {
  if (budget <= 0) return 0;
  // Every code unit encodes to at least one byte, so `budget` code units is
  // an upper bound; walk back one code point at a time from there.
  let cut = Math.min(text.length, budget);
  if (cut < text.length && isLowSurrogate(text.charCodeAt(cut))) cut -= 1;
  let bytes = byteLength(text.slice(0, cut));
  while (cut > 0 && bytes > budget) {
    const previous =
      cut >= 2 &&
      isLowSurrogate(text.charCodeAt(cut - 1)) &&
      isHighSurrogate(text.charCodeAt(cut - 2))
        ? cut - 2
        : cut - 1;
    bytes -= utf8Size(text.codePointAt(previous));
    cut = previous;
  }
  return cut;
}

/**
 * The fenced code block still open at `limit`, or null when `limit` sits in
 * prose. `openAt` is the offset of the opening delimiter, `contentStart` the
 * first offset after the opening line, and `delimiter` the string that closes
 * the fence (same character, same length).
 */
function openFenceAt(text, limit) {
  const beforeLimit = text.slice(0, limit);
  const fences = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*/g;
  let open = null;
  let match;
  while ((match = fences.exec(beforeLimit))) {
    const marker = match[2];
    const markerStart = match.index + match[1].length;
    if (open === null) {
      open = {
        openAt: markerStart,
        contentStart: Math.min(limit, match.index + match[0].length + 1),
        delimiter: marker,
      };
    } else if (
      marker[0] === open.delimiter[0] &&
      marker.length >= open.delimiter.length
    ) {
      open = null;
    }
  }
  return open;
}

/**
 * The run attribution trailer stampRun() appended to `text`, or "" when the
 * attribution feature is off or the body does not end with this run's stamp.
 * Anchoring on the feature keeps a report that merely ends in a `run:` line
 * from being treated as attribution.
 */
function runTrailer(text) {
  if (process.env.FACTORY_COMMENT_ATTRIBUTION !== "1") return "";
  const id = process.env.FACTORY_RUN_ID;
  if (!id) return "";
  const trailer = `\n\nrun:${id}`;
  return text.endsWith(trailer) ? trailer : "";
}

/**
 * Build the clamped body for a cut at `cut` code units into `report`.
 *
 * A truncation marker must not land inside a fenced code block: it would turn
 * the rest of the body into code and hide the marker. When the cut falls in a
 * fence, keep the retained part of the fence and close it with the same
 * delimiter before the marker. Only when none of the fence's content survives
 * is the fence discarded from its opening delimiter.
 */
function buildClamped(report, cut, trailer) {
  const fence = openFenceAt(report, cut);
  let prefix;
  let closer = "";
  if (fence === null) {
    prefix = report.slice(0, cut);
  } else if (cut > fence.contentStart) {
    prefix = report.slice(0, cut);
    closer = `${prefix.endsWith("\n") ? "" : "\n"}${fence.delimiter}\n`;
  } else {
    prefix = report.slice(0, fence.openAt);
  }
  const separator = closer
    ? ""
    : prefix.length === 0
      ? ""
      : prefix.endsWith("\n")
        ? "\n"
        : "\n\n";
  const marker = TRUNCATION_MARKER(report.length - prefix.length);
  return `${prefix}${closer}${separator}${marker}${trailer}`;
}

/**
 * Clamp a Markdown body for GitHub without losing the optional run stamp.
 *
 * `max` is a UTF-8 byte budget and the cut never splits a surrogate pair. The
 * marker's count is the number of source characters removed from the report
 * (the retained `run:` trailer is not counted). A cut inside a fenced block
 * closes the fence rather than dropping it, so a report that is mostly one
 * long log keeps as much of the log as the budget allows.
 *
 * Returns "" when not even the bare marker fits `max`; callers with a
 * deliberately tiny budget report that instead of posting a mangled marker.
 */
export function clampGithubBody(body, { max = GITHUB_BODY_MAX_LENGTH } = {}) {
  const text = String(body ?? "");
  if (byteLength(text) <= max) return text;

  // Keep the attribution outside the truncatable report so long logs cannot
  // erase the stamp that identifies a run.
  const trailer = runTrailer(text);
  const report = trailer ? text.slice(0, -trailer.length) : text;

  let cut = cutToBytes(report, max - byteLength(trailer));
  for (let attempt = 0; attempt < 8 && cut > 0; attempt++) {
    const candidate = buildClamped(report, cut, trailer);
    const overage = byteLength(candidate) - max;
    if (overage <= 0) return candidate;
    cut = cutToBytes(report, byteLength(report.slice(0, cut)) - overage);
  }

  const bare = `${TRUNCATION_MARKER(report.length)}${trailer}`;
  return byteLength(bare) <= max ? bare : "";
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
 * Classify a complete-set label write that drops `ai:agent-ready`.
 *
 * A ready ticket may leave the queue in only two ways: a claim adds both
 * lifecycle lock labels in the same label write, or a transition moves it to
 * a non-Todo state before the label is removed. Everything else would create
 * the silent, unclaimed Todo state that dispatch cannot see.
 */
export function classifyAgentReadyRemoval(
  currentNames,
  { add = [], remove = [], state = "" } = {},
) {
  const actuallyRemoved =
    currentNames.includes(AGENT_READY_LABEL) &&
    remove.includes(AGENT_READY_LABEL) &&
    !add.includes(AGENT_READY_LABEL);
  if (!actuallyRemoved) return "none";

  const claimWrite =
    add.includes(IN_PROGRESS_LABEL) &&
    add.some((name) => name.startsWith("agent:"));
  if (claimWrite) return "claim";

  const target = String(state).trim().toLowerCase();
  if (target && target !== "todo") return "demotion";
  return "unsafe";
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
