#!/usr/bin/env bun
/**
 * Blocked-tickets digest — every ai:blocked hold, its question, and its age.
 *
 *   bun orchestrator/digest.mjs               # every configured repo
 *   bun orchestrator/digest.mjs --repo bj29
 *
 * Read-only, writes nothing to Linear. The real failure mode of a hold isn't
 * that no agent revisits it — it's that the one-reply question never reached
 * a human. This is the report that surfaces those questions in one place,
 * oldest hold first, with an ANSWERED marker on tickets whose reply the
 * triage gate (reply-detection.mjs) will pick up on its next tick.
 *
 * Manual-start by design (watch TUI `b`, or this CLI) — see the unblock-digest
 * entry in config/schedule.yaml.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { AI_BLOCKED, blockedLabelIds, holdInfo } from "./reply-detection.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);

const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));
if (!repos.length) {
  console.error(only.length ? `no repo named "${only}" in config/repos.yaml` : "no repos configured");
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

// Same shape reply-detection queries, plus comment bodies — the digest is the
// one consumer that needs the question's text, so the heavier payload lives
// here and not in the every-5-minutes gate.
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
        comments(first: 100) { nodes { createdAt body } }
        history(first: 100) { nodes { createdAt addedLabelIds } }
      }
    }
  }`;

const DAY = 24 * 60 * 60 * 1000;
const age = (ms) => {
  if (ms == null) return "?";
  const d = Date.now() - ms;
  if (d >= DAY) return `${Math.floor(d / DAY)}d`;
  if (d >= 60 * 60_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.max(1, Math.floor(d / 60_000))}m`;
};
const excerpt = (body, n = 110) => {
  const s = String(body ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

const ids = await blockedLabelIds();
let totalHeld = 0;
let totalAnswered = 0;

for (const repo of repos) {
  const nodes = (await gql(DIGEST_QUERY, { team: repo.team, project: repo.project, label: AI_BLOCKED }))?.issues?.nodes ?? [];
  const held = nodes
    .map((n) => ({ node: n, info: holdInfo(n, ids) }))
    .filter((h) => h.info)
    // Oldest hold first; unknown hold times sink to the bottom rather than
    // masquerading as the most urgent.
    .sort((a, b) => (a.info.heldAtMs ?? Infinity) - (b.info.heldAtMs ?? Infinity));

  console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project} — ${held.length} held`));
  if (!held.length) { console.log(c.dim("  nothing held — no ai:blocked tickets")); continue; }

  for (const { node, info } of held) {
    totalHeld++;
    const answered = Boolean(info.reply);
    if (answered) totalAnswered++;
    const marker = answered
      ? c.green(`  ANSWERED ${age(info.reply.atMs)} ago — triage will re-examine`)
      : "";
    console.log(`  ${c.red(node.identifier.padEnd(10))} held ${age(info.heldAtMs)}${marker}`);
    console.log(c.dim(`    ${excerpt(node.title, 100)}`));
    if (info.question?.body) console.log(`    Q: ${excerpt(info.question.body)}`);
    else console.log(c.dim(`    (no blocking comment found — the hold never said what it needs)`));
  }
}

console.log(c.bold(`\n${totalHeld} held ticket(s)`) + (totalAnswered
  ? c.green(`, ${totalAnswered} answered and waiting for the next triage tick`)
  : c.dim(", none answered — every hold above is waiting on a human reply")));
console.log();
