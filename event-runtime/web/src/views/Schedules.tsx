import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useListKeys, useNow } from "../hooks";
import { setContextActions } from "../palette";
import type { AdmittedEvent, AgentDef } from "../types";
import type { OperatorContext } from "../context";
import { ScopeCaption } from "../components/ContextTabs";
import {
  Ago,
  Button,
  Countdown,
  DetailPane,
  Dialog,
  EVENT_STATUS_HUES,
  FilterInput,
  JumpLink,
  KV,
  ListEmpty,
  ListPane,
  Section,
  VerbError,
  copyLink,
  copyText,
  notify,
} from "../components/ui";

export interface ScheduleItem {
  loop: string;
  every: string;
  cadenceSeconds: number | null;
  eventType: string;
  approval: "watched" | "auto";
  catchUp: "none" | "last" | "all";
  singleton: boolean;
  enabled: boolean;
  lastSlot: string | null;
  lastCompletedSlot: string | null;
  neverCompleted: boolean;
  nextDue: string | null;
  intervalsLate: number | null;
  stopped: boolean;
  error: string | null;
}

export interface TriggerOutcome {
  admitted: boolean;
  duplicate: boolean;
  eventId: string;
  proposalId: string | null;
  runId: string | null;
  decision: string;
  reason: string | null;
  disabled: boolean;
  loop: string;
}

/**
 * Free-text filter tokens for a schedule row (WM-101). The enabled/state
 * tokens must match the words rendered in the Enabled and State cells so
 * filtering by what the operator sees works.
 */
export function scheduleFilterTokens(s: ScheduleItem): string[] {
  return [
    s.loop,
    s.every,
    s.eventType,
    s.approval,
    s.catchUp,
    s.enabled ? "enabled" : "disabled",
    s.error ? "error" : !s.enabled ? "not scheduled" : s.stopped ? "stopped" : "running",
  ];
}

async function fetchSchedules(): Promise<{ schedules: ScheduleItem[] }> {
  const res = await fetch("/api/schedules");
  if (!res.ok) {
    throw new Error(`Failed to fetch schedules: HTTP ${res.status}`);
  }
  return res.json();
}

