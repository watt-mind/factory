import { pad, withClient } from "./shared.mjs";

/**
 * The factory repo registry (OPS-299). MODE is the column an operator actually
 * scans for — a report-only repo is one the loop reports on but never dispatches
 * to — and CLEANUP says whether the janitor has a teardown script to call.
 */
export async function repos(client) {
  const { repos: rows } = await client.repos();
  if (rows.length === 0) {
    console.log("no repos in config/repos.yaml");
    return;
  }
  console.log(
    `${pad("REPO", 16)}${pad("TEAM", 6)}${pad("MODE", 12)}${pad("BASE", 10)}${pad("DEPLOY", 10)}${pad("CAP", 5)}${pad("CLEANUP", 9)}WORKTREE ROOT`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.name, 16)}${pad(r.team, 6)}${pad(r.reportOnly ? "report-only" : "dispatch", 12)}${pad(r.base, 10)}${pad(r.deployBranch, 10)}${pad(r.maxInFlight, 5)}${pad(r.hasWorktreeDown ? "yes" : "no", 9)}${r.worktreeRoot ?? "-"}`,
    );
  }
}

export default function reposCommand(args) {
  return withClient((client) => repos(client));
}
