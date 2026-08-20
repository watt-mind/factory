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

export const DEFAULT_POST_KINDS = INBOX_KINDS;

export const DM_KINDS = new Set(["BLOCKED", "CIRCUIT BREAKER", "SMOKE RED"]);

const EMOJI_BY_ID = {
  approve: "👍",
  reject: "👎",
  dismiss: "💤",
};
const EMOJI_BY_EFFECT = {
  approve_proposal: "👍",
  reject_proposal: "👎",
  dismiss: "💤",
};
const SHORT = { "👍": "approve", "👎": "reject", "💤": "not now" };

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
    options.length <= 3 &&
    unique.size === options.length &&
    emojis.every(Boolean)
  ) {
    return {
      style: "emoji",
      line: mapped.map((o) => `${o.emoji} ${SHORT[o.emoji]}`).join(" · "),
      map: Object.fromEntries(mapped.map((o) => [o.emoji, o.id])),
    };
  }
  return {
    style: "numbered",
    line: mapped.map((o, i) => `${i + 1}. ${o.label ?? o.id}`).join("\n"),
    map: Object.fromEntries(mapped.map((o, i) => [String(i + 1), o.id])),
  };
}

export function inboxDeepLink(itemId, webUrl) {
  const hash = `#/inbox/${encodeURIComponent(itemId)}`;
  if (typeof webUrl === "string" && webUrl.trim() !== "") {
    return `${webUrl.replace(/\/$/, "")}/${hash}`;
  }
  return hash;
}

const MESSAGE_BODY_LIMIT = 300;

export function truncateBody(text, limit = MESSAGE_BODY_LIMIT) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}…`;
}

export function formatInboxMessage(item, { webUrl } = {}) {
  const title = String(item?.title ?? "").trim() || "(untitled)";
  const question =
    typeof item?.decision?.question === "string" &&
    item.decision.question.trim()
      ? item.decision.question.trim()
      : typeof item?.body === "string"
        ? item.body.trim()
        : "";
  const options = formatOptions(item?.decision);
  const link = inboxDeepLink(item?.id ?? "", webUrl);
  return [title, truncateBody(question), options.line, link]
    .filter((line) => line !== "")
    .join("\n");
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
