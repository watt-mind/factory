import type { MouseEvent } from "react";
import { teamUrl, type TeamChip } from "../trackerLinks";
import { Ago } from "./ui";

export type TicketSupplyAction =
  "dispatch" | "triage" | "merge" | "unblock" | "wait";

export type RepoRecommendedAction = "dispatch" | "triage" | "idle";

export type SupplyChip = TeamChip;

export type TicketSupplySource = "linear" | "scan" | null;

export interface TicketSupplyRepo {
  name: string;
  team: string | null;
  triage: number | null;
  ready: number | null;
  inFlight: number | null;
  cap: number;
  blocked: number | null;
  noopReason: "queue_empty" | "cap_full" | "all_overlapping" | null;
  asOf: string | null;
  sourceRunId: string | null;
  source?: TicketSupplySource;
}

export interface TicketSupply {
  repos: TicketSupplyRepo[];
  recommendedAction: TicketSupplyAction | null;
  source?: TicketSupplySource;
  asOf?: string | null;
  stale?: boolean;
  linearError?: string | null;
  budget?: { remaining: number | null; limit: number | null } | null;
  cached?: boolean;
}

export const CHIP_FILTER_STATE: Record<SupplyChip, string> = {
  triage: "Triage",
  ready: "Todo",
  inFlight: "In Progress",
  blocked: "Blocked",
};

export function trackerTeamUrl(
  team: string | null,
  chip?: SupplyChip,
): string | null {
  return teamUrl(team, chip);
}

export function recommendedActionForRepo(
  repo: TicketSupplyRepo,
): RepoRecommendedAction {
  const ready = repo.ready ?? 0;
  const triage = repo.triage ?? 0;
  const inFlight = repo.inFlight ?? 0;
  const cap = repo.cap ?? 0;
  if (ready > 0 && (cap === 0 || inFlight < cap)) return "dispatch";
  if (triage > 0 && ready === 0) return "triage";
  return "idle";
}

function formatCount(value: number | null): string {
  return value == null ? "—" : String(value);
}

function actionLabel(action: RepoRecommendedAction): string {
  if (action === "dispatch") return "dispatch";
  if (action === "triage") return "triage";
  return "idle";
}

export function hasSnapshot(repo: TicketSupplyRepo): boolean {
  return (
    repo.asOf != null ||
    repo.triage != null ||
    repo.ready != null ||
    repo.inFlight != null ||
    repo.blocked != null
  );
}

