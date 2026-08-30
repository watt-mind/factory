/**
 * Batched merge-verify (WM-908). Proves every landed PR still reports its
 * merge SHA, polls required CI (and smoke_workflow when configured) on
 * finalSha only, then greens or reds the whole batch together.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "./config.mjs";
import { admitChainEvent } from "./chain.mjs";
import { openDb } from "./db.mjs";
import { loadRegistry } from "./registry.mjs";
import { getRepo, loadRepos } from "./repos.mjs";

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function wait() {
  spawnSync("sleep", ["10"]);
}

function parseJobs(parsed) {
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

function runningVerify(db, finalSha) {
  const rows = db
    .query(
      `SELECT run_id FROM runs
        WHERE state = 'RUNNING'
          AND json_extract(spec_json, '$.agent') = 'merge-verify@1'
          AND json_extract(spec_json, '$.input.finalSha') = ?`,
    )
    .all(finalSha);
  if (rows.length > 1) {
    throw new Error(
      `expected one running merge verifier, found ${rows.length}`,
    );
  }
  return rows[0]?.run_id ?? null;
}

function emitNextScan(db, { repo, finalSha }) {
  const causationId = runningVerify(db, finalSha);
  if (!causationId) return;
  const eventId = `merge-next:${repo}:${finalSha}`;
  const outcome = admitChainEvent(db, loadRegistry(), {
    schemaVersion: "factory.event/v1",
    eventId,
    type: "factory.merge.requested",
    subject: repo,
    occurredAt: new Date().toISOString(),
    correlationId: eventId,
    causationId,
    payload: { repo },
  });
  if (!outcome.admitted && !outcome.duplicate) {
    throw new Error(outcome.errors.join("; "));
  }
}

function blockAll(landed, { finalSha, kind, reason }, shell = sh) {
  for (const item of landed) {
    shell("factory", [
      "linear",
      "state",
      item.ticket,
      "Blocked",
      "--add",
      "ai:blocked",
      "--remove",
      "ai:needs-review",
    ]);
    shell("factory", [
      "linear",
      "comment",
      item.ticket,
      `${kind} after merge ${finalSha}: ${reason}. Branch/worktree preserved; merge barrier remains held.`,
    ]);
    shell("factory", [
      "notify",
      `${kind} ${item.ticket}/PR#${item.pr}: ${reason}`,
    ]);
  }
}

function githubFailureDetail(action, result) {
  const detail = (
    result.stderr ||
    result.stdout ||
    "unknown gh failure"
  ).trim();
  return `${action}: ${detail}`;
}

function githubUnavailable(action, result) {
  return `github_unavailable: ${githubFailureDetail(action, result)}`;
}

/**
 * Parse a status-0 gh JSON body. A truncated or non-JSON body is a transport
 * failure like any other: returned as `{ failure }` instead of thrown raw.
 */
function parseGhJson(action, result, fallback) {
  try {
    return { value: JSON.parse(result.stdout || fallback) };
  } catch (err) {
    const detail = `${err.message || err}`;
    return {
      failure: githubUnavailable(`${action}`, {
        stderr: `unparseable JSON response (${detail})`,
      }),
    };
  }
}

/**
 * Counts transport failures across one polling window so a flaky API that
 * merely happens to succeed on the final poll is still reported as
 * github_unavailable rather than as a settle failure.
 */
function transportWindow() {
  let polls = 0;
  let failed = 0;
  let last = null;
  return {
    poll() {
      polls += 1;
    },
    fail(reason) {
      failed += 1;
      last = reason;
      return reason;
    },
    unsettled(reason) {
      if (failed === 0) return { ok: false, reason };
      const detail = last.replace(/^github_unavailable: /, "");
      return {
        ok: false,
        reason: `github_unavailable: ${reason} (${failed} of ${polls} polls failed: ${detail})`,
      };
    },
  };
}

export function proveLanded(github, item, shell = sh) {
  const pull = shell("gh", ["api", `repos/${github}/pulls/${item.pr}`]);
  if (pull.status !== 0) {
    throw new Error(githubUnavailable(`read PR ${item.pr}`, pull));
  }
  const { value: parsed, failure } = parseGhJson(
    `read PR ${item.pr}`,
    pull,
    "{}",
  );
  if (failure) throw new Error(failure);
  return parsed.merged === true && parsed.merge_commit_sha === item.mergeSha;
}

