import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import { buildTemplates, triggerId, type TriggerTemplate } from "../templates";
import { Button, Dialog, VerbError } from "./ui";

const REQUIRED = ["schemaVersion", "eventId", "type", "source", "occurredAt"];

/** Blank slate for an unregistered/hand-written envelope (the escape hatch). */
function blankEnvelope(nowMs: number) {
  const id = triggerId(nowMs);
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type: "",
    source: "web-trigger",
    subject: "factory",
    occurredAt: new Date(nowMs).toISOString(),
    correlationId: id,
    payload: {},
  };
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Inject dialog (webui spec §4.4, templates per OPS-214).
 *
 * Templates are derived from the registry — one per registered event type,
 * with the payload skeleton built from that event's agent input schema — so
 * they cannot drift from what the runtime will actually accept, and a newly
 * registered event type appears here with no UI change. The raw JSON stays
 * editable underneath: the template is a starting point, never a cage.
 */
export function InjectDialog({
  onClose,
  initialEnvelope,
}: {
  onClose: () => void;
  initialEnvelope?: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const registry = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  // One clock read per dialog opening: stable ids while editing, fresh ones
  // each time the dialog is opened.
  const openedAt = useMemo(() => Date.now(), []);
  const templates = useMemo(
    () => (registry.data ? buildTemplates(registry.data, openedAt) : []),
    [registry.data, openedAt],
  );

  const [selected, setSelected] = useState<string | null>(initialEnvelope ? "__given__" : null);
  const [text, setText] = useState(() => pretty(initialEnvelope ?? blankEnvelope(openedAt)));
  const [clientError, setClientError] = useState<string | null>(null);
  // Unregistered event types are legitimately admissible (they park as
  // human_needed), so this warns once and then lets the operator through.
  const [unregisteredAck, setUnregisteredAck] = useState(false);

  const inject = useMutation({
    mutationFn: (envelope: unknown) => api.replay(envelope),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  function choose(template: TriggerTemplate) {
    setSelected(template.eventType);
    setText(pretty(template.envelope));
    setClientError(null);
    setUnregisteredAck(false);
    inject.reset();
  }

  function submit() {
    setClientError(null);
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(text);
    } catch (err) {
      setClientError(`not valid JSON: ${(err as Error).message}`);
      return;
    }
    const missing = REQUIRED.filter((k) => typeof envelope[k] !== "string" || !envelope[k]);
    if (missing.length) {
      setClientError(`missing required string field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
      return;
    }
    const registered = registry.data?.eventTypes.some((r) => r.type === envelope.type) ?? true;
    if (!registered && !unregisteredAck) {
      setClientError(
        `"${envelope.type}" is not a registered event type — it will be admitted, but planning will park it as human_needed. Inject again to confirm.`,
      );
      setUnregisteredAck(true);
      return;
    }
    inject.mutate(envelope);
  }

  const outcome = inject.data;
  return (
    <Dialog title="Inject event" onClose={onClose} wide>
      <div className="mb-3 text-[12px] text-(--text-dim)">
        Templates come from the registry — payload fields are the ones each agent's input schema
        requires. Edit freely before firing; duplicate delivery is safe.
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {templates.map((t) => (
          <button
            key={t.eventType}
            type="button"
            title={`${t.agent} · payload: ${t.summary}`}
            onClick={() => choose(t)}
            className={`rounded-md border px-2 py-1 text-left text-[11.5px] ${
              selected === t.eventType
                ? "border-(--accent) bg-(--surface-3) text-(--text)"
                : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
            }`}
          >
            <span className="mono">{t.eventType}</span>
            <span className="ml-1.5 text-(--text-faint)">{t.summary}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setText(pretty(blankEnvelope(openedAt)));
            setUnregisteredAck(false);
            inject.reset();
          }}
          className={`rounded-md border px-2 py-1 text-[11.5px] ${
            selected === null
              ? "border-(--accent) bg-(--surface-3) text-(--text)"
              : "border-(--border) text-(--text-faint) hover:bg-(--surface-2)"
          }`}
        >
          blank
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setClientError(null);
          setUnregisteredAck(false);
        }}
        spellCheck={false}
        rows={14}
        className="mono w-full resize-y rounded-md border border-(--border) bg-(--surface-0) p-3 text-(--text) outline-none focus:border-(--border-strong)"
      />

      {clientError && <VerbError error={new Error(clientError)} />}
      <VerbError error={inject.error} />
      {outcome && (
        <div
          className="mt-2 rounded-md px-2.5 py-1.5 text-[12px]"
          style={{
            color: outcome.duplicate ? "var(--hue-warn)" : "var(--hue-ok)",
            background: `color-mix(in oklch, ${outcome.duplicate ? "var(--hue-warn)" : "var(--hue-ok)"} 10%, transparent)`,
          }}
        >
          {outcome.duplicate
            ? `duplicate — event ${outcome.eventId} was already admitted (dedup working as designed)`
            : `admitted event ${outcome.eventId} — the planner proposes next`}
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={submit} disabled={inject.isPending}>
          Inject
        </Button>
      </div>
    </Dialog>
  );
}
