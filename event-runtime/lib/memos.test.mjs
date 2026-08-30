import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-memos-test-mjs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pruneArtifacts, referencedHashes } from "./artifacts.mjs";
import { hashJson, sha256Hex } from "./canonical.mjs";
import {
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  migrateDb,
  openDb,
} from "./db.mjs";
import {
  KIND_DEFAULT_TTL_MS,
  LEARNINGS_MAX,
  MEMO_RETENTION_MS,
  MEMO_SCHEMA_VERSION,
  learningsToMemos,
  listMemos,
  memoDigest,
  normalizeSubjectId,
  registerMemos,
  sweepMemos,
  validateMemo,
  withProvenance,
} from "./memos.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import { ContractViolation, verifyResult } from "./verify.mjs";

const registry = loadRegistry();
const statusDef = getAgent(registry, "factory-status-report@1");

const VALID_ARTIFACT = {
  repos: [
    { name: "bj29", triage: 1, agentReady: 2, inProgress: 0, blocked: 0 },
  ],
  recommendedAction: "dispatch",
};

function makeSpec(input = { repo: "factory", ticket: "WM-809" }) {
  return {
    schemaVersion: "factory.run-spec/v1",
    runId: "run_memo_test",
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: true },
    adapter: "fake",
    promptVersion: "git:test",
    policyVersion: "git:test",
    outputContract: "factory.status-report/v1",
    capabilities: ["linear:read"],
    timeoutSeconds: 600,
    maxAttempts: 1,
    idempotencyKey: "memo-test",
  };
}

function makeWorkspace(result) {
  const dir = tmpDir("evrt-memos-");
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(result), "utf8");
  return dir;
}

function postmortemDoc(overrides = {}) {
  return {
    schemaVersion: MEMO_SCHEMA_VERSION,
    subject: { type: "ticket", id: "WM-809" },
    kind: "postmortem",
    body: "Run the scoped command, not the full suite.",
    ...overrides,
  };
}

function repoNoteDoc(overrides = {}) {
  return {
    schemaVersion: MEMO_SCHEMA_VERSION,
    subject: { type: "repo", id: "factory" },
    kind: "repo-note",
    claim: { kind: "howto", text: "Verification is the scoped lib suite." },
    evidence: "Ran the root suite first: 6m40s. Scoped run: 41s clean.",
    body: "Verification is the scoped lib suite.",
    ...overrides,
  };
}

describe("factory.memo/v1 contract", () => {
  test("accepts a conforming postmortem and rejects unknown fields", () => {
    expect(validateMemo(postmortemDoc()).valid).toBe(true);
    const { valid, errors } = validateMemo(postmortemDoc({ extra: true }));
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("extra"))).toBe(true);
  });

  test("rejects agent-supplied provenance and admits runtime provenance", () => {
    const withAgent = postmortemDoc({
      provenance: {
        runId: "run_x",
        agent: "dispatch@1",
        createdAt: "2026-08-18T14:02:11.000Z",
      },
    });
    expect(validateMemo(withAgent).valid).toBe(false);
    expect(validateMemo(withAgent, { allowProvenance: true }).valid).toBe(true);
  });

  test("repo-note requires claim and evidence; a learning without evidence is rejected", () => {
    expect(validateMemo(repoNoteDoc()).valid).toBe(true);
    const noEvidence = { ...repoNoteDoc() };
    delete noEvidence.evidence;
    expect(validateMemo(noEvidence).valid).toBe(false);
    const noClaim = { ...repoNoteDoc() };
    delete noClaim.claim;
    expect(validateMemo(noClaim).valid).toBe(false);
  });

  test("decision memos require precedentOnly: true", () => {
    const decision = postmortemDoc({
      kind: "decision",
      precedentOnly: true,
      body: "Operator chose authorise on 2026-08-16.",
    });
    expect(validateMemo(decision).valid).toBe(true);
    expect(validateMemo(postmortemDoc({ kind: "decision" })).valid).toBe(false);
  });
});

