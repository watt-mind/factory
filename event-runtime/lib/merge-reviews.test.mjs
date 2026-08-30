import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { memoryForge } from "../../lib/forge/memory.mjs";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-merge-reviews-test-mjs";
import { sha256Hex } from "./canonical.mjs";
import { MIGRATIONS, migrateDb, openDb } from "./db.mjs";
import {
  defaultProveCi,
  enumerateMergePlan,
  enumerateMergeScan,
  lookupMergeReview,
  persistMergeReviewFromResult,
  runScanCli,
  upsertMergeReview,
} from "./merge-reviews.mjs";

const HEAD = "a".repeat(40);
const HEAD2 = "c".repeat(40);
const BASE = "b".repeat(40);
const BASE2 = "d".repeat(40);
const GITHUB = "watt-mind/factory";
const REBASE_HASH = sha256Hex("rebase_onto_base");
const OWNED = ["event-runtime/lib/merge-reviews.mjs"];

const repos = new Map([
  [
    "factory",
    {
      name: "factory",
      github: GITHUB,
      base: "develop",
      deployBranch: "master",
    },
  ],
]);

function pr({
  number,
  headRefOid = HEAD,
  headRefName = `feat/WM-${number}`,
  baseRefName = "develop",
  isDraft = false,
  state = "OPEN",
  title = `Fixes WM-${number}`,
  body = "",
  mergeable = "MERGEABLE",
  mergeStateStatus = "CLEAN",
  files = OWNED,
  labels = [],
  checks = [
    { name: "Verify", bucket: "pass", state: "SUCCESS", required: true },
  ],
} = {}) {
  return {
    number,
    state,
    isDraft,
    headRefOid,
    headRefName,
    baseRefName,
    title,
    body,
    mergeable,
    mergeStateStatus,
    files,
    labels,
    checks,
  };
}

function rebaseItem(
  prNumber,
  { headSha = HEAD, baseSha = BASE, round = 1 } = {},
) {
  return {
    pr: prNumber,
    headSha,
    baseSha,
    headRef: `feat/WM-${prNumber}`,
    ticket: `WM-${prNumber}`,
    finding: "rebase_onto_base",
    findingHash: REBASE_HASH,
    round,
    mechanical: true,
    withinOwnedPaths: true,
    ownedPaths: OWNED,
  };
}

function insertRun(db, { runId, agent, pr, headSha, state, github = GITHUB }) {
  const now = "2026-08-19T16:45:00.000Z";
  const spec = JSON.stringify({
    agent,
    input: { github, pr, headSha, baseSha: BASE },
  });
  db.query(
    `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'sha256:test', ?, 0, ?, ?)`,
  ).run(runId, `idem-${runId}`, spec, state, now, now);
}

function insertOpenProposal(db, { id, agent, pr, headSha, github = GITHUB }) {
  const now = "2026-08-19T16:45:00.000Z";
  const runId = `run-${id}`;
  const spec = JSON.stringify({
    agent,
    input: { github, pr, headSha, baseSha: BASE },
  });
  db.query(
    `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'sha256:test', 'PROPOSED', 0, ?, ?)`,
  ).run(runId, `idem-${id}`, spec, now, now);
  db.query(
    `INSERT INTO proposals (
       id, event_source, event_id, run_id, decision, spec_json, spec_hash,
       idempotency_key, status, created_at, ttl_seconds
     ) VALUES (?, 'chain', ?, ?, 'run', ?, 'sha256:test', ?, 'open', ?, 3600)`,
  ).run(id, `evt-${id}`, runId, spec, `idem-${id}`, now);
}

function forgeWith(prs, { baseSha = BASE } = {}) {
  return memoryForge({
    repos: { [GITHUB]: { prs } },
    api: {
      [`repos/${GITHUB}/git/ref/heads/develop`]: baseSha,
    },
  });
}

function planItem(prNumber = 12) {
  return {
    pr: prNumber,
    headSha: HEAD,
    baseSha: BASE,
    headRef: `feat/WM-${prNumber}`,
    ticket: `WM-${prNumber}`,
    action: "merge_pr",
    reason: "green",
    checksGreen: true,
    mergeable: true,
    ownedPathsValid: true,
    handoffValid: true,
    testsFalsifiable: true,
    policySafe: true,
    sensitive: false,
    ambiguous: false,
  };
}

