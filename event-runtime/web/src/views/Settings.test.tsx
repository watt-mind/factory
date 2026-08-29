import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ConfigExtension, ConfigView } from "../api";
import { changeInput, renderWithClient } from "../test-render";
import { Settings } from "./Settings";

const fixture: ConfigView = {
  generatedAt: "2026-08-18T10:00:00.000Z",
  policyVersion: "git:wm704",
  registry: {
    loadedAt: "2026-08-18T09:59:00.000Z",
    agentCount: 2,
    eventTypeCount: 3,
    edgeCount: 1,
    scheduleCount: 1,
  },
  sections: [
    {
      id: "repos",
      title: "Repositories",
      source: { file: "config/repos.yaml", kind: "yaml" },
      reload: "hot",
      entries: [
        {
          key: "factory.tools.base",
          value: "develop",
          note: "Repository factory.tools",
        },
      ],
    },
    {
      id: "policy",
      title: "Policy",
      source: { file: "config/policy.yaml", kind: "yaml" },
      reload: "hot",
      entries: [
        { key: "workers", value: { max: 20 } },
        { key: "notify", value: null },
      ],
    },
    {
      id: "policy-models",
      title: "Policy Models",
      source: { file: "config/policy.yaml", kind: "yaml" },
      reload: "restart",
      entries: [
        { key: "pi.standard", value: "provider/needle-model" },
        { key: "pi.light", value: "runtime/light" },
      ],
      modelTierConfig: {
        adapters: ["pi"],
        tiers: ["standard", "light"],
        tracked: {
          pi: {
            standard: "provider/needle-model",
            light: "provider/light",
          },
        },
        runtime: { pi: { light: "runtime/light" } },
        effective: {
          pi: {
            standard: "provider/needle-model",
            light: "runtime/light",
          },
        },
      },
    },
    {
      id: "nodes",
      title: "Nodes",
      source: { file: "config/nodes.yaml", kind: "yaml" },
      reload: "cli-only",
      entries: [{ key: "lab.env.keys", value: ["FACTORY_PORT"] }],
    },
    {
      id: "schedule",
      title: "Schedule",
      source: { file: "config/schedule.yaml", kind: "yaml" },
      reload: "cli-only",
      entries: [],
    },
    {
      id: "registry",
      title: "Registry",
      source: { file: "event-runtime/*.json", kind: "registry" },
      reload: "restart",
      entries: [
        { key: "agents", value: 2 },
        { key: "schedules", value: 1 },
      ],
    },
    {
      id: "extensions",
      title: "Extensions",
      source: { file: "config/policy.yaml", kind: "yaml" },
      reload: "restart",
      entries: [
        {
          key: "mobile",
          value: {
            simulator: "iPhone-16",
            apiToken: { set: true, source: "env" },
            pollEvery: "30s",
          },
          reload: "restart",
          note: "wattmind/mobile@1.0.0",
        },
        {
          key: "broken",
          value: null,
          reload: "restart",
          note: "wattmind/broken: disabled — config does not match ./config.schema.json — $.maxParallel: above maximum 4",
        },
      ],
      extensions: [
        {
          name: "wattmind/mobile",
          version: "1.0.0",
          path: "/ext/mobile",
          namespace: "mobile",
          reload: "restart",
          schema: {
            type: "object",
            properties: {
              simulator: {
                type: "string",
                title: "Simulator",
                description: "simulator name",
              },
              apiToken: {
                type: "string",
                format: "secret",
                title: "API token",
                description: "operator credential",
              },
              pollEvery: {
                type: "string",
                format: "duration",
                title: "Poll interval",
              },
            },
          },
          values: {
            simulator: "iPhone-16",
            apiToken: { set: true, source: "env" },
            pollEvery: "30s",
          },
          anomaly: null,
          contributions: {
            packs: 1,
            adapters: 2,
            connectors: 1,
            hooks: 0,
            panels: 1,
          },
        } as ConfigExtension,
        {
          name: "wattmind/broken",
          version: "2.0.0",
          path: "/ext/broken",
          namespace: "broken",
          reload: "restart",
          schema: null,
          values: null,
          anomaly:
            "wattmind/broken@2.0.0: config does not match ./config.schema.json — $.maxParallel: above maximum 4",
          contributions: {
            packs: 0,
            adapters: 0,
            connectors: 0,
            hooks: 0,
            panels: 0,
          },
        } as ConfigExtension,
      ],
    },
  ],
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubConfig() {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function StatefulSettings({ initial = null }: { initial?: string | null }) {
  const [section, setSection] = useState(initial);
  return <Settings focusSectionId={section} onSelectSection={setSection} />;
}

describe("Settings", () => {
  test("renders the section tree, counts, header metadata, and source/reload chips", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="policy" />);
    await view.findByText("workers");

    expect(
      view.getByRole("navigation", { name: "Settings sections" }),
    ).toBeTruthy();
    expect(
      view
        .getByRole("button", { name: /Policy\s*2/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(view.getByText("git:wm704")).toBeTruthy();
    expect(view.getByText("2026-08-18T09:59:00.000Z")).toBeTruthy();
    expect(view.getAllByText("policy.yaml").length).toBeGreaterThan(0);
    const hot = view.getAllByText("hot")[0];
    expect(hot.title).toContain("no serve restart");
    expect(hot.getAttribute("tabindex")).toBe("0");
    expect(hot.getAttribute("aria-label")).toContain("no serve restart");
    fireEvent.click(view.getByRole("button", { name: /Policy Models\s*2/ }));
    expect(
      await view.findByText(/take effect only after restarting serve/i),
    ).toBeTruthy();
  });

  test("searches keys and values across every section", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="repos" />);
    await view.findByText("factory.tools.base");

    act(() =>
      changeInput(
        view.getByRole("combobox", { name: "Search settings" }),
        "needle-model",
      ),
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Policy Models" })).toBeTruthy(),
    );
    expect(view.queryByText("factory.tools.base")).toBeNull();
    expect(view.getByRole("heading", { name: "Policy Models" })).toBeTruthy();
    expect(
      view.getByRole("textbox", { name: "pi standard model" }),
    ).toBeTruthy();
    expect(view.queryByRole("textbox", { name: "pi light model" })).toBeNull();

    act(() =>
      changeInput(
        view.getByRole("combobox", { name: "Search settings" }),
        "provider/light",
      ),
    );
    await waitFor(() =>
      expect(
        view.getByRole("textbox", { name: "pi light model" }),
      ).toBeTruthy(),
    );
    expect(
      view.queryByRole("textbox", { name: "pi standard model" }),
    ).toBeNull();
  });

  test("honours a deep-linked section and links repos and registry summaries to their owner views", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="registry" />);
    const agents = await view.findByRole("link", { name: "agents" });
    expect(agents.getAttribute("href")).toBe("#/agents");
    expect(
      view.getByRole("link", { name: "schedules" }).getAttribute("href"),
    ).toBe("#/schedules");

    fireEvent.click(view.getByRole("button", { name: /Repositories\s*1/ }));
    const repo = await view.findByRole("link", { name: "factory.tools.base" });
    expect(repo.getAttribute("href")).toBe("#/projects/factory.tools");
  });

  test("redirects an unknown section to the first section and uses the shared empty placeholder", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="missing" />);
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: /Repositories\s*1/ })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );

    fireEvent.click(view.getByRole("button", { name: /Policy\s*2/ }));
    expect(await view.findByText("notify")).toBeTruthy();
    expect(view.getByText("—")).toBeTruthy();
  });

  test("renders the Extensions section: namespace, effective values, and the anomaly of a disabled extension", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="extensions" />);
    await view.findByRole("heading", { name: "Extensions" });
    expect(
      view
        .getByRole("button", { name: /Extensions\s*2/ })
        .getAttribute("aria-current"),
    ).toBe("page");

    // A loaded extension: name, namespace, titles, and typed widgets.
    expect(view.getByText("wattmind/mobile")).toBeTruthy();
    expect(view.getByText("mobile")).toBeTruthy();
    expect(view.getByText("1 pack")).toBeTruthy();
    expect(view.getByText("2 adapters")).toBeTruthy();
    expect(view.getByText("1 connector")).toBeTruthy();
    expect(view.getByText("1 panel")).toBeTruthy();
    expect(view.queryByText("0 hooks")).toBeNull();
    expect(view.getByText("Simulator")).toBeTruthy();
    expect(view.getByText("iPhone-16")).toBeTruthy();
    expect(view.getByText("FACTORY_EXT_MOBILE_API_TOKEN")).toBeTruthy();
    expect(view.queryByText("[redacted]")).toBeNull();
    expect(view.getByText("simulator name")).toBeTruthy();
    expect(view.getByText("30 seconds")).toBeTruthy();
    expect(view.getAllByText("restart").length).toBeGreaterThan(0);

    // A disabled one: its anomaly replaces the form.
    const disabled = view.getByText(/disabled/);
    expect(disabled.textContent).toContain("$.maxParallel: above maximum 4");
    expect(view.queryByText("wattmind/broken")).toBeTruthy();
    // Nothing is editable: search is the only enabled control.
    const enabled = [
      ...view.container.querySelectorAll("input, select, textarea"),
    ].filter((el) => !(el as HTMLInputElement).disabled);
    expect(enabled.length).toBe(1);
  });

  test("searches extension values like any other section", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="repos" />);
    await view.findByText("factory.tools.base");
    act(() =>
      changeInput(
        view.getByRole("combobox", { name: "Search settings" }),
        "iphone",
      ),
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Extensions" })).toBeTruthy(),
    );
    expect(view.getByText("iPhone-16")).toBeTruthy();
    expect(view.queryByText("wattmind/broken")).toBeNull();
  });

  test("searches extension property titles and descriptions", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="repos" />);
    await view.findByText("factory.tools.base");
    act(() =>
      changeInput(
        view.getByRole("combobox", { name: "Search settings" }),
        "operator credential",
      ),
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Extensions" })).toBeTruthy(),
    );
    expect(view.getByText("wattmind/mobile")).toBeTruthy();
    expect(view.queryByText("wattmind/broken")).toBeNull();
  });

  test("searches extension contribution chips", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="repos" />);
    await view.findByText("factory.tools.base");
    act(() =>
      changeInput(
        view.getByRole("combobox", { name: "Search settings" }),
        "2 adapters",
      ),
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Extensions" })).toBeTruthy(),
    );
    expect(view.getByText("wattmind/mobile")).toBeTruthy();
    expect(view.getByText("2 adapters")).toBeTruthy();
    expect(view.queryByText("wattmind/broken")).toBeNull();
  });

  test("Policy Models edits and resets independent cells with restart feedback", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "PUT") {
        if (init?.body && JSON.parse(String(init.body)).model === "bad") {
          return new Response(JSON.stringify({ error: "model is refused" }), {
            status: 422,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            adapter: "pi",
            tier: "standard",
            trackedModel: "provider/needle-model",
            runtimeModel: "operator/model",
            effectiveModel: "operator/model",
            source: "runtime",
            restartRequired: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE") {
        return new Response(
          JSON.stringify({
            adapter: "pi",
            tier: "light",
            trackedModel: "provider/light",
            runtimeModel: null,
            effectiveModel: "provider/light",
            source: "tracked",
            restartRequired: true,
            deleted: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const view = renderWithClient(<StatefulSettings initial="policy-models" />);
    expect(
      await view.findByText(/take effect only after restarting serve/i),
    ).toBeTruthy();
    expect(
      view.getAllByText("tracked", { selector: "div" }).length,
    ).toBeGreaterThan(0);
    expect(
      view.getAllByText("runtime", { selector: "div" }).length,
    ).toBeGreaterThan(0);

    const standard = view.getByRole("textbox", {
      name: "pi standard model",
    });
    act(() => changeInput(standard, "operator/model"));
    fireEvent.click(
      view.getByRole("button", { name: "Save pi standard model" }),
    );
    await view.findByText(/pi standard saved.*restart serve/i);
    expect(
      calls.some(
        (call) =>
          call.method === "PUT" &&
          call.path.endsWith("/overrides/config/models/pi/standard") &&
          JSON.stringify(call.body) ===
            JSON.stringify({ model: "operator/model" }),
      ),
    ).toBe(true);

    act(() => changeInput(standard, "bad"));
    fireEvent.click(
      view.getByRole("button", { name: "Save pi standard model" }),
    );
    expect((await view.findByRole("alert")).textContent).toContain(
      "model is refused",
    );

    const light = view.getByRole("textbox", { name: "pi light model" });
    act(() => changeInput(light, "unsaved/model"));
    fireEvent.click(view.getByRole("button", { name: "Reset pi light model" }));
    await view.findByText(/pi light reset to tracked policy.*restart serve/i);
    expect((light as HTMLInputElement).value).toBe("runtime/light");
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path.endsWith("/overrides/config/models/pi/light"),
      ),
    ).toBe(true);
  });

  test("Policy Models keeps pending feedback independent across cells", async () => {
    const resolvers = new Map<string, (response: Response) => void>();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if ((init?.method ?? "GET") !== "PUT") {
        return new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Promise<Response>((resolve) => resolvers.set(path, resolve));
    }) as typeof fetch;

    const view = renderWithClient(<StatefulSettings initial="policy-models" />);
    const standard = await view.findByRole("textbox", {
      name: "pi standard model",
    });
    const light = view.getByRole("textbox", { name: "pi light model" });
    act(() => {
      changeInput(standard, "operator/standard");
      changeInput(light, "operator/light");
    });

    fireEvent.click(
      view.getByRole("button", { name: "Save pi standard model" }),
    );
    await waitFor(() =>
      expect((standard as HTMLInputElement).disabled).toBe(true),
    );
    expect((light as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Save pi light model" }));
    await waitFor(() =>
      expect((light as HTMLInputElement).disabled).toBe(true),
    );
    expect((standard as HTMLInputElement).disabled).toBe(true);

    const lightPath = [...resolvers.keys()].find((path) =>
      path.endsWith("/overrides/config/models/pi/light"),
    );
    expect(lightPath).toBeTruthy();
    act(() =>
      resolvers.get(lightPath!)?.(
        new Response(JSON.stringify({ restartRequired: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await waitFor(() =>
      expect((light as HTMLInputElement).disabled).toBe(false),
    );
    expect((standard as HTMLInputElement).disabled).toBe(true);

    const standardPath = [...resolvers.keys()].find((path) =>
      path.endsWith("/overrides/config/models/pi/standard"),
    );
    expect(standardPath).toBeTruthy();
    act(() =>
      resolvers.get(standardPath!)?.(
        new Response(JSON.stringify({ restartRequired: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await waitFor(() =>
      expect((standard as HTMLInputElement).disabled).toBe(false),
    );
  });
});
