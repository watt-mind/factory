#!/usr/bin/env bun
/**
 * Blocked-tickets digest — every ai:blocked hold, its question, and its age.
 *
 *   bun orchestrator/digest.mjs               # every configured repo
 *   bun orchestrator/digest.mjs --repo bj29
 *
 * Read-only, writes nothing to the tracker. The real failure mode of a hold
 * isn't that no agent revisits it — it's that the one-reply question never
 * reached a human. This is the report that surfaces those questions in one
 * place, oldest hold first, with an ANSWERED marker on tickets whose reply the
 * triage gate (reply-detection.mjs) will pick up on its next tick.
 *
 * Plane-aware (WM-1062): each repo is read through its OWN configured control
 * plane, not the workspace default. Linear keeps the label-history raw query
 * that dates the hold and detects the reply. GitHub has no label-history in
 * the neutral contract, so its holds are collected through the adapter's
 * `listTickets`/`listComments` verbs and shown with an explicit "timing
 * unknown" note rather than being silently dropped (which reported `0 held`
 * for a GitHub-backed repo whose board actually held work) or falsely marked
 * as unanswered.
 *
 * Manual-start by design (watch TUI `b`, or this CLI) — see the unblock-digest
 * entry in config/schedule.yaml.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/schedule.mjs";
import {
  loadControlPlane,
  controlPlaneKindFromRepo,
  controlPlaneKindFromPolicy,
} from "../lib/control-plane/index.mjs";
import { AI_BLOCKED, blockedLabelIds, holdInfo } from "./reply-detection.mjs";

// Same shape reply-detection queries, plus comment bodies — the digest is the
// one consumer that needs the question's text, so the heavier payload lives
// here and not in the every-5-minutes gate. Linear-only: it reads label
// history (`addedLabelIds`), which no other adapter models.
const DIGEST_QUERY = `
  query($team: String!, $project: String!, $label: String!) {
    issues(first: 100, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      labels: { name: { eq: $label } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        identifier title url
        state { name }
        comments(last: 100) { nodes { createdAt body } }
        history(last: 50) { nodes { createdAt addedLabelIds } }
      }
    }
  }`;

// The two documented hold shapes. An In Progress ticket carrying a stale
// ai:blocked is the reconciler's drift to explain, not a human-attention hold.
const HOLD_STATES = ["Triage", "Blocked"];

const DAY = 24 * 60 * 60 * 1000;
export const age = (ms) => {
  if (ms == null) return "?";
  const d = Date.now() - ms;
  if (d >= DAY) return `${Math.floor(d / DAY)}d`;
  if (d >= 60 * 60_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.max(1, Math.floor(d / 60_000))}m`;
};
export const excerpt = (body, n = 110) => {
  const s = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/**
 * The kind this repo's tickets live on: its explicit `control_plane`, else the
 * workspace default. The digest branches on this so a GitHub repo never has a
 * Linear GraphQL query issued through its adapter, and vice versa (WM-1062).
 */
export function planeKindForRepo(repo) {
  return controlPlaneKindFromRepo(repo.name) ?? controlPlaneKindFromPolicy();
}

/**
 * Normalized held item the renderer consumes, plane-independent:
 *
 *   identifier   ticket id (e.g. WM-840 or watt-mind/factory#840)
 *   title        ticket title
 *   heldAtMs     when the hold began; null when unknown
 *   question     newest comment at hold time — the blocking question; null
 *   reply        newest comment after the hold — an answer; null when none
 *   timingKnown  true when the plane dates the hold and can detect a reply
 *                (Linear); false when it cannot (GitHub label history is not
 *                in the neutral contract), so `reply` stays null and the row
 *                carries an explicit limitation note instead of a false
 *                "unanswered" claim.
 */

/** Linear: label-history raw query → holdInfo dates the hold and the reply. */
export async function heldFromLinear(repo, cp, ids) {
  const nodes =
    (
      await cp.raw(DIGEST_QUERY, {
        team: repo.team,
        project: repo.project,
        label: AI_BLOCKED,
      })
    )?.issues?.nodes ?? [];
  return nodes
    .map((n) => ({ node: n, info: holdInfo(n, ids) }))
    .filter((h) => h.info)
    .map(({ node, info }) => ({
      identifier: node.identifier,
      title: node.title,
      heldAtMs: info.heldAtMs,
      question: info.question,
      reply: info.reply,
      timingKnown: true,
    }));
}

