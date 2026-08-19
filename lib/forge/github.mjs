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

/** GitHub CLI stderr when a PR has no check-runs / no required checks. */
const NO_CHECKS_RE = /^no (required )?checks reported on the '.+' branch$/;

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

  const repoFlag = (repo) => (repo ? ["--repo", repo] : []);
  const jsonFlag = (fields) =>
    fields?.length ? ["--json", fields.join(",")] : [];

  return {
    kind: "github",
    cli: { bin: "gh", install: "brew install gh && gh auth login" },

    prView(repo, number, { fields, ...opts } = {}) {
      return ghJson(
        ["pr", "view", String(number), ...repoFlag(repo), ...jsonFlag(fields)],
        opts,
      );
    },

    prList(repo, { state, limit, fields, ...opts } = {}) {
      const args = ["pr", "list", ...repoFlag(repo)];
      if (state) args.push("--state", state);
      if (limit != null) args.push("--limit", String(limit));
      args.push(...jsonFlag(fields));
      const parsed = ghJson(args, opts);
      if (!Array.isArray(parsed)) {
        throw new ForgeError("gh pr list did not return an array", {
          status: 0,
          stdout: JSON.stringify(parsed),
        });
      }
      return parsed;
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
      const jsonFields = fields?.length ? fields : [...PR_CHECK_FIELDS];
      const args = [
        "pr",
        "checks",
        String(number),
        ...repoFlag(repo),
        ...(required ? ["--required"] : []),
        "--json",
        jsonFields.join(","),
      ];
      try {
        const parsed = ghJson(args, opts);
        if (!Array.isArray(parsed)) {
          throw new ForgeError("gh pr checks did not return an array", {
            status: 0,
            stdout: JSON.stringify(parsed),
          });
        }
        return parsed;
      } catch (err) {
        if (!(err instanceof ForgeError)) throw err;
        // `gh pr checks --json` still prints the array when checks are red or
        // pending on some CLI versions (exit 1 / 8). Prefer the snapshot.
        if (err.stdout) {
          try {
            const parsed = JSON.parse(err.stdout);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // not JSON — fall through to the empty-snapshot diagnostics
          }
        }
        const diagnostic = (err.stderr || "").trim();
        if (err.status === 1 && NO_CHECKS_RE.test(diagnostic)) return [];
        throw err;
      }
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
