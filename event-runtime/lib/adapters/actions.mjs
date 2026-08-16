/**
 * Closed action-list executor (docs/event-runtime.md §11, §14; OPS-208, OPS-410).
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

/**
 * Validate that every placeholder in a remote template or probeRemote corresponds
 * to an input-schema property constrained by an enum or an anchored pattern (OPS-410).
 */
export function validateRemotePlaceholders(def, inputSchema) {
  const templates = [];
  if (typeof def?.probeRemote === "string") templates.push(def.probeRemote);
  if (Array.isArray(def?.probeRemote)) templates.push(...def.probeRemote);
  if (def?.actionRegistry && typeof def.actionRegistry === "object") {
    for (const action of Object.values(def.actionRegistry)) {
      if (typeof action?.remote === "string") templates.push(action.remote);
      if (Array.isArray(action?.remote)) templates.push(...action.remote);
    }
  }
  const properties = inputSchema?.properties ?? {};
  for (const tpl of templates) {
    const matches = typeof tpl === "string" ? tpl.matchAll(/\{([A-Za-z0-9_]+)\}/g) : [];
    for (const match of matches) {
      const field = match[1];
      const prop = properties[field];
      if (!prop) {
        throw new Error(`unconstrained placeholder "{${field}}" in remote template: field is missing from input schema`);
      }
      const hasEnum = Array.isArray(prop.enum) && prop.enum.length > 0;
      const hasPattern = typeof prop.pattern === "string" && prop.pattern.startsWith("^") && prop.pattern.endsWith("$");
      if (!hasEnum && !hasPattern) {
        throw new Error(
          `unconstrained placeholder "{${field}}" in remote template: input schema property must declare an enum or anchored pattern`,
        );
      }
    }
  }
}

/** {mount}-style substitution in a remote command string; fields are schema-validated at plan time. */
export function substituteRemote(remote, input) {
  if (Array.isArray(remote)) {
    return remote.map((item) => substituteRemote(item, input));
  }
  if (typeof remote !== "string") {
    throw new Error(`remote template must be a string or array of strings, got ${typeof remote}`);
  }
  return remote.replace(/\{([A-Za-z0-9_]+)\}/g, (_, field) => {
    const value = input?.[field];
    if (value === undefined || value === null || !["string", "number"].includes(typeof value)) {
      throw new Error(`remote template references missing/non-primitive input field "${field}"`);
    }
    return String(value);
  });
}

/**
 * Build argv array safely using function replacers to prevent $ patterns from being interpreted (OPS-410).
 */
export function buildArgv(exec, target, remote) {
  const targetStr = String(target);
  const result = [];
  for (const element of exec) {
    if (element === "{remote}" && Array.isArray(remote)) {
      result.push(...remote);
    } else {
      const remoteStr = Array.isArray(remote) ? remote.join(" ") : String(remote);
      result.push(
        element
          .replace(/\{target\}/g, () => targetStr)
          .replace(/\{remote\}/g, () => remoteStr),
      );
    }
  }
  return result;
}

/** Last integer in probe output — `df --output=used -B1 <mount> | tail -1`. */
export function probeBytes(raw) {
  const match = String(raw ?? "").trim().match(/(\d+)\s*$/);
  if (!match) throw new Error(`probe output has no byte count: "${String(raw).slice(0, 120)}"`);
  return Number(match[1]);
}

/** Substitute {field} placeholders across an argv template (item-list mode). */
export function substituteArgv(argv, context) {
  for (const element of argv) {
    if (/\$\{[A-Za-z0-9_]+\}/.test(element)) {
      throw new Error('argv template element contains "${", which collides with argv placeholder syntax');
    }
  }
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
    const itemKey = def.itemKey ?? "issueId";
    const issueId = item[itemKey] ?? item.issueId ?? item.ticket ?? item.action;
    const key = `${issueId ?? item.action}:${item.action}`;
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
    applied.push({ issueId, action: item.action });
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

  const schema = def.inputSchema ?? spec.inputSchema;
  if (schema) {
    try {
      validateRemotePlaceholders(def, schema);
    } catch (err) {
      return fail(err.message);
    }
  }

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
    const argv = buildArgv(exec, target, remote);
    const proc = spawnSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      timeout: budget,
    });
    const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
    outputs[label] = raw.slice(-OUTPUT_TAIL_CHARS);
    const cmdStr = Array.isArray(remote) ? remote.join(" ") : remote;
    appendFileSync(log, `$ ${label}: ${cmdStr}\n${outputs[label]}\n`, "utf8");
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
            commands: [
              Array.isArray(probeRemote) ? probeRemote.join(" ") : probeRemote,
              ...actionCommands.map((a) => (Array.isArray(a.remote) ? a.remote.join(" ") : a.remote)),
            ],
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
