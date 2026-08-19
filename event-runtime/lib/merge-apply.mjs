/**
 * Batched merge-apply (WM-908). Lands each plan item in order, skips
 * conflicts without aborting the batch, and emits one factory.merge-landed
 * carrying landed[] plus finalSha.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "./config.mjs";
import { admitChainEvent } from "./chain.mjs";
import { openDb } from "./db.mjs";
import {
  noRequiredChecksDiagnostic,
  proveMergeCiFallback,
  resolveRequiredContexts,
} from "./merge-ci-proof.mjs";
import { loadRegistry } from "./registry.mjs";
import { getRepo, loadRepos } from "./repos.mjs";

function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

function parseJobs(stdout) {
  const parsed = JSON.parse(stdout || "[]");
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

function runningApply(db) {
  const rows = db
    .query(
      `SELECT run_id FROM runs
        WHERE state = 'RUNNING'
          AND json_extract(spec_json, '$.agent') = 'merge-apply@2'`,
    )
    .all();
  if (rows.length > 1) {
    throw new Error(`expected one running merge apply, found ${rows.length}`);
  }
  return rows[0]?.run_id ?? null;
}

function emitEvent(db, { type, eventId, repo, payload }) {
  const causationId = runningApply(db);
  if (!causationId) return;
  const outcome = admitChainEvent(db, loadRegistry(), {
    schemaVersion: "factory.event/v1",
    eventId,
    type,
    subject: repo,
    occurredAt: new Date().toISOString(),
    correlationId: eventId,
    causationId,
    payload,
  });
  if (!outcome.admitted && !outcome.duplicate) {
    throw new Error(outcome.errors.join("; "));
  }
}

function githubHeld(labels) {
  return (labels ?? []).some((label) => {
    const name = String(label?.name ?? label ?? "").toLowerCase();
    return name === "escalated" || name === "ai:escalated";
  });
}

function linearHeld(ticketJson) {
  if (!ticketJson || typeof ticketJson !== "object") return true;
  if (ticketJson.state?.name === "Blocked") return true;
  const names = (ticketJson.labels?.nodes ?? []).map((n) => n?.name ?? "");
  return names.some((name) =>
    /^(ai:escalated|type:security|.*security.*)$/i.test(name),
  );
}

function proveRequiredCi({ github, pr, headRef, headSha, repo, factoryRoot }) {
  const checked = sh("gh", [
    "pr",
    "checks",
    String(pr),
    "--repo",
    github,
    "--required",
    "--json",
    "name,bucket,state",
  ]);
  const output =
    `${checked.stdout ?? ""}${checked.status !== 0 ? (checked.stderr ?? "") : ""}`.trim();
  let contexts;
  try {
    contexts = resolveRequiredContexts({
      status: checked.status ?? 1,
      output:
        checked.status === 0 ? String(checked.stdout ?? "").trim() : output,
      headRef,
    });
  } catch {
    return { ok: false, reason: "required CI lookup failed or not green" };
  }
  if (contexts.length > 0) {
    const green = contexts.every(
      (c) => c.bucket === "pass" && c.state === "SUCCESS",
    );
    return green
      ? { ok: true }
      : { ok: false, reason: "required CI is pending or not green" };
  }
  const repoRecord = getRepo(loadRepos({ root: factoryRoot }), repo);
  const gate = repoRecord.mergeCi;
  if (!gate) {
    return {
      ok: false,
      reason: `${noRequiredChecksDiagnostic(headRef)}; no merge_ci fallback`,
    };
  }
  const runsRaw = sh("gh", [
    "run",
    "list",
    "--repo",
    github,
    "--workflow",
    gate.workflow,
    "--event",
    "pull_request",
    "--commit",
    headSha,
    "--limit",
    "20",
    "--json",
    "databaseId,status,conclusion,headSha,workflowName",
  ]);
  if (runsRaw.status !== 0) {
    return { ok: false, reason: "merge_ci fallback run list failed" };
  }
  try {
    const runs = JSON.parse(runsRaw.stdout || "[]");
    const matching = runs.filter(
      (run) => run.workflowName === gate.workflow && run.headSha === headSha,
    );
    if (matching.length !== 1) {
      return { ok: false, reason: "configured workflow missing or ambiguous" };
    }
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
    proveMergeCiFallback({
      workflow: gate.workflow,
      requiredChecks: gate.requiredChecks,
      headSha,
      runs,
      jobs,
    });
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: "configured CI checks missing, pending, or red",
    };
  }
}

function recheckAndMerge(item, input) {
  const { github, base, repo, factoryRoot } = input;
  const { pr, headSha, headRef, ticket } = item;
  const viewRaw = sh("gh", [
    "pr",
    "view",
    String(pr),
    "--repo",
    github,
    "--json",
    "state,isDraft,mergeable,headRefOid,headRefName,baseRefName,labels",
  ]);
  if (viewRaw.status !== 0) return { skip: "gh pr view failed" };
  const view = JSON.parse(viewRaw.stdout);
  const actualBase = sh("gh", [
    "api",
    `repos/${github}/git/ref/heads/${base}`,
    "--jq",
    ".object.sha",
  ]);
  const baseSha = (actualBase.stdout || "").trim();
  if (view.headRefOid !== headSha || baseSha !== item.baseSha) {
    return { skip: "head or base SHA moved" };
  }
  if (view.state !== "OPEN") return { skip: "PR is not open" };
  if (view.isDraft) return { skip: "PR is draft" };
  if (view.mergeable !== "MERGEABLE") return { skip: "PR is not mergeable" };
  if (view.headRefName !== headRef) return { skip: "head branch moved" };
  if (view.baseRefName !== base) return { skip: "base branch changed" };
  if (base !== "develop") return { skip: "only develop is auto-mergeable" };
  if (githubHeld(view.labels)) return { skip: "GitHub escalation hold" };

  const linearRaw = sh("factory", ["linear", "get", ticket, "--json"]);
  if (linearRaw.status !== 0) return { skip: "Linear lookup failed" };
  let linear;
  try {
    linear = JSON.parse(linearRaw.stdout);
  } catch {
    return { skip: "Linear lookup malformed" };
  }
  if (linearHeld(linear)) return { skip: "Linear hold present" };

  const ci = proveRequiredCi({
    github,
    pr,
    headRef,
    headSha,
    repo,
    factoryRoot,
  });
  if (!ci.ok) return { skip: ci.reason };

  const merged = sh("gh", [
    "pr",
    "merge",
    String(pr),
    "--repo",
    github,
    "--squash",
    "--match-head-commit",
    headSha,
  ]);
  if (merged.status !== 0) return { skip: "gh pr merge failed" };
  const landedRaw = sh("gh", [
    "pr",
    "view",
    String(pr),
    "--repo",
    github,
    "--json",
    "state,mergeCommit",
    "--jq",
    'select(.state == "MERGED") | .mergeCommit.oid',
  ]);
  const mergeSha = (landedRaw.stdout || "").trim();
  if (!/^[0-9a-f]{40}$/.test(mergeSha)) {
    throw new Error(`merge outcome uncertain for #${pr}`);
  }
  return { mergeSha };
}

export function runMergeApply({
  cwd = process.cwd(),
  db = openDb(),
  factoryRoot = FACTORY_ROOT,
} = {}) {
  const input = JSON.parse(readFileSync(path.join(cwd, "input.json"), "utf8"));
  input.factoryRoot ??= factoryRoot;
  const plan = Array.isArray(input.plan) ? input.plan : [];
  const applied = [];
  const skipped = [];
  const landed = [];
  for (const item of plan) {
    let outcome;
    try {
      outcome = recheckAndMerge(item, input);
    } catch (err) {
      if (landed.length > 0) {
        skipped.push({
          pr: item.pr,
          ticket: item.ticket,
          reason: err.message,
        });
        break;
      }
      throw err;
    }
    if (outcome.skip) {
      skipped.push({ pr: item.pr, ticket: item.ticket, reason: outcome.skip });
      continue;
    }
    applied.push({ issueId: item.ticket, action: "merge_pr" });
    landed.push({
      pr: item.pr,
      ticket: item.ticket,
      headSha: item.headSha,
      mergeSha: outcome.mergeSha,
      headRef: item.headRef,
    });
  }

  if (landed.length > 0) {
    const finalSha = landed[landed.length - 1].mergeSha;
    emitEvent(db, {
      type: "factory.merge-landed",
      eventId: `merge-landed:${input.github}:${finalSha}`,
      repo: input.repo,
      payload: {
        repo: input.repo,
        github: input.github,
        base: input.base,
        landed,
        finalSha,
      },
    });
  } else if (skipped.length > 0) {
    emitEvent(db, {
      type: "factory.merge.requested",
      eventId: `merge-refresh:${input.repo}:${skipped[0].pr}`,
      repo: input.repo,
      payload: { repo: input.repo },
    });
  }

  const result = {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: "ok",
    artifact: { repo: input.repo, applied, skipped },
    evidence: { commands: ["merge-apply.batch"] },
  };
  writeFileSync(
    path.join(cwd, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(runMergeApply());
}
