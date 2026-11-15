#!/usr/bin/env bun
/**
 * Reconcile Linear ticket state with what GitHub actually shows.
 *
 *   bun orchestrator/reconcile.mjs --repo bj29            # dry — what it would move
 *   bun orchestrator/reconcile.mjs --repo bj29 --apply
 *   bun orchestrator/reconcile.mjs --repo bj29 --gate     # 0 = drift exists, 1 = clean
 *
 * WHY THIS EXISTS. A ticket in `In Progress` consumes a dispatch slot, and the
 * slot is meant to be freed the moment the agent opens its PR and moves the
 * ticket to `In Review` — at that point no agent is running and the work is
 * waiting on review, not on capacity. When that last step is missed (a crashed
 * run, a hand-opened PR, an agent that pushed and stopped), the ticket keeps
 * the slot forever and nothing notices, because a stuck ticket looks exactly
 * like a working one.
 *
 * Observed on bj29: CLNT-415 and CLNT-387 sat `In Progress` for 13 hours with
 * open PRs, holding two of three slots. Throughput was one agent out of three
 * and no stage reported an error — dispatch had no room, and the merge stage
 * could not see the PRs (OPS-44).
 *
 * The reaper does not cover this. Its question is "has this claim gone silent",
 * and these claims are not silent — they are finished. The evidence here is
 * positive rather than temporal: an open PR attached to the ticket means the
 * implementation phase is over, whatever the ticket says.
 *
 * SAFETY. This moves an active ticket to `In Review` only when its own PR is
 * open, and to `Done` only when its own PR is merged. It never acts on a
 * merely closed PR. A merged PR has already passed the merge stage's gate; this
 * is the recovery path for the last Linear write being missed after that gate.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { lastActivity } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { emitFactoryEvent } from "../lib/emit-event.mjs";
import { loadControlPlane } from "../lib/control-plane/index.mjs";
import { githubForge, loadForge } from "../lib/forge/index.mjs";

export function parseArgs(argv) {
  const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  return {
    apply: argv.includes("--apply"),
    gate: argv.includes("--gate"),
    quietMin: Number(val("--quiet-minutes") ?? 25),
    only: (val("--repo") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

export const Q = `query($t:String!,$p:String!,$after:String){ issues(first:250, after:$after, filter:{
    team:{key:{eq:$t}}, project:{name:{eq:$p}}, state:{type:{nin:["completed","canceled"]}} }){
  nodes{ id identifier title startedAt updatedAt labels(first:20){nodes{id name}}
         state{ id name type }
         comments(last:1){ nodes{ createdAt } }
         attachments(first:20){ nodes{ url } } }
  pageInfo{ hasNextPage endCursor } } }`;

export const Q_DONE = `query($t:String!,$p:String!,$after:String){ issues(first:100, after:$after, filter:{
    team:{key:{eq:$t}}, project:{name:{eq:$p}}, state:{type:{eq:"completed"}} }, orderBy:updatedAt){
  nodes{ id identifier title startedAt updatedAt labels(first:20){nodes{id name}}
         state{ id name type }
         comments(last:1){ nodes{ createdAt } }
         attachments(first:20){ nodes{ url } } }
  pageInfo{ hasNextPage endCursor } } }`;

/** Upper bounds on pagination so a runaway cursor can never loop forever. */
export const MAX_PAGES_ACTIVE = 12; // 12 x 250 = 3000 open tickets
export const MAX_PAGES_DONE = 10; // 10 x 100 = 1000 most recently completed

/**
 * Follow `pageInfo { hasNextPage endCursor }` until exhausted or `maxPages`
 * is hit (then warn on stderr and return what was collected).
 */
export async function fetchAllPages(queryGql, query, vars, maxPages, label) {
  const nodes = [];
  let after = null;
  for (let page = 1; page <= maxPages; page++) {
    const conn = (await queryGql(query, { ...vars, after }))?.issues;
    nodes.push(...(conn?.nodes ?? []));
    const info = conn?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) return nodes;
    after = info.endCursor;
  }
  console.warn(
    c.yellow(
      `  warning: ${label} query hit the ${maxPages}-page bound (${nodes.length} tickets fetched); more tickets exist and were not evaluated`,
    ),
  );
  return nodes;
}

