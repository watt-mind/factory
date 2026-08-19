import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-memos-test-mjs";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  handleMemosApiRoute,
  memosView,
  parseMemosQuery,
} from "./api-memos.mjs";
import { canonicalJson } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import {
  MEMO_SCHEMA_VERSION,
  memoDigest,
  registerMemos,
  withProvenance,
} from "./memos.mjs";

function postmortemDoc(overrides = {}) {
  return {
    schemaVersion: MEMO_SCHEMA_VERSION,
    subject: { type: "ticket", id: "WM-809" },
    kind: "postmortem",
    body: "Run the scoped command, not the full suite.",
    ...overrides,
  };
}

function accepted(document, { runId = "run_memo_api", now, agent } = {}) {
  const createdAt = new Date(now).toISOString();
  const full = withProvenance(document, {
    runId,
    agent: agent ?? "run-postmortem@2",
    createdAt,
  });
  const sha256 = memoDigest(full);
  return {
    full,
    sha256,
    result: { memos: [{ sha256, document: full }] },
  };
}

function putStore(storeRoot, sha256, document) {
  mkdirSync(storeRoot, { recursive: true });
  writeFileSync(path.join(storeRoot, sha256), canonicalJson(document));
}

function invoke(db, search, { now, home } = {}) {
  const url = new URL(`http://127.0.0.1/memos${search}`);
  let captured = null;
  const send = (status, body) => {
    captured = { status, body };
    return captured;
  };
  const result = handleMemosApiRoute({
    route: "GET /memos",
    url,
    send,
    db,
    env: { home },
    nowMs: now,
    artifactsDir: home ? path.join(home, "artifacts") : undefined,
  });
  return result ?? captured;
}

describe("parseMemosQuery", () => {
  test("requires subjectType and subjectId and accepts live/kind/max", () => {
    expect(() => parseMemosQuery(new URLSearchParams(""))).toThrow(
      /subjectType is required/,
    );
    expect(() =>
      parseMemosQuery(new URLSearchParams("subjectType=ticket")),
    ).toThrow(/subjectId is required/);
    expect(() =>
      parseMemosQuery(new URLSearchParams("subjectType=board&subjectId=x")),
    ).toThrow(/subjectType must be one of/);
    expect(() =>
      parseMemosQuery(
        new URLSearchParams("subjectType=ticket&subjectId=WM-1&kind=gossip"),
      ),
    ).toThrow(/kind must be one of/);
    expect(() =>
      parseMemosQuery(
        new URLSearchParams("subjectType=ticket&subjectId=WM-1&live=maybe"),
      ),
    ).toThrow(/live must be true or false/);
    expect(
      parseMemosQuery(
        new URLSearchParams(
          "subjectType=ticket&subjectId=wm-809&kind=postmortem&live=false&max=5",
        ),
      ),
    ).toEqual({
      subject: { type: "ticket", id: "wm-809" },
      kinds: ["postmortem"],
      live: false,
      max: 5,
    });
  });
});

