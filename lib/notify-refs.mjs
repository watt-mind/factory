/**
 * Parse durable-notification prefix references into inbox refs.
 *
 * GitHub issue references stay fully qualified for control-plane operations,
 * while their repository ref uses the configured short name when available.
 */
import { loadRepos } from "../event-runtime/lib/repos.mjs";

const GITHUB_ISSUE = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*)\b/;
const LINEAR_ISSUE = /\b[A-Z][A-Z0-9]+-\d+\b/;
const BARE_GITHUB_ISSUE = /(?:^|[\s(])#([1-9]\d*)\b/;

/**
 * `factory notify` is the last-resort human notification path (WM-759), so a
 * missing or invalid repos config must not abort it. Without the registry,
 * GitHub refs stay fully qualified and bare `#N` issues are left unexpanded.
 */
export function safeRepos({ load = loadRepos } = {}) {
  try {
    return load();
  } catch {
    return new Map();
  }
}

function configuredRepo(repo, repos) {
  const normalized = repo.toLowerCase();
  for (const [name, configured] of repos) {
    if (configured.github?.toLowerCase() === normalized) {
      return { name, github: configured.github };
    }
  }
  const configured = repos.get(repo);
  return { name: repo, github: configured?.github ?? null };
}

function repoInPrefix(prefix, { hasIssue, hasPr }) {
  const merge = prefix.match(/^merge\s+(\S+)/i);
  if (merge) return merge[1];
  const run = prefix.match(/^(\S+)\s+run\s+/i);
  if (run) return run[1];
  if (!hasIssue && !hasPr) {
    const fallback = prefix.match(/^(\S+)/);
    if (fallback && !fallback[1].startsWith("#")) return fallback[1];
  }
  return null;
}

/**
 * Convert the text before a notification's colon into normalized inbox refs.
 * `repos` is injectable so the parser is deterministic in unit tests; the
 * default fails open to an empty registry (see `safeRepos`).
 */
export function parseNotifyRefs(prefix, { repos = safeRepos() } = {}) {
  const refs = {};
  const github = prefix.match(GITHUB_ISSUE);
  const linear = prefix.match(LINEAR_ISSUE);
  const pr = prefix.match(/\bPR#?\d+\b/i);
  const run = prefix.match(/\brun\s+([^\s:]+)/i);
  const bareGithub = github ? null : prefix.match(BARE_GITHUB_ISSUE);

  const repoToken = github
    ? github[1].slice(0, github[1].lastIndexOf("#"))
    : repoInPrefix(prefix, {
        hasIssue: Boolean(linear),
        hasPr: Boolean(pr),
      });
  const repo = repoToken ? configuredRepo(repoToken, repos) : null;

  if (github) refs.issue = github[1];
  else if (linear) refs.issue = linear[0];
  else if (bareGithub && repo?.github)
    refs.issue = `${repo.github}#${bareGithub[1]}`;
  if (pr) refs.pr = pr[0].toUpperCase();
  if (run) refs.runId = run[1];
  if (repo) refs.repo = repo.name;
  return refs;
}
