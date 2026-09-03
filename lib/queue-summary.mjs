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
import { openBlockers } from "../orchestrator/blockers.mjs";
import { parseReadyPin, readyPinMarker } from "../event-runtime/lib/triage.mjs";

/**
 * What the neutral contract still cannot answer (WM-1008).
 *
 * `attachments` is Linear's PR-link model and closed-state COUNTS need a
 * count verb; neither exists on `ControlPlane` and neither should be invented
 * in a hurry here. Active tickets — the part carrying priority, labels and
 * blockers, i.e. everything this module gates on — now come from
 * `listTickets()`. This residue is deliberately the smallest Linear-shaped
 * query that still answers the rest, and is tracked for removal.
 *
 * Under `controlPlane.kind: github` this degrades rather than throws: the
 * counts read 0 and PR links are absent, while queue gating stays correct.
 */
const EXTRAS_QUERY = `
  query($team: String!, $project: String!) {
    active: issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes { identifier attachments(first: 20) { nodes { url } } }
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

/**
 * Whether the latest ready-pin comment still describes the ticket body.
 *
 * This deliberately uses the same marker factory as planner admission: a
 * lookalike SHA-256 calculation here would make the queue disagree with the
 * refusal it is meant to surface. Returns one of "fresh", "stale", or
 * "missing". Missing is kept distinct from stale: a stale pin means the body
 * changed after a human approved it, while a missing pin means nothing was
 * ever stamped. Whether missing is admissible depends on the control plane
 * (see `qualifyReadyTickets`); this function only classifies. An unreadable
 * comment feed is the caller's fourth state ("unreadable") and must not be
 * advertised as ready.
 */
export function readyPinStatus(description = "", comments = []) {
  let latest = null;
  for (const [index, comment] of comments.entries()) {
    const hash = parseReadyPin(comment?.body);
    if (!hash) continue;
    const createdAt = Date.parse(comment?.createdAt ?? "");
    if (
      !latest ||
      (Number.isFinite(createdAt) &&
        (!Number.isFinite(latest.createdAt) ||
          createdAt >= latest.createdAt)) ||
      (!Number.isFinite(createdAt) &&
        !Number.isFinite(latest.createdAt) &&
        index > latest.index)
    ) {
      latest = { hash, createdAt, index };
    }
  }
  if (!latest) return "missing";
  return parseReadyPin(readyPinMarker(description)) === latest.hash
    ? "fresh"
    : "stale";
}

/** Comment feeds read per ready ticket at once; bounds tracker fan-out. */
export const READY_PIN_CONCURRENCY = 5;

/**
 * Classify every ready ticket's pin, reading comment feeds in bounded
 * batches so a large ready queue does not open one tracker request per
 * ticket simultaneously. Exported for tests; `listComments` is injected.
 */
export async function readyPinStatuses(
  tickets,
  listComments,
  concurrency = READY_PIN_CONCURRENCY,
) {
  const statuses = new Map();
  const width = Math.max(1, concurrency | 0);
  for (let start = 0; start < tickets.length; start += width) {
    const batch = tickets.slice(start, start + width);
    const results = await Promise.all(
      batch.map(async (ticket) => {
        try {
          return [
            ticket.identifier,
            readyPinStatus(
              ticket.description,
              await listComments(ticket.identifier),
            ),
          ];
        } catch {
          return [ticket.identifier, "unreadable"];
        }
      }),
    );
    for (const [identifier, status] of results)
      statuses.set(identifier, status);
  }
  return statuses;
}

/**
 * Split nominally-ready tickets into planner-admissible and qualified groups.
 *
 * `missingAdmissible` mirrors the planner: under a GitHub control plane an
 * absent pin is refused outright (`ticket_ready_pin_missing`,
 * event-runtime/lib/planner.mjs), so it must not be counted as dispatchable
 * supply there. Linear/memory tickets carry no pin check at admission, so a
 * missing pin stays admissible for them. Missing is never folded into stale:
 * the two have different remedies (re-stamp vs. review the body change).
 */
export function qualifyReadyTickets(
  tickets,
  pinStatuses,
  { missingAdmissible = true } = {},
) {
  const status = (ticket) => pinStatuses.get(ticket.identifier);
  const stale = tickets.filter((ticket) => status(ticket) === "stale");
  const unreadable = tickets.filter(
    (ticket) => status(ticket) === "unreadable",
  );
  const missing = missingAdmissible
    ? []
    : tickets.filter((ticket) => status(ticket) === "missing");
  const excluded = new Set(
    [...stale, ...unreadable, ...missing].map((t) => t.identifier),
  );
  return {
    stale,
    unreadable,
    missing,
    admissible: tickets.filter((ticket) => !excluded.has(ticket.identifier)),
  };
}

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
    const cp = loadControlPlane({ repoName: repo.name });
    // Priority order and blocker resolution come from the adapter, so this
    // summary and the dispatcher cannot disagree about what "ready" means.
    const nodes = await cp.listTickets({
      team: repo.team,
      project: repo.project,
    });
    let data;
    try {
      data = await cp.raw(EXTRAS_QUERY, {
        team: repo.team,
        project: repo.project,
      });
    } catch {
      // A control plane that cannot answer a Linear-shaped query must not
      // take the whole queue view down — gating above is already correct.
      data = null;
    }
    const attachmentsBy = new Map(
      (data?.active?.nodes ?? []).map((n) => [n.identifier, n.attachments]),
    );
    for (const n of nodes) n.attachments = attachmentsBy.get(n.identifier);
    const closed = data?.closed?.nodes ?? [];
    const done = closed.filter((i) => i.state?.type === "completed").length;
    const total = nodes.length + closed.length;
    const countCapped = nodes.length === 250 || closed.length === 250;
    // Flat array from the adapter; the {nodes} wrapper only if something
    // still hands us a raw Linear issue (WM-978 tolerance).
    const labels = (i) =>
      (Array.isArray(i.labels) ? i.labels : (i.labels?.nodes ?? [])).map(
        (l) => l.name,
      );
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
    // A stale pin is a real planner refusal, not dispatchable supply. Read
    // comments only for ready candidates so the queue's cost remains bounded
    // by the small set it might otherwise advertise for work.
    const pinStatuses = await readyPinStatuses(readyAll, (identifier) =>
      cp.listComments(identifier),
    );
    const {
      stale: readyStale,
      unreadable: readyUnreadable,
      missing: readyMissingPin,
      admissible: readyPinned,
    } = qualifyReadyTickets(readyAll, pinStatuses, {
      // The planner refuses a pin-less GitHub ticket outright; only the
      // Linear/memory planes admit one.
      missingAdmissible: cp.kind !== "github",
    });
    // "Ready" and "ready but waiting on another ticket" are different facts, and
    // folding them into one count hides the second entirely: a held ticket sits
    // in Todo consuming no slot and raising no error, so a wrong or forgotten
    // `blocked by` relation would starve it invisibly. Split the line instead.
    const readyHeld = readyPinned.filter((i) => openBlockers(i).length);
    const ready = readyPinned.filter((i) => !openBlockers(i).length);
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
      readyStale: readyStale.length,
      readyStaleTickets: readyStale.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        url: t.url,
      })),
      readyUnreadable: readyUnreadable.length,
      // GitHub-plane tickets with no pin at all: refused as
      // ticket_ready_pin_missing, fixed by re-promoting (remove/add the
      // label) rather than by reviewing a body change.
      readyMissingPin: readyMissingPin.length,
      readyMissingPinTickets: readyMissingPin.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        url: t.url,
      })),
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