describe("GET /memos (WM-814)", () => {
  test("returns live memos with body, provenance, expiry, and use counts", () => {
    const db = openDb(":memory:");
    const home = tmpDir("evrt-api-memos-");
    const store = path.join(home, "artifacts");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const { sha256, full, result } = accepted(postmortemDoc(), { now });
    registerMemos(db, "run_memo_api", result, { now });
    putStore(store, sha256, full);
    db.query(
      `INSERT INTO memo_uses (sha256, run_id, verdict, run_state, at)
       VALUES (?, 'run_consumer', 'useful', 'COMPLETED', ?)`,
    ).run(sha256, now + 1000);

    const res = invoke(db, "?subjectType=ticket&subjectId=wm-809", {
      now,
      home,
    });
    expect(res.status).toBe(200);
    expect(res.body.memos).toHaveLength(1);
    const memo = res.body.memos[0];
    expect(memo.sha256).toBe(sha256);
    expect(memo.subject).toEqual({ type: "ticket", id: "WM-809" });
    expect(memo.kind).toBe("postmortem");
    expect(memo.live).toBe(true);
    expect(memo.body).toBe("Run the scoped command, not the full suite.");
    expect(memo.provenance).toEqual(full.provenance);
    expect(memo.expiresAt).toBe("2026-09-17T14:02:11.000Z");
    expect(memo.usefulCount).toBe(1);
    expect(memo.wrongCount).toBe(0);
    expect(memo.uses).toEqual([
      {
        runId: "run_consumer",
        verdict: "useful",
        runState: "COMPLETED",
        at: new Date(now + 1000).toISOString(),
      },
    ]);
    db.close();
  });

  test("live=true drops expired and superseded rows; live=false returns them struck", () => {
    const db = openDb(":memory:");
    const home = tmpDir("evrt-api-memos-all-");
    const store = path.join(home, "artifacts");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const first = accepted(postmortemDoc({ body: "attempt 1" }), { now });
    registerMemos(db, "run_a", first.result, { now });
    putStore(store, first.sha256, first.full);
    const second = accepted(
      postmortemDoc({
        body: "attempt 2",
        supersedes: first.sha256,
      }),
      { now: now + 1000, runId: "run_b" },
    );
    registerMemos(db, "run_b", second.result, { now: now + 1000 });
    putStore(store, second.sha256, second.full);

    const live = invoke(db, "?subjectType=ticket&subjectId=WM-809", {
      now: now + 1000,
      home,
    });
    expect(live.body.memos.map((m) => m.sha256)).toEqual([second.sha256]);
    expect(live.body.memos[0].live).toBe(true);

    const all = invoke(db, "?subjectType=ticket&subjectId=WM-809&live=false", {
      now: now + 1000,
      home,
    });
    expect(all.body.memos.map((m) => m.sha256).sort()).toEqual(
      [first.sha256, second.sha256].sort(),
    );
    const older = all.body.memos.find((m) => m.sha256 === first.sha256);
    expect(older.live).toBe(false);
    expect(older.supersededBy).toBe(second.sha256);
    db.close();
  });

  test("kind filters the fold and a missing store still returns the ledger row", () => {
    const db = openDb(":memory:");
    const home = tmpDir("evrt-api-memos-kind-");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const note = accepted(
      {
        schemaVersion: MEMO_SCHEMA_VERSION,
        subject: { type: "repo", id: "factory" },
        kind: "repo-note",
        claim: { kind: "howto", text: "Use the scoped suite." },
        evidence: "Root suite: 6m40s. Scoped: 41s.",
        body: "Use the scoped suite.",
      },
      { now, runId: "run_note", agent: "dispatch@1" },
    );
    registerMemos(db, "run_note", note.result, { now });
    const post = accepted(postmortemDoc(), { now, runId: "run_pm" });
    registerMemos(db, "run_pm", post.result, { now });

    const filtered = invoke(
      db,
      "?subjectType=ticket&subjectId=WM-809&kind=postmortem",
      { now, home },
    );
    expect(filtered.body.memos).toHaveLength(1);
    expect(filtered.body.memos[0].kind).toBe("postmortem");
    expect(filtered.body.memos[0].body).toBeNull();

    const repo = invoke(db, "?subjectType=repo&subjectId=FACTORY", {
      now,
      home,
    });
    expect(repo.body.memos).toHaveLength(1);
    expect(repo.body.memos[0].subject).toEqual({ type: "repo", id: "factory" });
    db.close();
  });

  test("rejects unknown query values with 422 and ignores other routes", () => {
    const db = openDb(":memory:");
    expect(invoke(db, "").status).toBe(422);
    expect(invoke(db, "?subjectType=ticket").body.error).toMatch(
      /subjectId is required/,
    );
    expect(
      handleMemosApiRoute({
        route: "POST /memos",
        url: new URL("http://127.0.0.1/memos"),
        send: () => {
          throw new Error("must not send");
        },
        db,
      }),
    ).toBe(false);
    db.close();
  });

  test("memosView orders by useful count then newest", () => {
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const older = accepted(postmortemDoc({ body: "older" }), {
      now,
      runId: "run_old",
    });
    registerMemos(db, "run_old", older.result, { now });
    const newer = accepted(postmortemDoc({ body: "newer" }), {
      now: now + 5000,
      runId: "run_new",
    });
    registerMemos(db, "run_new", newer.result, { now: now + 5000 });
    db.query(
      `INSERT INTO memo_uses (sha256, run_id, verdict, run_state, at)
       VALUES (?, 'run_u1', 'useful', 'COMPLETED', ?)`,
    ).run(older.sha256, now + 10);

    const { memos } = memosView(db, {
      subject: { type: "ticket", id: "WM-809" },
      live: true,
      now: now + 5000,
      artifactsDir: tmpDir("evrt-api-memos-empty-"),
    });
    expect(memos.map((m) => m.sha256)).toEqual([older.sha256, newer.sha256]);
    db.close();
  });
});
