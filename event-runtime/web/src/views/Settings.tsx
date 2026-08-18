import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  fetchConfig,
  type ConfigEntry,
  type ConfigReload,
  type ConfigSection,
} from "../api";
import { FilterInput } from "../components/ui";
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
          ? section.entries.filter((entry) =>
              `${entry.key}\n${displayValue(entry.value)}`
                .toLowerCase()
                .includes(needle),
            )
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
                    {section.entries.map((entry) => (
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
