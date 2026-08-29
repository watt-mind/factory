import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import {
  Agents,
  PromotionPanel,
  adapterText,
  agentTabCounts,
  modelText,
  routeModel,
  tierText,
} from "./Agents";
import {
  EMPTY_VALUE,
  formatDurationSeconds,
} from "../components/AgentHoverCard";
import { api, ApiError } from "../api";
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
  const adapter = over.adapter ?? "claude";
  return {
    type: "factory.demo/v1",
    adapter,
    declaredAdapter: over.declaredAdapter ?? adapter,
    idempotencyScope: "repo",
    proposalTtlSeconds: null,
    resolvedModel: "sonnet",
    ...over,
  };
}

function stubAgent(id: string, over: Partial<AgentDef> = {}): AgentDef {
  const modelTier = Object.hasOwn(over, "modelTier")
    ? (over.modelTier ?? null)
    : "standard";
  const model = Object.hasOwn(over, "model") ? (over.model ?? null) : null;
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
    modelTier,
    declaredModelTier: over.declaredModelTier ?? modelTier,
    model,
    declaredModel: over.declaredModel ?? model,
    eventTypes: [stubRoute()],
    ...over,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const noop = () => {};

function renderAgents(focusAgentRef: string | null = null) {
  return renderWithClient(
    <Agents
      context={{ kind: "all" }}
      focusAgentRef={focusAgentRef}
      onSelectAgent={noop}
    />,
  );
}

function SelectableAgents() {
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  return (
    <Agents
      context={{ kind: "all" }}
      focusAgentRef={selectedRef}
      onSelectAgent={setSelectedRef}
    />
  );
}

function withAgents(
  agents: AgentDef[],
  fn: () => Promise<void>,
  extra: Partial<AgentsView> = {},
) {
  const orig = api.agents;
  const view: AgentsView = {
    agents,
    edges: {},
    eventTypes: [],
    contracts: {},
    adapters: ["claude", "pi", "cursor", "agy", "command", "actions", "fake"],
    ...extra,
  };
  api.agents = async () => view;
  return fn().finally(() => {
    api.agents = orig;
  });
}

describe("route model semantics (WM-211/WM-135)", () => {
  test("a resolved model is shown verbatim — it is what the planner pins", () => {
    expect(
      routeModel(
        stubRoute({ resolvedModel: "openai-codex/gpt-5.6-sol", adapter: "pi" }),
      ),
    ).toBe("openai-codex/gpt-5.6-sol");
  });

  test("non-model adapters read n/a, never blank — a fixed argv has no model by construction", () => {
    for (const adapter of ["command", "actions", "fake"]) {
      expect(routeModel(stubRoute({ adapter, resolvedModel: null }))).toBe(
        "n/a",
      );
    }
  });

  test("a model adapter that pins nothing rides the CLI default — not n/a", () => {
    expect(
      routeModel(stubRoute({ adapter: "claude", resolvedModel: null })),
    ).toBe("default");
    expect(routeModel(stubRoute({ adapter: "pi", resolvedModel: null }))).toBe(
      "default",
    );
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
    expect(adapterText(orphan)).toBe(EMPTY_VALUE);
    expect(modelText(orphan)).toBe(EMPTY_VALUE);
    expect(tierText(orphan)).toBe("strong");
  });

  test("tier falls back to override when a definition names an exact id instead of a tier", () => {
    expect(tierText(stubAgent("x", { modelTier: null, model: "haiku" }))).toBe(
      "override",
    );
    expect(tierText(stubAgent("x", { modelTier: null, model: null }))).toBe(
      EMPTY_VALUE,
    );
  });
});

describe("Agents registry presentation (WM-551)", () => {
  test("humanizes timeout seconds and counts mutation-safety tabs", () => {
    expect(formatDurationSeconds(2700)).toBe("45m");
    expect(formatDurationSeconds(2100)).toBe("35m");
    expect(formatDurationSeconds(600)).toBe("10m");
    expect(formatDurationSeconds(90)).toBe("1m 30s");
    expect(formatDurationSeconds(null)).toBe(EMPTY_VALUE);
    expect(
      agentTabCounts([
        stubAgent("dispatch", { mutating: true }),
        stubAgent("reaper"),
        stubAgent("report"),
      ]),
    ).toEqual({ ALL: 3, MUTATING: 1, READ_ONLY: 2 });
  });
});

describe("Agents table columns (WM-211)", () => {
  test("adapter, tier, and resolved model are visible without touching Display Options", async () => {
    const agents = [
      stubAgent("dispatch", {
        modelTier: "strong",
        eventTypes: [
          stubRoute({ type: "factory.dispatch/v1", resolvedModel: "default" }),
        ],
      }),
      stubAgent("reaper", {
        modelTier: null,
        eventTypes: [
          stubRoute({
            type: "factory.reap/v1",
            adapter: "command",
            resolvedModel: null,
          }),
        ],
      }),
    ];
    await withAgents(agents, async () => {
      const { getByText, getAllByText, getByRole } = renderAgents();
      await waitFor(() => {
        expect(getByText("dispatch@1")).toBeTruthy();
      });
      for (const label of ["Adapter", "Tier", "Model"]) {
        expect(
          getByRole("columnheader", { name: new RegExp(label) }),
        ).toBeTruthy();
      }
      expect(getAllByText("claude").length).toBeGreaterThan(0);
      expect(getByText("strong")).toBeTruthy();
      // The command agent's model cell is explicit, not empty (WM-211 AC 3).
      expect(getAllByText("command").length).toBeGreaterThan(0);
      expect(getByText("n/a")).toBeTruthy();
    });
  });

  test("a hidden column is dropped from the header and every row, and persists", async () => {
    localStorage.setItem(
      "evrt-display-agents",
      JSON.stringify({ hiddenColumns: ["capabilities"] }),
    );
    await withAgents([stubAgent("dispatch")], async () => {
      const { queryByRole, getByRole } = renderAgents();
      await waitFor(() => {
        expect(getByRole("columnheader", { name: /Adapter/ })).toBeTruthy();
      });
      expect(queryByRole("columnheader", { name: /Capabilities/ })).toBeNull();
    });
  });

  test("grouping by adapter sections the fleet, and every row still renders", async () => {
    localStorage.setItem(
      "evrt-display-agents",
      JSON.stringify({ groupBy: "adapter" }),
    );
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
      const headers = getAllByRole("button", { expanded: true }).map(
        (b) => b.textContent ?? "",
      );
      expect(headers.filter((t) => /claude1/.test(t))).toHaveLength(1);
      expect(headers.filter((t) => /command1/.test(t))).toHaveLength(1);
    });
  });
});

