import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agents, adapterText, modelText, routeModel, tierText } from "./Agents";
import { api } from "../api";
import type { AgentDef, AgentEventRoute, AgentsView } from "../types";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // Display options simply do not persist here; nothing to reset.
  }
});

function stubRoute(over: Partial<AgentEventRoute> = {}): AgentEventRoute {
  return {
    type: "factory.demo/v1",
    adapter: "claude",
    idempotencyScope: "repo",
    proposalTtlSeconds: null,
    resolvedModel: "sonnet",
    ...over,
  };
}

function stubAgent(id: string, over: Partial<AgentDef> = {}): AgentDef {
  return {
    ref: `${id}@1`,
    id,
    version: 1,
    outputContract: "factory.agent-result/v1",
    workspace: { type: "ephemeral" },
    capabilities: { filesystem: "workspace-only" },
    limits: { timeout_seconds: 600, attempts: 1 },
    mutating: false,
    promptFile: `agents/${id}.md`,
    prompt: "",
    inputSchemaFile: `schemas/${id}.input.json`,
    inputSchema: {},
    outputSchemaFile: "schemas/agent-result.output.json",
    outputSchema: {},
    pins: {},
    command: null,
    actionRegistry: null,
    hosts: null,
    modelTier: "standard",
    model: null,
    eventTypes: [stubRoute()],
    ...over,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const noop = () => {};

function renderAgents(focusAgentRef: string | null = null) {
  return renderWithClient(
    <Agents context={{ kind: "all" }} focusAgentRef={focusAgentRef} onSelectAgent={noop} />,
  );
}

function withAgents(agents: AgentDef[], fn: () => Promise<void>) {
  const orig = api.agents;
  const view: AgentsView = { agents, edges: {}, eventTypes: [], contracts: {} };
  api.agents = async () => view;
  return fn().finally(() => {
    api.agents = orig;
  });
}

describe("route model semantics (WM-211/WM-135)", () => {
  test("a resolved model is shown verbatim — it is what the planner pins", () => {
    expect(routeModel(stubRoute({ resolvedModel: "openai-codex/gpt-5.6-sol", adapter: "pi" }))).toBe(
      "openai-codex/gpt-5.6-sol",
    );
  });

  test("non-model adapters read n/a, never blank — a fixed argv has no model by construction", () => {
    for (const adapter of ["command", "actions", "fake"]) {
      expect(routeModel(stubRoute({ adapter, resolvedModel: null }))).toBe("n/a");
    }
  });

  test("a model adapter that pins nothing rides the CLI default — not n/a", () => {
    expect(routeModel(stubRoute({ adapter: "claude", resolvedModel: null }))).toBe("default");
    expect(routeModel(stubRoute({ adapter: "pi", resolvedModel: null }))).toBe("default");
  });
});

describe("row roll-ups across routes (WM-211)", () => {
  test("adapter is the distinct set in route order, so a mixed agent is not misreported", () => {
    const mixed = stubAgent("mixed", {
      eventTypes: [
        stubRoute({ type: "a", adapter: "claude" }),
        stubRoute({ type: "b", adapter: "command", resolvedModel: null }),
        stubRoute({ type: "c", adapter: "claude" }),
      ],
    });
    expect(adapterText(mixed)).toBe("claude, command");
    expect(modelText(mixed)).toBe("sonnet, n/a");
  });

  test("an agent nothing routes to shows a dash — nothing resolves, whatever it declares", () => {
    const orphan = stubAgent("orphan", { eventTypes: [], modelTier: "strong" });
    expect(adapterText(orphan)).toBe("-");
    expect(modelText(orphan)).toBe("-");
    expect(tierText(orphan)).toBe("strong");
  });

  test("tier falls back to override when a definition names an exact id instead of a tier", () => {
    expect(tierText(stubAgent("x", { modelTier: null, model: "haiku" }))).toBe("override");
    expect(tierText(stubAgent("x", { modelTier: null, model: null }))).toBe("-");
  });
});

describe("Agents table columns (WM-211)", () => {
  test("adapter, tier, and resolved model are visible without touching Display Options", async () => {
    const agents = [
      stubAgent("dispatch", {
        modelTier: "strong",
        eventTypes: [stubRoute({ type: "factory.dispatch/v1", resolvedModel: "default" })],
      }),
      stubAgent("reaper", {
        modelTier: null,
        eventTypes: [
          stubRoute({ type: "factory.reap/v1", adapter: "command", resolvedModel: null }),
        ],
      }),
    ];
    await withAgents(agents, async () => {
      const { getByText, getAllByText, getByRole } = renderAgents();
      await waitFor(() => {
        expect(getByText("dispatch@1")).toBeTruthy();
      });
      for (const label of ["Adapter", "Tier", "Model"]) {
        expect(getByRole("columnheader", { name: new RegExp(label) })).toBeTruthy();
      }
      expect(getAllByText("claude").length).toBeGreaterThan(0);
      expect(getByText("strong")).toBeTruthy();
      // The command agent's model cell is explicit, not empty (WM-211 AC 3).
      expect(getAllByText("command").length).toBeGreaterThan(0);
      expect(getByText("n/a")).toBeTruthy();
    });
  });

  test("a hidden column is dropped from the header and every row, and persists", async () => {
    localStorage.setItem("evrt-display-agents", JSON.stringify({ hiddenColumns: ["capabilities"] }));
    await withAgents([stubAgent("dispatch")], async () => {
      const { queryByRole, getByRole } = renderAgents();
      await waitFor(() => {
        expect(getByRole("columnheader", { name: /Adapter/ })).toBeTruthy();
      });
      expect(queryByRole("columnheader", { name: /Capabilities/ })).toBeNull();
    });
  });

  test("grouping by adapter sections the fleet, and every row still renders", async () => {
    localStorage.setItem("evrt-display-agents", JSON.stringify({ groupBy: "adapter" }));
    const agents = [
      stubAgent("dispatch"),
      stubAgent("reaper", {
        eventTypes: [stubRoute({ adapter: "command", resolvedModel: null })],
      }),
    ];
    await withAgents(agents, async () => {
      const { getByText, getAllByRole } = renderAgents();
      await waitFor(() => {
        expect(getByText("dispatch@1")).toBeTruthy();
      });
      expect(getByText("reaper@1")).toBeTruthy();
      // One collapsible section header per adapter bucket — the header text
      // repeats the cell text, so identity is the aria-expanded control.
      const headers = getAllByRole("button", { expanded: true }).map((b) => b.textContent ?? "");
      expect(headers.filter((t) => /claude1/.test(t))).toHaveLength(1);
      expect(headers.filter((t) => /command1/.test(t))).toHaveLength(1);
    });
  });
});

describe("Agents detail pane (WM-211)", () => {
  test("declared tier, exact override, and the per-route resolved model are all readable", async () => {
    const agents = [
      stubAgent("pi-smoke", {
        modelTier: "light",
        model: "openai-codex/gpt-5.6-luna",
        eventTypes: [
          stubRoute({
            type: "factory.pi-smoke/v1",
            adapter: "pi",
            resolvedModel: "openai-codex/gpt-5.6-luna",
          }),
        ],
      }),
    ];
    await withAgents(agents, async () => {
      const { getByText, getAllByText } = renderAgents("pi-smoke@1");
      await waitFor(() => {
        expect(getByText("modelTier")).toBeTruthy();
      });
      // The tier reads the same in the row cell and the detail pane, by design.
      expect(getAllByText("light").length).toBeGreaterThan(0);
      expect(getByText("model override")).toBeTruthy();
      expect(getAllByText("openai-codex/gpt-5.6-luna").length).toBeGreaterThan(0);
      expect(getByText(/adapter pi/)).toBeTruthy();
    });
  });

  test("a command agent's routing line says n/a rather than leaving the model unsaid", async () => {
    const agents = [
      stubAgent("reaper", {
        modelTier: null,
        eventTypes: [
          stubRoute({ type: "factory.reap/v1", adapter: "command", resolvedModel: null }),
        ],
      }),
    ];
    await withAgents(agents, async () => {
      const { getByText, getAllByText } = renderAgents("reaper@1");
      await waitFor(() => {
        expect(getByText("modelTier")).toBeTruthy();
      });
      expect(getAllByText("n/a").length).toBeGreaterThan(0);
      expect(getByText(/adapter command/)).toBeTruthy();
    });
  });
});

describe("Agents copy chords and hints (WM-233)", () => {
  test("copy chords: c (ref), c l (link) and utility hints", async () => {
    let written = "";
    const mockClipboard = {
      writeText: (t: string) => {
        written = t;
        return Promise.resolve();
      },
    };
    Object.defineProperty(window.navigator, "clipboard", {
      value: mockClipboard,
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: mockClipboard,
      configurable: true,
    });

    const agent = stubAgent("test-agent");
    await withAgents([agent], async () => {
      const r = renderAgents(agent.ref);
      await r.findByText("copy:");

      // Verify utility hint badges
      const refBtn = r.getByRole("button", { name: "ref" });
      expect(refBtn.textContent).toContain("c");
      const linkBtn = r.getByRole("button", { name: "link" });
      expect(linkBtn.textContent).toContain("c l");

      // 1. Press 'c' -> copies agent.ref
      fireEvent.keyDown(document.body, { key: "c" });
      expect(written).toBe(agent.ref);

      // 2. Press 'l' immediately after 'c' -> 'c l' copies link
      fireEvent.keyDown(document.body, { key: "l" });
      expect(written).toBe(window.location.href);
    });
  });
});
