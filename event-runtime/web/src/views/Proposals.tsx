import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useListKeys, useNow, useTabKeys } from "../hooks";
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
  Section,
  StateBadge,
  VerbError,
  copyText,
  copyLink,
} from "../components/ui";

const PROPOSAL_TABS = ["open", "history"] as const;

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
  const [tab, setTab] = useState<"open" | "history">("open");
  const query = useQuery({
    queryKey: ["proposals"],
    queryFn: api.proposals,
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
    queryFn: api.agents,
    refetchInterval: 5000,
  });

  const [filter, setFilter] = useState("");
  const [expiredOnly, setExpiredOnly] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [reason, setReason] = useState("");
  const [replan, setReplan] = useState<{ before: Proposal; after: Proposal } | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
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

  const selectedId = focusProposalId;
  const selectedIndex = useMemo(() => visible.findIndex((p) => p.id === selectedId), [visible, selectedId]);
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

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
    } else if (!inOpen && inHistory && tab === "open") {
      setTab("history");
      setExpiredOnly(false);
    }
  }, [focusProposalId, query.isPending, history.isPending, query.data, history.data, tab]);

  useEffect(() => {
    if (!focusExpired) return;
    setTab("open");
    setExpiredOnly(true);
    setFilter("");
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
    mutationFn: ({ id, why }: { id: string; why?: string }) => api.reject(id, why),
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

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectProposal(visible[i]?.id ?? null),
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
      c: () => sel && copyText(sel.id, "proposal id"),
    },
  });

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      const copy = [
        { label: `Copy ${sel.id}`, hint: "c", run: () => copyText(sel.id, "proposal id") },
        { label: "Copy link to this proposal", run: copyLink },
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

  const selectTab = (t: (typeof PROPOSAL_TABS)[number]) => {
    setTab(t);
    setExpiredOnly(false);
    onSelectProposal(null);
  };
  useTabKeys(PROPOSAL_TABS, tab, selectTab);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Proposals</h1>
        {context.kind === "inflight" && <ScopeCaption context={context} surface="fleet" />}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="tablist" aria-label="Proposal status">
            {PROPOSAL_TABS.map((t) => {
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
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"}`}
                >
                  {t === "open" ? "Open" : "History"}
                  {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
                </button>
              );
            })}
          </div>
          {tab === "open" && (
            <button
              type="button"
              aria-pressed={expiredOnly}
              onClick={() => setExpiredOnly((v) => !v)}
              className={`rounded-md px-2 py-1 text-[12px] ${
                expiredOnly
                  ? "bg-(--surface-3) text-(--text)"
                  : "text-(--text-faint) hover:bg-(--surface-1)"
              }`}
            >
              expired
              {expiredCount > 0 && (
                <span className="ml-1.5 tabular-nums text-(--text-faint)">
                  {expiredCount}
                </span>
              )}
            </button>
          )}
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
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Agent</th>
              {tab === "open" ? (
                <>
                  <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Decision</th>
                  <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">TTL</th>
                </>
              ) : (
                <>
                  <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Status</th>
                  <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Decided by</th>
                  <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Decided</th>
                </>
              )}
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Origin</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Created</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p, i) => {
              const tdCls = "border-b border-(--border) px-3 py-1.5";
              return (
              <tr
                key={p.id}
                onClick={() => onSelectProposal(p.id)}
                aria-selected={i === selectedIndex}
                className={`cursor-pointer hover:bg-(--surface-1) ${staleState(p) ? "row-wash-err" : p.expired ? "row-wash-warn" : ""} ${i === selectedIndex ? "row-selected" : ""}`}
              >
                <td className={tdCls}>
                  {p.agent ? (
                    <JumpLink
                      onClick={() => onJumpAgent(p.agent!)}
                      title={`What is ${p.agent}? Open in Agents`}
                    >
                      {p.agent}
                    </JumpLink>
                  ) : (
                    "—"
                  )}
                </td>
                {tab === "open" ? (
                  <>
                    <td className={tdCls}>
                      <StateBadge state={p.decision} hues={DECISION_HUES} />
                      {staleState(p) && (
                        <span className="ml-2" style={{ color: "var(--hue-err)" }}>
                          run {staleState(p)}
                        </span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <Countdown createdAt={p.created_at} ttlSeconds={p.ttl_seconds} />
                    </td>
                  </>
                ) : (
                  <>
                    <td className={tdCls}>
                      <StateBadge state={p.status} hues={PROPOSAL_STATUS_HUES} />
                    </td>
                    <td className={`${tdCls} text-(--text-dim)`}>{p.decided_by ?? "-"}</td>
                    <td className={`${tdCls} text-(--text-faint)`}>
                      <Ago iso={p.decided_at} now={now} />
                    </td>
                  </>
                )}
                <td className={`mono max-w-40 truncate ${tdCls} text-(--text-faint)`} title={originType(p) ?? undefined}>
                  {p.eventId && p.eventSource ? (
                    <JumpLink
                      onClick={() => onJumpEvent(p.eventSource!, p.eventId!)}
                      title={originType(p) ?? "Open origin event"}
                    >
                      {p.eventId}
                    </JumpLink>
                  ) : (
                    (p.eventId ?? "-")
                  )}
                </td>
                <td className={`${tdCls} text-(--text-faint)`}>
                  <Ago iso={p.created_at} now={now} />
                </td>
                <td className={`max-w-64 truncate ${tdCls} text-(--text-dim)`}>{p.reason ?? "-"}</td>
              </tr>
            );})}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={tab === "open" ? 6 : 7}
                query={tab === "open" ? query : history}
                filtered={unfilteredCount > 0}
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
          title={<span title={sel.id}>{sel.agent ?? sel.id}</span>}
          actions={
            <>
              <Button onClick={() => copyText(sel.id, "proposal id")}>Copy id</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectProposal(null)}>Close</Button>
            </>
          }
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
                  <JumpLink onClick={() => onRunQueued(sel.runId!)} title="Open run">
                    {sel.runId}
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
            {sel.reason && <KV k="planner reason" v={sel.reason} />}
          </Section>

          {sel.eventId && (
            <Section title="Origin event">
              <KV
                k="eventId"
                v={
                  sel.eventSource ? (
                    <JumpLink onClick={() => onJumpEvent(sel.eventSource!, sel.eventId!)} title="Open origin event">
                      {sel.eventId}
                    </JumpLink>
                  ) : (
                    sel.eventId
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
              <Section title="Summary Safety Card & Blast Radius Radar">
                <div className="mb-3 rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px]">
                  <div className="mb-2 flex items-center justify-between border-b border-(--border) pb-2">
                    <div className="flex gap-2">
                      <span className="rounded px-2 py-0.5 text-[11px] font-semibold uppercase" style={{ color: mut ? "var(--hue-err)" : "var(--hue-ok)", background: `color-mix(in oklch, ${mut ? "var(--hue-err)" : "var(--hue-ok)"} 12%, transparent)` }}>
                        {mut ? "🔴 Mutating" : "🟢 Read-Only"}
                      </span>
                      <span className="rounded px-2 py-0.5 text-[11px] font-semibold uppercase" style={{ color: blastHue, background: `color-mix(in oklch, ${blastHue} 12%, transparent)` }}>
                        Radar: {blast} Risk
                      </span>
                    </div>
                    <span className="mono text-[11px] text-(--text-faint)">{sel.spec.adapter}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><div className="text-[10px] uppercase text-(--text-faint)">Target Repo</div><div className="mono truncate text-(--text-dim)" title={repo}>{repo}</div></div>
                    <div><div className="text-[10px] uppercase text-(--text-faint)">Target Branch</div><div className="mono truncate text-(--text-dim)" title={branch}>{branch}</div></div>
                    <div><div className="text-[10px] uppercase text-(--text-faint)">Issue ID</div><div className="mono truncate text-(--text-dim)" title={issue}>{issue}</div></div>
                    <div><div className="text-[10px] uppercase text-(--text-faint)">Host</div><div className="mono truncate text-(--text-dim)" title={host}>{host}</div></div>
                    <div><div className="text-[10px] uppercase text-(--text-faint)">Budget</div><div className="mono text-(--text-dim)">{sel.spec.timeoutSeconds}s · max {sel.spec.maxAttempts} att</div></div>
                    <div><div className="text-[10px] uppercase text-(--text-faint)">Egress</div><div className="mono truncate text-(--text-dim)">{egress.length ? egress.join(", ") : "none"}</div></div>
                    <div className="col-span-2">
                      <div className="text-[10px] uppercase text-(--text-faint)">Capabilities</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {caps.length ? caps.map((c) => <span key={c} className="rounded bg-(--surface-2) px-1.5 py-0.5 mono text-[10.5px] text-(--text-dim)">{c}</span>) : <span className="text-[11px] text-(--text-faint)">none (sandboxed)</span>}
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
          {isOpen && (
            <div className="flex gap-2">
              {canApprove && (
                <Button
                  variant="primary"
                  disabled={!connected || approve.isPending}
                  onClick={() => setConfirmApprove(true)}
                >
                  Approve… <span className="mono ml-1 opacity-70">a</span>
                </Button>
              )}
              <Button
                variant="danger"
                disabled={!connected || reject.isPending}
                onClick={() => reject.mutate({ id: sel.id })}
              >
                Dismiss
              </Button>
              <Button variant="danger" disabled={!connected || reject.isPending} onClick={openReject}>
                Reject… <span className="mono ml-1 opacity-70">x</span>
              </Button>
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
                    if (e.key === "Enter" && reason.trim()) reject.mutate({ id: sel.id, why: reason.trim() });
                    if (e.key === "Escape") setRejecting(false);
                  }}
                  placeholder="Reason (required — rejections are audit records)"
                  className="flex-1 rounded-md border border-(--border-strong) bg-(--surface-1) px-2.5 py-1 text-(--text) outline-none focus:border-(--accent)"
                />
                <Button
                  variant="danger"
                  disabled={!reason.trim() || reject.isPending}
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
          {sel.spec && <JsonBlock value={sel.spec} />}
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmApprove(false)}>Not yet</Button>
            <Button
              variant="primary"
              autoFocus
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
            <Button onClick={() => setReplan(null)}>Not now</Button>
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
    </div>
  );
}
