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
 */
import { spawnSync } from "node:child_process";
import { ForgeError, PR_CHECK_FIELDS } from "./types.mjs";

const text = (v) =>
  v == null ? "" : Buffer.isBuffer(v) ? v.toString() : String(v);

const REST_PAGE_SIZE = 100;

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
    case "STARTUP_FAILURE":
    case "STALE":
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

function restChecks(checkRuns, statuses) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const legacy = Array.isArray(statuses) ? statuses : [];
  return [
    ...runs.map((run) => {
      const state = String(
        run?.conclusion ?? run?.status ?? "PENDING",
      ).toUpperCase();
      return {
        name: run?.name,
        bucket: checkBucket(state),
        state,
        conclusion: run?.conclusion
          ? String(run.conclusion).toUpperCase()
          : null,
        status: run?.status ? String(run.status).toUpperCase() : null,
      };
    }),
    ...legacy.map((status) => {
      const state = String(status?.state ?? "PENDING").toUpperCase();
      return {
        name: status?.context,
        bucket: checkBucket(state),
        state,
        conclusion: state,
        status: state === "PENDING" ? "PENDING" : "COMPLETED",
      };
    }),
  ];
}

/**
 * @param {{ exec?: (cmd: string, args: string[], opts: object) => { status?: number|null, exitCode?: number|null, stdout?: string|Buffer, stderr?: string|Buffer, error?: Error } }} [options]
 * @returns {import("./types.mjs").Forge}
 */
export function githubForge({ exec = spawnSync } = {}) {
  /** Run `gh <args>`; throw ForgeError on non-zero exit or spawn failure. */
  function gh(args, { cwd, timeout } = {}) {
    const r =
      exec("gh", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      }) ?? {};
    // child_process shape first (`status`), Bun.spawnSync shape second
    // (`exitCode`); a spawn error (ENOENT) leaves both null and is a failure.
    const status = r.status ?? r.exitCode ?? null;
    const stdout = text(r.stdout);
    const stderr =
      text(r.stderr) || (r.error ? String(r.error.message ?? r.error) : "");
    if (status !== 0) {
      throw new ForgeError(
        `gh ${args.slice(0, 2).join(" ")} failed (status ${status})`,
        {
          status,
          stdout,
          stderr,
          cause: r.error,
        },
      );
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

  function pullChecks(repo, number, opts) {
    const pull = apiJson(`repos/${repo}/pulls/${number}`, opts);
    const sha = pull?.head?.sha;
    if (typeof sha !== "string" || !sha) {
      throw new ForgeError(`pull request #${number} has no head SHA`, {
        status: 0,
        stdout: JSON.stringify(pull),
      });
    }
    const checkRuns = apiJson(
      `repos/${repo}/commits/${sha}/check-runs?per_page=${REST_PAGE_SIZE}`,
      opts,
    )?.check_runs;
    const statuses = apiJson(
      `repos/${repo}/commits/${sha}/status`,
      opts,
    )?.statuses;
    return { pull, checks: restChecks(checkRuns, statuses) };
  }

  function requiredContexts(repo, baseRef, opts) {
    try {
      const protection = apiJson(
        `repos/${repo}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`,
        opts,
      );
      return new Set([
        ...(Array.isArray(protection?.contexts) ? protection.contexts : []),
        ...(Array.isArray(protection?.checks)
          ? protection.checks.map((check) => check?.context)
          : []),
      ]);
    } catch (err) {
      if (err instanceof ForgeError && /HTTP 404/i.test(err.stderr))
        return new Set();
      throw err;
    }
  }

  function statusCheckRollup(repo, pull, opts) {
    const sha = pull?.head?.sha;
    if (typeof sha !== "string" || !sha) return [];
    const checkRuns = apiJson(
      `repos/${repo}/commits/${sha}/check-runs?per_page=${REST_PAGE_SIZE}`,
      opts,
    )?.check_runs;
    const statuses = apiJson(
      `repos/${repo}/commits/${sha}/status`,
      opts,
    )?.statuses;
    return restChecks(checkRuns, statuses).map(
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
        state === "merged" ? "closed" : state === "all" ? "all" : "open";
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
          state === "merged" ? raw.filter((pull) => pull?.merged_at) : raw;
        prs.push(...filtered);
        if (raw.length < perPage) break;
      }
      return prs.slice(0, requested).map((pull) => {
        const pr = restPullToPr(pull);
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
      const contexts = required
        ? requiredContexts(resolvedRepo, pull?.base?.ref, opts)
        : null;
      const selected = contexts
        ? checks.filter((check) => contexts.has(check.name))
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