describe("subject normalization", () => {
  test("collapses ticket case and github slug to the repo name", () => {
    expect(normalizeSubjectId("ticket", "wm-809")).toBe("WM-809");
    expect(normalizeSubjectId("repo", "watt-mind/factory")).toBe("factory");
    expect(normalizeSubjectId("repo", "FACTORY")).toBe("factory");
    expect(normalizeSubjectId("pr", "watt-mind/factory#612")).toBe(
      "factory#612",
    );
  });
});

describe("schema migration (memos, memo_uses)", () => {
  test("a fresh database has the memo ledger at CURRENT_SCHEMA_VERSION", () => {
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    const tables = db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);
    expect(tables).toContain("memos");
    expect(tables).toContain("memo_uses");
    db.close();
  });

  test("v7 databases gain memos tables on open", () => {
    const file = path.join(tmpDir("evrt-memos-db-"), "runtime.db");
    const raw = new Database(file);
    migrateDb(raw, { targetVersion: 7 });
    expect(getSchemaVersion(raw)).toBe(7);
    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memos'`,
        )
        .get(),
    ).toBeNull();
    raw.close();

    const upgraded = openDb(file);
    expect(getSchemaVersion(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      upgraded
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memos'`,
        )
        .get()?.name,
    ).toBe("memos");
    upgraded.close();
  });
});

function accepted(document, { runId = "run_memo_test", now } = {}) {
  const createdAt = new Date(now ?? Date.now()).toISOString();
  const full = withProvenance(document, {
    runId,
    agent: "run-postmortem@2",
    createdAt,
  });
  const sha256 = memoDigest(full);
  return {
    full,
    sha256,
    result: {
      memos: [{ sha256, document: full }],
      artifacts: [{ kind: "memo", sha256, document: full }],
    },
  };
}

