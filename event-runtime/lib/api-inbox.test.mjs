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
  makeServer,
  mkdirSync,
  mkdtempSync,
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

describe("human inbox API (WM-285)", () => {
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

      const resolved = await fetch(s.url(`/inbox/${body.item.id}/resolve`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "handled" }),
      });
      expect(resolved.status).toBe(200);
      expect((await resolved.json()).item.resolvedBy).toBe("operator");
      expect(
        (await (await fetch(s.url("/inbox?status=resolved"))).json()).items,
      ).toHaveLength(1);
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
});
