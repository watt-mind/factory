import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POST_KINDS,
  fieldsForOption,
  formatInboxMessage,
  formatOptions,
  formatResolvedReply,
  inboxDeepLink,
  isApprover,
  optionNeedsReason,
  parseCommand,
  reactionToOptionId,
  replyOptionId,
  shouldPost,
  truncateBody,
} from "../lib/format.mjs";

const proposal = {
  question: "Approve dispatch of WM-1?",
  options: [
    { id: "approve", label: "Approve proposal", effect: "approve_proposal" },
    { id: "reject", label: "Reject proposal", effect: "reject_proposal" },
    { id: "dismiss", label: "Not now", effect: "dismiss" },
  ],
  fields: [
    {
      id: "reason",
      kind: "text",
      required: true,
      whenOption: ["reject"],
    },
  ],
};

describe("option formatting", () => {
  test("three standard options render as 👍 approve · 👎 reject · 💤 not now", () => {
    const formatted = formatOptions(proposal);
    expect(formatted.style).toBe("emoji");
    expect(formatted.line).toBe("👍 approve · 👎 reject · 💤 not now");
    expect(reactionToOptionId("👍", formatted.map)).toBe("approve");
    expect(reactionToOptionId("👎", formatted.map)).toBe("reject");
    expect(reactionToOptionId("💤", formatted.map)).toBe("dismiss");
    expect(reactionToOptionId("+", formatted.map)).toBe("approve");
  });

  test("more than three options without effects are numbered", () => {
    const formatted = formatOptions({
      options: [
        { id: "a", label: "One" },
        { id: "b", label: "Two" },
        { id: "c", label: "Three" },
        { id: "d", label: "Four" },
      ],
    });
    expect(formatted.style).toBe("numbered");
    expect(formatted.line).toBe("1. One\n2. Two\n3. Three\n4. Four");
    expect(reactionToOptionId("2", formatted.map)).toBe("b");
  });

  test("closed-set effects each have a unique reaction emoji", () => {
    const formatted = formatOptions({
      options: [
        { id: "requeue", label: "Requeue the event", effect: "requeue" },
        {
          id: "triage",
          label: "Send back to Triage",
          effect: "send_to_triage",
        },
        { id: "answer", label: "Answer the agent", effect: "answer" },
        { id: "authorise", label: "Authorise", effect: "authorise" },
        { id: "dismiss", label: "Not now", effect: "dismiss" },
      ],
    });
    expect(formatted.style).toBe("emoji");
    expect(formatted.line).toContain("🔁 requeue");
    expect(formatted.line).toContain("📤 triage");
    expect(formatted.line).toContain("💬 answer");
    expect(formatted.line).toContain("🔓 authorise");
    expect(formatted.line).toContain("💤 not now");
    expect(reactionToOptionId("🔁", formatted.map)).toBe("requeue");
    expect(reactionToOptionId("📤", formatted.map)).toBe("triage");
    expect(reactionToOptionId("💬", formatted.map)).toBe("answer");
    expect(reactionToOptionId("🔓", formatted.map)).toBe("authorise");
  });
});

describe("inbox message", () => {
  test("subject, question, options, deep link", () => {
    const body = formatInboxMessage(
      {
        id: "inbox_1",
        kind: "ESCALATED",
        title: "ESCALATED run_abc: needs_human",
        refs: { issue: "WM-1", repo: "factory" },
        decision: {
          ...proposal,
          context: "Missing Stripe key on the runner.",
        },
      },
      { webUrl: "http://127.0.0.1:7382" },
    );
    expect(body).toStartWith("ESCALATED  factory  WM-1\n");
    expect(body).toContain("Missing Stripe key on the runner.");
    expect(body).toContain("👍 approve · 👎 reject · 💤 not now");
    expect(body).toContain("http://127.0.0.1:7382/#/inbox/inbox_1");
    expect(body).not.toContain("ESCALATED run_abc");
  });

  test("omits a hash-only inbox link when webUrl is missing", () => {
    const body = formatInboxMessage({
      id: "inbox_1",
      title: "Decide proposal prop_1",
      decision: proposal,
    });
    expect(body).not.toContain("#/inbox/");
    expect(inboxDeepLink("x", null)).toBe("");
    expect(inboxDeepLink("x", "#")).toBe("");
  });

  test("resolved reply names the actor", () => {
    expect(
      formatResolvedReply({
        decidedBy: "alice",
        response: { optionId: "approve" },
      }),
    ).toBe("✅ approve by alice");
  });

  test("long question/body fallback is capped at ~300 chars with ellipsis, deep link kept", () => {
    const long = "x".repeat(500);
    const body = formatInboxMessage(
      { id: "inbox_1", title: "t", body: long },
      { webUrl: "http://127.0.0.1:7382" },
    );
    const lines = body.split("\n");
    expect(lines[1].length).toBeLessThanOrEqual(301);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(body).toContain("http://127.0.0.1:7382/#/inbox/inbox_1");
  });

  test("truncateBody leaves short text untouched", () => {
    expect(truncateBody("short")).toBe("short");
  });
});

