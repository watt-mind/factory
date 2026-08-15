import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { keyGuard, useDisplayOptions, useListKeys, useNow, useTabKeys } from "../hooks";
import { goPrefixActive } from "../goSequence";
import {
  buildSections,
  cycleColumnSort,
  flattenSections,
  grouped,
  removeCustomColumn,
  toggleCollapsed,
  visibleColumns,
  type DisplayConfig,
} from "../displayOptions";
import { DisplayOptions } from "../components/DisplayOptions";
import { CustomCell } from "../components/CustomCell";
import { setContextActions } from "../palette";
import type { Proposal } from "../types";
import type { OperatorContext } from "../context";
import { matchesRepo } from "../context";
import { PROPOSAL_FACETS, matchesFilterQuery, parseFilterQuery, proposalRunState } from "../filterQuery";
import { ScopeCaption } from "../components/ContextTabs";
import { SpecDiff } from "../components/SpecDiff";
import { decideRevealFilters } from "../reveal";
import {
  Ago,
  BulkActionBar,
  Button,
  Countdown,
  DECISION_HUES,
  Dialog,
  Disclosure,
  FilterInput,
  ListPane,
  DetailPane,
  JsonBlock,
  JumpLink,
  KV,
  ListEmpty,
  notify,
  PROPOSAL_STATUS_HUES,
  GroupHeaderRow,
  Section,
  StateBadge,
  Th,
  VerbError,
  copyText,
  copyLink,
  shortId,
} from "../components/ui";

const PROPOSAL_TABS = ["open", "history"] as const;
type ProposalTab = (typeof PROPOSAL_TABS)[number];

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
}

const ttlExpiry = (p: Proposal) => new Date(p.created_at).getTime() + p.ttl_seconds * 1000;

/** Grouping/ordering/columns per tab (OPS-493) — two views, two persisted keys. */
const OPEN_DISPLAY: DisplayConfig<Proposal> = {
  view: "proposals-open",
  groups: [
    {
      key: "decision",
      label: "Decision",
      get: (p) => p.decision,
      order: ["run", "human_needed", "noop"],
      hue: DECISION_HUES,
    },
    { key: "agent", label: "Agent", get: (p) => p.agent ?? "" },
  ],
  subGroups: ["agent", "decision"],
  sorts: [
    { key: "agent", label: "Agent", get: (p) => p.agent ?? "", column: "agent" },
    { key: "decision", label: "Decision", get: (p) => p.decision, column: "decision" },
    { key: "ttl", label: "Time left", get: ttlExpiry, column: "ttl" },
    {
      key: "origin",
      label: "Origin",
      get: (p) => `${p.eventSource ?? ""}:${p.eventId ?? ""}`,
      column: "origin",
    },
    { key: "created", label: "Created", get: (p) => p.created_at, defaultDir: "desc", column: "created" },
    { key: "reason", label: "Reason", get: (p) => p.reason ?? "", column: "reason" },
  ],
  columns: [
    { key: "agent", label: "Agent", always: true },
    { key: "decision", label: "Decision" },
    { key: "ttl", label: "TTL" },
    { key: "origin", label: "Origin" },
    { key: "created", label: "Created" },
    { key: "reason", label: "Reason" },
  ],
};

const HISTORY_DISPLAY: DisplayConfig<Proposal> = {
  view: "proposals-history",
  groups: [
    {
      key: "status",
      label: "Status",
      get: (p) => p.status,
      order: ["approved", "rejected", "superseded", "resolved"],
      hue: PROPOSAL_STATUS_HUES,
    },
    { key: "agent", label: "Agent", get: (p) => p.agent ?? "" },
  ],
  subGroups: ["agent", "status"],
  sorts: [
    { key: "agent", label: "Agent", get: (p) => p.agent ?? "", column: "agent" },
    { key: "status", label: "Status", get: (p) => p.status, column: "status" },
    { key: "decided", label: "Decided", get: (p) => p.decided_at ?? "", defaultDir: "desc", column: "decided" },
    {
      key: "origin",
      label: "Origin",
      get: (p) => `${p.eventSource ?? ""}:${p.eventId ?? ""}`,
      column: "origin",
    },
    { key: "created", label: "Created", get: (p) => p.created_at, defaultDir: "desc", column: "created" },
    { key: "reason", label: "Reason", get: (p) => p.reason ?? "", column: "reason" },
  ],
  columns: [
    { key: "agent", label: "Agent", always: true },
    { key: "status", label: "Status" },
    { key: "decided", label: "Decided" },
    { key: "origin", label: "Origin" },
    { key: "created", label: "Created" },
    { key: "reason", label: "Reason" },
  ],
};

/**
 * Proposals (webui spec §4.2) — the watched-approval centerpiece. The full
 * immutable RunSpec is always rendered (§12: the operator approves a spec,
 * not a summary), and a TTL-expired approval that re-plans STOPS and shows
 * the diff — never auto-approves the replacement. The History tab (doc
 * §10.2) is the read-only decision audit off GET /proposals?status=all.
 */