export function SupplyStrip({
  supply,
  pending,
  refreshing,
  error,
  repoFilter,
  stateFilter,
  now,
  onFilter,
  onRefresh,
}: {
  supply: TicketSupply | null | undefined;
  pending?: boolean;
  refreshing?: boolean;
  error?: string | null;
  repoFilter?: string;
  stateFilter?: string;
  now: number;
  onFilter: (next: { repo: string; state: string }) => void;
  onRefresh?: () => void;
}) {
  const repos = supply?.repos ?? [];
  const scanned = repos.filter(hasSnapshot);
  const unscanned = repos.filter((repo) => !hasSnapshot(repo));
  const asOf = supply?.asOf ?? scanned.find((repo) => repo.asOf)?.asOf ?? null;
  const stale = supply?.stale === true;
  const fromScan = supply?.source === "scan";

  return (
    <section
      data-testid="ticket-supply"
      aria-label="Ticket supply"
      className="mb-3 rounded-md border border-(--border) bg-(--surface-0) px-3 py-2"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <h2 className="font-medium tracking-wide text-(--text-faint) uppercase">
          Supply
        </h2>
        {supply?.recommendedAction && (
          <span className="text-(--text-dim)">
            · next:{" "}
            <span className="font-medium text-(--text)">
              {supply.recommendedAction}
            </span>
          </span>
        )}
        {asOf && (
          <span
            className={stale ? "text-(--hue-warn)" : "text-(--text-faint)"}
            title={
              stale
                ? "Last scan is older than an hour"
                : fromScan
                  ? "Figures from the last work-plan / status-report scan"
                  : "Figures from Linear"
            }
          >
            · {fromScan ? "scan · " : ""}as of <Ago iso={asOf} now={now} />
          </span>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || pending}
            aria-busy={refreshing || undefined}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-(--border) bg-(--surface-1) px-1.5 py-0.5 font-medium text-(--text-dim) hover:border-(--border-strong) hover:text-(--text) disabled:cursor-wait disabled:opacity-60"
          >
            {refreshing ? (
              <span
                aria-hidden="true"
                className="inline-block size-2.5 animate-spin rounded-full border border-(--text-faint) border-t-transparent"
              />
            ) : null}
            Refresh
          </button>
        )}
      </div>
      {supply?.linearError && fromScan && (
        <p role="status" className="mb-1.5 text-[11px] text-(--hue-warn)">
          Linear unavailable — showing last scan. {supply.linearError}
        </p>
      )}
      {pending && repos.length === 0 ? (
        <p role="status" className="text-[11px] text-(--text-faint)">
          Loading supply…
        </p>
      ) : error ? (
        <p role="status" className="text-[11px] text-(--hue-warn)">
          Supply figures unavailable: {error}
        </p>
      ) : repos.length === 0 ? (
        <p role="status" className="text-[11px] text-(--text-dim)">
          Queue supply will appear after Linear refresh or the next scan.
        </p>
      ) : (
        <>
          {scanned.length > 0 && (
            <table className="w-full border-collapse text-left text-[11px]">
              <caption className="sr-only">
                Ticket supply by repo: triage, ready, in flight, blocked, next
                action
              </caption>
              <thead>
                <tr className="text-(--text-faint)">
                  <th scope="col" className="pr-2 pb-1 font-medium">
                    Repo
                  </th>
                  <th
                    scope="col"
                    className="px-1 pb-1 text-right font-medium tabular-nums"
                  >
                    Triage
                  </th>
                  <th
                    scope="col"
                    className="px-1 pb-1 text-right font-medium tabular-nums"
                  >
                    Ready
                  </th>
                  <th
                    scope="col"
                    className="px-1 pb-1 text-right font-medium tabular-nums"
                  >
                    In flight
                  </th>
                  <th
                    scope="col"
                    className="px-1 pb-1 text-right font-medium tabular-nums"
                  >
                    Blocked
                  </th>
                  <th scope="col" className="pl-2 pb-1 font-medium">
                    Next
                  </th>
                </tr>
              </thead>
              <tbody>
                {scanned.map((repo) => (
                  <SupplyRow
                    key={repo.name}
                    repo={repo}
                    active={repoFilter === repo.name ? (stateFilter ?? "") : ""}
                    onFilter={onFilter}
                  />
                ))}
              </tbody>
            </table>
          )}
          {unscanned.length > 0 && (
            <details className="mt-1.5 text-[11px] text-(--text-faint)">
              <summary className="cursor-pointer hover:text-(--text-dim)">
                {unscanned.length} without a snapshot
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                {unscanned.map((repo) => (
                  <li key={repo.name} className="mono">
                    {repo.name}
                    {repo.team ? ` · ${repo.team}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function SupplyRow({
  repo,
  active,
  onFilter,
}: {
  repo: TicketSupplyRepo;
  active: string;
  onFilter: (next: { repo: string; state: string }) => void;
}) {
  const action = recommendedActionForRepo(repo);
  const tracker = trackerTeamUrl(repo.team);
  const inFlightLabel =
    repo.inFlight == null ? "—" : `${repo.inFlight}/${repo.cap}`;

  const clickChip = (event: MouseEvent, chip: SupplyChip) => {
    const href = trackerTeamUrl(repo.team, chip);
    if ((event.metaKey || event.ctrlKey) && href) {
      event.preventDefault();
      window.open(href, "_blank", "noreferrer");
      return;
    }
    onFilter({ repo: repo.name, state: CHIP_FILTER_STATE[chip] });
  };

  return (
    <tr className="border-t border-(--border)">
      <th scope="row" className="py-0.5 pr-2 font-medium">
        {tracker ? (
          <a
            href={tracker}
            target="_blank"
            rel="noreferrer"
            className="mono text-(--accent) hover:underline"
            title={`Open ${repo.team} in tracker`}
          >
            {repo.name}
          </a>
        ) : (
          <span className="mono text-(--text)">{repo.name}</span>
        )}
      </th>
      <td className="px-1 py-0.5 text-right">
        <SupplyChipButton
          label="Triage"
          value={formatCount(repo.triage)}
          active={active === CHIP_FILTER_STATE.triage}
          disabled={repo.triage == null}
          onClick={(event) => clickChip(event, "triage")}
        />
      </td>
      <td className="px-1 py-0.5 text-right">
        <SupplyChipButton
          label="Ready"
          value={formatCount(repo.ready)}
          active={active === CHIP_FILTER_STATE.ready}
          disabled={repo.ready == null}
          onClick={(event) => clickChip(event, "ready")}
        />
      </td>
      <td className="px-1 py-0.5 text-right">
        <SupplyChipButton
          label="In flight"
          value={inFlightLabel}
          active={active === CHIP_FILTER_STATE.inFlight}
          disabled={repo.inFlight == null}
          onClick={(event) => clickChip(event, "inFlight")}
        />
      </td>
      <td className="px-1 py-0.5 text-right">
        <SupplyChipButton
          label="Blocked"
          value={formatCount(repo.blocked)}
          active={active === CHIP_FILTER_STATE.blocked}
          disabled={repo.blocked == null}
          onClick={(event) => clickChip(event, "blocked")}
        />
      </td>
      <td
        className={`py-0.5 pl-2 font-medium ${
          action === "idle" ? "text-(--text-faint)" : "text-(--text)"
        }`}
        title={repo.noopReason ? `noop: ${repo.noopReason}` : undefined}
      >
        {actionLabel(action)}
      </td>
    </tr>
  );
}

function SupplyChipButton({
  label,
  value,
  active,
  disabled,
  onClick,
}: {
  label: string;
  value: string;
  active: boolean;
  disabled: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      aria-label={`Filter tickets: ${label} ${value}. ⌘-click opens Linear.`}
      title={`${label} ${value} — click to filter this hub, ⌘-click for Linear`}
      onClick={onClick}
      className={`inline-flex min-w-6 justify-end rounded-sm px-1 py-0.5 tabular-nums ${
        active
          ? "bg-(--surface-2) font-medium text-(--text)"
          : "text-(--text) hover:bg-(--surface-1)"
      } disabled:cursor-default disabled:opacity-60`}
    >
      {value}
    </button>
  );
}