describe("registerMemos / listMemos", () => {
  test("registers a memo and lists it live; a second insert of the same sha256 is a no-op", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const { sha256, result } = accepted(postmortemDoc(), { now });
    const first = registerMemos(db, "run_memo_test", result, { now });
    const second = registerMemos(db, "run_memo_test", result, { now });
    expect(first[0].inserted).toBe(true);
    expect(second[0].inserted).toBe(false);
    const live = listMemos(db, { type: "ticket", id: "wm-809" }, { now });
    expect(live).toHaveLength(1);
    expect(live[0].sha256).toBe(sha256);
    expect(live[0].kind).toBe("postmortem");
    db.close();
  });

  test("supersedes drops the earlier memo from the live fold but keeps the row", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const first = accepted(postmortemDoc({ body: "attempt 1" }), { now });
    registerMemos(db, "run_a", first.result, { now });
    const second = accepted(
      postmortemDoc({
        body: "attempt 2 — do not rerun the full suite",
        supersedes: first.sha256,
      }),
      { runId: "run_b", now: now + 1000 },
    );
    registerMemos(db, "run_b", second.result, { now: now + 1000 });
    const live = listMemos(
      db,
      { type: "ticket", id: "WM-809" },
      { now: now + 1000 },
    );
    expect(live.map((row) => row.sha256)).toEqual([second.sha256]);
    const all = listMemos(
      db,
      { type: "ticket", id: "WM-809" },
      { live: false, now: now + 1000 },
    );
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.sha256 === first.sha256).supersededBy).toBe(
      second.sha256,
    );
    db.close();
  });

  test("kind-default expiry drops a postmortem after 30 days", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const { result } = accepted(postmortemDoc(), { now });
    registerMemos(db, "run_memo_test", result, { now });
    expect(
      listMemos(db, { type: "ticket", id: "WM-809" }, { now }).length,
    ).toBe(1);
    expect(
      listMemos(
        db,
        { type: "ticket", id: "WM-809" },
        { now: now + KIND_DEFAULT_TTL_MS.postmortem + 1 },
      ),
    ).toHaveLength(0);
    db.close();
  });

  test("live SQL filtering keeps the existing mixed-subject fold and applies max", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const useful = accepted(postmortemDoc({ body: "useful" }), { now });
    const newer = accepted(postmortemDoc({ body: "newer" }), { now: now + 1 });
    const expired = accepted(postmortemDoc({ body: "expired" }), { now });
    const retired = accepted(postmortemDoc({ body: "retired" }), { now });
    const superseded = accepted(postmortemDoc({ body: "superseded" }), {
      now,
    });
    registerMemos(db, "run_useful", useful.result, { now });
    registerMemos(db, "run_newer", newer.result, { now: now + 1 });
    registerMemos(db, "run_expired", expired.result, { now });
    registerMemos(db, "run_retired", retired.result, { now });
    registerMemos(db, "run_superseded", superseded.result, { now });
    db.query(`UPDATE memos SET expires_at = ? WHERE sha256 = ?`).run(
      now,
      expired.sha256,
    );
    db.query(`UPDATE memos SET retired_at = ? WHERE sha256 = ?`).run(
      now,
      retired.sha256,
    );
    db.query(`UPDATE memos SET superseded_by = ? WHERE sha256 = ?`).run(
      newer.sha256,
      superseded.sha256,
    );
    registerMemos(
      db,
      "run_consumer",
      { usedMemos: [{ sha256: useful.sha256, verdict: "useful" }] },
      { now: now + 2 },
    );

    const allLive = listMemos(
      db,
      { type: "ticket", id: "WM-809" },
      { now: now + 2 },
    );
    expect(allLive.map((row) => row.sha256)).toEqual([
      useful.sha256,
      newer.sha256,
    ]);
    const live = listMemos(
      db,
      { type: "ticket", id: "WM-809" },
      { now: now + 2, max: 1 },
    );
    expect(live.map((row) => row.sha256)).toEqual([useful.sha256]);
    expect(live[0].usefulCount).toBe(1);
    db.close();
  });

  test("sweepMemos removes retained dead memos and their use rows only", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const expired = accepted(repoNoteDoc({ body: "expired" }), { now });
    const retired = accepted(repoNoteDoc({ body: "retired" }), { now });
    const predecessor = accepted(repoNoteDoc({ body: "predecessor" }), { now });
    const replacement = accepted(repoNoteDoc({ body: "replacement" }), {
      now: now - MEMO_RETENTION_MS - 1,
    });
    const live = accepted(repoNoteDoc({ body: "live" }), { now });
    for (const [runId, memo] of [
      ["run_expired", expired],
      ["run_retired", retired],
      ["run_predecessor", predecessor],
      ["run_replacement", replacement],
      ["run_live", live],
    ]) {
      registerMemos(db, runId, memo.result, { now });
    }
    db.query(`UPDATE memos SET expires_at = ? WHERE sha256 = ?`).run(
      now - MEMO_RETENTION_MS - 1,
      expired.sha256,
    );
    db.query(`UPDATE memos SET retired_at = ? WHERE sha256 = ?`).run(
      now - MEMO_RETENTION_MS - 1,
      retired.sha256,
    );
    db.query(`UPDATE memos SET superseded_by = ? WHERE sha256 = ?`).run(
      replacement.sha256,
      predecessor.sha256,
    );
    db.query(
      `INSERT INTO memo_uses (sha256, run_id, verdict, run_state, at)
       VALUES (?, 'run_use', 'useful', 'COMPLETED', ?)`,
    ).run(expired.sha256, now);
    db.query(
      `INSERT INTO memo_uses (sha256, run_id, verdict, run_state, at)
       VALUES (?, 'run_use', 'wrong', 'COMPLETED', ?)`,
    ).run(predecessor.sha256, now);

    expect(sweepMemos(db, { now })).toEqual({ deleted: 3, usesDeleted: 2 });
    expect(
      db
        .query(`SELECT sha256 FROM memos ORDER BY sha256`)
        .all()
        .map((row) => row.sha256),
    ).toEqual([live.sha256, replacement.sha256].sort());
    expect(db.query(`SELECT COUNT(*) AS n FROM memo_uses`).get().n).toBe(0);
    db.close();
  });

  test("sweepMemos keeps memos that died inside the retention window", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const expired = accepted(repoNoteDoc({ body: "expired" }), { now });
    const retired = accepted(repoNoteDoc({ body: "retired" }), { now });
    const predecessor = accepted(repoNoteDoc({ body: "predecessor" }), {
      now: now - MEMO_RETENTION_MS - 1,
    });
    const replacement = accepted(repoNoteDoc({ body: "replacement" }), {
      now,
    });
    registerMemos(db, "run_expired", expired.result, { now });
    registerMemos(db, "run_retired", retired.result, { now });
    registerMemos(db, "run_predecessor", predecessor.result, {
      now: now - MEMO_RETENTION_MS - 1,
    });
    registerMemos(db, "run_replacement", replacement.result, { now });
    db.query(`UPDATE memos SET expires_at = ? WHERE sha256 = ?`).run(
      now - 1,
      expired.sha256,
    );
    db.query(`UPDATE memos SET retired_at = ? WHERE sha256 = ?`).run(
      now - 1,
      retired.sha256,
    );
    db.query(`UPDATE memos SET superseded_by = ? WHERE sha256 = ?`).run(
      replacement.sha256,
      predecessor.sha256,
    );

    expect(sweepMemos(db, { now })).toEqual({ deleted: 0, usesDeleted: 0 });
    expect(db.query(`SELECT COUNT(*) AS n FROM memos`).get().n).toBe(4);
    db.close();
  });

  test("sweepMemos treats a dangling superseded_by as retained from the predecessor's own age", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const old = accepted(repoNoteDoc({ body: "old predecessor" }), {
      now: now - MEMO_RETENTION_MS - 1,
    });
    const young = accepted(repoNoteDoc({ body: "young predecessor" }), {
      now,
    });
    registerMemos(db, "run_old", old.result, {
      now: now - MEMO_RETENTION_MS - 1,
    });
    registerMemos(db, "run_young", young.result, { now });
    // The replacement was itself swept in an earlier pass: no row exists.
    db.query(`UPDATE memos SET superseded_by = ? WHERE sha256 IN (?, ?)`).run(
      "f".repeat(64),
      old.sha256,
      young.sha256,
    );

    expect(sweepMemos(db, { now })).toEqual({ deleted: 1, usesDeleted: 0 });
    expect(
      db
        .query(`SELECT sha256 FROM memos`)
        .all()
        .map((row) => row.sha256),
    ).toEqual([young.sha256]);
    db.close();
  });

  test("sweepMemos bounds each pass and drains the backlog across passes", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const memos = ["one", "two", "three"].map((body) =>
      accepted(repoNoteDoc({ body }), { now }),
    );
    for (const [i, memo] of memos.entries()) {
      registerMemos(db, `run_${i}`, memo.result, { now });
      db.query(`UPDATE memos SET expires_at = ? WHERE sha256 = ?`).run(
        now - MEMO_RETENTION_MS - 1,
        memo.sha256,
      );
    }

    expect(sweepMemos(db, { now, limit: 2 })).toEqual({
      deleted: 2,
      usesDeleted: 0,
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM memos`).get().n).toBe(1);
    expect(sweepMemos(db, { now, limit: 2 })).toEqual({
      deleted: 1,
      usesDeleted: 0,
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM memos`).get().n).toBe(0);
    db.close();
  });

  test("listMemos orders ties on useful_count and created_at by sha256", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const memos = ["alpha", "beta", "gamma"].map((body) =>
      accepted(repoNoteDoc({ body }), { now }),
    );
    for (const [i, memo] of memos.entries()) {
      registerMemos(db, `run_${i}`, memo.result, { now });
    }
    const expected = memos
      .map((memo) => memo.sha256)
      .sort()
      .reverse();
    for (let i = 0; i < 3; i += 1) {
      expect(
        listMemos(db, { type: "repo", id: "factory" }, { now }).map(
          (row) => row.sha256,
        ),
      ).toEqual(expected);
    }
    db.close();
  });

  test("a binding observed broken retires the memo", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const descriptionHash = `sha256:${"a".repeat(64)}`;
    const { sha256, result } = accepted(
      postmortemDoc({ bindings: { descriptionHash } }),
      { now },
    );
    registerMemos(db, "run_memo_test", result, { now });
    const live = listMemos(
      db,
      { type: "ticket", id: "WM-809" },
      { now, descriptionHash: `sha256:${"b".repeat(64)}` },
    );
    expect(live).toHaveLength(0);
    const stored = db
      .query(`SELECT retired_reason FROM memos WHERE sha256 = ?`)
      .get(sha256);
    expect(stored.retired_reason).toBe("description_hash_mismatch");
    db.close();
  });

  test("useful count orders the fold; two distinct wrong verdicts retire contradicted", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const older = accepted(postmortemDoc({ body: "older" }), {
      runId: "run_old",
      now,
    });
    const newer = accepted(postmortemDoc({ body: "newer" }), {
      runId: "run_new",
      now: now + 5000,
    });
    registerMemos(db, "run_old", older.result, { now });
    registerMemos(db, "run_new", newer.result, { now: now + 5000 });

    registerMemos(
      db,
      "run_consumer_1",
      {
        memoPin: { entries: [{ sha256: older.sha256 }] },
        usedMemos: [{ sha256: older.sha256, verdict: "useful" }],
      },
      { now: now + 6000 },
    );
    let live = listMemos(
      db,
      { type: "ticket", id: "WM-809" },
      { now: now + 6000 },
    );
    expect(live[0].sha256).toBe(older.sha256);

    registerMemos(
      db,
      "run_consumer_2",
      { usedMemos: [{ sha256: newer.sha256, verdict: "wrong" }] },
      { now: now + 7000 },
    );
    registerMemos(
      db,
      "run_consumer_3",
      { usedMemos: [{ sha256: newer.sha256, verdict: "wrong" }] },
      { now: now + 8000 },
    );
    live = listMemos(db, { type: "ticket", id: "WM-809" }, { now: now + 8000 });
    expect(live.map((row) => row.sha256)).toEqual([older.sha256]);
    const retired = db
      .query(`SELECT retired_reason FROM memos WHERE sha256 = ?`)
      .get(newer.sha256);
    expect(retired.retired_reason).toBe("contradicted");
    db.close();
  });

  test("runtime-authored documents register with run_id NULL", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const document = withProvenance(
      postmortemDoc({
        kind: "decision",
        precedentOnly: true,
        body: "Operator chose authorise.",
        refs: { inboxItemId: "inbox_1" },
      }),
      {
        runId: null,
        agent: "runtime:inbox",
        createdAt: new Date(now).toISOString(),
      },
    );
    registerMemos(db, null, document, { now });
    const live = listMemos(db, { type: "ticket", id: "WM-809" }, { now });
    expect(live).toHaveLength(1);
    expect(live[0].runId).toBeNull();
    expect(live[0].inboxItemId).toBe("inbox_1");
    db.close();
  });
});