/** PR numbers attached to a ticket, for this repo only. */
export function prNumbers(issue, nameWithOwner) {
  const re = new RegExp(
    `github\\.com/${nameWithOwner.replace("/", "\\/")}/pull/(\\d+)`,
    "i",
  );
  const out = new Set();
  for (const a of issue.attachments?.nodes ?? []) {
    const m = re.exec(a.url ?? "");
    if (m) out.add(Number(m[1]));
  }
  return [...out];
}

/**
 * `{state,isDraft,labels}` of one PR, or null when the forge could not answer.
 * `run` is the legacy Bun.spawnSync-shaped seam (`run([cmd, ...args])`) the
 * tests inject; when given it drives the GitHub implementation.
 */
export function prState(nameWithOwner, number, run = undefined) {
  const forge = run
    ? githubForge({ exec: (cmd, args) => run([cmd, ...args]) })
    : loadForge();
  try {
    return forge.prView(nameWithOwner, number, {
      fields: ["state", "isDraft", "labels"],
    });
  } catch {
    return null;
  }
}

export const LIFECYCLE_LABELS = [
  "ai:in-progress",
  "ai:needs-review",
  "ai:agent-ready",
  "ai:escalated",
  "ai:blocked",
];

/** Remove all factory lifecycle markers; preserve all project labels (WM-16). */
export function settledLabelIds(issue) {
  return (issue.labels?.nodes ?? [])
    .filter(
      (l) => !LIFECYCLE_LABELS.includes(l.name) && !l.name.startsWith("agent:"),
    )
    .map((l) => l.id);
}

/** How far back to look for merged PRs carrying `Fixes` lines (WM-1140). */
export const FIXES_WINDOW_DAYS = 14;
/** Upper bound on merged PRs inspected per repo, newest first. */
export const FIXES_PR_LIMIT = 300;

/**
 * Explicit completion markers in a PR body (WM-1140): a line that is *only*
 * `Fixes|Closes|Resolves <TEAM>-<n>` (case-insensitive; optional list bullet,
 * optional trailing punctuation). A bare ID mentioned in prose, a caveat or a
 * "related to" note never matches — that scraping closed the wrong ticket in
 * the CLNT-5138 incident (2026-10-03). Lines inside fenced code blocks are
 * examples, not claims, and are ignored.
 * @returns {{id:string, line:string}[]} unique by id, in body order
 */
export function parseFixesLines(body, team = null) {
  const out = [];
  const seen = new Set();
  let fenced = false;
  const re =
    /^(?:[-*+]\s+)?(?:fixes|closes|resolves)\s+([A-Za-z][A-Za-z0-9]*-\d+)\s*[.,;]?$/i;
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = re.exec(line);
    if (!m) continue;
    const id = m[1].toUpperCase();
    if (team && !id.startsWith(`${team.toUpperCase()}-`)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, line });
  }
  return out;
}

/**
 * Merged PRs into the repo's base branch within the window, as
 * `{number, body, mergedAt, baseRefName}`. Empty (with a warning) when the
 * forge cannot answer — never a reason to act.
 */
export function recentMergedPrs(repo, { now = Date.now() } = {}, forge = null) {
  try {
    const f = forge ?? loadForge();
    const cutoff = now - FIXES_WINDOW_DAYS * 86400000;
    return f
      .prList(repo.github, {
        state: "merged",
        limit: FIXES_PR_LIMIT,
        fields: ["number", "body", "mergedAt", "baseRefName", "state"],
      })
      .filter(
        (pr) =>
          pr.mergedAt &&
          Date.parse(pr.mergedAt) >= cutoff &&
          (!repo.base || pr.baseRefName === repo.base),
      );
  } catch (err) {
    console.warn(
      c.yellow(
        `  warning: could not list merged PRs for ${repo.github}: ${err?.message ?? err}`,
      ),
    );
    return [];
  }
}

/**
 * Drift descriptors for non-terminal tickets named on a `Fixes` line of a
 * merged PR. Unlike the attachment rule this applies to *every* non-terminal
 * state: an explicit own-line `Fixes` is positive completion evidence even for
 * a Blocked/Backlog ticket. First (earliest-listed) PR wins per ticket.
 */
export function evaluateFixesLines(issues, mergedPrs, team = null) {
  const byId = new Map(
    issues
      .filter(
        (i) =>
          i.state?.type !== "completed" &&
          i.state?.type !== "canceled" &&
          i.state?.name?.toLowerCase() !== "done",
      )
      .map((i) => [i.identifier?.toUpperCase(), i]),
  );
  const out = new Map();
  for (const pr of mergedPrs) {
    for (const { id, line } of parseFixesLines(pr.body, team)) {
      const issue = byId.get(id);
      if (!issue || out.has(id)) continue;
      out.set(id, {
        type: "merged-fixes-line",
        issue,
        merged: [pr.number],
        mergedAt: pr.mergedAt,
        fixesLine: line,
        targetState: "Done",
      });
    }
  }
  return [...out.values()];
}

