/**
 * GitHub Issues ControlPlane (WM-798).
 *
 * The same verbs as `linear.mjs` / `memory.mjs`, bound onto GitHub:
 *   - protocol labels → issue labels of the same spelling (complete set)
 *   - assignee → issue assignee; claim read-back is the concurrency control
 *   - factory states → a Projects v2 single-select (default title `Factory`,
 *     field `Status`)
 *
 * Production talks to GitHub through `gh api` / `gh api graphql` (the same
 * CLI the forge already requires). No Octokit — a Linear-account-free
 * quickstart is `gh auth login` plus `factory init --control-plane github`.
 *
 * `api` is the seam: `(method, path, { body, query }) => json`, so the
 * contract suite can drive the implementation with a fake tracker and no
 * network. When omitted, `exec` (a spawnSync-shaped result, but async and
 * non-blocking — see `ghSpawn`) wraps `gh`.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { byQueueOrder, ControlPlaneError } from "./types.mjs";
import {
  AGENT_READY_LABEL,
  appendIssueDetail,
  BLOCKED_LABEL,
  clampGithubBody,
  claimLabels,
  GITHUB_BODY_MAX_LENGTH,
  IN_PROGRESS_LABEL,
  stampRun,
  validateLabels,
} from "./labels.mjs";
import {
  isTrustedAssociation,
  parseReadyPin,
  readyPinMarker,
} from "../../event-runtime/lib/triage.mjs";
import { defaultTokenFile, readCachedAppToken } from "./gh-app-auth.mjs";

export const GITHUB_FACTORY_STATES = Object.freeze([
  "Triage",
  "Todo",
  "In Progress",
  "In Review",
  "Done",
  "Blocked",
]);

const DEFAULT_PROJECT = "Factory";
const DEFAULT_STATUS_FIELD = "Status";

const FIND_REPO_PROJECT = `query FindRepoProject($owner: String!, $name: String!, $title: String!, $statusField: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 20, query: $title) {
      nodes {
        id
        title
        field(name: $statusField) {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`;

const FIND_VIEWER_PROJECT = `query FindViewerProject($title: String!, $statusField: String!) {
  viewer {
    projectsV2(first: 20, query: $title) {
      nodes {
        id
        title
        field(name: $statusField) {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`;

const PROJECT_ITEMS = `query ProjectItems($projectId: ID!, $statusField: String!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        nodes {
          id
          content {
            ... on Issue {
              id
              number
              repository { nameWithOwner }
            }
          }
          fieldValueByName(name: $statusField) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/**
 * Resolved repo-permission associations, keyed `"<repo> <login>"`, held for
 * the process lifetime (WM-879). Permission changes are rare and a factory
 * process is short-lived, so this trades staleness for not paying a
 * `collaborators/{login}/permission` request on every plan.
 */
const collaboratorAssociationCache = new Map();

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Read a bounded GitHub REST collection in full. GitHub defaults to 30
 * records, so callers that need the complete collection (comment history,
 * repo labels) must opt into pagination rather than silently treating the
 * first page as the entire collection.
 */
async function listAllPages(call, pathName, query = {}) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await call("GET", pathName, {
      query: {
        ...query,
        per_page: String(PAGE_SIZE),
        page: String(page),
      },
    });
    const pageItems = Array.isArray(rows) ? rows : [];
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) return items;
  }
  console.warn(
    `GitHub pagination reached the ${MAX_PAGES}-page safety ceiling for ${pathName}; results may be incomplete`,
  );
  return items;
}

/**
 * WM-879 gate 1: who last edited the issue body. `UserContentEdit.editor`
 * carries no `authorAssociation` of its own (that field only exists on the
 * issue/comment itself, not on arbitrary edit history), so an editor other
 * than the original author is resolved separately via the repo collaborator
 * permission endpoint (see `collaboratorAssociation`). Requires the same
 * write-level `gh` token the dispatcher already needs to label/comment/
 * transition these issues — GitHub only exposes edit history to accounts
 * with write access, so a token that can operate this ticket can also see
 * whether its body was edited.
 */
const ISSUE_LAST_EDITOR = `query IssueLastEditor($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      userContentEdits(last: 1) {
        nodes { editor { login } }
      }
    }
  }
}`;