describe("configured merge_ci fallback", () => {
  const mergeCiRepos = new Map([
    [
      "factory",
      {
        ...repos.get("factory"),
        mergeCi: { workflow: "CI", requiredChecks: ["Lint", "Verify"] },
      },
    ],
  ]);

  function fallbackForge(jobs, { conclusion = "success" } = {}) {
    return memoryForge({
      repos: {
        [GITHUB]: {
          prs: [pr({ number: 42, checks: [] })],
          runs: [
            {
              databaseId: 409,
              status: "completed",
              conclusion,
              headSha: HEAD,
              workflowName: "CI",
            },
          ],
        },
      },
      api: {
        [`repos/${GITHUB}/actions/runs/409/jobs?per_page=100`]: JSON.stringify({
          jobs,
        }),
      },
    });
  }

  const prove = (forge) =>
    defaultProveCi({
      forge,
      github: GITHUB,
      pr: 42,
      headRef: "feat/WM-984",
      headSha: HEAD,
      repo: "factory",
      repos: mergeCiRepos,
    });

  test("evaluates only configured required jobs at the selected head SHA", () => {
    const forge = fallbackForge(
      [
        { name: "Lint", status: "completed", conclusion: "success" },
        { name: "Verify", status: "completed", conclusion: "success" },
        { name: "docs", status: "completed", conclusion: "failure" },
      ],
      { conclusion: "failure" },
    );

    expect(prove(forge)).toBe(true);
    expect(forge.calls).toContainEqual({
      op: "apiRaw",
      path: `repos/${GITHUB}/actions/runs/409/jobs?per_page=100`,
      jq: undefined,
    });
  });

  test("fails closed when a configured required job fails", () => {
    expect(
      prove(
        fallbackForge([
          { name: "Lint", status: "completed", conclusion: "failure" },
          { name: "Verify", status: "completed", conclusion: "success" },
        ]),
      ),
    ).toBe(false);
  });
});

describe("merge_reviews ledger keying (WM-907 / WM-936)", () => {
  test("a fresh database has the merge_reviews table", () => {
    const db = openDb(":memory:");
    const tables = db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);
    expect(tables).toContain("merge_reviews");
  });

  test("lookup misses when the head SHA moved", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 12,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(12),
    });
    expect(
      lookupMergeReview(db, {
        github: GITHUB,
        pr: 12,
        headSha: HEAD,
        baseSha: BASE,
      })?.verdict,
    ).toBe("MERGE");
    expect(
      lookupMergeReview(db, {
        github: GITHUB,
        pr: 12,
        headSha: HEAD2,
        baseSha: BASE,
      }),
    ).toBeNull();
  });

  test("lookup hits when the base SHA moved and the head did not", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 12,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(12),
    });
    const hit = lookupMergeReview(db, {
      github: GITHUB,
      pr: 12,
      headSha: HEAD,
      baseSha: BASE2,
    });
    expect(hit?.verdict).toBe("MERGE");
    expect(hit?.baseSha).toBe(BASE);
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 12,
      headSha: HEAD,
      baseSha: BASE2,
      verdict: "MERGE",
      plan: { ...planItem(12), baseSha: BASE2 },
    });
    expect(
      lookupMergeReview(db, { github: GITHUB, pr: 12, headSha: HEAD })?.baseSha,
    ).toBe(BASE2);
  });

  test("v9 rows keyed on base_sha migrate to a head-only primary key", () => {
    const file = path.join(tmpDir("merge-reviews-v11-"), "runtime.db");
    const raw = new Database(file);
    migrateDb(raw, { migrations: MIGRATIONS, targetVersion: 9 });
    raw
      .query(
        `INSERT INTO merge_reviews (
           github, pr, head_sha, base_sha, verdict, findings_json, fix_json,
           plan_json, policy_version, run_id, reviewed_at
         ) VALUES (?, 12, ?, ?, 'MERGE', '[]', NULL, NULL, NULL, 'old', '2026-08-19T16:00:00.000Z'),
                 (?, 12, ?, ?, 'FIX', '[]', NULL, NULL, NULL, 'new', '2026-08-19T17:00:00.000Z')`,
      )
      .run(GITHUB, HEAD, BASE, GITHUB, HEAD, BASE2);
    const pk = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'merge_reviews'`,
      )
      .get().sql;
    expect(pk).toContain("PRIMARY KEY (github, pr, head_sha, base_sha)");
    raw.close();

    const db = openDb(file);
    const schema = db
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'merge_reviews'`,
      )
      .get().sql;
    expect(schema).toContain("PRIMARY KEY (github, pr, head_sha)");
    expect(schema).not.toContain(
      "PRIMARY KEY (github, pr, head_sha, base_sha)",
    );
    const rows = db
      .query(
        `SELECT verdict, base_sha AS baseSha, run_id AS runId FROM merge_reviews
          WHERE github = ? AND pr = 12 AND head_sha = ?`,
      )
      .all(GITHUB, HEAD);
    expect(rows).toEqual([{ verdict: "FIX", baseSha: BASE2, runId: "new" }]);
    expect(
      lookupMergeReview(db, { github: GITHUB, pr: 12, headSha: HEAD })?.verdict,
    ).toBe("FIX");
    db.close();
  });

  test("persistMergeReviewFromResult writes the COMPLETED merge-review artifact", () => {
    const db = openDb(":memory:");
    const persisted = persistMergeReviewFromResult(db, {
      spec: {
        agent: "merge-review@1",
        policyVersion: "git:test",
        input: { github: GITHUB, pr: 12 },
      },
      result: {
        terminalState: "completed",
        artifact: {
          verdict: "FIX",
          github: GITHUB,
          pr: 12,
          headSha: HEAD,
          baseSha: BASE,
          findings: ["rebase_onto_base"],
          fix: [
            {
              pr: 12,
              headSha: HEAD,
              baseSha: BASE,
              headRef: "feat/WM-12",
              ticket: "WM-12",
              finding: "rebase_onto_base",
              findingHash: "d".repeat(64),
              round: 1,
              mechanical: true,
              withinOwnedPaths: true,
              ownedPaths: ["event-runtime/lib/worker.mjs"],
            },
          ],
          plan: [],
        },
      },
      runId: "run_review_1",
      now: Date.parse("2026-08-19T12:00:00.000Z"),
    });
    expect(persisted).toBe(true);
    const row = lookupMergeReview(db, {
      github: GITHUB,
      pr: 12,
      headSha: HEAD,
      baseSha: BASE,
    });
    expect(row.verdict).toBe("FIX");
    expect(row.runId).toBe("run_review_1");
    expect(row.fix.finding).toBe("rebase_onto_base");
    expect(
      persistMergeReviewFromResult(db, {
        spec: { agent: "merge-scan@2" },
        result: { artifact: { verdict: "MERGE" } },
        runId: "run_scan",
      }),
    ).toBe(false);
  });
});