export function pollWorkflow({
  github,
  workflow,
  base,
  sha,
  requiredChecks,
  shell = sh,
  pause = wait,
  attempts = 90,
}) {
  const window = transportWindow();
  for (let i = 0; i < attempts; i++) {
    window.poll();
    const runsRaw = shell("gh", [
      "run",
      "list",
      "--repo",
      github,
      "--workflow",
      workflow,
      "--event",
      "push",
      "--branch",
      base,
      "--commit",
      sha,
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,headSha,workflowName",
    ]);
    if (runsRaw.status !== 0) {
      window.fail(githubUnavailable("list workflow runs", runsRaw));
      pause();
      continue;
    }
    const runsParsed = parseGhJson("list workflow runs", runsRaw, "[]");
    if (runsParsed.failure) {
      window.fail(runsParsed.failure);
      pause();
      continue;
    }
    const runs = runsParsed.value;
    const matching = runs.filter(
      (run) => run.workflowName === workflow && run.headSha === sha,
    );
    if (matching.length > 1) {
      return {
        ok: false,
        reason: `configured ${workflow} workflow is ambiguous at exact merge SHA`,
      };
    }
    if (matching.length === 1) {
      const jobsRaw = shell("gh", [
        "run",
        "view",
        String(matching[0].databaseId),
        "--repo",
        github,
        "--json",
        "jobs",
      ]);
      const jobsAction = `read workflow jobs for run ${matching[0].databaseId}`;
      if (jobsRaw.status !== 0) {
        window.fail(githubUnavailable(jobsAction, jobsRaw));
        pause();
        continue;
      }
      const jobsParsed = parseGhJson(jobsAction, jobsRaw, "[]");
      if (jobsParsed.failure) {
        window.fail(jobsParsed.failure);
        pause();
        continue;
      }
      const jobs = parseJobs(jobsParsed.value);
      const named = (name) => jobs.filter((job) => job.name === name);
      if (requiredChecks.some((name) => named(name).length > 1)) {
        return {
          ok: false,
          reason: `configured ${workflow} jobs are ambiguous at exact merge SHA`,
        };
      }
      if (requiredChecks.every((name) => named(name).length === 1)) {
        if (
          requiredChecks.some((name) => {
            const job = named(name)[0];
            return job.status === "completed" && job.conclusion !== "success";
          })
        ) {
          return {
            ok: false,
            reason: `configured ${workflow} workflow failed at exact merge SHA`,
          };
        }
        if (
          requiredChecks.every((name) => {
            const job = named(name)[0];
            return job.status === "completed" && job.conclusion === "success";
          })
        ) {
          return { ok: true };
        }
      }
    }
    pause();
  }
  return window.unsettled(
    `configured ${workflow} workflow and required jobs did not settle at exact merge SHA`,
  );
}

export function pollSmoke({
  github,
  workflow,
  base,
  sha,
  shell = sh,
  pause = wait,
  attempts = 90,
}) {
  const window = transportWindow();
  for (let i = 0; i < attempts; i++) {
    window.poll();
    const runsRaw = shell("gh", [
      "run",
      "list",
      "--repo",
      github,
      "--workflow",
      workflow,
      "--branch",
      base,
      "--commit",
      sha,
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion",
    ]);
    if (runsRaw.status !== 0) {
      window.fail(githubUnavailable("list smoke workflow runs", runsRaw));
      pause();
      continue;
    }
    const runsParsed = parseGhJson("list smoke workflow runs", runsRaw, "[]");
    if (runsParsed.failure) {
      window.fail(runsParsed.failure);
      pause();
      continue;
    }
    const runs = runsParsed.value;
    if (runs.length > 0 && runs.every((run) => run.status === "completed")) {
      const ok = runs.every((run) =>
        ["success", "neutral", "skipped"].includes(run.conclusion),
      );
      return ok
        ? { ok: true }
        : {
            ok: false,
            reason: `configured smoke workflow ${workflow} failed at ${sha}`,
          };
    }
    pause();
  }
  return window.unsettled(
    `configured smoke workflow ${workflow} did not settle at ${sha}`,
  );
}

