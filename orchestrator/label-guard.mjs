#!/usr/bin/env bun
/**
 * Mechanical linear.md §5-template guard for `ai:agent-ready` tickets.
 *
 * `ai:agent-ready` is supposed to mean "has all five §5 sections", but
 * nothing ever enforced that -- a ticket built from a different template can
 * carry the label without meeting it. CLNT-871/872 did exactly this: created
 * via the 4-section Frappe support-ticket ingestion format
 * (frappe-agent-protocol.md §12), landed as Todo + ai:agent-ready + unassigned
 * -- which reads as dispatchable -- with no Owned Paths (so dispatch's
 * collision check has nothing to compare) and no Verification Command (so
 * "done" has no test to run).
 *
 * Checking for five markdown sections is a string match, not a judgment call
 * -- it doesn't need an agent. This runs BEFORE the triage stage so the triage
 * agent only spends investigation budget on tickets that genuinely need
 * (re-)specification, not on re-deriving a header check by hand every pass.
 *
 * Dry-run by default. Nothing is written without --apply.
 *
 *     bun orchestrator/label-guard.mjs                    # show violations
 *     bun orchestrator/label-guard.mjs --apply             # demote them
 *     bun orchestrator/label-guard.mjs --repo legalease
 *     bun orchestrator/label-guard.mjs --repo legalease --apply
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gql, fetchTeams } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths } from "./owned-paths.mjs";

const AI_AGENT_READY = "ai:agent-ready";

/** Split markdown heading sections (levels 2-4), keyed by heading text and trimmed body. */
function sections(description = "") {
  return description
    .split(/^#{2,4}\s+/m)
    .slice(1)
    .map((s) => {
      const nl = s.indexOf("\n");
      const heading = (nl === -1 ? s : s.slice(0, nl)).trim();
      const body = (nl === -1 ? "" : s.slice(nl + 1)).trim();
      return { heading, body };
    });
}

/**
 * Which linear.md §5 sections a description is missing. [] means it passes.
 *
 * Owned Paths is checked with the real parser (owned-paths.mjs), not a header
 * scan, because that is what dispatch actually reads at claim time -- a
 * heading with unparseable content underneath is exactly as useless to
 * dispatch as no heading at all. Acceptance Criteria requires an actual
 * checkbox, not just a heading, because a prose task list under that heading
 * ("Technical Tasks:") isn't the observable checklist §5 asks for.
 */
// "None", "N/A", or "no ... path(s)" within a short span -- covers "None in
// this repo", "No repository paths", "None — infra/deploy verification only".
const NOT_APPLICABLE = /\b(none|n\/a|not applicable)\b|\bno\b[^.]{0,30}\bpaths?\b/i;

/**
 * Which of the two *mechanically load-bearing* §5 sections a description is
 * missing. [] means it passes.
 *
 * Deliberately narrower than the full five-section §5 template. An early
 * version also checked Problem & Context, Acceptance Criteria, and Source
 * File Pointers -- against real workspace tickets that produced five false
 * positives (including an Urgent, fully-actionable security ticket) for every
 * two genuine catches, because legitimate tickets vary a lot in how they
 * write context, criteria, and file pointers (agent-surfaced PR findings,
 * evidence-only tickets, non-code infra verification). Owned Paths and
 * Verification Command don't have that problem: one is what dispatch's
 * collision check actually reads, the other is what "done" actually runs, so
 * "missing" is unambiguous rather than a style judgment. A false demotion
 * here costs real disruption to a ready ticket, so this errs toward
 * precision -- catching CLNT-871/872-shaped tickets, not flagging format
 * variation.
 */
export function templateGaps(description = "") {
  const secs = sections(description);
  const gaps = [];

  // A non-code ticket (deploy/env-var/business change) legitimately has no
  // repo paths -- linear.md's non-code exception applies here too. Accept an
  // explicit "not applicable" declaration in the section body.
  const owned = secs.find((s) => /\bowned\s+paths\b/i.test(s.heading));
  const ownedNA = owned && NOT_APPLICABLE.test(owned.body);
  if (!parseOwnedPaths(description).length && !ownedNA) gaps.push("Owned Paths");

  // "Evidence Required" / "Evidence line" is the accepted non-code substitute
  // for a Verification Command (linear.md §5's non-code-work exception).
  // Requires more than the bare word "evidence" -- a bug ticket's
  // "## Production evidence" (proof the bug is real) is not a verification
  // method and must not satisfy this.
  const verified = secs.some((s) => {
    return (
      (/\bverification\s+command\b/i.test(s.heading) || /\bevidence\b.*\b(required|line)\b/i.test(s.heading)) &&
      s.body.length > 0
    );
  });
  if (!verified) gaps.push("Verification Command");

  return gaps;
}

const QUERY = `
  query($team: String!, $project: String!) {
    issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { name: { eq: "Todo" } },
      labels: { name: { eq: "${AI_AGENT_READY}" } },
      assignee: { null: true }
    }) {
      nodes {
        id identifier title description url
        labels(first: 20) { nodes { id name } }
      }
    }
  }`;

export async function fetchReadyIssues(repo) {
  const data = await gql(QUERY, { team: repo.team, project: repo.project });
  return data?.issues?.nodes ?? [];
}

export async function demote(issue, triageStateId, gaps, apply) {
  if (!apply) return;

  const keepLabelIds = (issue.labels?.nodes ?? [])
    .filter((l) => (l.name || "").toLowerCase() !== AI_AGENT_READY)
    .map((l) => l.id);

  await gql(
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: issue.id, input: { stateId: triageStateId, labelIds: keepLabelIds } }
  );

  const body =
    `**Demoted by the \`ai:agent-ready\` template guard.**\n\n` +
    `This ticket was labeled \`ai:agent-ready\` and in \`Todo\`, but its description is missing ` +
    `linear.md §5 section(s) required for that label:\n\n` +
    gaps.map((g) => `- **${g}**`).join("\n") +
    `\n\nMoved back to \`Triage\` and the label was removed so it isn't picked up for dispatch. ` +
    `A triage pass needs to add the missing section(s) before re-labeling \`ai:agent-ready\`.`;

  await gql(
    `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    { input: { issueId: issue.id, body } }
  );
}

export function parseArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
  const repos = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { apply, repos };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
  const repos = (cfg.repos ?? []).filter((r) => !args.repos.length || args.repos.includes(r.name));

  if (!repos.length) {
    console.error(args.repos.length ? `no repo named "${args.repos.join(",")}" in config/repos.yaml` : "no repos configured");
    process.exit(2);
  }

  console.log(`=== ai:agent-ready template guard [${args.apply ? "APPLY" : "DRY RUN"}] ===\n`);

  let teams = null;
  let violations = 0;

  for (const repo of repos) {
    const issues = await fetchReadyIssues(repo);
    const bad = issues.map((issue) => ({ issue, gaps: templateGaps(issue.description ?? "") })).filter((r) => r.gaps.length);

    console.log(`${repo.name}  ${repo.team} / ${repo.project}  --  ${issues.length} ai:agent-ready ticket(s), ${bad.length} failing §5`);

    if (!bad.length) continue;
    violations += bad.length;

    if (args.apply && !teams) teams = await fetchTeams();
    const triageStateId = args.apply ? teams?.[repo.team]?.states?.["triage"] : null;
    if (args.apply && !triageStateId) {
      console.log(`  ! no 'Triage' state on team ${repo.team}, skipping demotion for this repo`);
    }

    for (const { issue, gaps } of bad) {
      console.log(`  ${issue.identifier.padEnd(10)} ${issue.title.slice(0, 60)}`);
      for (const g of gaps) console.log(`      missing: ${g}`);

      if (args.apply && triageStateId) {
        try {
          await demote(issue, triageStateId, gaps, true);
          console.log(`      -> demoted to Triage, ai:agent-ready removed`);
        } catch (err) {
          console.log(`      ! failed: ${err.message || err}`);
        }
      }
    }
  }

  console.log(`\n=== ${args.apply ? "Demoted" : "Would demote"}: ${violations} ===`);
  if (!args.apply && violations) console.log("Run again with --apply to demote these.");
}

if (import.meta.main || process.argv[1]?.endsWith("label-guard.mjs")) {
  main().catch((err) => {
    console.error(`Linear API error: ${err.message || err}`);
    process.exit(1);
  });
}
