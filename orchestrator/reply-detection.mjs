/**
 * Reply detection for held tickets. `ai:blocked` is applied with a comment
 * "phrased so one reply unblocks it" — but nothing used to watch for the
 * reply, so the label was a one-way door. Per-agent identity doesn't exist yet
 * (OPS-40): agent and human comments share one Linear account, so detection
 * cannot be author-based. The signal is a comment created after the label was
 * last ADDED (a fresh re-add resets the clock — factory-triage re-adds the
 * label when it re-holds, which is what keeps this from firing forever on an
 * unanswered sharper question).
 */
import { gql } from "./reaper.mjs";

export const AI_BLOCKED = "ai:blocked";

// Blocking is comment-then-label within seconds, but the order occasionally
// flips (label-then-comment, observed up to ~10s apart). The slack keeps the
// agent's own hold comment from reading as the human's answer. Cost of the
// window: a reply posted within 2 minutes of the hold goes unseen until any
// later comment lands — humans answering a held ticket that fast are rare.
export const REPLY_GRACE_MS = 2 * 60 * 1000;

const LABEL_IDS_QUERY = `
  query($name: String!) {
    issueLabels(first: 20, filter: { name: { eq: $name } }) { nodes { id } }
  }`;

// Comments + label history for held tickets only. Kept out of the queue's main
// issue query on purpose: this costs per-issue nested pagination, so it runs
// as a second query and only when the cheap query shows a held ticket at all.
export const HELD_QUERY = `
  query($team: String!, $project: String!, $label: String!) {
    issues(first: 100, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      labels: { name: { eq: $label } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        identifier
        state { name }
        comments(last: 100) { nodes { createdAt } }
        history(last: 50) { nodes { createdAt addedLabelIds } }
      }
    }
  }`;

/**
 * Pure decision: which of these held issues has a comment newer than the most
 * recent ai:blocked label-add, beyond the grace window? Returns a Set of
 * identifiers.
 *
 * Conservative on missing evidence: a ticket with no label-add event in the
 * fetched history window (label applied at creation, or paged out) or no
 * comments is NOT answered. Wrongly resurfacing a hold re-derives it every
 * 5 minutes; wrongly leaving one held costs what it costs today.
 */
export function answeredIdentifiers(heldNodes, labelIds, graceMs = REPLY_GRACE_MS) {
  const answered = new Set();
  for (const t of heldNodes ?? []) {
    // Only the two documented hold shapes. An In Progress ticket carrying a
    // stale ai:blocked is the reconciler's drift to explain, not triage work.
    if (!["Triage", "Blocked"].includes(t.state?.name)) continue;
    const adds = (t.history?.nodes ?? [])
      .filter((h) => (h.addedLabelIds ?? []).some((id) => labelIds.has(id)))
      .map((h) => Date.parse(h.createdAt));
    const comments = (t.comments?.nodes ?? []).map((n) => Date.parse(n.createdAt));
    if (!adds.length || !comments.length) continue;
    if (Math.max(...comments) > Math.max(...adds) + graceMs) answered.add(t.identifier);
  }
  return answered;
}

/**
 * Everything the digest wants to say about one held issue, from the same raw
 * shape answeredIdentifiers reads (comments + history; comments may carry
 * `body` when the caller's query asked for it):
 *
 *   heldAtMs   when ai:blocked was last added; null when no add event is in
 *              the history window (label applied at creation, or paged out)
 *   question   newest comment at hold time (within the grace window) — the
 *              agent's blocking question; null when the hold has no comment
 *   reply      newest comment after the grace window — someone answered;
 *              null when nobody has
 *
 * Pure; returns null for issues that aren't in a hold state at all.
 */
export function holdInfo(node, labelIds, graceMs = REPLY_GRACE_MS) {
  if (!["Triage", "Blocked"].includes(node?.state?.name)) return null;
  const adds = (node.history?.nodes ?? [])
    .filter((h) => (h.addedLabelIds ?? []).some((id) => labelIds.has(id)))
    .map((h) => Date.parse(h.createdAt));
  const heldAtMs = adds.length ? Math.max(...adds) : null;
  const comments = (node.comments?.nodes ?? [])
    .map((n) => ({ atMs: Date.parse(n.createdAt), body: n.body ?? null }))
    .sort((a, b) => a.atMs - b.atMs);
  let question = null;
  let reply = null;
  if (heldAtMs != null) {
    for (const c of comments) {
      if (c.atMs <= heldAtMs + graceMs) question = c;
      else reply = c;
    }
  } else if (comments.length) {
    // No add event to anchor on: the newest comment is the best guess at the
    // question, and reply detection stays conservatively off.
    question = comments[comments.length - 1];
  }
  return { identifier: node.identifier, heldAtMs, question, reply };
}

// ai:blocked is a workspace label today, but collecting every id matching the
// name keeps this correct if it ever becomes per-team. Fetched once per
// process, shared across repos.
let _blockedLabelIds = null;
export async function blockedLabelIds() {
  if (!_blockedLabelIds) {
    const r = await gql(LABEL_IDS_QUERY, { name: AI_BLOCKED });
    _blockedLabelIds = new Set((r?.issueLabels?.nodes ?? []).map((n) => n.id));
  }
  return _blockedLabelIds;
}

/** Identifiers of the repo's held tickets that someone has replied to. */
export async function answeredHeldTickets(repo) {
  const ids = await blockedLabelIds();
  if (!ids.size) return new Set();
  const held = (await gql(HELD_QUERY, { team: repo.team, project: repo.project, label: AI_BLOCKED }))?.issues?.nodes ?? [];
  return answeredIdentifiers(held, ids);
}