/**
 * Evaluate drift between ticket state in Linear and PR state on GitHub.
 * Returns drift descriptor or null if ticket is consistent.
 */
export function evaluateTicketDrift(
  issue,
  repoGithub,
  prStates,
  { quietMin = 25 } = {},
) {
  const openPrs = prStates.filter((pr) => pr.state === "OPEN");
  const open = openPrs.map((pr) => pr.number);
  const isDone =
    issue.state?.type === "completed" ||
    issue.state?.name?.toLowerCase() === "done";

  if (isDone) {
    if (!open.length) return null;
    const isEscalated = openPrs.some((pr) =>
      (pr.labels ?? []).some(
        (l) =>
          (typeof l === "string" ? l : l.name)?.toLowerCase() === "escalated",
      ),
    );
    return {
      type: "done-with-open-pr",
      issue,
      open,
      isEscalated,
      targetState: "In Review",
    };
  }

  // Only worked tickets can be reconciled from a merged PR. Unstarted and
  // held tickets may link historical PRs as context without being complete.
  if (!open.length) {
    if (!["In Review", "In Progress"].includes(issue.state?.name)) return null;
    const merged = prStates
      .filter((pr) => pr.state === "MERGED")
      .map((pr) => pr.number);
    if (!merged.length) return null;
    return {
      type: "merged-not-done",
      issue,
      merged,
      targetState: "Done",
    };
  }

  // Active ticket with open PR
  if (issue.state?.name !== "In Progress") return null;

  const quietFor = Math.round(
    (Date.now() - (lastActivity(issue)?.getTime() ?? Date.now())) / 60000,
  );
  if (quietFor < quietMin) {
    return {
      type: "still-active",
      issue,
      open,
      quietFor,
    };
  }

  return {
    type: "in-progress-with-open-pr",
    issue,
    open,
    quietFor,
    targetState: "In Review",
  };
}