describe("commands", () => {
  test("closed grammar", () => {
    expect(parseCommand("@factory status")).toEqual({ type: "status" });
    expect(parseCommand("@factory dispatch WM-123 repo=bj29")).toEqual({
      type: "dispatch",
      ticket: "WM-123",
      repo: "bj29",
    });
    expect(parseCommand("@factory dispatch WM-123")).toEqual({
      type: "dispatch",
      ticket: "WM-123",
      repo: null,
    });
    expect(parseCommand("hello factory")).toBeNull();
    expect(parseCommand("@factory shutdown")).toBeNull();
  });
});

describe("reject reason gating", () => {
  test("reject requires a text field; approve does not", () => {
    expect(optionNeedsReason(proposal, "reject")).toBe(true);
    expect(optionNeedsReason(proposal, "approve")).toBe(false);
    expect(fieldsForOption(proposal, "reject", "nope")).toEqual({
      reason: "nope",
    });
    expect(fieldsForOption(proposal, "approve", "ignored")).toEqual({});
  });
});

describe("approvers", () => {
  test("allow-list is case-insensitive hex", () => {
    expect(isApprover("AA", ["aa"])).toBe(true);
    expect(isApprover("bb", ["aa"])).toBe(false);
  });
});

describe("shouldPost", () => {
  const kinds = new Set(DEFAULT_POST_KINDS);

  test("skips dismiss-only cards and ticket-less ESCALATED", () => {
    expect(
      shouldPost(
        {
          id: "inbox_1",
          kind: "ESCALATED",
          refs: { issue: "WM-1" },
          decision: {
            options: [{ id: "dismiss", label: "Not now", effect: "dismiss" }],
          },
        },
        kinds,
      ),
    ).toBe(false);
    expect(
      shouldPost(
        {
          id: "inbox_1",
          kind: "ESCALATED",
          refs: { runId: "run_1" },
          decision: proposal,
        },
        kinds,
      ),
    ).toBe(false);
  });

  test("posts ESCALATED with a ticket and a real verb", () => {
    expect(
      shouldPost(
        {
          id: "inbox_1",
          kind: "ESCALATED",
          refs: { issue: "WM-1" },
          decision: proposal,
        },
        kinds,
      ),
    ).toBe(true);
  });

  test("posts CI RED even without a decision", () => {
    expect(shouldPost({ id: "inbox_1", kind: "CI RED" }, kinds)).toBe(true);
  });

  test("drops kinds outside the interrupt set", () => {
    expect(
      shouldPost(
        { id: "inbox_1", kind: "decision_needed", decision: proposal },
        kinds,
      ),
    ).toBe(false);
  });
});

describe("replyOptionId", () => {
  test("selects recommended, else answer, never dismiss", () => {
    expect(
      replyOptionId({
        recommended: "requeue",
        options: [
          { id: "requeue", effect: "requeue" },
          { id: "dismiss", effect: "dismiss" },
        ],
      }),
    ).toBe("requeue");
    expect(
      replyOptionId({
        options: [
          { id: "triage", effect: "send_to_triage" },
          { id: "answer", effect: "answer" },
          { id: "dismiss", effect: "dismiss" },
        ],
      }),
    ).toBe("answer");
    expect(
      replyOptionId({
        recommended: "dismiss",
        options: [{ id: "dismiss", effect: "dismiss" }],
      }),
    ).toBe(null);
  });
});
