/** Default, schema-valid decision requests for runtime inbox producers. */
import {
  proposalDecisionContext,
  proposalQuestion,
} from "./proposal-subject.mjs";

const dismiss = (label = "Not now") => ({
  id: "dismiss",
  label,
  effect: "dismiss",
  tone: "neutral",
});

const textField = ({
  id = "answer",
  label,
  required = false,
  whenOption,
} = {}) => ({
  id,
  kind: "text",
  label: label ?? "Anything the runtime should know",
  required,
  maxLength: 2000,
  ...(whenOption ? { whenOption } : {}),
});

function escalation(refs) {
  const options = [];
  if (refs.issue) {
    options.push({
      id: "triage",
      label: "Send back to Triage",
      effect: "send_to_triage",
      tone: "neutral",
    });
    options.push({
      id: "answer",
      label: "Answer the agent",
      effect: "answer",
      tone: "primary",
    });
  }
  options.push(dismiss("Acknowledge"));
  const subject = refs.pr
    ? `PR ${refs.pr}`
    : refs.runId
      ? `run ${refs.runId}`
      : "this refused run";
  return {
    schemaVersion: "factory.decision-request/v1",
    question: refs.issue
      ? `How should the factory proceed with ${refs.issue}?`
      : `What follow-up is needed for ${subject}?`,
    options,
    fields: refs.issue
      ? [textField({ required: true, whenOption: ["answer"] })]
      : [],
  };
}

function parked(refs) {
  const options = [];
  if (refs.eventSource && refs.eventId) {
    options.push({
      id: "requeue",
      label: "Requeue the event",
      effect: "requeue",
      tone: "primary",
    });
  }
  options.push(dismiss());
  return {
    schemaVersion: "factory.decision-request/v1",
    question: "Should this parked event be requeued?",
    recommended: options[0].id,
    options,
    fields: [textField({ id: "insight", required: false })],
  };
}

function triageQuestion(refs) {
  const options = [];
  if (refs.issue) {
    options.push({
      id: "answer",
      label: "Answer the question",
      effect: "answer",
      tone: "primary",
    });
  }
  options.push(dismiss());
  return {
    schemaVersion: "factory.decision-request/v1",
    question: refs.issue
      ? `What answer should be recorded on ${refs.issue}?`
      : "Should this triage question be dismissed?",
    options,
    fields: refs.issue
      ? [textField({ required: true, whenOption: ["answer"] })]
      : [],
  };
}

function mergeEscalation(refs) {
  const options = [];
  if (refs.issue) {
    options.push({
      id: "triage",
      label: "Send back to Triage",
      effect: "send_to_triage",
      tone: "neutral",
    });
    options.push({
      id: "answer",
      label: "Answer the reviewer",
      effect: "answer",
      tone: "primary",
    });
  }
  options.push(dismiss("Acknowledge"));
  const subject = refs.pr
    ? `PR ${refs.pr}`
    : refs.runId
      ? `run ${refs.runId}`
      : "this merge escalation";
  return {
    schemaVersion: "factory.decision-request/v1",
    question: `How should the merge escalation for ${subject} be handled?`,
    options,
    fields: refs.issue
      ? [textField({ required: true, whenOption: ["answer"] })]
      : [],
  };
}

function proposal(refs, { spec, reason } = {}) {
  const options = [];
  if (refs.proposalId) {
    options.push({
      id: "approve",
      label: "Approve proposal",
      effect: "approve_proposal",
      tone: "primary",
    });
    options.push({
      id: "reject",
      label: "Reject proposal",
      effect: "reject_proposal",
      tone: "danger",
    });
  }
  options.push(dismiss());
  const context = proposalDecisionContext(reason);
  return {
    schemaVersion: "factory.decision-request/v1",
    question: proposalQuestion(spec, { proposalId: refs.proposalId }),
    ...(context ? { context } : {}),
    options,
    fields: refs.proposalId
      ? [
          textField({
            id: "reason",
            label: "Reason for rejection",
            required: true,
            whenOption: ["reject"],
          }),
        ]
      : [],
  };
}

const BUILDERS = {
  escalation,
  parked,
  "triage-question": triageQuestion,
  "merge-escalation": mergeEscalation,
  proposal,
};

/**
 * The operator-facing note for a proposal that expired and was re-planned
 * rather than approved (WM-714). The answer they gave bought a fresh question:
 * the spec on offer now is not the one they read.
 */
export function replannedProposalContext(previousProposalId, proposalId) {
  const previous = previousProposalId ?? "the expired proposal";
  return `Approving ${previous} did not start a run: it had already expired, so the runtime re-planned against the current registry — re-planned after expiry; spec changed — please re-review. Proposal ${proposalId} carries the new spec and is still undecided.`;
}

/**
 * Return a new request for one producer. `kind` is retained in the signature
 * because callers naturally have the inbox kind; `producer` selects the
 * template when several producers share a kind. `context` is the optional §2.1
 * free-text preamble; omitted rather than serialised when absent.
 */
export function templateFor(
  kind,
  { producer, refs = {}, context, spec, reason } = {},
) {
  const selected = producer ?? String(kind ?? "").toLowerCase();
  const builder = BUILDERS[selected];
  if (!builder)
    throw new Error(`unknown decision template producer: ${selected}`);
  const request =
    selected === "proposal" ? proposal(refs, { spec, reason }) : builder(refs);
  if (context !== undefined) {
    if (typeof context !== "string" || context.trim() === "") {
      throw new Error("decision template context must be a non-empty string");
    }
    request.context = context;
  }
  return request;
}

export default templateFor;
