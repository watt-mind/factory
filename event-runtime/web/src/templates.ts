import type { AgentsView } from "./types";

// Trigger templates (OPS-214): one per registered event type, with the
// payload skeleton derived from that event's agent input schema. Deriving
// beats hand-maintaining — a template can never drift from the registry,
// and a newly registered event type shows up without a UI change.

export interface TriggerTemplate {
  eventType: string;
  agent: string;
  adapter: string;
  /** Field notes for the picker: what the payload wants, in one line. */
  summary: string;
  envelope: Record<string, unknown>;
}

/** A plausible starting value for one schema property — never a lie, just a seed. */
function seedFor(name: string, schema: any, nowMs: number = Date.now()): unknown {
  if (!schema || typeof schema !== "object") return "";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "array": {
      // Arrays of objects under minItems > 0 seed one skeleton element so the
      // required shape is visible. Arrays of strings seed empty even under
      // minItems (WM-76 critique r1): a seeded empty-string chip reads as a
      // rendering glitch, and the minItems validation warning covers the ask.
      const itemType = Array.isArray(schema.items?.type) ? schema.items.type[0] : schema.items?.type;
      if ((schema.minItems ?? 0) > 0 && itemType !== "string") {
        return [seedFor(name, schema.items, nowMs)];
      }
      return [];
    }
    case "object":
      return buildSkeleton(schema, nowMs);
    default:
      // Example-ish pattern hints are placeholders, not values (WM-76
      // critique r1): a pre-filled "owner/name" renders as real typed text,
      // satisfies the pattern, and ships as plausible garbage. Seed "" —
      // validation warns, never blocks — and let the form surface the
      // example via placeholderFor() (lib/injectForm.ts).
      if (typeof schema.pattern === "string") {
        if (schema.pattern.startsWith("^/") || schema.pattern.includes("/")) return "";
      }
      if (
        schema.format === "date-time" ||
        schema.format === "date" ||
        name === "at" ||
        /(?:[a-z0-9](?:At|_at|-at))$/.test(name)
      ) {
        return new Date(nowMs).toISOString();
      }
      if (
        schema.format === "uuid" ||
        name === "id" ||
        name === "ID" ||
        /(?:[a-z0-9](?:Id|_id|-id)|ID)$/.test(name)
      ) {
        return triggerId(nowMs);
      }
      return "";
  }
}

/** Required properties only: the smallest envelope that can pass validation. */
export function buildSkeleton(schema: any, nowMs: number = Date.now()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const required: string[] = schema?.required ?? [];
  const props = schema?.properties ?? {};
  for (const name of required) {
    out[name] = seedFor(name, props[name], nowMs);
  }
  return out;
}

/** One-line description of the payload shape, for the template list. */
export function summarize(schema: any): string {
  const required: string[] = schema?.required ?? [];
  if (required.length === 0) return "no required payload fields";
  return required.join(", ");
}

/**
 * Deterministic-ish id seed. The caller passes the clock so this stays a pure
 * function (and tests get stable output).
 */
export function triggerId(nowMs: number, suffix = ""): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `web-${stamp}${suffix}`;
}

export function buildTemplates(view: unknown, nowMs: number): TriggerTemplate[] {
  if (!view || typeof view !== "object" || Array.isArray(view)) return [];
  const agents = Array.isArray((view as Partial<AgentsView>).agents)
    ? (view as Partial<AgentsView>).agents!
    : null;
  const eventTypes = Array.isArray((view as Partial<AgentsView>).eventTypes)
    ? (view as Partial<AgentsView>).eventTypes!
    : null;
  if (!agents || !eventTypes) return [];

  const byRef = new Map(agents.map((a) => [a.ref, a]));
  return eventTypes.map((route) => {
    const def = route.agent ? byRef.get(route.agent) : undefined;
    const id = triggerId(nowMs);
    const eventType = route.type ?? "";
    const agent = route.agent ?? "";
    const adapter = route.adapter ?? "";
    return {
      eventType,
      agent,
      adapter,
      summary: summarize(def?.inputSchema),
      envelope: {
        schemaVersion: "factory.event/v1",
        eventId: id,
        type: eventType,
        source: "web-trigger",
        subject: "factory",
        occurredAt: new Date(nowMs).toISOString(),
        correlationId: id,
        payload: buildSkeleton(def?.inputSchema, nowMs),
      },
    };
  });
}

/**
 * Clone an existing event's envelope under a fresh identity — "fire this
 * again", which is deliberately NOT replay: replay reuses the delivery id and
 * dedups to a no-op, this makes a genuinely new admission.
 */
export function retriggerEnvelope(envelope: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  const id = triggerId(nowMs, "-again");
  return {
    ...envelope,
    eventId: id,
    correlationId: id,
    source: "web-trigger",
    occurredAt: new Date(nowMs).toISOString(),
    receivedAt: undefined,
  };
}
