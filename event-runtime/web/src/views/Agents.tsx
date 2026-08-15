import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
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
import type { AgentDef } from "../types";
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
 * Events already owns `#/events?type=` (the same target Graph jumps to). A real
 * link, not a callback through App, keeps that route single-owner and makes the
 * jump behave like one: middle-click, copy link, Back.
 */
const eventsTypeHref = (type: string) => `#/${eventsHash(null, null, type)}`;

const AGENTS_DISPLAY: DisplayConfig<AgentDef> = {
  view: "agents",
  groups: [
    {
      key: "mutating",
      label: "Mutating",
      get: (a) => (a.mutating ? "mutating" : "read-only"),
      order: ["mutating", "read-only"],
    },
    { key: "contract", label: "Contract", get: (a) => a.outputContract },
  ],
  sorts: [
    { key: "ref", label: "Ref", get: (a) => a.ref, column: "ref" },
    { key: "contract", label: "Contract", get: (a) => a.outputContract, column: "contract" },
    { key: "timeout", label: "Timeout", get: (a) => a.limits.timeout_seconds ?? 0, column: "timeout" },
    { key: "attempts", label: "Attempts", get: (a) => a.limits.attempts ?? 0, column: "attempts" },
  ],
  columns: [
    { key: "ref", label: "Ref", always: true },
    { key: "contract", label: "Contract" },
    { key: "mutating", label: "Mutating" },
    { key: "capabilities", label: "Capabilities" },
    { key: "timeout", label: "Timeout" },
    { key: "attempts", label: "Attempts" },
  ],
};

/**
 * Agents (webui doc §10.6) — the registry, fully readable. An operator
 * approving "factory-status-report@1" can read exactly what that ref means —
 * prompt, schemas, pins, routing — without opening the repo. Read-only:
 * the registry has no mutation surface, by design.
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
  const [display, setDisplay] = useDisplayOptions(AGENTS_DISPLAY);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((a) =>
      [a.ref, a.id, a.outputContract, caps(a), ...a.eventTypes.map((t) => t.type)].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [rows, filter]);

  const show = useMemo(
    () =>
      new Set(
        display.hiddenColumns.length
          ? AGENTS_DISPLAY.columns.map((c) => c.key).filter((k) => !display.hiddenColumns.includes(k))
          : AGENTS_DISPLAY.columns.map((c) => c.key),
      ),
    [display.hiddenColumns],
  );
  const cols = useMemo(() => visibleColumns(AGENTS_DISPLAY, display), [display]);
  const sections = useMemo(() => buildSections(visible, AGENTS_DISPLAY, display), [visible, display]);
  const flat = useMemo(() => flattenSections(sections, display.collapsed), [sections, display.collapsed]);

  const selectedRef = focusAgentRef;
  const selectedIndex = useMemo(() => flat.findIndex((a) => a.ref === selectedRef), [flat, selectedRef]);
  const sel = selectedIndex >= 0 ? flat[selectedIndex] : null;

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusAgentRef) setFilter("");
  }, [focusAgentRef]);

  useListKeys({
    count: flat.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectAgent(flat[i]?.ref ?? null),
    onClose: () => {
      if (selectedRef) onSelectAgent(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => sel && copyText(sel.ref, "agent ref"),
    },
  });

  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      setContextActions([
        { label: `Copy ${sel.ref}`, hint: "c", run: () => copyText(sel.ref, "agent ref") },
        { label: "Copy link to this agent", run: copyLink },
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
                placeholder="Filter ref, contract, event type…"
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
                    {!closed && s.rows.map(renderRow)}
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
          actions={
            <>
              <Button onClick={() => copyText(sel.ref, "agent ref")}>Copy ref</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectAgent(null)}>Close</Button>
            </>
          }
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
                      adapter {r.adapter} · idempotency {r.idempotencyScope}
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
