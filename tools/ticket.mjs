#!/usr/bin/env bun
/**
 * The factory's control-plane surface, as a shell command.
 *
 * Named `ticket`, not `linear`, because it has routed through
 * `loadControlPlane()` since WM-894 and picks its control plane per repo
 * since WM-1007 — only the filename still said Linear (WM-1026).
 * `tools/linear.mjs` remains as a deprecated shim.
 *
 *   bun tools/ticket.mjs get CLNT-616
 *   bun tools/ticket.mjs comments CLNT-616
 *   bun tools/ticket.mjs claim CLNT-616 --agent claude
 *   bun tools/ticket.mjs comment CLNT-616 "verified: 42 tests pass"
 *   bun tools/ticket.mjs triage CLNT-616 --comment "Owned Paths need revision"
 *   bun tools/ticket.mjs answer CLNT-616 "Use the existing token cache"
 *   bun tools/ticket.mjs detail CLNT-616 -- "## Acceptance criteria\n- [ ] ..."
 *   bun tools/ticket.mjs labels CLNT-616 --add ai:needs-review --remove ai:in-progress
 *   bun tools/ticket.mjs state CLNT-616 "In Review" --add ai:needs-review
 *   bun tools/ticket.mjs file --team CLNT --title "..." --body "..." --type bug
 *   bun tools/ticket.mjs queue --repo bj29
 *   bun tools/ticket.mjs budget
 *   bun tools/ticket.mjs raw '<graphql>' --var key=value
 *
 * WHY THIS EXISTS, given a perfectly good Linear MCP. (These reasons are
 * Linear-specific and still true; they are why the factory does not depend on
 * that connector, not a claim that the tracker is always Linear.)
 *
 * Three reasons, in ascending order of importance.
 *
 *  1. The MCP is flaky in practice. Across 485 measured runs `list_issues`
 *     failed input validation 18 times in 12 runs and `save_issue` 10 times,
 *     and 96 runs fell through to a hand-rolled GraphQL fallback. Agents were
 *     already routing around it; this makes the route the road.
 *
 *  2. It is not declared anywhere. The MCP arrives as a claude.ai connector
 *     configured in a UI, so what the factory can reach changes when someone
 *     toggles a checkbox. Everything else the factory depends on is in git and
 *     moves by PR.
 *
 *  3. Connectors come as a bundle, and the bundle is the problem. An unattended
 *     factory session was loading 174 MCP tools: Linear (52), but also a client
 *     law firm's connector (51), Gmail (16), Drive, Calendar. Every ticket
 *     agent running unattended under bypassPermissions had personal mail and
 *     client data one tool call away, for no reason. Replacing the one
 *     connector the factory actually needs is what makes it possible to turn
 *     the rest off (--strict-mcp-config in config/mcp/claude.json).
 *
 * NOT A GENERAL TRACKER CLIENT. It covers the verbs the floor's protocol
 * actually names; anything rarer goes through `raw` with explicit GraphQL
 * rather than growing an API surface nobody maintains. Verbs run through
 * `loadControlPlane()` (WM-894); retries, backoff and key loading stay in
 * `orchestrator/reaper.mjs` as the Linear transport behind the adapter.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadRepos } from "../event-runtime/lib/repos.mjs";
import {
  loadControlPlane,
  TYPE_LABELS,
  SOURCE_LABELS,
  validateLabels,
  resolveLabelIds,
  agentLabel,
  claimLabels,
  appendIssueDetail,
} from "../lib/control-plane/index.mjs";
import {
  parseOwnedPaths,
  ownedPathsClosureGaps,
  readPinManifestRequirements,
  formatOwnedPathClosureGaps,
} from "../orchestrator/owned-paths.mjs";

export {
  TYPE_LABELS,
  SOURCE_LABELS,
  validateLabels,
  resolveLabelIds,
  agentLabel,
  claimLabels,
  appendIssueDetail,
};

// Budget capture lives on disk so `doctor` / `linear budget` can read it
// across process boundaries. The verbs themselves go through the ControlPlane
// adapter (team states and workspace labels are fetched there).
const CACHE_DIR = path.join(homedir(), ".factory/cache/linear");
const BUDGET_FILE = "budget.json";
const LINEAR_API_HOST = "api.linear.app";

/** Distinct from generic CLI failure (exit 1) so planners can retry-later. */
export const LINEAR_RATE_LIMIT_EXIT = 3;
export const LINEAR_REQUESTS_LIMIT = 2500;
export const LINEAR_BUDGET_WARN_REMAINING = 300;

