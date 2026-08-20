import type { MouseEvent } from "react";
import { Ago, shortId } from "./ui";

export type TicketSupplyAction =
  "dispatch" | "triage" | "merge" | "unblock" | "wait";

export type RepoRecommendedAction = "dispatch" | "triage" | "idle";

export type SupplyChip = "triage" | "ready" | "inFlight" | "blocked";

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
}

export interface TicketSupply {
  repos: TicketSupplyRepo[];
  recommendedAction: TicketSupplyAction | null;
}

export const CHIP_FILTER_STATE: Record<SupplyChip, string> = {
  triage: "Triage",
  ready: "Todo",
  inFlight: "In Progress",
  blocked: "Blocked",
};

const LINEAR_TEAM = "https://linear.app/watt-mind/team";

export function linearTeamUrl(
  team: string | null,
  chip?: SupplyChip,
): string | null {
  if (!team) return null;
  const base = `${LINEAR_TEAM}/${encodeURIComponent(team)}`;
  if (chip === "triage") return `${base}/triage`;
  return `${base}/active`;
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
  if (action === "dispatch") return "→dispatch";
  if (action === "triage") return "→triage";
  return "idle";
}

function hasScan(repo: TicketSupplyRepo): boolean {
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
  error,
  repoFilter,
  stateFilter,
  now,
  onFilter,
}: {
  supply: TicketSupply | null | undefined;
  pending?: boolean;
  error?: string | null;
  repoFilter?: string;
  stateFilter?: string;
  now: number;
  onFilter: (next: { repo: string; state: string }) => void;
}) {
  const repos = supply?.repos ?? [];

  return (
    <section
      data-testid="ticket-supply"
      aria-label="Ticket supply"
      className="mb-3 rounded-md border border-(--border) bg-(--surface-0) px-3 py-2"
    >
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
          Supply
        </h2>
        {supply?.recommendedAction && (
          <span className="text-[11px] text-(--text-dim)">
            next:{" "}
            <span className="font-medium text-(--text)">
              {supply.recommendedAction}
            </span>
          </span>
        )}
      </div>
      {pending && repos.length === 0 ? (
        <p role="status" className="text-[11px] text-(--text-faint)">
          Loading latest scan figures…
        </p>
      ) : error ? (
        <p role="status" className="text-[11px] text-(--hue-warn)">
          Supply figures unavailable: {error}
        </p>
      ) : repos.length === 0 ? (
        <p role="status" className="text-[11px] text-(--text-dim)">
          Queue supply will appear after the next work-plan or status-report
          scan.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {repos.map((repo) => (
            <SupplyRow
              key={repo.name}
              repo={repo}
              now={now}
              active={repoFilter === repo.name ? (stateFilter ?? "") : ""}
              onFilter={onFilter}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SupplyRow({
  repo,
  now,
  active,
  onFilter,
}: {
  repo: TicketSupplyRepo;
  now: number;
  active: string;
  onFilter: (next: { repo: string; state: string }) => void;
}) {
  const action = recommendedActionForRepo(repo);
  const scanned = hasScan(repo);
  const linear = linearTeamUrl(repo.team);
  const inFlightLabel =
    repo.inFlight == null ? "—" : `${repo.inFlight}/${repo.cap}`;

  const clickChip = (event: MouseEvent, chip: SupplyChip) => {
    const href = linearTeamUrl(repo.team, chip);
    if ((event.metaKey || event.ctrlKey) && href) {
      event.preventDefault();
      window.open(href, "_blank", "noreferrer");
      return;
    }
    onFilter({ repo: repo.name, state: CHIP_FILTER_STATE[chip] });
  };

  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      {linear ? (
        <a
          href={linear}
          target="_blank"
          rel="noreferrer"
          className="mono shrink-0 font-medium text-(--accent) hover:underline"
          title={`Open ${repo.team} on Linear`}
        >
          {repo.name}
        </a>
      ) : (
        <span className="mono shrink-0 font-medium text-(--text)">
          {repo.name}
        </span>
      )}
      {repo.team && (
        <span className="shrink-0 text-(--text-faint)">{repo.team}</span>
      )}
      {!scanned ? (
        <span className="text-(--text-faint)">no scan yet</span>
      ) : (
        <>
          <SupplyChipButton
            label="Triage"
            value={formatCount(repo.triage)}
            active={active === CHIP_FILTER_STATE.triage}
            disabled={repo.triage == null}
            onClick={(event) => clickChip(event, "triage")}
          />
          <SupplyChipButton
            label="Ready"
            value={formatCount(repo.ready)}
            active={active === CHIP_FILTER_STATE.ready}
            disabled={repo.ready == null}
            onClick={(event) => clickChip(event, "ready")}
          />
          <SupplyChipButton
            label="In flight"
            value={inFlightLabel}
            active={active === CHIP_FILTER_STATE.inFlight}
            disabled={repo.inFlight == null}
            onClick={(event) => clickChip(event, "inFlight")}
          />
          <SupplyChipButton
            label="Blocked"
            value={formatCount(repo.blocked)}
            active={active === CHIP_FILTER_STATE.blocked}
            disabled={repo.blocked == null}
            onClick={(event) => clickChip(event, "blocked")}
          />
          <span
            className={`shrink-0 font-medium ${
              action === "idle" ? "text-(--text-faint)" : "text-(--text)"
            }`}
            title={repo.noopReason ? `noop: ${repo.noopReason}` : undefined}
          >
            {actionLabel(action)}
          </span>
          {repo.asOf && (
            <span className="ml-auto shrink-0 text-(--text-faint)">
              {repo.sourceRunId ? (
                <a
                  href={`#/run/${encodeURIComponent(repo.sourceRunId)}`}
                  className="hover:text-(--accent) hover:underline"
                  title={`Scan ${repo.sourceRunId} at ${repo.asOf}`}
                >
                  as of <Ago iso={repo.asOf} now={now} /> ·{" "}
                  {shortId(repo.sourceRunId)}
                </a>
              ) : (
                <>
                  as of <Ago iso={repo.asOf} now={now} />
                </>
              )}
            </span>
          )}
        </>
      )}
    </li>
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
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 tabular-nums ${
        active
          ? "border-(--accent) bg-(--surface-2) text-(--text)"
          : "border-(--border) bg-(--surface-1) text-(--text-dim) hover:border-(--border-strong) hover:text-(--text)"
      } disabled:cursor-default disabled:opacity-60`}
    >
      <span className="text-(--text-faint)">{label}</span>
      <span className="font-medium text-(--text)">{value}</span>
    </button>
  );
}
