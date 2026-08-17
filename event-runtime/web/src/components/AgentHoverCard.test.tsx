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

describe("AgentHoverCard", () => {
  test("renders trigger with agent ref and opens hover card with details", async () => {
    const onJumpAgent = mock(() => {});

    await withApi(
      {
        agents: mock(async () =>
          createAgentsFixture({
            agents: [sampleAgent],
          }),
        ),
      },
      async () => {
        const r = renderWithClient(
          <AgentHoverCard agentRef="triage-scan" onJumpAgent={onJumpAgent} />,
        );

        expect(r.getByText("triage-scan")).toBeTruthy();

        // Hover over the trigger
        const trigger = r.getByText("triage-scan");
        fireEvent.mouseEnter(trigger);

        // Wait for hover card portal to render with agent details
        await waitFor(() => {
          expect(r.getByRole("tooltip")).toBeTruthy();
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
      },
    );
  });
});
