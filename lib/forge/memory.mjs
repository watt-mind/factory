/**
 * Memory Forge — an in-process fake satisfying the same contract as
 * `github.mjs` (WM-836). For tests and the offline demo (WM-799).
 *
 * Seed shape:
 *   {
 *     repos: {
 *       "owner/name": {
 *         prs:  [{ number, state, isDraft, labels:[{name}], headRefName,
 *                  headRefOid, title, body, url, files:[...], comments:[...],
 *                  checks:[{ name, bucket, state, required }] }],
 *         runs: [{ databaseId, name, workflowName, status, conclusion,
 *                  headBranch, createdAt, startedAt, updatedAt }],
 *       },
 *     },
 *     api: { "<path>": string | (opts) => string },
 *   }
 *
 * `defaultRepo` stands in for a `null` RepoRef (the "whatever the cwd points
 * at" case). Every mutation is recorded on `forge.calls` so a test can assert
 * what would have been done.
 */
import { ForgeError, PR_CHECK_FIELDS } from "./types.mjs";

const pick = (obj, fields) =>
  fields?.length
    ? Object.fromEntries(fields.map((f) => [f, obj[f]]))
    : { ...obj };

/**
 * @param {{ repos?: object, api?: object, defaultRepo?: string|null }} [seed]
 * @returns {import("./types.mjs").Forge & { calls: object[], seed: object }}
 */
export function memoryForge({ repos = {}, api = {}, defaultRepo = null } = {}) {
  const seed = { repos, api };
  const calls = [];

  function repoData(repo) {
    const key = repo ?? defaultRepo;
    const data = key ? seed.repos[key] : null;
    if (!data) {
      throw new ForgeError(`repository ${key ?? "(cwd)"} not found`, {
        status: 1,
        stderr: `GraphQL: Could not resolve to a Repository with the name '${key ?? ""}'.`,
      });
    }
    data.prs ??= [];
    data.runs ??= [];
    return data;
  }

  function findPr(repo, number) {
    const pr = repoData(repo).prs.find(
      (p) => String(p.number) === String(number),
    );
    if (!pr) {
      throw new ForgeError(`pull request #${number} not found`, {
        status: 1,
        stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`,
      });
    }
    return pr;
  }

  const stateMatches = (pr, state) => {
    if (!state || state === "all") return true;
    return String(pr.state ?? "OPEN").toLowerCase() === state.toLowerCase();
  };

  return {
    kind: "memory",
    cli: { bin: null, install: null },
    calls,
    seed,

    prView(repo, number, { fields } = {}) {
      calls.push({ op: "prView", repo, number, fields });
      return pick(findPr(repo, number), fields);
    },

    prList(repo, { state, limit, fields } = {}) {
      calls.push({ op: "prList", repo, state, limit, fields });
      let prs = repoData(repo).prs.filter((p) => stateMatches(p, state));
      if (limit != null) prs = prs.slice(0, limit);
      return prs.map((p) => pick(p, fields));
    },

    prDiffFiles(repo, number) {
      calls.push({ op: "prDiffFiles", repo, number });
      return [...(findPr(repo, number).files ?? [])];
    },

    prSetDraft(repo, number, draft) {
      calls.push({ op: "prSetDraft", repo, number, draft });
      findPr(repo, number).isDraft = Boolean(draft);
    },

    prComment(repo, number, body) {
      calls.push({ op: "prComment", repo, number, body });
      const pr = findPr(repo, number);
      (pr.comments ??= []).push({ body });
    },

    prChecks(repo, number, { required, fields } = {}) {
      calls.push({ op: "prChecks", repo, number, required, fields });
      let checks = [...(findPr(repo, number).checks ?? [])];
      if (required) checks = checks.filter((c) => c.required);
      return checks.map((c) =>
        pick(c, fields?.length ? fields : [...PR_CHECK_FIELDS]),
      );
    },

    runList(repo, { branch, created, limit, fields } = {}) {
      calls.push({ op: "runList", repo, branch, created, limit, fields });
      let runs = repoData(repo).runs;
      if (branch) runs = runs.filter((r) => r.headBranch === branch);
      const since = /^>=?(.+)$/.exec(created ?? "")?.[1];
      if (since) runs = runs.filter((r) => String(r.createdAt ?? "") >= since);
      if (limit != null) runs = runs.slice(0, limit);
      return runs.map((r) => pick(r, fields));
    },

    apiRaw(path, opts = {}) {
      calls.push({ op: "apiRaw", path, jq: opts.jq });
      const hit = seed.api[path];
      if (hit === undefined) {
        throw new ForgeError(`api ${path} not seeded`, {
          status: 1,
          stderr: `gh: Not Found (HTTP 404)`,
        });
      }
      return typeof hit === "function" ? String(hit(opts)) : String(hit);
    },
  };
}