export function Proposals({
  connected,
  context,
  onRunQueued,
  focusProposalId,
  onSelectProposal,
  focusExpired,
  onFocusExpiredConsumed,
  onJumpAgent,
  onJumpEvent,
  rejumpEpoch,
}: {
  connected: boolean;
  context: OperatorContext;
  onRunQueued: (runId: string) => void;
  focusProposalId: string | null;
  onSelectProposal: (id: string | null) => void;
  focusExpired: boolean;
  onFocusExpiredConsumed: () => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ProposalTab>("open");
  const query = useQuery({
    queryKey: ["proposals"],
    queryFn: () => api.proposals(),
    refetchInterval: 2000,
  });
  const history = useQuery({
    queryKey: ["proposals", "history"],
    queryFn: () => api.proposalHistory("all"),
    refetchInterval: 2000,
  });
  const rows = useMemo(
    () =>
      tab === "open"
        ? (query.data?.proposals ?? [])
        : (history.data?.proposals ?? []).filter((p) => p.status !== "open"),
    [tab, query.data, history.data],
  );
  const scoped = useMemo(
    () => rows.filter((p) => p.id === focusProposalId || matchesRepo(p.repos, context)),
    [rows, context, focusProposalId],
  );

  // Origin event type, resolved from the shared events cache (cheap: same
  // query key as the Events view's "all" tab).
  const eventsQuery = useQuery({
    queryKey: ["events", "all"],
    queryFn: () => api.events(),
    refetchInterval: 2000,
  });
  const eventTypes = useMemo(
    () => new Map((eventsQuery.data?.events ?? []).map((e) => [`${e.source}:${e.eventId}`, e.type])),
    [eventsQuery.data],
  );
  const originType = (p: Proposal) =>
    p.eventId ? eventTypes.get(`${p.eventSource}:${p.eventId}`) : undefined;

  // An open proposal's run should still be PROPOSED; anything else means it
  // was raced (e.g. cancelled from the Runs view) and can never be approved.
  const runsQuery = useQuery({ queryKey: ["runs", "ALL"], queryFn: () => api.runs(), refetchInterval: 2000 });
  const runStates = useMemo(
    () => new Map((runsQuery.data?.runs ?? []).map((r) => [r.runId, r.state])),
    [runsQuery.data],
  );
  // Shared with the `is:stale` facet, so the chip and the red row wash can never
  // disagree about which open proposals are already dead.
  const staleState = (p: Proposal) => proposalRunState(p, runStates);

  const CANNED_REJECTION_REASONS = [
    "Scope too wide",
    "Wrong target branch",
    "Needs dry-run parameter",
    "Token limit excessive",
  ] as const;

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    refetchInterval: 5000,
  });

  const [filter, setFilter] = useState("");
  const [expiredOnly, setExpiredOnly] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [reason, setReason] = useState("");
  const [replan, setReplan] = useState<{ before: Proposal; after: Proposal } | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejecting, setBulkRejecting] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  const bulkReasonRef = useRef<HTMLInputElement>(null);

  const statusQ = useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 2000 });
  // The expired chip only exists on Open; History rows have no live TTL. Derive
  // the gate once so the row filter and the empty copy can never disagree.
  const expiredFilter = expiredOnly && tab === "open";
  const expiredCount =
    context.kind === "repo"
      ? scoped.filter((p) => p.expired).length
      : (statusQ.data?.proposals.expired ?? 0);
  const parsed = useMemo(() => parseFilterQuery(filter, PROPOSAL_FACETS), [filter]);
  const visible = useMemo(() => {
    return scoped.filter((p) => {
      if (expiredFilter && !p.expired) return false;
      return matchesFilterQuery(p, parsed, PROPOSAL_FACETS, { runStates });
    });
  }, [scoped, parsed, expiredFilter, runStates]);

  const actionableVisible = useMemo(
    () => (tab === "open" ? visible.filter((p) => p.status === "open") : []),
    [tab, visible],
  );
  const allActionableSelected =
    actionableVisible.length > 0 && actionableVisible.every((p) => selectedIds.has(p.id));
  const someActionableSelected =
    actionableVisible.some((p) => selectedIds.has(p.id)) && !allActionableSelected;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someActionableSelected;
    }
  }, [someActionableSelected]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allActionableSelected) {
        actionableVisible.forEach((p) => next.delete(p.id));
      } else {
        actionableVisible.forEach((p) => next.add(p.id));
      }
      return next;
    });
  };

  const selectedRows = useMemo(
    () => rows.filter((p) => selectedIds.has(p.id)),
    [rows, selectedIds],
  );
  const approvableSelected = useMemo(
    () => selectedRows.filter((p) => p.status === "open" && p.decision === "run" && !staleState(p)),
    [selectedRows, runStates],
  );
  const rejectableSelected = useMemo(
    () => selectedRows.filter((p) => p.status === "open"),
    [selectedRows],
  );

  const handleBulkApprove = async () => {
    if (!connected || !approvableSelected.length) return;
    setBulkConfirmOpen(false);
    setBulkApproving(true);
    let ok = 0;
    let err = 0;
    const processed = new Set<string>();
    let haltedOnReplan: { before: Proposal; after: Proposal } | null = null;
    for (const p of approvableSelected) {
      try {
        const o = await api.approve(p.id);
        processed.add(p.id);
        if (o.approved && o.runId) {
          ok++;
          onRunQueued(o.runId);
        } else if (o.replanned && o.proposal) {
          haltedOnReplan = { before: p, after: o.proposal };
          break;
        }
      } catch {
        err++;
        processed.add(p.id);
      }
    }
    invalidate();
    setBulkApproving(false);
    if (haltedOnReplan) {
      setReplan(haltedOnReplan);
      onSelectProposal(haltedOnReplan.after.id);
      notify(`Proposal expired — re-planned new spec`, "info");
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of processed) next.delete(id);
        return next;
      });
    } else {
      setSelectedIds(new Set());
    }
    if (ok) notify(`Approved ${ok} proposal${ok === 1 ? "" : "s"}`, "ok");
    if (err) notify(`Failed to approve ${err} proposal${err === 1 ? "" : "s"}`, "err");
  };

  const handleBulkReject = async () => {
    const why = bulkReason.trim();
    if (!rejectableSelected.length || !why) return;
    setBulkRejecting(true);
    let ok = 0;
    let err = 0;
    for (const p of rejectableSelected) {
      try {
        await api.reject(p.id, why);
        ok++;
      } catch {
        err++;
      }
    }
    invalidate();
    setSelectedIds(new Set());
    setBulkRejecting(false);
    setBulkRejectOpen(false);
    setBulkReason("");
    if (ok) notify(`Rejected ${ok} proposal${ok === 1 ? "" : "s"}`, "info");
    if (err) notify(`Failed to reject ${err} proposal${err === 1 ? "" : "s"}`, "err");
  };

  // What the list would show without the text filter. An empty list under the
  // expired chip has two causes and needs two messages: no expired opens exist
  // (chip copy, nothing for Esc to clear) or the text filter hid the expired
  // ones (filter copy + the Esc hint).
  const unfilteredCount = useMemo(
    () => (expiredFilter ? scoped.filter((p) => p.expired).length : scoped.length),
    [scoped, expiredFilter],
  );

  // Esc clears the text filter and the expired chip together, so the hint is
  // owed whenever either is set — including when the unfiltered set is itself
  // empty, where `filtered` is false so the copy can stay specific ("No expired
  // open proposals."). ListEmpty renders its own hint from `filtered` and its
  // `action` slot in exactly the complementary case, so this lands in the same
  // cell — never doubled — and stays quiet while loading or the API is down.
  const escClearsFilter = filter.trim() !== "" || expiredFilter;

  // Display options (OPS-493): partition into sections, order inside them,
  // and feed keyboard navigation only the rows of open sections.
  const displayConfig = tab === "open" ? OPEN_DISPLAY : HISTORY_DISPLAY;
  const [display, setDisplay] = useDisplayOptions(displayConfig);
  const sections = useMemo(
    () => buildSections(visible, displayConfig, display),
    [visible, displayConfig, display],
  );
  const flat = useMemo(
    () => flattenSections(sections, display.collapsed),
    [sections, display.collapsed],
  );
  const cols = visibleColumns(displayConfig, display);
  const show = useMemo(() => new Set(cols.map((c) => c.key)), [cols]);

  const selectedId = focusProposalId;
  // Keyboard index walks the open sections; the detail pane keys off the row
  // itself so collapsing the group under a selection never closes the pane.
  const selectedIndex = useMemo(() => flat.findIndex((p) => p.id === selectedId), [flat, selectedId]);
  const sel = useMemo(
    () => (selectedId ? (visible.find((p) => p.id === selectedId) ?? null) : null),
    [visible, selectedId],
  );

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Reveal a hash-selected proposal only when current filters hide it. Latch
  // until the row exists in `rows` (tab switch / re-plan / poll); decide once
  // so a later 2s poll does not wipe a typed filter. Click on a visible row
  // (including under the expired chip) keeps the filters.
  const pendingReveal = useRef<{
    key: string;
    snapshot: { filter: string; expiredOnly: boolean };
  } | null>(null);
  const lastKey = useRef<string | null>(null);
  const lastRejump = useRef<number | undefined>(rejumpEpoch);
  useEffect(() => {
    const isNewKey = focusProposalId !== lastKey.current;
    const isRejump = rejumpEpoch !== lastRejump.current;
    lastKey.current = focusProposalId;
    lastRejump.current = rejumpEpoch;

    if (focusProposalId && (isNewKey || isRejump)) {
      pendingReveal.current = {
        key: focusProposalId,
        snapshot: { filter, expiredOnly },
      };
    }
    const latch = pendingReveal.current;
    if (!latch || latch.key !== focusProposalId) return;
    if (!rows.some((p) => p.id === latch.key)) return; // tab switch / poll still pending
    pendingReveal.current = null; // decided once
    const isVisible = visible.some((p) => p.id === latch.key);
    const currentFilters = { filter, expiredOnly };
    const emptyFilters = { filter: "", expiredOnly: false };
    const decision = decideRevealFilters(latch.snapshot, currentFilters, emptyFilters, isVisible);
    if (decision.cleared) {
      if (decision.clearedFields.includes("filter")) setFilter(decision.next.filter);
      if (decision.clearedFields.includes("expiredOnly")) setExpiredOnly(decision.next.expiredOnly);
    }
  }, [focusProposalId, rejumpEpoch, rows, visible, filter, expiredOnly]);

  // Deep link: open tab first, then history if the id is a decided proposal.
  // Hash stays; we only switch tabs so the row is in `visible` — the selection
  // is the whole point of the deep link, so unlike selectTab we keep it. The
  // chip is cleared like selectTab does: it belongs to Open only.
  useEffect(() => {
    if (!focusProposalId) return;
    if (query.isPending || history.isPending) return;
    const inOpen = (query.data?.proposals ?? []).some((p) => p.id === focusProposalId);
    const inHistory = (history.data?.proposals ?? []).some(
      (p) => p.id === focusProposalId && p.status !== "open",
    );
    if (inOpen && tab !== "open") {
      setTab("open");
      setSelectedIds(new Set());
    } else if (!inOpen && inHistory && tab === "open") {
      setTab("history");
      setExpiredOnly(false);
      setSelectedIds(new Set());
    }
  }, [focusProposalId, query.isPending, history.isPending, query.data, history.data, tab]);

  useEffect(() => {
    if (!focusExpired) return;
    setTab("open");
    setExpiredOnly(true);
    setFilter("");
    setSelectedIds(new Set());
    onFocusExpiredConsumed();
  }, [focusExpired, onFocusExpiredConsumed]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["proposals"] });
    queryClient.invalidateQueries({ queryKey: ["status"] });
    queryClient.invalidateQueries({ queryKey: ["runs"] });
  };

  const approve = useMutation({
    mutationFn: (p: Proposal) => api.approve(p.id).then((outcome) => ({ p, outcome })),
    onSuccess: ({ p, outcome }) => {
      invalidate();
      if (outcome.approved && outcome.runId) {
        notify(`Approved proposal — queued ${outcome.runId}`, "ok");
        onRunQueued(outcome.runId);
      } else if (outcome.replanned && outcome.proposal) {
        notify(`Proposal expired — re-planned new spec`, "info");
        // §12: expired proposal re-planned to a different spec — stop and show it.
        setReplan({ before: p, after: outcome.proposal });
        onSelectProposal(outcome.proposal.id);
      }
    },
    onError: invalidate, // 404/409 mean someone else acted — converge on truth
  });

  const reject = useMutation({
    mutationFn: ({ id, why }: { id: string; why: string }) => {
      const trimmed = why.trim();
      if (!trimmed) return Promise.reject(new Error("Rejection reason required"));
      return api.reject(id, trimmed);
    },
    onSuccess: (_, { id }) => {
      invalidate();
      notify(`Rejected proposal ${id}`, "info");
      setRejecting(false);
      setReason("");
    },
    onError: invalidate,
  });

  // History rows are audit records — no verbs, ever (doc §10.2).
  const isOpen = sel !== null && sel.status === "open";
  const canApprove = isOpen && sel.decision === "run" && !staleState(sel);
  const openReject = () => {
    setRejecting(true);
    setTimeout(() => reasonRef.current?.focus(), 0);
  };

  const pendingC = useRef<number>(0);

  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectProposal(flat[i]?.id ?? null),
    onClose: () => {
      if (sel) onSelectProposal(null);
      else if (filter || expiredOnly) {
        if (filter) setFilter("");
        if (expiredOnly) setExpiredOnly(false);
      } else if (selectedId) {
        onSelectProposal(null);
      }
    },
    keys: {
      // §5: `a` opens the confirm with the spec in view — it never fires the verb directly.
      a: () => canApprove && connected && setConfirmApprove(true),
      x: () => isOpen && connected && openReject(),
      c: () => {
        if (!sel) return;
        copyText(sel.id, "proposal id");
        pendingC.current = Date.now();
      },
      l: () => {
        if (sel && pendingC.current > 0 && Date.now() - pendingC.current < 800) {
          copyLink();
          pendingC.current = 0;
        }
      },
    },
  });

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      const copy = [
        { label: `Copy ${sel.id}`, hint: "c", run: () => copyText(sel.id, "proposal id") },
        { label: "Copy link to this proposal", hint: "c l", run: copyLink },
      ];
      if (!connected || !isOpen) {
        setContextActions(copy);
      } else {
        setContextActions([
          ...(canApprove
            ? [{ label: `Approve ${sel.agent ?? sel.id}…`, hint: "a", run: () => setConfirmApprove(true) }]
            : []),
          { label: `Reject ${sel.agent ?? sel.id}…`, hint: "x", run: openReject },
          ...copy,
        ]);
      }
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, canApprove, isOpen, connected]);

  const selectTab = (t: ProposalTab) => {
    setTab(t);
    setExpiredOnly(false);
    onSelectProposal(null);
    setSelectedIds(new Set());
  };
  useTabKeys(PROPOSAL_TABS, tab, selectTab);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (isTypingTarget(e.target)) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= PROPOSAL_TABS.length) {
        e.preventDefault();
        selectTab(PROPOSAL_TABS[num - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Proposals</h1>
        {context.kind === "inflight" && <ScopeCaption context={context} surface="fleet" />}
        {context.kind === "repo" && (
          <p className="mb-3 text-[11px] text-(--text-faint)">
            {`Showing proposals that name ${context.name}.`}
          </p>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="tablist" aria-label="Proposal status">
            {PROPOSAL_TABS.map((t, idx) => {
              const count = t === "open"
                ? (context.kind === "repo" ? (query.data?.proposals ?? []).filter((p) => matchesRepo(p.repos, context)).length : (statusQ.data?.proposals.open ?? 0))
                : (history.data?.proposals ?? []).filter((p) => p.status !== "open" && matchesRepo(p.repos, context)).length;
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => selectTab(t)}
                  title={t}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"}`}
                >
                  {t === "open" ? "Open" : "History"}
                  {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
                  <span aria-hidden="true" className="mono ml-1 text-(--text-faint) text-[10px] opacity-70">
                    {idx + 1}
                  </span>
                </button>
              );
            })}
          </div>
          {tab === "open" && expiredCount > 0 && (
            <button
              type="button"
              aria-pressed={expiredOnly}
              onClick={() => setExpiredOnly((v) => !v)}
              title="Filter to expired open proposals"
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                expiredOnly
                  ? "bg-(--surface-3) text-(--text)"
                  : "text-(--text-faint) hover:bg-(--surface-1)"
              }`}
            >
              Expired
              <span className="ml-1.5 tabular-nums text-(--text-faint)">
                {expiredCount}
              </span>
            </button>
          )}
          <span className="ml-auto">
            <DisplayOptions
              config={displayConfig}
              state={display}
              onChange={setDisplay}
              rows={scoped}
            />
          </span>
          {/* Last in the row: the token chips are a full-width item, so anything
              after the filter box would be pushed onto a third line the moment
              a chip appears. */}
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="agent:… is:stale is:expired"
            label="Filter proposals"
            query={parsed}
          />
        </div>
          </>
        }
      >

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {tab === "open" && (
                <th className="sticky top-0 z-10 h-7 w-8 bg-(--surface-0) px-3 shadow-[inset_0_-1px_0_var(--border)]">
                  <input
                    type="checkbox"
                    aria-label="Select all proposals"
                    ref={headerCheckboxRef}
                    checked={allActionableSelected}
                    disabled={actionableVisible.length === 0}
                    onChange={toggleSelectAll}
                    className="cursor-pointer"
                  />
                </th>
              )}
              {cols.map((c) => {
                const sort = displayConfig.sorts.find((s) => s.column === c.key);
                const isCustom = c.isCustom || c.key.startsWith("custom:");
                const customPath = c.key.replace(/^custom:/, "");
                const isCurrentSort = isCustom ? display.sortBy === c.key : (sort && display.sortBy === sort.key);
                return (
                  <Th
                    key={c.key}
                    label={c.label}
                    dir={isCurrentSort ? display.sortDir : null}
                    naturalDir={sort?.defaultDir ?? "asc"}
                    onSort={sort || isCustom ? () => setDisplay((s) => cycleColumnSort(displayConfig, s, c.key)) : undefined}
                    onRemove={isCustom ? () => setDisplay((s) => removeCustomColumn(s, customPath)) : undefined}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const totalColSpan = cols.length + (tab === "open" ? 1 : 0);
              const tdCls = "border-b border-(--border) px-3 py-1.5";
              const renderRow = (p: Proposal) => (
                <tr
                  key={p.id}
                  onClick={() => onSelectProposal(p.id)}
                  aria-selected={p.id === selectedId}
                  className={`cursor-pointer hover:bg-(--surface-1) ${staleState(p) ? "row-wash-err" : p.expired ? "row-wash-warn" : ""} ${p.id === selectedId ? "row-selected" : ""}`}
                >
                  {tab === "open" && (
                    <td className={`${tdCls} w-8`} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select proposal ${p.id}`}
                        checked={selectedIds.has(p.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleSelect(p.id);
                        }}
                        className="cursor-pointer"
                      />
                    </td>
                  )}
                  <td className={`${tdCls} max-w-32 truncate`}>
                    {p.agent ? (
                      <JumpLink
                        onClick={() => onJumpAgent(p.agent!)}
                        title={`What is ${p.agent}? Open in Agents`}
                      >
                        {p.agent}
                      </JumpLink>
                    ) : (
                      <span className="text-(--text-faint)" title="no agent: proposal rejected at planning">
                        —
                      </span>
                    )}
                  </td>
                  {show.has("decision") && (
                    <td className={`${tdCls} max-w-28 truncate`}>
                      <StateBadge state={p.decision} hues={DECISION_HUES} />
                      {staleState(p) && (
                        <span className="ml-2" style={{ color: "var(--hue-err)" }}>
                          run {staleState(p)}
                        </span>
                      )}
                    </td>
                  )}
                  {show.has("ttl") && (
                    <td className={`${tdCls} max-w-20 whitespace-nowrap`}>
                      <Countdown createdAt={p.created_at} ttlSeconds={p.ttl_seconds} />
                    </td>
                  )}
                  {show.has("status") && (
                    <td className={`${tdCls} max-w-28 truncate`}>
                      <StateBadge state={p.status} hues={PROPOSAL_STATUS_HUES} />
                    </td>
                  )}
                  {show.has("decided") && (
                    <td
                      className={`max-w-36 truncate ${tdCls} text-(--text-faint)`}
                      title={
                        p.decided_at
                          ? `${new Date(p.decided_at).toLocaleString()}${p.decided_by ? ` · ${p.decided_by}` : ""}`
                          : undefined
                      }
                    >
                      {p.decided_at ? (
                        <>
                          <Ago iso={p.decided_at} now={now} />
                          {p.decided_by && <span className="text-(--text-faint)"> · {p.decided_by}</span>}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                  )}
                  {show.has("origin") && (
                    <td className={`mono max-w-32 truncate ${tdCls} text-(--text-faint)`} title={p.eventId ?? undefined}>
                      {p.eventId && p.eventSource ? (
                        <JumpLink
                          onClick={() => onJumpEvent(p.eventSource!, p.eventId!)}
                          title={`Open origin event ${p.eventId}`}
                        >
                          {shortId(p.eventId)}
                        </JumpLink>
                      ) : (
                        (p.eventId ? shortId(p.eventId) : "-")
                      )}
                    </td>
                  )}
                  {show.has("created") && (
                    <td className={`max-w-24 whitespace-nowrap ${tdCls} text-(--text-faint)`}>
                      <Ago iso={p.created_at} now={now} />
                    </td>
                  )}
                  {show.has("reason") && (
                    <td className={`max-w-48 truncate ${tdCls} text-(--text-dim)`} title={p.reason ?? undefined}>
                      {p.reason ?? "-"}
                    </td>
                  )}
                  {cols.filter((c) => c.isCustom || c.key.startsWith("custom:")).map((c) => (
                    <CustomCell key={c.key} row={p} path={c.key.replace(/^custom:/, "")} />
                  ))}
                </tr>
              );
              if (!grouped(display)) return sections[0]?.rows.map(renderRow);
              return sections.map((s) => {
                const closed = display.collapsed.includes(s.key);
                return (
                  <Fragment key={s.key}>
                    <GroupHeaderRow
                      colSpan={totalColSpan}
                      section={s}
                      collapsed={closed}
                      onToggle={() => setDisplay((st) => toggleCollapsed(st, s.key))}
                    />
                    {!closed &&
                      (s.subsections
                        ? s.subsections.map((child) => {
                            const childClosed = display.collapsed.includes(child.key);
                            return (
                              <Fragment key={child.key}>
                                <GroupHeaderRow
                                  colSpan={totalColSpan}
                                  section={child}
                                  collapsed={childClosed}
                                  onToggle={() => setDisplay((st) => toggleCollapsed(st, child.key))}
                                  sub
                                />
                                {!childClosed && child.rows.map(renderRow)}
                              </Fragment>
                            );
                          })
                        : s.rows.map(renderRow))}
                  </Fragment>
                );
              });
            })()}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={cols.length + (tab === "open" ? 1 : 0)}
                query={tab === "open" ? query : history}
                filtered={unfilteredCount > 0}
                onClear={
                  escClearsFilter
                    ? () => {
                        setFilter("");
                        setExpiredOnly(false);
                      }
                    : undefined
                }
                noun="proposals"
                empty={
                  expiredFilter
                    ? "No expired open proposals."
                    : context.kind === "repo"
                      ? `No proposals naming ${context.name}.`
                      : tab === "open"
                        ? "No open proposals — the operator's work is done, for now."
                        : "No decided proposals yet."
                }
                escHint={escClearsFilter}
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[460px]"
          title={
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal">
              <button
                type="button"
                onClick={() => onSelectProposal(null)}
                className="cursor-pointer text-(--text-dim) hover:text-(--accent)"
                title="Back to proposals list"
              >
                Proposals
              </button>
              <span className="text-(--text-faint)" aria-hidden="true">
                /
              </span>
              <span className="flex min-w-0 items-center gap-2 truncate font-semibold text-(--text)" aria-current="page">
                <StateBadge
                  state={sel.status === "open" ? sel.decision : sel.status}
                  hues={sel.status === "open" ? DECISION_HUES : PROPOSAL_STATUS_HUES}
                />
                <span className="truncate mono" title={sel.id}>
                  {shortId(sel.id)}
                </span>
              </span>
            </nav>
          }
          actions={
            isOpen ? (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="danger"
                  disabled={!connected || reject.isPending}
                  onClick={openReject}
                >
                  Reject… <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">x</span>
                </Button>
                {canApprove && (
                  <Button
                    variant="primary"
                    disabled={!connected || approve.isPending}
                    onClick={() => setConfirmApprove(true)}
                  >
                    Approve… <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">a</span>
                  </Button>
                )}
              </div>
            ) : null
          }
          utility={
            <>
              <span>copy:</span>
              <button
                type="button"
                onClick={() => copyText(sel.id, "proposal id")}
                className="cursor-pointer hover:text-(--text)"
              >
                id <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c</span>
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={copyLink}
                className="cursor-pointer hover:text-(--text)"
              >
                link <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c l</span>
              </button>
            </>
          }
          close={<Button onClick={() => onSelectProposal(null)}>Close</Button>}
        >

          <Section title="Proposal">
            <KV k="id" v={sel.id} />
            {sel.agent && (
              <KV
                k="agent"
                v={
                  <JumpLink onClick={() => onJumpAgent(sel.agent!)} title={`What is ${sel.agent}? Open in Agents`}>
                    {sel.agent}
                  </JumpLink>
                }
              />
            )}
            <KV k="decision" v={<StateBadge state={sel.decision} hues={DECISION_HUES} />} />
            <KV k="status" v={<StateBadge state={sel.status} hues={PROPOSAL_STATUS_HUES} />} />
            <KV
              k="run"
              v={
                sel.runId ? (
                  <JumpLink onClick={() => onRunQueued(sel.runId!)} title={`Open run ${sel.runId}`}>
                    {shortId(sel.runId)}
                  </JumpLink>
                ) : null
              }
            />
            {isOpen && (
              <KV
                k="ttl"
                v={<Countdown createdAt={sel.created_at} ttlSeconds={sel.ttl_seconds} />}
              />
            )}
            <KV k="created" v={<Ago iso={sel.created_at} now={now} />} />
            {sel.decided_at && <KV k="decided at" v={<Ago iso={sel.decided_at} now={now} />} />}
            {sel.decided_by && <KV k="decided by" v={sel.decided_by} />}
            {sel.reason && (
              <KV
                k="planner reason"
                v={
                  <span className="break-words whitespace-pre-wrap leading-relaxed text-(--text-dim)">
                    {sel.reason}
                  </span>
                }
              />
            )}
          </Section>

          {sel.eventId && (
            <Section title="Origin event">
              <KV
                k="eventId"
                v={
                  sel.eventSource ? (
                    <JumpLink onClick={() => onJumpEvent(sel.eventSource!, sel.eventId!)} title={`Open origin event ${sel.eventId}`}>
                      {shortId(sel.eventId)}
                    </JumpLink>
                  ) : (
                    <span title={sel.eventId}>{shortId(sel.eventId)}</span>
                  )
                }
              />
              <KV k="source" v={sel.eventSource} />
              {originType(sel) && <KV k="type" v={originType(sel)} />}
            </Section>
          )}

          {sel.spec && (() => {
            const ag = (agentsQuery.data?.agents ?? []).find((a) => a.id === sel.agent || a.ref === sel.agent || a.id === sel.spec?.agent);
            const inp = (typeof sel.spec.input === "object" && sel.spec.input ? sel.spec.input : {}) as Record<string, unknown>;
            const repo = sel.repos.length ? sel.repos.join(", ") : String(inp.repo || inp.repository || "unscoped");
            const branch = String(inp.branch || inp.targetBranch || inp.base || "default");
            const issue = String(inp.issueId || inp.issue || inp.ticket || sel.eventId || "—");
            const host = sel.spec.placement ? Object.entries(sel.spec.placement).map(([k, v]) => `${k}=${v}`).join(", ") : (ag?.hosts?.length ? ag.hosts.join(", ") : "any worker");
            const mut = ag ? ag.mutating : (sel.spec.capabilities?.some((c) => /write|mutate|exec/i.test(c)) ?? false);
            const egress = ag?.capabilities?.services ?? sel.spec.capabilities?.filter((c) => /net|http|api/i.test(c)) ?? [];
            const caps = sel.spec.capabilities ?? [];
            const score = (mut ? 2 : 0) + (["main", "master", "develop"].includes(branch.toLowerCase()) ? 1 : 0) + (egress.length ? 1 : 0) + (sel.spec.timeoutSeconds > 300 ? 1 : 0);
            const blast = score >= 3 ? "HIGH" : score >= 1 ? "MEDIUM" : "LOW";
            const blastHue = blast === "HIGH" ? "var(--hue-err)" : blast === "MEDIUM" ? "var(--hue-warn)" : "var(--hue-ok)";
            const prev = (runsQuery.data?.runs ?? []).find((r) => r.agent === sel.agent && r.state === "COMPLETED");

            return (
              <Section title="Summary Safety Card & Blast Radius Radar" card={false}>
                <div className="mb-3 rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px]">
                  <div className="mb-2 flex items-center justify-between border-b border-(--border) pb-2">
                    <div className="flex gap-2">
                      <span className="rounded px-2 py-0.5 text-[11px] font-semibold uppercase" style={{ color: mut ? "var(--hue-err)" : "var(--hue-ok)", background: `color-mix(in oklch, ${mut ? "var(--hue-err)" : "var(--hue-ok)"} 12%, transparent)` }}>
                        {mut ? "Mutating" : "Read-Only"}
                      </span>
                      <span className="rounded px-2 py-0.5 text-[11px] font-semibold uppercase" style={{ color: blastHue, background: `color-mix(in oklch, ${blastHue} 12%, transparent)` }}>
                        Radar: {blast} Risk
                      </span>
                    </div>
                    <span className="mono text-[11px] text-(--text-faint)">{sel.spec.adapter}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><div className="text-[11px] uppercase text-(--text-faint)">Target Repo</div><div className="mono truncate text-(--text-dim)" title={repo}>{repo}</div></div>
                    <div><div className="text-[11px] uppercase text-(--text-faint)">Target Branch</div><div className="mono truncate text-(--text-dim)" title={branch}>{branch}</div></div>
                    <div><div className="text-[11px] uppercase text-(--text-faint)">Issue ID</div><div className="mono truncate text-(--text-dim)" title={issue}>{issue}</div></div>
                    <div><div className="text-[11px] uppercase text-(--text-faint)">Host</div><div className="mono truncate text-(--text-dim)" title={host}>{host}</div></div>
                    <div><div className="text-[11px] uppercase text-(--text-faint)">Budget</div><div className="mono text-(--text-dim)">{sel.spec.timeoutSeconds}s · max {sel.spec.maxAttempts} att</div></div>
                    <div><div className="text-[11px] uppercase text-(--text-faint)">Egress</div><div className="mono truncate text-(--text-dim)">{egress.length ? egress.join(", ") : "none"}</div></div>
                    <div className="col-span-2">
                      <div className="text-[11px] uppercase text-(--text-faint)">Capabilities</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {caps.length ? caps.map((c) => <span key={c} className="rounded bg-(--surface-2) px-1.5 py-0.5 mono text-[11.5px] text-(--text-dim)">{c}</span>) : <span className="text-[11px] text-(--text-faint)">none (sandboxed)</span>}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-(--border) pt-2 text-[11px]">
                    <div className="uppercase text-(--text-faint) mb-0.5">Historical Comparison</div>
                    {prev ? (
                      <div className="flex justify-between text-(--text-dim)">
                        <span>Prior: <JumpLink onClick={() => onRunQueued(prev.runId)}>{prev.runId}</JumpLink> (<Ago iso={prev.updated_at} now={now} />)</span>
                        <span className="mono text-(--text-faint)">{prev.attempts} att</span>
                      </div>
                    ) : <div className="text-(--text-faint)">No prior run for {sel.agent}.</div>}
                  </div>
                </div>
                <Disclosure label="immutable RunSpec" defaultOpen={isOpen}>
                  <JsonBlock value={sel.spec} />
                </Disclosure>
              </Section>
            );
          })()}

          {isOpen && staleState(sel) && (
            <div
              className="mb-3 rounded-md px-2.5 py-1.5 text-[12px]"
              style={{
                color: "var(--hue-err)",
                background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
              }}
            >
              This proposal&apos;s run is already {staleState(sel)} — it can no longer be approved.
              Reject it to clear the queue.
            </div>
          )}

          {isOpen && rejecting && (
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-(--border) bg-(--surface-0) p-2.5">
              <div className="text-[11px] font-medium text-(--text-faint)">Canned Rejection Templates:</div>
              <div className="flex flex-wrap gap-1.5">
                {CANNED_REJECTION_REASONS.map((tmpl) => (
                  <button
                    key={tmpl}
                    type="button"
                    onClick={() => {
                      setReason(tmpl);
                      reasonRef.current?.focus();
                    }}
                    className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                      reason === tmpl
                        ? "border-(--accent) bg-(--surface-3) text-(--text)"
                        : "border-(--border) bg-(--surface-1) text-(--text-dim) hover:bg-(--surface-2)"
                    }`}
                  >
                    {tmpl}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 mt-1">
                <input
                  ref={reasonRef}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      (e.key === "Enter" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) &&
                      reason.trim() &&
                      !reject.isPending &&
                      connected
                    ) {
                      e.preventDefault();
                      reject.mutate({ id: sel.id, why: reason.trim() });
                    }
                    if (e.key === "Escape") setRejecting(false);
                  }}
                  placeholder="Reason (required — rejections are audit records)"
                  className="flex-1 rounded-md border border-(--border-strong) bg-(--surface-1) px-2.5 py-1 text-(--text) outline-none focus:border-(--accent)"
                />
                <Button
                  variant="danger"
                  disabled={!reason.trim() || reject.isPending || !connected}
                  onClick={() => reject.mutate({ id: sel.id, why: reason.trim() })}
                >
                  Confirm
                </Button>
                <Button onClick={() => setRejecting(false)}>Cancel</Button>
              </div>
            </div>
          )}

          <VerbError error={approve.error ?? reject.error} />
        </DetailPane>
      )}

      {confirmApprove && sel && (
        <Dialog title="Approve and queue this run?" onClose={() => setConfirmApprove(false)} wide>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            You are approving this exact immutable spec — the agent below runs with these
            capabilities the moment you confirm.
          </div>
          <div className="mb-3">
            <KV k="agent" v={sel.spec?.agent} />
            <KV k="adapter" v={sel.spec?.adapter} />
            <KV k="capabilities" v={sel.spec?.capabilities.join(", ") || "none"} />
            <KV k="timeout" v={`${sel.spec?.timeoutSeconds}s`} />
            <KV k="attempts" v={String(sel.spec?.maxAttempts)} />
            <KV k="ttl" v={<Countdown createdAt={sel.created_at} ttlSeconds={sel.ttl_seconds} />} />
          </div>
          {sel.spec && (
            <div className="mb-3 max-h-[50vh] overflow-auto">
              <JsonBlock value={sel.spec} />
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmApprove(false)}>Not yet</Button>
            <Button
              variant="primary"
              disabled={!connected || approve.isPending}
              onClick={() => {
                setConfirmApprove(false);
                approve.mutate(sel);
              }}
            >
              Approve and queue
            </Button>
          </div>
        </Dialog>
      )}

      {replan && (
        <Dialog title="Proposal expired — re-planned against current state" onClose={() => setReplan(null)} wide>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            The TTL passed, so the planner re-read authoritative state and produced a new spec. Review
            the difference; nothing runs until you approve the new proposal explicitly.
          </div>
          <SpecDiff before={replan.before.spec} after={replan.after.spec} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setReplan(null)}>Not yet</Button>
            <Button
              variant="primary"
              disabled={!connected || approve.isPending}
              onClick={() => {
                const fresh = replan.after;
                setReplan(null);
                approve.mutate(fresh);
              }}
            >
              Approve new proposal
            </Button>
          </div>
        </Dialog>
      )}

      {selectedIds.size > 0 && tab === "open" && (
        <BulkActionBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
          <Button
            variant="primary"
            disabled={!connected || bulkApproving || approvableSelected.length === 0}
            onClick={() => setBulkConfirmOpen(true)}
          >
            {bulkApproving ? "Approving…" : `Approve selected (${approvableSelected.length})`}
          </Button>
          <Button
            variant="danger"
            disabled={!connected || bulkRejecting || rejectableSelected.length === 0}
            onClick={() => {
              setBulkRejectOpen(true);
              setBulkReason("");
            }}
          >
            Reject selected ({selectedIds.size})
          </Button>
        </BulkActionBar>
      )}

      {bulkConfirmOpen && approvableSelected.length > 0 && (
        <Dialog
          title={`Approve and queue ${approvableSelected.length} run${approvableSelected.length === 1 ? "" : "s"}?`}
          onClose={() => setBulkConfirmOpen(false)}
          wide
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            You are approving {approvableSelected.length === 1 ? "this exact immutable spec" : "these exact immutable specs"}{" "}
            — each agent below runs with these capabilities the moment you confirm. Stale and non-run
            rows are skipped.
          </div>
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-auto">
            {approvableSelected.map((p) => (
              <div key={p.id} className="rounded-md border border-(--border) bg-(--surface-0) p-2.5">
                <div className="mb-2 font-medium text-[12px]">{p.agent ?? p.id}</div>
                <KV k="agent" v={p.spec?.agent} />
                <KV k="adapter" v={p.spec?.adapter} />
                <KV k="capabilities" v={p.spec?.capabilities.join(", ") || "none"} />
                <KV k="timeout" v={`${p.spec?.timeoutSeconds}s`} />
                <KV k="attempts" v={String(p.spec?.maxAttempts)} />
                <KV k="ttl" v={<Countdown createdAt={p.created_at} ttlSeconds={p.ttl_seconds} />} />
                {p.spec && <JsonBlock value={p.spec} />}
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setBulkConfirmOpen(false)}>Not yet</Button>
            <Button
              variant="primary"
              autoFocus
              disabled={!connected || bulkApproving}
              onClick={() => {
                void handleBulkApprove();
              }}
            >
              Approve and queue
            </Button>
          </div>
        </Dialog>
      )}

      {bulkRejectOpen && (
        <Dialog
          title={`Reject ${rejectableSelected.length} selected proposal${rejectableSelected.length === 1 ? "" : "s"}`}
          onClose={() => setBulkRejectOpen(false)}
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Provide a rejection reason for all {rejectableSelected.length} selected proposals:
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {CANNED_REJECTION_REASONS.map((tmpl) => (
              <button
                key={tmpl}
                type="button"
                onClick={() => {
                  setBulkReason(tmpl);
                  bulkReasonRef.current?.focus();
                }}
                className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                  bulkReason === tmpl
                    ? "border-(--accent) bg-(--surface-3) text-(--text)"
                    : "border-(--border) bg-(--surface-1) text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                {tmpl}
              </button>
            ))}
          </div>
          <input
            ref={bulkReasonRef}
            autoFocus
            value={bulkReason}
            onChange={(e) => setBulkReason(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.key === "Enter" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) &&
                bulkReason.trim() &&
                !bulkRejecting &&
                connected
              ) {
                e.preventDefault();
                handleBulkReject();
              }
            }}
            placeholder="Reason (required — rejections are audit records)"
            className="w-full rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1.5 text-[12px] text-(--text) outline-none focus:border-(--accent)"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setBulkRejectOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={!bulkReason.trim() || bulkRejecting || !connected}
              onClick={handleBulkReject}
            >
              {bulkRejecting ? "Rejecting…" : `Reject ${rejectableSelected.length} proposals`}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
