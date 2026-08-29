/**
 * Merge-review ledger and scan enumerator (WM-907 / WM-936).
 *
 * `merge_reviews` is keyed (github, pr, head_sha). `base_sha` is recorded,
 * not part of the key: a moved base with an unchanged head is a hit. A moved
 * head is a miss — the next enumerator tick emits `factory.merge-review.requested`
 * for that head only. Completing `merge-review@1` persists the row from the
 * accepted result (worker hook). `merge-scan@2` is the deterministic enumerator
 * that reads this table, fans out reviews for misses, and emits operational
 * `rebase_onto_base` fix items for hits that are CONFLICTING/BEHIND.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadForge, ForgeError } from "../../lib/forge/index.mjs";
import { sha256Hex } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import { policyMergeBatchSize } from "./planner.mjs";
import { getRepo, loadRepos, RepoError } from "./repos.mjs";
import {
  noRequiredChecksDiagnostic,
  proveMergeCiFallback,
} from "./merge-ci-proof.mjs";

export const MERGE_REVIEW_VERDICTS = Object.freeze([
  "MERGE",
  "FIX",
  "ESCALATE",
]);
export const MERGE_SCAN_AGENT = "merge-scan@2";
export const MERGE_REVIEW_AGENT = "merge-review@1";

const SHA40 = /^[0-9a-f]{40}$/;
const TICKET = /[A-Z]+-[0-9]+/;
const GITHUB_REF_TICKET = /(?:^|\/)gh-([0-9]+)$/i;
const BARE_GITHUB_REF_TICKET = /^([0-9]+)$/;
const GITHUB_BODY_TICKET =
  /(?:^|\n)\s*fixes\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+)\b/i;
const PR_LIST_FIELDS = [
  "number",
  "state",
  "isDraft",
  "headRefOid",
  "headRefName",
  "baseRefName",
  "title",
  "body",
  "mergeable",
  "mergeStateStatus",
];
const PR_VIEW_FIELDS = [...PR_LIST_FIELDS, "labels"];
const REBASE_FINDING = "rebase_onto_base";
const IN_FLIGHT_RUN_STATES = [
  "PROPOSED",
  "APPROVED",
  "QUEUED",
  "LEASED",
  "RUNNING",
  "VERIFYING",
];
const GITHUB_HOLD_LABELS = new Set(["escalated", "ai:escalated"]);

function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

function asSha(value) {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return SHA40.test(sha) ? sha : null;
}

function asPr(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function ticketFromRef(headRef, title, body, github) {
  const githubRef =
    typeof headRef === "string"
      ? (headRef.match(GITHUB_REF_TICKET) ??
        headRef.match(BARE_GITHUB_REF_TICKET))
      : null;
  if (githubRef && typeof github === "string" && github.length > 0) {
    return `${github}#${githubRef[1] ?? githubRef[2]}`;
  }
  const fromRef =
    typeof headRef === "string" ? headRef.toUpperCase().match(TICKET) : null;
  if (fromRef) return fromRef[0];
  const fromBody =
    typeof body === "string" ? body.match(GITHUB_BODY_TICKET) : null;
  if (fromBody) return fromBody[1];
  const fromTitle =
    typeof title === "string" ? title.toUpperCase().match(TICKET) : null;
  return fromTitle ? fromTitle[0] : null;
}

function parseJsonColumn(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Look up a review by (github, pr, headSha). A moved head is a miss. */
export function lookupMergeReview(db, { github, pr, headSha }) {
  const row = db
    .query(
      `SELECT github, pr, head_sha AS headSha, base_sha AS baseSha,
              verdict, findings_json AS findingsJson, fix_json AS fixJson,
              plan_json AS planJson, policy_version AS policyVersion,
              run_id AS runId, reviewed_at AS reviewedAt
         FROM merge_reviews
        WHERE github = ? AND pr = ? AND head_sha = ?`,
    )
    .get(github, pr, headSha);
  if (!row) return null;
  return {
    github: row.github,
    pr: row.pr,
    headSha: row.headSha,
    baseSha: row.baseSha,
    verdict: row.verdict,
    findings: parseJsonColumn(row.findingsJson, []),
    fix: parseJsonColumn(row.fixJson, null),
    plan: parseJsonColumn(row.planJson, null),
    policyVersion: row.policyVersion,
    runId: row.runId,
    reviewedAt: row.reviewedAt,
  };
}

