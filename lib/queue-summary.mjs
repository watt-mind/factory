/**
 * Shared queue snapshot for queue.mjs, next.mjs, and the watch TUI.
 *
 * One Linear + GitHub read path so gate predicates and recommendations never
 * drift from what "dispatch would start" actually means.
 */
import { loadConfigYaml } from "./schedule.mjs";
import { loadControlPlane } from "./control-plane/index.mjs";
import { loadForge } from "./forge/index.mjs";
import {
  effectiveOwnedPaths,
  pathsCollide,
} from "../orchestrator/owned-paths.mjs";
import {
  AI_BLOCKED,
  answeredHeldTickets,
} from "../orchestrator/reply-detection.mjs";
import { liveWorkerLeases } from "./worker-leases.mjs";
import {
  openBlockers,
  BLOCKING_RELATIONS_GQL,
} from "../orchestrator/blockers.mjs";

const QUERY = `
  query($team: String!, $project: String!) {
    active: issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        identifier title description priority url
        attachments(first: 20) { nodes { url } }
        state { name type }
        assignee { name }
        labels(first: 20) { nodes { name } }
        ${BLOCKING_RELATIONS_GQL}
      }
    }
    closed: issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { in: ["completed", "canceled"] } }
    }) {
      nodes { state { type } }
    }
  }`;

/** Same predicates as queue.mjs --gate. Import here, don't rephrase. */
export const STAGE_GATES = {
  triage: (s) => s.triageState > 0 || s.answered > 0,
  dispatch: (s) => s.slotsFree > 0 && s.startable.length > 0,
  merge: (s) => s.openPRs > 0,
};

export function loadQueueConfig(repoFilter = []) {
  const cfg = loadConfigYaml("repos");
  const policy = loadConfigYaml("policy");
  const defaultCap = policy?.concurrency?.max_in_flight_per_repo ?? 3;
  const repos = (cfg.repos ?? []).filter(
    (r) => !repoFilter.length || repoFilter.includes(r.name),
  );
  return { repos, policy, defaultCap };
}

async function openPRSummary(nameWithOwner) {
  try {
    const prs = loadForge().prList(nameWithOwner, {
      state: "all",
      limit: 250,
      fields: ["number", "url", "body", "isDraft", "labels", "title", "state"],
    });
    const open = prs.filter((pr) => pr.state === "OPEN");
    return {
      all: open.length,
      drafts: open.filter((pr) => pr.isDraft).length,
      escalated: open.filter((pr) =>
        (pr.labels ?? []).some((l) => l.name === "escalated"),
      ).length,
      allPRs: prs,
      mergeCandidates: open.filter(
        (pr) =>
          !pr.isDraft && !(pr.labels ?? []).some((l) => l.name === "escalated"),
      ),
    };
  } catch {
    return { all: 0, drafts: 0, escalated: 0, allPRs: [], mergeCandidates: [] };
  }
}