describe("Agents table accessible selection (WM-754)", () => {
  test("the selected agent row is exposed as selected in the accessibility tree", async () => {
    const agents = [stubAgent("alpha"), stubAgent("beta")];
    await withAgents(agents, async () => {
      const r = renderWithClient(<SelectableAgents />);
      const grid = await r.findByRole("grid", { name: "Agents registry" });
      expect(within(grid).getAllByRole("rowgroup")).toHaveLength(2);

      const alpha = r.getByRole("row", { name: "alpha@1" });
      const beta = r.getByRole("row", { name: "beta@1" });
      expect(alpha.getAttribute("role")).toBe("row");
      expect(within(alpha).getAllByRole("gridcell").length).toBeGreaterThan(0);
      expect(r.queryByRole("row", { selected: true })).toBeNull();

      alpha.focus();
      fireEvent.keyDown(alpha, { key: "Enter" });
      expect(r.getByRole("row", { selected: true, name: "alpha@1" })).toBe(
        alpha,
      );
      expect(r.getByRole("row", { selected: false, name: "beta@1" })).toBe(
        beta,
      );

      fireEvent.keyDown(alpha, { key: "ArrowDown" });
      expect(document.activeElement).toBe(beta);
      expect(r.getByRole("row", { selected: true, name: "beta@1" })).toBe(beta);
      expect(
        r.queryByRole("row", { selected: true, name: "alpha@1" }),
      ).toBeNull();
    });
  });
});

describe("Agents table keyboard navigation (WM-732)", () => {
  test("rows are named, activate with Enter, and arrow between visible agents", async () => {
    const agents = [stubAgent("alpha"), stubAgent("beta"), stubAgent("gamma")];
    await withAgents(agents, async () => {
      const r = renderWithClient(<SelectableAgents />);
      const alpha = await r.findByRole("row", { name: /alpha@1/ });
      const beta = r.getByRole("row", { name: /beta@1/ });

      alpha.focus();
      fireEvent.keyDown(alpha, { key: "Enter" });
      expect(
        r.getByRole("button", { name: "Copy agent ref (c)" }),
      ).toBeTruthy();
      expect(alpha.getAttribute("aria-selected")).toBe("true");

      const bubbledKeys: string[] = [];
      const recordBubbledKey = (event: KeyboardEvent) =>
        bubbledKeys.push(event.key);
      window.addEventListener("keydown", recordBubbledKey);
      fireEvent.keyDown(alpha, { key: "ArrowDown" });
      window.removeEventListener("keydown", recordBubbledKey);
      expect(document.activeElement).toBe(beta);
      expect(beta.getAttribute("aria-selected")).toBe("true");
      expect(bubbledKeys).toEqual([]);

      fireEvent.keyDown(beta, { key: "ArrowUp" });
      expect(document.activeElement).toBe(alpha);
      expect(alpha.getAttribute("aria-selected")).toBe("true");
    });
  });
});

