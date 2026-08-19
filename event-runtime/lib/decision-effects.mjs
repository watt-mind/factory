/** Runtime-owned effects for inbox decisions (docs/event-runtime-inbox.md §3). */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { hashBytes } from "./canonical.mjs";
import { FACTORY_ROOT } from "./config.mjs";
import { admitExternalEvent } from "./intake.mjs";
import { requeueEvent } from "./planner.mjs";
import { approveProposal, rejectProposal } from "./proposals.mjs";

const linearCli = () => path.join(FACTORY_ROOT, "tools", "linear.mjs");

function runLinear(args) {
  try {
    return execFileSync("bun", [linearCli(), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
  } catch (err) {
    const message =
      String(err?.stderr ?? "")
        .trim()
        .split("\n")
        .pop() || err.message;
    throw new Error(`linear_${args[0]}_failed: ${message}`, { cause: err });
  }
}

/** Synchronous Linear transport: decision application runs inside a DB transaction. */
export const linearDecisionTransport = {
  get(issue) {
    return JSON.parse(runLinear(["get", issue, "--json"]));
  },
  triage(issue, comment) {
    runLinear(["triage", issue, "--comment", comment]);
    return { ok: true };
  },
  answer(issue, text) {
    runLinear(["answer", issue, text]);
    return { ok: true };
  },
};

/** Bind runtime operations that need the loaded registry. */
export function decisionEffectPlanner(
  registry,
  { onEvent = () => {}, policyVersion = "unknown" } = {},
) {
  return {
    admit(db, envelope, { now } = {}) {
      const outcome = admitExternalEvent(db, registry, envelope, { now });
      if (outcome.admitted) onEvent("admitted");
      return outcome;
    },
    requeue(db, refs, options) {
      const outcome = requeueEvent(db, refs, options);
      onEvent("requeued");
      return outcome;
    },
    approveProposal(db, id, options) {
      return approveProposal(db, registry, id, {
        ...options,
        policyVersion,
      });
    },
    rejectProposal(db, id, options) {
      return rejectProposal(db, id, { ...options, policyVersion });
    },
  };
}

function resolveNow(now) {
  return typeof now === "function" ? now() : now;
}

function textFields(item, response) {
  const fields = item?.decision?.fields ?? [];
  return fields
    .filter((field) => field.kind === "text")
    .map((field) => response?.fields?.[field.id])
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .join("\n\n");
}

function authorisedPaths(option, item, response) {
  const scoped = option.scope.paths;
  const gatedPathFields = (item.decision.fields ?? []).filter(
    (field) =>
      field.kind === "multi-choice" &&
      Array.isArray(field.whenOption) &&
      field.whenOption.includes(option.id),
  );
  if (gatedPathFields.length === 0) return [...scoped];

  const selected = new Set();
  for (const field of gatedPathFields) {
    const ids = new Set(response.fields?.[field.id] ?? []);
    for (const choice of field.choices ?? []) {
      if (ids.has(choice.id)) selected.add(choice.label);
    }
  }
  return scoped.filter((scopedPath) => selected.has(scopedPath));
}

function transportSucceeded(result, operation) {
  if (result === false || result?.ok === false) {
    throw new Error(result?.error ?? `${operation} failed`);
  }
  return result;
}

function authorise(db, item, response, option, { linear, planner, now }) {
  const issue = transportSucceeded(linear.get(item.refs.issue), "linear get");
  if (!issue || typeof issue.description !== "string") {
    throw new Error(
      `linear description unavailable for ${item.refs.issue} at decision time`,
    );
  }

  const decidedAt = response.decidedAt ?? new Date(now).toISOString();
  const authorisation = {
    ticket: item.refs.issue,
    repo: item.refs.repo,
    descriptionHash: hashBytes(issue.description),
    paths: authorisedPaths(option, item, response),
    summary: option.scope.summary,
    insight: textFields(item, response),
    refusedRunId: item.refs.runId,
    decidedBy: response.decidedBy ?? "operator",
    decidedAt,
  };
  const envelope = {
    schemaVersion: "factory.event/v1",
    eventId: item.id,
    type: "factory.dispatch.requested",
    source: "inbox",
    subject: item.refs.issue,
    occurredAt: new Date(now).toISOString(),
    correlationId: item.id,
    causationId: item.refs.runId,
    payload: {
      repo: item.refs.repo,
      ticket: item.refs.issue,
      humanDecision: {
        schemaVersion: "factory.human-decision/v1",
        inboxItemId: item.id,
        authorisation,
      },
    },
  };
  const admitted = transportSucceeded(
    planner.admit(db, envelope, { now }),
    "dispatch admission",
  );
  if (!admitted?.admitted && !admitted?.duplicate) {
    throw new Error(
      `dispatch admission failed: ${(admitted?.errors ?? ["no outcome"]).join("; ")}`,
    );
  }
  return {
    detail: admitted.duplicate ? "already_admitted" : "dispatched",
    descriptionHash: authorisation.descriptionHash,
  };
}

/**
 * Apply one validated decision response.
 *
 * Stateful callers inject `{ linear, planner }`; keeping the dependencies at
 * the seam makes every transport failure deterministic in tests and lets the
 * inbox ledger record it without resolving the item.
 */
export function applyDecisionEffect(
  db,
  item,
  response,
  { linear, planner, now = Date.now() } = {},
) {
  const option = item?.decision?.options?.find(
    (candidate) => candidate.id === response?.optionId,
  );
  const kind = option?.effect ?? "unknown";
  if (kind === "dismiss") return { kind, outcome: "applied" };

  // The WM-390 ledger still calls this seam directly in non-composed contexts.
  // Preserve its retryable sentinel there; the runtime API always injects both
  // transports and therefore returns only applied/failed for real effects.
  if (!linear && !planner) return { kind, outcome: "unsupported" };

  const at = resolveNow(now);
  try {
    let detail;
    let newProposalId;
    let descriptionHash;
    switch (kind) {
      case "authorise": {
        const authorised = authorise(db, item, response, option, {
          linear,
          planner,
          now: at,
        });
        detail = authorised.detail;
        descriptionHash = authorised.descriptionHash;
        break;
      }
      case "send_to_triage": {
        const text =
          textFields(item, response) ||
          `Operator sent ${item.refs.issue} to Triage from inbox ${item.id}.`;
        transportSucceeded(
          linear.triage(item.refs.issue, text),
          "linear triage",
        );
        break;
      }
      case "answer":
        transportSucceeded(
          linear.answer(item.refs.issue, textFields(item, response)),
          "linear answer",
        );
        break;
      case "requeue":
        transportSucceeded(
          planner.requeue(
            db,
            {
              source: item.refs.eventSource,
              eventId: item.refs.eventId,
            },
            { actor: "operator", now: at },
          ),
          "event requeue",
        );
        break;
      case "approve_proposal": {
        const approved = transportSucceeded(
          planner.approveProposal(db, item.refs.proposalId, {
            actor: "operator",
            now: at,
          }),
          "proposal approval",
        );
        if (approved?.replanned && approved?.approved === false) {
          detail = "replanned_awaiting_approval";
          newProposalId = approved?.proposal?.id;
          if (!newProposalId) {
            throw new Error(
              "proposal re-plan did not return the fresh proposal id",
            );
          }
        }
        break;
      }
      case "reject_proposal":
        transportSucceeded(
          planner.rejectProposal(db, item.refs.proposalId, {
            actor: "operator",
            reason: textFields(item, response),
            now: at,
          }),
          "proposal rejection",
        );
        break;
      default:
        throw new Error(`unknown decision effect: ${kind}`);
    }
    return {
      kind,
      outcome: "applied",
      ...(detail ? { detail } : {}),
      ...(newProposalId ? { newProposalId } : {}),
      ...(descriptionHash ? { descriptionHash } : {}),
    };
  } catch (err) {
    return {
      kind,
      outcome: "failed",
      error: err?.message ?? String(err),
    };
  }
}

export default applyDecisionEffect;
