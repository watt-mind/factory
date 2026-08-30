/**
 * GitHub Forge — wraps the `gh` CLI (WM-836).
 *
 * A pure move of the `gh` invocations that used to live in ~13 modules. It
 * still shells out to `gh` (no Octokit); what changed is that argument
 * building, JSON parsing and failure handling happen in exactly one place and
 * the caller never sees the word `gh`.
 *
 * `exec` is the seam: it has `child_process.spawnSync`'s shape,
 * `(cmd, args, opts) => { status, stdout, stderr }`, so the existing test
 * recorders in `orchestrator/*.test.mjs` plug straight in and the contract
 * suite can drive the implementation with a fake `gh` and no network.
 *
 * Every `gh` read has an explicit 64 MiB output buffer. Commands expected to
 * exceed it must paginate or stream instead; a future buffer exhaustion is a
 * structured `forge_read_failed` ForgeError rather than a partial read.
 */
import { spawnSync } from "node:child_process";
import { ForgeError, PR_CHECK_FIELDS } from "./types.mjs";

const text = (v) =>
  v == null ? "" : Buffer.isBuffer(v) ? v.toString() : String(v);

const REST_PAGE_SIZE = 100;
const STATUS_PAGE_SIZE = 30;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
/** How long a hydrated `mergeable`/`mergeable_state` pair is reused. */
const HYDRATION_TTL_MS = 120_000;
const HYDRATION_CACHE_MAX = 2000;
/** Shared by every real (spawnSync-backed) forge instance in this process. */
const sharedHydration = new Map();

const pick = (obj, fields) =>
  fields?.length
    ? Object.fromEntries(fields.map((field) => [field, obj[field]]))
    : { ...obj };

function restPullToPr(pull) {
  const mergeable =
    pull?.mergeable === true
      ? "MERGEABLE"
      : pull?.mergeable === false
        ? "CONFLICTING"
        : "UNKNOWN";
  return {
    number: pull?.number,
    url: pull?.html_url,
    headRefName: pull?.head?.ref,
    headRefOid: pull?.head?.sha,
    baseRefName: pull?.base?.ref,
    isDraft: pull?.draft === true,
    title: pull?.title,
    body: pull?.body,
    labels: Array.isArray(pull?.labels) ? pull.labels : [],
    state: pull?.merged_at ? "MERGED" : String(pull?.state ?? "").toUpperCase(),
    mergedAt: pull?.merged_at,
    mergeable,
    mergeStateStatus: String(pull?.mergeable_state ?? "UNKNOWN").toUpperCase(),
  };
}

function checkBucket(state) {
  switch (state) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STALE":
    case "STARTUP_FAILURE":
      return "fail";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipping";
    case "CANCELLED":
      return "cancel";
    default:
      return "pending";
  }
}

