/** Default, schema-valid decision requests for runtime inbox producers. */

const dismiss = () => ({
  id: "dismiss",
  label: "Not now",
  effect: "dismiss",
  tone: "neutral",
});

const textField = ({ id = "answer", label, required = false, whenOption } = {}) => ({
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
  options.push(dismiss());
  return {
    schemaVersion: "factory.decision-request/v1",
    question: refs.issue
      ? `How should the factory proceed with ${refs.issue}?`
      : "How should the factory handle this refused run?",
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
  options.push(dismiss());
  return {
    schemaVersion: "factory.decision-request/v1",
    question: refs.pr
      ? `How should the merge escalation for ${refs.pr} be handled?`
      : "How should this merge escalation be handled?",
    options,
    fields: refs.issue
      ? [textField({ required: true, whenOption: ["answer"] })]
      : [],
  };
}

function proposal(refs) {
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
  return {
    schemaVersion: "factory.decision-request/v1",
    question: refs.proposalId
      ? `Decide proposal ${refs.proposalId}`
      : "Should this proposal notification be dismissed?",
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
 * Return a new request for one producer. `kind` is retained in the signature
 * because callers naturally have the inbox kind; `producer` selects the
 * template when several producers share a kind.
 */
export function templateFor(kind, { producer, refs = {} } = {}) {
  const selected = producer ?? String(kind ?? "").toLowerCase();
  const builder = BUILDERS[selected];
  if (!builder) throw new Error(`unknown decision template producer: ${selected}`);
  return builder(refs);
}

export default templateFor;