export async function reconcileRepo(
  repo,
  { apply = false, gate = false, quietMin = 25 } = {},
  deps = {},
) {
  const queryGql = deps.gql ?? ((q, v) => loadControlPlane().raw(q, v));
  const getPrState = deps.prState ?? prState;

  if (!gate)
    console.log(
      c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project}`),
    );
  if (!repo.github) {
    if (!gate) console.log(c.dim("  no github: in repos.yaml — skipping"));
    return { drift: 0, actions: [] };
  }

  let activeNodes;
  let doneNodes;
  if (deps.issues) {
    activeNodes = deps.issues.filter(
      (i) =>
        i.state?.type !== "completed" &&
        i.state?.name?.toLowerCase() !== "done",
    );
    doneNodes = deps.issues.filter(
      (i) =>
        i.state?.type === "completed" ||
        i.state?.name?.toLowerCase() === "done",
    );
  } else {
    const vars = { t: repo.team, p: repo.project };
    activeNodes = await fetchAllPages(
      queryGql,
      Q,
      vars,
      MAX_PAGES_ACTIVE,
      "open-ticket",
    );
    doneNodes = await fetchAllPages(
      queryGql,
      Q_DONE,
      vars,
      MAX_PAGES_DONE,
      "completed-ticket",
    );
  }
  const nodes = [...activeNodes, ...doneNodes];

  const states =
    deps.states ??
    (
      await queryGql(
        `query($t:String!){ team(id:$t){ states(first:50){ nodes{ id name type } } } }`,
        { t: repo.team },
      )
    )?.team?.states?.nodes ??
    [];
  const inReviewId = states.find(
    (s) => s.name.toLowerCase() === "in review",
  )?.id;
  const doneId = states.find((s) => s.type === "completed")?.id;
  const allLabels =
    deps.labels ??
    (await queryGql(`query{ issueLabels(first:250){ nodes{ id name } } }`))
      ?.issueLabels?.nodes ??
    [];
  const labelId = (n) => allLabels.find((l) => l.name === n)?.id;

  let drift = 0;
  const actions = [];

  const handled = new Set();
  const mergedPrs = deps.mergedPrs ?? recentMergedPrs(repo);
  for (const ev of evaluateFixesLines(nodes, mergedPrs, repo.team)) {
    const issue = ev.issue;
    handled.add(issue.id);
    drift++;
    actions.push(ev);
    if (gate) continue;
    console.log(
      `  ${c.yellow(issue.identifier)} is ${issue.state?.name ?? "open"} but merged PR #${ev.merged[0]} says "${ev.fixesLine}" — ${apply ? "moving to Done" : "would move to Done"}`,
    );
    console.log(c.dim(`    ${issue.title.slice(0, 70)}`));
    if (!apply) continue;
    if (!doneId) {
      console.log(
        c.red(`    ! no completed state on team ${repo.team}, skipping`),
      );
      continue;
    }
    await queryGql(
      `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      {
        id: issue.id,
        in: { stateId: doneId, labelIds: settledLabelIds(issue) },
      },
    );
    await queryGql(
      `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
      {
        in: {
          issueId: issue.id,
          body:
            `**State reconciled: \`${issue.state?.name ?? "open"}\` → \`Done\` (WM-1140).**\n\n` +
            `PR #${ev.merged[0]} merged at ${ev.mergedAt} and its body carries the line \`${ev.fixesLine}\`, ` +
            `which is explicit completion evidence regardless of ticket state. ` +
            `Removed the factory lifecycle labels (\`ai:in-progress\`, \`ai:needs-review\`, \`ai:blocked\`, ...); project labels were preserved.`,
        },
      },
    );
  }

  for (const issue of nodes) {
    if (handled.has(issue.id)) continue;
    const prs = prNumbers(issue, repo.github);
    if (!prs.length) continue;

    const prStates = prs.map((n) => ({
      number: n,
      ...(getPrState(repo.github, n) ?? {}),
    }));
    const evaluation = evaluateTicketDrift(issue, repo.github, prStates, {
      quietMin,
    });
    if (!evaluation) {
      if (
        !gate &&
        !prStates.some((pr) => pr.state === "OPEN" || pr.state === "MERGED")
      ) {
        console.log(
          c.dim(
            `  ${issue.identifier} — PR ${prs.map((n) => "#" + n).join(", ")} not open; leaving to the merge stage`,
          ),
        );
      }
      continue;
    }

    if (evaluation.type === "still-active") {
      if (!gate) {
        console.log(
          c.dim(
            `  ${issue.identifier} — PR ${evaluation.open.map((n) => "#" + n).join(", ")} open but active ${evaluation.quietFor}m ago; its agent is still working`,
          ),
        );
      }
      continue;
    }

    drift++;
    actions.push(evaluation);
    if (gate) continue;

    if (evaluation.type === "done-with-open-pr") {
      console.log(
        `  ${c.yellow(issue.identifier)} is Done but PR ${evaluation.open.map((n) => "#" + n).join(", ")} is still OPEN — ${apply ? "moving to In Review" : "would move to In Review"}`,
      );
      console.log(c.dim(`    ${issue.title.slice(0, 70)}`));
      if (!apply) continue;
      if (!inReviewId) {
        console.log(
          c.red(`    ! no 'In Review' state on team ${repo.team}, skipping`),
        );
        continue;
      }

      const keep = (issue.labels?.nodes ?? [])
        .filter(
          (l) =>
            !LIFECYCLE_LABELS.includes(l.name) && !l.name.startsWith("agent:"),
        )
        .map((l) => l.id);
      const wantNames = ["ai:needs-review"];
      if (evaluation.isEscalated) wantNames.push("ai:escalated");
      const want = [
        ...new Set(
          [...keep, ...wantNames.map((n) => labelId(n))].filter(Boolean),
        ),
      ];

      await queryGql(
        `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
        { id: issue.id, in: { stateId: inReviewId, labelIds: want } },
      );
      await queryGql(
        `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
        {
          in: {
            issueId: issue.id,
            body:
              `**State reconciled: \`Done\` → \`In Review\` (WM-11).**\n\n` +
              `PR ${evaluation.open.map((n) => `#${n}`).join(", ")} is still open, but the ticket was marked Done. ` +
              `Reopened to In Review${evaluation.isEscalated ? " with `ai:escalated`" : ""}.\n\n` +
              `The merge stage reviews it from here.`,
          },
        },
      );
    } else if (evaluation.type === "merged-not-done") {
      console.log(
        `  ${c.yellow(issue.identifier)} has merged PR ${evaluation.merged.map((n) => "#" + n).join(", ")} but is still ${issue.state?.name ?? "active"} — ${apply ? "moving to Done" : "would move to Done"}`,
      );
      console.log(c.dim(`    ${issue.title.slice(0, 70)}`));
      if (!apply) continue;
      if (!doneId) {
        console.log(
          c.red(`    ! no completed state on team ${repo.team}, skipping`),
        );
        continue;
      }

      await queryGql(
        `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
        {
          id: issue.id,
          in: { stateId: doneId, labelIds: settledLabelIds(issue) },
        },
      );
      await queryGql(
        `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
        {
          in: {
            issueId: issue.id,
            body:
              `**State reconciled: \`${issue.state?.name ?? "active"}\` → \`Done\`.**\n\n` +
              `PR ${evaluation.merged.map((n) => `#${n}`).join(", ")} is merged, but the ticket's final Linear update was missed. ` +
              `Removed the factory lifecycle labels; all project labels were preserved.`,
          },
        },
      );
    } else if (evaluation.type === "in-progress-with-open-pr") {
      console.log(
        `  ${c.yellow(issue.identifier)} holds a slot but PR ${evaluation.open.map((n) => "#" + n).join(", ")} is open — ${apply ? "moving to In Review" : "would move to In Review"}`,
      );
      console.log(c.dim(`    ${issue.title.slice(0, 70)}`));
      if (!apply) continue;
      if (!inReviewId) {
        console.log(
          c.red(`    ! no 'In Review' state on team ${repo.team}, skipping`),
        );
        continue;
      }

      const keep = (issue.labels?.nodes ?? [])
        .filter(
          (l) => l.name !== "ai:in-progress" && !l.name.startsWith("agent:"),
        )
        .map((l) => l.id);
      const want = [
        ...new Set([...keep, labelId("ai:needs-review")].filter(Boolean)),
      ];
      await queryGql(
        `mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
        { id: issue.id, in: { stateId: inReviewId, labelIds: want } },
      );
      await queryGql(
        `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
        {
          in: {
            issueId: issue.id,
            body:
              `**State reconciled: \`In Progress\` → \`In Review\`.**\n\n` +
              `PR ${evaluation.open.map((n) => `#${n}`).join(", ")} is open, so the implementation phase is over — but the ticket was still ` +
              `holding a dispatch slot, which caps how many agents can run in this repo.\n\n` +
              `Nothing about the PR was changed. The merge stage reviews it from here.`,
          },
        },
      );
    }
  }

  return { drift, actions };
}