describe("learnings → repo-note", () => {
  const def = { emits: { memos: ["repo-note"] } };
  const spec = makeSpec({ repo: "watt-mind/factory", ticket: "wm-809" });

  test("turns each learning into a repo-note on the normalized repo subject", () => {
    const { errors, memos } = learningsToMemos(
      [
        {
          claim: { kind: "howto", text: "Use the scoped verify command." },
          evidence: "Root suite took 6m40s; scoped run was 41s clean.",
        },
      ],
      { spec, def, now: Date.parse("2026-08-18T14:02:11.000Z") },
    );
    expect(errors).toEqual([]);
    expect(memos).toHaveLength(1);
    expect(memos[0].document.kind).toBe("repo-note");
    expect(memos[0].document.subject).toEqual({ type: "repo", id: "factory" });
    expect(memos[0].document.provenance.agent).toBe(spec.agent);
  });

  test("rejects more than five learnings and learnings without evidence", () => {
    const tooMany = learningsToMemos(
      Array.from({ length: LEARNINGS_MAX + 1 }, () => ({
        claim: { kind: "fact", text: "x" },
        evidence: "y",
      })),
      { spec, def },
    );
    expect(tooMany.errors[0]).toMatch(/max 5/);
    const noEvidence = learningsToMemos(
      [{ claim: { kind: "fact", text: "x" } }],
      { spec, def },
    );
    expect(noEvidence.errors.some((e) => e.includes("evidence"))).toBe(true);
  });

  test("a definition that does not emit repo-note cannot leave learnings", () => {
    const { errors } = learningsToMemos(
      [{ claim: { kind: "fact", text: "x" }, evidence: "y" }],
      { spec, def: { emits: { memos: ["postmortem"] } } },
    );
    expect(errors[0]).toMatch(/learnings_not_emitted/);
  });
});