describe("merge-scan enumerator (WM-907)", () => {
  test("canonicalizes GitHub ref slugs and falls back to a Fixes body reference", () => {
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db: openDb(":memory:"),
      forge: forgeWith([
        pr({ number: 877, headRefName: "feat/gh-877" }),
        pr({ number: 878, headRefName: "gh-878" }),
        pr({ number: 879, headRefName: "879" }),
        pr({
          number: 880,
          headRefName: "feat/no-ticket",
          body: "Fixes watt-mind/factory#880",
        }),
        pr({ number: 123, headRefName: "feat/WM-123" }),
      ]),
      repos,
    });

    expect(result.artifact.reviews.map((row) => row.ticket)).toEqual([
      "watt-mind/factory#877",
      "watt-mind/factory#878",
      "watt-mind/factory#879",
      "watt-mind/factory#880",
      "WM-123",
    ]);
  });

  test("emits reviews only for ledger misses", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 10,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "ESCALATE",
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 10 }),
        pr({ number: 11, headRefOid: HEAD2, headRefName: "feat/WM-11" }),
        pr({ number: 12, isDraft: true, headRefName: "feat/WM-12" }),
        pr({
          number: 13,
          baseRefName: "master",
          headRefName: "feat/WM-13",
        }),
      ]),
      repos,
    });
    expect(result.terminalState).toBe("completed");
    expect(result.artifact.reviews.map((row) => row.pr)).toEqual([11]);
    expect(result.artifact.plan).toEqual([]);
    expect(result.artifact.recommendation).toBe("ESCALATE");
    expect(result.artifact.escalate).toEqual([
      {
        pr: 13,
        headSha: HEAD,
        ticket: "WM-13",
        reason: "targets master instead of configured base develop",
      },
    ]);
  });

  test("escalates an open non-draft PR that targets the wrong base", () => {
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db: openDb(":memory:"),
      forge: forgeWith([
        pr({
          number: 13,
          baseRefName: "main",
          headRefName: "feat/WM-13",
        }),
      ]),
      repos,
    });

    expect(result.artifact.recommendation).toBe("ESCALATE");
    expect(result.artifact.escalate).toEqual([
      {
        pr: 13,
        headSha: HEAD,
        ticket: "WM-13",
        reason: "targets main instead of configured base develop",
      },
    ]);
    expect(result.artifact.summary).toContain(
      "wrong-base PR(s): #13 (main → develop)",
    );
  });

  test("selected scan forces a review even on a ledger hit", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 10,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(10),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory", prNumbers: [10] },
      db,
      forge: forgeWith([pr({ number: 10 })]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([
      {
        pr: 10,
        headSha: HEAD,
        baseSha: BASE,
        headRef: "feat/WM-10",
        ticket: "WM-10",
      },
    ]);
    expect(result.artifact.plan).toEqual([]);
  });

  test("open scan stubs the lowest MERGE candidate from the ledger", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 20,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(20),
    });
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 8,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(8),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 20, headRefName: "feat/WM-20" }),
        pr({ number: 8, headRefName: "feat/WM-8" }),
      ]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([]);
    expect(result.artifact.plan).toEqual([]);
    expect(result.artifact.planRequests).toEqual([{ repo: "factory" }]);
    expect(result.artifact.recommendation).toBe("MERGE");
  });

  test("an invalid selected PR refuses the whole scan", () => {
    const result = enumerateMergeScan({
      input: { repo: "factory", prNumbers: [99] },
      db: openDb(":memory:"),
      forge: forgeWith([]),
      repos,
    });
    expect(result.terminalState).toBe("refused");
    expect(result.reasonCode).toBe("needs_human");
    expect(result.evidence.message).toMatch(/#99 missing/);
  });

  test("runScanCli writes result.json from input.json", () => {
    const dir = tmpDir("merge-scan-cli-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "input.json"),
      JSON.stringify({ repo: "factory" }),
    );
    const db = openDb(":memory:");
    const code = runScanCli({
      cwd: dir,
      db,
      forge: forgeWith([]),
      repos,
    });
    expect(code).toBe(0);
    const written = JSON.parse(
      readFileSync(path.join(dir, "result.json"), "utf8"),
    );
    expect(written.artifact.noopReason).toBe("no_open_prs");
    expect(written.artifact.reviews).toEqual([]);
  });
});