export function upsertMergeReview(
  db,
  {
    github,
    pr,
    headSha,
    baseSha,
    verdict,
    findings = [],
    fix = null,
    plan = null,
    policyVersion = null,
    runId = null,
    reviewedAt,
  },
) {
  if (!MERGE_REVIEW_VERDICTS.includes(verdict)) {
    throw new Error(
      `merge_reviews verdict ${JSON.stringify(verdict)} is not MERGE|FIX|ESCALATE`,
    );
  }
  const head = asSha(headSha);
  const base = asSha(baseSha);
  const number = asPr(pr);
  if (!github || !number || !head || !base) {
    throw new Error("merge_reviews row requires github, pr, headSha, baseSha");
  }
  db.query(
    `INSERT INTO merge_reviews (
       github, pr, head_sha, base_sha, verdict, findings_json, fix_json,
       plan_json, policy_version, run_id, reviewed_at
     )      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github, pr, head_sha) DO UPDATE SET
       base_sha = excluded.base_sha,
       verdict = excluded.verdict,
       findings_json = excluded.findings_json,
       fix_json = excluded.fix_json,
       plan_json = excluded.plan_json,
       policy_version = excluded.policy_version,
       run_id = excluded.run_id,
       reviewed_at = excluded.reviewed_at`,
  ).run(
    github,
    number,
    head,
    base,
    verdict,
    JSON.stringify(findings ?? []),
    fix == null ? null : JSON.stringify(fix),
    plan == null ? null : JSON.stringify(plan),
    policyVersion,
    runId,
    reviewedAt ?? iso(),
  );
}

/**
 * Worker COMPLETED hook. No-op unless this run is merge-review@1 with a
 * schema-valid completed artifact. Never throws out of a missing optional
 * field — refuse to persist rather than write a partial key. `baseSha` is
 * required as a recorded column; it is not part of the lookup key.
 */
export function persistMergeReviewFromResult(
  db,
  { spec, result, runId, now = Date.now() },
) {
  if (spec?.agent !== MERGE_REVIEW_AGENT) return false;
  if (result?.terminalState && result.terminalState !== "completed")
    return false;
  const artifact = result?.artifact;
  if (!artifact || typeof artifact !== "object") return false;
  const github = artifact.github ?? spec.input?.github;
  const pr = asPr(artifact.pr ?? spec.input?.pr);
  const headSha = asSha(artifact.headSha ?? spec.input?.headSha);
  const baseSha = asSha(artifact.baseSha ?? spec.input?.baseSha);
  const verdict = artifact.verdict;
  if (!github || !pr || !headSha || !baseSha) return false;
  if (!MERGE_REVIEW_VERDICTS.includes(verdict)) return false;
  const planItem = Array.isArray(artifact.plan)
    ? (artifact.plan[0] ?? null)
    : null;
  const fixItem = Array.isArray(artifact.fix)
    ? (artifact.fix[0] ?? null)
    : null;
  upsertMergeReview(db, {
    github,
    pr,
    headSha,
    baseSha,
    verdict,
    findings: Array.isArray(artifact.findings) ? artifact.findings : [],
    fix: fixItem,
    plan: planItem,
    policyVersion: spec.policyVersion ?? null,
    runId,
    reviewedAt: iso(now),
  });
  return true;
}

function reviewItemFromPr(pr) {
  const item = {
    pr: pr.number,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
  };
  if (pr.headRef) item.headRef = pr.headRef;
  if (pr.ticket) item.ticket = pr.ticket;
  return item;
}