describe("referencedHashes protects ledger memos from GC", () => {
  test("a memo with no result row is not pruned", () => {
    const db = openDb(":memory:");
    const storeRoot = tmpDir("evrt-memos-store-");
    const bytes = "memo-bytes\n";
    const sha256 = sha256Hex(bytes);
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(path.join(storeRoot, sha256), bytes);
    db.query(
      `INSERT INTO memos (sha256, subject_type, subject_id, kind, created_at)
       VALUES (?, 'ticket', 'WM-809', 'postmortem', ?)`,
    ).run(sha256, Date.now());

    expect(referencedHashes(db).has(sha256)).toBe(true);
    const pruned = pruneArtifacts(db, storeRoot, { olderThanMs: -1000 });
    expect(pruned.deleted).toBe(0);
    db.close();
  });
});

describe("verifyResult memo collection", () => {
  function writeMemoWorkspace(document) {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      artifacts: [{ kind: "memo", path: "memos/note.json" }],
    });
    mkdirSync(path.join(dir, "memos"), { recursive: true });
    writeFileSync(
      path.join(dir, "memos", "note.json"),
      JSON.stringify(document),
      "utf8",
    );
    return dir;
  }

  test("admits a memo artifact whose subject matches the spec and kind is emitted", () => {
    const def = { ...statusDef, emits: { memos: ["postmortem"] } };
    const dir = writeMemoWorkspace(postmortemDoc());
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("completed");
    expect(out.result.verification.checks).toContain("memos_valid");
    expect(out.result.memos).toHaveLength(1);
    expect(out.result.memos[0].document.provenance.runId).toBe("run_memo_test");
    expect(out.result.artifacts[0].kind).toBe("memo");
  });

  test("a memo without emits.memos is a contract violation", () => {
    const dir = writeMemoWorkspace(postmortemDoc());
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def: statusDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
  });

  test("a memo about another ticket is rejected", () => {
    const def = { ...statusDef, emits: { memos: ["postmortem"] } };
    const dir = writeMemoWorkspace(
      postmortemDoc({ subject: { type: "ticket", id: "WM-1" } }),
    );
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(/memo_subject_mismatch/);
  });

  test("agent-supplied provenance is rejected at verification", () => {
    const def = { ...statusDef, emits: { memos: ["postmortem"] } };
    const dir = writeMemoWorkspace(
      postmortemDoc({
        provenance: {
          runId: "run_forged",
          agent: "dispatch@1",
          createdAt: "2026-08-18T14:02:11.000Z",
        },
      }),
    );
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(/provenance/);
  });

  test("usedMemos whose sha256 is not in memoPin fail closed", () => {
    const def = {
      ...statusDef,
      emits: { memos: ["postmortem"] },
      outputSchema: { type: "object" },
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: {
        ...VALID_ARTIFACT,
        usedMemos: [{ sha256: "a".repeat(64), verdict: "useful" }],
      },
    });
    expect(() =>
      verifyResult({
        spec: makeSpec({
          repo: "factory",
          ticket: "WM-809",
          memoPin: { entries: [{ sha256: "b".repeat(64) }] },
        }),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(/not in this run's memoPin/);
  });

  test("learnings on the artifact become repo-note memo artifacts", () => {
    const def = {
      ...statusDef,
      emits: { memos: ["repo-note"] },
      outputSchema: { type: "object" },
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: {
        ...VALID_ARTIFACT,
        learnings: [
          {
            claim: { kind: "howto", text: "Use the scoped verify command." },
            evidence: "Root suite took 6m40s; scoped run was 41s clean.",
          },
        ],
      },
    });
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.result.verification.checks).toContain("learnings_materialized");
    expect(out.result.memos).toHaveLength(1);
    expect(out.result.memos[0].document.kind).toBe("repo-note");
    expect(out.result.artifacts.some((entry) => entry.kind === "memo")).toBe(
      true,
    );
  });
});
