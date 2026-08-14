import { describe, expect, test } from "bun:test";
import { buildSkeleton, buildTemplates, retriggerEnvelope, summarize, triggerId } from "./templates";
import type { AgentsView } from "./types";

const NOW = Date.parse("2026-08-13T09:15:00.000Z");

const agent = (over: Record<string, unknown> = {}) =>
  ({
    ref: "a@1",
    id: "a",
    version: 1,
    outputContract: "c/v1",
    workspace: { type: "ephemeral" },
    capabilities: {},
    limits: {},
    mutating: false,
    promptFile: "",
    prompt: "",
    inputSchemaFile: "",
    inputSchema: {},
    outputSchemaFile: "",
    outputSchema: {},
    pins: {},
    command: null,
    actionRegistry: null,
    hosts: null,
    eventTypes: [],
    ...over,
  }) as AgentsView["agents"][number];

describe("buildSkeleton", () => {
  test("includes required properties only — optional fields stay out of the way", () => {
    expect(
      buildSkeleton({
        required: ["host", "mount"],
        properties: { host: { type: "string" }, mount: { type: "string" }, note: { type: "string" } },
      }),
    ).toEqual({ host: "", mount: "" });
  });

  test("enums seed their first value, numbers their minimum, booleans false", () => {
    expect(
      buildSkeleton({
        required: ["host", "usedPct", "flag"],
        properties: {
          host: { enum: ["lab", "web"] },
          usedPct: { type: "number", minimum: 0 },
          flag: { type: "boolean" },
        },
      }),
    ).toEqual({ host: "lab", usedPct: 0, flag: false });
  });

  test("string arrays seed empty even under minItems — the warning covers the ask; object arrays keep one skeleton element", () => {
    expect(
      buildSkeleton({
        required: ["repos", "tags", "plan"],
        properties: {
          repos: { type: "array", minItems: 1, items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
          plan: {
            type: "array",
            minItems: 1,
            items: { type: "object", required: ["action"], properties: { action: { type: "string" } } },
          },
        },
      }),
    ).toEqual({ repos: [], tags: [], plan: [{ action: "" }] });
  });

  test("example-ish pattern hints seed empty values — the form surfaces the example as a placeholder instead", () => {
    expect(
      buildSkeleton({
        required: ["repo", "mount"],
        properties: {
          repo: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$" },
          mount: { type: "string", pattern: "^/[A-Za-z0-9/._-]*$" },
        },
      }),
    ).toEqual({ repo: "", mount: "" });
  });

  test("nested objects recurse", () => {
    expect(
      buildSkeleton({
        required: ["outer"],
        properties: {
          outer: { type: "object", required: ["inner"], properties: { inner: { type: "integer", minimum: 3 } } },
        },
      }),
    ).toEqual({ outer: { inner: 3 } });
  });

  test("seeds uuid-like property names or format: 'uuid' to a non-empty id", () => {
    expect(
      buildSkeleton(
        {
          required: ["id", "ID", "eventId", "correlationId", "alertId", "user_id", "task-id", "customRef", "grid"],
          properties: {
            id: { type: "string" },
            ID: { type: "string" },
            eventId: { type: "string" },
            correlationId: { type: "string" },
            alertId: { type: "string" },
            user_id: { type: "string" },
            "task-id": { type: "string" },
            customRef: { type: "string", format: "uuid" },
            grid: { type: "string" },
          },
        },
        NOW,
      ),
    ).toEqual({
      id: triggerId(NOW),
      ID: triggerId(NOW),
      eventId: triggerId(NOW),
      correlationId: triggerId(NOW),
      alertId: triggerId(NOW),
      user_id: triggerId(NOW),
      "task-id": triggerId(NOW),
      customRef: triggerId(NOW),
      grid: "",
    });
  });

  test("seeds date/timestamp property names or format: 'date-time' / 'date' to an ISO timestamp", () => {
    expect(
      buildSkeleton(
        {
          required: ["occurredAt", "createdAt", "updated_at", "started-at", "at", "timeField", "dateOnly", "plain"],
          properties: {
            occurredAt: { type: "string" },
            createdAt: { type: "string" },
            updated_at: { type: "string" },
            "started-at": { type: "string" },
            at: { type: "string" },
            timeField: { type: "string", format: "date-time" },
            dateOnly: { type: "string", format: "date" },
            plain: { type: "string" },
          },
        },
        NOW,
      ),
    ).toEqual({
      occurredAt: "2026-08-13T09:15:00.000Z",
      createdAt: "2026-08-13T09:15:00.000Z",
      updated_at: "2026-08-13T09:15:00.000Z",
      "started-at": "2026-08-13T09:15:00.000Z",
      at: "2026-08-13T09:15:00.000Z",
      timeField: "2026-08-13T09:15:00.000Z",
      dateOnly: "2026-08-13T09:15:00.000Z",
      plain: "",
    });
  });
});

describe("buildTemplates", () => {
  const view: AgentsView = {
    agents: [
      agent({
        ref: "disk-diagnose@1",
        inputSchema: {
          required: ["host", "mount", "usedPct", "alertId"],
          properties: {
            host: { enum: ["lab", "web"] },
            mount: { type: "string", pattern: "^/[A-Za-z0-9/._-]*$" },
            usedPct: { type: "number", minimum: 0 },
            alertId: { type: "string" },
          },
        },
      }),
    ],
    edges: {},
    eventTypes: [
      {
        type: "keephq.disk-alert.raised",
        agent: "disk-diagnose@1",
        adapter: "claude",
        idempotencyScope: ["subject", "correlationId"],
        proposalTtlSeconds: 1800,
      },
    ],
    contracts: {},
  };

  test("one template per registered event type, payload derived from the agent's schema", () => {
    const [t] = buildTemplates(view, NOW);
    expect(t.eventType).toBe("keephq.disk-alert.raised");
    expect(t.agent).toBe("disk-diagnose@1");
    expect(t.summary).toBe("host, mount, usedPct, alertId");
    expect(t.envelope).toMatchObject({
      schemaVersion: "factory.event/v1",
      type: "keephq.disk-alert.raised",
      source: "web-trigger",
      occurredAt: "2026-08-13T09:15:00.000Z",
      payload: { host: "lab", mount: "", usedPct: 0, alertId: triggerId(NOW) },
    });
  });

  test("eventId and correlationId match, so the envelope is self-consistent", () => {
    const [t] = buildTemplates(view, NOW);
    expect(t.envelope.eventId).toBe(t.envelope.correlationId);
    expect(t.envelope.eventId).toBe(triggerId(NOW));
  });

  test("an unknown agent still yields a usable envelope with an empty payload", () => {
    const [t] = buildTemplates({ ...view, agents: [] }, NOW);
    expect(t.envelope.payload).toEqual({});
    expect(t.summary).toBe("no required payload fields");
  });
});

describe("retriggerEnvelope", () => {
  test("fresh identity, same payload — deliberately not a replay", () => {
    const original = {
      schemaVersion: "factory.event/v1",
      eventId: "keep-1",
      correlationId: "alert-1",
      type: "keephq.disk-alert.raised",
      source: "keephq",
      occurredAt: "2026-08-12T10:00:00Z",
      payload: { host: "lab", usedPct: 93 },
    };
    const again = retriggerEnvelope(original, NOW);
    expect(again.eventId).not.toBe(original.eventId);
    expect(again.eventId).toBe(again.correlationId);
    expect(again.payload).toEqual(original.payload);
    expect(again.type).toBe(original.type);
    expect(again.source).toBe("web-trigger");
  });
});

describe("summarize", () => {
  test("lists required fields, or says there are none", () => {
    expect(summarize({ required: ["a", "b"] })).toBe("a, b");
    expect(summarize({})).toBe("no required payload fields");
    expect(summarize(undefined)).toBe("no required payload fields");
  });
});
