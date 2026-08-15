import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useDisplayOptions, useListKeys } from "../hooks";
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
import { DisplayOptions, exportJson } from "../components/DisplayOptions";
import { CustomCell } from "../components/CustomCell";
import type { AgentDef, AgentEventRoute } from "../types";
import type { OperatorContext } from "../context";
import {
  Button,
  DetailPane,
  Disclosure,
  FilterInput,
  GroupHeaderRow,
  JsonBlock,
  KV,
  ListEmpty,
  ListPane,
  Section,
  Th,
  copyText,
  copyLink,
} from "../components/ui";
import { ScopeCaption } from "../components/ContextTabs";
import { eventsHash } from "../hash";
import { setContextActions } from "../palette";

const caps = (a: AgentDef) =>
  [a.capabilities.filesystem, ...(a.capabilities.services ?? [])].filter(Boolean).join(", ") || "none";

/**
 * The adapters that take a model at all — the web-side mirror of
 * `MODEL_ADAPTERS` in `event-runtime/lib/registry.mjs` (WM-135). `GET /agents`
 * reports `resolvedModel: null` for two different situations, and an operator
 * reads them differently: a command/actions agent has no model *by
 * construction*, while an LLM agent that declares no tier simply pins nothing
 * and rides the CLI's own default. Collapsing both to a blank cell is exactly
 * the ambiguity this view exists to remove.
 */
const MODEL_ADAPTERS = new Set(["claude", "pi"]);

/**
 * Tier buckets, strongest first — the group order and the sort order at once,
 * so "sort by tier" and "group by tier" cannot disagree. `override` is not a
 * tier but reads as one here: it is what a definition says instead of a tier.
 */
const TIER_ORDER = ["strong", "standard", "light", "override", "-"] as const;

/** No tier, no override, nothing to say — one dash, used everywhere. */
const DASH = "-";

const uniq = (values: string[]) => [...new Set(values)];

/**
 * What this route actually runs on. `resolvedModel` is the planner's answer and
 * wins whenever it exists; null falls back to the adapter's nature rather than
 * to an empty cell.
 */
export const routeModel = (r: AgentEventRoute): string =>
  r.resolvedModel ?? (MODEL_ADAPTERS.has(r.adapter) ? "default" : "n/a");

/**
 * Row-level roll-ups. An agent is one row but can be routed by several event
 * types, each with its own adapter — so the cell is the distinct set in route
 * order, not the first value. A mixed agent reading `claude, command` is the
 * truth; picking one adapter to show would be a lie the table cannot flag.
 */
export const adapterText = (a: AgentDef): string =>
  uniq(a.eventTypes.map((r) => r.adapter)).join(", ") || DASH;

/** Declared intent. An exact-id override answers for a definition that names no tier. */
export const tierText = (a: AgentDef): string => a.modelTier ?? (a.model ? "override" : DASH);

/** Sort key for the Tier column: TIER_ORDER's position, unknowns last. */
const tierRank = (a: AgentDef): number => {
  const i = (TIER_ORDER as readonly string[]).indexOf(tierText(a));
  return i === -1 ? TIER_ORDER.length : i;
};

/**
 * Resolved model per row. Nothing routes to this agent → nothing resolves,
 * whatever it declares; the Tier column and the detail pane still carry the
 * declaration, so the fact is not lost.
 */
export const modelText = (a: AgentDef): string =>
  uniq(a.eventTypes.map(routeModel)).join(", ") || DASH;

/** Grouping/ordering/columns for the registry table (OPS-493/OPS-492). */
const AGENTS_DISPLAY: DisplayConfig<AgentDef> = {
  view: "agents",
  groups: [
    { key: "adapter", label: "Adapter", get: adapterText },
    { key: "tier", label: "Tier", get: tierText, order: TIER_ORDER },
    { key: "contract", label: "Contract", get: (a) => a.outputContract },
  ],
  subGroups: ["adapter", "tier", "contract"],
  sorts: [
    { key: "ref", label: "Ref", get: (a) => a.ref, column: "ref" },
    { key: "contract", label: "Contract", get: (a) => a.outputContract, column: "contract" },
    { key: "adapter", label: "Adapter", get: adapterText, column: "adapter" },
    { key: "tier", label: "Tier", get: tierRank, column: "tier" },
    { key: "model", label: "Model", get: modelText, column: "model" },
    { key: "mutating", label: "Mutating", get: (a) => Number(a.mutating), column: "mutating" },
    { key: "capabilities", label: "Capabilities", get: caps, column: "capabilities" },
    {
      key: "timeout",
      label: "Timeout",
      get: (a) => a.limits.timeout_seconds ?? Number.POSITIVE_INFINITY,
      column: "timeout",
    },
    {
      key: "attempts",
      label: "Attempts",
      get: (a) => a.limits.attempts ?? Number.POSITIVE_INFINITY,
      column: "attempts",
    },
  ],
  columns: [
    { key: "ref", label: "Ref", always: true },
    { key: "contract", label: "Contract" },
    { key: "adapter", label: "Adapter" },
    { key: "tier", label: "Tier" },
    { key: "model", label: "Model" },
    { key: "mutating", label: "Mutating" },
    { key: "capabilities", label: "Capabilities" },
    { key: "timeout", label: "Timeout" },
    { key: "attempts", label: "Attempts" },
  ],
};