/**
 * Non-Linear (GitHub, memory): the neutral adapter. `listTickets` gives the
 * open Triage/Blocked tickets; keep the ai:blocked ones and read their newest
 * comment as the blocking question. The plane cannot date the hold or time a
 * reply, so `timingKnown` is false — the ticket is still counted and shown.
 */
export async function heldFromAdapter(repo, cp) {
  const tickets = await cp.listTickets({
    team: repo.team,
    project: repo.project,
    states: HOLD_STATES,
  });
  const held = tickets.filter((t) =>
    (t.labels ?? []).some((l) => l.name === AI_BLOCKED),
  );
  const items = [];
  for (const t of held) {
    const comments = await cp.listComments(t.identifier);
    const sorted = [...comments].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    items.push({
      identifier: t.identifier,
      title: t.title,
      heldAtMs: null,
      // Newest comment is the best guess at the blocking question when there
      // is no label-add event to anchor on.
      question: sorted.length ? sorted[sorted.length - 1] : null,
      reply: null,
      timingKnown: false,
    });
  }
  return items;
}

/**
 * Every held ticket for one repo, read through THAT repo's plane, oldest hold
 * first. Unknown hold times sink to the bottom rather than masquerading as the
 * most urgent.
 */
export async function heldForRepo(
  repo,
  { load = loadControlPlane, kind } = {},
) {
  const resolved = kind ?? planeKindForRepo(repo);
  const cp = load({ repoName: repo.name });
  // blockedLabelIds() is fetched only on the Linear branch: it dates the hold
  // via label history. The GitHub branch must never issue that Linear GraphQL.
  const items =
    resolved === "linear"
      ? await heldFromLinear(repo, cp, await blockedLabelIds())
      : await heldFromAdapter(repo, cp);
  return items.sort(
    (a, b) => (a.heldAtMs ?? Infinity) - (b.heldAtMs ?? Infinity),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  const only = (val("--repo") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cfg = Bun.YAML.parse(
    readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"),
  );
  const repos = (cfg.repos ?? []).filter(
    (r) => !only.length || only.includes(r.name),
  );
  if (!repos.length) {
    console.error(
      only.length
        ? `no repo named "${only}" in config/repos.yaml`
        : "no repos configured",
    );
    process.exit(2);
  }

  // Plain text when piped — the watch TUI renders this output inside an Ink
  // pane, where ANSI escapes would come through as garbage.
  const tty = process.stdout.isTTY;
  const c = {
    dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
    bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
    green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
    red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  };

  let totalHeld = 0;
  let totalAnswered = 0;
  let totalUntimed = 0;

  for (const repo of repos) {
    const held = await heldForRepo(repo);

    console.log(
      c.bold(`\n${repo.name}`) +
        c.dim(`  ${repo.team} / ${repo.project} — ${held.length} held`),
    );
    if (!held.length) {
      console.log(c.dim("  nothing held — no ai:blocked tickets"));
      continue;
    }

    for (const item of held) {
      totalHeld++;
      const answered = item.timingKnown && Boolean(item.reply);
      if (answered) totalAnswered++;
      if (!item.timingKnown) totalUntimed++;
      const marker = answered
        ? c.green(
            `  ANSWERED ${age(item.reply.atMs)} ago — triage will re-examine`,
          )
        : "";
      console.log(
        `  ${c.red(item.identifier.padEnd(10))} held ${age(item.heldAtMs)}${marker}`,
      );
      console.log(c.dim(`    ${excerpt(item.title, 100)}`));
      if (!item.timingKnown)
        console.log(
          c.dim(
            `    (hold age and reply timing unknown — this plane exposes no label history)`,
          ),
        );
      if (item.question?.body)
        console.log(`    Q: ${excerpt(item.question.body)}`);
      else
        console.log(
          c.dim(
            `    (no blocking comment found — the hold never said what it needs)`,
          ),
        );
    }
  }

  const summaryTail = totalAnswered
    ? c.green(
        `, ${totalAnswered} answered and waiting for the next triage tick`,
      )
    : totalUntimed === totalHeld
      ? c.dim(", reply timing unavailable — check each ticket's latest comment")
      : c.dim(", none answered — every hold above is waiting on a human reply");
  console.log(c.bold(`\n${totalHeld} held ticket(s)`) + summaryTail);
  console.log();
}

if (import.meta.main) await main();
