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
function seedFor(name: string, schema: any): unknown {
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
      // minItems > 0 means "empty is invalid" — seed one element so the
      // template is submittable, not a guaranteed 422.
      const item = seedFor(name, schema.items);
      return (schema.minItems ?? 0) > 0 ? [item] : [];
    }
    case "object":
      return buildSkeleton(schema);
    default:
      // Pattern-constrained strings get a hint the operator can recognise and
      // replace; anything else stays empty rather than inventing content.
      if (typeof schema.pattern === "string") {
        // Order matters: a path pattern ("^/…") also contains a slash, so the
        // absolute-path case must be tested before the owner/name case.
        if (schema.pattern.startsWith("^/")) return "/";
        if (schema.pattern.includes("/")) return "owner/name";
      }
      return "";
  }
}

/** Required properties only: the smallest envelope that can pass validation. */
export function buildSkeleton(schema: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const required: string[] = schema?.required ?? [];
  const props = schema?.properties ?? {};
  for (const name of required) {
    out[name] = seedFor(name, props[name]);
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

export function buildTemplates(view: AgentsView, nowMs: number): TriggerTemplate[] {
  const byRef = new Map(view.agents.map((a) => [a.ref, a]));
  return (view.eventTypes ?? []).map((route) => {
    const def = byRef.get(route.agent);
    const id = triggerId(nowMs);
    return {
      eventType: route.type,
      agent: route.agent,
      adapter: route.adapter,
      summary: summarize(def?.inputSchema),
      envelope: {
        schemaVersion: "factory.event/v1",
        eventId: id,
        type: route.type,
        source: "web-trigger",
        subject: "factory",
        occurredAt: new Date(nowMs).toISOString(),
        correlationId: id,
        payload: buildSkeleton(def?.inputSchema),
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
