import "../test-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApiError } from "../api";
import type { DecisionRequest, InboxItem } from "../types";
import { decisionRequestHash } from "../lib/decision";
import { DecisionCard } from "./DecisionCard";

const request: DecisionRequest = {
  schemaVersion: "factory.decision-request/v1",
  question:
    "WM-313 changes how the pi adapter reads FACTORY_EVENT_SECRET. May I proceed?",
  context:
    "The ticket moves secret handling from env to a file the worker mounts…\n\nRisk: a wrong path leaks the secret into the run journal.",
  recommended: "authorise",
  options: [
    {
      id: "triage",
      label: "Send back to Triage",
      description: "The ticket should be re-scoped before anyone touches this.",
      effect: "send_to_triage",
      tone: "neutral",
    },
    {
      id: "authorise",
      label: "Authorise within these paths",
      description:
        "Re-dispatch me with your approval bound to WM-313 as written now.",
      effect: "authorise",
      tone: "primary",
      scope: {
        paths: [
          "event-runtime/lib/adapters/pi.mjs",
          "event-runtime/lib/security-env.mjs",
        ],
        summary:
          "Read the event secret from FACTORY_EVENT_SECRET_FILE when set; never log its value.",
      },
    },
    { id: "dismiss", label: "Not now", effect: "dismiss", tone: "neutral" },
  ],
  fields: [
    {
      id: "insight",
      kind: "text",
      label: "Anything I should know before I start",
      placeholder: "e.g. the file path convention, or a test to add",
      required: false,
      maxLength: 2000,
    },
    {
      id: "paths",
      kind: "multi-choice",
      label: "Restrict me to",
      choices: [
        { id: "pi", label: "event-runtime/lib/adapters/pi.mjs" },
        { id: "env", label: "event-runtime/lib/security-env.mjs" },
      ],
      required: true,
      whenOption: ["authorise"],
    },
    {
      id: "confirm",
      kind: "confirm",
      label: "I understand this changes secret handling on every worker",
      required: true,
      whenOption: ["authorise"],
    },
  ],
};

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox_decision",
    kind: "decision_needed",
    severity: "normal",
    title: "Decision needed",
    body: null,
    refs: {},
    source: "agent:run_1",
    createdAt: "2026-08-16T12:40:00.000Z",
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    delivery: {},
    decision: request,
    response: null,
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

let apiCalls: NonNullable<
  React.ComponentProps<typeof DecisionCard>["apiCalls"]
>;

beforeEach(() => {
  apiCalls = {
    decide: mock(async () => ({
      item: item(),
      effect: { kind: "authorise", outcome: "applied" },
    })),
    get: mock(async () => ({
      item: item({
        resolvedAt: "2026-08-16T12:41:07.000Z",
        resolvedBy: "operator:authorise",
        response: {
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(request),
          optionId: "authorise",
          fields: { paths: ["pi"], confirm: true },
          decidedBy: "operator",
          decidedAt: "2026-08-16T12:41:07.000Z",
          effect: { kind: "authorise", outcome: "applied" },
        },
      }),
    })),
    retry: mock(async () => ({
      item: item(),
      effect: { kind: "authorise", outcome: "applied" },
    })),
  };
});

afterEach(() => {
  cleanup();
});

