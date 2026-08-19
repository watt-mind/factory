import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AgentHoverCard } from "./AgentHoverCard";
import {
  createAgentsFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { AgentDef } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
});

const sampleAgent: AgentDef = {
  ref: "triage-scan",
  id: "triage-scan",
  version: 2,
  outputContract: "triage/v1",
  workspace: { type: "ephemeral" },
  capabilities: { filesystem: "read", services: ["github", "linear"] },
  limits: { timeout_seconds: 450, attempts: 2 },
  mutating: true,
  promptFile: "agents/triage-scan.prompt.md",
  prompt: "You are a triage agent...",
  inputSchemaFile: "agents/triage-scan.input.json",
  inputSchema: {},
  outputSchemaFile: "agents/triage-scan.output.json",
  outputSchema: {},
  pins: {},
  command: null,
  actionRegistry: null,
  hosts: null,
  modelTier: "strong",
  model: "claude-3-7-sonnet",
  eventTypes: [
    {
      type: "github/issue.opened",
      adapter: "claude",
      idempotencyScope: "repo",
      proposalTtlSeconds: null,
      resolvedModel: "claude-3-7-sonnet",
    },
    {
      type: "github/issue.labeled",
      adapter: "claude",
      idempotencyScope: "repo",
      proposalTtlSeconds: null,
      resolvedModel: "claude-3-7-sonnet",
    },
  ],
};

const agentsApi = () => ({
  agents: mock(async () => createAgentsFixture({ agents: [sampleAgent] })),
});

/** The element carrying the popup ARIA state (wrapper or inner trigger). */
function triggerOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[aria-haspopup='dialog']");
  if (!el) throw new Error("hover card trigger not found");
  return el;
}

describe("AgentHoverCard", () => {
  test("renders trigger with agent ref and opens hover card with details", async () => {
    const onJumpAgent = mock(() => {});

    await withApi(agentsApi(), async () => {
      const r = renderWithClient(
        <AgentHoverCard agentRef="triage-scan" onJumpAgent={onJumpAgent} />,
      );

      expect(r.getByText("triage-scan")).toBeTruthy();

      // Hover over the trigger
      const trigger = r.getByText("triage-scan");
      fireEvent.mouseEnter(trigger);

      // Wait for hover card portal to render with agent details
      await waitFor(() => {
        expect(r.getByRole("dialog")).toBeTruthy();
        expect(r.getByText("v2")).toBeTruthy();
        expect(r.getByText("Mutating")).toBeTruthy();
        expect(r.getByText("claude-3-7-sonnet")).toBeTruthy();
        expect(r.getByText("triage/v1")).toBeTruthy();
        expect(r.getByText("ephemeral")).toBeTruthy();
        expect(r.getByText(/450s timeout/)).toBeTruthy();
        expect(r.getByText(/github, linear/)).toBeTruthy();
      });

      // Click "Open in Agents"
      const openBtn = r.getByRole("button", { name: /Open in Agents/i });
      fireEvent.click(openBtn);
      expect(onJumpAgent).toHaveBeenCalledWith("triage-scan");
    });
  });

  test("names the card so a screen reader announces which agent it describes", async () => {
    await withApi(agentsApi(), async () => {
      const r = renderWithClient(<AgentHoverCard agentRef="triage-scan" />);
      fireEvent.mouseEnter(r.getByText("triage-scan"));

      await waitFor(() =>
        expect(r.getByRole("dialog").getAttribute("aria-label")).toBe(
          "Agent triage-scan",
        ),
      );
    });
  });

  test("opens on keyboard focus, not only on hover", async () => {
    await withApi(agentsApi(), async () => {
      const r = renderWithClient(<AgentHoverCard agentRef="triage-scan" />);
      const jump = r.getByRole("button", { name: /triage-scan/ });

      jump.focus();
      fireEvent.focus(jump);

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(jump.getAttribute("aria-haspopup")).toBe("dialog");
      expect(jump.getAttribute("aria-expanded")).toBe("true");
      expect(jump.getAttribute("aria-controls")).toBe(r.getByRole("dialog").id);
      expect(jump.parentElement?.hasAttribute("aria-haspopup")).toBe(false);
    });
  });

  test("Escape closes the card and returns focus to the agent link", async () => {
    await withApi(agentsApi(), async () => {
      const r = renderWithClient(<AgentHoverCard agentRef="triage-scan" />);
      const jump = r.getByRole("button", { name: /triage-scan/ });
      jump.focus();
      fireEvent.focus(jump);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      fireEvent.keyDown(window, { key: "Escape" });

      await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(jump);
    });
  });

  test("ArrowDown opens the card and moves focus into it", async () => {
    const onJumpAgent = mock(() => {});
    await withApi(agentsApi(), async () => {
      const r = renderWithClient(
        <AgentHoverCard agentRef="triage-scan" onJumpAgent={onJumpAgent} />,
      );
      const trigger = triggerOf(r.container);
      r.getByRole("button", { name: /triage-scan/ }).focus();

      fireEvent.keyDown(trigger, { key: "ArrowDown" });

      await waitFor(() =>
        expect(document.activeElement).toBe(
          r.getByRole("button", { name: /Open in Agents/i }),
        ),
      );
    });
  });

  test("dismisses when the table underneath scrolls", async () => {
    await withApi(agentsApi(), async () => {
      const r = renderWithClient(
        <div data-testid="table-scroll">
          <AgentHoverCard agentRef="triage-scan" />
        </div>,
      );
      fireEvent.mouseEnter(r.getByText("triage-scan"));
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      fireEvent.scroll(r.getByTestId("table-scroll"));

      await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());
    });
  });

  test("falls back to the resolved Agents route when no jump handler is wired", async () => {
    await withApi(agentsApi(), async () => {
      const r = renderWithClient(<AgentHoverCard agentRef="triage-scan" />);
      fireEvent.mouseEnter(r.getByText("triage-scan"));

      await waitFor(() =>
        expect(
          r.getByRole("link", { name: /Open in Agents/i }).getAttribute("href"),
        ).toBe("#/agents/triage-scan"),
      );
    });
  });

  test("keeps custom trigger content clickable and its own tab stop", async () => {
    const onJumpAgent = mock(() => {});
    await withApi(agentsApi(), async () => {
      const r = renderWithClient(
        <AgentHoverCard agentRef="triage-scan" onJumpAgent={onJumpAgent}>
          <span>custom label</span>
        </AgentHoverCard>,
      );

      expect(triggerOf(r.container).getAttribute("tabindex")).toBe("0");
      fireEvent.click(r.getByText("custom label"));
      expect(onJumpAgent).toHaveBeenCalledWith("triage-scan");
    });
  });
});