// Deliberately bounded and repository-scoped. The closing-reference edge is
// GitHub's canonical interpretation of "Fixes #N"; unlike body parsing it
// also handles cross-reference syntax and edits. Twenty simultaneous closing
// PRs for one issue is already pathological, and a hard ceiling protects the
// unattended reaper from an unbounded forge walk.
//
// `number`/`url`/`mergeCommit` carry the merged-PR evidence the claim guard
// (WM-1050) reconciles with; the open-PR reaper reads only `state`.
const ISSUE_CLOSING_PULL_REQUESTS = `query IssueClosingPullRequests($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 20) {
        nodes {
          state
          number
          url
          repository { nameWithOwner }
          mergeCommit { oid }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const ADD_PROJECT_ITEM = `mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`;

const SET_PROJECT_STATUS = `mutation SetProjectStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) { projectV2Item { id } }
}`;

const text = (v) =>
  v == null ? "" : Buffer.isBuffer(v) ? v.toString() : String(v);

/**
 * Remove `GH_TOKEN`/`GITHUB_TOKEN` from a child env, but ONLY when they hold
 * the App installation token. An operator's own PAT is never touched: it is a
 * legitimate ambient user credential and the identity read works with it.
 *
 * @param {NodeJS.ProcessEnv} childEnv mutated in place
 * @param {string|null} appToken
 * @returns {number} how many variables were removed
 */
function stripAppToken(childEnv, appToken) {
  if (!appToken) return 0;
  let removed = 0;
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (childEnv[name] === appToken) {
      delete childEnv[name];
      removed += 1;
    }
  }
  return removed;
}

/**
 * The App token as it sits on disk, ignoring whether `FACTORY_GH_APP_*` is
 * configured for this process — used only to recognise an exported copy of it
 * in the ambient env. Never throws and never logs: a missing or unparseable
 * file simply means "nothing to compare against".
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
function cachedTokenFileToken(env) {
  try {
    const file = env.FACTORY_GH_APP_TOKEN_FILE || defaultTokenFile();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed?.token === "string" && parsed.token
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

/**
 * Default `api` implementation: `gh api` / `gh api graphql` via `exec`.
 *
 * `exec` runs the `gh` subprocess and returns (or resolves to) a
 * spawnSync-shaped `{ status, stdout, stderr, error }`. The default `ghSpawn`
 * is an ASYNC, non-blocking spawn: serve's single event loop yields while
 * `gh` runs instead of stalling in a blocking `spawnSync` (WM-1166). `ghJson`
 * awaits the result, so a synchronous spawnSync-shaped stub (the tests) and
 * the async default both work unchanged.
 *
 * GitHub App auth (WM-1137, Phase 2 of #1136): when the App env vars are set
 * and a fresh cached installation token exists, each `gh` spawn is given
 * `GH_TOKEN` in its child env so `gh` authenticates as the factory's App
 * instead of the ambient gh-config PAT. Reading the cached token per spawn
 * means the hourly rotation needs no restart. It is fully defensive and a
 * strict no-op when unconfigured: `resolveToken` returns null (env untouched,
 * today's behavior), and any failure resolving a configured token logs ONE
 * warning and falls back to spawning `gh` with the env untouched — a `gh` call
 * never crashes because App auth is misconfigured. The token never appears in
 * a log or error.
 *
 * @param {(cmd: string, args: string[], opts: object) => (object|Promise<object>)} exec
 * @param {{ env?: NodeJS.ProcessEnv, resolveToken?: (args: {env: NodeJS.ProcessEnv}) => (string|null), sleep?: (ms: number) => Promise<void> }} [options]
 */
export function makeGhApi(exec = ghSpawn, options = {}) {
  const {
    env = process.env,
    resolveToken = readCachedAppToken,
    sleep = defaultSleep,
  } = options;
  let warnedAppAuth = false;
  const spawn = (cmd, args, opts, { allowApp = true } = {}) => {
    let childEnv;
    try {
      const token = resolveToken({ env });
      if (token) {
        // An installation token has no user identity and GitHub permanently
        // rejects REST GET /user with "Resource not accessible by
        // integration". Claims still need an assignable human account as
        // their distributed lock owner, so that ONE lookup uses the ambient
        // gh user credential instead. Every repository/project operation
        // continues to use the App token and its separate rate budget.
        if (allowApp) {
          childEnv = { ...env, GH_TOKEN: token };
        } else {
          childEnv = { ...env };
          stripAppToken(childEnv, token);
        }
      } else if (!allowApp && (env.GH_TOKEN || env.GITHUB_TOKEN)) {
        // App auth is not configured for this process, but the operator may
        // still have `export GH_TOKEN=$(… gh-app-token.json)` in the ambient
        // shell — the App token then wins over `hosts.yml` and the identity
        // read fails with 401/403 all the same. Drop it for this one spawn.
        const cached = cachedTokenFileToken(env);
        if (cached) {
          const candidate = { ...env };
          if (stripAppToken(candidate, cached)) childEnv = candidate;
        }
      }
    } catch (err) {
      if (!warnedAppAuth) {
        warnedAppAuth = true;
        // Status/state only — never the token (see gh-app-auth.mjs).
        console.warn(
          `GitHub App auth unavailable; falling back to default gh credentials: ${err?.message ?? err}`,
        );
      }
    }
    return exec(cmd, args, childEnv ? { ...opts, env: childEnv } : opts);
  };
  return function ghApi(method, pathName, { body, query } = {}) {
    // `--include` exposes Retry-After on secondary rate limits. ghJson strips
    // the response envelope before parsing the JSON body.
    const args = ["api", "--include"];
    const isGraphql =
      pathName === "graphql" || pathName === "/graphql" || method === "GRAPHQL";
    if (isGraphql) {
      args.push("graphql", "--input", "-");
      return ghJson(
        spawn,
        args,
        JSON.stringify({
          query: body?.query ?? body,
          variables: body?.variables ?? query ?? {},
        }),
        { sleep },
      );
    }
    if (method && method !== "GET") args.push("-X", method);
    let url = String(pathName).replace(/^\//, "");
    const isUserIdentityRead = (!method || method === "GET") && url === "user";
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(
        Object.fromEntries(
          Object.entries(query).filter(([, v]) => v != null && v !== ""),
        ),
      ).toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    args.push(url);
    if (body !== undefined) {
      args.push("--input", "-");
      return ghJson(
        (cmd, childArgs, opts) =>
          spawn(cmd, childArgs, opts, { allowApp: !isUserIdentityRead }),
        args,
        JSON.stringify(body),
        { sleep },
      );
    }
    return ghJson(
      (cmd, childArgs, opts) =>
        spawn(cmd, childArgs, opts, { allowApp: !isUserIdentityRead }),
      args,
      undefined,
      { sleep },
    );
  };
}

/**
 * Non-blocking default `exec`: run `gh` via `child_process.spawn` and collect
 * its result into a spawnSync-shaped `{ status, stdout, stderr, error }` on a
 * Promise (WM-1166). Unlike `spawnSync`, this yields serve's event loop while
 * `gh` runs. It reads the same `opts` the previous blocking path used — `env`
 * (the per-call GH_TOKEN injection) and `input` (graphql `--input -` stdin) —
 * and reports failures the same way spawnSync did: a non-zero exit as
 * `status`, an unspawnable `gh` as `error` with `status: null`.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, input?: string, timeoutMs?: number }} [opts]
 * @param {{ spawnImpl?: typeof import("node:child_process").spawn, setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout, killGraceMs?: number, killImpl?: typeof process.kill }} [runtime]
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, error: Error|null}>}
 */
export function ghSpawn(cmd, args, opts = {}, runtime = {}) {
  const { env, input } = opts;
  const {
    spawnImpl = spawnProcess,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    killGraceMs = 1_000,
    killImpl = process.kill,
  } = runtime;
  // The child env is only materialised in App-token mode; in PAT mode `gh`
  // inherits the ambient environment, so the operator's FACTORY_GH_TIMEOUT_MS
  // must be honoured from process.env as well.
  const timeoutMs = validTimeout(
    opts.timeoutMs ??
      env?.FACTORY_GH_TIMEOUT_MS ??
      process.env.FACTORY_GH_TIMEOUT_MS,
  );
  return new Promise((resolve) => {
    let settled = false;
    let timeoutTimer;
    let killTimer;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeoutImpl(timeoutTimer);
      resolve(r);
    };
    let child;
    try {
      // `detached` puts gh in its own process group so a timeout kill also
      // reaches any helper it spawned (pager, credential helper, browser).
      child = spawnImpl(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        ...(env ? { env } : {}),
      });
    } catch (error) {
      finish({ status: null, stdout: "", stderr: "", error });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    // A spawn failure (e.g. `gh` not on PATH) fires 'error' and no 'close'.
    child.on("error", (error) => {
      finish({ status: null, stdout, stderr, error });
    });
    // status is the exit code, or null when the process died on a signal —
    // exactly spawnSync's `status` semantics.
    child.on("close", (code) => {
      if (killTimer) clearTimeoutImpl(killTimer);
      finish({ status: code, stdout, stderr, error: null });
    });
    timeoutTimer = setTimeoutImpl(() => {
      const error = new Error(`gh timed out after ${timeoutMs}ms`);
      killProcessGroup(child, "SIGTERM", killImpl);
      killTimer = setTimeoutImpl(
        () => killProcessGroup(child, "SIGKILL", killImpl),
        killGraceMs,
      );
      // Do not keep the control-plane process alive solely for a stuck child.
      killTimer?.unref?.();
      finish({ status: null, stdout, stderr, error });
    }, timeoutMs);
    timeoutTimer?.unref?.();
    if (child.stdin) {
      // Never let a broken pipe (gh exiting before reading stdin) crash serve.
      child.stdin.on("error", () => {});
      if (input != null) child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/**
 * Signal the whole process group `gh` was started in (mirrors
 * event-runtime/lib/adapters/cursor.mjs). Falls back to the child alone when
 * the group is already gone (ESRCH) or the platform has no groups.
 */
function killProcessGroup(child, signal, kill = process.kill) {
  const pid = child?.pid;
  if (!pid) {
    try {
      child?.kill?.(signal);
    } catch {
      // already terminated
    }
    return;
  }
  try {
    kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already terminated
    }
  }
}

function validTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60_000;
}

function ghResponse(stdout) {
  // Status line, zero or more header lines, a blank line, then the body.
  const match =
    /^HTTP\/\S+(?:\s+(\d{3}))?[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n([\s\S]*)$/.exec(
      stdout,
    );
  if (!match) return { body: stdout, headers: {}, httpStatus: null };
  const httpStatus = match[1] ? Number(match[1]) : null;
  const headers = Object.fromEntries(
    match[2]
      .split(/\r?\n/)
      .map((line) => {
        const index = line.indexOf(":");
        return index === -1
          ? null
          : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
      })
      .filter(Boolean),
  );
  return { body: match[3], headers, httpStatus };
}

const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Back-off before the next `gh` attempt: `Retry-After` (seconds) wins, then
 * `X-RateLimit-Reset` (epoch seconds; delay = reset - now, jittered so a
 * fleet of callers does not stampede at the reset instant), else exponential.
 * Every branch is capped at MAX_RETRY_DELAY_MS.
 */
function retryDelayMs(
  headers,
  attempt,
  { now = Date.now, random = Math.random } = {},
) {
  const retryAfter = Number(headers?.["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0)
    return Math.min(retryAfter * 1_000, MAX_RETRY_DELAY_MS);
  const reset = Number(headers?.["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) {
    const untilReset = Math.max(0, reset * 1_000 - now());
    const jitter = Math.floor(random() * 1_000);
    return Math.min(untilReset + jitter, MAX_RETRY_DELAY_MS);
  }
  return Math.min(2 ** (attempt + 1) * 1_000, MAX_RETRY_DELAY_MS);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ghJson(exec, args, input, { sleep = defaultSleep } = {}) {
  const command = args
    .filter((arg) => arg !== "--include")
    .slice(0, 2)
    .join(" ");
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const r =
      (await exec("gh", args, {
        encoding: "utf8",
        stdio:
          input != null ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        input: input != null ? input : undefined,
      })) ?? {};
    const status = r.status ?? r.exitCode ?? null;
    const response = ghResponse(text(r.stdout));
    const stdout = response.body;
    const stderr =
      text(r.stderr) || (r.error ? String(r.error.message ?? r.error) : "");
    if (status !== 0) {
      let message = `gh ${command} failed (status ${status})`;
      // The HTTP status line from `--include` is the fallback when the JSON
      // body carries no `status` (GraphQL errors, some 429 bodies) so those
      // still key rate-limit retries and named failures correctly.
      let apiStatus = response.httpStatus ?? status;
      let secondaryRateLimit = false;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.message) message = `github api: ${parsed.message}`;
        // `gh` reports the HTTP status as a string ("401"); a raw REST error
        // body may carry a number. Accept either — the claim path keys its
        // named failures off this value.
        const parsedStatus = Number(parsed?.status);
        if (Number.isInteger(parsedStatus) && parsedStatus > 0)
          apiStatus = parsedStatus;
        secondaryRateLimit =
          apiStatus === 429 ||
          (apiStatus === 403 && /secondary rate limit/i.test(parsed?.message));
      } catch {
        if (stderr) message = `${message}: ${stderr.trim()}`;
      }
      if (secondaryRateLimit && attempt < 2) {
        await sleep(retryDelayMs(response.headers, attempt));
        continue;
      }
      throw new ControlPlaneError(message, {
        status: apiStatus,
        cause: r.error,
      });
    }
    if (!stdout.trim()) return {};
    try {
      return JSON.parse(stdout);
    } catch (cause) {
      throw new ControlPlaneError(`gh ${command} returned invalid JSON`, {
        status: 0,
        cause,
      });
    }
  }
}

/** Parse `owner/repo#42`, `#42`, or `42` (the last two need a default repo). */
export function parseIssueIdentifier(identifier, defaultRepo) {
  const raw = String(identifier ?? "").trim();
  const full = raw.match(/^([^/#\s]+\/[^/#\s]+)#(\d+)$/);
  if (full) return { repo: full[1], number: Number(full[2]) };
  const num = raw.match(/^#?(\d+)$/);
  if (num && defaultRepo) return { repo: defaultRepo, number: Number(num[1]) };
  throw new ControlPlaneError(
    `not a GitHub issue identifier: ${identifier} (want owner/repo#N)`,
  );
}

export function issueIdentifier(repo, number) {
  return `${repo}#${number}`;
}

function resolveLabelNames(currentNames, { add = [], remove = [] } = {}) {
  const dropped = new Set(remove);
  const kept = currentNames.filter((n) => !dropped.has(n));
  return [...new Set([...kept, ...add])];
}

function stateType(name) {
  const n = String(name ?? "").toLowerCase();
  if (n === "done") return "completed";
  if (n === "triage" || n === "todo") return "unstarted";
  return "started";
}

export function githubPolicyStanza({
  repo = "OWNER/REPO",
  teams,
  project = DEFAULT_PROJECT,
  statusField = DEFAULT_STATUS_FIELD,
  includeKind = true,
} = {}) {
  const github = {
    repo,
    teams: teams ?? { DEMO: repo },
    project,
    statusField,
  };
  return includeKind ? { kind: "github", github } : { github };
}

/** `controlPlane.github` from `<root>/config/policy.yaml`, or `{}`. */
export function readGithubPolicy(root) {
  try {
    const policy = Bun.YAML.parse(
      readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
    );
    const gh = policy?.controlPlane?.github ?? {};
    return {
      kind: policy?.controlPlane?.kind,
      repo: gh.repo ?? null,
      teams: gh.teams ?? {},
      project: gh.project ?? DEFAULT_PROJECT,
      statusField: gh.statusField ?? DEFAULT_STATUS_FIELD,
    };
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Write / merge GitHub Issues control-plane defaults into
 * `<root>/config/policy.yaml`. Idempotent: existing keys besides
 * `controlPlane` are preserved.
 *
 * `includeKind: false` (WM-1046) merges only the `controlPlane.github`
 * sub-stanza and leaves an existing `controlPlane.kind` exactly as it was —
 * or absent, if it was absent. `kind` is the workspace-wide default every
 * repo without its own `control_plane:` in repos.yaml inherits, so touching
 * it is a much bigger blast radius than the one repo `--repo` named.
 */
export function writeGithubControlPlanePolicy(root, opts = {}) {
  const { includeKind = true, ...stanzaOpts } = opts;
  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const policyPath = path.join(configDir, "policy.yaml");
  let existing = {};
  try {
    existing = Bun.YAML.parse(readFileSync(policyPath, "utf8")) ?? {};
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  const stanza = githubPolicyStanza({ ...stanzaOpts, includeKind });
  const controlPlane = includeKind
    ? stanza
    : { ...(existing.controlPlane ?? {}), github: stanza.github };
  const next = { ...existing, controlPlane };
  const yaml = Bun.YAML.stringify(next);
  writeFileSync(
    policyPath,
    `# Generated by factory init --control-plane github (WM-798).\n${yaml.endsWith("\n") ? yaml : `${yaml}\n`}`,
  );
  return { path: policyPath, controlPlane };
}

/** Repo name/github-slug/control_plane summary from `<root>/config/repos.yaml`, or `[]` if absent. */
function readReposYamlSummary(root) {
  const file = path.join(root, "config", "repos.yaml");
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return (parsed?.repos ?? []).map((e) => ({
    name: e?.name,
    github: e?.github ?? null,
    controlPlane: e?.control_plane ?? null,
  }));
}

const REPOS_ENTRY_RE = /^ {2}- name:\s*(\S+)/;
const GITHUB_FIELD_RE = /^ {4}github:\s*([^\s#]+)/;
const CONTROL_PLANE_RE = /^ {4}control_plane:\s*(\S+)/;
const CONTROL_PLANE_COMMENT_RE = /^ {4}#\s*control_plane:/;

/**
 * Set `control_plane: github` on the ONE `config/repos.yaml` entry whose
 * `github:` field is exactly `repo` (WM-1046) — a line-level splice, not a
 * parse/stringify round-trip, so every other line (including the operator's
 * own comments) is byte-identical. Returns `null` when repos.yaml is absent
 * or no entry matches; callers then fall back to the workspace default.
 */
export function setRepoControlPlaneGithub(root, repo) {
  const file = path.join(root, "config", "repos.yaml");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const lines = text.split("\n");
  const starts = [];
  lines.forEach((l, i) => {
    if (REPOS_ENTRY_RE.test(l)) starts.push(i);
  });
  let target = null;
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    for (let j = begin; j < end; j++) {
      const m = GITHUB_FIELD_RE.exec(lines[j]);
      if (m && m[1] === repo) {
        target = { begin, end, githubLineIdx: j };
        break;
      }
    }
    if (target) break;
  }
  if (!target) return null;
  const name = REPOS_ENTRY_RE.exec(lines[target.begin])[1];

  for (let i = target.begin; i < target.end; i++) {
    const active = CONTROL_PLANE_RE.exec(lines[i]);
    if (active) {
      if (active[1] === "github") return { name, changed: false };
      lines[i] = "    control_plane: github";
      writeFileSync(file, lines.join("\n"));
      return { name, changed: true };
    }
    if (CONTROL_PLANE_COMMENT_RE.test(lines[i])) {
      lines[i] = "    control_plane: github";
      writeFileSync(file, lines.join("\n"));
      return { name, changed: true };
    }
  }
  lines.splice(target.githubLineIdx + 1, 0, "    control_plane: github");
  writeFileSync(file, lines.join("\n"));
  return { name, changed: true };
}

/**
 * @param {{
 *   exec?: Function,
 *   api?: Function,
 *   root?: string,
 *   repo?: string,
 *   teams?: Record<string, string>,
 *   project?: string,
 *   statusField?: string,
 *   now?: () => number,
 * }} [options]
 * @returns {import("./types.mjs").ControlPlane}
 */
export function githubControlPlane(options = {}) {
  const {
    exec = ghSpawn,
    api: apiOpt,
    root,
    repo: repoOpt,
    teams: teamsOpt,
    project: projectOpt,
    statusField: statusFieldOpt,
    now = () => Date.now(),
  } = options;

  const fromPolicy = root ? readGithubPolicy(root) : {};
  const teams = { ...(fromPolicy.teams ?? {}), ...(teamsOpt ?? {}) };
  const defaultRepo =
    repoOpt ?? fromPolicy.repo ?? Object.values(teams)[0] ?? null;
  const projectTitle = projectOpt ?? fromPolicy.project ?? DEFAULT_PROJECT;
  const statusFieldName =
    statusFieldOpt ?? fromPolicy.statusField ?? DEFAULT_STATUS_FIELD;
  const api = apiOpt ?? makeGhApi(exec);

  let projectCache = null;
  const repoLabelsCache = new Map();
  // Short-TTL memo of the Projects v2 board read (WM-1067). `projectItems`
  // re-paginates the whole board over GraphQL and is called synchronously on
  // the dispatch/queue path — every concurrent claim and status lookup used to
  // pay its own full board fetch, blocking the serve event loop under load.
  // Within this window they share ONE in-flight fetch instead. The window is
  // deliberately tiny: a few seconds of staleness is acceptable for status
  // reads, and any mutation that changes the board (adding an item, setting a
  // status) invalidates the memo immediately below, so the only staleness is
  // from writes made through a *different* client within the window.
  const PROJECT_ITEMS_TTL_MS = 3000;
  let projectItemsCache = null; // { at: number, promise: Promise<{project, items}> }

  async function call(method, pathName, opts) {
    try {
      const result = await Promise.resolve(api(method, pathName, opts));
      const isGraphql =
        pathName === "graphql" ||
        pathName === "/graphql" ||
        method === "GRAPHQL";
      if (isGraphql) {
        if (result?.errors?.length)
          throw new ControlPlaneError(
            result.errors[0]?.message ?? "github graphql error",
          );
        return result?.data ?? result;
      }
      return result;
    } catch (cause) {
      if (cause instanceof ControlPlaneError) throw cause;
      throw new ControlPlaneError(
        cause?.message ? String(cause.message) : "github api failed",
        { cause, status: cause?.status ?? null },
      );
    }
  }

  // 401 counts too: `gh` answers an App installation token on an endpoint that
  // needs a user identity with "Requires authentication", not a 403. Both are
  // "this credential may not do this", so both get the named requirement
  // instead of a bare `github api: …` — and both still fail closed.
  function isPermissionFailure(error) {
    return (
      error instanceof ControlPlaneError &&
      (error.status === 403 ||
        error.status === 401 ||
        /resource not accessible by integration|forbidden|permission|requires authentication|bad credentials/i.test(
          error.message,
        ))
    );
  }

  async function claimStep(action, requirement, operation) {
    try {
      return await operation();
    } catch (cause) {
      if (!isPermissionFailure(cause)) throw cause;
      throw new ControlPlaneError(
        `github claim: ${action} requires ${requirement}: ${cause.message}`,
        { status: cause.status ?? 403, cause },
      );
    }
  }

  function repoForTeam(team) {
    if (!team) throw new ControlPlaneError("listDispatchable requires team");
    if (teams[team]) return teams[team];
    if (String(team).includes("/")) return team;
    if (defaultRepo) return defaultRepo;
    throw new ControlPlaneError(`no GitHub repo bound to team ${team}`);
  }

  function teamKeyForRepo(repoName) {
    const hit = Object.entries(teams).find(([, r]) => r === repoName);
    return { key: hit ? hit[0] : repoName };
  }

  function locate(identifier) {
    return parseIssueIdentifier(identifier, defaultRepo);
  }

  async function repoLabels(repo) {
    if (!repoLabelsCache.has(repo)) {
      const promise = listAllPages(call, `repos/${repo}/labels`);
      // A rejected read (403 mid token refresh, timeout, rate limit) must not
      // be replayed to every later file()/claim()/setLabels() until restart:
      // drop the memo so the next caller retries instead of inheriting it.
      promise.catch(() => {
        if (repoLabelsCache.get(repo) === promise) repoLabelsCache.delete(repo);
      });
      repoLabelsCache.set(repo, promise);
    }
    return repoLabelsCache.get(repo);
  }

  async function requireLabelsExist(repo, names) {
    const bad = validateLabels(names);
    if (bad.length)
      throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
    if (!names.length) return;
    const findMissing = (all) =>
      names.filter((n) => !all.some((l) => l.name === n));
    let missing = findMissing(await repoLabels(repo));
    if (missing.length) {
      // The memo may predate `factory init` creating the label: re-read once
      // before refusing so a fresh label takes effect without restarting serve.
      repoLabelsCache.delete(repo);
      missing = findMissing(await repoLabels(repo));
    }
    if (missing.length)
      throw new ControlPlaneError(
        `label(s) do not exist in this workspace: ${missing.join(", ")}\n` +
          `  fix: factory init --control-plane github --repo ${repo}`,
      );
  }

  async function loadProject() {
    if (projectCache) return projectCache;
    // GitHub's `projectsV2(query:)` is a search, not an exact-title filter.
    // Never accept its first partial match: doing so makes a misspelled board
    // title silently query a different board and report an empty queue.
    const pick = (nodes) => (nodes ?? []).find((p) => p.title === projectTitle);

    let node = null;
    if (defaultRepo && defaultRepo.includes("/")) {
      const [owner, name] = defaultRepo.split("/");
      const d = await call("POST", "graphql", {
        body: {
          query: FIND_REPO_PROJECT,
          variables: {
            owner,
            name,
            title: projectTitle,
            statusField: statusFieldName,
          },
        },
      });
      node = pick(d?.repository?.projectsV2?.nodes);
    }
    if (!node) {
      const d = await call("POST", "graphql", {
        body: {
          query: FIND_VIEWER_PROJECT,
          variables: { title: projectTitle, statusField: statusFieldName },
        },
      });
      node = pick(d?.viewer?.projectsV2?.nodes);
    }
    if (!node)
      throw new ControlPlaneError(`no GitHub Project titled "${projectTitle}"`);
    const field = node.field;
    if (!field?.id || !Array.isArray(field.options))
      throw new ControlPlaneError(
        `project "${projectTitle}" has no "${statusFieldName}" single-select field`,
      );
    projectCache = {
      id: node.id,
      title: node.title,
      fieldId: field.id,
      options: field.options,
    };
    return projectCache;
  }

  function optionFor(project, stateName) {
    const target = project.options.find(
      (o) => o.name.toLowerCase() === String(stateName).toLowerCase(),
    );
    if (!target)
      throw new ControlPlaneError(
        `no state "${stateName}" on team ${defaultRepo ?? project.title} — have: ${project.options.map((o) => o.name).join(", ")}`,
      );
    return target;
  }

  async function projectItems() {
    const project = await loadProject();
    const t = now();
    if (projectItemsCache && t - projectItemsCache.at < PROJECT_ITEMS_TTL_MS)
      return projectItemsCache.promise;
    const promise = (async () => {
      const items = [];
      let after = null;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const d = await call("POST", "graphql", {
          body: {
            query: PROJECT_ITEMS,
            variables: {
              projectId: project.id,
              statusField: statusFieldName,
              after,
            },
          },
        });
        const connection = d?.node?.items;
        items.push(...(connection?.nodes ?? []));
        if (!connection?.pageInfo?.hasNextPage) return { project, items };
        if (!connection.pageInfo.endCursor) {
          console.warn(
            "GitHub Projects v2 item pagination reported another page without an end cursor; results may be incomplete",
          );
          return { project, items };
        }
        after = connection.pageInfo.endCursor;
      }
      console.warn(
        `GitHub Projects v2 item pagination reached the ${MAX_PAGES}-page safety ceiling; results may be incomplete`,
      );
      return { project, items };
    })();
    projectItemsCache = { at: t, promise };
    // A rejected fetch must not be served for the rest of the TTL window: drop
    // the memo so the next caller retries instead of inheriting the failure.
    promise.catch(() => {
      if (projectItemsCache?.promise === promise) projectItemsCache = null;
    });
    return promise;
  }

  // `state` defaults to "open": the queue (Todo) and in-flight (In Progress)
  // reads only ever keep open issues — listTickets maps every closed issue to
  // "Done" and drops it unless a caller explicitly asks for finished tickets.
  // On a long-lived repo the closed backlog dwarfs the open set (1000+ issues,
  // 8+ pages of `state=all`), and this read runs synchronously inside the
  // dispatch claim lock, so paginating it stalled serve and starved claims
  // (WM-1061). Callers that need finished tickets pass state="all".
  async function listIssues(repo, state = "open") {
    const issuesByNumber = new Map();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const rows = await call("GET", `repos/${repo}/issues`, {
        query: {
          state,
          per_page: String(PAGE_SIZE),
          page: String(page),
        },
      });
      const issues = Array.isArray(rows) ? rows : [];
      for (const issue of issues) {
        if (!issue.pull_request && !issuesByNumber.has(issue.number))
          issuesByNumber.set(issue.number, issue);
      }
      if (issues.length < PAGE_SIZE) return [...issuesByNumber.values()];
    }
    console.warn(
      `GitHub issue pagination reached the ${MAX_PAGES}-page safety ceiling for ${repo}; results may be incomplete`,
    );
    return [...issuesByNumber.values()];
  }

  async function statusOf(repo, number) {
    const { project, items } = await projectItems();
    const item = items.find(
      (it) =>
        it.content?.number === number &&
        (it.content?.repository?.nameWithOwner ?? repo) === repo,
    );
    const name = item?.fieldValueByName?.name ?? null;
    const opt = name ? project.options.find((o) => o.name === name) : null;
    return { project, item, name, opt };
  }

  async function ensureProjectItem(repo, number, contentId) {
    const { project, items } = await projectItems();
    const existing = items.find(
      (it) =>
        it.content?.number === number &&
        (it.content?.repository?.nameWithOwner ?? repo) === repo,
    );
    if (existing) return { project, item: existing };
    const added = await call("POST", "graphql", {
      body: {
        query: ADD_PROJECT_ITEM,
        variables: { projectId: project.id, contentId },
      },
    });
    const item = added?.addProjectV2ItemById?.item;
    if (!item?.id)
      throw new ControlPlaneError(
        `failed to add ${issueIdentifier(repo, number)} to project ${project.title}`,
      );
    projectCache = null;
    projectItemsCache = null;
    return { project, item };
  }

  async function setStatus(repo, number, contentId, stateName) {
    const { project, item } = await ensureProjectItem(repo, number, contentId);
    const opt = optionFor(project, stateName);
    await call("POST", "graphql", {
      body: {
        query: SET_PROJECT_STATUS,
        variables: {
          projectId: project.id,
          itemId: item.id,
          fieldId: project.fieldId,
          optionId: opt.id,
        },
      },
    });
    projectCache = null;
    projectItemsCache = null;
    return opt;
  }

  /**
   * The repository-scoped closing-PR references for an issue, validated to
   * fail closed (WM-1050).
   *
   * Both the open-PR reaper guard (`hasOpenPullRequest`) and the merged-work
   * claim guard read this single edge. An unreadable transport error escapes
   * (never caught here); a truncated, malformed, or over-ceiling response
   * THROWS a ControlPlaneError. Neither caller may act on an inconclusive
   * relationship: returning a partial answer would let the reaper destroy a
   * live claim, or let a claim proceed on work that is already merged.
   */
  async function closingPullRequestRefs(repo, number) {
    const [owner, name] = repo.split("/");
    const d = await call("POST", "graphql", {
      body: {
        query: ISSUE_CLOSING_PULL_REQUESTS,
        variables: { owner, name, number },
      },
    });
    const issue = d?.repository?.issue;
    if (!issue)
      throw new ControlPlaneError(
        `could not resolve pull requests for ${issueIdentifier(repo, number)}`,
      );
    const refs = issue.closedByPullRequestsReferences;
    if (
      !refs ||
      !Array.isArray(refs.nodes) ||
      typeof refs.pageInfo?.hasNextPage !== "boolean" ||
      refs.nodes.some(
        (pr) =>
          typeof pr?.state !== "string" ||
          typeof pr?.repository?.nameWithOwner !== "string",
      )
    )
      throw new ControlPlaneError(
        `pull-request lookup for ${issueIdentifier(repo, number)} returned an inconclusive response`,
      );
    if (refs.pageInfo.hasNextPage)
      throw new ControlPlaneError(
        `pull-request lookup for ${issueIdentifier(repo, number)} exceeded the 20-reference safety ceiling`,
      );
    return refs.nodes;
  }

  /**
   * The first MERGED closing PR that lives in THIS repository, or null.
   *
   * Cross-repo references (a fork's PR, an unrelated "fixes" from another repo)
   * are ignored: only a merged PR in the issue's own repository is proof the
   * work shipped here.
   */
  function mergedClosingPullRequest(refs, repo) {
    return (
      refs.find(
        (pr) =>
          pr?.state === "MERGED" && pr?.repository?.nameWithOwner === repo,
      ) ?? null
    );
  }

  /**
   * number -> identifiers of its OPEN blockers (WM-1008).
   *
   * GitHub models this as issue dependencies (`blocked_by`). That endpoint is
   * comparatively new and not present on every deployment, so a 404/403 is
   * treated as "this repo has no dependency data" — every ticket unblocked —
   * rather than as a hard failure. That is the same direction Linear's
   * `openBlockers` takes for an issue whose relations were never fetched:
   * absent data must not silently gate the entire queue to empty.
   *
   * It deliberately does NOT fall back to parsing task lists out of issue
   * bodies. A prose-derived blocker that nobody can see in the UI is worse
   * than no blocker at all, because the ticket then stalls invisibly — the
   * exact failure WM-1024 was filed for.
   */
  async function blockedByMap(repo, issues) {
    const out = new Map();
    const openNumbers = new Set(
      issues.filter((i) => i.state !== "closed").map((i) => i.number),
    );
    for (const issue of issues) {
      if (issue.state === "closed") continue;
      let deps;
      try {
        deps = await call(
          "GET",
          `repos/${repo}/issues/${issue.number}/dependencies/blocked_by`,
          { query: { per_page: "100" } },
        );
      } catch (err) {
        if (
          err instanceof ControlPlaneError &&
          (err.status === 404 || err.status === 403 || err.status === 410)
        ) {
          out.set(issue.number, []);
          continue;
        }
        throw err;
      }
      const blockers = (Array.isArray(deps) ? deps : [])
        .filter((d) =>
          d.state ? d.state !== "closed" : openNumbers.has(d.number),
        )
        .map((d) => issueIdentifier(d.repository?.full_name ?? repo, d.number));
      out.set(issue.number, blockers);
    }
    return out;
  }

  function normalizeIssue(issue, repo, status, trust) {
    const labels = (issue.labels ?? []).map((l) => ({
      id: l.id != null ? String(l.id) : undefined,
      name: l.name,
    }));
    const assignee = issue.assignee
      ? {
          id: String(issue.assignee.id),
          name: issue.assignee.login ?? issue.assignee.name,
        }
      : null;
    const statusName =
      status?.name ?? (issue.state === "closed" ? "Done" : "Triage");
    const opt = status?.opt;
    return {
      id: issue.node_id ?? String(issue.id),
      identifier: issueIdentifier(repo, issue.number),
      title: issue.title,
      description: issue.body ?? "",
      url: issue.html_url ?? "",
      state: {
        id: opt?.id,
        name: statusName,
        type: stateType(statusName),
      },
      assignee,
      team: teamKeyForRepo(repo),
      project: { name: projectTitle },
      labels,
      priority: priorityFromLabels(labels),
      createdAt: issue.created_at ?? "",
      // GitHub has no workflow-state startedAt. Leaving it null makes the
      // reaper use updated_at, which advances on claim mutations/comments.
      startedAt: null,
      updatedAt: issue.updated_at ?? issue.created_at ?? null,
      lastCommentAt: null,
      // Populated by listTickets/listDispatchable, which resolve dependency
      // state in one batch. A single-issue read leaves it empty rather than
      // firing an extra request per getTicket call.
      blockedBy: issue.__blockedBy ?? [],
      // WM-879: trust facts for dispatch admission. Populated only by
      // getTicket (a single-issue read), same reasoning as blockedBy above —
      // listTickets/listDispatchable never pay the extra edit-history/pin
      // requests for a whole board. `controlPlaneKind` is the discriminator
      // planner.mjs uses to keep these gates github-only; Linear tickets
      // never carry it.
      controlPlaneKind: trust ? "github" : undefined,
      authorAssociation: trust ? (trust.authorAssociation ?? null) : undefined,
      lastEditorAssociation: trust
        ? (trust.lastEditorAssociation ?? null)
        : undefined,
      readyPinHash: trust ? (trust.readyPinHash ?? null) : undefined,
    };
  }

  /**
   * The association of whoever last edited the issue body, for WM-879 gate 1.
   * No edit since creation means the author is still the last editor — reuse
   * `authorAssociation` rather than an extra request. A ghost/deleted editor
   * (`editor` null), or the edit-history query itself failing (older `gh`
   * schema, transient API error, insufficient token scope), is unresolvable
   * and must fail closed — resolve to `null`, never throw and never assume
   * trust — same as any other unfetchable association.
   */
  async function resolveLastEditorAssociation(repo, number, issue) {
    const authorLogin = issue.user?.login ?? null;
    const authorAssociation = await resolveAuthorAssociation(
      repo,
      authorLogin,
      issue.author_association ?? null,
    );
    let edits;
    try {
      const [owner, name] = repo.split("/");
      const d = await call("POST", "graphql", {
        body: {
          query: ISSUE_LAST_EDITOR,
          variables: { owner, name, number },
        },
      });
      edits = d?.repository?.issue?.userContentEdits?.nodes ?? [];
    } catch {
      return { authorAssociation, lastEditorAssociation: null };
    }
    if (!edits.length)
      return { authorAssociation, lastEditorAssociation: authorAssociation };
    const editorLogin = edits[edits.length - 1]?.editor?.login ?? null;
    if (!editorLogin) return { authorAssociation, lastEditorAssociation: null };
    if (editorLogin === authorLogin)
      return { authorAssociation, lastEditorAssociation: authorAssociation };
    return {
      authorAssociation,
      lastEditorAssociation: await collaboratorAssociation(repo, editorLogin),
    };
  }

  /**
   * `author_association` is reported relative to the API *viewer*, not
   * absolutely. When the control plane authenticates as the GitHub App
   * installation (FACTORY_GH_APP_*), the App cannot see org membership, so
   * GitHub reports an org member — including the operator — as
   * `CONTRIBUTOR`, which would refuse every human-authored ticket with
   * `ticket_untrusted_author` and collapse dispatch supply. So whenever the
   * raw association is not already trusted, fall back to the same repo
   * permission approximation used for a non-author editor. A raw association
   * that is already trusted is kept as-is and costs no extra request.
   */
  async function resolveAuthorAssociation(repo, login, raw) {
    if (isTrustedAssociation(raw)) return raw;
    return (await collaboratorAssociation(repo, login)) ?? raw;
  }

  /**
   * A non-author editor's association is not directly queryable (GitHub's
   * `authorAssociation` is only meaningful in the context of a specific
   * issue/comment they authored), so it is approximated from their repo
   * permission level — admin/maintain/write reads as COLLABORATOR-trusted,
   * anything weaker or unfetchable reads as untrusted/unknown.
   *
   * The App installation needs repository `Metadata: read` for
   * `GET repos/{repo}/collaborators/{login}/permission`; a 403/404 (the App
   * not installed on the repo, or the login not a collaborator) resolves to
   * null/NONE and stays fail-closed.
   *
   * Cached per (repo, login) for the process lifetime — one plan reads the
   * author and possibly the same login as editor, and a scan reads the same
   * handful of operators over and over. Only resolved answers are cached; a
   * transient failure (null) is retried rather than pinned untrusted.
   */
  async function collaboratorAssociation(repo, login) {
    if (!login) return null;
    const key = `${repo} ${login}`;
    if (collaboratorAssociationCache.has(key))
      return collaboratorAssociationCache.get(key);
    let resolved = null;
    try {
      const perm = await call(
        "GET",
        `repos/${repo}/collaborators/${login}/permission`,
      );
      const level = perm?.permission;
      if (["admin", "maintain", "write"].includes(level))
        resolved = "COLLABORATOR";
      else if (level) resolved = "NONE";
    } catch {
      return null;
    }
    if (resolved) collaboratorAssociationCache.set(key, resolved);
    return resolved;
  }

  /**
   * The latest `ai:agent-ready` pin comment's hash, newest first (WM-879
   * gate 2). Absent entirely (never labeled through a pin-aware path, e.g. a
   * pre-rollout ticket) is not itself a refusal — only a MISMATCHED pin is —
   * so admission does not strand every already-ready ticket on rollout.
   */
  async function fetchReadyPin(repo, number) {
    let rows;
    try {
      rows = await listAllPages(
        call,
        `repos/${repo}/issues/${number}/comments`,
      );
    } catch {
      // Absence — including an unfetchable comment list — is not itself a
      // refusal (see the docstring above): only a mismatched pin is.
      return null;
    }
    const comments = Array.isArray(rows) ? rows : [];
    for (let i = comments.length - 1; i >= 0; i--) {
      const hash = parseReadyPin(comments[i].body);
      if (hash) return hash;
    }
    return null;
  }

  /**
   * Stamp/refresh the body-hash pin whenever a label change adds
   * `ai:agent-ready` (WM-879 gate 2) — labeling is triage-apply's only
   * mutation path, and re-labeling is the documented way to refresh a stale
   * pin after a legitimate maintainer body edit.
   */
  async function maybeStampReadyPin(repo, number, add, description) {
    if (!add?.includes(AGENT_READY_LABEL)) return;
    // WM-879 stored the pin as an HTML-comment-only body, which renders as an
    // empty comment bubble and was re-posted on every (re-)promotion — a wall
    // of blank duplicates on the public timeline. Keep exactly one pin comment:
    // a short human-readable line carries the hidden marker (parseReadyPin still
    // finds it), updated in place, with any older duplicates removed.
    const body = `Queued for automated implementation.\n\n${readyPinMarker(description)}`;
    let comments = [];
    try {
      const rows = await listAllPages(
        call,
        `repos/${repo}/issues/${number}/comments`,
      );
      comments = Array.isArray(rows) ? rows : [];
    } catch {
      // Comment list unreadable — fall back to a single POST below.
    }
    const pins = comments.filter((c) => parseReadyPin(c.body));
    if (pins.length === 0) {
      await call("POST", `repos/${repo}/issues/${number}/comments`, {
        body: { body: clampGithubBody(stampRun(body)) },
      });
      return;
    }
    // Newest pin survives (updated in place); older duplicates are pruned.
    const newest = pins[pins.length - 1];
    await call("PATCH", `repos/${repo}/issues/comments/${newest.id}`, {
      body: { body: clampGithubBody(stampRun(body)) },
    });
    for (const c of pins.slice(0, -1)) {
      try {
        await call("DELETE", `repos/${repo}/issues/comments/${c.id}`);
      } catch {
        // Best effort — a leftover duplicate is cosmetic, never a failure.
      }
    }
  }

  /**
   * GitHub has no priority field, so the protocol binds it to a `priority:N`
   * label (WM-1008). Absent means null, which sorts LAST — an unprovisioned
   * repo degrades to createdAt order instead of erroring or, worse, treating
   * every unlabelled ticket as most urgent.
   */
  function priorityFromLabels(labels) {
    for (const l of labels) {
      const m = /^priority:(\d+)$/.exec(l.name ?? "");
      if (m) return Number(m[1]);
    }
    return null;
  }

  async function fetchIssue(repo, number) {
    let issue;
    try {
      issue = await call("GET", `repos/${repo}/issues/${number}`);
    } catch (err) {
      if (
        err instanceof ControlPlaneError &&
        (err.status === 404 || /not found/i.test(err.message))
      )
        throw new ControlPlaneError(
          `no such issue: ${issueIdentifier(repo, number)}`,
        );
      throw err;
    }
    if (!issue || issue.message === "Not Found" || issue.pull_request)
      throw new ControlPlaneError(
        `no such issue: ${issueIdentifier(repo, number)}`,
      );
    const status = await statusOf(repo, number);
    return { issue, status, ticket: normalizeIssue(issue, repo, status) };
  }

  return {
    kind: "github",

    async getTicket(identifier) {
      const { repo, number } = locate(identifier);
      const { issue, status } = await fetchIssue(repo, number);
      const [trust, readyPinHash] = await Promise.all([
        resolveLastEditorAssociation(repo, number, issue),
        fetchReadyPin(repo, number),
      ]);
      return normalizeIssue(issue, repo, status, { ...trust, readyPinHash });
    },

    async listComments(identifier) {
      const { repo, number } = locate(identifier);
      await fetchIssue(repo, number);
      const rows = await listAllPages(
        call,
        `repos/${repo}/issues/${number}/comments`,
      );
      return rows.map((c) => ({
        id: c.id != null ? String(c.id) : undefined,
        body: c.body,
        createdAt: c.created_at ?? c.createdAt,
        user: c.user
          ? {
              id: c.user.id != null ? String(c.user.id) : undefined,
              name: c.user.login ?? c.user.name,
            }
          : null,
      }));
    },

    /**
     * @param {{ team: string, project?: string, states?: string[],
     *           resolveBlockers?: boolean }} [opts]
     *
     * `resolveBlockers` is OFF by default and that default is load-bearing
     * (WM-1044). GitHub has no bulk dependency read, so resolving blockers
     * costs one request per issue. Doing it for every open issue made a single
     * `listDispatchable` cost `1 + N` requests — measured at 6 for 6 issues,
     * which projects to ~251 on a 250-issue board and 15,000/hr against a
     * 5,000/hr limit. The factory would rate-limit itself within minutes and
     * take merges and PR creation down with it, since they share the budget.
     *
     * Callers that need the gate ask for it, and `listDispatchable` asks only
     * AFTER narrowing to real candidates.
     */
    async listTickets({
      team,
      project,
      states,
      resolveBlockers = false,
      includeFinished = false,
    } = {}) {
      if (!team) throw new ControlPlaneError("listTickets requires team");
      if (project && project !== projectTitle)
        throw new ControlPlaneError(
          `GitHub Project title mismatch: requested "${project}", configured "${projectTitle}"`,
        );
      const repo = repoForTeam(team);
      // Only pay for the closed backlog when a caller actually wants finished
      // tickets — either explicitly (includeFinished) or by naming a finished
      // status in `states`. Every other read (queue, in-flight) is open-only.
      const wantsFinished =
        includeFinished ||
        Boolean(
          states?.some((n) =>
            ["done", "canceled"].includes(String(n).toLowerCase()),
          ),
        );
      const issues = await listIssues(repo, wantsFinished ? "all" : "open");
      const { items } = await projectItems();
      const statusByNumber = new Map(
        items
          .filter(
            (it) => (it.content?.repository?.nameWithOwner ?? repo) === repo,
          )
          .map((it) => [it.content?.number, it.fieldValueByName?.name]),
      );
      const wanted = states?.length
        ? new Set(states.map((n) => n.toLowerCase()))
        : null;
      // Narrow FIRST; only then pay per-issue costs.
      const kept = [];
      for (const issue of issues) {
        // A closed issue is Done regardless of a stale board status. Reading
        // the board first let a closed issue whose Projects v2 status still
        // said "In Progress" be counted as in-flight — inflating the cap and
        // stalling dispatch (the board does not always move to Done on close).
        const statusName =
          issue.state === "closed"
            ? "Done"
            : (statusByNumber.get(issue.number) ?? "Triage");
        const name = String(statusName).toLowerCase();
        if (
          wanted
            ? !wanted.has(name)
            : !includeFinished && ["done", "canceled"].includes(name)
        )
          continue;
        kept.push({ issue, statusName });
      }
      const open = resolveBlockers
        ? await blockedByMap(
            repo,
            kept.map((k) => k.issue),
          )
        : null;
      return kept
        .map(({ issue, statusName }) =>
          normalizeIssue(
            { ...issue, __blockedBy: open?.get(issue.number) ?? [] },
            repo,
            { name: statusName, opt: null },
          ),
        )
        .sort(byQueueOrder);
    },

    async listDispatchable({ team, project } = {}) {
      if (!team) throw new ControlPlaneError("listDispatchable requires team");
      // Cheap predicate first — state, labels, assignee are already in the
      // issue list response and cost nothing extra. Only the survivors are
      // worth a dependency request each.
      const candidates = (
        await this.listTickets({ team, project, states: ["Todo"] })
      ).filter(
        (t) =>
          !t.assignee &&
          (t.labels ?? []).some((l) => l.name === AGENT_READY_LABEL),
      );
      if (!candidates.length) return [];
      const repo = repoForTeam(team);
      const open = await blockedByMap(
        repo,
        candidates.map((t) => ({
          number: Number(t.identifier.split("#")[1]),
          state: "open",
        })),
      );
      return candidates
        .map((t) => ({
          ...t,
          blockedBy: open.get(Number(t.identifier.split("#")[1])) ?? [],
        }))
        .filter((t) => t.blockedBy.length === 0);
    },

    async claim(identifier, { harness = "claude" } = {}) {
      const { repo, number } = locate(identifier);
      const { issue, ticket } = await fetchIssue(repo, number);

      // Before touching labels, assignee, or project status, reconcile an
      // issue whose implementation already merged (WM-1050). GitHub-backed
      // dispatch otherwise trusts an open issue's Todo status and
      // `ai:agent-ready` label even after its closing PR landed, so a shipped
      // ticket (e.g. #1004 after PR #1006) is claimed again and only discovers
      // the merged work after taking a worker slot.
      //
      // `closingPullRequestRefs` fails closed: a malformed, truncated, or
      // failed lookup THROWS and the claim never proceeds — it is safer to
      // skip a claim than to re-work merged code or clobber a live claim.
      const refs = await closingPullRequestRefs(repo, number);
      const merged = mergedClosingPullRequest(refs, repo);
      if (merged) {
        const remove = [
          IN_PROGRESS_LABEL,
          AGENT_READY_LABEL,
          BLOCKED_LABEL,
          ...(ticket.labels ?? [])
            .map((l) => l.name)
            .filter((n) => n.startsWith("agent:")),
        ];
        const nextLabels = resolveLabelNames(
          (ticket.labels ?? []).map((l) => l.name),
          { remove },
        );
        await call("PUT", `repos/${repo}/issues/${number}/labels`, {
          body: { labels: nextLabels },
        });
        await call("PATCH", `repos/${repo}/issues/${number}`, {
          body: { assignees: [], state: "closed" },
        });
        await setStatus(repo, number, issue.node_id ?? ticket.id, "Done");
        const oid = merged.mergeCommit?.oid;
        const evidence = [
          `Skipped dispatch: closing PR #${merged.number} is already merged` +
            `${merged.url ? ` (${merged.url})` : ""}.`,
          oid ? `Merge commit \`${oid}\`.` : null,
          `Reconciled to Done, claim labels removed, left unassigned.`,
        ]
          .filter(Boolean)
          .join("\n\n");
        await call("POST", `repos/${repo}/issues/${number}/comments`, {
          body: { body: stampRun(evidence) },
        });
        return {
          ok: false,
          identifier: issueIdentifier(repo, number),
          assignee: null,
          why: `closing PR #${merged.number} already merged`,
        };
      }

      // GitHub App installation tokens cannot call REST GET /user: an
      // installation is not an assignable user. makeGhApi deliberately sends
      // this one request through the ambient gh user credential, then returns
      // to App auth for labels, assignment and Projects v2 state.
      const me = await claimStep(
        "resolve the assignable lock owner",
        "ambient GitHub user authentication (`gh auth login`); installation tokens cannot access GET /user",
        () => call("GET", "user"),
      );
      if (!me?.id)
        throw new ControlPlaneError("github viewer is not available");
      const { add, remove } = claimLabels(
        (ticket.labels ?? []).map((l) => l.name),
        harness,
      );
      await requireLabelsExist(repo, add);
      const nextLabels = resolveLabelNames(
        (ticket.labels ?? []).map((l) => l.name),
        { add, remove },
      );
      await claimStep(
        "update issue labels",
        'GitHub App repository permission "Issues: write"',
        () =>
          call("PUT", `repos/${repo}/issues/${number}/labels`, {
            body: { labels: nextLabels },
          }),
      );
      await claimStep(
        "assign the lock owner",
        'GitHub App repository permission "Issues: write"',
        () =>
          call("PATCH", `repos/${repo}/issues/${number}`, {
            body: { assignees: [me.login], state: "open" },
          }),
      );
      await claimStep(
        "set the Projects v2 status",
        'GitHub App organization permission "Projects: write"',
        () =>
          setStatus(repo, number, issue.node_id ?? ticket.id, "In Progress"),
      );

      const back = await claimStep(
        "read back the assignee",
        'GitHub App repository permission "Issues: read"',
        () => call("GET", `repos/${repo}/issues/${number}`),
      );
      const assigneeId =
        back?.assignee?.id != null ? String(back.assignee.id) : null;
      return {
        ok: assigneeId === String(me.id),
        identifier: issueIdentifier(repo, number),
        assignee: back?.assignee?.login ?? back?.assignee?.name ?? null,
      };
    },

    async comment(identifier, body) {
      if (!body) throw new ControlPlaneError(`comment requires a body`);
      const { repo, number } = locate(identifier);
      await fetchIssue(repo, number);
      await call("POST", `repos/${repo}/issues/${number}/comments`, {
        body: { body: clampGithubBody(stampRun(body)) },
      });
    },

    async transition(
      identifier,
      state,
      { add = [], remove = [], unassign } = {},
    ) {
      if (!state && !add.length && !remove.length && !unassign)
        throw new ControlPlaneError(
          `transition requires a state name or a label change`,
        );
      const { repo, number } = locate(identifier);
      const { issue, ticket } = await fetchIssue(repo, number);
      if (state)
        await setStatus(repo, number, issue.node_id ?? ticket.id, state);
      if (add.length || remove.length) {
        await requireLabelsExist(repo, add);
        const nextLabels = resolveLabelNames(
          (ticket.labels ?? []).map((l) => l.name),
          { add, remove },
        );
        await call("PUT", `repos/${repo}/issues/${number}/labels`, {
          body: { labels: nextLabels },
        });
        await maybeStampReadyPin(repo, number, add, issue.body ?? "");
      }
      const patch = {};
      if (unassign) patch.assignees = [];
      if (state)
        patch.state = state.toLowerCase() === "done" ? "closed" : "open";
      if (Object.keys(patch).length)
        await call("PATCH", `repos/${repo}/issues/${number}`, { body: patch });
    },

    async setLabels(identifier, { add = [], remove = [] } = {}) {
      const { repo, number } = locate(identifier);
      const { issue, ticket } = await fetchIssue(repo, number);
      if (!add.length && !remove.length) return;
      await requireLabelsExist(repo, add);
      const nextLabels = resolveLabelNames(
        (ticket.labels ?? []).map((l) => l.name),
        { add, remove },
      );
      await call("PUT", `repos/${repo}/issues/${number}/labels`, {
        body: { labels: nextLabels },
      });
      await maybeStampReadyPin(repo, number, add, issue.body ?? "");
    },

    async hasOpenPullRequest(identifier) {
      const { repo, number } = locate(identifier);
      // `closingPullRequestRefs` deliberately lets transport/schema failures
      // escape. Returning false on an unreadable edge would let the reaper
      // destroy a live claim.
      const refs = await closingPullRequestRefs(repo, number);
      return refs.some(
        (pr) => pr?.state === "OPEN" && pr?.repository?.nameWithOwner === repo,
      );
    },

    /**
     * `dedupeKey` is opt-in: it is stored in the created issue as an opaque
     * HTML comment and probes for that exact marker before POSTing.  Callers
     * which already have a stable exact title can instead opt into that probe
     * with `matchTitle` (true uses `title`; a string names the title to find).
     * Neither probe runs unless explicitly requested, so normal filing keeps
     * its current duplicate-title behaviour.
     */
    async file({
      team,
      title,
      body = "",
      labels = [],
      state = "Triage",
      projectId: _projectId,
      dedupeKey,
      matchTitle = false,
    } = {}) {
      if (!title) throw new ControlPlaneError("file requires title");
      // GitHub tickets are repository-scoped rather than team-scoped. A
      // configured default repository therefore supplies the destination for
      // factory findings that have no Linear-style team key.
      const repo = team ? repoForTeam(team) : defaultRepo;
      if (!repo)
        throw new ControlPlaneError(
          "file requires team or a configured default repository",
        );
      await requireLabelsExist(repo, labels);
      const key =
        typeof dedupeKey === "string" && dedupeKey.trim()
          ? dedupeKey.trim()
          : null;
      const titleToMatch =
        matchTitle === true
          ? title
          : typeof matchTitle === "string" && matchTitle.trim()
            ? matchTitle.trim()
            : null;
      const marker = key
        ? `<!-- factory:dedupe-key ${encodeURIComponent(key)} -->`
        : null;
      let created = null;

      // This is one bounded search instead of listing the repository's whole
      // issue history. It remains opt-in because even a cheap remote read is
      // unnecessary for ordinary filing.
      if (marker || titleToMatch) {
        const terms = [`repo:${repo}`, "is:issue"];
        if (marker)
          terms.push(`in:body ${JSON.stringify(encodeURIComponent(key))}`);
        // The key is percent-encoded (it is stored encoded in the marker).
        // The title is searched as typed, so it is not encoded; instead any
        // `"` / `\` is dropped from the term so it cannot close the quoted
        // phrase and smuggle in qualifiers (e.g. a second `repo:`).  The
        // exact-title and repository_url post-filters below make the probe
        // strict again and ignore any hit from another repository.
        if (titleToMatch)
          terms.push(
            `in:title ${JSON.stringify(titleToMatch.replace(/["\\]/g, ""))}`,
          );
        const found = await call("GET", "search/issues", {
          query: { q: terms.join(" "), per_page: "100" },
        });
        created = (Array.isArray(found?.items) ? found.items : []).find(
          (issue) =>
            typeof issue?.repository_url === "string" &&
            issue.repository_url.endsWith(`/${repo}`) &&
            (!marker || issue.body?.includes(marker)) &&
            (!titleToMatch || issue.title === titleToMatch),
        );
      }
      if (!created) {
        const issueBody = marker ? `${marker}\n${body}` : body;
        created = await call("POST", `repos/${repo}/issues`, {
          body: {
            title,
            body: clampGithubBody(stampRun(issueBody)),
            labels,
          },
        });
      }
      if (!created?.number)
        throw new ControlPlaneError("issueCreate returned no issue");
      const filed = {
        identifier: issueIdentifier(repo, created.number),
        url: created.html_url ?? "",
      };
      try {
        await setStatus(
          repo,
          created.number,
          created.node_id ?? String(created.id),
          state,
        );
        if (state.toLowerCase() === "done")
          await call("PATCH", `repos/${repo}/issues/${created.number}`, {
            body: { state: "closed" },
          });
      } catch (err) {
        return {
          ...filed,
          warnings: [
            `${filed.identifier} exists, but a follow-up write failed: ${err?.message ?? String(err)}`,
          ],
        };
      }
      return filed;
    },

    async appendDetail(identifier, markdown) {
      const { repo, number } = locate(identifier);
      const { issue } = await fetchIssue(repo, number);
      const { description, appended } = appendIssueDetail(
        issue.body ?? "",
        markdown,
      );
      if (!appended) return { appended: false };
      const current = issue.body ?? "";
      const rawDetail = String(markdown).trim();
      const suffix = description.slice(current.length);
      const separator = suffix.slice(0, -rawDetail.length - 1);
      // Byte budget, matching clampGithubBody (never smaller than chars).
      const available =
        GITHUB_BODY_MAX_LENGTH -
        Buffer.byteLength(current, "utf8") -
        Buffer.byteLength(separator, "utf8") -
        1;
      if (available <= 0) return { appended: false, reason: "body_full" };
      const detail = clampGithubBody(rawDetail, { max: available });
      if (!detail) return { appended: false, reason: "body_full" };
      await call("PATCH", `repos/${repo}/issues/${number}`, {
        body: { body: `${current}${separator}${detail}\n` },
      });
      return { appended: true };
    },

    async raw(query, variables = {}) {
      if (typeof query === "string" && query.trim().startsWith("/")) {
        return call("GET", query.trim().replace(/^\//, ""), {
          query: variables,
        });
      }
      return call("POST", "graphql", {
        body: { query, variables },
      });
    },
  };
}

/**
 * The protocol's full label set, with colours and descriptions (WM-1009).
 *
 * GitHub labels are per-REPOSITORY, not per-org, so every managed repo needs
 * all of these. Hand-creating ~20 labels with exactly the right spelling is
 * not a quickstart; one typo surfaces much later as a runtime error inside an
 * unattended loop, which is why `factory init` provisions them.
 *
 * Colours are grouped so a human scanning the issue list can read lifecycle
 * from colour alone: ai:* blue-greys, type:* by kind, source:* muted,
 * priority:* a red-to-green ramp.
 */
export const PROTOCOL_LABELS = Object.freeze([
  ["ai:agent-ready", "1d76db", "Specified and waiting to be picked up"],
  ["ai:in-progress", "0e8a16", "An agent holds the claim"],
  ["ai:needs-review", "5319e7", "PR is up; the merge stage owns it"],
  ["ai:blocked", "b60205", "Waiting on a human"],
  ["ai:escalated", "d93f0b", "Security-relevant diff; a human must merge"],
  ["type:bug", "d73a4a", "Something is broken"],
  ["type:feature", "0075ca", "New capability"],
  ["type:ui-ux", "c5def5", "Interface or interaction change"],
  ["type:security", "b60205", "Security-relevant"],
  ["type:performance", "fbca04", "Speed or resource use"],
  ["type:maintenance", "cfd3d7", "Upkeep, refactors, dependencies"],
  ["type:docs", "0052cc", "Documentation"],
  ["type:a11y", "006b75", "Accessibility"],
  ["source:agent", "ededed", "Discovered by an agent"],
  ["source:human", "ededed", "Requested by a human"],
  ["source:sentry", "ededed", "From a Sentry issue"],
  ["source:client-support", "ededed", "From client support"],
  ["priority:0", "b60205", "Urgent"],
  ["priority:1", "d93f0b", "High"],
  ["priority:2", "fbca04", "Medium"],
  ["priority:3", "0e8a16", "Low"],
  ["priority:4", "cfd3d7", "None"],
  ["tier:light", "c2e0c6", "Model-tier override: light"],
  ["tier:standard", "bfd4f2", "Model-tier override: standard"],
  ["tier:strong", "f9d0c4", "Model-tier override: strong"],
]);

/** `agent:<harness>` labels for the harnesses the factory can dispatch to. */
export const AGENT_LABELS = Object.freeze([
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "pi",
]);

/** Every label name `factory init` provisions, in creation order. */
export function protocolLabelSpecs() {
  return [
    ...PROTOCOL_LABELS.map(([name, color, description]) => ({
      name,
      color,
      description,
    })),
    ...AGENT_LABELS.map((h) => ({
      name: `agent:${h}`,
      color: "e4e669",
      description: `Claimed by the ${h} harness`,
    })),
  ];
}

/**
 * Create the protocol labels and the Projects v2 board in `repo` (WM-1009).
 *
 * Idempotent by construction: existing labels are LEFT ALONE, never patched.
 * A maintainer who recoloured `type:bug` or rewrote a description meant it,
 * and an init that silently reverted their choice on every run would be a
 * worse bug than the missing label this fixes.
 *
 * @param {(m:string,p:string,o?:object)=>Promise<any>} call  gh api seam
 * @param {string} repo owner/name
 * @param {{ dryRun?: boolean, project?: string, statusField?: string }} opts
 */
export async function provisionGithubRepo(call, repo, opts = {}) {
  const {
    dryRun = false,
    project = DEFAULT_PROJECT,
    statusField = DEFAULT_STATUS_FIELD,
  } = opts;
  const report = { created: [], existed: [], board: null, dryRun };

  let existing;
  try {
    existing = await listAllPages(call, `repos/${repo}/labels`);
  } catch (err) {
    throw scopeHint(err, repo, "repo");
  }
  const have = new Set(existing.map((l) => l.name));

  for (const spec of protocolLabelSpecs()) {
    if (have.has(spec.name)) {
      report.existed.push(spec.name);
      continue;
    }
    report.created.push(spec.name);
    if (dryRun) continue;
    try {
      await call("POST", `repos/${repo}/labels`, { body: spec });
    } catch (err) {
      // A concurrent init (or a human) may have created it between the list
      // and the write. That is success, not a conflict worth failing on.
      if (err instanceof ControlPlaneError && err.status === 422) continue;
      throw scopeHint(err, repo, "repo");
    }
  }

  report.board = await provisionBoard(call, repo, {
    dryRun,
    project,
    statusField,
  });
  return report;
}

/**
 * Ensure the Projects v2 board exists with exactly the factory's states.
 *
 * A board whose Status options do NOT match fails loudly rather than being
 * half-configured: a missing option means `transition()` to that state throws
 * later, inside an unattended loop, where it reads as a tracker outage rather
 * than a setup mistake.
 */
async function provisionBoard(call, repo, { dryRun, project, statusField }) {
  const [owner] = repo.split("/");
  let found;
  try {
    const d = await call("POST", "graphql", {
      body: {
        query: FIND_REPO_PROJECT,
        variables: {
          owner,
          name: repo.split("/")[1],
          title: project,
          statusField,
        },
      },
    });
    found = (d?.data ?? d)?.repository?.projectsV2?.nodes?.find(
      (p) => p.title === project,
    );
  } catch (err) {
    throw scopeHint(err, repo, "project");
  }

  if (!found) {
    return dryRun
      ? { action: "would-create", title: project }
      : {
          action: "manual",
          title: project,
          statusField,
          options: [...GITHUB_FACTORY_STATES],
          // Projects v2 creation needs an owner id and a field-definition
          // mutation per option; doing it blind against the wrong owner
          // (user vs org) creates a board in the wrong place that then has to
          // be found and deleted. Report precisely what to make instead.
          hint: `Create a Projects v2 board named ${JSON.stringify(project)} on ${owner} with a single-select field ${JSON.stringify(statusField)} whose options are exactly: ${GITHUB_FACTORY_STATES.join(", ")}`,
        };
  }

  const options = (found.field?.options ?? []).map((o) => o.name);
  const missing = GITHUB_FACTORY_STATES.filter((s) => !options.includes(s));
  if (missing.length) {
    throw new ControlPlaneError(
      `project ${JSON.stringify(project)} field ${JSON.stringify(statusField)} is missing option(s): ${missing.join(", ")} — have: ${options.join(", ") || "(none)"}`,
    );
  }
  return { action: "exists", title: project, options };
}

/** Turn a permission failure into an error that names the scope needed. */
function scopeHint(err, repo, scope) {
  if (
    err instanceof ControlPlaneError &&
    (err.status === 403 || err.status === 404)
  ) {
    return new ControlPlaneError(
      `${err.message}\n  hint: the gh token needs the '${scope}' scope for ${repo}. Run: gh auth refresh -s ${scope}`,
      { status: err.status, cause: err },
    );
  }
  return err;
}

function print(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/** CLI: `factory init --control-plane github [--root DIR] [--repo owner/name]`. */
export async function runGithubInit(argv, { cwd = process.cwd(), api } = {}) {
  const args = argv[0] === "init" ? argv.slice(1) : argv;
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1 || i === args.length - 1) return fallback;
    return args[i + 1];
  };
  const controlPlane = flag("control-plane");
  if (!controlPlane) {
    fail(
      "factory init: specify --control-plane github\n" +
        "(Linear remains the default tracker; this command scaffolds GitHub Issues defaults.)",
    );
  }
  if (controlPlane !== "github") {
    fail(
      `factory init: unknown control plane ${JSON.stringify(controlPlane)} — only github is scaffolded (WM-798)`,
    );
  }
  const root = flag("root", cwd);
  const repo = flag("repo", "OWNER/REPO");
  const project = flag("project", DEFAULT_PROJECT);
  const statusField = flag("status-field", DEFAULT_STATUS_FIELD);
  const team = flag("team", "DEMO");
  const global = args.includes("--global");

  // `kind` is the workspace-wide default every repos.yaml entry without its
  // own `control_plane:` inherits (WM-1007). On a multi-repo root that moves
  // every one of them, so it needs explicit opt-in there — a 0-1 repo root
  // has nothing else to move, so it keeps today's single-repo behavior
  // (WM-1046).
  const reposYaml = readReposYamlSummary(root);
  let repoEntry = null;
  if (repo !== "OWNER/REPO") {
    repoEntry = setRepoControlPlaneGithub(root, repo);
    if (repoEntry) {
      print(
        repoEntry.changed
          ? `config/repos.yaml: set control_plane: github on repo "${repoEntry.name}".`
          : `config/repos.yaml: repo "${repoEntry.name}" already control_plane: github.`,
      );
    }
  }
  const includeKind = global || reposYaml.length <= 1;
  const otherInheritors = reposYaml
    .filter((e) => e.name !== repoEntry?.name && e.controlPlane == null)
    .map((e) => e.name);
  if (!includeKind) {
    print(
      `controlPlane.kind left unchanged (workspace has ${reposYaml.length} repos)` +
        (otherInheritors.length
          ? ` — pass --global to also move: ${otherInheritors.join(", ")}`
          : " — pass --global to change the workspace default"),
    );
  } else if (global && otherInheritors.length) {
    print(
      `--global: controlPlane.kind=github will also move: ${otherInheritors.join(", ")}`,
    );
  }

  const written = writeGithubControlPlanePolicy(root, {
    repo,
    teams: { [team]: repo },
    project,
    statusField,
    includeKind,
  });
  print(
    includeKind
      ? `Wrote ${written.path} (controlPlane.kind=github, repo=${repo}).`
      : `Wrote ${written.path} (controlPlane.github updated, controlPlane.kind unchanged, repo=${repo}).`,
  );

  // Nothing to provision against a placeholder — the operator has not said
  // which repo yet, so writing the policy is the whole job.
  if (repo === "OWNER/REPO") {
    print(
      `Next: re-run with --repo owner/name to create the protocol labels and check the ${JSON.stringify(project)} board.`,
    );
    return written;
  }

  const dryRun = args.includes("--dry-run");
  const call = api ?? makeGhApi();
  let report;
  try {
    report = await provisionGithubRepo(call, repo, {
      dryRun,
      project,
      statusField,
    });
  } catch (err) {
    // Writing the policy is the command's contract and it already succeeded.
    // Provisioning needs network + auth, and failing the whole command here
    // would break scaffolding a config offline — which is exactly what an
    // operator does before running `gh auth login`. Report and exit 0.
    print(`Labels/board: not provisioned — ${err.message}`);
    print(
      `  retry once authenticated: factory init --control-plane github --repo ${repo}`,
    );
    return written;
  }

  const verb = dryRun ? "would create" : "created";
  print(
    `Labels: ${verb} ${report.created.length}, already present ${report.existed.length}.`,
  );
  if (report.created.length) print(`  ${report.created.join(", ")}`);
  if (report.board?.action === "exists")
    print(`Board ${JSON.stringify(project)}: present with all Status options.`);
  else if (report.board?.action === "would-create")
    print(`Board ${JSON.stringify(project)}: missing (dry run).`);
  else if (report.board?.hint) print(`Board: ${report.board.hint}`);
  if (dryRun) print("(dry run — nothing was written to GitHub)");
  return { ...written, report };
}

if (import.meta.main) await runGithubInit(process.argv.slice(2));