/**
 * Events already owns `#/events?type=` (the same target Graph jumps to). A real
 * link, not a callback through App, keeps that route single-owner and makes the
 * jump behave like one: middle-click, copy link, Back.
 */
const eventsTypeHref = (type: string) => `#/${eventsHash(null, null, type)}`;

/**
 * Agents (webui doc §10.6) — the registry, fully readable. An operator
 * approving "factory-status-report@1" can read exactly what that ref means —
 * prompt, schemas, pins, routing, and (WM-211) which adapter runs it on which
 * model — without opening the repo. Read-only: the registry has no mutation
 * surface, by design.
 */
export function Agents({
  context,
  focusAgentRef,
  onSelectAgent,
}: {
  context: OperatorContext;
  focusAgentRef: string | null;
  onSelectAgent: (ref: string | null) => void;
}) {
  const query = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 2000 });
  const rows = query.data?.agents ?? [];
  const contracts = query.data?.contracts ?? {};

  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((a) =>
      [
        a.ref,
        a.id,
        a.outputContract,
        caps(a),
        // Adapter/tier/model are filterable for the same reason they are
        // columns: "which agents run on pi" is one of the questions.
        adapterText(a),
        tierText(a),
        modelText(a),
        ...a.eventTypes.map((t) => t.type),
      ].some((v) => v.toLowerCase().includes(q)),
    );
  }, [rows, filter]);

  // Display options (OPS-493): partition into sections, order inside them, and
  // feed keyboard navigation only the rows of open sections.
  const [display, setDisplay] = useDisplayOptions(AGENTS_DISPLAY);
  const sections = useMemo(() => buildSections(visible, AGENTS_DISPLAY, display), [visible, display]);
  const flat = useMemo(
    () => flattenSections(sections, display.collapsed),
    [sections, display.collapsed],
  );
  const cols = visibleColumns(AGENTS_DISPLAY, display);
  const show = useMemo(() => new Set(cols.map((c) => c.key)), [cols]);

  const selectedRef = focusAgentRef;
  // Keyboard index walks the open sections; the detail pane keys off the row
  // itself so collapsing the group under a selection never closes the pane.
  const selectedIndex = useMemo(() => flat.findIndex((a) => a.ref === selectedRef), [flat, selectedRef]);
  const sel = useMemo(
    () => (selectedRef ? (visible.find((a) => a.ref === selectedRef) ?? null) : null),
    [visible, selectedRef],
  );

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusAgentRef) setFilter("");
  }, [focusAgentRef]);

  const pendingC = useRef<number>(0);

  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectAgent(flat[i]?.ref ?? null),
    onClose: () => {
      if (selectedRef) onSelectAgent(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => {
        if (!sel) return;
        copyText(sel.ref, "agent ref");
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

  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      setContextActions([
        { label: `Copy ${sel.ref}`, hint: "c", run: () => copyText(sel.ref, "agent ref") },
        { label: "Copy link to this agent", hint: "c l", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
  }, [sel?.ref]);

  const handleExport = () => exportJson("agents.json", visible);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Agents</h1>
        <ScopeCaption context={context} surface="registry" />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="ml-auto">
            <DisplayOptions
              config={AGENTS_DISPLAY}
              state={display}
              onChange={setDisplay}
              onExport={visible.length > 0 ? handleExport : undefined}
              rows={rows}
            />
          </span>
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter ref, contract, adapter, model, event type…"
            label="Filter agents"
          />
        </div>
          </>
        }
      >

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {cols.map((c) => {
                const sort = AGENTS_DISPLAY.sorts.find((s) => s.column === c.key);
                const isCustom = c.isCustom || c.key.startsWith("custom:");
                const customPath = c.key.replace(/^custom:/, "");
                const isCurrentSort = isCustom ? display.sortBy === c.key : (sort && display.sortBy === sort.key);
                return (
                  <Th
                    key={c.key}
                    label={c.label}
                    dir={isCurrentSort ? display.sortDir : null}
                    naturalDir={sort?.defaultDir ?? "asc"}
                    onSort={sort || isCustom ? () => setDisplay((s) => cycleColumnSort(AGENTS_DISPLAY, s, c.key)) : undefined}
                    onRemove={isCustom ? () => setDisplay((s) => removeCustomColumn(s, customPath)) : undefined}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const renderRow = (a: AgentDef) => (
                <tr
                  key={a.ref}
                  onClick={() => onSelectAgent(a.ref)}
                  aria-selected={a.ref === selectedRef}
                  className={`cursor-pointer hover:bg-(--surface-1) ${a.ref === selectedRef ? "row-selected" : ""}`}
                >
                  <td className="mono border-b border-(--border) px-3 py-1.5">{a.ref}</td>
                  {show.has("contract") && (
                    <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{a.outputContract}</td>
                  )}
                  {show.has("adapter") && (
                    <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-dim)">
                      {adapterText(a)}
                    </td>
                  )}
                  {show.has("tier") && (
                    <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-dim)">
                      {tierText(a)}
                      {a.model && a.modelTier && (
                        <span
                          className="ml-1.5 text-[11px] text-(--text-faint)"
                          title={`Overridden outright by model ${a.model} — the tier is declared but never resolved.`}
                        >
                          overridden
                        </span>
                      )}
                    </td>
                  )}
                  {show.has("model") && (
                    <td
                      className="mono max-w-56 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)"
                      title={modelText(a)}
                    >
                      {modelText(a)}
                    </td>
                  )}
                  {show.has("mutating") && (
                    <td className="border-b border-(--border) px-3 py-1.5">
                      <span style={{ color: a.mutating ? "var(--hue-err)" : "var(--text-faint)" }}>
                        {a.mutating ? "mutating" : "read-only"}
                      </span>
                    </td>
                  )}
                  {show.has("capabilities") && (
                    <td className="max-w-64 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                      {caps(a)}
                    </td>
                  )}
                  {show.has("timeout") && (
                    <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                      {a.limits.timeout_seconds != null ? `${a.limits.timeout_seconds}s` : "-"}
                    </td>
                  )}
                  {show.has("attempts") && (
                    <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                      {a.limits.attempts ?? "-"}
                    </td>
                  )}
                  {cols.filter((c) => c.isCustom || c.key.startsWith("custom:")).map((c) => (
                    <CustomCell key={c.key} row={a} path={c.key.replace(/^custom:/, "")} />
                  ))}
                </tr>
              );
              if (!grouped(display)) return sections[0]?.rows.map(renderRow);
              return sections.map((s) => {
                const closed = display.collapsed.includes(s.key);
                return (
                  <Fragment key={s.key}>
                    <GroupHeaderRow
                      colSpan={cols.length}
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
                                  colSpan={cols.length}
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
                colSpan={cols.length}
                query={query}
                filtered={rows.length > 0}
                noun="agents"
                empty="No registered agents."
              />
            )}
          </tbody>
        </table>

        <div className="mt-6">
          <Section title="Shared contracts">
            <div className="mb-1.5 text-[11px] text-(--text-faint)">
              Every agent&apos;s input arrives as a factory.event/v1 envelope and its output must
              validate against factory.agent-result/v1 — these schemas are the runtime&apos;s edges.
            </div>
            {Object.entries(contracts).map(([name, schema]) => (
              <Disclosure key={name} label={name}>
                <JsonBlock value={schema} />
              </Disclosure>
            ))}
          </Section>
        </div>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[520px]"
          title={
            <span className="mono" title={sel.ref}>
              {sel.ref}
            </span>
          }
          utility={
            <>
              <span>copy:</span>
              <button
                type="button"
                onClick={() => copyText(sel.ref, "agent ref")}
                className="cursor-pointer hover:text-(--text)"
              >
                ref <span aria-hidden="true" className="mono ml-0.5 text-(--text-faint) text-[10px]">c</span>
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
          close={<Button onClick={() => onSelectAgent(null)}>Close</Button>}
        >

          <Section title="Definition">
            <KV k="id" v={sel.id} />
            <KV k="version" v={String(sel.version)} />
            <KV k="outputContract" v={sel.outputContract} />
            <KV
              k="mutating"
              v={
                <span style={{ color: sel.mutating ? "var(--hue-err)" : "var(--text-faint)" }}>
                  {sel.mutating ? "yes" : "no"}
                </span>
              }
            />
            <KV
              k="workspace"
              v={`${sel.workspace.type}${sel.workspace.retainOnFailure ? " · retain on failure" : ""}`}
            />
            <KV k="capabilities" v={caps(sel)} />
            <KV k="adapter" v={adapterText(sel)} />
            {/* Declared intent and the exact-id escape hatch (WM-135). What each
                route actually resolves to is per adapter, and lives on the
                Event routing lines below — the same split `cli.mjs agents` prints. */}
            <KV k="modelTier" v={sel.modelTier ?? "-"} />
            <KV
              k="model override"
              v={
                sel.model ? (
                  <span title="Exact model id — resolved verbatim, whatever the tier says.">{sel.model}</span>
                ) : (
                  "-"
                )
              }
            />
            <KV k="hosts" v={sel.hosts && sel.hosts.length > 0 ? sel.hosts.join(", ") : "-"} />
            <KV k="command" v={sel.command && sel.command.length > 0 ? sel.command.join(" ") : "-"} />
            <KV
              k="actionRegistry"
              v={
                sel.actionRegistry && Object.keys(sel.actionRegistry).length > 0
                  ? Object.keys(sel.actionRegistry).join(", ")
                  : "-"
              }
            />
            <KV k="timeout" v={sel.limits.timeout_seconds != null ? `${sel.limits.timeout_seconds}s` : "-"} />
            <KV k="attempts" v={String(sel.limits.attempts ?? "-")} />
          </Section>

          {sel.command && (
            <Section title="Command argv" card={false}>
              <div className="mb-1.5 flex justify-end">
                <Button onClick={() => copyText(sel.command!.join(" "), "command")}>Copy command</Button>
              </div>
              <JsonBlock value={sel.command} />
            </Section>
          )}

          {sel.actionRegistry && (
            <Section
              title={`Action registry${sel.hosts && sel.hosts.length > 0 ? ` · hosts ${sel.hosts.join(", ")}` : ""}`}
              card={false}
            >
              <JsonBlock value={sel.actionRegistry} />
            </Section>
          )}

          <Section title={`Prompt · ${sel.promptFile}`} card={false}>
            <div className="mb-1.5 flex justify-end">
              <Button onClick={() => copyText(sel.prompt, "prompt")}>Copy prompt</Button>
            </div>
            <pre className="mono max-h-96 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 leading-relaxed whitespace-pre-wrap">
              {sel.prompt}
            </pre>
          </Section>

          <Section title="Schemas">
            <Disclosure label={`input — ${sel.inputSchemaFile}`}>
              <JsonBlock value={sel.inputSchema} />
            </Disclosure>
            <Disclosure label={`output — ${sel.outputSchemaFile}`}>
              <JsonBlock value={sel.outputSchema} />
            </Disclosure>
          </Section>

          <Section title="Pins">
            <div className="mb-1.5 text-[11px] text-(--text-faint)">
              Content-hash pins over the prompt and schema files: if a pinned file&apos;s bytes
              drift from its hash, the registry fails closed at load — versions are bumped and
              re-pinned, never edited in place.
            </div>
            {Object.entries(sel.pins).map(([file, hash]) => (
              <KV key={file} k={file} v={hash} />
            ))}
          </Section>

          <Section title="Event routing" card={false}>
            {sel.eventTypes.length === 0 ? (
              <div className="text-(--text-faint)">No event types route to this agent.</div>
            ) : (
              <div className="rounded-md border border-(--border) px-3 py-1">
                {sel.eventTypes.map((r) => (
                  <a
                    key={r.type}
                    href={eventsTypeHref(r.type)}
                    title={`Show ${r.type} in Events`}
                    className="group -mx-3 block border-b border-(--border) px-3 py-1.5 last:border-0 hover:bg-(--surface-1)"
                  >
                    <div className="mono text-(--accent) group-hover:underline">{r.type}</div>
                    <div className="text-[11px] text-(--text-faint)">
                      adapter {r.adapter} · model{" "}
                      <span
                        className="mono"
                        title={
                          r.resolvedModel != null
                            ? "What the planner pins into the RunSpec for this route."
                            : MODEL_ADAPTERS.has(r.adapter)
                              ? "This definition pins nothing, so dispatch rides the CLI's own default."
                              : `The ${r.adapter} adapter runs a fixed argv, not a model.`
                        }
                      >
                        {routeModel(r)}
                      </span>{" "}
                      · idempotency {r.idempotencyScope}
                      {r.proposalTtlSeconds != null ? ` · proposal TTL ${r.proposalTtlSeconds}s` : ""}
                    </div>
                  </a>
                ))}
              </div>
            )}
          </Section>
        </DetailPane>
      )}
    </div>
  );
}
