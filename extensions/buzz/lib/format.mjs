/**
 * Inbox item → kind-9 body, option emoji mapping, closed-grammar command parse.
 */
export const INBOX_KINDS = Object.freeze([
  "BLOCKED",
  "ESCALATED",
  "CI RED",
  "SMOKE RED",
  "CIRCUIT BREAKER",
  "RC READY",
  "human_needed",
  "decision_needed",
  "proposal_expired",
]);

/** Interrupt kinds only. Telemetry (run starts, ticket-less FYIs) is WM-975. */
export const DEFAULT_POST_KINDS = Object.freeze([
  "ESCALATED",
  "BLOCKED",
  "CI RED",
  "SMOKE RED",
  "CIRCUIT BREAKER",
  "RC READY",
]);

export const DM_KINDS = new Set(["BLOCKED", "CIRCUIT BREAKER", "SMOKE RED"]);

export const RUN_LIFECYCLE_VERBS = Object.freeze({
  LEASED: "claimed",
  RUNNING: "started",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed out",
  REFUSED: "refused",
  CANCELLED: "cancelled",
});

/**
 * Format only the useful lifecycle milestones for the operational feed.
 * Queue and verification hops remain in the journal but are not chat noise.
 */
export function formatRunLifecycleMessage(event, run = null) {
  const runId = typeof event?.runId === "string" ? event.runId : "";
  const verb = RUN_LIFECYCLE_VERBS[event?.to];
  if (!runId || !verb) return null;

  // getRun (event-runtime/lib/connectors.mjs) hands a connector the
  // artifact only — `run.result` IS the artifact, never the whole
  // result_json (WM-975 review).
  const artifact = run?.result ?? {};
  const ticket = artifact.ticket ?? run?.spec?.input?.ticket ?? null;
  const agent = run?.spec?.agent ?? null;
  const prUrl =
    artifact.outcome === "PR_OPEN" && typeof artifact.prUrl === "string"
      ? artifact.prUrl
      : null;
  const lines = [
    `run ${runId} ${verb}${prUrl ? " — PR opened" : ""}`,
    ...(ticket ? [`ticket: ${truncateBody(String(ticket), 300)}`] : []),
    ...(agent ? [`agent: ${truncateBody(String(agent), 300)}`] : []),
    ...(prUrl ? [prUrl] : []),
  ];
  return lines.join("\n");
}

const EMOJI_BY_ID = {
  approve: "👍",
  reject: "👎",
  dismiss: "💤",
  requeue: "🔁",
  triage: "📤",
  answer: "💬",
  authorise: "🔓",
};
const EMOJI_BY_EFFECT = {
  approve_proposal: "👍",
  reject_proposal: "👎",
  dismiss: "💤",
  requeue: "🔁",
  send_to_triage: "📤",
  answer: "💬",
  authorise: "🔓",
};
const SHORT = {
  "👍": "approve",
  "👎": "reject",
  "💤": "not now",
  "🔁": "requeue",
  "📤": "triage",
  "💬": "answer",
  "🔓": "authorise",
};

export function optionEmoji(option) {
  if (!option || typeof option !== "object") return null;
  return EMOJI_BY_ID[option.id] ?? EMOJI_BY_EFFECT[option.effect] ?? null;
}

export function formatOptions(decision) {
  const options = Array.isArray(decision?.options) ? decision.options : [];
  const mapped = options.map((option) => ({
    ...option,
    emoji: optionEmoji(option),
  }));
  const emojis = mapped.map((o) => o.emoji);
  const unique = new Set(emojis.filter(Boolean));
  if (
    options.length > 0 &&
    unique.size === options.length &&
    emojis.every(Boolean)
  ) {
    const map = Object.fromEntries(mapped.map((o) => [o.emoji, o.id]));
    return {
      style: "emoji",
      line: mapped
        .map((o) => `${o.emoji} ${SHORT[o.emoji] ?? o.label ?? o.id}`)
        .join(" · "),
      map,
    };
  }
  const emojiCounts = new Map();
  for (const emoji of emojis) {
    if (!emoji) continue;
    emojiCounts.set(emoji, (emojiCounts.get(emoji) ?? 0) + 1);
  }
  const map = {};
  const line = mapped
    .map((o, i) => {
      const n = String(i + 1);
      map[n] = o.id;
      if (o.emoji && emojiCounts.get(o.emoji) === 1) map[o.emoji] = o.id;
      const label = o.label ?? o.id;
      return o.emoji ? `${n}. ${o.emoji} ${label}` : `${n}. ${label}`;
    })
    .join("\n");
  return { style: "numbered", line, map };
}

export function absoluteWebUrl(webUrl) {
  if (typeof webUrl !== "string") return "";
  const trimmed = webUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return "";
  return trimmed.replace(/\/$/, "");
}

export function inboxDeepLink(itemId, webUrl) {
  const base = absoluteWebUrl(webUrl);
  if (!base || itemId == null || String(itemId) === "") return "";
  return `${base}/#/inbox/${encodeURIComponent(itemId)}`;
}