async function main() {
  const {
    apply: APPLY,
    gate: GATE,
    quietMin: QUIET_MIN,
    only,
  } = parseArgs(process.argv.slice(2));
  const cfg = Bun.YAML.parse(
    readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"),
  );
  const repos = (cfg.repos ?? []).filter(
    (r) => !only.length || only.includes(r.name),
  );
  if (!repos.length) {
    console.error(
      `--repo required; known: ${(cfg.repos ?? []).map((r) => r.name).join(", ")}`,
    );
    process.exit(2);
  }

  let totalDrift = 0;
  for (const repo of repos) {
    const { drift, actions } = await reconcileRepo(repo, {
      apply: APPLY,
      gate: GATE,
      quietMin: QUIET_MIN,
    });
    totalDrift += drift;
    // Lifecycle observation (WM-75): fire-and-forget, one event per applied
    // move; the PR numbers make the id stable across re-runs of the same drift.
    if (APPLY && !GATE) {
      for (const a of actions) {
        const prs = (a.open ?? a.merged ?? []).join(",");
        await emitFactoryEvent(
          "factory.ticket.reconciled",
          {
            repo: repo.name,
            ticket: a.issue.identifier,
            kind: a.type,
            targetState: a.targetState,
            prs: a.open ?? a.merged ?? [],
          },
          {
            eventId: `reconcile:${a.issue.identifier}:${a.type}:${prs}`,
            subject: a.issue.identifier,
          },
        );
      }
    }
  }

  if (GATE) process.exit(totalDrift ? 0 : 1);
  if (!totalDrift)
    console.log(
      c.dim(
        "\nno drift — every In Progress ticket is genuinely in progress.\n",
      ),
    );
  else if (APPLY)
    console.log(
      c.dim(
        `\n${totalDrift} ticket(s) reconciled; those slots are free now.\n`,
      ),
    );
  else
    console.log(
      c.dim(
        `\n${totalDrift} ticket(s) would be reconciled — re-run with --apply.\n`,
      ),
    );
}

if (import.meta.main || process.argv[1]?.endsWith("reconcile.mjs"))
  await main();