function normalizeListedPr(raw, baseSha, github) {
  const number = asPr(raw?.number);
  const headSha = asSha(raw?.headRefOid);
  const base = asSha(baseSha);
  if (!number || !headSha || !base) return null;
  return {
    number,
    isDraft: raw.isDraft === true,
    state: typeof raw.state === "string" ? raw.state.toUpperCase() : "",
    headSha,
    baseSha: base,
    headRef: typeof raw.headRefName === "string" ? raw.headRefName : null,
    baseRefName: typeof raw.baseRefName === "string" ? raw.baseRefName : null,
    ticket: ticketFromRef(raw.headRefName, raw.title, raw.body, github),
    mergeable:
      typeof raw.mergeable === "string" ? raw.mergeable.toUpperCase() : "",
    mergeStateStatus:
      typeof raw.mergeStateStatus === "string"
        ? raw.mergeStateStatus.toUpperCase()
        : "",
  };
}

function classifySelectedPr(raw, { base, baseSha, github }) {
  if (!raw) return { invalid: "missing" };
  const state = typeof raw.state === "string" ? raw.state.toUpperCase() : "";
  if (state && state !== "OPEN") return { invalid: "closed" };
  if (raw.isDraft === true) return { invalid: "draft" };
  const baseRef = typeof raw.baseRefName === "string" ? raw.baseRefName : "";
  if (baseRef && baseRef !== base) return { invalid: "wrong-base" };
  const pr = normalizeListedPr(raw, baseSha, github);
  if (!pr) return { invalid: "missing" };
  return { pr };
}

function lowestMergePlan(candidates) {
  const mergeable = candidates
    .filter(
      (row) =>
        row.verdict === "MERGE" && row.plan && typeof row.plan === "object",
    )
    .slice()
    .sort((a, b) => a.pr - b.pr);
  if (mergeable.length === 0) return [];
  return [mergeable[0].plan];
}

function planRequestsOf(repo, mergeHits) {
  return mergeHits.length > 0 ? [{ repo }] : [];
}

function recommendationOf({
  reviews,
  plan,
  fix = [],
  escalate,
  planRequests = [],
}) {
  if (escalate.length > 0) return "ESCALATE";
  if (plan.length > 0 || planRequests.length > 0) return "MERGE";
  if (reviews.length > 0) return "REVIEW";
  if (fix.length > 0) return "FIX";
  return "NOOP";
}

function noopReasonOf({
  reviews,
  plan,
  fix = [],
  escalate,
  listedCount,
  planRequests = [],
}) {
  if (
    escalate.length > 0 ||
    plan.length > 0 ||
    reviews.length > 0 ||
    fix.length > 0 ||
    planRequests.length > 0
  )
    return undefined;
  if (listedCount === 0) return "no_open_prs";
  return "all_prs_held";
}

function isBehindOrConflicting(pr, hit) {
  if (pr.mergeable === "CONFLICTING") return true;
  if (pr.mergeStateStatus === "BEHIND") return true;
  return Boolean(hit?.baseSha && pr.baseSha && hit.baseSha !== pr.baseSha);
}

function ownedPathsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

function rebaseFixItem(pr, hit, { forge, github }) {
  const headRef = pr.headRef;
  const ticket = pr.ticket;
  if (!headRef || !ticket) return null;
  const previous = hit.fix && typeof hit.fix === "object" ? hit.fix : null;
  let ownedPaths = ownedPathsFrom(previous?.ownedPaths);
  if (ownedPaths.length === 0 && forge) {
    try {
      ownedPaths = ownedPathsFrom(forge.prDiffFiles(github, pr.number));
    } catch {
      ownedPaths = [];
    }
  }
  if (ownedPaths.length === 0) return null;
  const round =
    Number.isInteger(previous?.round) && previous.round >= 1
      ? previous.round
      : 1;
  return {
    pr: pr.number,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    headRef,
    ticket,
    finding: REBASE_FINDING,
    findingHash: sha256Hex(REBASE_FINDING),
    round,
    mechanical: true,
    withinOwnedPaths: true,
    ownedPaths,
  };
}