export class LinearRateLimitError extends Error {
  constructor(resetAt, cause) {
    super(`linear_rate_limited: resetAt=${resetAt ?? "unknown"}`);
    this.name = "LinearRateLimitError";
    this.rateLimited = true;
    this.resetAt = resetAt ?? null;
    if (cause) this.cause = cause;
  }
}

export function isLinearRateLimitMessage(text) {
  const s = String(text ?? "");
  return (
    /rate limit exceeded/i.test(s) ||
    /RATELIMITED/i.test(s) ||
    /HTTP 429\b/.test(s) ||
    /"rateLimited"\s*:\s*true/.test(s)
  );
}

export function isLinearRateLimited(err) {
  if (!err) return false;
  if (err instanceof LinearRateLimitError || err.rateLimited === true)
    return true;
  return String(err.message ?? "").startsWith("linear_rate_limited:");
}

function parseHeaderNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Linear's reset header is a unix timestamp; Retry-After is a small delta.
 * ISO-8601 strings pass through Date.parse.
 */
export function parseRateLimitReset(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n < 1e9) return new Date(now + n * 1000).toISOString();
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseRateLimitHeaders(headers, now = Date.now()) {
  if (!headers || typeof headers.get !== "function") return null;
  const remaining = parseHeaderNumber(
    headers.get("x-ratelimit-requests-remaining"),
  );
  const limit = parseHeaderNumber(headers.get("x-ratelimit-requests-limit"));
  const resetAt = parseRateLimitReset(
    headers.get("x-ratelimit-requests-reset") ?? headers.get("retry-after"),
    now,
  );
  const complexityRemaining = parseHeaderNumber(
    headers.get("x-ratelimit-complexity-remaining"),
  );
  const complexityLimit = parseHeaderNumber(
    headers.get("x-ratelimit-complexity-limit"),
  );
  const complexityResetAt = parseRateLimitReset(
    headers.get("x-ratelimit-complexity-reset"),
    now,
  );
  if (
    remaining == null &&
    limit == null &&
    resetAt == null &&
    complexityRemaining == null &&
    complexityLimit == null &&
    complexityResetAt == null
  ) {
    return null;
  }
  return {
    remaining: remaining ?? complexityRemaining,
    limit: limit ?? complexityLimit ?? LINEAR_REQUESTS_LIMIT,
    resetAt: resetAt ?? complexityResetAt,
  };
}

export function linearCacheDir() {
  return process.env.LINEAR_CACHE_DIR || CACHE_DIR;
}

export function loadLinearBudget() {
  try {
    return JSON.parse(
      readFileSync(path.join(linearCacheDir(), BUDGET_FILE), "utf8"),
    );
  } catch {
    return null;
  }
}

export function saveLinearBudget(budget) {
  try {
    mkdirSync(linearCacheDir(), { recursive: true });
    writeFileSync(
      path.join(linearCacheDir(), BUDGET_FILE),
      JSON.stringify({ ...budget, capturedAt: new Date().toISOString() }),
    );
  } catch {
    // Budget is an optimization / doctor line, never a dependency.
  }
}