function issuePR(issue, repo, prs) {
  const attachmentNumbers = new Set(
    (issue.attachments?.nodes ?? []).flatMap((a) => {
      const m = new RegExp(
        `github\\.com/${repo.github.replace("/", "\\/")}/pull/(\\d+)`,
        "i",
      ).exec(a.url ?? "");
      return m ? [Number(m[1])] : [];
    }),
  );
  const id = String(issue.identifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prs.find(
    (pr) =>
      attachmentNumbers.has(pr.number) ||
      new RegExp(`\\b${id}\\b`, "i").test(
        `${pr.title ?? ""}\n${pr.body ?? ""}`,
      ),
  );
}

/** @param {object[]} repos from config/repos.yaml @param {number} defaultCap */
export async function fetchQueueSummaries(repos, defaultCap) {
  const summary = [];

  for (const repo of repos) {
    const data = await loadControlPlane().raw(QUERY, {
      team: repo.team,
      project: repo.project,
    });
    const nodes = data?.active?.nodes ?? [];
    const closed = data?.closed?.nodes ?? [];
    const done = closed.filter((i) => i.state?.type === "completed").length;
    const total = nodes.length + closed.length;
    const countCapped = nodes.length === 250 || closed.length === 250;
    const labels = (i) => (i.labels?.nodes ?? []).map((l) => l.name);
    const state = (i) => i.state?.name ?? "?";

    const triage = nodes.filter(
      (i) => state(i) === "Triage" && !labels(i).includes(AI_BLOCKED),
    );
    const triageHeld = nodes.filter(
      (i) => state(i) === "Triage" && labels(i).includes(AI_BLOCKED),
    );
    const readyAll = nodes.filter(
      (i) => state(i) === "Todo" && labels(i).includes("ai:agent-ready"),
    );
    // "Ready" and "ready but waiting on another ticket" are different facts, and
    // folding them into one count hides the second entirely: a held ticket sits
    // in Todo consuming no slot and raising no error, so a wrong or forgotten
    // `blocked by` relation would starve it invisibly. Split the line instead.
    const readyHeld = readyAll.filter((i) => openBlockers(i).length);
    const ready = readyAll.filter((i) => !openBlockers(i).length);
    const notReady = nodes.filter(
      (i) => state(i) === "Todo" && !labels(i).includes("ai:agent-ready"),
    );
    const inProgress = nodes.filter((i) => state(i) === "In Progress");
    const inReview = nodes.filter((i) => state(i) === "In Review");
    const blocked = nodes.filter((i) => state(i) === "Blocked");

    const heldAny = nodes.filter(
      (i) =>
        ["Triage", "Blocked"].includes(state(i)) &&
        labels(i).includes(AI_BLOCKED),
    );
    const answeredIds = heldAny.length
      ? await answeredHeldTickets(repo)
      : new Set();
    const answered = heldAny.filter((i) => answeredIds.has(i.identifier));

    const prs = repo.github
      ? await openPRSummary(repo.github)
      : { all: 0, drafts: 0, escalated: 0, allPRs: [], mergeCandidates: [] };
    const openPRs = prs.mergeCandidates;

    const workers = liveWorkerLeases(repo.name);
    const workerIds = new Set(workers.map((w) => w.ticket));
    const orphanedClaims = inProgress.filter(
      (i) => !workerIds.has(i.identifier),
    );
    const inFlightPaths = inProgress.flatMap((i) =>
      effectiveOwnedPaths(i.description ?? ""),
    );
    const sorted = [...ready].sort(
      (a, b) => (a.priority || 99) - (b.priority || 99),
    );
    const slotsFree = repo.report_only
      ? 0
      : Math.max(0, (repo.max_in_flight ?? defaultCap) - workers.length);
    const free = [];
    const busyPaths = [...inFlightPaths];
    for (const t of sorted) {
      if (free.length >= slotsFree) break;
      const own = effectiveOwnedPaths(t.description ?? "");
      if (pathsCollide(own, busyPaths)) continue;
      free.push(t);
      busyPaths.push(...own);
    }

    summary.push({
      repo: repo.name,
      reportOnly: !!repo.report_only,
      github: repo.github,
      team: repo.team,
      done,
      total,
      countCapped,
      triage: triage.length + notReady.length,
      triageState: triage.length,
      triageHeld: triageHeld.length,
      todoNotReady: notReady.length,
      answered: answered.length,
      ready: ready.length,
      // Held ≠ ready: dispatch will not touch these until the named blockers
      // finish. Surfaced separately so starvation from a stale relation is a
      // visible line in watch, not an empty queue.
      readyHeld: readyHeld.length,
      readyHeldTickets: readyHeld.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        url: t.url,
        blockedBy: openBlockers(t),
      })),
      inProgress: inProgress.length,
      workers: workers.length,
      liveWorkerIds: workers.map((w) => w.ticket),
      orphanedClaims: orphanedClaims.length,
      inReview: inReview.length,
      openPRs: openPRs.length,
      allOpenPRs: prs.all,
      draftPRs: prs.drafts,
      escalatedPRs: prs.escalated,
      blocked: blocked.length,
      slotsFree,
      startable: free.map((t) => t.identifier),
      startableTickets: free.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        url: t.url,
      })),
      inProgressTickets: inProgress.map((t) => {
        const pr = issuePR(t, repo, prs.allPRs);
        return {
          identifier: t.identifier,
          title: t.title,
          url: t.url,
          prNumber: pr?.number,
          prUrl: pr?.url,
        };
      }),
      inReviewTickets: inReview.map((t) => {
        const pr = issuePR(t, repo, prs.allPRs);
        return {
          identifier: t.identifier,
          title: t.title,
          url: t.url,
          prNumber: pr?.number,
          prUrl: pr?.url,
        };
      }),
      blockedTickets: blocked.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        url: t.url,
      })),
      answeredTickets: answered.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        url: t.url,
      })),
    });
  }

  return summary;
}