function hasInFlightAgent(db, agent, { github, pr, headSha }) {
  if (!db) return false;
  const runPlaceholders = IN_FLIGHT_RUN_STATES.map(() => "?").join(", ");
  const run = db
    .query(
      `SELECT 1 AS ok FROM runs
        WHERE json_extract(spec_json, '$.agent') = ?
          AND json_extract(spec_json, '$.input.pr') = ?
          AND json_extract(spec_json, '$.input.headSha') = ?
          AND json_extract(spec_json, '$.input.github') = ?
          AND state IN (${runPlaceholders})
        LIMIT 1`,
    )
    .get(agent, pr, headSha, github, ...IN_FLIGHT_RUN_STATES);
  if (run) return true;
  const proposal = db
    .query(
      `SELECT 1 AS ok FROM proposals p
        JOIN runs r ON r.run_id = p.run_id
        WHERE p.status = 'open'
          AND p.decision = 'run'
          AND r.state = 'PROPOSED'
          AND json_extract(p.spec_json, '$.agent') = ?
          AND json_extract(p.spec_json, '$.input.pr') = ?
          AND json_extract(p.spec_json, '$.input.headSha') = ?
          AND json_extract(p.spec_json, '$.input.github') = ?
        LIMIT 1`,
    )
    .get(agent, pr, headSha, github);
  return Boolean(proposal);
}

/**
 * Deterministic enumerator. Does not review diffs — it classifies live PRs
 * against the ledger and emits reviews for misses (or every selected PR).
 */
