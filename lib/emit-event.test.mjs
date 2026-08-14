import { afterAll, describe, expect, test } from "bun:test";
import { buildEnvelope, emitFactoryEvent } from "./emit-event.mjs";

describe("buildEnvelope", () => {
  test("builds a factory.event/v1 envelope with the caller's deterministic id", () => {
    const env = buildEnvelope(
      "factory.ticket.dispatched",
      { repo: "bj29", ticket: "CLNT-1" },
      { eventId: "dispatch:CLNT-1:x", subject: "CLNT-1", occurredAt: "2026-08-14T00:00:00Z" },
    );
    expect(env).toEqual({
      schemaVersion: "factory.event/v1",
      eventId: "dispatch:CLNT-1:x",
      type: "factory.ticket.dispatched",
      source: "orchestrator",
      subject: "CLNT-1",
      occurredAt: "2026-08-14T00:00:00Z",
      correlationId: "dispatch:CLNT-1:x",
      causationId: null,
      payload: { repo: "bj29", ticket: "CLNT-1" },
    });
  });

  test("refuses a missing eventId — accidental random identity would break dedup", () => {
    expect(() => buildEnvelope("t", {}, {})).toThrow(/eventId/);
  });
});

describe("emitFactoryEvent", () => {
  test("nothing listening → resolves null quickly, never throws", async () => {
    const started = Date.now();
    const outcome = await emitFactoryEvent(
      "factory.ticket.dispatched",
      { repo: "bj29" },
      { eventId: "dispatch:none:1", port: 1, timeoutMs: 500 },
    );
    expect(outcome).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a listening intake receives the envelope on POST /replay", async () => {
    let received = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/replay") {
          received = await req.json();
          return Response.json({ admitted: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    afterAll(() => server.stop(true));

    const outcome = await emitFactoryEvent(
      "factory.ticket.reaped",
      { ticket: "CLNT-2", reason: "returned_to_todo" },
      { eventId: "reap:CLNT-2:123", subject: "CLNT-2", port: server.port },
    );
    expect(outcome).toEqual({ admitted: true });
    expect(received.type).toBe("factory.ticket.reaped");
    expect(received.eventId).toBe("reap:CLNT-2:123");
    expect(received.source).toBe("orchestrator");
    server.stop(true);
  });

  test("an invalid envelope (no eventId) is swallowed, not thrown", async () => {
    expect(await emitFactoryEvent("t", {}, { port: 1 })).toBeNull();
  });
});