const MESSAGE_BODY_LIMIT = 300;

export function truncateBody(text, limit = MESSAGE_BODY_LIMIT) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}…`;
}

function refText(item, key) {
  const value = item?.refs?.[key];
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  return text;
}

export function formatSubject(item) {
  const kind = String(item?.kind ?? "").trim();
  const repo = refText(item, "repo");
  const ticket = refText(item, "issue");
  const parts = [kind, repo, ticket].filter(Boolean);
  if (ticket) return parts.join("  ");
  const title = String(item?.title ?? "").trim();
  return title || kind || "(untitled)";
}

export function formatWhy(item) {
  const context =
    typeof item?.decision?.context === "string"
      ? item.decision.context.trim()
      : "";
  if (context) return context;
  const body = typeof item?.body === "string" ? item.body.trim() : "";
  if (body) return body;
  const question =
    typeof item?.decision?.question === "string"
      ? item.decision.question.trim()
      : "";
  return question;
}

export function isDismissOnly(item) {
  const options = Array.isArray(item?.decision?.options)
    ? item.decision.options
    : [];
  if (options.length === 0) return false;
  return options.every(
    (option) => option?.effect === "dismiss" || option?.id === "dismiss",
  );
}

export function shouldPost(item, postKinds) {
  if (!item?.id) return false;
  const kinds = postKinds instanceof Set ? postKinds : new Set(postKinds ?? []);
  if (!kinds.has(item.kind)) return false;
  if (item.kind === "ESCALATED" && !refText(item, "issue")) return false;
  if (isDismissOnly(item)) return false;
  return true;
}

/**
 * A thread reply selects `answer` when present, else the recommended option.
 * Never dismiss.
 */
export function replyOptionId(decision) {
  const options = Array.isArray(decision?.options) ? decision.options : [];
  const byId = (id) => options.find((option) => option.id === id);
  const answer = options.find(
    (option) => option.effect === "answer" || option.id === "answer",
  );
  if (answer) return answer.id;
  const recommended = decision?.recommended;
  const rec = byId(recommended);
  if (rec && rec.effect !== "dismiss") return rec.id;
  return null;
}

export function formatInboxMessage(item, { webUrl } = {}) {
  const subject = formatSubject(item);
  const why = truncateBody(formatWhy(item));
  const options = formatOptions(item?.decision);
  const link = inboxDeepLink(item?.id ?? "", webUrl);
  const lines = [subject];
  if (why && why !== subject) lines.push(why);
  if (options.line) lines.push(options.line);
  if (link) lines.push(link);
  return lines.join("\n");
}

export function formatResolvedReply(item) {
  const who = item?.decidedBy ?? "operator";
  const option = item?.response?.optionId ?? "decided";
  return `✅ ${option} by ${who}`;
}

/**
 * Map a kind-7 content string onto an option id using the same map formatOptions
 * produced. Also accepts NIP-25 `+` / `-` as approve / reject aliases.
 */
export function reactionToOptionId(content, optionMap) {
  const raw = String(content ?? "").trim();
  if (raw === "") return null;
  if (optionMap[raw]) return optionMap[raw];
  if (raw === "+" && optionMap["👍"]) return optionMap["👍"];
  if (raw === "-" && optionMap["👎"]) return optionMap["👎"];
  return null;
}

export function optionNeedsReason(decision, optionId) {
  const fields = Array.isArray(decision?.fields) ? decision.fields : [];
  return fields.some(
    (field) =>
      field.required === true &&
      field.kind === "text" &&
      (field.whenOption === undefined || field.whenOption.includes(optionId)),
  );
}

export function fieldsForOption(decision, optionId, text) {
  const fields = {};
  const declared = Array.isArray(decision?.fields) ? decision.fields : [];
  for (const field of declared) {
    if (field.whenOption && !field.whenOption.includes(optionId)) continue;
    if (field.kind !== "text") continue;
    if (text !== undefined && text !== null && String(text).trim() !== "") {
      fields[field.id] = String(text);
    } else if (field.required === true) {
      fields[field.id] = "";
    }
  }
  return fields;
}

const DISPATCH_RE =
  /^@factory\s+dispatch\s+([A-Z]+-\d+)(?:\s+repo=([A-Za-z0-9._-]+))?\s*$/i;
const STATUS_RE = /^@factory\s+status\s*$/i;

/**
 * Closed grammar. Anything else is ignored (returns null).
 * Dispatch without repo= is still a command — the connector replies with usage.
 */
export function parseCommand(content) {
  const text = String(content ?? "").trim();
  const status = text.match(STATUS_RE);
  if (status) return { type: "status" };
  const dispatch = text.match(DISPATCH_RE);
  if (!dispatch) return null;
  return {
    type: "dispatch",
    ticket: dispatch[1].toUpperCase(),
    repo: dispatch[2] ?? null,
  };
}

export function isApprover(pubkey, approvers) {
  const hex = String(pubkey ?? "").toLowerCase();
  return (
    Array.isArray(approvers) && approvers.some((p) => p.toLowerCase() === hex)
  );
}
