import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { keyGuard, useListKeys, useNow, useTabKeys } from "../hooks";
import { goPrefixActive } from "../goSequence";
import type { InboxItem } from "../types";
import {
  Ago,
  Button,
  CopyActions,
  DetailPane,
  Dialog,
  JumpLink,
  KV,
  ListPane,
  Section,
  StateBadge,
  Th,
  VerbError,
  notify,
  shortId,
} from "../components/ui";

/**
 * The human inbox (WM-286): everything the runtime is waiting on the operator
 * for, grouped by what kind of attention it needs. Empty is the goal state
 * here, so the empty state is a sentence, not a table.
 */

export const INBOX_TABS = ["open", "acked", "resolved", "all"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export type InboxGroupId = "decide" | "red" | "ready" | "other";

export interface InboxGroup {
  id: InboxGroupId;
  label: string;
  hue: string;
  kinds: readonly string[];
}

/**
 * Decide = a human choice is the only thing that moves it. Red = something is
 * broken and will stay broken until looked at. Ready = good news that wants a
 * `master` decision. Order is triage order.
 */
export const INBOX_GROUPS: readonly InboxGroup[] = [
  {
    id: "decide",
    label: "Decide",
    hue: "var(--hue-warn)",
    kinds: ["decision_needed", "proposal_expired", "BLOCKED", "ESCALATED", "human_needed"],
  },
  { id: "red", label: "Red", hue: "var(--hue-err)", kinds: ["CI RED", "SMOKE RED", "CIRCUIT BREAKER"] },
  { id: "ready", label: "Ready", hue: "var(--hue-ok)", kinds: ["RC READY"] },
];

const OTHER_GROUP: InboxGroup = { id: "other", label: "Other", hue: "var(--hue-idle)", kinds: [] };

export function groupOf(kind: string): InboxGroup {
  return INBOX_GROUPS.find((g) => g.kinds.includes(kind)) ?? OTHER_GROUP;
}

/** One hue per kind so the badge reads the same in the list, the pane, and Overview. */
export const INBOX_KIND_HUES: Record<string, string> = Object.fromEntries(
  INBOX_GROUPS.flatMap((g) => g.kinds.map((k) => [k, g.hue])),
);

export type InboxItemStatus = Exclude<InboxTab, "all">;

export function itemStatus(item: InboxItem): InboxItemStatus {
  if (item.resolvedAt) return "resolved";
  if (item.ackedAt) return "acked";
  return "open";
}

export function matchesTab(item: InboxItem, tab: InboxTab): boolean {
  return tab === "all" || itemStatus(item) === tab;
}

export type DeliveryState = "sent" | "failed" | "none";

/** Not attempted is a distinct fact from failed: the row must not look red for a push that was never tried. */
export function deliveryState(item: InboxItem): DeliveryState {
  const t = item.delivery?.telegram;
  if (!t) return "none";
  return t.error || (t.exit_code !== null && t.exit_code !== 0) ? "failed" : "sent";
}

export function deliveryText(item: InboxItem): string {
  const t = item.delivery?.telegram;
  if (!t) return "Telegram: not attempted";
  const when = new Date(t.sent_at).toLocaleTimeString([], { hour12: false });
  if (t.error) return `Telegram: failed ${when} · ${t.error}`;
  if (t.exit_code !== null && t.exit_code !== 0) return `Telegram: failed ${when} · exit ${t.exit_code}`;
  return `Telegram: sent ${when} · exit ${t.exit_code ?? 0}`;
}

const DELIVERY_HUES: Record<DeliveryState, string> = {
  sent: "var(--hue-ok)",
  failed: "var(--hue-err)",
  none: "var(--hue-idle)",
};

/** Group in triage order, oldest first inside a group; empty groups are dropped. */
export function groupItems(items: InboxItem[]): { group: InboxGroup; items: InboxItem[] }[] {
  const byGroup = new Map<InboxGroupId, InboxItem[]>();
  for (const item of items) {
    const g = groupOf(item.kind);
    const list = byGroup.get(g.id) ?? [];
    list.push(item);
    byGroup.set(g.id, list);
  }
  const ordered = [...INBOX_GROUPS, OTHER_GROUP];
  return ordered
    .filter((g) => byGroup.has(g.id))
    .map((g) => ({
      group: g,
      items: [...byGroup.get(g.id)!].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
}

/** `agent:<runId>` sources point at the run that raised the item. */
export function sourceRunId(source: string): string | null {
  const m = /^agent:(.+)$/.exec(source);
  return m ? m[1] : null;
}

const LINEAR_ISSUE_URL = "https://linear.app/watt-mind/issue/";

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));

export function Inbox({
  connected,
  focusItemId,
  onSelectItem,
  onJumpRun,
  onJumpProposal,
  onJumpEvent,
}: {
  connected: boolean;
  focusItemId: string | null;
  onSelectItem: (id: string | null) => void;
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  // One fetch of the whole ledger: it is small, every tab is a client-side
  // filter, and a deep link to a resolved item still resolves from the Open tab.
  const query = useQuery({ queryKey: ["inbox", "all"], queryFn: () => api.inbox("all"), refetchInterval: 2000 });
  const items = query.data?.items ?? [];

  const [tab, setTab] = useState<InboxTab>("open");
  const counts = useMemo(() => {
    const c: Record<InboxTab, number> = { open: 0, acked: 0, resolved: 0, all: items.length };
    for (const it of items) c[itemStatus(it)] += 1;
    return c;
  }, [items]);

  const visibleGroups = useMemo(() => groupItems(items.filter((it) => matchesTab(it, tab))), [items, tab]);
  const visible = useMemo(() => visibleGroups.flatMap((g) => g.items), [visibleGroups]);

  const sel = focusItemId ? (items.find((it) => it.id === focusItemId) ?? null) : null;
  const selectedIndex = sel ? visible.findIndex((it) => it.id === sel.id) : -1;
  // A deep link is only "unknown" once the ledger has actually answered.
  const unknownFocus = !!focusItemId && !sel && query.isSuccess;

  // The tab follows the selected item: a Telegram deep link to an already-acked
  // item lands on Acked, and acking the selected row moves you to Acked with
  // the row still selected — the list keys (`x` to resolve) keep working
  // because the row stays visible.
  const selStatus = sel ? itemStatus(sel) : null;
  useEffect(() => {
    if (sel && !matchesTab(sel, tab)) setTab(itemStatus(sel));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the selection or its status changes
  }, [sel?.id, selStatus]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["inbox"] });
    queryClient.invalidateQueries({ queryKey: ["status"] });
  };
  const ack = useMutation({
    mutationFn: (id: string) => api.ackInbox(id),
    onSuccess: (_out, id) => {
      invalidate();
      notify(`Acked ${shortId(id)}`, "ok");
    },
    onError: (err) => notify(`Ack failed: ${(err as Error).message}`, "err"),
  });
  const [confirmResolve, setConfirmResolve] = useState(false);
  const resolve = useMutation({
    mutationFn: (id: string) => api.resolveInbox(id),
    onSuccess: (_out, id) => {
      invalidate();
      setConfirmResolve(false);
      notify(`Resolved ${shortId(id)}`, "ok");
    },
    onError: (err) => notify(`Resolve failed: ${(err as Error).message}`, "err"),
  });

  const canAck = !!sel && connected && itemStatus(sel) === "open" && !ack.isPending;
  const canResolve = !!sel && connected && itemStatus(sel) !== "resolved" && !resolve.isPending;

  // Enter confirms the resolve dialog (same idiom as the Proposals confirms):
  // the Dialog primitive parks focus on its root, so a focused button is not
  // something we can rely on.
  useEffect(() => {
    if (!confirmResolve) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !sel || !canResolve) return;
      e.preventDefault();
      resolve.mutate(sel.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmResolve, sel, canResolve, resolve]);

  const selectTab = (t: InboxTab) => {
    setTab(t);
    onSelectItem(null);
  };
  useTabKeys(INBOX_TABS, tab, selectTab);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive() || isTypingTarget(e.target)) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= INBOX_TABS.length) {
        e.preventDefault();
        selectTab(INBOX_TABS[num - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectTab is stable enough for a listener
  }, []);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectItem(visible[i]?.id ?? null),
    onClose: () => {
      if (confirmResolve) setConfirmResolve(false);
      else if (sel) onSelectItem(null);
    },
    keys: {
      a: () => {
        if (canAck && sel) ack.mutate(sel.id);
      },
      x: () => {
        if (canResolve) setConfirmResolve(true);
      },
    },
  });

  const tdCls = "border-b border-(--border) px-3 py-1.5 whitespace-nowrap";
  const openEmpty = tab === "open" && visible.length === 0 && query.isSuccess;

  return (
    <div className="flex h-full min-w-0">
      <div className={`${sel ? "hidden sm:flex" : "flex"} min-h-0 min-w-0 flex-1`}>
        <ListPane
          chrome={
            <>
              <h1 className="display mb-4 text-lg font-semibold">Inbox</h1>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="flex gap-1" role="tablist" aria-label="Inbox status">
                  {INBOX_TABS.map((t, idx) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      onClick={() => selectTab(t)}
                      title={t}
                      className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                        tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                      }`}
                    >
                      {t[0].toUpperCase() + t.slice(1)}
                      {counts[t] > 0 && (
                        <span className="ml-1.5 tabular-nums text-(--text-faint)">{counts[t]}</span>
                      )}
                      <span aria-hidden="true" className="mono ml-1 text-[10px] text-(--text-faint) opacity-70">
                        {idx + 1}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          }
        >
          {unknownFocus && (
            <div
              role="status"
              className="mb-3 rounded-md px-3 py-2 text-[12px]"
              style={{
                color: "var(--hue-warn)",
                background: "color-mix(in oklch, var(--hue-warn) 10%, transparent)",
              }}
            >
              No inbox item <span className="mono">{focusItemId}</span> — it may predate the ledger or the link is stale.
            </div>
          )}
          {openEmpty ? (
            <div className="px-3 py-10 text-center text-(--text-dim)">
              <span
                aria-hidden="true"
                className="mr-2 inline-block size-2 rounded-full align-middle"
                style={{ background: "var(--hue-ok)" }}
              />
              Nothing waiting on you.
            </div>
          ) : (
            <table className="w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-[11px] text-(--text-faint)">
                  <Th label="Kind" />
                  <Th label="Title" />
                  <Th label="Age" />
                  <Th label="Refs" />
                  <Th label="Sent" title="Telegram delivery: sent, failed, or not attempted" />
                </tr>
              </thead>
              <tbody>
                {query.isPending && !query.data && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-(--text-faint)">Loading inbox…</td>
                  </tr>
                )}
                {query.isError && !query.data && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-(--text-faint)">
                      Cannot reach the control API — the inbox will appear when it is up.
                    </td>
                  </tr>
                )}
                {query.isSuccess && visible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-(--text-faint)">
                      {tab === "acked" ? "No acked items." : tab === "resolved" ? "No resolved items yet." : "The ledger is empty."}
                    </td>
                  </tr>
                )}
                {visibleGroups.map(({ group, items: rows }) => (
                  <GroupRows
                    key={group.id}
                    group={group}
                    rows={rows}
                    now={now}
                    selectedId={sel?.id ?? null}
                    onSelect={onSelectItem}
                    onJumpRun={onJumpRun}
                    onJumpProposal={onJumpProposal}
                    onJumpEvent={onJumpEvent}
                    tdCls={tdCls}
                  />
                ))}
              </tbody>
            </table>
          )}
        </ListPane>
      </div>

      {sel && (
        <DetailPane
          widthClass="w-full sm:w-[460px]"
          title={
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal">
              <button
                type="button"
                onClick={() => onSelectItem(null)}
                className="cursor-pointer text-(--text-dim) hover:text-(--accent)"
                title="Back to inbox list"
              >
                Inbox
              </button>
              <span className="text-(--text-faint)" aria-hidden="true">/</span>
              <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-(--text)" aria-current="page">
                <StateBadge state={sel.kind} hues={INBOX_KIND_HUES} dot={false} />
                <span className="mono truncate" title={sel.id}>{shortId(sel.id)}</span>
              </span>
            </nav>
          }
          actions={
            itemStatus(sel) !== "resolved" ? (
              <div className="flex items-center gap-1.5">
                <Button disabled={!canResolve} onClick={() => setConfirmResolve(true)}>
                  Resolve… <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">x</span>
                </Button>
                {itemStatus(sel) === "open" && (
                  <Button variant="primary" disabled={!canAck} onClick={() => ack.mutate(sel.id)}>
                    Ack <span className="mono ml-1 opacity-80" aria-hidden="true">a</span>
                  </Button>
                )}
              </div>
            ) : null
          }
          utility={<CopyActions id={sel.id} idLabel="inbox item id" />}
          close={<Button onClick={() => onSelectItem(null)}>Close</Button>}
        >
          <Section title="Item" icons>
            <KV k="kind" v={<StateBadge state={sel.kind} hues={INBOX_KIND_HUES} dot={false} />} />
            <KV k="status" v={itemStatus(sel)} />
            {sel.severity !== "normal" && <KV k="severity" v={sel.severity} />}
            <KV k="created" v={<Ago iso={sel.createdAt} now={now} />} />
            {sel.ackedAt && <KV k="acked" v={<Ago iso={sel.ackedAt} now={now} />} />}
            {sel.resolvedAt && <KV k="resolved" v={<Ago iso={sel.resolvedAt} now={now} />} />}
            {sel.resolvedBy && <KV k="resolved by" v={sel.resolvedBy} />}
            <KV
              k="source"
              v={
                sourceRunId(sel.source) ? (
                  <JumpLink onClick={() => onJumpRun(sourceRunId(sel.source)!)} title={`Open run ${sourceRunId(sel.source)}`}>
                    {sel.source}
                  </JumpLink>
                ) : (
                  sel.source
                )
              }
            />
          </Section>

          <Section title="Message" card={false}>
            <div className="rounded-md border border-(--border) bg-(--surface-0) px-3 py-2 text-[12px] leading-relaxed">
              <div className="font-medium text-(--text)">{sel.title}</div>
              {sel.body && (
                <div className="mt-1.5 whitespace-pre-wrap break-words text-(--text-dim)">{sel.body}</div>
              )}
            </div>
          </Section>

          {Object.keys(sel.refs).length > 0 && (
            <Section title="References" icons>
              {sel.refs.runId && (
                <KV k="run" v={<JumpLink onClick={() => onJumpRun(sel.refs.runId!)} title={`Open run ${sel.refs.runId}`}>{shortId(sel.refs.runId)}</JumpLink>} />
              )}
              {sel.refs.proposalId && (
                <KV k="proposal" v={<JumpLink onClick={() => onJumpProposal(sel.refs.proposalId!)} title={`Open proposal ${sel.refs.proposalId}`}>{shortId(sel.refs.proposalId)}</JumpLink>} />
              )}
              {sel.refs.eventId && (
                <KV
                  k="event"
                  v={
                    sel.refs.eventSource ? (
                      <JumpLink onClick={() => onJumpEvent(sel.refs.eventSource!, sel.refs.eventId!)} title={`Open event ${sel.refs.eventId}`}>
                        {shortId(sel.refs.eventId)}
                      </JumpLink>
                    ) : (
                      shortId(sel.refs.eventId)
                    )
                  }
                />
              )}
              {sel.refs.issue && (
                <KV k="issue" v={<JumpLink href={`${LINEAR_ISSUE_URL}${encodeURIComponent(sel.refs.issue)}`} title="Open in Linear">{sel.refs.issue}</JumpLink>} />
              )}
              {sel.refs.pr && (
                <KV k="pr" v={<JumpLink href={sel.refs.pr} title="Open pull request">{sel.refs.pr.replace(/^https?:\/\/(www\.)?github\.com\//, "")}</JumpLink>} />
              )}
              {sel.refs.repo && <KV k="repo" v={sel.refs.repo} />}
            </Section>
          )}

          <Section title="Delivery" icons>
            <KV
              k="telegram"
              v={
                <span style={{ color: DELIVERY_HUES[deliveryState(sel)] }} title={deliveryText(sel)}>
                  {deliveryText(sel).replace(/^Telegram: /, "")}
                </span>
              }
            />
          </Section>

          {(ack.isError || resolve.isError) && <VerbError error={ack.error ?? resolve.error} />}
        </DetailPane>
      )}

      {confirmResolve && sel && (
        <Dialog title="Resolve inbox item?" onClose={() => setConfirmResolve(false)}>
          <p className="mb-3 text-[12px] text-(--text-dim)">
            Marks <span className="mono">{shortId(sel.id)}</span> as dealt with. It leaves Open and Acked and stays in the
            ledger under Resolved. This does not act on the underlying run, proposal or PR.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmResolve(false)}>Cancel</Button>
            <Button variant="primary" disabled={!canResolve} onClick={() => resolve.mutate(sel.id)} autoFocus>
              Resolve
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function GroupRows({
  group,
  rows,
  now,
  selectedId,
  onSelect,
  onJumpRun,
  onJumpProposal,
  onJumpEvent,
  tdCls,
}: {
  group: InboxGroup;
  rows: InboxItem[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  tdCls: string;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={5}
          className="sticky top-7 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1 text-[11px] font-medium"
          style={{ color: group.hue }}
        >
          <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full align-middle" style={{ background: group.hue }} />
          {group.label}
          <span className="ml-1.5 tabular-nums text-(--text-faint)">{rows.length}</span>
        </td>
      </tr>
      {rows.map((item) => {
        const d = deliveryState(item);
        return (
          <tr
            key={item.id}
            onClick={() => onSelect(item.id)}
            aria-selected={item.id === selectedId}
            className={`cursor-pointer hover:bg-(--surface-1) ${item.id === selectedId ? "row-selected" : ""}`}
          >
            <td className={`${tdCls} w-32`}>
              <StateBadge state={item.kind} hues={INBOX_KIND_HUES} dot={false} />
            </td>
            {/* Title is the decision text: it truncates last. `max-w-0` lets it
                shrink-to-fit, `min-w-40` stops it collapsing to a glyph when
                the pane opens at ~1100px — Refs gives up width first. */}
            <td className={`${tdCls} min-w-40 max-w-0`}>
              <div className="truncate text-(--text)" title={item.title}>{item.title}</div>
            </td>
            <td className={`${tdCls} w-16 text-(--text-faint)`}>
              <Ago iso={item.createdAt} now={now} />
            </td>
            <td className={`${tdCls} w-40 max-w-40`}>
              <RefChips item={item} onJumpRun={onJumpRun} onJumpProposal={onJumpProposal} onJumpEvent={onJumpEvent} />
            </td>
            <td className={`${tdCls} w-12`}>
              <span
                role="img"
                aria-label={deliveryText(item)}
                title={deliveryText(item)}
                className="inline-block size-2 rounded-full"
                style={{ background: DELIVERY_HUES[d] }}
              />
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** Every ref is one click from the thing it is about; nothing here selects the row. */
function RefChips({
  item,
  onJumpRun,
  onJumpProposal,
  onJumpEvent,
}: {
  item: InboxItem;
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
}) {
  const r = item.refs;
  const chip = "rounded border border-(--border) bg-(--surface-1) px-1 text-[10px]";
  const chips: React.ReactNode[] = [];
  if (r.runId) chips.push(<JumpLink key="run" className={chip} onClick={() => onJumpRun(r.runId!)} title={r.runId}>{shortId(r.runId)}</JumpLink>);
  if (r.proposalId) chips.push(<JumpLink key="prop" className={chip} onClick={() => onJumpProposal(r.proposalId!)} title={r.proposalId}>{shortId(r.proposalId)}</JumpLink>);
  if (r.eventId && r.eventSource) chips.push(<JumpLink key="event" className={chip} onClick={() => onJumpEvent(r.eventSource!, r.eventId!)} title={r.eventId}>{shortId(r.eventId)}</JumpLink>);
  if (r.issue) chips.push(<JumpLink key="issue" className={chip} href={`${LINEAR_ISSUE_URL}${encodeURIComponent(r.issue)}`} title="Open in Linear">{r.issue}</JumpLink>);
  if (r.pr) chips.push(<JumpLink key="pr" className={chip} href={r.pr} title={r.pr}>PR</JumpLink>);
  if (chips.length === 0) return <span className="text-(--text-faint)">-</span>;
  // One line, clipped: a row must stay one row high; the pane lists every ref in full.
  return <div className="flex gap-1 overflow-hidden whitespace-nowrap [&>*]:shrink-0">{chips}</div>;
}