describe("merge-scan enumerator (WM-936)", () => {
  test("uses the canonical GitHub ticket in merge-fix input", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 877,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(877),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({
          number: 877,
          headRefName: "feat/gh-877",
          mergeStateStatus: "BEHIND",
        }),
      ]),
      repos,
    });

    expect(result.artifact.fix).toHaveLength(1);
    expect(result.artifact.fix[0].ticket).toBe("watt-mind/factory#877");
  });

  test("base moved with head unchanged is a hit and emits no review", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 8,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(8),
    });
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 20,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "ESCALATE",
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith(
        [
          pr({ number: 8, headRefName: "feat/WM-8" }),
          pr({ number: 20, headRefName: "feat/WM-20" }),
        ],
        { baseSha: BASE2 },
      ),
      repos,
    });
    expect(result.artifact.reviews).toEqual([]);
    expect(result.artifact.plan).toEqual([]);
    expect(result.artifact.fix).toEqual([
      rebaseItem(8, { baseSha: BASE2 }),
      rebaseItem(20, { baseSha: BASE2 }),
    ]);
    expect(result.artifact.recommendation).toBe("FIX");
  });

  test("head moved is a miss", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 11,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(11),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 11, headRefOid: HEAD2, headRefName: "feat/WM-11" }),
      ]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([
      {
        pr: 11,
        headSha: HEAD2,
        baseSha: BASE,
        headRef: "feat/WM-11",
        ticket: "WM-11",
      },
    ]);
    expect(result.artifact.fix).toEqual([]);
    expect(result.artifact.recommendation).toBe("REVIEW");
  });

  test("behind-base hit emits a rebase fix item without a review", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 9,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(9),
      fix: rebaseItem(9, { round: 1 }),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({
          number: 9,
          headRefName: "feat/WM-9",
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
        }),
      ]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([]);
    expect(result.artifact.plan).toEqual([]);
    expect(result.artifact.fix).toEqual([rebaseItem(9)]);
    expect(result.artifact.fix[0].mechanical).toBe(true);
    expect(result.artifact.fix[0].withinOwnedPaths).toBe(true);
    expect(result.artifact.recommendation).toBe("FIX");
  });

  test("CONFLICTING hit emits rebase without a review", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 9,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "FIX",
      fix: rebaseItem(9, { round: 2 }),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({
          number: 9,
          headRefName: "feat/WM-9",
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        }),
      ]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([]);
    expect(result.artifact.fix[0]).toMatchObject({
      finding: "rebase_onto_base",
      round: 2,
      mechanical: true,
      withinOwnedPaths: true,
    });
  });

  test("in-flight merge-review at the same head emits no duplicate item", () => {
    const db = openDb(":memory:");
    insertRun(db, {
      runId: "run_review_inflight",
      agent: "merge-review@1",
      pr: 11,
      headSha: HEAD2,
      state: "RUNNING",
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 11, headRefOid: HEAD2, headRefName: "feat/WM-11" }),
      ]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([]);
    expect(result.artifact.recommendation).toBe("NOOP");
  });

  test("open merge-review proposal at the same head emits no duplicate item", () => {
    const db = openDb(":memory:");
    insertOpenProposal(db, {
      id: "prop_review_open",
      agent: "merge-review@1",
      pr: 11,
      headSha: HEAD2,
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 11, headRefOid: HEAD2, headRefName: "feat/WM-11" }),
      ]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([]);
  });

  test("stale open proposal linked to a refused review does not suppress a retry", () => {
    const db = openDb(":memory:");
    insertOpenProposal(db, {
      id: "prop_review_refused",
      agent: "merge-review@1",
      pr: 11,
      headSha: HEAD2,
    });
    db.query(`UPDATE runs SET state = 'REFUSED' WHERE run_id = ?`).run(
      "run-prop_review_refused",
    );

    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 11, headRefOid: HEAD2, headRefName: "feat/WM-11" }),
      ]),
      repos,
    });

    expect(result.artifact.reviews.map((row) => row.pr)).toEqual([11]);
    expect(result.artifact.recommendation).toBe("REVIEW");
  });

  test("in-flight merge-fix at the same head does not emit a second rebase", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 9,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(9),
    });
    insertRun(db, {
      runId: "run_fix_inflight",
      agent: "merge-fix@1",
      pr: 9,
      headSha: HEAD,
      state: "QUEUED",
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([pr({ number: 9, headRefName: "feat/WM-9" })], {
        baseSha: BASE2,
      }),
      repos,
    });
    expect(result.artifact.fix).toEqual([]);
    expect(result.artifact.reviews).toEqual([]);
  });
});