function formatResetClock(resetAt) {
  if (!resetAt) return "unknown";
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function formatLinearBudgetLine(budget) {
  if (!budget || budget.remaining == null) {
    return "Linear budget: unknown (no recent API call)";
  }
  const limit = budget.limit ?? LINEAR_REQUESTS_LIMIT;
  return `Linear budget: ${budget.remaining}/${limit} remaining, resets ${formatResetClock(budget.resetAt)}`;
}

export function linearBudgetStatus(budget) {
  if (!budget || budget.remaining == null) return "unknown";
  if (budget.remaining < LINEAR_BUDGET_WARN_REMAINING) return "warn";
  return "pass";
}

function recordLinearBudgetFromResponse(res) {
  const parsed = parseRateLimitHeaders(res.headers);
  if (!parsed && res.status !== 400 && res.status !== 429) return;
  const prior = loadLinearBudget() ?? {};
  const rateLimited =
    res.status === 429 ||
    (res.status === 400 && parsed?.remaining === 0) ||
    parsed?.remaining === 0;
  saveLinearBudget({
    remaining:
      parsed?.remaining ?? (rateLimited ? 0 : (prior.remaining ?? null)),
    limit: parsed?.limit ?? prior.limit ?? LINEAR_REQUESTS_LIMIT,
    resetAt: parsed?.resetAt ?? prior.resetAt ?? null,
    rateLimited: Boolean(rateLimited || prior.rateLimited),
    status: res.status,
  });
}

let fetchHookInstalled = false;

export function installLinearBudgetCapture() {
  if (fetchHookInstalled) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  fetchHookInstalled = true;
  globalThis.fetch = async function linearBudgetFetch(input, init) {
    const url = String(input?.url ?? input);
    const res = await originalFetch(input, init);
    if (url.includes(LINEAR_API_HOST)) recordLinearBudgetFromResponse(res);
    return res;
  };
}

/**
 * Raised instead of falling through to the tracked example configuration.
 *
 * `config/repos.yaml` is instance-local routing state: examples name a
 * different control plane by design. A runner checkout without that file must
 * therefore not turn a GitHub ticket into a Linear lookup merely because the
 * fallback is syntactically valid (GH-975).
 */
export class InstanceConfigMissingError extends Error {
  constructor(root) {
    super(
      `instance_config_missing: ${path.join(root, "config", "repos.yaml")} is required for this checkout (${root})`,
    );
    this.code = "instance_config_missing";
  }
}

/**
 * Resolve the operator checkout which owns the instance-local control-plane
 * configuration. `FACTORY_REPOS_ROOT` remains the explicit test/operator
 * override; dispatched agents otherwise receive `FACTORY_ROOT` from their
 * launching worker. Never use the executing agent's cwd for this decision.
 */
export function instanceConfigRoot({
  env = process.env,
  checkoutRoot = path.resolve(import.meta.dir, ".."),
} = {}) {
  const root = path.resolve(
    env.FACTORY_REPOS_ROOT || env.FACTORY_ROOT || checkoutRoot,
  );
  if (!existsSync(path.join(root, "config", "repos.yaml"))) {
    throw new InstanceConfigMissingError(root);
  }
  return root;
}

/**
 * Which `config/repos.yaml` entry this invocation is about (WM-1007), or null
 * when nothing identifies one.
 *
 * `--repo` wins. Otherwise match cwd, which must consider **both** the repo's
 * checkout and its `worktree_root`: every dispatched agent runs from
 * `<worktree_root>/<TICKET>`, not from `path`, so matching `path` alone would
 * resolve to null in the one case that matters most and silently fall back to
 * the workspace-wide control plane.
 *
 * Longest prefix wins, so a repo checked out inside another repo's tree
 * resolves to the inner one.
 */
export function resolveRepoName({
  cwd = process.cwd(),
  repos,
  repoFlag = flag("repo"),
} = {}) {
  const registry = repos ?? getRepos();
  const explicit = repoFlag;
  if (explicit) {
    if (!registry.has(explicit)) {
      throw new Error(
        `unknown --repo ${JSON.stringify(explicit)} — known: ${[...registry.keys()].join(", ") || "(none)"}`,
      );
    }
    return explicit;
  }
  const here = path.resolve(cwd);
  const under = (dir) =>
    dir &&
    (here === dir || here.startsWith(dir.endsWith("/") ? dir : `${dir}/`));
  let best = null;
  for (const repo of registry.values()) {
    for (const dir of [repo.path, repo.worktreeRoot]) {
      if (!under(dir)) continue;
      if (!best || dir.length > best.length)
        best = { name: repo.name, length: dir.length };
    }
  }
  return best?.name ?? null;
}

/**
 * When cwd identifies no repo (dispatched agents run from ephemeral runtime
 * workspaces under ~/.factory, matching neither `path` nor `worktree_root` —
 * GH-975), the ticket identifier itself still can: `owner/repo#N` names the
 * GitHub repo, and a registry entry whose `github:` matches decides the
 * plane. Without this, a workspace-run claim silently falls back to the
 * workspace-wide default plane and misreads or misses the ticket entirely.
 */
export function resolveRepoNameFromTicket(ticketArg, repos) {
  const registry = repos ?? getRepos();
  const m =
    typeof ticketArg === "string" &&
    ticketArg.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#[0-9]+/);
  if (!m) return null;
  const github = m[1].toLowerCase();
  for (const repo of registry.values()) {
    if (typeof repo.github === "string" && repo.github.toLowerCase() === github)
      return repo.name;
  }
  return null;
}

function controlPlane(ticketArg = positional[0]) {
  // All ticket verbs act on instance-local state. Resolve this before looking
  // at cwd or the identifier so a missing runner config is an explicit refusal
  // rather than a silent default-plane lookup.
  const root = instanceConfigRoot();
  const repos = getRepos(root);
  // Absent a resolvable repo, fall back to the workspace default exactly as
  // before — a CLI run from /tmp must still work.
  let repoName = null;
  try {
    repoName = resolveRepoName({ repos });
  } catch (err) {
    // An explicit bad --repo is the operator's mistake; surface it.
    if (flag("repo")) throw err;
  }
  if (!repoName) {
    try {
      repoName = resolveRepoNameFromTicket(ticketArg, repos);
    } catch {
      // registry unreadable — same fallback as before
    }
  }
  return loadControlPlane(repoName ? { root, repoName } : { root });
}

/** Compact ticket rendering — the fields the protocol actually acts on. */
export function formatTicket(i) {
  const labels = Array.isArray(i.labels)
    ? i.labels.map((l) => l.name)
    : (i.labels?.nodes ?? []).map((l) => l.name);
  const lines = [
    `${i.identifier}  ${i.title}`,
    `  state     ${i.state?.name ?? "?"}`,
    `  assignee  ${i.assignee?.name ?? "(unassigned)"}`,
    `  labels    ${labels.join(" ") || "(none)"}`,
    `  url       ${i.url ?? ""}`,
  ];
  if (i.description) lines.push("", i.description);
  return lines.join("\n");
}

/** Compact comment rendering — author, timestamp, and body. */
export function formatComment(c) {
  const author = c.user?.name ?? "(unknown)";
  const when = c.createdAt ?? "";
  const header = when ? `${author}  ${when}` : author;
  return `${header}\n${c.body ?? ""}`;
}

export function formatComments(nodesOrIssue) {
  const nodes = Array.isArray(nodesOrIssue)
    ? nodesOrIssue
    : (nodesOrIssue?.comments?.nodes ?? []);
  if (!nodes.length) return "(no comments)";
  return nodes.map(formatComment).join("\n\n---\n\n");
}

let REPOS;
const PATH_REQUIREMENTS_CACHE = new Map();

function getRepos(root = instanceConfigRoot()) {
  if (!REPOS) REPOS = loadRepos({ root });
  return REPOS;
}

export function __resetLinearReposCache() {
  REPOS = undefined;
  PATH_REQUIREMENTS_CACHE.clear();
}

function repoForIssue(issue) {
  const repoTeam = issue?.team?.key;
  const repoProject = issue?.project?.name;
  if (!repoTeam || !repoProject) return null;
  for (const repo of getRepos().values()) {
    if (repo.team === repoTeam && repo.project === repoProject) return repo;
  }
  return null;
}

export function closureCheckMessages(issue) {
  const repo = repoForIssue(issue);
  if (!repo?.ownedPathsPolicy) return [];
  const key = `${repo.name}::${repo.ownedPathsPolicy.pinManifests?.join(",") || ""}`;
  if (!PATH_REQUIREMENTS_CACHE.has(key)) {
    const requirements = repo.ownedPathsPolicy.pinManifests?.length
      ? readPinManifestRequirements(
          repo.path,
          repo.ownedPathsPolicy.pinManifests,
        )
      : [];
    PATH_REQUIREMENTS_CACHE.set(key, requirements);
  }
  const requirements = PATH_REQUIREMENTS_CACHE.get(key);
  const gaps = ownedPathsClosureGaps({
    ownedPaths: parseOwnedPaths(issue.description ?? ""),
    ownedPathsPolicy: repo.ownedPathsPolicy,
    pinManifestRequirements: requirements,
  });
  return formatOwnedPathClosureGaps(gaps);
}

const teamOf = (key) => String(key).split("-")[0];

// ------------------------------------------------------------------ verbs ---
const VALUE_FLAGS = new Set([
  "add",
  "agent",
  "area",
  "body",
  "comment",
  "label",
  "project",
  "remove",
  "repo",
  "source",
  "team",
  "title",
  "type",
  "var",
]);

const BODY_VERBS = new Set(["answer", "comment", "detail"]);

/**
 * Return command arguments that are not flags or values consumed by flags.
 *
 * `--` is the conventional end-of-options marker. A leading markdown rule is
 * also accepted directly for the verbs whose second positional argument is
 * markdown; arbitrary leading `--` text must use the marker so unknown flags
 * remain flags rather than silently becoming bodies.
 */
export function parsePositionalArgs(argv) {
  const positional = [];
  let optionsEnded = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (optionsEnded) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (
        BODY_VERBS.has(argv[0]) &&
        positional.length === 1 &&
        arg.startsWith("---")
      ) {
        positional.push(arg);
        continue;
      }
      if (VALUE_FLAGS.has(arg.slice(2))) i += 1;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

const argv = process.argv.slice(2);
const verb = argv[0];
const positional = parsePositionalArgs(argv);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flagAll = (name) =>
  argv
    .flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []))
    .filter(Boolean);
