import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api";
import {
  keyGuard,
  refetchIntervals,
  useDisplayOptions,
  useListKeys,
  useNow,
  useTabKeys,
} from "../hooks";
import { goPrefixActive } from "../goSequence";
import {
  buildSections,
  cycleColumnSort,
  flattenSections,
  grouped,
  removeCustomColumn,
  sortRows,
  toggleCollapsed,
  visibleColumns,
  type DisplayConfig,
  type DisplayState,
} from "../displayOptions";
import { DisplayOptions, exportJson } from "../components/DisplayOptions";
import { CustomCell } from "../components/CustomCell";
import { DecisionCard } from "../components/DecisionCard";
import { hasInboxPlainActions, InboxActions } from "../components/InboxActions";
import {
  INBOX_FACETS,
  matchesFilterQuery,
  parseFilterQuery,
} from "../filterQuery";
import type { InboxItem, Proposal } from "../types";
import {
  Ago,
  BulkActionBar,
  Button,
  CopyActions,
  DetailPane,
  Dialog,
  FilterInput,
  GroupHeaderRow,
  JumpLink,
  KV,
  ListEmpty,
  ListPane,
  Section,
  StateBadge,
  Table,
  Th,
  VerbError,
  notify,
  shortId,
} from "../components/ui";
import { Button as PrimitiveButton } from "../components/ui";

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
    kinds: [
      "decision_needed",
      "proposal_expired",
      "BLOCKED",
      "ESCALATED",
      "human_needed",
    ],
  },
  {
    id: "red",
    label: "Red",
    hue: "var(--hue-err)",
    kinds: ["CI RED", "SMOKE RED", "CIRCUIT BREAKER"],
  },
  { id: "ready", label: "Ready", hue: "var(--hue-ok)", kinds: ["RC READY"] },
];

const OTHER_GROUP: InboxGroup = {
  id: "other",
  label: "Other",
  hue: "var(--hue-idle)",
  kinds: [],
};

const INBOX_RESOLVE_REASONS = [
  "Handled manually",
  "No longer actionable",
  "Superseded",
  "Duplicate",
] as const;

export function groupOf(kind: string): InboxGroup {
  return INBOX_GROUPS.find((g) => g.kinds.includes(kind)) ?? OTHER_GROUP;
}

/** One hue per kind so the badge reads the same in the list, the pane, and Overview. */
export const INBOX_KIND_HUES: Record<string, string> = Object.fromEntries(
  INBOX_GROUPS.flatMap((g) => g.kinds.map((k) => [k, g.hue])),
);

const INBOX_GROUP_HUES = Object.fromEntries(
  [...INBOX_GROUPS, OTHER_GROUP].map((group) => [group.label, group.hue]),
);

/** Shared display grammar for Inbox: triage grouping and oldest-first age are the operator defaults. */
export const INBOX_DISPLAY: DisplayConfig<InboxItem> = {
  view: "inbox",
  groups: [
    {
      key: "attention",
      label: "Group (Decide/Red/Ready)",
      get: (item) => groupOf(item.kind).label,
      order: [...INBOX_GROUPS.map((group) => group.label), OTHER_GROUP.label],
      hue: INBOX_GROUP_HUES,
    },
    {
      key: "kind",
      label: "Kind",
      get: (item) => item.kind,
      hue: INBOX_KIND_HUES,
    },
    { key: "repo", label: "Repo", get: (item) => item.refs.repo ?? "—" },
  ],
  sorts: [
    { key: "age", label: "Age", get: (item) => item.createdAt, column: "age" },
    { key: "kind", label: "Kind", get: (item) => item.kind, column: "kind" },
  ],
  columns: [
    { key: "kind", label: "Kind" },
    { key: "title", label: "Title" },
    { key: "age", label: "Age" },
    { key: "refs", label: "Refs" },
    { key: "sent", label: "Sent" },
  ],
  defaults: { groupBy: "attention", sortBy: "age", sortDir: "asc" },
};

/** Keep one identity column visible while allowing every Inbox property to be toggled. */
export function ensureInboxColumn(state: DisplayState): DisplayState {
  const visibleBuiltIn = INBOX_DISPLAY.columns.some(
    (column) => !state.hiddenColumns.includes(column.key),
  );
  const visibleCustom = state.customColumns.some(
    (path) => !state.hiddenColumns.includes(`custom:${path}`),
  );
  if (visibleBuiltIn || visibleCustom) return state;
  return {
    ...state,
    hiddenColumns: state.hiddenColumns.filter((key) => key !== "title"),
  };
}

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
  return t.error || (t.exit_code !== null && t.exit_code !== 0)
    ? "failed"
    : "sent";
}

export function deliveryText(item: InboxItem): string {
  const t = item.delivery?.telegram;
  if (!t) return "Telegram: not attempted";
  const when = new Date(t.sent_at).toLocaleTimeString([], { hour12: false });
  if (t.error) return `Telegram: failed ${when} · ${t.error}`;
  if (t.exit_code !== null && t.exit_code !== 0)
    return `Telegram: failed ${when} · exit ${t.exit_code}`;
  return `Telegram: sent ${when} · exit ${t.exit_code ?? 0}`;
}

type InboxWaiter = { runId?: string; at?: string };

function inboxWaiters(item: InboxItem): InboxWaiter[] {
  const waiters = (item as InboxItem & { waiters?: InboxWaiter[] }).waiters;
  return Array.isArray(waiters) ? waiters : [];
}

/** 1 (this item) + attached runs. Hidden in the list when the count is 1. */
export function waitingCount(item: InboxItem): number {
  const named = (item as InboxItem & { waitingCount?: number }).waitingCount;
  if (typeof named === "number" && Number.isFinite(named) && named >= 1) {
    return named;
  }
  return 1 + inboxWaiters(item).length;
}

export function waitingLabel(count: number): string | null {
  if (count <= 1) return null;
  return `${count} runs waiting on this answer`;
}

const DELIVERY_HUES: Record<DeliveryState, string> = {
  sent: "var(--hue-ok)",
  failed: "var(--hue-err)",
  none: "var(--hue-idle)",
};

/** Group in triage order, oldest first inside a group; empty groups are dropped. */
export function groupItems(
  items: InboxItem[],
): { group: InboxGroup; items: InboxItem[] }[] {
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
      items: [...byGroup.get(g.id)!].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    }));
}

/** `agent:<runId>` sources point at the run that raised the item. */
export function sourceRunId(source: string): string | null {
  const m = /^agent:(.+)$/.exec(source);
  return m ? m[1] : null;
}

const LINEAR_ISSUE_URL = "https://linear.app/watt-mind/issue/";

