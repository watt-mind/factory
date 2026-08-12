import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { retriggerEnvelope } from "../templates";
import { useListKeys, useNow } from "../hooks";
import { setContextActions } from "../palette";
import type { AdmittedEvent } from "../types";
import { ago, Button, EVENT_STATUS_HUES, JsonBlock, KV, notify, Section, VerbError } from "../components/ui";

const STATUS_TABS = ["all", "admitted", "planned", "noop", "human_needed", "dead_lettered"] as const;

/** Only these two statuses may be requeued (planner.mjs requeueEvent). */
const REQUEUEABLE = new Set(["dead_lettered", "human_needed"]);

const keyOf = (e: AdmittedEvent) => `${e.source}:${e.eventId}`;

/**
 * Events (webui doc §10.1) — the event inbox. Every admitted envelope with
 * its planning outcome; dead letters carry the error tone, and requeue
 * (`q`) re-plans a dead_lettered/human_needed event through the same path
 * as a fresh admission.
 */
export function Events({
  connected,
  focusStatus,
  onFocusConsumed,
  onTriggerAgain,
}: {
  connected: boolean;
  focusStatus: string | null;
  onFocusConsumed: () => void;
  onTriggerAgain: (envelope: Record<string, unknown>) => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]>(
    focusStatus && (STATUS_TABS as readonly string[]).includes(focusStatus)
      ? (focusStatus as (typeof STATUS_TABS)[number])
      : "all",
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Deep link from the Overview doctor panel: the tab was seeded above; release.
  useEffect(() => {
    if (focusStatus) onFocusConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = useQuery({
    queryKey: ["events", tab],
    queryFn: () => api.events(tab === "all" ? undefined : tab),
    refetchInterval: 2000,
  });
  const rows = list.data?.events ?? [];

  const selectedIndex = useMemo(() => rows.findIndex((e) => keyOf(e) === selectedKey), [rows, selectedKey]);
  const sel = selectedIndex >= 0 ? rows[selectedIndex] : null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["events"] });
    queryClient.invalidateQueries({ queryKey: ["status"] });
    queryClient.invalidateQueries({ queryKey: ["proposals"] });
  };

  const requeue = useMutation({
    mutationFn: (e: AdmittedEvent) => api.requeue(e.source, e.eventId),
    onSuccess: (_, e) => {
      invalidate();
      notify(`Requeued event ${e.eventId}`, "ok");
    },
    onError: invalidate, // 404/409 mean someone else acted — converge on truth
  });

  const replay = useMutation({
    mutationFn: (envelope: unknown) => api.replay(envelope),
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      notify(data.duplicate ? `Duplicate event ${data.eventId}` : `Replayed event ${data.eventId}`, "info");
    },
  });

  const canRequeue = sel !== null && REQUEUEABLE.has(sel.status);

  useListKeys({
    count: rows.length,
    selected: selectedIndex,
    onSelect: (i) => setSelectedKey(rows[i] ? keyOf(rows[i]) : null),
    onClose: () => setSelectedKey(null),
    keys: {
      // `q` not `r`: `r` is the `g r` navigation suffix, and both listeners
      // see the same keydown — `g r` with a selection must never requeue.
      q: () => canRequeue && connected && sel && requeue.mutate(sel),
    },
  });

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel || !connected) {
      setContextActions([]);
    } else {
      setContextActions([
        ...(canRequeue
          ? [{ label: `Requeue ${sel.eventId}`, hint: "q", run: () => requeue.mutate(sel) }]
          : []),
        { label: `Replay ${sel.eventId} through intake`, run: () => replay.mutate(sel.envelope) },
        {
          label: `Trigger ${sel.type} again (new event id)…`,
          run: () => onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now())),
        },
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel ? keyOf(sel) : null, canRequeue, connected]);

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1 overflow-auto p-5">
        <h1 className="display mb-4 text-lg font-semibold">Events</h1>

        <div className="mb-3 flex gap-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
              }`}
            >
              {t === "all" ? "All" : t}
            </button>
          ))}
        </div>

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Event</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Type</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Subject</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Status</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Admitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr
                key={keyOf(e)}
                onClick={() => setSelectedKey(keyOf(e))}
                className={`cursor-pointer hover:bg-(--surface-1) ${i === selectedIndex ? "row-selected" : ""}`}
                style={
                  e.status === "dead_lettered"
                    ? { background: "color-mix(in oklch, var(--hue-err) 6%, transparent)" }
                    : undefined
                }
              >
                <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5">{e.eventId}</td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{e.type}</td>
                <td className="max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {e.subject ?? "-"}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <span style={{ color: EVENT_STATUS_HUES[e.status] ?? "var(--text-dim)" }}>{e.status}</span>
                  {e.planFailures > 0 && (
                    <span className="ml-2 text-[11px]" style={{ color: "var(--hue-err)" }}>
                      {e.planFailures} plan failure{e.planFailures === 1 ? "" : "s"}
                    </span>
                  )}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{ago(e.admittedAt, now)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-(--text-faint)">
                  {tab === "all"
                    ? "No events yet — inject one with ⌘K → Inject event."
                    : `No ${tab} events.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="w-[440px] shrink-0 overflow-auto border-l border-(--border) bg-(--surface-1) p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="display truncate text-[14px] font-semibold" title={sel.eventId}>
              {sel.eventId}
            </div>
            <Button onClick={() => setSelectedKey(null)}>Close</Button>
          </div>

          <Section title="Event">
            <KV k="source" v={sel.source} />
            <KV k="type" v={sel.type} />
            <KV k="subject" v={sel.subject} />
            <KV
              k="status"
              v={<span style={{ color: EVENT_STATUS_HUES[sel.status] ?? "var(--text-dim)" }}>{sel.status}</span>}
            />
            <KV k="correlationId" v={sel.correlationId} />
            <KV k="occurredAt" v={sel.occurredAt} />
            <KV k="receivedAt" v={sel.receivedAt} />
            <KV k="admittedAt" v={sel.admittedAt} />
          </Section>

          {(sel.planFailures > 0 || sel.lastPlanError) && (
            <Section title="Planning">
              <KV k="planFailures" v={String(sel.planFailures)} />
              {sel.lastPlanError && (
                <div
                  className="mt-1.5 rounded-md px-2.5 py-1.5 text-[12px]"
                  style={{
                    color: "var(--hue-err)",
                    background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
                  }}
                >
                  {sel.lastPlanError}
                </div>
              )}
            </Section>
          )}

          <Section title="Envelope">
            <JsonBlock value={sel.envelope} />
          </Section>

          <div className="flex gap-2">
            {canRequeue && (
              <Button
                variant="primary"
                disabled={!connected || requeue.isPending}
                onClick={() => requeue.mutate(sel)}
              >
                Requeue <span className="mono ml-1 opacity-70">q</span>
              </Button>
            )}
            <Button
              disabled={!connected || replay.isPending}
              onClick={() => replay.mutate(sel.envelope)}
            >
              Replay through intake
            </Button>
            {/* Distinct from replay: a fresh delivery identity, so it admits
                a NEW event instead of deduping to a no-op (OPS-214). */}
            <Button
              disabled={!connected}
              onClick={() => onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now()))}
            >
              Trigger again…
            </Button>
          </div>
          <VerbError error={requeue.error ?? replay.error} />
        </div>
      )}
    </div>
  );
}