function restChecks(checkRuns, statuses, { dedupe = true } = {}) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const legacy = Array.isArray(statuses) ? statuses : [];
  const newestBy = (rows, keyOf, timestampOf) => {
    const seen = new Set();
    return [...rows]
      .sort(
        (a, b) =>
          Date.parse(timestampOf(b) ?? 0) - Date.parse(timestampOf(a) ?? 0),
      )
      .filter((row) => {
        const key = keyOf(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
  // A workflow re-run creates a new check suite on the same commit. REST's
  // default `filter=latest` still returns both suites, while `gh pr checks`
  // keeps only the newest run for each check identity. Dedupe by check
  // suite: for each (name, app) identity keep every run of the newest suite,
  // so matrix siblings that share a name survive while older suites drop.
  // Runs without a suite id fall back to newest-by-identity.
  const latestRuns = dedupe ? latestSuiteRuns(runs) : runs;
  const latestStatuses = dedupe
    ? newestBy(
        legacy,
        (status) => status?.context ?? "",
        (status) => status?.created_at ?? status?.updated_at,
      )
    : legacy;
  return [
    ...latestRuns.map((run) => {
      const state = String(
        run?.conclusion ?? run?.status ?? "PENDING",
      ).toUpperCase();
      return {
        name: run?.name,
        bucket: checkBucket(state),
        state,
        appId: run?.app?.id ?? null,
        conclusion: run?.conclusion
          ? String(run.conclusion).toUpperCase()
          : null,
        status: run?.status ? String(run.status).toUpperCase() : null,
      };
    }),
    ...latestStatuses.map((status) => {
      const state = String(status?.state ?? "PENDING").toUpperCase();
      return {
        name: status?.context,
        bucket: checkBucket(state),
        state,
        appId: null,
        conclusion: state,
        status: state === "PENDING" ? "PENDING" : "COMPLETED",
      };
    }),
  ];
}

function latestSuiteRuns(runs) {
  const identityOf = (run) =>
    `${run?.name ?? ""}\0${run?.app?.id ?? run?.app?.slug ?? ""}`;
  const suiteOf = (run) => run?.check_suite?.id ?? null;
  const timestampOf = (run) =>
    Date.parse(run?.started_at ?? run?.completed_at ?? 0) || 0;
  const newest = new Map();
  for (const run of runs) {
    const key = identityOf(run);
    const current = newest.get(key);
    if (!current || timestampOf(run) > timestampOf(current))
      newest.set(key, run);
  }
  return runs.filter((run) => {
    const head = newest.get(identityOf(run));
    if (run === head) return true;
    const suite = suiteOf(run);
    return suite != null && suite === suiteOf(head);
  });
}

/**
 * @param {{
 *   exec?: (cmd: string, args: string[], opts: object) => { status?: number|null, exitCode?: number|null, stdout?: string|Buffer, stderr?: string|Buffer, error?: Error },
 *   hydrationTtlMs?: number, // mergeability cache TTL (tests)
 *   now?: () => number,      // clock for that TTL (tests)
 * }} [options]
 * @returns {import("./types.mjs").Forge}
 */
export function githubForge({
  exec = spawnSync,
  hydrationTtlMs = HYDRATION_TTL_MS,
  now = Date.now,
} = {}) {
  // Test fakes get a private cache so recorded call counts stay per-instance;
  // the real `gh` shares one so back-to-back loadForge() callers in a tick
  // (merge-scan lists open PRs twice) hydrate each head SHA once.
  const hydration = exec === spawnSync ? sharedHydration : new Map();
  /** Run `gh <args>`; throw ForgeError on non-zero exit or spawn failure. */
  function gh(args, { cwd, timeout } = {}) {
    const r =
      exec("gh", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        maxBuffer: GH_MAX_BUFFER,
      }) ?? {};
    // child_process shape first (`status`), Bun.spawnSync shape second
    // (`exitCode`); a spawn error (ENOENT) leaves both null and is a failure.
    const status = r.status ?? r.exitCode ?? null;
    const stdout = text(r.stdout);
    const stderr =
      text(r.stderr) || (r.error ? String(r.error.message ?? r.error) : "");
    if (status !== 0) {
      const bufferExceeded = r.error?.code === "ENOBUFS";
      const error = new ForgeError(
        `${bufferExceeded ? "forge_read_failed: " : ""}gh ${args.slice(0, 2).join(" ")} failed (status ${status})`,
        {
          status,
          stdout,
          stderr,
          cause: r.error,
        },
      );
      if (bufferExceeded) error.code = "forge_read_failed";
      throw error;
    }
    return stdout;
  }

  function ghJson(args, opts) {
    const out = gh(args, opts);
    try {
      return JSON.parse(out);
    } catch (cause) {
      throw new ForgeError(
        `gh ${args.slice(0, 2).join(" ")} returned invalid JSON`,
        {
          status: 0,
          stdout: out,
          cause,
        },
      );
    }
  }

  const resolvedRepos = new Map();

  function resolveRepo(repo, opts) {
    if (repo) return repo;
    const key = opts?.cwd ?? "";
    if (resolvedRepos.has(key)) return resolvedRepos.get(key);
    const resolved = ghJson(
      ["repo", "view", "--json", "nameWithOwner"],
      opts,
    )?.nameWithOwner;
    if (typeof resolved !== "string" || !resolved.includes("/")) {
      throw new ForgeError("gh repo view did not return nameWithOwner", {
        status: 0,
        stdout: JSON.stringify(resolved),
      });
    }
    resolvedRepos.set(key, resolved);
    return resolved;
  }

  function apiJson(path, opts) {
    return ghJson(["api", path], opts);
  }

  /**
   * `GET /pulls/{n}` for the mergeability fields the list endpoint omits,
   * bounded so a merge-scan tick over ~100 open PRs is not ~100 REST calls
   * every tick: closed/merged rows are never hydrated (GitHub reports no
   * mergeability for them), and an open row is fetched at most once per
   * (repo, number, head SHA) per TTL across every forge instance in this
   * process. A new head SHA is a cache miss, so a rebase is seen at once.
   */
  function hydrateMergeability(repo, pull, opts) {
    if (pull?.merged_at || String(pull?.state ?? "").toLowerCase() !== "open")
      return pull;
    const key = `${repo}#${pull?.number}@${pull?.head?.sha ?? ""}`;
    const at = now();
    const cached = hydration.get(key);
    if (cached && at - cached.at < hydrationTtlMs)
      return { ...pull, ...cached.fields };
    const detailed = apiJson(`repos/${repo}/pulls/${pull.number}`, opts);
    // GitHub computes mergeability asynchronously; `null` means "not yet"
    // and must not be pinned for a whole TTL.
    if (detailed?.mergeable != null) {
      if (hydration.size >= HYDRATION_CACHE_MAX) {
        for (const [k, v] of hydration)
          if (at - v.at >= hydrationTtlMs) hydration.delete(k);
        if (hydration.size >= HYDRATION_CACHE_MAX) hydration.clear();
      }
      hydration.set(key, {
        at,
        fields: {
          mergeable: detailed.mergeable,
          mergeable_state: detailed.mergeable_state,
        },
      });
    }
    return detailed;
  }

  function commitChecks(repo, sha, opts) {
    const checkRuns = [];
    for (let page = 1; ; page++) {
      const response = apiJson(
        `repos/${repo}/commits/${sha}/check-runs?per_page=${REST_PAGE_SIZE}${
          page === 1 ? "" : `&page=${page}`
        }`,
        opts,
      );
      const rows = response?.check_runs;
      if (!Array.isArray(rows)) {
        throw new ForgeError(
          "GitHub REST check-runs endpoint did not return an array",
          { status: 0, stdout: JSON.stringify(response) },
        );
      }
      checkRuns.push(...rows);
      if (
        rows.length < REST_PAGE_SIZE ||
        (Number.isFinite(response?.total_count) &&
          checkRuns.length >= response.total_count)
      )
        break;
    }

    const statuses = [];
    for (let page = 1; ; page++) {
      const response = apiJson(
        `repos/${repo}/commits/${sha}/status${
          page === 1 ? "" : `?per_page=${STATUS_PAGE_SIZE}&page=${page}`
        }`,
        opts,
      );
      const rows = response?.statuses;
      if (!Array.isArray(rows)) {
        throw new ForgeError(
          "GitHub REST commit-status endpoint did not return an array",
          { status: 0, stdout: JSON.stringify(response) },
        );
      }
      statuses.push(...rows);
      if (
        rows.length < STATUS_PAGE_SIZE ||
        (Number.isFinite(response?.total_count) &&
          statuses.length >= response.total_count)
      )
        break;
    }
    return { checkRuns, statuses };
  }

  function pullChecks(repo, number, opts) {
    const pull = apiJson(`repos/${repo}/pulls/${number}`, opts);
    const sha = pull?.head?.sha;
    if (typeof sha !== "string" || !sha) {
      throw new ForgeError(`pull request #${number} has no head SHA`, {
        status: 0,
        stdout: JSON.stringify(pull),
      });
    }
    const { checkRuns, statuses } = commitChecks(repo, sha, opts);
    return { pull, checks: restChecks(checkRuns, statuses) };
  }

  function requiredContexts(repo, baseRef, opts) {
    try {
      const protection = apiJson(
        `repos/${repo}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`,
        opts,
      );
      const checks = Array.isArray(protection?.checks)
        ? protection.checks.filter(
            (check) => typeof check?.context === "string",
          )
        : [];
      const modernNames = new Set(checks.map((check) => check.context));
      return {
        contexts: new Set(
          (Array.isArray(protection?.contexts)
            ? protection.contexts
            : []
          ).filter((context) => !modernNames.has(context)),
        ),
        checks,
      };
    } catch (err) {
      // 404: the branch is unprotected. 401/403: the caller's token (the
      // factory App token, notably) may not read branch protection at all;
      // `gh pr checks --required` reports "no required checks" there too, so
      // an unreadable rule set is an empty rule set, never a thrown scan.
      if (err instanceof ForgeError && /HTTP (401|403|404)\b/i.test(err.stderr))
        return { contexts: new Set(), checks: [] };
      throw err;
    }
  }

  function isRequired(check, required) {
    if (required.contexts.has(check.name)) return true;
    return required.checks.some(
      (rule) =>
        rule.context === check.name &&
        (rule.app_id == null ||
          rule.app_id === -1 ||
          String(rule.app_id) === String(check.appId)),
    );
  }

  function statusCheckRollup(repo, pull, opts) {
    const sha = pull?.head?.sha;
    if (typeof sha !== "string" || !sha) return [];
    const { checkRuns, statuses } = commitChecks(repo, sha, opts);
    return restChecks(checkRuns, statuses, { dedupe: false }).map(
      ({ name, conclusion, status }) => ({
        name,
        conclusion,
        status,
      }),
    );
  }

  const repoFlag = (repo) => (repo ? ["--repo", repo] : []);
  const jsonFlag = (fields) =>
    fields?.length ? ["--json", fields.join(",")] : [];

  return {
    kind: "github",
    cli: { bin: "gh", install: "brew install gh && gh auth login" },

    prView(repo, number, { fields, ...opts } = {}) {
      const resolvedRepo = resolveRepo(repo, opts);
      const pull = apiJson(`repos/${resolvedRepo}/pulls/${number}`, opts);
      const pr = restPullToPr(pull);
      if (fields?.includes("statusCheckRollup")) {
        pr.statusCheckRollup = statusCheckRollup(resolvedRepo, pull, opts);
      }
      return pick(pr, fields);
    },

    prList(repo, { state, limit, fields, ...opts } = {}) {
      const resolvedRepo = resolveRepo(repo, opts);
      const requested = limit == null ? 30 : Math.max(0, limit);
      if (requested === 0) return [];
      const restState =
        state === "merged"
          ? "closed"
          : state === "all"
            ? "all"
            : state === "closed"
              ? "closed"
              : "open";
      const needsMergeability = fields?.some(
        (field) => field === "mergeable" || field === "mergeStateStatus",
      );
      const perPage = Math.min(REST_PAGE_SIZE, requested);
      const prs = [];
      for (let page = 1; prs.length < requested; page++) {
        const raw = apiJson(
          `repos/${resolvedRepo}/pulls?state=${restState}&per_page=${perPage}&page=${page}`,
          opts,
        );
        if (!Array.isArray(raw)) {
          throw new ForgeError(
            "GitHub REST pulls endpoint did not return an array",
            {
              status: 0,
              stdout: JSON.stringify(raw),
            },
          );
        }
        const filtered =
          state === "merged"
            ? raw.filter((pull) => pull?.merged_at)
            : state === "closed"
              ? raw.filter((pull) => !pull?.merged_at)
              : raw;
        prs.push(...filtered);
        if (raw.length < perPage) break;
      }
      return prs.slice(0, requested).map((pull) => {
        // The REST list endpoint omits mergeability, even when those fields
        // are requested. Hydrate only callers that used those `gh pr --json`
        // fields; the hotter branch/URL lookups stay at one REST request.
        const detailedPull = needsMergeability
          ? hydrateMergeability(resolvedRepo, pull, opts)
          : pull;
        const pr = restPullToPr(detailedPull);
        if (fields?.includes("statusCheckRollup")) {
          pr.statusCheckRollup = statusCheckRollup(resolvedRepo, pull, opts);
        }
        return pick(pr, fields);
      });
    },

    prDiffFiles(repo, number, opts = {}) {
      const out = gh(
        ["pr", "diff", String(number), ...repoFlag(repo), "--name-only"],
        opts,
      );
      return out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    },

    prSetDraft(repo, number, draft, opts = {}) {
      gh(
        [
          "pr",
          "ready",
          ...(draft ? ["--undo"] : []),
          String(number),
          ...repoFlag(repo),
        ],
        opts,
      );
    },

    prComment(repo, number, body, opts = {}) {
      gh(
        ["pr", "comment", String(number), ...repoFlag(repo), "--body", body],
        opts,
      );
    },

    prChecks(repo, number, { required, fields, ...opts } = {}) {
      const resolvedRepo = resolveRepo(repo, opts);
      const { pull, checks } = pullChecks(resolvedRepo, number, opts);
      const requiredRules = required
        ? requiredContexts(resolvedRepo, pull?.base?.ref, opts)
        : null;
      const selected = requiredRules
        ? checks.filter((check) => isRequired(check, requiredRules))
        : checks;
      return selected.map((check) =>
        pick(check, fields?.length ? fields : PR_CHECK_FIELDS),
      );
    },

    runList(repo, { branch, created, limit, fields, ...opts } = {}) {
      const args = ["run", "list", ...repoFlag(repo)];
      if (branch) args.push("--branch", branch);
      if (created) args.push("--created", created);
      if (limit != null) args.push("--limit", String(limit));
      args.push(...jsonFlag(fields));
      const parsed = ghJson(args, opts);
      if (!Array.isArray(parsed)) {
        throw new ForgeError("gh run list did not return an array", {
          status: 0,
          stdout: JSON.stringify(parsed),
        });
      }
      return parsed;
    },

    apiRaw(path, { jq, ...opts } = {}) {
      return gh(["api", path, ...(jq ? ["--jq", jq] : [])], opts);
    },
  };
}