const REPO_GITHUB: Record<string, string> = {
  bj29: "watt-mind/bakonszegi-coaching",
  "wm-home": "watt-mind/wm-home",
  "coach-wattz": "watt-mind/coach",
  "watts-mobile": "watt-mind/watts-mobile",
  legalease: "watt-mind/legalease",
  cashsaas: "hdkiller/cashsaas",
  proxies: "watt-mind/proxies",
  hdkiller: "hdkiller/hdkiller",
  "eslint-config": "watt-mind/eslint-config",
  factory: "watt-mind/factory",
};

// Only unambiguous team prefixes belong here. CLNT, CW, and OPS each route to
// multiple repositories, so a bare issue from those teams must not guess.
const ISSUE_PREFIX_GITHUB: Record<string, string> = {
  WM: "watt-mind/factory",
  LAB: "watt-mind/proxies",
};

function prNumber(ref: string | undefined): string | null {
  if (!ref) return null;
  return (
    /^(?:PR\s*)?#(\d+)$/i.exec(ref.trim())?.[1] ??
    /\/pull\/(\d+)(?:[/?#]|$)/.exec(ref)?.[1] ??
    null
  );
}

function githubRepo(item: InboxItem): string | null {
  const repo = item.refs.repo?.trim();
  if (repo) {
    if (/^[^/\s]+\/[^/\s]+$/.test(repo)) return repo;
    if (REPO_GITHUB[repo]) return REPO_GITHUB[repo];
  }
  const team = /^([A-Z][A-Z0-9]+)-\d+$/i
    .exec(item.refs.issue ?? "")?.[1]
    ?.toUpperCase();
  return team ? (ISSUE_PREFIX_GITHUB[team] ?? null) : null;
}

/** Resolve only real absolute URLs or PR shorthands with a known repository. */
export function prHref(item: InboxItem): string | null {
  const ref = item.refs.pr?.trim();
  if (!ref) return null;
  if (/^https?:\/\/[^\s]+$/i.test(ref)) return ref;
  const number = prNumber(ref);
  const repo = githubRepo(item);
  return number && repo ? `https://github.com/${repo}/pull/${number}` : null;
}

/** Per-kind action chips may trust a digits-only refs.pr once refs.repo resolves. */
export function inboxActionPrHref(item: InboxItem): string | null {
  const existing = prHref(item);
  if (existing) return existing;
  const number = /^\d+$/.exec(item.refs.pr?.trim() ?? "")?.[0];
  const repo = githubRepo(item);
  return number && repo ? `https://github.com/${repo}/pull/${number}` : null;
}

function refPrefixIsVisible(prefix: string, item: InboxItem): boolean {
  const tokens = prefix.split(/\s*\/\s*/);
  return tokens.every((token) => {
    if (/^[A-Z][A-Z0-9]+-\d+$/i.test(token)) {
      return item.refs.issue?.toUpperCase() === token.toUpperCase();
    }
    const number = /^(?:PR\s*)?#(\d+)$/i.exec(token)?.[1];
    return number != null && prNumber(item.refs.pr) === number;
  });
}

/** Keep the row focused on the action by removing labels already shown beside it. */
export function displayTitle(item: InboxItem): string {
  let title = item.title.trimStart();
  if (/^DECISION NEEDED\s+/i.test(title)) {
    title = title.replace(/^DECISION NEEDED\s+/i, "");
  }
  const knownKinds = [
    ...new Set([item.kind, ...INBOX_GROUPS.flatMap((group) => group.kinds)]),
  ].sort((a, b) => b.length - a.length);
  for (const kind of knownKinds) {
    const plain = kind.toLowerCase();
    const bracketed = `[${plain}]`;
    const lower = title.toLowerCase();
    const matched = lower.startsWith(`${plain} `)
      ? plain.length
      : lower.startsWith(`${bracketed} `)
        ? bracketed.length
        : 0;
    if (matched) {
      title = title.slice(matched).trimStart();
      break;
    }
  }

  const refPrefix =
    /^((?:(?:[A-Z][A-Z0-9]+-\d+)|(?:(?:PR\s*)?#\d+))(?:\s*\/\s*(?:(?:[A-Z][A-Z0-9]+-\d+)|(?:(?:PR\s*)?#\d+)))?)\s*:\s*/i.exec(
      title,
    );
  if (refPrefix && refPrefixIsVisible(refPrefix[1], item))
    title = title.slice(refPrefix[0].length);
  return title || item.title;
}

/**
 * Kind badge in the list row is redundant when a group header already names
 * the group. Other (unknown kinds) still needs the badge; so does an
 * ungrouped table, or grouping by a field that is not kind/attention.
 */
export function kindBadgeInRow(
  item: InboxItem,
  display: { groupBy: string },
): boolean {
  if (groupOf(item.kind).id === "other") return true;
  if (display.groupBy === "attention" || display.groupBy === "kind")
    return false;
  return true;
}

/** Live TTL remaining from proposal `created_at + ttl_seconds`. */
export function proposalTtlLabel(
  createdAt: string | undefined,
  ttlSeconds: number | undefined,
  now: number,
): string | null {
  if (!createdAt || ttlSeconds == null || ttlSeconds <= 0) return null;
  const expiry = new Date(createdAt).getTime() + ttlSeconds * 1000;
  if (!Number.isFinite(expiry)) return null;
  const leftMs = expiry - now;
  if (leftMs <= 0) return "expired";
  const minutes = Math.max(1, Math.ceil(leftMs / 60_000));
  if (minutes >= 60) return `${Math.ceil(minutes / 60)}h left`;
  return `${minutes}m left`;
}

/**
 * Expired items stay available in the Open tab, but are not actionable by default.
 * Must agree with the `open` count predicate in `inboxCounts` (event-runtime/lib/inbox.mjs)
 * so the sidebar badge and the Open tab count match.
 */
export function isExpiredInboxItem(
  item: InboxItem,
  proposalsById: Map<string, Proposal>,
  now: number,
): boolean {
  if (item.kind === "proposal_expired") return true;
  const proposal = item.refs.proposalId
    ? proposalsById.get(item.refs.proposalId)
    : undefined;
  return (
    proposal?.status === "open" &&
    proposalTtlLabel(proposal.created_at, proposal.ttl_seconds, now) ===
      "expired"
  );
}

/** WM-559 will move this precision into shared `Ago`; keep the Inbox local until then. */
export function inboxAge(iso: string, now: number): string {
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h ago`;
}

/** How many rows a single Needs-you group shows before deferring to the Inbox. */
export const NEEDS_YOU_CAP = 5;

/**
 * The compact attention grammar shared by Inbox-adjacent surfaces.  Overview
 * intentionally owns neither another inbox list nor another kind palette:
 * it supplies the navigation/action wiring while this component keeps the
 * visual and keyboard semantics aligned with the Inbox ledger.
 */
export interface NeedsYouRowProps {
  kind: string;
  title: string;
  /** Full, unabridged title for the tooltip; defaults to the visible title. */
  tooltip?: string;
  age?: ReactNode;
  hue?: string;
  selected?: boolean;
  onOpen?: () => void;
  primaryAction?: { label: string; onClick: () => void };
  onAck?: () => void;
  ackDisabled?: boolean;
  children?: ReactNode;
}

export function NeedsYouRow({
  kind,
  title,
  tooltip,
  age,
  hue,
  selected = false,
  onOpen,
  primaryAction,
  onAck,
  ackDisabled = false,
  children,
}: NeedsYouRowProps) {
  const hues = hue ? { ...INBOX_KIND_HUES, [kind]: hue } : INBOX_KIND_HUES;
  const showKind = groupOf(kind).id === "other";
  const open = () => onOpen?.();
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-current={onOpen && selected ? "true" : undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !onOpen) return;
        event.preventDefault();
        open();
      }}
      className={`group flex min-w-0 items-center gap-2 border-b border-(--border) px-3 py-2 last:border-0 ${
        onOpen
          ? "cursor-pointer hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)"
          : ""
      } ${selected ? "row-selected" : ""}`}
    >
      {showKind && <StateBadge state={kind} hues={hues} dot={false} />}
      <span
        className="min-w-0 flex-1 truncate text-[12px] text-(--text)"
        title={tooltip ?? title}
      >
        {title}
      </span>
      {age && (
        <span className="mono shrink-0 text-[11px] text-(--text-faint)">
          {age}
        </span>
      )}
      {primaryAction && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            primaryAction.onClick();
          }}
          className="shrink-0 cursor-pointer rounded bg-(--surface-3) px-2 py-1 text-[11px] font-medium text-(--text) hover:bg-(--accent) hover:text-(--surface-0) focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          {primaryAction.label}
        </button>
      )}
      {onAck && (
        <button
          type="button"
          disabled={ackDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onAck();
          }}
          className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-[11px] text-(--text-faint) hover:bg-(--surface-3) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:cursor-not-allowed disabled:opacity-40"
        >
          ack
        </button>
      )}
      {children}
    </div>
  );
}

export function NeedsYouGroup({
  label,
  hue,
  count,
  onMore,
  children,
}: {
  label: string;
  hue: string;
  count: number;
  onMore?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-(--border) bg-(--surface-1)">
      <div className="flex items-center gap-2 border-b border-(--border) px-3 py-1.5 text-[11px]">
        <span className="size-1.5 rounded-full" style={{ background: hue }} />
        <h3 className="font-semibold text-(--text-dim)">{label}</h3>
        <span className="mono text-(--text-faint)">{count}</span>
        {count > NEEDS_YOU_CAP && onMore && (
          <button
            type="button"
            onClick={onMore}
            className="ml-auto cursor-pointer text-(--text-faint) hover:text-(--text) hover:underline"
          >
            {count - NEEDS_YOU_CAP} more →
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

export interface OverviewNeedsYouProps {
  items: InboxItem[];
  runtimeItems: Array<{
    id: string;
    title: string;
    primaryAction?: { label: string; onClick: () => void };
  }>;
  now: number;
  lastDecision: string | null;
  runtimeLabel?: string;
  connected: boolean;
  /** An ack is in flight: keep the verb visible but inert. */
  ackPending?: boolean;
  /** The ledger has not answered yet — say nothing rather than "all clear". */
  isPending?: boolean;
  onOpenItem: (id: string) => void;
  onAck: (id: string) => void;
  onMore: () => void;
}

/**
 * Overview is deliberately a thin, lazy consumer of the Inbox's compact
 * grammar. Keeping this with the ledger avoids a second row implementation
 * while retaining the Inbox view as its own bundle.
 */
export function OverviewNeedsYou({
  items,
  runtimeItems,
  now,
  lastDecision,
  runtimeLabel = "Runtime",
  connected,
  ackPending = false,
  isPending = false,
  onOpenItem,
  onAck,
  onMore,
}: OverviewNeedsYouProps) {
  const groups = useMemo(() => groupItems(items), [items]);
  const navigable = useMemo(
    () => [
      ...groups.flatMap(({ items: groupItems }) =>
        groupItems
          .slice(0, NEEDS_YOU_CAP)
          .map((item) => ({ id: item.id, open: () => onOpenItem(item.id) })),
      ),
      ...runtimeItems
        .slice(0, NEEDS_YOU_CAP)
        .flatMap((item) =>
          item.primaryAction
            ? [{ id: item.id, open: item.primaryAction.onClick }]
            : [],
        ),
    ],
    [groups, onOpenItem, runtimeItems],
  );
  const [selected, setSelected] = useState(0);
  const selectedIndex = Math.min(selected, Math.max(0, navigable.length - 1));
  useListKeys({
    count: navigable.length,
    selected: selectedIndex,
    onSelect: setSelected,
    onOpen: () => navigable[selectedIndex]?.open(),
  });

  const empty = items.length === 0 && runtimeItems.length === 0;

  return (
    <section className="mb-6" aria-label="Needs you">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-(--text-faint)">
            Needs you
          </span>
        </h2>
        {items.length > 0 && (
          <span className="text-[11px] text-(--text-faint)">
            {items.length} open
          </span>
        )}
      </div>
      {empty && isPending ? (
        <div className="flex items-center gap-2 px-1 py-2 text-[12px] text-(--text-faint)">
          <span className="size-1.5 rounded-full bg-(--hue-idle)" />
          Checking what needs you
        </div>
      ) : empty ? (
        <div className="flex items-center gap-2 px-1 py-2 text-[12px] text-(--text-faint)">
          <span className="size-1.5 rounded-full bg-(--hue-ok)" />
          Nothing needs you · last decision{" "}
          {lastDecision ? <Ago iso={lastDecision} now={now} /> : "—"}
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map(({ group, items: groupItems }) => (
            <NeedsYouGroup
              key={group.id}
              label={group.label}
              hue={group.hue}
              count={groupItems.length}
              onMore={onMore}
            >
              {groupItems.slice(0, NEEDS_YOU_CAP).map((item) => (
                <NeedsYouRow
                  key={item.id}
                  kind={item.kind}
                  title={displayTitle(item)}
                  tooltip={item.title}
                  age={<Ago iso={item.createdAt} now={now} />}
                  selected={navigable[selectedIndex]?.id === item.id}
                  onOpen={() => onOpenItem(item.id)}
                  primaryAction={{
                    label: "Open",
                    onClick: () => onOpenItem(item.id),
                  }}
                  onAck={() => onAck(item.id)}
                  ackDisabled={!connected || ackPending}
                />
              ))}
            </NeedsYouGroup>
          ))}
          {runtimeItems.length > 0 && (
            <NeedsYouGroup
              label={runtimeLabel}
              hue="var(--hue-warn)"
              count={runtimeItems.length}
            >
              {runtimeItems.slice(0, NEEDS_YOU_CAP).map((item) => (
                <NeedsYouRow
                  key={item.id}
                  kind="Runtime"
                  hue="var(--hue-warn)"
                  title={item.title}
                  selected={navigable[selectedIndex]?.id === item.id}
                  onOpen={item.primaryAction?.onClick}
                  primaryAction={item.primaryAction}
                />
              ))}
            </NeedsYouGroup>
          )}
        </div>
      )}
    </section>
  );
}

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  Boolean(target.closest("input, textarea, select, [contenteditable=true]"));

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
  const query = useQuery({
    queryKey: ["inbox", "all"],
    queryFn: () => api.inbox("all"),
    ...refetchIntervals.primary,
  });
  const items = query.data?.items ?? [];
  const proposalsQuery = useQuery({
    queryKey: ["proposals"],
    queryFn: api.proposals,
    ...refetchIntervals.primary,
  });
  const proposalsById = useMemo(() => {
    const map = new Map<string, Proposal>();
    for (const proposal of proposalsQuery.data?.proposals ?? []) {
      map.set(proposal.id, proposal);
    }
    return map;
  }, [proposalsQuery.data]);

  const [tab, setTab] = useState<InboxTab>("open");
  const [expiredOnly, setExpiredOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const expiredOpenItems = useMemo(
    () =>
      items.filter(
        (item) =>
          itemStatus(item) === "open" &&
          isExpiredInboxItem(item, proposalsById, now),
      ),
    [items, now, proposalsById],
  );
  const counts = useMemo(() => {
    const c: Record<InboxTab, number> = {
      open: 0,
      acked: 0,
      resolved: 0,
      all: 0,
    };
    // Expired open items live behind the Expired chip, so every tab count
    // excludes them and open + acked + resolved === all.
    for (const it of items) {
      if (
        itemStatus(it) === "open" &&
        isExpiredInboxItem(it, proposalsById, now)
      ) {
        continue;
      }
      c[itemStatus(it)] += 1;
      c.all += 1;
    }
    return c;
  }, [items, now, proposalsById]);

  const byTab = useMemo(
    () =>
      items.filter((item) => {
        if (!matchesTab(item, tab)) return false;
        if (itemStatus(item) !== "open") return true;
        const expired = isExpiredInboxItem(item, proposalsById, now);
        return tab === "open" ? expired === expiredOnly : !expired;
      }),
    [expiredOnly, items, now, proposalsById, tab],
  );
  const parsed = useMemo(
    () => parseFilterQuery(filter, INBOX_FACETS),
    [filter],
  );
  const filtered = useMemo(
    () =>
      byTab.filter((item) =>
        matchesFilterQuery(item, parsed, INBOX_FACETS, undefined),
      ),
    [byTab, parsed],
  );
  const [display, updateDisplay] = useDisplayOptions(INBOX_DISPLAY);
  const setDisplay = (
    next: DisplayState | ((state: DisplayState) => DisplayState),
  ) => {
    updateDisplay((state) =>
      ensureInboxColumn(typeof next === "function" ? next(state) : next),
    );
  };
  const sections = useMemo(
    () => buildSections(filtered, INBOX_DISPLAY, display),
    [filtered, display],
  );
  const visible = useMemo(
    () => flattenSections(sections, display.collapsed),
    [sections, display.collapsed],
  );
  const cols = visibleColumns(INBOX_DISPLAY, display);
  const show = useMemo(() => new Set(cols.map((column) => column.key)), [cols]);

  const selectionEnabled = tab === "open" || tab === "acked";
  const actionableVisible = selectionEnabled ? visible : [];
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAcking, setBulkAcking] = useState(false);
  const [bulkResolving, setBulkResolving] = useState(false);
  const [bulkResolveOpen, setBulkResolveOpen] = useState(false);
  const [bulkResolveReason, setBulkResolveReason] = useState("");
  const bulkResolveReasonRef = useRef<HTMLTextAreaElement>(null);
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  const pendingStar = useRef(0);

  const allActionableSelected =
    actionableVisible.length > 0 &&
    actionableVisible.every((it) => selectedIds.has(it.id));
  const someActionableSelected =
    actionableVisible.some((it) => selectedIds.has(it.id)) &&
    !allActionableSelected;
  const selectedRows = useMemo(
    () => visible.filter((it) => selectedIds.has(it.id)),
    [visible, selectedIds],
  );
  const ackableSelected = selectedRows.filter(
    (it) =>
      itemStatus(it) === "open" &&
      !it.decision &&
      !hasInboxPlainActions(it.kind),
  );
  const resolvableSelected = selectedRows.filter(
    (it) =>
      itemStatus(it) !== "resolved" &&
      !it.decision &&
      (!hasInboxPlainActions(it.kind) ||
        it.kind === "SMOKE RED" ||
        it.kind === "CIRCUIT BREAKER"),
  );

  useEffect(() => {
    if (headerCheckboxRef.current)
      headerCheckboxRef.current.indeterminate = someActionableSelected;
  }, [someActionableSelected]);

  // IDs survive ordinary polling, while items that leave the active tab are
  // pruned once the refetch establishes the new visible set.
  useEffect(() => {
    const visibleIds = new Set(actionableVisible.map((it) => it.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [actionableVisible]);

  const lastInteractedId = useRef<string | null>(null);

  const toggleSelect = (id: string, shiftKey = false) => {
    const anchorId = lastInteractedId.current;
    lastInteractedId.current = id;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      const isSelected = next.has(id);
      const targetIndex = actionableVisible.findIndex((it) => it.id === id);
      const anchorIndex =
        anchorId !== null
          ? actionableVisible.findIndex((it) => it.id === anchorId)
          : -1;

      if (shiftKey && anchorIndex !== -1 && targetIndex !== -1) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const range = actionableVisible.slice(start, end + 1);
        if (isSelected) {
          for (const item of range) {
            next.delete(item.id);
          }
        } else {
          for (const item of range) {
            next.add(item.id);
          }
        }
      } else {
        if (isSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  };
  const selectAllActionable = () => {
    lastInteractedId.current = null;
    setSelectedIds(new Set(actionableVisible.map((it) => it.id)));
  };
  const toggleSelectAll = () => {
    lastInteractedId.current = null;
    if (allActionableSelected) setSelectedIds(new Set());
    else selectAllActionable();
  };

  const sel = focusItemId
    ? (items.find((it) => it.id === focusItemId) ?? null)
    : null;
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
  const [resolveReason, setResolveReason] = useState("");
  const resolveReasonRef = useRef<HTMLTextAreaElement>(null);
  const resolve = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.resolveInbox(id, reason),
    onSuccess: (_out, { id }) => {
      invalidate();
      setConfirmResolve(false);
      setResolveReason("");
      notify(`Resolved ${shortId(id)}`, "ok");
    },
    onError: (err) =>
      notify(`Resolve failed: ${(err as Error).message}`, "err"),
  });

  const canAck =
    !!sel &&
    !sel.decision &&
    !hasInboxPlainActions(sel.kind) &&
    connected &&
    itemStatus(sel) === "open" &&
    !ack.isPending;
  const canResolve =
    !!sel &&
    !sel.decision &&
    (!hasInboxPlainActions(sel.kind) ||
      sel.kind === "SMOKE RED" ||
      sel.kind === "CIRCUIT BREAKER") &&
    connected &&
    itemStatus(sel) !== "resolved" &&
    !resolve.isPending;
  const canSubmitResolve = canResolve && resolveReason.trim().length > 0;

  const openResolve = () => {
    setResolveReason("");
    setConfirmResolve(true);
  };

  const openBulkResolve = () => {
    setBulkResolveReason("");
    setBulkResolveOpen(true);
  };

  const handleBulkAck = async () => {
    if (!connected || bulkAcking || ackableSelected.length === 0) return;
    setBulkAcking(true);
    let done = 0;
    let failed = 0;
    for (const item of ackableSelected) {
      try {
        await api.ackInbox(item.id);
        done++;
      } catch {
        failed++;
      }
    }
    invalidate();
    setSelectedIds(new Set());
    setBulkAcking(false);
    notify(`Ack: ${done} done / ${failed} failed`, failed ? "err" : "ok");
  };

  const handleBulkResolve = async () => {
    const reason = bulkResolveReason.trim();
    if (
      !connected ||
      bulkResolving ||
      resolvableSelected.length === 0 ||
      !reason
    )
      return;
    setBulkResolving(true);
    let done = 0;
    let failed = 0;
    for (const item of resolvableSelected) {
      try {
        await api.resolveInbox(item.id, reason);
        done++;
      } catch {
        failed++;
      }
    }
    invalidate();
    setSelectedIds(new Set());
    setBulkResolving(false);
    setBulkResolveOpen(false);
    setBulkResolveReason("");
    notify(`Resolve: ${done} done / ${failed} failed`, failed ? "err" : "ok");
  };

  // Enter confirms either resolve dialog. Dialog focus parks on its root, so a
  // focused button is not something the keyboard contract can rely on.
  useEffect(() => {
    if (!confirmResolve && !bulkResolveOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (
        bulkResolveOpen &&
        connected &&
        !bulkResolving &&
        resolvableSelected.length > 0 &&
        bulkResolveReason.trim()
      ) {
        e.preventDefault();
        void handleBulkResolve();
      } else if (confirmResolve && sel && canSubmitResolve) {
        e.preventDefault();
        resolve.mutate({ id: sel.id, reason: resolveReason.trim() });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    confirmResolve,
    bulkResolveOpen,
    sel,
    canSubmitResolve,
    resolve,
    resolveReason,
    connected,
    bulkResolving,
    bulkResolveReason,
    resolvableSelected,
  ]);

  const selectTab = (t: InboxTab) => {
    lastInteractedId.current = null;
    setTab(t);
    setExpiredOnly(false);
    onSelectItem(null);
    setSelectedIds(new Set());
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
      else if (bulkResolveOpen) setBulkResolveOpen(false);
      else if (selectedIds.size > 0) setSelectedIds(new Set());
      else if (sel) onSelectItem(null);
    },
    keys: {
      a: () => {
        const starActive =
          pendingStar.current > 0 && Date.now() - pendingStar.current < 800;
        if (!starActive && canAck && sel) ack.mutate(sel.id);
      },
      x: () => {
        if (canResolve) openResolve();
      },
    },
  });

  useEffect(() => {
    function onSelectionKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.altKey || goPrefixActive() || e.repeat) return;
      const now = Date.now();
      const starActive =
        pendingStar.current > 0 && now - pendingStar.current < 800;

      if (!e.metaKey && !e.ctrlKey && e.key === "*") {
        e.preventDefault();
        pendingStar.current = now;
        return;
      }
      if (
        !e.metaKey &&
        !e.ctrlKey &&
        starActive &&
        (e.key === "a" || e.key === "n")
      ) {
        e.preventDefault();
        pendingStar.current = 0;
        if (e.key === "a") selectAllActionable();
        else setSelectedIds(new Set());
        return;
      }
      pendingStar.current = 0;

      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "a"
      ) {
        if (actionableVisible.length === 0) return;
        e.preventDefault();
        selectAllActionable();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;

      if ((e.key === " " || e.key === "Spacebar") && selectionEnabled && sel) {
        e.preventDefault();
        toggleSelect(sel.id);
        return;
      }
      if (e.key === "A" && selectedIds.size > 0) {
        if (!connected || bulkAcking || ackableSelected.length === 0) return;
        e.preventDefault();
        void handleBulkAck();
        return;
      }
      if (e.key === "X" && selectedIds.size > 0) {
        if (!connected || bulkResolving || resolvableSelected.length === 0)
          return;
        e.preventDefault();
        openBulkResolve();
      }
    }

    window.addEventListener("keydown", onSelectionKey);
    return () => window.removeEventListener("keydown", onSelectionKey);
  }, [
    actionableVisible,
    ackableSelected,
    bulkAcking,
    bulkResolving,
    connected,
    resolvableSelected,
    sel,
    selectedIds.size,
    selectionEnabled,
  ]);

  const tdCls = "border-b border-(--border) px-3 py-1.5 whitespace-nowrap";
  const openEmpty =
    tab === "open" && byTab.length === 0 && !filter.trim() && query.isSuccess;
  const handleExport = () => {
    const sorted = sortRows(filtered, INBOX_DISPLAY, display);
    const dateStr = new Date().toISOString().slice(0, 10);
    exportJson(`inbox-export-${dateStr}.json`, sorted);
    notify(
      `Exported ${sorted.length} inbox item${sorted.length === 1 ? "" : "s"} to JSON`,
      "info",
    );
  };

  return (
    <div className="flex h-full min-w-0">
      <div
        className={`${sel ? "hidden sm:flex" : "flex"} min-h-0 min-w-0 flex-1`}
      >
        <ListPane
          chrome={
            <>
              <h1 className="display mb-4 text-h1 font-semibold">Inbox</h1>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div
                  className="flex min-w-0 flex-1 flex-wrap gap-1"
                  role="tablist"
                  aria-label="Inbox status"
                >
                  {INBOX_TABS.map((t, idx) => (
                    <PrimitiveButton
                      bare
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      onClick={() => selectTab(t)}
                      title={t}
                      className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                        tab === t
                          ? "bg-(--surface-3) text-(--text)"
                          : "text-(--text-faint) hover:bg-(--surface-1)"
                      }`}
                    >
                      {t[0].toUpperCase() + t.slice(1)}
                      {counts[t] > 0 && (
                        <span className="ml-1.5 tabular-nums text-(--text-faint)">
                          {counts[t]}
                        </span>
                      )}
                      <span
                        aria-hidden="true"
                        className="mono ml-1 text-xs text-(--text-faint) opacity-70"
                      >
                        {idx + 1}
                      </span>
                    </PrimitiveButton>
                  ))}
                </div>
                {tab === "open" && expiredOpenItems.length > 0 && (
                  <PrimitiveButton
                    bare
                    type="button"
                    aria-pressed={expiredOnly}
                    onClick={() => {
                      setExpiredOnly((current) => !current);
                      onSelectItem(null);
                      setSelectedIds(new Set());
                    }}
                    className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                      expiredOnly
                        ? "bg-(--surface-3) text-(--text)"
                        : "text-(--text-faint) hover:bg-(--surface-1)"
                    }`}
                  >
                    Expired ({expiredOpenItems.length})
                  </PrimitiveButton>
                )}
                <span className="ml-auto">
                  <DisplayOptions
                    config={INBOX_DISPLAY}
                    state={display}
                    onChange={setDisplay}
                    onExport={filtered.length > 0 ? handleExport : undefined}
                    rows={byTab}
                  />
                </span>
                <FilterInput
                  value={filter}
                  onChange={setFilter}
                  placeholder="kind:… is:open repo:… issue:…"
                  label="Filter inbox"
                  query={parsed}
                  facets={INBOX_FACETS}
                />
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
                background:
                  "color-mix(in oklch, var(--hue-warn) 10%, transparent)",
              }}
            >
              No inbox item <span className="mono">{focusItemId}</span> — it may
              predate the ledger or the link is stale.
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
            <Table className="w-full border-separate border-spacing-0">
              <thead className="group">
                <tr className="text-left">
                  {selectionEnabled && (
                    <th className="sticky top-0 z-10 h-7 w-8 bg-(--surface-0) px-3 shadow-[inset_0_-1px_0_var(--border)]">
                      <input
                        ref={headerCheckboxRef}
                        type="checkbox"
                        aria-label="Select all inbox items"
                        checked={allActionableSelected}
                        disabled={actionableVisible.length === 0}
                        onChange={toggleSelectAll}
                        className={`cursor-pointer transition-opacity ${
                          selectedIds.size > 0
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                        }`}
                      />
                    </th>
                  )}
                  {cols.map((column) => {
                    const sort = INBOX_DISPLAY.sorts.find(
                      (field) => field.column === column.key,
                    );
                    const isCustom =
                      column.isCustom || column.key.startsWith("custom:");
                    const customPath = column.key.replace(/^custom:/, "");
                    const isCurrentSort = isCustom
                      ? display.sortBy === column.key
                      : sort && display.sortBy === sort.key;
                    return (
                      <Th
                        key={column.key}
                        label={column.label}
                        title={
                          column.key === "sent"
                            ? "Telegram delivery: sent, failed, or not attempted"
                            : undefined
                        }
                        dir={isCurrentSort ? display.sortDir : null}
                        naturalDir={sort?.defaultDir ?? "asc"}
                        onSort={
                          sort || isCustom
                            ? () =>
                                setDisplay((state) =>
                                  cycleColumnSort(
                                    INBOX_DISPLAY,
                                    state,
                                    column.key,
                                  ),
                                )
                            : undefined
                        }
                        onRemove={
                          isCustom
                            ? () =>
                                setDisplay((state) =>
                                  removeCustomColumn(state, customPath),
                                )
                            : undefined
                        }
                      />
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const renderRow = (item: InboxItem) => {
                    const delivery = deliveryState(item);
                    const proposal = item.refs.proposalId
                      ? proposalsById.get(item.refs.proposalId)
                      : undefined;
                    const ttl = proposalTtlLabel(
                      proposal?.created_at,
                      proposal?.ttl_seconds,
                      now,
                    );
                    const showKind =
                      show.has("kind") && kindBadgeInRow(item, display);
                    return (
                      <tr
                        key={item.id}
                        onClick={() => onSelectItem(item.id)}
                        aria-selected={item.id === sel?.id}
                        className={`group cursor-pointer hover:bg-(--surface-1) ${item.id === sel?.id ? "row-selected" : ""}`}
                      >
                        {selectionEnabled && (
                          <td
                            className={`${tdCls} w-8`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select inbox item ${item.id}`}
                              checked={selectedIds.has(item.id)}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSelect(item.id, e.shiftKey);
                              }}
                              onChange={() => {}}
                              className={`cursor-pointer transition-opacity ${
                                selectedIds.size > 0 || selectedIds.has(item.id)
                                  ? "opacity-100"
                                  : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                              }`}
                            />
                          </td>
                        )}
                        {show.has("kind") && (
                          <td className={`${tdCls} w-32`}>
                            {showKind && (
                              <StateBadge
                                state={item.kind}
                                hues={INBOX_KIND_HUES}
                                dot={false}
                              />
                            )}
                          </td>
                        )}
                        {show.has("title") && (
                          <td className={`${tdCls} min-w-40 max-w-0`}>
                            <div className="flex min-w-0 items-center gap-2">
                              <div
                                className="min-w-0 flex-1 truncate text-(--text)"
                                title={item.title}
                              >
                                {item.decision && !item.response && (
                                  <span
                                    className="mono mr-1.5 text-(--hue-warn)"
                                    aria-label="Decision required"
                                  >
                                    ?
                                  </span>
                                )}
                                {displayTitle(item)}
                              </div>
                              {ttl && (
                                <span
                                  className="mono shrink-0 text-[11px] text-(--text-faint)"
                                  aria-label={`Time left ${ttl}`}
                                >
                                  {ttl}
                                </span>
                              )}
                              {waitingLabel(waitingCount(item)) && (
                                <span className="ml-1.5 shrink-0 text-(--text-faint)">
                                  {waitingCount(item)} waiting
                                </span>
                              )}
                            </div>
                          </td>
                        )}
                        {show.has("age") && (
                          <td className={`${tdCls} w-16 text-(--text-faint)`}>
                            <Ago iso={item.createdAt} now={now} />
                          </td>
                        )}
                        {show.has("refs") && (
                          <td className={`${tdCls} w-40 max-w-40`}>
                            <RefChips
                              item={item}
                              onJumpRun={onJumpRun}
                              onJumpProposal={onJumpProposal}
                              onJumpEvent={onJumpEvent}
                            />
                          </td>
                        )}
                        {show.has("sent") && (
                          <td className={`${tdCls} w-12`}>
                            <span
                              role="img"
                              aria-label={deliveryText(item)}
                              title={deliveryText(item)}
                              className="inline-block size-2 rounded-full"
                              style={{ background: DELIVERY_HUES[delivery] }}
                            />
                          </td>
                        )}
                        {cols
                          .filter(
                            (column) =>
                              column.isCustom ||
                              column.key.startsWith("custom:"),
                          )
                          .map((column) => (
                            <CustomCell
                              key={column.key}
                              row={item}
                              path={column.key.replace(/^custom:/, "")}
                            />
                          ))}
                      </tr>
                    );
                  };
                  if (!grouped(display))
                    return sections[0]?.rows.map(renderRow);
                  return sections.map((section) => {
                    const collapsed = display.collapsed.includes(section.key);
                    return (
                      <Fragment key={section.key}>
                        <GroupHeaderRow
                          colSpan={Math.max(
                            cols.length + (selectionEnabled ? 1 : 0),
                            1,
                          )}
                          section={section}
                          collapsed={collapsed}
                          onToggle={() =>
                            setDisplay((state) =>
                              toggleCollapsed(state, section.key),
                            )
                          }
                        />
                        {!collapsed && section.rows.map(renderRow)}
                      </Fragment>
                    );
                  });
                })()}
                {filtered.length === 0 && (
                  <ListEmpty
                    colSpan={Math.max(
                      cols.length + (selectionEnabled ? 1 : 0),
                      1,
                    )}
                    query={query}
                    filtered={byTab.length > 0}
                    onClear={filter.trim() ? () => setFilter("") : undefined}
                    noun="inbox items"
                    empty={
                      tab === "acked"
                        ? "No acked items."
                        : tab === "resolved"
                          ? "No resolved items yet."
                          : tab === "open"
                            ? "Nothing waiting on you."
                            : "The ledger is empty."
                    }
                    escHint={Boolean(filter.trim())}
                  />
                )}
              </tbody>
            </Table>
          )}
        </ListPane>
      </div>

      {sel && (
        <DetailPane
          widthClass="w-full sm:w-[460px]"
          title={
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal"
            >
              <PrimitiveButton
                bare
                type="button"
                onClick={() => onSelectItem(null)}
                className="cursor-pointer text-(--text-dim) hover:text-(--accent)"
                title="Back to inbox list"
              >
                Inbox
              </PrimitiveButton>
              <span className="text-(--text-faint)" aria-hidden="true">
                /
              </span>
              <span
                className="flex min-w-0 items-center gap-2 truncate font-semibold text-(--text)"
                aria-current="page"
              >
                {groupOf(sel.kind).id === "other" && (
                  <StateBadge
                    state={sel.kind}
                    hues={INBOX_KIND_HUES}
                    dot={false}
                  />
                )}
                <span className="mono truncate" title={sel.id}>
                  {shortId(sel.id)}
                </span>
              </span>
            </nav>
          }
          actions={
            !sel.decision &&
            !hasInboxPlainActions(sel.kind) &&
            itemStatus(sel) !== "resolved" ? (
              <div className="flex items-center gap-1.5">
                <Button disabled={!canResolve} onClick={openResolve}>
                  Resolve…{" "}
                  <span
                    className="mono ml-1 text-(--text-faint)"
                    aria-hidden="true"
                  >
                    x
                  </span>
                </Button>
                {itemStatus(sel) === "open" && (
                  <Button
                    variant="primary"
                    disabled={!canAck}
                    onClick={() => ack.mutate(sel.id)}
                  >
                    Ack{" "}
                    <span className="mono ml-1 opacity-80" aria-hidden="true">
                      a
                    </span>
                  </Button>
                )}
              </div>
            ) : null
          }
          utility={<CopyActions id={sel.id} idLabel="inbox item id" />}
          close={<Button onClick={() => onSelectItem(null)}>Close</Button>}
        >
          {hasInboxPlainActions(sel.kind) && itemStatus(sel) !== "resolved" && (
            <Section title="Actions" card={false}>
              <InboxActions
                // Per-item state: a failed verb on one item must not follow
                // the operator to the next.
                key={sel.id}
                item={sel}
                connected={connected}
                prUrl={inboxActionPrHref(sel)}
                onResolve={() => setConfirmResolve(true)}
                onItemChange={invalidate}
              />
            </Section>
          )}

          <Section title="Item" icons>
            <KV
              k="kind"
              v={
                <StateBadge
                  state={sel.kind}
                  hues={INBOX_KIND_HUES}
                  dot={false}
                />
              }
            />
            <KV k="status" v={itemStatus(sel)} />
            {waitingLabel(waitingCount(sel)) && (
              <KV k="waiting" v={waitingLabel(waitingCount(sel))} />
            )}
            {sel.severity !== "normal" && <KV k="severity" v={sel.severity} />}
            <KV k="created" v={<Ago iso={sel.createdAt} now={now} />} />
            {sel.ackedAt && (
              <KV k="acked" v={<Ago iso={sel.ackedAt} now={now} />} />
            )}
            {sel.resolvedAt && (
              <KV
                k="resolved"
                v={
                  <span>
                    <Ago iso={sel.resolvedAt} now={now} />
                    {sel.resolvedReason && <> · {sel.resolvedReason}</>}
                  </span>
                }
              />
            )}
            {sel.resolvedBy && <KV k="resolved by" v={sel.resolvedBy} />}
            <KV
              k="source"
              v={
                sourceRunId(sel.source) ? (
                  <JumpLink
                    onClick={() => onJumpRun(sourceRunId(sel.source)!)}
                    title={`Open run ${sourceRunId(sel.source)}`}
                  >
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
                <div className="mt-1.5 whitespace-pre-wrap break-words text-(--text-dim)">
                  {sel.body}
                </div>
              )}
            </div>
          </Section>

          {sel.decision && (
            <Section title="Decision" card={false}>
              <DecisionCard
                itemId={sel.id}
                request={sel.decision}
                response={sel.response}
                refs={sel.refs}
                onJumpProposal={onJumpProposal}
                connected={connected}
                onItemChange={invalidate}
              />
            </Section>
          )}

          {Object.keys(sel.refs).length > 0 && (
            <Section title="References" icons>
              {sel.refs.runId && (
                <KV
                  k="run"
                  v={
                    <JumpLink
                      onClick={() => onJumpRun(sel.refs.runId!)}
                      title={`Open run ${sel.refs.runId}`}
                    >
                      {shortId(sel.refs.runId)}
                    </JumpLink>
                  }
                />
              )}
              {sel.refs.proposalId && (
                <KV
                  k="proposal"
                  v={
                    <JumpLink
                      onClick={() => onJumpProposal(sel.refs.proposalId!)}
                      title={`Open proposal ${sel.refs.proposalId}`}
                    >
                      {shortId(sel.refs.proposalId)}
                    </JumpLink>
                  }
                />
              )}
              {sel.refs.eventId && (
                <KV
                  k="event"
                  v={
                    sel.refs.eventSource ? (
                      <JumpLink
                        onClick={() =>
                          onJumpEvent(sel.refs.eventSource!, sel.refs.eventId!)
                        }
                        title={`Open event ${sel.refs.eventId}`}
                      >
                        {shortId(sel.refs.eventId)}
                      </JumpLink>
                    ) : (
                      shortId(sel.refs.eventId)
                    )
                  }
                />
              )}
              {sel.refs.issue && (
                <KV
                  k="issue"
                  v={
                    <JumpLink
                      href={`${LINEAR_ISSUE_URL}${encodeURIComponent(sel.refs.issue)}`}
                      title="Open in Linear"
                    >
                      {sel.refs.issue}
                    </JumpLink>
                  }
                />
              )}
              {sel.refs.pr && <KV k="pr" v={<PrRef item={sel} />} />}
              {sel.refs.repo && <KV k="repo" v={sel.refs.repo} />}
            </Section>
          )}

          <Section title="Delivery" icons>
            <KV
              k="telegram"
              v={
                <span
                  style={{ color: DELIVERY_HUES[deliveryState(sel)] }}
                  title={deliveryText(sel)}
                >
                  {deliveryText(sel).replace(/^Telegram: /, "")}
                </span>
              }
            />
          </Section>

          {(ack.isError || resolve.isError) && (
            <VerbError error={ack.error ?? resolve.error} />
          )}
        </DetailPane>
      )}

      {selectedIds.size > 0 && selectionEnabled && (
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
        >
          <Button
            variant="primary"
            disabled={!connected || bulkAcking || ackableSelected.length === 0}
            onClick={() => void handleBulkAck()}
          >
            {bulkAcking ? "Acking…" : "Ack"}
            <span
              className="mono ml-1 text-xs text-(--text-faint)"
              aria-hidden="true"
            >
              A
            </span>
          </Button>
          <Button
            disabled={
              !connected || bulkResolving || resolvableSelected.length === 0
            }
            onClick={openBulkResolve}
          >
            Resolve…
            <span
              className="mono ml-1 text-xs text-(--text-faint)"
              aria-hidden="true"
            >
              X
            </span>
          </Button>
        </BulkActionBar>
      )}

      {bulkResolveOpen && resolvableSelected.length > 0 && (
        <Dialog
          title={`Resolve ${resolvableSelected.length} inbox item${resolvableSelected.length === 1 ? "" : "s"}?`}
          onClose={() => setBulkResolveOpen(false)}
        >
          <p className="mb-3 text-[12px] text-(--text-dim)">
            Marks all {resolvableSelected.length} selected items as dealt with.
            They leave Open or Acked and stay in the ledger under Resolved. This
            does not act on their underlying runs, proposals, or PRs.
          </p>
          <ResolveReasonField
            value={bulkResolveReason}
            onChange={setBulkResolveReason}
            inputRef={bulkResolveReasonRef}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setBulkResolveOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                !connected || bulkResolving || !bulkResolveReason.trim()
              }
              onClick={() => void handleBulkResolve()}
            >
              {bulkResolving
                ? "Resolving…"
                : `Resolve ${resolvableSelected.length} items`}
            </Button>
          </div>
        </Dialog>
      )}

      {confirmResolve && sel && (
        <Dialog
          title="Resolve inbox item?"
          onClose={() => setConfirmResolve(false)}
        >
          <p className="mb-3 text-[12px] text-(--text-dim)">
            Marks <span className="mono">{shortId(sel.id)}</span> as dealt with.
            It leaves Open and Acked and stays in the ledger under Resolved.
            This does not act on the underlying run, proposal or PR.
          </p>
          <ResolveReasonField
            value={resolveReason}
            onChange={setResolveReason}
            inputRef={resolveReasonRef}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmResolve(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!canSubmitResolve}
              onClick={() =>
                resolve.mutate({ id: sel.id, reason: resolveReason.trim() })
              }
              autoFocus
            >
              Resolve
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function ResolveReasonField({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="mb-4">
      <div className="mb-2 text-[11px] font-medium text-(--text-faint)">
        Common reasons
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {INBOX_RESOLVE_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            onClick={() => {
              onChange(reason);
              inputRef.current?.focus();
            }}
            className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
              value === reason
                ? "border-(--accent) bg-(--surface-3) text-(--text)"
                : "border-(--border) bg-(--surface-1) text-(--text-dim) hover:bg-(--surface-2)"
            }`}
          >
            {reason}
          </button>
        ))}
      </div>
      <label className="block text-[11px] font-medium text-(--text-faint)">
        Resolution reason
        <textarea
          ref={inputRef}
          autoFocus
          required
          rows={3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Reason required — resolutions are audit records"
          className="mt-1 w-full resize-y rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1.5 text-[12px] text-(--text) outline-none focus:border-(--accent)"
        />
      </label>
    </div>
  );
}

function PrRef({ item, className }: { item: InboxItem; className?: string }) {
  const ref = item.refs.pr!;
  const href = prHref(item);
  const label = ref.replace(/^https?:\/\/(www\.)?github\.com\//, "");
  return href ? (
    <JumpLink className={className} href={href} title="Open pull request">
      {label}
    </JumpLink>
  ) : (
    <span className={`mono ${className ?? ""}`} title={ref}>
      {ref}
    </span>
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
  const chip =
    "inline-block max-w-20 truncate rounded border border-(--border) bg-(--surface-1) px-1 align-bottom text-xs";
  const chips: { key: string; description: string; node: React.ReactNode }[] =
    [];
  if (r.runId)
    chips.push({
      key: "run",
      description: `run ${r.runId}`,
      node: (
        <JumpLink
          className={chip}
          onClick={() => onJumpRun(r.runId!)}
          title={r.runId}
        >
          {shortId(r.runId)}
        </JumpLink>
      ),
    });
  if (r.proposalId)
    chips.push({
      key: "prop",
      description: `proposal ${r.proposalId}`,
      node: (
        <JumpLink
          className={chip}
          onClick={() => onJumpProposal(r.proposalId!)}
          title={r.proposalId}
        >
          {shortId(r.proposalId)}
        </JumpLink>
      ),
    });
  if (r.eventId) {
    const event = r.eventSource ? (
      <JumpLink
        className={chip}
        onClick={() => onJumpEvent(r.eventSource!, r.eventId!)}
        title={r.eventId}
      >
        {shortId(r.eventId)}
      </JumpLink>
    ) : (
      <span className={`mono ${chip}`} title={r.eventId}>
        {shortId(r.eventId)}
      </span>
    );
    chips.push({
      key: "event",
      description: `event ${r.eventId}`,
      node: event,
    });
  }
  if (r.issue)
    chips.push({
      key: "issue",
      description: `issue ${r.issue}`,
      node: (
        <JumpLink
          className={chip}
          href={`${LINEAR_ISSUE_URL}${encodeURIComponent(r.issue)}`}
          title="Open in Linear"
        >
          {r.issue}
        </JumpLink>
      ),
    });
  if (r.pr)
    chips.push({
      key: "pr",
      description: `pull request ${r.pr}`,
      node: <PrRef item={item} className={chip} />,
    });
  if (chips.length === 0) return <span className="text-(--text-faint)">-</span>;
  const visible = chips.slice(0, 3);
  const hidden = chips.slice(3);
  return (
    <div className="flex gap-1 overflow-hidden whitespace-nowrap [&>*]:shrink-0">
      {visible.map(({ key, node }) => (
        <span key={key} className="contents">
          {node}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          className={`mono ${chip} text-(--text-faint)`}
          title={hidden.map((ref) => ref.description).join(", ")}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}
