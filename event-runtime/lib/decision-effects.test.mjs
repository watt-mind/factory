import { describe, expect, test } from "bun:test";
import { hashBytes, hashJson } from "./canonical.mjs";
import { applyDecisionEffect } from "./decision-effects.mjs";
import { decisionRequestHash } from "./decision.mjs";
import { openDb } from "./db.mjs";
import {
  createInboxItem,
  decideInboxItem,
  retryInboxDecision,
} from "./inbox.mjs";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function item(effect, overrides = {}) {
  const option = {
    id: "choose",
    label: "Choose",
    effect,
    ...(effect === "authorise"
      ? {
          scope: {
            paths: ["src/a.ts", "src/b.ts"],
            summary: "Change the bounded implementation",
          },
        }
      : {}),
  };
  return {
    id: "inbox_391",
    refs: {
      issue: "WM-313",
      repo: "factory",
      runId: "run_refused",
      eventSource: "linear",
      eventId: "delivery-313",
      proposalId: "prop_313",
    },
    decision: {
      schemaVersion: "factory.decision-request/v1",
      question: "Proceed?",
      options: [option],
      fields: [
        {
          id: "insight",
          kind: "text",
          label: "Insight",
          required: false,
        },
        {
          id: "paths",
          kind: "multi-choice",
          label: "Paths",
          required: true,
          whenOption: ["choose"],
          choices: [
            { id: "a", label: "src/a.ts" },
            { id: "b", label: "src/b.ts" },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function response(fields = {}) {
  return {
    schemaVersion: "factory.decision-response/v1",
    requestHash: "sha256:" + "0".repeat(64),
    optionId: "choose",
    fields,
    decidedBy: "operator:laszlo",
    decidedAt: new Date(NOW).toISOString(),
  };
}

describe("runtime decision effects", () => {
  test("applies dismiss, Linear writes, requeue, approve, and reject through injected transports", () => {
    const calls = [];
    const linear = {
      triage: (...args) => calls.push(["triage", ...args]),
      answer: (...args) => calls.push(["answer", ...args]),
    };
    const planner = {
      requeue: (...args) => calls.push(["requeue", ...args]),
      approveProposal: (...args) => {
        calls.push(["approve", ...args]);
        return { approved: true };
      },
      rejectProposal: (...args) => calls.push(["reject", ...args]),
    };

    expect(applyDecisionEffect(null, item("dismiss"), response())).toEqual({
      kind: "dismiss",
      outcome: "applied",
    });
    expect(
      applyDecisionEffect(
        null,
        item("send_to_triage"),
        response({ insight: "Needs a tighter scope" }),
        { linear, planner, now: NOW },
      ),
    ).toEqual({ kind: "send_to_triage", outcome: "applied" });
    expect(
      applyDecisionEffect(
        null,
        item("answer"),
        response({ insight: "Use the existing seam" }),
        { linear, planner, now: NOW },
      ),
    ).toEqual({ kind: "answer", outcome: "applied" });
    expect(
      applyDecisionEffect(null, item("requeue"), response(), {
        linear,
        planner,
        now: NOW,
      }),
    ).toEqual({ kind: "requeue", outcome: "applied" });
    expect(
      applyDecisionEffect(null, item("approve_proposal"), response(), {
        linear,
        planner,
        now: NOW,
      }),
    ).toEqual({ kind: "approve_proposal", outcome: "applied" });
    expect(
      applyDecisionEffect(
        null,
        item("reject_proposal"),
        response({ insight: "Spec is stale" }),
        { linear, planner, now: NOW },
      ),
    ).toEqual({ kind: "reject_proposal", outcome: "applied" });

    expect(calls[0]).toEqual(["triage", "WM-313", "Needs a tighter scope"]);
    expect(calls[1]).toEqual(["answer", "WM-313", "Use the existing seam"]);
    expect(calls[2][1]).toBeNull();
    expect(calls[2][2]).toEqual({
      source: "linear",
      eventId: "delivery-313",
    });
    expect(calls[3][2]).toBe("prop_313");
    expect(calls[4][3]).toMatchObject({
      actor: "operator",
      reason: "Spec is stale",
      now: NOW,
    });
  });

  test("expired proposal re-plan is applied but requires a second approval", () => {
    const result = applyDecisionEffect(
      null,
      item("approve_proposal"),
      response(),
      {
        linear: {},
        planner: {
          approveProposal: () => ({
            approved: false,
            replanned: true,
            proposal: { id: "prop_fresh" },
          }),
        },
        now: NOW,
      },
    );
    expect(result).toEqual({
      kind: "approve_proposal",
      outcome: "applied",
      detail: "replanned_awaiting_approval",
      newProposalId: "prop_fresh",
    });
  });

  test("authorise binds the live description, selected paths, text, and refused run into a new dispatch payload", () => {
    let envelope;
    const decisionItem = item("authorise");
    const refusedInputHash = hashJson({ repo: "factory", ticket: "WM-313" });
    const result = applyDecisionEffect(
      null,
      decisionItem,
      response({ paths: ["b"], insight: "Keep the adapter synchronous" }),
      {
        linear: { get: () => ({ description: "Current Linear body" }) },
        planner: {
          admit: (_db, value) => {
            envelope = value;
            return { admitted: true, duplicate: false };
          },
        },
        now: NOW,
      },
    );

    expect(result).toEqual({
      kind: "authorise",
      outcome: "applied",
      detail: "dispatched",
      descriptionHash: hashBytes("Current Linear body"),
    });
    expect(envelope).toMatchObject({
      schemaVersion: "factory.event/v1",
      eventId: "inbox_391",
      type: "factory.dispatch.requested",
      source: "inbox",
      subject: "WM-313",
      correlationId: "inbox_391",
      causationId: "run_refused",
      payload: {
        repo: "factory",
        ticket: "WM-313",
        humanDecision: {
          schemaVersion: "factory.human-decision/v1",
          inboxItemId: "inbox_391",
          authorisation: {
            ticket: "WM-313",
            repo: "factory",
            descriptionHash: hashBytes("Current Linear body"),
            paths: ["src/b.ts"],
            summary: "Change the bounded implementation",
            insight: "Keep the adapter synchronous",
            refusedRunId: "run_refused",
            decidedBy: "operator:laszlo",
            decidedAt: new Date(NOW).toISOString(),
          },
        },
      },
    });
    expect(hashJson(envelope.payload)).not.toBe(refusedInputHash);
  });

  test("authorise fails closed before admission when Linear has no description", () => {
    let admitted = false;
    const result = applyDecisionEffect(
      null,
      item("authorise"),
      response({ paths: ["a"] }),
      {
        linear: { get: () => ({ description: null }) },
        planner: {
          admit: () => {
            admitted = true;
          },
        },
        now: NOW,
      },
    );
    expect(result).toMatchObject({
      kind: "authorise",
      outcome: "failed",
      error: expect.stringContaining("description unavailable"),
    });
    expect(admitted).toBe(false);
  });

  test("transport failure stays open with the response recorded and retry resolves", () => {
    const db = openDb(":memory:");
    const request = {
      schemaVersion: "factory.decision-request/v1",
      question: "Send to triage?",
      options: [
        {
          id: "choose",
          label: "Triage",
          effect: "send_to_triage",
        },
      ],
    };
    createInboxItem(
      db,
      {
        kind: "ESCALATED",
        title: "Failure-safe effect",
        refs: { issue: "WM-313" },
        decision: request,
      },
      { id: "retry_effect" },
    );
    let fail = true;
    const applyEffect = (effectDb, effectItem, effectResponse) =>
      applyDecisionEffect(effectDb, effectItem, effectResponse, {
        linear: {
          triage: () => {
            if (fail) throw new Error("Linear unavailable");
            return { ok: true };
          },
        },
        planner: {},
        now: NOW,
      });
    const first = decideInboxItem(
      db,
      "retry_effect",
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(request),
        optionId: "choose",
        fields: {},
      },
      { now: NOW, applyEffect },
    );
    expect(first.effect).toMatchObject({
      outcome: "failed",
      error: "Linear unavailable",
    });
    expect(first.item.resolvedAt).toBeNull();
    expect(first.item.response.effect.error).toBe("Linear unavailable");

    fail = false;
    const retried = retryInboxDecision(db, "retry_effect", {
      now: NOW + 1,
      applyEffect,
      artifactStore: null,
    });
    expect(retried.effect.outcome).toBe("applied");
    expect(retried.item.resolvedBy).toBe("operator:send_to_triage");
  });
});
