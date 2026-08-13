/**
 * Closed action-list executor (docs/event-runtime.md §11, §14; OPS-208).
 *
 * Slice 2's remediation node: executes an *approved list of action IDs*, each
 * resolved to a fixed remote command from the definition's action registry —
 * the model proposed the plan, the operator approved the concrete list, and
 * this code executes exactly the registered templates, nothing else. An
 * unregistered action ID, unknown host, or missing probe fails the attempt
 * before any action runs.
 *
 * The definition declares:
 *   exec           argv template reaching the host: ["ssh","-o","BatchMode=yes","{target}","{remote}"]
 *   hosts          { hostName: sshTarget } — the host allowlist, closed
 *   probeRemote    fixed remote command measuring used bytes ({mount} substitutable)
 *   actionRegistry { actionId: { remote: "<fixed remote command>" } }
 *
 * Evidence discipline (§9): the probe runs before and after; raw outputs go
 * into evidence, derived numbers into the artifact, and the verifier
 * recomputes reclaimedBytes from the evidence — a wrong claim fails closed.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "../config.mjs";

const OUTPUT_TAIL_CHARS = 2_000;

/** {mount}-style substitution in a remote command string; fields are schema-validated at plan time. */
function substituteRemote(remote, input) {
  return remote.replace(/\{([A-Za-z0-9_]+)\}/g, (_, field) => {
    const value = input?.[field];
    if (value === undefined || value === null || !["string", "number"].includes(typeof value)) {
      throw new Error(`remote template references missing/non-primitive input field "${field}"`);
    }
    return String(value);
  });
}

function buildArgv(exec, target, remote) {
  return exec.map((element) => element.replace("{target}", target).replace("{remote}", remote));
}

/** Last integer in probe output — `df --output=used -B1 <mount> | tail -1`. */
function probeBytes(raw) {
  const match = String(raw ?? "").trim().match(/(\d+)\s*$/);
  if (!match) throw new Error(`probe output has no byte count: "${String(raw).slice(0, 120)}"`);
  return Number(match[1]);
}

/** Substitute {field} placeholders across an argv template (item-list mode). */
function substituteArgv(argv, context) {
  return argv.map((element) =>
    element.replace(/\{([A-Za-z0-9_]+)\}/g, (_, field) => {
      const value = context?.[field];
      if (value === undefined || value === null || !["string", "number"].includes(typeof value)) {
        throw new Error(`argv template references missing/non-primitive field "${field}"`);
      }
      return String(value);
    }),
  );
}

/**
 * Item-list mode (OPS-229): the approved plan is a *list*, each item resolved
 * to a fixed local argv from the closed registry — one registered action per
 * item, nothing else executable. Used by triage-apply, where each item is a
 * Linear transition rather than a remote shell command.
 */
