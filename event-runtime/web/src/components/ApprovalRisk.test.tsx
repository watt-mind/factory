import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApprovalRiskDetails, ApprovalSafetyCard, computeApprovalRisk } from "./ApprovalRisk";
import { createProposalFixture, createRunSpecFixture, restoreApi } from "../test-render";
import type { AgentDef, Proposal } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
});

function stubAgent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    ref: "shipper@1",
    id: "shipper",
    version: 1,
    outputContract: "factory.agent-result/v1",
    workspace: { type: "ephemeral" },
    capabilities: { filesystem: "workspace-only" },
    limits: { timeout_seconds: 600, attempts: 1 },
    mutating: false,
    promptFile: "agents/shipper.md",
    prompt: "",
    inputSchemaFile: "schemas/shipper.input.json",
    inputSchema: {},
    outputSchemaFile: "schemas/agent-result.output.json",
    outputSchema: {},
    pins: {},
    command: null,
    actionRegistry: null,
    hosts: null,
    modelTier: "standard",
    model: null,
    eventTypes: [],
    ...over,
  } as AgentDef;
}

function proposal(over: Partial<Proposal> = {}, spec: Record<string, unknown> = {}): Proposal {
  return createProposalFixture({
    agent: "shipper",
    repos: ["watt-mind/factory"],
    spec: createRunSpecFixture("run_1", { agent: "shipper", ...spec }),
    ...over,
  });
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("computeApprovalRisk (WM-505)", () => {
  test("returns null when the proposal carries no spec", () => {
    expect(computeApprovalRisk(proposal({ spec: null }))).toBeNull();
  });

  test("prefers the agent definition for mutating and egress", () => {
    const risk = computeApprovalRisk(
      proposal({}, { capabilities: [] }),
      stubAgent({ mutating: true, capabilities: { filesystem: "rw", services: ["github"] } }),
    );
    expect(risk?.mutating).toBe(true);
    expect(risk?.egress).toEqual(["github"]);
  });

  test("falls back to capability regexes when the agent is unknown", () => {
    const risk = computeApprovalRisk(proposal({}, { capabilities: ["gh:write", "http:fetch"] }));
    expect(risk?.mutating).toBe(true);
    expect(risk?.egress).toEqual(["http:fetch"]);
  });

  test("a read-only, short, unprotected-branch run scores LOW", () => {
    const risk = computeApprovalRisk(
      proposal({}, { capabilities: ["linear:read"], timeoutSeconds: 120, input: { branch: "feat/x" } }),
      stubAgent({ mutating: false, capabilities: { filesystem: "ro" } }),
    );
    expect(risk?.blast).toBe("LOW");
    expect(risk?.mutating).toBe(false);
  });

  test("a mutating run on a protected branch with egress scores HIGH", () => {
    const risk = computeApprovalRisk(
      proposal({}, { capabilities: ["gh:write"], timeoutSeconds: 900, input: { branch: "main" } }),
      stubAgent({ mutating: true, capabilities: { filesystem: "rw", services: ["github"] } }),
    );
    expect(risk?.blast).toBe("HIGH");
    expect(risk?.branch).toBe("main");
  });

  test("target repo falls back to the spec input when the proposal is unscoped", () => {
    const risk = computeApprovalRisk(proposal({ repos: [] }, { input: { repo: "acme/thing" } }));
    expect(risk?.repo).toBe("acme/thing");
    expect(computeApprovalRisk(proposal({ repos: [] }, { input: {} }))?.repo).toBe("unscoped");
  });

  test("host reports the placement when the spec pins one", () => {
    const risk = computeApprovalRisk(proposal({}, { placement: { host: "worker-3" } }));
    expect(risk?.host).toBe("host=worker-3");
    expect(computeApprovalRisk(proposal())?.host).toBe("any worker");
  });
});

describe("ApprovalSafetyCard (WM-505)", () => {
  test("renders the mutating badge, blast verdict, capabilities and budget", () => {
    const r = renderWithClient(
      <ApprovalSafetyCard
        proposal={proposal({}, { capabilities: ["gh:write", "linear:read"], timeoutSeconds: 900, maxAttempts: 2 })}
        agent={stubAgent({ mutating: true, capabilities: { filesystem: "rw", services: ["github"] } })}
      />,
    );
    const text = r.container.textContent ?? "";
    expect(text).toContain("Mutating");
    expect(text).toContain("Risk");
    expect(text).toContain("gh:write");
    expect(text).toContain("linear:read");
    expect(text).toContain("15m");
    expect(text).toContain("max 2 att");
    expect(text).toContain("github");
  });

  test("labels a non-mutating agent Read-Only and sandboxed capabilities", () => {
    const r = renderWithClient(
      <ApprovalSafetyCard proposal={proposal({}, { capabilities: [] })} agent={stubAgent({ mutating: false })} />,
    );
    const text = r.container.textContent ?? "";
    expect(text).toContain("Read-Only");
    expect(text).toContain("none (sandboxed)");
  });

  test("renders an optional footer slot", () => {
    const r = renderWithClient(
      <ApprovalSafetyCard proposal={proposal()} footer={<span>Historical Comparison</span>} />,
    );
    expect(r.container.textContent).toContain("Historical Comparison");
  });

  test("renders nothing when the proposal has no spec", () => {
    const r = renderWithClient(<ApprovalSafetyCard proposal={proposal({ spec: null })} />);
    expect(r.container.textContent).toBe("");
  });
});

describe("ApprovalRiskDetails (WM-505)", () => {
  test("surfaces capabilities, budget and the immutable RunSpec", () => {
    const r = renderWithClient(
      <ApprovalRiskDetails
        proposal={proposal({}, { capabilities: ["gh:write"], timeoutSeconds: 900, maxAttempts: 2 })}
        agent={stubAgent({ mutating: true })}
      />,
    );
    const text = r.container.textContent ?? "";
    expect(text).toContain("gh:write");
    expect(text).toContain("15m");
    expect(text).toContain("Mutating");
    expect(text).toContain("immutable RunSpec");
  });

  test("warns rather than silently hiding risk when the spec is missing", () => {
    const r = renderWithClient(<ApprovalRiskDetails proposal={proposal({ spec: null })} />);
    expect(r.container.textContent).toContain("no RunSpec");
  });
});