describe("DecisionCard", () => {
  test("renders the §2.1 options recommended-first and gates its fields", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    const optionButtons = view
      .getByRole("group", { name: "Options" })
      .querySelectorAll("button");
    expect(optionButtons).toHaveLength(3);
    expect(optionButtons[0].textContent).toContain(
      "Authorise within these paths",
    );
    expect(optionButtons[0].textContent).toContain("suggested");
    expect(optionButtons[1].textContent).toContain("Send back to Triage");
    expect(optionButtons[2].textContent).toContain("Not now");
    expect(view.queryByText("Restrict me to")).toBeNull();
    expect(
      view.queryByLabelText(/I understand this changes secret handling/),
    ).toBeNull();

    fireEvent.click(optionButtons[0]);
    expect(view.getByRole("group", { name: /Restrict me to/ })).toBeTruthy();
    expect(
      view.getByLabelText(/I understand this changes secret handling/),
    ).toBeTruthy();
  });

  test("proposal cards show ticket and proposal links on the card (WM-896)", () => {
    const onJumpProposal = mock(() => {});
    const view = render(
      <DecisionCard
        itemId="inbox_dispatch"
        request={{
          schemaVersion: "factory.decision-request/v1",
          question:
            "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
          context:
            "**Why you're being asked.** Auto-approval re-check failed (see proposal)",
          options: [
            {
              id: "approve",
              label: "Approve proposal",
              effect: "approve_proposal",
              tone: "primary",
            },
            { id: "dismiss", label: "Not now", effect: "dismiss" },
          ],
        }}
        refs={{
          issue: "WM-862",
          repo: "factory",
          proposalId: "prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
        }}
        onJumpProposal={onJumpProposal}
        apiCalls={apiCalls}
      />,
    );
    expect(
      view.getByText(
        "Run dispatch@1 for WM-862 (factory) on cursor-grok-4.6-high?",
      ),
    ).toBeTruthy();
    expect(view.getByText(/Why you're being asked/)).toBeTruthy();
    expect(
      view.getByText(/Auto-approval re-check failed \(see proposal\)/),
    ).toBeTruthy();
    const ticket = view.getByRole("link", { name: "WM-862" });
    expect(ticket.getAttribute("href")).toBe(
      "https://linear.app/watt-mind/issue/WM-862",
    );
    fireEvent.click(view.getByText(/prop_2dda/));
    expect(onJumpProposal).toHaveBeenCalledWith(
      "prop_2dda1ca8-2469-4aab-8908-79c31a5df55b",
    );
  });

  test("keeps submit disabled until confirmation and at least one path are chosen", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    fireEvent.click(
      view.getByRole("group", { name: "Options" }).querySelector("button")!,
    );
    const submit = view.getByRole("button", {
      name: "Authorise within these paths",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(view.getByLabelText("event-runtime/lib/adapters/pi.mjs"));
    expect(submit.disabled).toBe(true);
    fireEvent.click(
      view.getByLabelText(/I understand this changes secret handling/),
    );
    expect(submit.disabled).toBe(false);
  });

  test("posts the response contract then refetches before rendering the record", async () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    fireEvent.click(
      view.getByRole("group", { name: "Options" }).querySelector("button")!,
    );
    fireEvent.click(view.getByLabelText("event-runtime/lib/adapters/pi.mjs"));
    fireEvent.click(
      view.getByLabelText(/I understand this changes secret handling/),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Authorise within these paths" }),
    );

    await waitFor(() => expect(apiCalls.decide).toHaveBeenCalledTimes(1));
    expect(apiCalls.decide).toHaveBeenCalledWith("inbox_decision", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "authorise",
      fields: { paths: ["pi"], confirm: true },
    });
    await waitFor(() => expect(apiCalls.get).toHaveBeenCalledTimes(1));
    await waitFor(() => view.getByRole("region", { name: "Decision record" }));
    expect(view.getByText("Effect applied")).toBeTruthy();
  });

  test("refetches and asks the operator to re-read a stale request", async () => {
    const changed: DecisionRequest = {
      ...request,
      question: "The scope changed. Continue?",
    };
    apiCalls.decide = mock(async () => {
      throw new ApiError("stale_request", 409);
    });
    apiCalls.get = mock(async () => ({
      item: item({ decision: changed, response: null }),
    }));
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    fireEvent.click(
      view.getByRole("group", { name: "Options" }).querySelector("button")!,
    );
    fireEvent.click(view.getByLabelText("event-runtime/lib/adapters/pi.mjs"));
    fireEvent.click(
      view.getByLabelText(/I understand this changes secret handling/),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Authorise within these paths" }),
    );
    await waitFor(() =>
      view.getByText("This question changed — please re-read"),
    );
    expect(view.getByText("The scope changed. Continue?")).toBeTruthy();
  });

  test("number keys select from anywhere in the view, beat the view's own bubble-phase bindings, and never from a text field", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    // Stand-in for Inbox's status-tab listener (bubble phase on window): with
    // an undecided card open it must not see the number keys.
    const tabListener = mock(() => {});
    window.addEventListener("keydown", tabListener);
    try {
      const optionButtons = view
        .getByRole("group", { name: "Options" })
        .querySelectorAll("button");
      fireEvent.keyDown(document.body, { key: "2" });
      expect(optionButtons[1].getAttribute("aria-pressed")).toBe("true");
      expect(tabListener).not.toHaveBeenCalled();
      const text = view.getByLabelText("Anything I should know before I start");
      fireEvent.keyDown(text, { key: "3" });
      expect(optionButtons[1].getAttribute("aria-pressed")).toBe("true");
      expect(tabListener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", tabListener);
    }
  });

  test("an unapplied effect (WM-390's `unsupported` stub) is retryable, not just `failed`", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        response={{
          schemaVersion: "factory.decision-response/v1" as const,
          requestHash: decisionRequestHash(request),
          optionId: "authorise",
          fields: { paths: ["pi"], confirm: true },
          decidedBy: "operator",
          decidedAt: "2026-08-16T12:41:07.000Z",
          effect: { kind: "authorise", outcome: "unsupported" },
        }}
        apiCalls={apiCalls}
      />,
    );
    expect(view.getByText(/Effect unsupported/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("shows a failed effect and retries it before refetching the record", async () => {
    const failed = {
      schemaVersion: "factory.decision-response/v1" as const,
      requestHash: decisionRequestHash(request),
      optionId: "dismiss",
      fields: {},
      decidedBy: "operator",
      decidedAt: "2026-08-16T12:41:07.000Z",
      effect: {
        kind: "dismiss",
        outcome: "failed",
        error: "temporary failure",
      },
    };
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        response={failed}
        apiCalls={apiCalls}
      />,
    );
    expect(view.getByText(/temporary failure/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(apiCalls.retry).toHaveBeenCalledWith("inbox_decision"),
    );
    await waitFor(() =>
      expect(apiCalls.get).toHaveBeenCalledWith("inbox_decision"),
    );
  });

  test("renders an auto-superseded decision without treating it as an answer", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        response={{
          superseded: true,
          reason: "auto:proposal_closed",
          decidedBy: "auto:proposal_closed",
          decidedAt: "2026-08-16T12:41:07.000Z",
        }}
        apiCalls={apiCalls}
      />,
    );
    expect(
      view.getByText("This question no longer needs an answer."),
    ).toBeTruthy();
    expect(view.getByText("auto:proposal_closed")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("submits with Enter when valid, ignores plain Enter in textarea, and submits with Cmd+Enter/Ctrl+Enter from anywhere", async () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );

    // Negative test: Enter with no option selected does nothing
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(apiCalls.decide).not.toHaveBeenCalled();

    // Select option 1 (Authorise, which requires paths + confirm)
    fireEvent.keyDown(document.body, { key: "1" });

    // Negative test: Enter with invalid form does nothing
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(apiCalls.decide).not.toHaveBeenCalled();

    // Fill required fields
    fireEvent.click(view.getByLabelText("event-runtime/lib/adapters/pi.mjs"));
    fireEvent.click(
      view.getByLabelText(/I understand this changes secret handling/),
    );

    // Focus textarea and press plain Enter - should NOT submit (multiline entry)
    const textarea = view.getByLabelText(
      "Anything I should know before I start",
    );
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(apiCalls.decide).not.toHaveBeenCalled();

    // Press Cmd+Enter inside textarea - SHOULD submit
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    await waitFor(() => expect(apiCalls.decide).toHaveBeenCalledTimes(1));
    expect(apiCalls.decide).toHaveBeenCalledWith("inbox_decision", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "authorise",
      fields: { paths: ["pi"], confirm: true },
    });
  });

  test("submits with plain Enter from anywhere when option has no extra required fields", async () => {
    render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );

    // Select option 2 (Send back to Triage, which has no required fields)
    fireEvent.keyDown(document.body, { key: "2" });

    // Plain Enter submits
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(apiCalls.decide).toHaveBeenCalledTimes(1));
    expect(apiCalls.decide).toHaveBeenCalledWith("inbox_decision", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "triage",
      fields: {},
    });
  });

  test("Ctrl+Enter submits when connected, and ignores shortcuts when disconnected", async () => {
    const disconnectedView = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        connected={false}
        apiCalls={apiCalls}
      />,
    );

    fireEvent.keyDown(document.body, { key: "2" });
    fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
    expect(apiCalls.decide).not.toHaveBeenCalled();

    disconnectedView.unmount();

    render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        connected={true}
        apiCalls={apiCalls}
      />,
    );

    fireEvent.keyDown(document.body, { key: "2" });
    fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(apiCalls.decide).toHaveBeenCalledTimes(1));
  });

  test("displays shortcut hint on submit button when an option is selected", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );

    const submitBtnBefore = view.getByRole("button", {
      name: "Choose an option",
    });
    expect(submitBtnBefore.querySelector(".mono")).toBeNull();

    // Select option 2
    fireEvent.keyDown(document.body, { key: "2" });

    const submitBtnAfter = view.getByRole("button", {
      name: "Send back to Triage",
    });
    const hint = submitBtnAfter.querySelector(".mono");
    expect(hint).toBeTruthy();
    expect(hint?.textContent).toBe("↵");
  });
});