async function executeItemList({ spec, def, workspaceDir, timeoutMs }) {
  const log = path.join(workspaceDir, ".actions.log");
  const fail = (message) => {
    appendFileSync(log, `REFUSED before execution: ${message}\n`, "utf8");
    return { exitCode: 1, timedOut: false };
  };

  const items = spec.input?.[def.itemsField];
  if (!Array.isArray(items) || items.length === 0) return fail(`no items in input.${def.itemsField}`);

  // Resolve EVERY item before executing ANY: an unregistered action id in the
  // approved list is a refusal, never a partial application.
  const resolved = [];
  try {
    for (const item of items) {
      const registered = def.actionRegistry?.[item.action];
      if (!registered?.argv) throw new Error(`action "${item.action}" is not in the closed action registry`);
      resolved.push({
        item,
        argv: substituteArgv(registered.argv, { ...spec.input, ...item, factoryRoot: FACTORY_ROOT }),
      });
    }
  } catch (err) {
    return fail(err.message);
  }

  const deadline = Date.now() + timeoutMs;
  const applied = [];
  const outputs = {};
  for (const { item, argv } of resolved) {
    const budget = Math.max(1000, deadline - Date.now());
    const proc = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: budget, cwd: FACTORY_ROOT });
    const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.slice(-OUTPUT_TAIL_CHARS);
    const key = `${item[def.itemKey]}:${item.action}`;
    outputs[key] = raw;
    appendFileSync(log, `$ ${key}: ${argv.join(" ")}\n${raw}\n`, "utf8");
    if (proc.error?.code === "ETIMEDOUT") {
      appendFileSync(log, `TIMED OUT after ${applied.length}/${resolved.length}\n`, "utf8");
      return { exitCode: null, timedOut: true };
    }
    if (proc.status !== 0) {
      // Partial application is a real outcome: the log records what landed,
      // and the attempt fails so nothing claims success it cannot prove.
      appendFileSync(log, `FAILED on ${key} (exit ${proc.status}) after ${applied.length} applied\n`, "utf8");
      return { exitCode: proc.status ?? 1, timedOut: false };
    }
    applied.push({ issueId: item[def.itemKey], action: item.action });
  }

  writeFileSync(
    path.join(workspaceDir, "result.json"),
    `${JSON.stringify(
      {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        reasonCode: "ok",
        artifact: { repo: spec.input.repo, applied },
        evidence: { commands: resolved.map((r) => r.argv), outputs },
        artifacts: [{ kind: "log", path: ".actions.log" }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { exitCode: 0, timedOut: false };
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({ spec, def, workspaceDir, timeoutMs }) {
  // Two closed-registry shapes: a per-item local argv list (OPS-229) and the
  // remote probe → act → probe flow (OPS-208). The definition picks.
  if (def.itemsField) return executeItemList({ spec, def, workspaceDir, timeoutMs });

  const log = path.join(workspaceDir, ".actions.log");
  const fail = (message) => {
    appendFileSync(log, `REFUSED before execution: ${message}\n`, "utf8");
    return { exitCode: 1, timedOut: false };
  };

  const input = spec.input ?? {};
  const exec = def.exec;
  if (!Array.isArray(exec) || exec.length === 0) return fail(`definition ${def.ref} has no exec template`);
  const target = def.hosts?.[input.host];
  if (!target) return fail(`host "${input.host}" is not in the definition's host allowlist`);

  // Resolve EVERYTHING before executing ANYTHING — an unregistered action ID
  // in the approved plan is a refusal, not a partial execution (OPS-208 AC).
  let probeRemote;
  const actionCommands = [];
  try {
    probeRemote = substituteRemote(def.probeRemote, input);
    for (const entry of input.actions ?? []) {
      const registered = def.actionRegistry?.[entry.action];
      if (!registered) throw new Error(`action "${entry.action}" is not in the closed action registry`);
      actionCommands.push({ id: entry.action, remote: substituteRemote(registered.remote, input) });
    }
    if (actionCommands.length === 0) throw new Error("empty action list");
  } catch (err) {
    return fail(err.message);
  }

  const deadline = Date.now() + timeoutMs;
  const outputs = {};
  const run = (label, remote) => {
    const budget = Math.max(1000, deadline - Date.now());
    const proc = spawnSync(buildArgv(exec, target, remote)[0], buildArgv(exec, target, remote).slice(1), {
      encoding: "utf8",
      timeout: budget,
    });
    const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
    outputs[label] = raw.slice(-OUTPUT_TAIL_CHARS);
    appendFileSync(log, `$ ${label}: ${remote}\n${outputs[label]}\n`, "utf8");
    if (proc.error?.code === "ETIMEDOUT") throw Object.assign(new Error(`${label} timed out`), { timedOut: true });
    if (proc.status !== 0) throw new Error(`${label} exited ${proc.status}`);
    return proc.stdout ?? "";
  };

  try {
    const probeBefore = run("probe-before", probeRemote);
    for (const action of actionCommands) run(action.id, action.remote);
    const probeAfter = run("probe-after", probeRemote);

    const beforeUsedBytes = probeBytes(probeBefore);
    const afterUsedBytes = probeBytes(probeAfter);
    writeFileSync(
      path.join(workspaceDir, "result.json"),
      `${JSON.stringify(
        {
          schemaVersion: "factory.agent-result/v1",
          terminalState: "completed",
          reasonCode: "ok",
          artifact: {
            host: input.host,
            mount: input.mount,
            actions: actionCommands.map((a) => a.id),
            beforeUsedBytes,
            afterUsedBytes,
            reclaimedBytes: beforeUsedBytes - afterUsedBytes,
          },
          evidence: {
            probeBefore,
            probeAfter,
            commands: [probeRemote, ...actionCommands.map((a) => a.remote)],
            outputs,
          },
          artifacts: [{ kind: "log", path: ".actions.log" }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { exitCode: 0, timedOut: false };
  } catch (err) {
    appendFileSync(log, `FAILED: ${err.message}\n`, "utf8");
    return { exitCode: 1, timedOut: err.timedOut === true };
  }
}