describe("Agents detail pane (WM-211)", () => {
  test("renders the shared Agents breadcrumb in the standard pane width (WM-552)", async () => {
    const agent = stubAgent("dispatch");
    await withAgents([agent], async () => {
      const view = renderAgents(agent.ref);
      const breadcrumb = await view.findByRole("navigation", {
        name: "Breadcrumb",
      });

      expect(breadcrumb.textContent).toContain("Agents/");
      expect(breadcrumb.textContent).toContain("dispatch@1");
      expect(view.container.querySelector("aside")?.className).toContain(
        "w-[440px]",
      );
    });
  });

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
      const { getByText, getAllByText, getByLabelText } =
        renderAgents("pi-smoke@1");
      await waitFor(() => {
        expect(getByText("model tier")).toBeTruthy();
      });
      // The tier reads the same in the row cell and the detail pane, by design.
      expect(getAllByText("light").length).toBeGreaterThan(0);
      expect(getByText("model override")).toBeTruthy();
      expect(getAllByText("openai-codex/gpt-5.6-luna").length).toBeGreaterThan(
        0,
      );
      expect(
        getByLabelText("Adapter overlay for factory.pi-smoke/v1"),
      ).toBeTruthy();
    });
  });

  test("a command agent's routing line says n/a rather than leaving the model unsaid", async () => {
    const agents = [
      stubAgent("reaper", {
        modelTier: null,
        eventTypes: [
          stubRoute({
            type: "factory.reap/v1",
            adapter: "command",
            resolvedModel: null,
          }),
        ],
      }),
    ];
    await withAgents(agents, async () => {
      const { getByText, getAllByText, getByLabelText } =
        renderAgents("reaper@1");
      await waitFor(() => {
        expect(getByText("model tier")).toBeTruthy();
      });
      expect(getAllByText("n/a").length).toBeGreaterThan(0);
      expect(
        getByLabelText("Adapter overlay for factory.reap/v1"),
      ).toBeTruthy();
    });
  });
});

describe("Agents overlay editors (WM-884)", () => {
  test("select+save paints the this-runtime chip; revert restores declared", async () => {
    const agent = stubAgent("demo", {
      eventTypes: [
        stubRoute({
          type: "factory.demo.requested",
          adapter: "pi",
          declaredAdapter: "pi",
        }),
      ],
    });
    let current = [agent];
    const origAgents = api.agents;
    const origPut = api.putEventTypeOverride;
    const origDel = api.deleteEventTypeOverride;
    api.agents = async () => ({
      agents: current,
      edges: {},
      eventTypes: [],
      contracts: {},
      adapters: ["pi", "cursor"],
    });
    api.putEventTypeOverride = async (type, body) => {
      current = current.map((row) => ({
        ...row,
        eventTypes: row.eventTypes.map((route) =>
          route.type === type ? { ...route, adapter: body.adapter } : route,
        ),
      }));
      return { patch: body };
    };
    api.deleteEventTypeOverride = async (type) => {
      current = current.map((row) => ({
        ...row,
        eventTypes: row.eventTypes.map((route) =>
          route.type === type
            ? { ...route, adapter: route.declaredAdapter ?? route.adapter }
            : route,
        ),
      }));
      return { deleted: true };
    };
    try {
      const { getByLabelText, getByRole, queryByText } = renderAgents(
        agent.ref,
      );
      const select = await waitFor(() =>
        getByLabelText("Adapter overlay for factory.demo.requested"),
      );
      fireEvent.change(select, { target: { value: "cursor" } });
      await waitFor(() => {
        expect(queryByText("this runtime")).toBeTruthy();
      });
      fireEvent.click(getByRole("button", { name: "Revert" }));
      await waitFor(() => {
        expect(queryByText("this runtime")).toBeNull();
      });
    } finally {
      api.agents = origAgents;
      api.putEventTypeOverride = origPut;
      api.deleteEventTypeOverride = origDel;
    }
  });

  test("a 422 leaves declared values on screen", async () => {
    const agent = stubAgent("demo", {
      eventTypes: [
        stubRoute({
          type: "factory.demo.requested",
          adapter: "pi",
          declaredAdapter: "pi",
        }),
      ],
    });
    const origAgents = api.agents;
    const origPut = api.putEventTypeOverride;
    api.agents = async () => ({
      agents: [agent],
      edges: {},
      eventTypes: [],
      contracts: {},
      adapters: ["pi", "cursor"],
    });
    api.putEventTypeOverride = async () => {
      throw new ApiError('unknown adapter "nope"', 422);
    };
    try {
      const { getByLabelText, queryByText } = renderAgents(agent.ref);
      const select = await waitFor(() =>
        getByLabelText("Adapter overlay for factory.demo.requested"),
      );
      fireEvent.change(select, { target: { value: "cursor" } });
      await waitFor(() => {
        expect((select as HTMLSelectElement).value).toBe("pi");
      });
      expect(queryByText("this runtime")).toBeNull();
    } finally {
      api.agents = origAgents;
      api.putEventTypeOverride = origPut;
    }
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
      const refBtn = await r.findByRole("button", {
        name: "Copy agent ref (c)",
      });

      // Verify icon-action tooltips preserve shortcut discoverability.
      expect(
        refBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
      ).toBe("Copy agent ref · c");
      const linkBtn = r.getByRole("button", { name: "Copy link (c l)" });
      expect(
        linkBtn.parentElement?.querySelector('[role="tooltip"]')?.textContent,
      ).toBe("Copy link · c l");

      // 1. Press 'c' -> copies agent.ref
      fireEvent.keyDown(document.body, { key: "c" });
      expect(written).toBe(agent.ref);

      // 2. Press 'l' immediately after 'c' -> 'c l' copies link
      fireEvent.keyDown(document.body, { key: "l" });
      expect(written).toBe(window.location.href);
    });
  });
});

