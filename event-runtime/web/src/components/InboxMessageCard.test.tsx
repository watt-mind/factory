import "../test-dom";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { InboxMessageCard, parseInboxMessage } from "./InboxMessageCard";

describe("InboxMessageCard", () => {
  test("groups markdown into section cards, lists, callouts, and safe inline formatting", () => {
    const { getByRole, getByText } = render(
      <InboxMessageCard
        title="Deployment needs a decision"
        body={`# What changed\n**Review** the \`run_123\` details.\n\n- First action\n- [Open the run](https://example.test/runs/123)\n\n> Warning: confirm the target before retrying.`}
      />,
    );

    expect(
      getByRole("heading", { name: "Deployment needs a decision" }),
    ).toBeTruthy();
    expect(getByRole("heading", { name: "What changed" })).toBeTruthy();
    expect(getByRole("list")).toBeTruthy();
    expect(getByRole("note").textContent).toContain("confirm the target");
    expect(getByText("warning")).toBeTruthy();
    expect(getByText("Open the run").getAttribute("href")).toBe(
      "https://example.test/runs/123",
    );
  });

  test("a multi-line callout keeps the warning tone raised by its first line", () => {
    const sections = parseInboxMessage(
      "> Warning: confirm the target.\n> Retrying is destructive.",
    );
    expect(sections[0].blocks).toEqual([
      {
        type: "callout",
        tone: "warning",
        lines: ["confirm the target.", "Retrying is destructive."],
      },
    ]);
  });

  test("keeps plain text as a paragraph and parses numbered lists", () => {
    const sections = parseInboxMessage("Plain update\n\n1. First\n2. Second");
    expect(sections).toEqual([
      {
        heading: null,
        blocks: [
          { type: "paragraph", lines: ["Plain update"] },
          { type: "list", ordered: true, items: ["First", "Second"] },
        ],
      },
    ]);
  });
});
