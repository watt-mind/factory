/**
 * Merge-review ledger and scan enumerator (WM-907).
 *
 * `merge_reviews` is keyed (github, pr, head_sha, base_sha). A moved head is
 * a miss: the next enumerator tick emits `factory.merge-review.requested`
 * for that SHA pair only. Completing `merge-review@1` persists the row from
 * the accepted result (worker hook). `merge-scan@2` is the deterministic
 * enumerator that reads this table and fans out reviews for misses.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadForge, ForgeError } from "../../lib/forge/index.mjs";
import { openDb } from "./db.mjs";
import { getRepo, loadRepos, RepoError } from "./repos.mjs";

export const MERGE_REVIEW_VERDICTS = Object.freeze([
  "MERGE",
  "FIX",
  "ESCALATE",
]);
export const MERGE_SCAN_AGENT = "merge-scan@2";
export const MERGE_REVIEW_AGENT = "merge-review@1";

const SHA40 = /^[0-9a-f]{40}$/;
const TICKET = /[A-Z]+-[0-9]+/;
const PR_LIST_FIELDS = [
  "number",
  "state",
  "isDraft",
  "headRefOid",
  "headRefName",
  "baseRefName",
  "title",
];
const PR_VIEW_FIELDS = PR_LIST_FIELDS;

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

function ticketFromRef(headRef, title) {
  const fromRef =
    typeof headRef === "string" ? headRef.toUpperCase().match(TICKET) : null;
  if (fromRef) return fromRef[0];
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

/** Look up a review by the exact SHA pair. A moved head is a miss. */
export function lookupMergeReview(db, { github, pr, headSha, baseSha }) {
  const row = db
    .query(
      `SELECT github, pr, head_sha AS headSha, base_sha AS baseSha,
              verdict, findings_json AS findingsJson, fix_json AS fixJson,
              plan_json AS planJson, policy_version AS policyVersion,
              run_id AS runId, reviewed_at AS reviewedAt
         FROM merge_reviews
        WHERE github = ? AND pr = ? AND head_sha = ? AND base_sha = ?`,
    )
    .get(github, pr, headSha, baseSha);
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github, pr, head_sha, base_sha) DO UPDATE SET
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
 * field — refuse to persist rather than write a partial key.
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

function normalizeListedPr(raw, baseSha) {
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
    ticket: ticketFromRef(raw.headRefName, raw.title),
  };
}

function classifySelectedPr(raw, { base, baseSha }) {
  if (!raw) return { invalid: "missing" };
  const state = typeof raw.state === "string" ? raw.state.toUpperCase() : "";
  if (state && state !== "OPEN") return { invalid: "closed" };
  if (raw.isDraft === true) return { invalid: "draft" };
  const baseRef = typeof raw.baseRefName === "string" ? raw.baseRefName : "";
  if (baseRef && baseRef !== base) return { invalid: "wrong-base" };
  const pr = normalizeListedPr(raw, baseSha);
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

function recommendationOf({ reviews, plan, escalate }) {
  if (escalate.length > 0) return "ESCALATE";
  if (plan.length > 0) return "MERGE";
  if (reviews.length > 0) return "REVIEW";
  return "NOOP";
}

function noopReasonOf({ reviews, plan, escalate, listedCount }) {
  if (escalate.length > 0 || plan.length > 0 || reviews.length > 0)
    return undefined;
  if (listedCount === 0) return "no_open_prs";
  return "all_prs_held";
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
      const classified = classifySelectedPr(entry.raw, { base, baseSha });
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
      targets,
      forceReview: true,
      listedCount: targets.length,
    });
  }

  const targets = [];
  for (const entry of listed) {
    const pr = normalizeListedPr(entry.raw, baseSha);
    if (!pr) continue;
    if (pr.isDraft) continue;
    if (pr.baseRefName && pr.baseRefName !== base) continue;
    targets.push(pr);
  }
  return assemble({
    repo: repoName,
    github,
    base,
    deployBranch,
    db,
    targets,
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
  targets,
  forceReview,
  listedCount,
}) {
  const reviews = [];
  const mergeHits = [];
  for (const pr of targets) {
    const hit = lookupMergeReview(db, {
      github,
      pr: pr.number,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
    });
    if (!hit || forceReview) {
      reviews.push(reviewItemFromPr(pr));
      continue;
    }
    if (hit.verdict === "MERGE") mergeHits.push(hit);
  }
  const plan = lowestMergePlan(mergeHits);
  const escalate = [];
  const artifact = {
    recommendation: recommendationOf({ reviews, plan, escalate }),
    repo,
    github,
    base,
    deployBranch,
    reviews,
    plan,
    fix: [],
    escalate,
    summary: summaryFor({
      reviews,
      plan,
      listedCount,
      forceReview,
    }),
  };
  const noopReason = noopReasonOf({
    reviews,
    plan,
    escalate,
    listedCount,
  });
  if (noopReason) artifact.noopReason = noopReason;
  return completed(artifact);
}

function summaryFor({ reviews, plan, listedCount, forceReview }) {
  const bits = [];
  if (forceReview) bits.push(`selected scan of ${listedCount} PR(s)`);
  else bits.push(`${listedCount} open base-targeting PR(s)`);
  bits.push(`${reviews.length} review(s) to run`);
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
    fix: [],
    escalate: [],
    summary,
  });
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
  if (verb !== "scan") {
    console.error("usage: bun event-runtime/lib/merge-reviews.mjs scan");
    process.exit(2);
  }
  process.exit(runScanCli());
}