describe("merge-plan batch selection (WM-908)", () => {
  const linearOpen = () => ({
    state: { name: "In Review" },
    labels: { nodes: [] },
  });

  function seedMergeHits(db, numbers) {
    for (const number of numbers) {
      upsertMergeReview(db, {
        github: GITHUB,
        pr: number,
        headSha: HEAD,
        baseSha: BASE,
        verdict: "MERGE",
        plan: planItem(number),
      });
    }
  }

  test("orders by PR number and truncates to batch_size", () => {
    const db = openDb(":memory:");
    seedMergeHits(db, [11, 8, 9, 10, 12, 7]);
    const first = enumerateMergePlan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([7, 8, 9, 10, 11, 12].map((number) => pr({ number }))),
      repos,
      batchSize: 4,
      proveCi: () => true,
      linearGet: linearOpen,
    });
    expect(first.artifact.plan.map((item) => item.pr)).toEqual([7, 8, 9, 10]);
    expect(first.artifact.recommendation).toBe("MERGE");

    seedMergeHits(db, [11, 12]);
    const second = enumerateMergePlan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([11, 12].map((number) => pr({ number }))),
      repos,
      batchSize: 4,
      proveCi: () => true,
      linearGet: linearOpen,
    });
    expect(second.artifact.plan.map((item) => item.pr)).toEqual([11, 12]);
  });

  test("skips held, unmergeable, and red-CI MERGE hits", () => {
    const db = openDb(":memory:");
    seedMergeHits(db, [1, 2, 3, 4]);
    const result = enumerateMergePlan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 1, mergeable: "CONFLICTING" }),
        pr({ number: 2, labels: [{ name: "ai:escalated" }] }),
        pr({ number: 3 }),
        pr({ number: 4 }),
      ]),
      repos,
      batchSize: 4,
      proveCi: ({ pr }) => pr !== 3,
      linearGet: linearOpen,
    });
    expect(result.artifact.plan.map((item) => item.pr)).toEqual([4]);
  });

  test("zero live candidates is a NOOP", () => {
    const result = enumerateMergePlan({
      input: { repo: "factory" },
      db: openDb(":memory:"),
      forge: forgeWith([]),
      repos,
      proveCi: () => true,
      linearGet: linearOpen,
    });
    expect(result.artifact.recommendation).toBe("NOOP");
    expect(result.artifact.plan).toEqual([]);
    expect(result.artifact.noopReason).toBe("no_merge_candidates");
  });
});
