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

function parseJobs(stdout) {
  const parsed = JSON.parse(stdout || "[]");
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

function blockAll(landed, { finalSha, kind, reason }) {
  for (const item of landed) {
    sh("factory", [
      "linear",
      "state",
      item.ticket,
      "Blocked",
      "--add",
      "ai:blocked",
      "--remove",
      "ai:needs-review",
    ]);
    sh("factory", [
      "linear",
      "comment",
      item.ticket,
      `${kind} after merge ${finalSha}: ${reason}. Branch/worktree preserved; merge barrier remains held.`,
    ]);
    sh("factory", [
      "notify",
      `${kind} ${item.ticket}/PR#${item.pr}: ${reason}`,
    ]);
  }
}

function proveLanded(github, item) {
  const state = sh("gh", [
    "pr",
    "view",
    String(item.pr),
    "--repo",
    github,
    "--json",
    "state",
    "--jq",
    ".state",
  ]);
  const mergeSha = sh("gh", [
    "pr",
    "view",
    String(item.pr),
    "--repo",
    github,
    "--json",
    "mergeCommit",
    "--jq",
    ".mergeCommit.oid",
  ]);
  return (
    (state.stdout || "").trim() === "MERGED" &&
    (mergeSha.stdout || "").trim() === item.mergeSha
  );
}

function pollWorkflow({ github, workflow, base, sha, requiredChecks }) {
  for (let i = 0; i < 90; i++) {
    const runsRaw = sh("gh", [
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
    const runs = JSON.parse(runsRaw.stdout || "[]");
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
      const jobsRaw = sh("gh", [
        "run",
        "view",
        String(matching[0].databaseId),
        "--repo",
        github,
        "--json",
        "jobs",
      ]);
      const jobs = parseJobs(jobsRaw.stdout);
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
    wait();
  }
  return {
    ok: false,
    reason: `configured ${workflow} workflow and required jobs did not settle at exact merge SHA`,
  };
}

function pollSmoke({ github, workflow, base, sha }) {
  for (let i = 0; i < 90; i++) {
    const runsRaw = sh("gh", [
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
    const runs = JSON.parse(runsRaw.stdout || "[]");
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
    wait();
  }
  return {
    ok: false,
    reason: `configured smoke workflow ${workflow} did not settle at ${sha}`,
  };
}

function cleanupItem({ github, repo, factoryRoot, item }) {
  const remote = sh("gh", [
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
  const guard = sh(
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
  const del = sh("gh", [
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
} = {}) {
  const input = JSON.parse(readFileSync(path.join(cwd, "input.json"), "utf8"));
  const { repo, github, base, landed, finalSha } = input;
  if (!Array.isArray(landed) || landed.length === 0) {
    throw new Error("landed[] is required");
  }
  for (const item of landed) {
    if (!proveLanded(github, item)) {
      throw new Error("landed PR no longer proves exact merge commit");
    }
  }

  const repoRecord = getRepo(loadRepos({ root: factoryRoot }), repo);
  if (!repoRecord.mergeCi) {
    throw new Error("merge_ci workflow/check gate is unavailable");
  }
  const ci = pollWorkflow({
    github,
    workflow: repoRecord.mergeCi.workflow,
    base,
    sha: finalSha,
    requiredChecks: repoRecord.mergeCi.requiredChecks,
  });
  if (!ci.ok) {
    blockAll(landed, { finalSha, kind: "CI RED", reason: ci.reason });
    throw new Error(ci.reason);
  }

  const smoke = repoRecord.smokeWorkflow;
  if (smoke) {
    const smoked = pollSmoke({ github, workflow: smoke, base, sha: finalSha });
    if (!smoked.ok) {
      blockAll(landed, { finalSha, kind: "SMOKE RED", reason: smoked.reason });
      throw new Error(smoked.reason);
    }
  }

  for (const item of landed) {
    cleanupItem({ github, repo, factoryRoot, item });
    sh("factory", [
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
  }
  emitNextScan(db, { repo, finalSha });

  const result = {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: "ok",
    artifact: {
      command: ["merge-verify.batch"],
      exitCode: 0,
      outputTail: `verified ${landed.length} landed PR(s) at ${finalSha}`,
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