const has = (name) => argv.includes(`--${name}`);
const JSON_OUT = has("json");
const out = (obj, text) =>
  console.log(JSON_OUT ? JSON.stringify(obj, null, 2) : text);

const VERBS = {
  async get() {
    const issue = await controlPlane().getTicket(positional[0]);
    out(issue, formatTicket(issue));
  },

  async comments() {
    const key = positional[0];
    if (!key) throw new Error(`usage: comments <ISSUE-ID>`);
    const nodes = await controlPlane().listComments(key);
    out(nodes, formatComments(nodes));
  },

  async claim() {
    const key = positional[0];
    const harness = flag("agent", "claude");
    // Linear has no compare-and-swap; the adapter's read-back IS the
    // concurrency control. `ok: false` is a lost race, not a transport error.
    const result = await controlPlane().claim(key, { harness });
    out(
      result,
      result.ok
        ? `claimed ${key} as ${result.assignee}`
        : `LOST RACE on ${key} — now assigned to ${result.assignee ?? "someone else"}; take the next ticket`,
    );
    if (!result.ok) process.exit(1);
  },

  async comment() {
    const key = positional[0];
    const body = positional[1];
    if (!body) throw new Error(`usage: comment <ISSUE-ID> [--] "<text>"`);
    await controlPlane().comment(key, body);
    out({ ok: true, identifier: key }, `commented on ${key}`);
  },

  async triage() {
    const key = positional[0];
    const comment = flag("comment");
    if (!key || comment === null)
      throw new Error(`usage: triage <ISSUE-ID> --comment "<text>"`);
    const cp = controlPlane();
    await cp.transition(key, "Triage", { remove: ["ai:agent-ready"] });
    if (comment.trim()) await cp.comment(key, comment);
    out({ ok: true, identifier: key }, `${key} -> Triage`);
  },

  async answer() {
    const key = positional[0];
    const text = positional[1];
    if (!key || !text)
      throw new Error(`usage: answer <ISSUE-ID> [--] "<text>"`);
    const cp = controlPlane();
    const issue = await cp.getTicket(key);
    if (issue.state?.name?.toLowerCase() === "blocked")
      await cp.transition(key, "Todo");
    await cp.comment(key, text);
    out({ ok: true, identifier: key }, `answered ${key}`);
  },

  async detail() {
    const key = positional[0];
    const rawDetail = positional[1];
    if (!key || !rawDetail)
      throw new Error(`usage: detail <ISSUE-ID> [--] "<markdown>"`);
    const { appended } = await controlPlane().appendDetail(key, rawDetail);
    if (!appended) {
      out(
        { ok: true, identifier: key, appended: false },
        `${key} detail already present`,
      );
      return;
    }
    out(
      { ok: true, identifier: key, appended: true },
      `${key} detail appended`,
    );
  },

  async labels() {
    const key = positional[0];
    if (!key)
      throw new Error(
        `usage: labels <ISSUE-ID> [--add <label>] [--remove <label>]`,
      );
    const cp = controlPlane();
    const add = flagAll("add"),
      remove = flagAll("remove");
    if (!add.length && !remove.length) {
      const issue = await cp.getTicket(key);
      const current = (issue.labels ?? []).map((l) => l.name);
      out(current, current.join(" ") || "(none)");
      return;
    }
    await cp.setLabels(key, { add, remove });
    out(
      { ok: true, identifier: key, added: add, removed: remove },
      `${key} labels updated`,
    );
  },

  async label() {
    return VERBS.labels();
  },

  async state() {
    const key = positional[0];
    const wanted = positional[1];
    const add = flagAll("add"),
      remove = flagAll("remove");
    if (!key)
      throw new Error(
        `usage: state <ISSUE-ID> ["<State Name>"] [--add label] [--remove label]`,
      );
    if (!wanted && !add.length && !remove.length && !has("unassign")) {
      throw new Error(
        `usage: state <ISSUE-ID> "<State Name>" [--add label] [--remove label]`,
      );
    }
    const cp = controlPlane();
    const issue = await cp.getTicket(key);

    if (add.includes("ai:agent-ready")) {
      const gaps = closureCheckMessages(issue);
      if (gaps.length) {
        throw new Error(
          `Cannot add ai:agent-ready on ${key}: Owned Paths closure policy not satisfied:\n${gaps.map((g) => `- ${g}`).join("\n")}`,
        );
      }
    }

    await cp.transition(key, wanted ?? "", {
      add,
      remove,
      unassign: has("unassign"),
    });
    const msg = wanted ? `${key} -> ${wanted}` : `${key} labels updated`;
    out(
      { ok: true, identifier: key, ...(wanted ? { state: wanted } : {}) },
      msg,
    );
  },

  async file() {
    const team = flag("team");
    const title = flag("title");
    if (!team || !title)
      throw new Error(
        `usage: file --team CLNT --title "..." [--body "..."] [--type bug] [--area x] [--source agent] [--todo]`,
      );

    // New findings land in Triage unless they already meet the agent-ready bar.
    const stateName = has("todo") ? "Todo" : "Triage";
    const wanted = [
      ...(flag("type") ? [`type:${flag("type")}`] : []),
      ...flagAll("area").map((a) => `area:${a}`),
      `source:${flag("source", "agent")}`,
      ...(has("todo") ? ["ai:agent-ready"] : []),
      ...flagAll("label"),
    ];
    const created = await controlPlane().file({
      team,
      title,
      body: flag("body", ""),
      labels: wanted,
      state: stateName,
      projectId: flag("project") || undefined,
    });
    out(
      { ok: true, ...created },
      `filed ${created.identifier} in ${stateName}  ${created.url}`,
    );
  },

  async inflight() {
    // In Progress tickets for a team/project — the planner's Owned Paths
    // collision set (WM-1006: control-plane-neutral, replaces raw Linear GQL).
    const team = flag("team") ?? teamOf(positional[0] ?? "");
    if (!team) throw new Error(`usage: inflight --team WM [--project Factory]`);
    const rows = await controlPlane().listTickets({
      team,
      project: flag("project") ?? undefined,
      states: ["In Progress"],
    });
    const slim = rows.map((i) => ({
      identifier: i.identifier,
      description: i.description ?? "",
    }));
    out(
      slim,
      slim.length
        ? slim.map((i) => i.identifier).join("\n")
        : "no in-progress tickets",
    );
  },

  async queue() {
    let team = flag("team") ?? teamOf(positional[0] ?? "");
    let project = flag("project") ?? null;
    if (!team) {
      // Repo-scoped read (work-scan calls `queue --repo <name>`): derive the
      // team from the repo's config. GitHub-plane repos have no meaningful
      // team of their own — listDispatchable maps it back to the repo — but
      // the verb still needs *a* team, and requiring the caller to pass it for
      // a --repo read is exactly the mismatch that made work-scan refuse.
      const repoName = flag("repo");
      if (repoName) {
        const cfg = getRepos().get(repoName);
        team = cfg?.team ?? null;
        // ...and its project. Several repos share one Linear team (CLNT covers
        // BJ29 Coaching, CashMap, RiccoMoto, ...); without the project filter
        // `queue --repo bj29` returns every CLNT ticket and dispatch runs a
        // CashMap ticket in the bj29 worktree.
        if (project === null) project = cfg?.project ?? null;
      }
    }
    if (!team) throw new Error(`usage: queue --team CLNT (or --repo <name>)`);
    // Dispatchable == Todo + ai:agent-ready + unassigned. The same predicate
    // the dispatcher uses; agents must not invent their own.
    const ready = await controlPlane().listDispatchable(
      project ? { team, project } : { team },
    );
    out(
      ready,
      ready.length
        ? ready.map((i) => `${i.identifier}  ${i.title}`).join("\n")
        : "no agent-ready tickets",
    );
  },

  async budget() {
    const budget = loadLinearBudget();
    out(
      budget ?? {
        remaining: null,
        limit: LINEAR_REQUESTS_LIMIT,
        resetAt: null,
      },
      formatLinearBudgetLine(budget),
    );
  },

  async raw() {
    const vars = Object.fromEntries(
      flagAll("var").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    console.log(
      JSON.stringify(await controlPlane().raw(positional[0], vars), null, 2),
    );
  },
};

/**
 * The CLI entry point, exported so `tools/linear.mjs` (the deprecated shim,
 * WM-1026) can delegate to exactly this and stay behaviourally identical.
 */
export async function main() {
  installLinearBudgetCapture();
  if (!verb || has("help") || !VERBS[verb]) {
    console.log(`verbs: ${Object.keys(VERBS).join(", ")}\n`);
    console.log(
      import.meta.file ? "see the header of tools/ticket.mjs for usage" : "",
    );
    process.exit(verb && !VERBS[verb] ? 2 : 0);
  }
  try {
    await VERBS[verb]();
  } catch (e) {
    if (isLinearRateLimited(e) || isLinearRateLimitMessage(e.message)) {
      const budget = loadLinearBudget() ?? {};
      const resetAt = e.resetAt ?? budget.resetAt ?? null;
      const payload = { rateLimited: true, resetAt };
      console.error(JSON.stringify(payload));
      process.exit(LINEAR_RATE_LIMIT_EXIT);
    }
    console.error(`ticket ${verb}: ${e.message}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
