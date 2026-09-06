import { trackTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-panels-test-mjs";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { PANEL_ENDPOINTS, panelsView } from "./api-panels.mjs";
import {
  CONTROL_TOKEN,
  apiClient,
  loadRegistry,
  makeServer as makeApiServer,
} from "./api-test-helpers.mjs";

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

describe("GET /panels (WM-840)", () => {
  test("lists the accepted panels with their origin and file, plus the endpoint allow-list", async () => {
    const { server } = await makeServer();
    try {
      const client = apiClient({
        port: server.address().port,
        token: CONTROL_TOKEN,
      });
      const body = await client.panels();
      expect(body.endpoints).toEqual([...PANEL_ENDPOINTS]);
      expect(body.panels).toHaveLength(1);
      const [panel] = body.panels;
      expect(panel).toEqual({
        name: "inbox-open",
        title: "Open inbox items",
        description: expect.stringContaining("Built-in proof panel"),
        source: {
          endpoint: "/inbox",
          query: { status: "open" },
          path: "/items",
        },
        refreshSeconds: 30,
        view: {
          sections: [expect.objectContaining({ as: "table", path: "" })],
        },
        origin: "builtin",
        file: "panels/inbox-open.panel.json",
      });
      // The panel's own source resolves through the same API, with its query.
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/inbox?status=open`,
      );
      expect(res.status).toBe(200);
      expect(Array.isArray((await res.json()).items)).toBe(true);
    } finally {
      server.close();
    }
  });

  test("origins are carried through from packs and extensions; invalid panels are absent (they are /status anomalies)", async () => {
    const registry = loadRegistry();
    registry.panels = [
      ...registry.panels,
      {
        name: "wattmind/mobile:blocked",
        title: "Blocked",
        source: { endpoint: "/tickets", query: {}, path: "/tickets" },
        refreshSeconds: 60,
        view: { sections: [{ path: "", as: "list" }] },
        origin: "extension:wattmind/mobile",
        file: "panels/blocked.panel.json",
      },
    ];
    registry.anomalies = ["panel x is invalid (skipped): boom"];
    const { server } = await makeServer({ registry });
    try {
      const port = server.address().port;
      const client = apiClient({ port, token: CONTROL_TOKEN });
      const body = await client.panels();
      expect(body.panels.map((p) => [p.name, p.origin])).toEqual([
        ["inbox-open", "builtin"],
        ["wattmind/mobile:blocked", "extension:wattmind/mobile"],
      ]);
      expect(body.panels[1].description).toBeNull();
      const status = await client.status();
      expect(status.anomalies.configuration).toContain(
        "panel x is invalid (skipped): boom",
      );
      // Only GET; nothing under /panels/.
      const post = await fetch(`http://127.0.0.1:${port}/panels`, {
        method: "POST",
        body: "{}",
      });
      expect(post.status).toBe(404);
      const sub = await fetch(`http://127.0.0.1:${port}/panels/inbox-open`);
      expect(sub.status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("every allow-listed endpoint is a real GET route of the loopback API (never 404)", async () => {
    const { server } = await makeServer();
    try {
      const port = server.address().port;
      for (const endpoint of PANEL_ENDPOINTS) {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`);
        expect([endpoint, res.status === 404]).toEqual([endpoint, false]);
        expect([endpoint, res.status < 500]).toEqual([endpoint, true]);
      }
      // And the list is what a panel is validated against — no drift between
      // what the API answers and what a panel may bind to.
      expect(panelsView({ panels: [] }).endpoints).toEqual([
        ...PANEL_ENDPOINTS,
      ]);
      expect(PANEL_ENDPOINTS).not.toContain("/panels");
    } finally {
      server.close();
    }
  });
});