export function enumerateMergeScan({
  input,
  db,
  forge,
  repos,
  now = Date.now(),
}) {
  const repoName = input?.repo;
  if (typeof repoName !== "string" || repoName.length === 0) {
    return refuse("repo is required");
  }

  let repo;
  try {
    repo = getRepo(repos ?? loadRepos(), repoName);
  } catch (err) {
    if (err instanceof RepoError) return refuse(err.message);
    throw err;
  }
  if (!repo.github || !repo.base) {
    return refuse(`repo ${repoName} is missing github or base`);
  }

  const github = repo.github;
  const base = repo.base;
  const deployBranch = repo.deployBranch ?? null;
  const selected = Array.isArray(input.prNumbers) ? input.prNumbers : null;

  let baseSha;
  try {
    const raw = String(
      forge.apiRaw(`repos/${github}/git/ref/heads/${base}`, {
        jq: ".object.sha",
      }),
    ).trim();
    baseSha = asSha(raw);
    if (!baseSha) {
      try {
        const parsed = JSON.parse(raw);
        baseSha = asSha(parsed?.object?.sha ?? parsed?.sha);
      } catch {
        baseSha = null;
      }
    }
  } catch (err) {
    return transient(github, repoName, base, deployBranch, err);
  }
  if (!baseSha) {
    return refuse(`unresolvable base SHA for ${github}#${base}`);
  }

  let listed;
  try {
    listed = selected
      ? selected.map((number) => {
          try {
            return {
              number,
              raw: forge.prView(github, number, { fields: PR_VIEW_FIELDS }),
            };
          } catch (err) {
            if (err instanceof ForgeError)
              return { number, raw: null, error: err };
            throw err;
          }
        })
      : forge
          .prList(github, {
            state: "open",
            limit: 100,
            fields: PR_LIST_FIELDS,
          })
          .map((raw) => ({ number: raw.number, raw }));
  } catch (err) {
    return transient(github, repoName, base, deployBranch, err);
  }

  if (selected) {
    const invalid = [];
    const targets = [];
    for (const entry of listed) {
      if (entry.error && !entry.raw) {
        invalid.push({ pr: entry.number, reason: "missing" });
        continue;
      }
      const classified = classifySelectedPr(entry.raw, {
        base,
        baseSha,
        github,
      });
      if (classified.invalid) {
        invalid.push({ pr: entry.number, reason: classified.invalid });
      } else {
        targets.push(classified.pr);
      }
    }
    if (invalid.length > 0) {
      return refuse(
        `invalid selected PR(s): ${invalid
          .map((row) => `#${row.pr} ${row.reason}`)
          .join("; ")}`,
        { invalid },
      );
    }
    return assemble({
      repo: repoName,
      github,
      base,
      deployBranch,
      db,
      forge,
      targets,
      forceReview: true,
      listedCount: targets.length,
    });
  }

  const targets = [];
  const wrongBase = [];
  for (const entry of listed) {
    const pr = normalizeListedPr(entry.raw, baseSha, github);
    if (!pr) continue;
    if (pr.isDraft) continue;
    if (pr.baseRefName && pr.baseRefName !== base) {
      wrongBase.push(pr);
      continue;
    }
    targets.push(pr);
  }
  return assemble({
    repo: repoName,
    github,
    base,
    deployBranch,
    db,
    forge,
    targets,
    wrongBase,
    forceReview: false,
    listedCount: targets.length,
    now,
  });
}

function assemble({
  repo,
  github,
  base,
  deployBranch,
  db,
  forge,
  targets,
  wrongBase = [],
  forceReview,
  listedCount,
}) {
  const reviews = [];
  const mergeHits = [];
  const fix = [];
  for (const pr of targets) {
    const hit = lookupMergeReview(db, {
      github,
      pr: pr.number,
      headSha: pr.headSha,
    });
    if (!hit || forceReview) {
      if (
        hasInFlightAgent(db, MERGE_REVIEW_AGENT, {
          github,
          pr: pr.number,
          headSha: pr.headSha,
        })
      ) {
        continue;
      }
      reviews.push(reviewItemFromPr(pr));
      continue;
    }
    if (isBehindOrConflicting(pr, hit)) {
      if (
        hasInFlightAgent(db, "merge-fix@1", {
          github,
          pr: pr.number,
          headSha: pr.headSha,
        })
      ) {
        continue;
      }
      const item = rebaseFixItem(pr, hit, { forge, github });
      if (item) fix.push(item);
      continue;
    }
    if (hit.verdict === "MERGE") mergeHits.push(hit);
  }
  const plan = [];
  const planRequests = planRequestsOf(repo, mergeHits);
  const escalate = wrongBase
    .filter((pr) => pr.ticket)
    .map((pr) => ({
      pr: pr.number,
      headSha: pr.headSha,
      ticket: pr.ticket,
      reason: `targets ${pr.baseRefName} instead of configured base ${base}`,
    }));
  const artifact = {
    recommendation: recommendationOf({
      reviews,
      plan,
      fix,
      escalate,
      planRequests,
    }),
    repo,
    github,
    base,
    deployBranch,
    reviews,
    plan,
    planRequests,
    fix,
    escalate,
    summary: summaryFor({
      reviews,
      plan,
      fix,
      base,
      listedCount,
      wrongBase,
      forceReview,
      planRequests,
    }),
  };
  const noopReason = noopReasonOf({
    reviews,
    plan,
    fix,
    escalate,
    listedCount,
    planRequests,
  });
  if (noopReason) artifact.noopReason = noopReason;
  return completed(artifact);
}

function summaryFor({
  reviews,
  plan,
  fix = [],
  base,
  listedCount,
  wrongBase = [],
  forceReview,
  planRequests = [],
}) {
  const bits = [];
  if (forceReview) bits.push(`selected scan of ${listedCount} PR(s)`);
  else bits.push(`${listedCount} open base-targeting PR(s)`);
  if (wrongBase.length > 0) {
    bits.push(
      `wrong-base PR(s): ${wrongBase
        .map((pr) => `#${pr.number} (${pr.baseRefName} → ${base})`)
        .join(", ")}`,
    );
  }
  bits.push(`${reviews.length} review(s) to run`);
  if (fix.length > 0) bits.push(`${fix.length} rebase fix(es)`);
  if (planRequests.length > 0) bits.push("MERGE hits queued for planning");
  if (plan.length > 0) bits.push(`lowest MERGE candidate is #${plan[0].pr}`);
  return bits.join("; ") + ".";
}

function completed(artifact) {
  return {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: "ok",
    artifact,
    evidence: { commands: ["merge-reviews.scan"] },
  };
}

function refuse(message, extra = {}) {
  return {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "refused",
    reasonCode: "needs_human",
    evidence: { message, ...extra },
  };
}

function transient(github, repo, base, deployBranch, err) {
  const summary = `transient forge error listing ${github}: ${err?.message ?? err}`;
  return completed({
    recommendation: "NOOP",
    repo,
    github,
    base,
    deployBranch,
    reviews: [],
    plan: [],
    planRequests: [],
    fix: [],
    escalate: [],
    summary,
  });
}

function githubLabelsOf(raw) {
  const labels = raw?.labels;
  if (!Array.isArray(labels)) return [];
  return labels
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : typeof entry?.name === "string"
          ? entry.name
          : "",
    )
    .filter(Boolean);
}

function linearHeld(ticketState) {
  if (!ticketState || typeof ticketState !== "object") return true;
  const state = ticketState.state?.name;
  if (state === "Blocked") return true;
  const names = (
    Array.isArray(ticketState.labels)
      ? ticketState.labels
      : (ticketState.labels?.nodes ?? [])
  ) // WM-978: both label shapes
    .map((node) => (typeof node?.name === "string" ? node.name : ""))
    .filter(Boolean);
  return names.some((name) =>
    /^(ai:escalated|type:security|.*security.*)$/i.test(name),
  );
}

export function requiredChecksGreen(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return false;
  return checks.every(
    (check) =>
      check &&
      (check.bucket === "pass" || check.bucket === "SUCCESS") &&
      (check.state === "SUCCESS" || check.state === "success"),
  );
}

export function defaultProveCi({
  forge,
  github,
  pr,
  headRef,
  headSha,
  repo,
  repos,
}) {
  try {
    const checks = forge.prChecks(github, pr, {
      required: true,
      fields: ["name", "bucket", "state"],
    });
    if (Array.isArray(checks) && checks.length > 0) {
      return requiredChecksGreen(checks);
    }
  } catch (err) {
    if (err instanceof ForgeError) {
      const diagnostic = String(err.stderr ?? "").trim();
      if (diagnostic !== noRequiredChecksDiagnostic(headRef)) return false;
    } else {
      return false;
    }
  }
  if (!repo || !repos) return false;
  try {
    const record = getRepo(repos, repo);
    const gate = record.mergeCi;
    if (!gate) return false;
    const runs = forge.runList(github, {
      limit: 20,
      fields: ["databaseId", "status", "conclusion", "headSha", "workflowName"],
    });
    const matching = (runs ?? []).filter(
      (run) => run.workflowName === gate.workflow && run.headSha === headSha,
    );
    if (matching.length !== 1) return false;
    const rawJobs = forge.apiRaw(
      `repos/${github}/actions/runs/${matching[0].databaseId}/jobs?per_page=100`,
    );
    const jobs = JSON.parse(rawJobs)?.jobs;
    proveMergeCiFallback({
      workflow: gate.workflow,
      requiredChecks: gate.requiredChecks,
      headSha,
      runs,
      jobs,
    });
    return true;
  } catch {
    return false;
  }
}

export function defaultLinearGet(ticket) {
  const result = Bun.spawnSync(["factory", "linear", "get", ticket, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`linear lookup failed for ${ticket}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

/**
 * Deterministic planner (WM-908). Reads the ledger, re-checks live
 * mergeability / required CI / holds, and takes the lowest PR numbers up to
 * policy.merge.batch_size.
 */
export function enumerateMergePlan({
  input,
  db,
  forge,
  repos,
  now = Date.now(),
  batchSize,
  proveCi = defaultProveCi,
  linearGet = defaultLinearGet,
}) {
  const size =
    Number.isInteger(batchSize) && batchSize > 0
      ? batchSize
      : policyMergeBatchSize();
  const listed = enumerateMergeScan({ input, db, forge, repos, now });
  if (listed.terminalState !== "completed") return listed;

  const { repo, github, base, deployBranch } = listed.artifact;
  let baseSha;
  try {
    const raw = String(
      forge.apiRaw(`repos/${github}/git/ref/heads/${base}`, {
        jq: ".object.sha",
      }),
    ).trim();
    baseSha = asSha(raw);
    if (!baseSha) {
      try {
        const parsed = JSON.parse(raw);
        baseSha = asSha(parsed?.object?.sha ?? parsed?.sha);
      } catch {
        baseSha = null;
      }
    }
  } catch (err) {
    return transient(github, repo, base, deployBranch, err);
  }
  if (!baseSha) return refuse(`unresolvable base SHA for ${github}#${base}`);

  let open;
  try {
    open = forge.prList(github, {
      state: "open",
      limit: 100,
      fields: PR_VIEW_FIELDS,
    });
  } catch (err) {
    return transient(github, repo, base, deployBranch, err);
  }

  const candidates = [];
  for (const raw of open) {
    const pr = normalizeListedPr(raw, baseSha, github);
    if (!pr || pr.isDraft) continue;
    if (pr.baseRefName && pr.baseRefName !== base) continue;
    const hit = lookupMergeReview(db, {
      github,
      pr: pr.number,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
    });
    if (hit?.verdict !== "MERGE" || !hit.plan || typeof hit.plan !== "object")
      continue;
    if (String(raw.mergeable ?? "").toUpperCase() !== "MERGEABLE") continue;
    if (
      githubLabelsOf(raw).some((name) =>
        GITHUB_HOLD_LABELS.has(name.toLowerCase()),
      )
    )
      continue;
    if (!pr.ticket) continue;
    try {
      if (linearHeld(linearGet(pr.ticket))) continue;
    } catch {
      continue;
    }
    if (
      !proveCi({
        forge,
        github,
        pr: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        repo,
        repos,
      })
    )
      continue;
    candidates.push(hit.plan);
  }

  const plan = candidates.sort((a, b) => a.pr - b.pr).slice(0, size);
  const artifact = {
    recommendation: plan.length > 0 ? "MERGE" : "NOOP",
    repo,
    github,
    base,
    deployBranch,
    reviews: [],
    plan,
    planRequests: [],
    fix: [],
    escalate: [],
    summary:
      plan.length > 0
        ? `planning ${plan.length} MERGE PR(s) (batch_size ${size}): ${plan.map((item) => `#${item.pr}`).join(", ")}.`
        : "no live MERGE candidates passed mergeability, CI, and hold checks.",
  };
  if (plan.length === 0) artifact.noopReason = "no_merge_candidates";
  return completed(artifact);
}

export function runPlanCli({
  cwd = process.cwd(),
  db = openDb(),
  forge = loadForge(),
  repos = loadRepos(),
  batchSize,
  proveCi,
  linearGet,
} = {}) {
  const input = JSON.parse(readFileSync(path.join(cwd, "input.json"), "utf8"));
  const result = enumerateMergePlan({
    input,
    db,
    forge,
    repos,
    batchSize,
    proveCi,
    linearGet,
  });
  writeFileSync(
    path.join(cwd, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result.terminalState === "completed" ||
    result.terminalState === "refused"
    ? 0
    : 1;
}

export function runScanCli({
  cwd = process.cwd(),
  db = openDb(),
  forge = loadForge(),
  repos = loadRepos(),
} = {}) {
  const input = JSON.parse(readFileSync(path.join(cwd, "input.json"), "utf8"));
  const result = enumerateMergeScan({ input, db, forge, repos });
  writeFileSync(
    path.join(cwd, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result.terminalState === "completed" ||
    result.terminalState === "refused"
    ? 0
    : 1;
}

if (import.meta.main) {
  const verb = process.argv[2];
  if (verb === "plan") {
    process.exit(runPlanCli());
  }
  if (verb !== "scan") {
    console.error("usage: bun event-runtime/lib/merge-reviews.mjs scan|plan");
    process.exit(2);
  }
  process.exit(runScanCli());
}
