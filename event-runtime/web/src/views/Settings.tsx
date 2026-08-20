import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  fetchConfig,
  type ConfigEntry,
  type ConfigExtension,
  type ConfigReload,
  type ConfigSection,
} from "../api";
import { FilterInput } from "../components/ui";
import {
  SchemaForm,
  schemaSearchText,
  type JsonSchema,
} from "../components/SchemaForm";
import { EMPTY } from "../format";
import { refetchIntervals } from "../hooks";

const RELOAD_HELP: Record<ConfigReload, string> = {
  hot: "Read again while the service is running; no serve restart is needed.",
  restart: "Loaded when serve starts; restart serve to apply a file change.",
  "cli-only":
    "Consumed only by CLI or launchd generation; the running server does not read it.",
};

function displayValue(value: unknown): string {
  if (
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
    return EMPTY;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function sourceName(file: string): string {
  return file.split("/").pop() ?? file;
}

function rowHref(section: ConfigSection, entry: ConfigEntry): string | null {
  if (section.id === "repos") {
    const repo = entry.note?.match(/^Repository (.+)$/)?.[1];
    return repo ? `#/projects/${encodeURIComponent(repo)}` : null;
  }
  if (section.id !== "registry") return null;
  return entry.key === "schedules" ? "#/schedules" : "#/agents";
}

function ReloadChip({ reload }: { reload: ConfigReload }) {
  return (
    <span
      tabIndex={0}
      aria-label={`${reload}. ${RELOAD_HELP[reload]}`}
      className="mono shrink-0 rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-xs text-(--text-dim)"
      title={RELOAD_HELP[reload]}
    >
      {reload}
    </span>
  );
}

function SettingsRow({
  section,
  entry,
}: {
  section: ConfigSection;
  entry: ConfigEntry;
}) {
  const reload = entry.reload ?? section.reload;
  const value = displayValue(entry.value);
  const href = rowHref(section, entry);
  return (
    <div className="grid min-w-0 gap-2 border-b border-(--border) px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(10rem,0.8fr)_minmax(12rem,1.4fr)_auto]">
      <div className="mono min-w-0 break-words text-[12px] font-medium text-(--text)">
        {href ? (
          <a href={href} className="text-(--accent) hover:underline">
            {entry.key}
          </a>
        ) : (
          entry.key
        )}
      </div>
      <div className="min-w-0 overflow-x-auto">
        <pre
          className={`mono w-max min-w-full whitespace-pre text-[12px] ${value === EMPTY ? "text-(--text-faint)" : "text-(--text-dim)"}`}
        >
          {value}
        </pre>
        {entry.note && (
          <div className="mt-1 text-xs text-(--text-faint)">{entry.note}</div>
        )}
      </div>
      <div className="flex items-start gap-1.5 md:justify-end">
        <span
          className="mono shrink-0 rounded border border-(--border) px-1.5 py-0.5 text-xs text-(--text-faint)"
          title={section.source.file}
        >
          {sourceName(section.source.file)}
        </span>
        <ReloadChip reload={reload} />
      </div>
    </div>
  );
}

/** The entry key the server publishes for an extension (mirrors lib/api-config.mjs). */
function extensionKey(ext: ConfigExtension): string {
  return ext.namespace ?? ext.name ?? ext.path;
}

const CONTRIBUTION_LABELS = [
  ["packs", "pack"],
  ["adapters", "adapter"],
  ["connectors", "connector"],
  ["hooks", "hook"],
  ["panels", "panel"],
] as const;

type ExtensionContributions = Record<
  (typeof CONTRIBUTION_LABELS)[number][0],
  number
>;

function isContributions(value: unknown): value is ExtensionContributions {
  if (!value || typeof value !== "object") return false;
  return CONTRIBUTION_LABELS.every(
    ([key]) => typeof (value as Record<string, unknown>)[key] === "number",
  );
}

/** Wire field lives on ConfigExtension after WM-856; api.ts is outside Owned Paths. */
function contributionsOf(ext: ConfigExtension): ExtensionContributions | null {
  const raw = (ext as ConfigExtension & { contributions?: unknown })
    .contributions;
  return isContributions(raw) ? raw : null;
}

function contributionChipLabel(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function contributionHaystack(ext: ConfigExtension): string {
  const counts = contributionsOf(ext);
  if (!counts) return "";
  return CONTRIBUTION_LABELS.map(([key, word]) =>
    contributionChipLabel(counts[key], word),
  ).join("\n");
}

function extensionHaystack(ext: ConfigExtension): string {
  return [
    ext.name ?? "",
    ext.namespace ?? "",
    ext.path,
    ext.anomaly ?? "",
    contributionHaystack(ext),
    schemaSearchText(ext.schema as JsonSchema | null),
  ].join("\n");
}

function ContributionChips({ ext }: { ext: ConfigExtension }) {
  const counts = contributionsOf(ext);
  if (!counts) return null;
  const chips = CONTRIBUTION_LABELS.filter(([key]) => counts[key] > 0).map(
    ([key, word]) => {
      const label = contributionChipLabel(counts[key], word);
      return (
        <span
          key={key}
          className="mono shrink-0 rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-xs text-(--text-dim)"
          title={`${label} contributed`}
        >
          {label}
        </span>
      );
    },
  );
  return chips.length > 0 ? chips : null;
}

/**
 * One extension of the Extensions section (WM-841): what loaded, under which
 * namespace, with its effective (defaulted, validated, redacted) values — or
 * the anomaly that disabled it. Read-only, like every other section.
 */
function ExtensionRow({
  section,
  ext,
}: {
  section: ConfigSection;
  ext: ConfigExtension;
}) {
  return (
    <div className="border-b border-(--border) last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="mono min-w-0 break-words text-[12px] font-medium text-(--text)">
          {ext.name ?? ext.path}
        </span>
        {ext.namespace && (
          <span
            className="mono shrink-0 rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-xs text-(--text-dim)"
            title="config namespace"
          >
            {ext.namespace}
          </span>
        )}
        {ext.version && (
          <span className="mono shrink-0 text-xs text-(--text-faint)">
            v{ext.version}
          </span>
        )}
        <ContributionChips ext={ext} />
        {ext.name && (
          <span
            className="mono min-w-0 truncate text-xs text-(--text-faint)"
            title={ext.path}
          >
            {ext.path}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span
            className="mono shrink-0 rounded border border-(--border) px-1.5 py-0.5 text-xs text-(--text-faint)"
            title={section.source.file}
          >
            {sourceName(section.source.file)}
          </span>
          <ReloadChip reload={ext.reload} />
        </span>
      </div>
      {ext.anomaly ? (
        <div
          role="status"
          className="mx-3 mb-2.5 rounded border border-(--hue-err) px-2.5 py-2 text-[12px] text-(--hue-err)"
        >
          disabled — {ext.anomaly}
        </div>
      ) : ext.values === null ? (
        <div className="px-3 pb-2.5 text-xs text-(--text-faint)">
          Declares no config.
        </div>
      ) : (
        <>
          <div className="mx-3 mb-2 overflow-hidden rounded border border-(--border) bg-(--surface-1)">
            <SchemaForm
              schema={ext.schema as JsonSchema | null}
              values={ext.values}
              namespace={ext.namespace}
            />
          </div>
          {ext.schema && (
            <details className="mx-3 mb-2.5 text-xs text-(--text-faint)">
              <summary className="cursor-pointer select-none">schema</summary>
              <pre className="mono mt-1 overflow-x-auto text-[11px] text-(--text-dim)">
                {JSON.stringify(ext.schema, null, 2)}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** One read-only inventory for every factory configuration source (WM-704). */
export function Settings({
  focusSectionId,
  onSelectSection,
}: {
  focusSectionId: string | null;
  onSelectSection: (id: string) => void;
}) {
  const query = useQuery({
    queryKey: ["config"],
    queryFn: fetchConfig,
    ...refetchIntervals.secondary,
  });
  const sections = useMemo(
    () => query.data?.sections ?? [],
    [query.data?.sections],
  );
  const selected =
    sections.find((section) => section.id === focusSectionId) ??
    sections[0] ??
    null;
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (selected && focusSectionId !== selected.id)
      onSelectSection(selected.id);
  }, [focusSectionId, onSelectSection, selected]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const candidates = needle ? sections : selected ? [selected] : [];
    return candidates
      .map((section) => ({
        ...section,
        entries: needle
          ? section.entries.filter((entry) => {
              const ext = section.extensions?.find(
                (item) => extensionKey(item) === entry.key,
              );
              const extra = ext ? extensionHaystack(ext) : "";
              return `${entry.key}\n${displayValue(entry.value)}\n${extra}`
                .toLowerCase()
                .includes(needle);
            })
          : section.entries,
      }))
      .filter((section) => !needle || section.entries.length > 0);
  }, [search, sections, selected]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="shrink-0 border-b border-(--border) px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="display text-lg font-semibold">Settings</h1>
            <p className="mt-1 text-[12px] text-(--text-faint)">
              Read-only configuration inventory. Changes still happen in source
              files.
            </p>
          </div>
          <FilterInput
            value={search}
            onChange={setSearch}
            placeholder="Search keys and values"
            label="Search settings"
          />
        </div>
        {query.data && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-(--text-faint)">
            <span>
              policy{" "}
              <span className="mono text-(--text-dim)">
                {query.data.policyVersion || EMPTY}
              </span>
            </span>
            <span>
              registry loaded{" "}
              <time
                className="mono text-(--text-dim)"
                dateTime={query.data.registry.loadedAt}
              >
                {query.data.registry.loadedAt}
              </time>
            </span>
          </div>
        )}
      </header>

      {query.isPending && (
        <div className="p-5 text-(--text-faint)">Loading settings…</div>
      )}
      {query.isError && (
        <div className="p-5 text-(--text-faint)">
          Cannot reach the control API — settings will appear when it is up.
        </div>
      )}
      {query.data && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label="Settings sections"
            className="shrink-0 overflow-auto border-b border-(--border) bg-(--surface-1) p-2 md:w-52 md:border-r md:border-b-0"
          >
            <div className="flex gap-1 md:flex-col">
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  aria-current={
                    selected?.id === section.id ? "page" : undefined
                  }
                  onClick={() => {
                    setSearch("");
                    onSelectSection(section.id);
                  }}
                  className={`flex min-w-max items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-[12px] md:min-w-0 ${selected?.id === section.id ? "bg-(--surface-3) font-medium text-(--text)" : "text-(--text-dim) hover:bg-(--surface-2)"}`}
                >
                  <span>{section.title}</span>
                  <span className="mono text-xs text-(--text-faint)">
                    {section.entries.length}
                  </span>
                </button>
              ))}
            </div>
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3 md:p-5">
            {shown.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-(--text-faint)">
                No settings match this search.
              </div>
            ) : (
              shown.map((section) => (
                <section
                  key={section.id}
                  aria-labelledby={`settings-${section.id}`}
                  className="mb-5"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h2
                      id={`settings-${section.id}`}
                      className="display text-[14px] font-semibold"
                    >
                      {section.title}
                    </h2>
                    <span className="mono text-xs text-(--text-faint)">
                      {section.source.file}
                    </span>
                  </div>
                  <div className="min-w-0 overflow-hidden rounded-md border border-(--border) bg-(--surface-0)">
                    {section.extensions && section.extensions.length === 0 && (
                      <div className="px-3 py-2.5 text-xs text-(--text-faint)">
                        No extensions enabled — add them under{" "}
                        <span className="mono">extensions:</span> in
                        policy.yaml.
                      </div>
                    )}
                    {section.extensions
                      ? section.extensions
                          .filter((ext) =>
                            section.entries.some(
                              (entry) => entry.key === extensionKey(ext),
                            ),
                          )
                          .map((ext) => (
                            <ExtensionRow
                              key={`${extensionKey(ext)}:${ext.path}`}
                              section={section}
                              ext={ext}
                            />
                          ))
                      : section.entries.map((entry) => (
                          <SettingsRow
                            key={entry.key}
                            section={section}
                            entry={entry}
                          />
                        ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