function cleanupItem({ github, repo, factoryRoot, item, shell = sh }) {
  const remote = shell("gh", [
    "api",
    `repos/${github}/git/ref/heads/${item.headRef}`,
    "--jq",
    ".object.sha",
  ]);
  if (remote.status !== 0) {
    const err = `${remote.stderr ?? ""}`;
    if (/HTTP 404/.test(err)) return;
    throw new Error(err.trim() || "head ref lookup failed");
  }
  if ((remote.stdout || "").trim() !== item.headSha) {
    throw new Error("head branch moved; refusing cleanup");
  }
  const guard = shell(
    "factory",
    [
      "branch-guard",
      "--repo",
      repo,
      "--pr",
      String(item.pr),
      "--head",
      item.headRef,
    ],
    {
      env: {
        ...process.env,
        FACTORY_BRANCH_GUARD_REPOS_YAML: `${factoryRoot}/config/repos.yaml`,
      },
    },
  );
  if (guard.status === 2) return;
  if (guard.status !== 0) {
    throw new Error("branch cleanup guard could not evaluate");
  }
  const record = getRepo(loadRepos({ root: factoryRoot }), repo);
  if (record.worktreeDown && record.worktreeRoot && record.path) {
    const ticketPath = path.join(
      record.worktreeRoot.replace(/^~(?=\/)/, process.env.HOME),
      item.ticket,
    );
    if (existsSync(ticketPath)) {
      const down = spawnSync("/bin/bash", [record.worktreeDown, item.ticket], {
        cwd: record.path.replace(/^~(?=\/)/, process.env.HOME),
        encoding: "utf8",
        stdio: "inherit",
      });
      if ((down.status ?? 1) !== 0) {
        throw new Error("worktree teardown failed");
      }
    }
  }
  const del = shell("gh", [
    "api",
    "-X",
    "DELETE",
    `repos/${github}/git/refs/heads/${item.headRef}`,
  ]);
  if (del.status !== 0 && !/HTTP 404/.test(del.stderr ?? "")) {
    throw new Error("head ref delete failed");
  }
}

export function runMergeVerify({
  cwd = process.cwd(),
  db = openDb(),
  factoryRoot = FACTORY_ROOT,
  shell = sh,
  pause = wait,
  pollAttempts = 90,
  repoRecord: configuredRepoRecord,
} = {}) {
  const input = JSON.parse(readFileSync(path.join(cwd, "input.json"), "utf8"));
  const { repo, github, base, landed, finalSha } = input;
  if (!Array.isArray(landed) || landed.length === 0) {
    throw new Error("landed[] is required");
  }
  for (const item of landed) {
    if (!proveLanded(github, item, shell)) {
      throw new Error("landed PR no longer proves exact merge commit");
    }
  }

  const repoRecord =
    configuredRepoRecord ?? getRepo(loadRepos({ root: factoryRoot }), repo);
  if (!repoRecord.mergeCi) {
    throw new Error("merge_ci workflow/check gate is unavailable");
  }
  const ci = pollWorkflow({
    github,
    workflow: repoRecord.mergeCi.workflow,
    base,
    sha: finalSha,
    requiredChecks: repoRecord.mergeCi.requiredChecks,
    shell,
    pause,
    attempts: pollAttempts,
  });
  if (!ci.ok) {
    if (!ci.reason.startsWith("github_unavailable:")) {
      blockAll(landed, { finalSha, kind: "CI RED", reason: ci.reason }, shell);
    }
    throw new Error(ci.reason);
  }

  const smoke = repoRecord.smokeWorkflow;
  if (smoke) {
    const smoked = pollSmoke({
      github,
      workflow: smoke,
      base,
      sha: finalSha,
      shell,
      pause,
      attempts: pollAttempts,
    });
    if (!smoked.ok) {
      if (!smoked.reason.startsWith("github_unavailable:")) {
        blockAll(
          landed,
          { finalSha, kind: "SMOKE RED", reason: smoked.reason },
          shell,
        );
      }
      throw new Error(smoked.reason);
    }
  }

  const doneFailures = [];
  for (const item of landed) {
    cleanupItem({ github, repo, factoryRoot, item, shell });
    const done = shell("factory", [
      "linear",
      "state",
      item.ticket,
      "Done",
      "--remove",
      "ai:needs-review",
      "--remove",
      "ai:escalated",
      "--remove",
      "ai:blocked",
      "--remove",
      "ai:in-progress",
    ]);
    if (done.status !== 0) {
      const detail = (done.stderr || done.stdout || "unknown failure").trim();
      const message = `Done transition failed for ${item.ticket}: ${detail}`;
      console.error(message);
      doneFailures.push(message);
    }
  }
  emitNextScan(db, { repo, finalSha });

  const result = {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: "ok",
    artifact: {
      command: ["merge-verify.batch"],
      exitCode: 0,
      outputTail: [
        `verified ${landed.length} landed PR(s) at ${finalSha}`,
        ...doneFailures,
      ].join("; "),
    },
    evidence: { commands: ["merge-verify.batch"] },
  };
  writeFileSync(
    path.join(cwd, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(runMergeVerify());
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
