import { trackTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-inbox-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GH_SECRET,
  PV,
  SECRET,
  apiClient,
  deregisterWorker,
  envelope,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  makeServer as makeApiServer,
  mkdirSync,
  observedModelFromTranscript,
  openDb,
  os,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  rejection,
  repoNamesFromInput,
  registry,
  runOnce,
  sign,
  startApi,
  utimesSync,
  writeFileSync,
} from "./api-test-helpers.mjs";
import { decisionRequestHash } from "./decision.mjs";
import { templateFor } from "./decision-templates.mjs";

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

describe("human inbox API (WM-285)", () => {
  test("GET /inbox applies a default keyset page", async () => {
    const s = await makeServer({ now: () => 1_700_000_000_000 });
    try {
      for (const title of ["a", "b", "c"]) {
        await fetch(s.url("/inbox"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "BLOCKED",
            title,
            source: "agent:test",
          }),
        });
      }
      const first = await (await fetch(s.url("/inbox?limit=2"))).json();
      expect(first.items).toHaveLength(2);
      expect(typeof first.nextBefore).toBe("string");
      const second = await (
        await fetch(
          s.url(
            `/inbox?limit=2&before=${encodeURIComponent(first.nextBefore)}`,
          ),
        )
      ).json();
      expect(second.items).toHaveLength(1);
      expect(second.nextBefore).toBeNull();
      for (const limit of ["abc", "0", "201"]) {
        const response = await fetch(s.url(`/inbox?limit=${limit}`));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_limit",
          message: "limit must be an integer between 1 and 200",
        });
      }
      for (const before of [
        "garbage",
        Buffer.from(
          JSON.stringify({
            createdAt: "2024-01-01T00:00:00.000Z",
            rowid: 0,
          }),
        ).toString("base64url"),
      ]) {
        const response = await fetch(
          s.url(`/inbox?before=${encodeURIComponent(before)}`),
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_before",
          message: "before must be a valid cursor",
        });
      }
      const invalidStatus = await fetch(s.url("/inbox?status=bogus"));
      expect(invalidStatus.status).toBe(422);
      expect(await invalidStatus.json()).toMatchObject({
        error: "invalid_status",
        message: "unknown inbox status: bogus",
      });
    } finally {
      s.close();
    }
  });

  test("POST writes before a failed delivery, rejects unknown kinds, and GET/ack/resolve filter rows", async () => {
    const delivered = [];
    const s = await makeServer({
      now: () => 1000,
      inboxWebUrl: "http://127.0.0.1:7382",
      inboxSend: async (_command, message) => {
        delivered.push(message);
        return { ok: false, exitCode: 9, error: "telegram unavailable" };
      },
    });
    try {
      const unknown = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "claimed", title: "routine" }),
      });
      expect(unknown.status).toBe(422);
      expect((await unknown.json()).error).toContain("unknown inbox kind");

      const created = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "BLOCKED",
          title: "BLOCKED WM-1: choose a policy",
          refs: { issue: "WM-1" },
          source: "agent:run_1",
        }),
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.delivery).toEqual({
        ok: false,
        exitCode: 9,
        error: "telegram unavailable",
      });
      expect(body.item.refs).toEqual({ issue: "WM-1" });
      expect(body.item.delivery.telegram.error).toBe("telegram unavailable");
      expect(delivered[0]).toEndWith(`/#/inbox/${body.item.id}`);

      let listed = await (await fetch(s.url("/inbox?status=open"))).json();
      expect(listed.items.map((item) => item.id)).toEqual([body.item.id]);

      const acked = await fetch(s.url(`/inbox/${body.item.id}/ack`), {
        method: "POST",
        body: "{}",
      });
      expect(acked.status).toBe(200);
      listed = await (await fetch(s.url("/inbox?status=acked"))).json();
      expect(listed.items).toHaveLength(1);

      for (const reason of [undefined, "", "   "]) {
        const invalid = await fetch(s.url(`/inbox/${body.item.id}/resolve`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reason === undefined ? {} : { reason }),
        });
        expect(invalid.status).toBe(422);
        expect((await invalid.json()).error).toBe(
          "reason must be a non-empty string",
        );
      }

      const resolved = await fetch(s.url(`/inbox/${body.item.id}/resolve`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "handled" }),
      });
      expect(resolved.status).toBe(200);
      expect((await resolved.json()).item).toMatchObject({
        resolvedBy: "operator",
        resolvedReason: "handled",
      });
      const resolvedItems = (
        await (await fetch(s.url("/inbox?status=resolved"))).json()
      ).items;
      expect(resolvedItems).toHaveLength(1);
      expect(resolvedItems[0].resolvedReason).toBe("handled");
    } finally {
      s.close();
    }
  });

  test("inbox routes inherit loopback Host and Origin confinement", async () => {
    const s = await makeServer({
      inboxSend: async () => ({ ok: true, exitCode: 0, error: null }),
    });
    try {
      const res = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ kind: "BLOCKED", title: "BLOCKED WM-1: q" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("cross_origin_rejected");
      expect(s.db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(
        0,
      );
    } finally {
      s.close();
    }
  });

  test("approving an expired proposal retargets the item onto the re-planned one (WM-714)", async () => {
    const refs = {
      proposalId: "prop-old",
      eventSource: "linear",
      eventId: "evt-1",
    };
    const request = templateFor("proposal_expired", {
      producer: "proposal",
      refs,
    });
    const s = await makeServer({
      now: () => 1000,
      inboxSend: async () => ({ ok: true, exitCode: 0, error: null }),
      inboxPlanner: {
        // WM-391's expired-proposal path: no approval, a fresh open proposal.
        approveProposal: () => ({
          approved: false,
          replanned: true,
          proposal: { id: "prop-fresh" },
        }),
        rejectProposal: () => ({ ok: true }),
        requeue: () => ({ ok: true }),
        admit: () => ({ admitted: true }),
      },
    });
    try {
      const created = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "proposal_expired",
          title: "DECISION NEEDED proposal prop-old: expired undecided",
          refs,
          source: "serve:notify",
          decision: request,
          dedupeKey: "proposal_expired:prop-old",
        }),
      });
      expect(created.status).toBe(201);
      const id = (await created.json()).item.id;

      const decided = await fetch(s.url(`/inbox/${id}/decide`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(request),
          optionId: "approve",
          fields: {},
        }),
      });
      expect(decided.status).toBe(200);
      expect((await decided.json()).effect).toMatchObject({
        kind: "approve_proposal",
        outcome: "applied",
        detail: "replanned_awaiting_approval",
        newProposalId: "prop-fresh",
      });

      const detail = (await (await fetch(s.url(`/inbox/${id}`))).json()).item;
      expect(detail.resolvedAt).toBeNull();
      expect(detail.refs.proposalId).toBe("prop-fresh");
      expect(detail.response).toBeNull();
      expect(detail.decidedAt).toBeNull();
      expect(detail.decision.question).toContain("prop-fresh");
      expect(detail.decision.context).toContain("please re-review");
      expect(detail.dedupeKey).toBe("proposal_expired:prop-fresh");
      expect(detail.responseHistory).toHaveLength(1);
      expect(detail.responseHistory[0]).toMatchObject({
        retargetedFrom: "prop-old",
        retargetedTo: "prop-fresh",
      });
      expect(detail.responseHistory[0].response.optionId).toBe("approve");

      // Nothing to replay: the answer was consumed by the retarget rather than
      // applied, so retry reports the item undecided instead of already_applied.
      const retried = await fetch(s.url(`/inbox/${id}/decide/retry`), {
        method: "POST",
      });
      expect(retried.status).toBe(409);
      expect((await retried.json()).error).toBe("not_decided");

      // The fresh request is pending, so a bare resolve is still refused.
      const resolved = await fetch(s.url(`/inbox/${id}/resolve`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "manual dismissal" }),
      });
      expect(resolved.status).toBe(409);

      const again = await fetch(s.url(`/inbox/${id}/decide`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(detail.decision),
          optionId: "reject",
          fields: { reason: "the re-planned spec is too different" },
        }),
      });
      expect(again.status).toBe(200);
      const settled = (await again.json()).item;
      expect(settled.resolvedBy).toBe("operator:reject_proposal");
      expect(settled.responseHistory).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  test("POST of the same subject attaches a waiter and does not push again", async () => {
    const delivered = [];
    const s = await makeServer({
      now: () => 1000,
      inboxSend: async (_command, message) => {
        delivered.push(message);
        return { ok: true, exitCode: 0, error: null };
      },
    });
    try {
      const payload = {
        kind: "BLOCKED",
        title: "BLOCKED WM-1: choose a policy",
        refs: { issue: "WM-1", runId: "run_1" },
        source: "agent:run_1",
      };
      const first = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(201);
      const firstBody = await first.json();
      expect(firstBody.item.waitingCount).toBe(1);
      expect(delivered).toHaveLength(1);

      const second = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...payload,
          refs: { issue: "WM-1", runId: "run_2" },
          source: "agent:run_2",
        }),
      });
      expect(second.status).toBe(201);
      const secondBody = await second.json();
      expect(secondBody.item.id).toBe(firstBody.item.id);
      expect(secondBody.item.waitingCount).toBe(2);
      expect(secondBody.item.waiters).toEqual([
        { runId: "run_2", at: expect.any(String) },
      ]);
      expect(secondBody.delivery.skipped).toBe("deduped");
      expect(delivered).toHaveLength(1);
    } finally {
      s.close();
    }
  });
});