async function triggerSchedule(loop: string): Promise<TriggerOutcome> {
  const res = await fetch(`/api/schedules/${encodeURIComponent(loop)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = json?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as TriggerOutcome;
}

/**
 * Schedules view (OPS-400, OPS-401) — surfaces recurring loops, last fire,
 * next due countdown, and stopped clocks, with an ad-hoc trigger modal.
 */
export function Schedules({
  context,
  focusScheduleLoop,
  onSelectSchedule,
  onJumpProposal,
  onJumpRun,
  onJumpEvent,
  onJumpAgent,
  rejumpEpoch,
}: {
  connected?: boolean;
  context: OperatorContext;
  focusScheduleLoop: string | null;
  onSelectSchedule: (loop: string | null) => void;
  onJumpProposal: (id: string) => void;
  onJumpRun: (runId: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpAgent: (ref: string) => void;
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();

  const schedulesQ = useQuery({
    queryKey: ["schedules"],
    queryFn: fetchSchedules,
    refetchInterval: 2000,
  });
  const rows = schedulesQ.data?.schedules ?? [];

  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: api.agents,
    refetchInterval: 10_000,
  });
  const agents = agentsQ.data?.agents ?? [];

  const eventsQ = useQuery({
    queryKey: ["events", "all"],
    queryFn: () => api.events(),
    refetchInterval: 2000,
  });
  const allEvents = eventsQ.data?.events ?? [];

  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((s) =>
      scheduleFilterTokens(s).some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, filter]);

  const selectedLoop = focusScheduleLoop;
  const selectedIndex = useMemo(
    () => visible.findIndex((s) => s.loop === selectedLoop),
    [visible, selectedLoop],
  );
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  // Find agent corresponding to the selected schedule's eventType
  const selAgent: AgentDef | undefined = useMemo(() => {
    if (!sel) return undefined;
    return agents.find((a) => a.eventTypes.some((t) => t.type === sel.eventType));
  }, [sel, agents]);

  // Recent ticks for the selected loop
  const recentTicks: AdmittedEvent[] = useMemo(() => {
    if (!sel) return [];
    return allEvents
      .filter((e) => e.type === sel.eventType || (e.envelope?.payload as Record<string, unknown> | undefined)?.loop === sel.loop)
      .slice(0, 10);
  }, [sel, allEvents]);

  const [confirmLoop, setConfirmLoop] = useState<ScheduleItem | null>(null);

  const triggerMut = useMutation({
    mutationFn: (loop: string) => triggerSchedule(loop),
    onSuccess: (outcome, loop) => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      setConfirmLoop(null);
      if (outcome.decision === "noop") {
        notify(`Schedule "${loop}" was not started: ${outcome.reason ?? "previous run in flight"}`, "info");
      } else if (outcome.proposalId) {
        notify(`Triggered "${loop}" · proposal ${outcome.proposalId}`, "ok");
        onJumpProposal(outcome.proposalId);
      } else {
        notify(`Triggered "${loop}" ad-hoc event`, "ok");
      }
    },
  });

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, rejumpEpoch]);

  useEffect(() => {
    if (focusScheduleLoop) setFilter("");
  }, [focusScheduleLoop]);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectSchedule(visible[i]?.loop ?? null),
    onClose: () => {
      if (selectedLoop) onSelectSchedule(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => sel && copyText(sel.loop, "schedule loop"),
      r: () => sel && setConfirmLoop(sel),
    },
  });

  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      setContextActions([
        { label: `Run ${sel.loop} now…`, hint: "r", run: () => setConfirmLoop(sel) },
        { label: `Copy ${sel.loop}`, hint: "c", run: () => copyText(sel.loop, "schedule loop") },
        { label: "Copy link to this schedule", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
  }, [sel]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-lg font-semibold">Schedules</h1>
            <ScopeCaption context={context} surface="registry" />
            <div className="mb-3">
              <FilterInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter loop, cadence, event type, approval…"
                label="Filter schedules"
              />
            </div>
          </>
        }
      >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Loop</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Cadence</th>
              <th
                className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium"
                title="Config flag from event-runtime/schedules.json — edit that file (or use the CLI) to enable/disable; there is no toggle in this UI"
              >
                Enabled
              </th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Approval</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Catch-up</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Last fire</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Next due</th>
              <th
                className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium"
                title="Runtime health of the scheduler loop: running, stopped (no ticks), not scheduled (disabled), or error"
              >
                State
              </th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s, idx) => {
              const isSel = idx === selectedIndex;
              const isAuto = s.approval === "auto";
              return (
                <tr
                  key={s.loop}
                  onClick={() => onSelectSchedule(s.loop)}
                  className={`cursor-pointer border-b border-(--border) text-[13px] hover:bg-(--surface-2) ${
                    isSel ? "row-selected bg-(--surface-3)" : ""
                  }`}
                >
                  <td className="mono border-b border-(--border) px-3 py-2 font-medium text-(--text)">
                    {s.loop}
                  </td>
                  <td className="mono border-b border-(--border) px-3 py-2 text-(--text-dim)">
                    {s.every}
                  </td>
                  <td className="border-b border-(--border) px-3 py-2">
                    {s.enabled ? (
                      <span
                        className="mono text-[11px] text-(--hue-ok)"
                        title="enabled: true in event-runtime/schedules.json — the scheduler will fire this loop on cadence"
                      >
                        enabled
                      </span>
                    ) : (
                      <span
                        className="mono text-[11px] text-(--text-faint)"
                        title="enabled: false in event-runtime/schedules.json — edit that file (or use the CLI) to re-enable"
                      >
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="border-b border-(--border) px-3 py-2">
                    {isAuto ? (
                      <span
                        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
                        title="approval: auto — executes unattended without operator prompt"
                        style={{
                          color: "var(--hue-warn)",
                          borderColor: "color-mix(in oklch, var(--hue-warn) 40%, var(--border))",
                          background: "color-mix(in oklch, var(--hue-warn) 12%, transparent)",
                        }}
                      >
                        auto
                      </span>
                    ) : (
                      <span className="text-[11px] text-(--text-dim)">watched</span>
                    )}
                  </td>
                  <td className="mono border-b border-(--border) px-3 py-2 text-[11px] text-(--text-dim)">
                    {s.catchUp}
                  </td>
                  <td className="border-b border-(--border) px-3 py-2 text-[11px] text-(--text-dim)">
                    {s.lastSlot ? <Ago iso={s.lastSlot} now={now} /> : <span className="text-(--text-faint)">never</span>}
                  </td>
                  <td className="border-b border-(--border) px-3 py-2 text-[11px] text-(--text-dim)">
                    {!s.enabled ? (
                      <span className="text-(--text-faint)">-</span>
                    ) : s.error ? (
                      <span className="text-(--hue-err)">-</span>
                    ) : s.nextDue && s.cadenceSeconds ? (
                      <Countdown
                        createdAt={
                          s.lastSlot ?? new Date(Date.parse(s.nextDue) - s.cadenceSeconds * 1000).toISOString()
                        }
                        ttlSeconds={s.cadenceSeconds}
                      />
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="border-b border-(--border) px-3 py-2">
                    {s.error ? (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--hue-err)"
                        style={{ background: "color-mix(in oklch, var(--hue-err) 14%, transparent)" }}
                        title={s.error}
                      >
                        error
                      </span>
                    ) : !s.enabled ? (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--text-faint)"
                        style={{ background: "var(--surface-2)" }}
                        title="Not scheduled: enabled: false in event-runtime/schedules.json, so the scheduler loop is not running for this schedule"
                      >
                        not scheduled
                      </span>
                    ) : s.stopped ? (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--hue-err)"
                        style={{ background: "color-mix(in oklch, var(--hue-err) 14%, transparent)" }}
                        title={`Stopped: enabled: true but the scheduler loop is not ticking — no ticks for ${s.intervalsLate} intervals. Check the event runtime serve process.`}
                      >
                        stopped ({s.intervalsLate} late)
                      </span>
                    ) : (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-(--hue-ok)"
                        style={{ background: "color-mix(in oklch, var(--hue-ok) 14%, transparent)" }}
                        title="Running: enabled: true and the scheduler loop is ticking on cadence"
                      >
                        running
                      </span>
                    )}
                  </td>
                  <td className="border-b border-(--border) px-3 py-2 text-right">
                    <Button
                      onClick={() => setConfirmLoop(s)}
                    >
                      Run now…
                    </Button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={9}
                query={schedulesQ}
                filtered={rows.length > 0}
                noun="schedules"
                empty="No schedules registered (event-runtime/schedules.json)"
              />
            )}
          </tbody>
        </table>
        <div className="px-3 py-2 text-[11px] text-(--text-faint)">
          Enable or disable schedules in{" "}
          <code className="mono">event-runtime/schedules.json</code> (or via the CLI) — there is no
          toggle here.
        </div>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[520px]"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="mono truncate" title={sel.loop}>
                {sel.loop}
              </span>
              {sel.approval === "auto" && (
                <span
                  className="rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
                  style={{
                    color: "var(--hue-warn)",
                    borderColor: "color-mix(in oklch, var(--hue-warn) 40%, var(--border))",
                    background: "color-mix(in oklch, var(--hue-warn) 12%, transparent)",
                  }}
                >
                  auto
                </span>
              )}
            </span>
          }
          actions={
            <>
              <Button variant="primary" onClick={() => setConfirmLoop(sel)}>
                Run now…
              </Button>
              <Button onClick={() => copyText(sel.loop, "schedule loop")}>Copy loop</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectSchedule(null)}>Close</Button>
            </>
          }
        >
          <div className="space-y-6">
            {sel.stopped && (
              <div
                className="rounded-md border border-[color:var(--hue-err)] bg-[color:color-mix(in_oklch,var(--hue-err)_8%,var(--surface-1))] p-3 text-[12px]"
                style={{ color: "var(--hue-err)" }}
              >
                <div className="font-semibold">Schedule clock stopped</div>
                <div className="mt-1 text-(--text-dim)">
                  This loop is enabled but has been silent for {sel.intervalsLate} intervals (cadence: {sel.every}).
                  Check that the event runtime serve process is running.
                </div>
              </div>
            )}

            {sel.error && (
              <div
                className="rounded-md border border-[color:var(--hue-err)] bg-[color:color-mix(in_oklch,var(--hue-err)_8%,var(--surface-1))] p-3 text-[12px]"
                style={{ color: "var(--hue-err)" }}
              >
                <div className="font-semibold">Cadence configuration error</div>
                <div className="mono mt-1 text-(--text-dim)">{sel.error}</div>
              </div>
            )}

            <Section title="Configuration">
              <KV k="loop name" v={<span className="mono">{sel.loop}</span>} />
              <KV
                k="cadence"
                v={
                  <span>
                    <span className="mono">{sel.every}</span>
                    {sel.cadenceSeconds && (
                      <span className="ml-2 text-(--text-faint)">({sel.cadenceSeconds}s)</span>
                    )}
                  </span>
                }
              />
              <KV
                k="event type"
                v={
                  <JumpLink
                    onClick={() => {
                      window.location.hash = `#/events?type=${encodeURIComponent(sel.eventType)}`;
                    }}
                  >
                    {sel.eventType}
                  </JumpLink>
                }
              />
              {selAgent && (
                <KV
                  k="agent"
                  v={
                    <JumpLink onClick={() => onJumpAgent(selAgent.ref)}>
                      {selAgent.ref}
                    </JumpLink>
                  }
                />
              )}
              <KV
                k="approval"
                v={
                  sel.approval === "auto" ? (
                    <span className="font-medium text-(--hue-warn)">
                      auto (unattended execution)
                    </span>
                  ) : (
                    <span className="text-(--text-dim)">watched (requires human approval)</span>
                  )
                }
              />
              <KV k="catch-up" v={<span className="mono">{sel.catchUp}</span>} />
              <KV
                k="singleton"
                v={sel.singleton ? "true (previous run must finish before next starts)" : "false"}
              />
              <KV
                k="enabled"
                v={
                  sel.enabled ? (
                    <span className="text-(--hue-ok)">true</span>
                  ) : (
                    <span className="text-(--text-faint)">
                      false (disabled — re-enable in event-runtime/schedules.json or via the CLI)
                    </span>
                  )
                }
              />
            </Section>

            <Section title="Timing & Clocks">
              <KV
                k="last fire"
                v={
                  sel.lastSlot ? (
                    <span>
                      <Ago iso={sel.lastSlot} now={now} />{" "}
                      <span className="mono text-[11px] text-(--text-faint)">({sel.lastSlot})</span>
                    </span>
                  ) : (
                    <span className="text-(--text-faint)">never fired</span>
                  )
                }
              />
              <KV
                k="last completed"
                v={
                  sel.lastCompletedSlot ? (
                    <span>
                      <Ago iso={sel.lastCompletedSlot} now={now} />{" "}
                      <span className="mono text-[11px] text-(--text-faint)">
                        ({sel.lastCompletedSlot})
                      </span>
                    </span>
                  ) : (
                    <span className="text-(--text-faint)">never completed</span>
                  )
                }
              />
              <KV
                k="next due"
                v={
                  !sel.enabled ? (
                    <span className="text-(--text-faint)">disabled</span>
                  ) : sel.nextDue && sel.cadenceSeconds ? (
                    <span>
                      <Countdown
                        createdAt={
                          sel.lastSlot ??
                          new Date(Date.parse(sel.nextDue) - sel.cadenceSeconds * 1000).toISOString()
                        }
                        ttlSeconds={sel.cadenceSeconds}
                      />{" "}
                      <span className="mono text-[11px] text-(--text-faint)">({sel.nextDue})</span>
                    </span>
                  ) : (
                    "-"
                  )
                }
              />
            </Section>

            <Section title="Recent Ticks">
              {recentTicks.length === 0 ? (
                <div className="text-[12px] text-(--text-faint)">
                  No tick events recorded yet for this loop.
                </div>
              ) : (
                <div className="space-y-2">
                  {recentTicks.map((e) => {
                    const payload = (e.envelope?.payload as Record<string, unknown> | undefined) ?? {};
                    const isAdhoc = e.source === "operator" || payload.adhoc === true;
                    return (
                      <div
                        key={`${e.source}:${e.eventId}`}
                        className="flex items-center justify-between gap-3 rounded border border-(--border) bg-(--surface-2) px-3 py-2 text-[12px]"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <JumpLink onClick={() => onJumpEvent(e.source, e.eventId)}>
                              {e.eventId}
                            </JumpLink>
                            {isAdhoc && (
                              <span className="rounded bg-(--surface-3) px-1 text-[10px] text-(--hue-info)">
                                ad-hoc
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-(--text-dim)">
                            <Ago iso={e.occurredAt} now={now} />
                            <span>·</span>
                            <span>source: {e.source}</span>
                            {typeof payload.skippedSlots === "number" && payload.skippedSlots > 0 && (
                              <>
                                <span>·</span>
                                <span className="text-(--hue-warn)">
                                  skipped: {payload.skippedSlots}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-right">
                          <span
                            className="mono text-[11px]"
                            style={{ color: EVENT_STATUS_HUES[e.status] ?? "inherit" }}
                          >
                            {e.status}
                          </span>
                          {e.proposalId && (
                            <JumpLink onClick={() => onJumpProposal(e.proposalId!)}>
                              proposal
                            </JumpLink>
                          )}
                          {e.runId && (
                            <JumpLink onClick={() => onJumpRun(e.runId!)}>
                              run
                            </JumpLink>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          </div>
        </DetailPane>
      )}

      {confirmLoop && (
        <Dialog
          title={`Run schedule "${confirmLoop.loop}" now?`}
          onClose={() => {
            if (!triggerMut.isPending) setConfirmLoop(null);
          }}
        >
          <div className="space-y-4 text-[13px]">
            <p className="text-(--text-dim)">
              Triggering an ad-hoc run admits a new event immediately with source{" "}
              <code className="mono rounded bg-(--surface-2) px-1 py-0.5 text-(--text)">
                operator
              </code>
              . It creates an open proposal for review and does not alter the schedule&apos;s normal slot timer.
            </p>

            {confirmLoop && (
              <div className="rounded-md border border-(--border) bg-(--surface-2) p-3 space-y-2">
                <KV k="loop" v={<span className="mono font-semibold">{confirmLoop.loop}</span>} />
                <KV k="event type" v={<span className="mono">{confirmLoop.eventType}</span>} />
                {(() => {
                  const agent = agents.find((a) =>
                    a.eventTypes.some((t) => t.type === confirmLoop.eventType),
                  );
                  if (!agent) return null;
                  return (
                    <>
                      <KV
                        k="agent"
                        v={
                          <span>
                            <span className="mono">{agent.ref}</span>
                            {agent.mutating ? (
                              <span className="ml-2 font-medium text-(--hue-warn)">
                                (mutating)
                              </span>
                            ) : (
                              <span className="ml-2 text-(--text-faint)">(read-only)</span>
                            )}
                          </span>
                        }
                      />
                      {agent.command && (
                        <div className="mt-2">
                          <div className="text-[11px] font-medium text-(--text-faint) mb-1">
                            Command argv:
                          </div>
                          <pre className="mono max-h-24 overflow-auto rounded bg-(--surface-1) p-2 text-[11px] text-(--text)">
                            {agent.command.join(" ")}
                          </pre>
                        </div>
                      )}
                    </>
                  );
                })()}
                {!confirmLoop.enabled && (
                  <div className="mt-2 rounded bg-(--surface-3) p-2 text-[12px] text-(--hue-warn)">
                    Note: This schedule is disabled (<code className="mono">enabled: false</code> in{" "}
                    <code className="mono">event-runtime/schedules.json</code>), so it is not
                    scheduled to run on its own. Triggering ad-hoc will evaluate the loop once.
                  </div>
                )}
              </div>
            )}

            <VerbError error={triggerMut.error} />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                disabled={triggerMut.isPending}
                onClick={() => setConfirmLoop(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={triggerMut.isPending}
                onClick={() => triggerMut.mutate(confirmLoop.loop)}
              >
                {triggerMut.isPending ? "Triggering…" : "Trigger Run"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