describe("PromotionPanel (gh-860)", () => {
  const preview = {
    digest: "sha256:deadbeef",
    selections: [
      {
        key: "eventType:factory.demo/v1:adapter",
        kind: "eventType" as const,
        ref: "factory.demo/v1",
        field: "adapter" as const,
        target: {
          file: "event-runtime/event-types.json",
          path: '["x"].adapter',
        },
        before: "pi",
        effective: "cursor",
        current: true,
      },
      {
        key: "agent:stale@1:modelTier",
        kind: "agent" as const,
        ref: "stale@1",
        field: "modelTier" as const,
        target: { file: "event-runtime/agents/stale.json", path: "model_tier" },
        before: "strong",
        effective: "strong",
        current: false,
      },
    ],
  };

  function withPromotionStubs(fn: () => Promise<void>) {
    const origPreview = api.promotionPreview;
    const origRepos = api.repos;
    const origApply = api.promotionApply;
    api.promotionPreview = async () => preview;
    api.repos = async () =>
      ({ repos: [{ name: "factory" }] }) as Awaited<
        ReturnType<typeof api.repos>
      >;
    return fn().finally(() => {
      api.promotionPreview = origPreview;
      api.repos = origRepos;
      api.promotionApply = origApply;
    });
  }

  test("previews divergent overrides, promotes a selected subset, and links the PR", async () => {
    await withPromotionStubs(async () => {
      const applied: { repo: string; digest: string; keys: string[] }[] = [];
      api.promotionApply = async (body) => {
        applied.push(body);
        return {
          status: "opened",
          repo: body.repo,
          ticket: "gh-860-x",
          branch: "promo/x",
          pr: { url: "https://example/pr/9", number: 9 },
        };
      };

      const r = renderWithClient(<PromotionPanel defaultRepo="factory" />);

      // Collapsed by default: only the opener button, no preview fetch implied.
      fireEvent.click(
        r.getByRole("button", { name: "Promote overrides to Git…" }),
      );

      // The divergent row is selectable; the non-current one is disabled.
      const good = await waitFor(() =>
        r.getByLabelText("eventType:factory.demo/v1:adapter"),
      );
      const stale = r.getByLabelText("agent:stale@1:modelTier");
      expect((stale as HTMLInputElement).disabled).toBe(true);

      fireEvent.click(good);
      fireEvent.click(r.getByRole("button", { name: "Promote 1 selected" }));

      await waitFor(() => r.getByText("PR #9"));
      expect(applied).toEqual([
        {
          repo: "factory",
          digest: "sha256:deadbeef",
          keys: ["eventType:factory.demo/v1:adapter"],
        },
      ]);
      expect(r.getByText("PR #9").getAttribute("href")).toBe(
        "https://example/pr/9",
      );
    });
  });
});
