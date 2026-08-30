const LINEAR_ISSUE_ROOT = "https://linear.app/watt-mind/issue";
const LINEAR_TEAM_ROOT = "https://linear.app/watt-mind/team";

const LINEAR_ISSUE = /^[A-Z]{2,5}-\d+$/;
const LINEAR_TEAM = /^[A-Z]{2,5}$/;
const GITHUB_REPOSITORY =
  /^([A-Za-z0-9][A-Za-z0-9.-]*)\/([A-Za-z0-9][A-Za-z0-9.-]*)$/;
const GITHUB_ISSUE = new RegExp(
  `${GITHUB_REPOSITORY.source.slice(0, -1)}#([1-9]\\d*)$`,
);

/** Return the tracker URL for a supported Linear or GitHub issue identifier. */
export function issueUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  if (LINEAR_ISSUE.test(id)) return `${LINEAR_ISSUE_ROOT}/${id}`;

  const github = GITHUB_ISSUE.exec(id);
  if (!github) return null;
  return `https://github.com/${github[1]}/${github[2]}/issues/${github[3]}`;
}

/** Return a team/repository tracker URL, optionally narrowed to its triage view. */
export function teamUrl(
  team: string | null | undefined,
  chip?: string,
): string | null {
  if (!team) return null;

  const github = GITHUB_REPOSITORY.exec(team);
  if (github) {
    const query = chip === "triage" ? "is:open label:state:Triage" : "is:open";
    return `https://github.com/${github[1]}/${github[2]}/issues?${new URLSearchParams({ q: query })}`;
  }

  if (!LINEAR_TEAM.test(team)) return null;
  const base = `${LINEAR_TEAM_ROOT}/${encodeURIComponent(team)}`;
  return chip === "triage" ? `${base}/triage` : `${base}/active`;
}
