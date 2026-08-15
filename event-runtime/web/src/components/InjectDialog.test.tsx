import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InjectDialog } from "./InjectDialog";
import { api } from "../api";
import type { AgentsView } from "../types";
import { changeInput } from "../test-render";

afterEach(() => {
  cleanup();
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// ---------------------------------------------------------------------------
// WM-76: schema-driven Form view. Real input schemas from event-runtime/schemas
// so the renderer is exercised against what the registry actually serves.

const boilerplateAgent = {
  version: 1,
  outputContract: "c/v1",
  workspace: { type: "ephemeral" as const },
  capabilities: {},
  limits: {},
  mutating: false,
  promptFile: "",
  prompt: "",
  inputSchemaFile: "",
  outputSchemaFile: "",
  outputSchema: {},
  pins: {},
  command: null,
  actionRegistry: null,
  hosts: null,
  eventTypes: [],
};

const TRIAGE_SCAN_SCHEMA = {
  title: "triage-scan input",
  type: "object",
  required: ["repo"],
  additionalProperties: false,
  properties: {
    repo: { type: "string", minLength: 1 },
    ref: { type: "string" },
    repoPin: {
      type: "object",
      required: ["repo", "sha"],
      additionalProperties: false,
      properties: {
        repo: { type: "string", minLength: 1 },
        ref: { type: "string" },
        sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        github: { type: ["string", "null"] },
      },
    },
  },
};

const DISK_DIAGNOSE_SCHEMA = {
  title: "disk-diagnose input",
  type: "object",
  required: ["host", "mount", "usedPct", "alertId"],
  additionalProperties: false,
  properties: {
    host: { enum: ["lab", "web"] },
    mount: { type: "string", pattern: "^/[A-Za-z0-9/._-]*$" },
    usedPct: { type: "number", minimum: 0, maximum: 100 },
    alertId: { type: "string", minLength: 1 },
  },
};

const CI_DOCTOR_SCHEMA = {
  title: "ci-doctor input",
  type: "object",
  required: ["repo", "runId", "logArtifact"],
  additionalProperties: false,
  properties: {
    repo: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$" },
    runId: { type: ["string", "integer"] },
    headSha: { type: "string" },
    workflowName: { type: "string" },
    logArtifact: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
};

const STATUS_REPORT_SCHEMA = {
  title: "factory.status-report/v1 input",
  type: "object",
  required: ["repos"],
  additionalProperties: false,
  properties: {
    repos: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
  },
};

// Synthetic: exercises Now button + boolean + array-of-objects sub-editor.
const DEMO_SCHEMA = {
  type: "object",
  required: ["scheduledAt"],
  additionalProperties: false,
  properties: {
    scheduledAt: { type: "string" },
    dryRun: { type: "boolean" },
    plan: {
      type: "array",
      items: { type: "object", required: ["action"], properties: { action: { type: "string" } } },
    },
  },
};

function schemaRegistry(): AgentsView {
  const mk = (id: string, inputSchema: unknown) => ({
    ...boilerplateAgent,
    ref: `${id}@1`,
    id,
    inputSchema,
  });
  return {
    agents: [
      mk("triage", TRIAGE_SCAN_SCHEMA),
      mk("disk", DISK_DIAGNOSE_SCHEMA),
      mk("cidoctor", CI_DOCTOR_SCHEMA),
      mk("report", STATUS_REPORT_SCHEMA),
      mk("demo", DEMO_SCHEMA),
    ],
    eventTypes: [
      { type: "triage.scan.requested", agent: "triage@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
      { type: "disk.diagnose", agent: "disk@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
      { type: "ci.run.failed", agent: "cidoctor@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
      { type: "factory.status.requested", agent: "report@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
      { type: "demo.requested", agent: "demo@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
    ],
    edges: {},
    contracts: {},
    schemaHash: "hash123",
    publishedAt: new Date().toISOString(),
  } as unknown as AgentsView;
}

const REPO_ITEMS = [
  { name: "bj29", path: "/r/bj29", github: "watt-mind/bj29", team: null, project: null, base: "develop", deployBranch: null, reportOnly: false, maxInFlight: null, worktreeRoot: null, hasWorktreeUp: false, hasWorktreeDown: false, hasWorktreeWarm: false, verify: null },
  { name: "factory", path: "/r/factory", github: null, team: null, project: null, base: "develop", reportOnly: false, deployBranch: null, maxInFlight: null, worktreeRoot: null, hasWorktreeUp: false, hasWorktreeDown: false, hasWorktreeWarm: false, verify: null },
];

function withSchemaApi(fn: (r: ReturnType<typeof renderWithClient>) => Promise<void>) {
  const origAgents = api.agents;
  const origRepos = api.repos;
  api.agents = async () => schemaRegistry();
  api.repos = async () => ({ repos: REPO_ITEMS });
  return (async () => {
    try {
      const r = renderWithClient(<InjectDialog onClose={() => {}} />);
      await fn(r);
    } finally {
      api.agents = origAgents;
      api.repos = origRepos;
    }
  })();
}

async function selectTemplate(r: ReturnType<typeof renderWithClient>, name: RegExp) {
  const chip = await r.findByRole("radio", { name });
  act(() => {
    fireEvent.click(chip);
  });
  return chip;
}

describe("InjectDialog schema-driven Form view (WM-76)", () => {
  test("renders form fields from the selected template's input schema", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /disk\.diagnose/i);
      // Form tab exists and is active for a schema'd template.
      const formTab = r.getByRole("tab", { name: /form/i });
      expect(formTab.getAttribute("aria-selected")).toBe("true");
      // enum -> select, number -> numeric input, strings -> text inputs.
      const host = r.getByLabelText("host") as HTMLSelectElement;
      expect(host.tagName.toLowerCase()).toBe("select");
      expect([...host.querySelectorAll("option")].map((o) => o.value)).toContain("web");
      const usedPct = r.getByLabelText("usedPct") as HTMLInputElement;
      expect(usedPct.getAttribute("type")).toBe("number");
      expect(r.getByLabelText("mount")).toBeTruthy();
      expect(r.getByLabelText("alertId")).toBeTruthy();
      // Envelope preview disclosure is present in Form mode.
      expect(r.getByText(/envelope preview/i)).toBeTruthy();
    }));

  test("hides planner-injected repoPin and collapses optional fields", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /triage\.scan\.requested/i);
      expect(r.getByLabelText("repo")).toBeTruthy();
      expect(r.queryByLabelText("repoPin")).toBeNull();
      // Optional `ref` sits behind a disclosure, not in the always-visible set.
      expect(r.getByText(/optional fields/i)).toBeTruthy();
    }));

  test("repo picker offers short names, or github slugs when the pattern wants owner/name", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /triage\.scan\.requested/i);
      const optionsOf = (input: HTMLInputElement) => {
        const listId = input.getAttribute("list");
        expect(listId).toBeTruthy();
        const list = document.getElementById(listId!);
        expect(list).toBeTruthy();
        return [...list!.querySelectorAll("option")].map((o) => o.getAttribute("value"));
      };
      const repo = r.getByLabelText("repo") as HTMLInputElement;
      let options = optionsOf(repo);
      expect(options).toContain("bj29");
      expect(options).toContain("factory");

      await selectTemplate(r, /ci\.run\.failed/i);
      options = optionsOf(r.getByLabelText("repo") as HTMLInputElement);
      expect(options).toContain("watt-mind/bj29");
      // github:null repos are filtered from the slug convention.
      expect(options).not.toContain("factory");
    }));

  test("*Id fields get a Generate button, *At fields get a Now button", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /disk\.diagnose/i);
      const gen = r.getByRole("button", { name: /generate/i });
      act(() => {
        fireEvent.click(gen);
      });
      expect((r.getByLabelText("alertId") as HTMLInputElement).value).toMatch(/^web-/);

      await selectTemplate(r, /demo\.requested/i);
      const now = r.getByRole("button", { name: /^now$/i });
      act(() => {
        fireEvent.click(now);
      });
      expect((r.getByLabelText("scheduledAt") as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }));

  test("validation flags a bad payload with a field-level error", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /disk\.diagnose/i);
      const usedPct = r.getByLabelText("usedPct") as HTMLInputElement;
      act(() => {
        changeInput(usedPct, "150");
      });
      expect(r.getByText(/above maximum 100/i)).toBeTruthy();
    }));

  test("form ↔ JSON tab sync round trip", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /disk\.diagnose/i);
      const mount = r.getByLabelText("mount") as HTMLInputElement;
      act(() => {
        changeInput(mount, "/var");
      });
      // Form -> JSON regenerates the envelope text.
      act(() => {
        fireEvent.click(r.getByRole("tab", { name: /json/i }));
      });
      const textarea = r.getByLabelText(/event envelope json/i) as HTMLTextAreaElement;
      expect(textarea.value).toContain('"/var"');
      // JSON -> Form re-parses on switch.
      const parsed = JSON.parse(textarea.value);
      parsed.payload.mount = "/data";
      act(() => {
        changeInput(textarea, JSON.stringify(parsed, null, 2));
      });
      act(() => {
        fireEvent.click(r.getByRole("tab", { name: /form/i }));
      });
      expect((r.getByLabelText("mount") as HTMLInputElement).value).toBe("/data");
    }));

  test("unregistered type is JSON-only: form tab disabled with a stated reason", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /blank envelope/i);
      const formTab = r.getByRole("tab", { name: /form/i });
      expect(formTab.getAttribute("aria-disabled")).toBe("true");
      const jsonTab = r.getByRole("tab", { name: /json/i });
      expect(jsonTab.getAttribute("aria-selected")).toBe("true");
      // Clicking the disabled tab states why instead of switching.
      act(() => {
        fireEvent.click(formTab);
      });
      expect(jsonTab.getAttribute("aria-selected")).toBe("true");
      expect(r.getByText(/no schema to render/i)).toBeTruthy();
    }));

  test("schema-invalid payload warns, needs explicit ack, then still submits", () =>
    withSchemaApi(async (r) => {
      const origReplay = api.replay;
      const sent: unknown[] = [];
      api.replay = async (envelope: unknown) => {
        sent.push(envelope);
        return { admitted: true, duplicate: false, eventId: "e1" };
      };
      try {
        await selectTemplate(r, /disk\.diagnose/i);
        // Make the payload schema-invalid: usedPct above its maximum of 100.
        act(() => {
          changeInput(r.getByLabelText("usedPct"), "150");
        });
        const injectBtn = r.getByRole("button", { name: /inject/i });
        act(() => {
          fireEvent.click(injectBtn);
        });
        // Not submitted yet: warned and waiting on explicit acknowledgement.
        expect(sent.length).toBe(0);
        expect(r.getByText(/does not validate/i)).toBeTruthy();
        const confirm = r.getByRole("button", { name: /confirm inject/i });
        await act(async () => {
          fireEvent.click(confirm);
        });
        expect(sent.length).toBe(1);
        expect((sent[0] as any).payload.host).toBe("lab");
        expect((sent[0] as any).payload.usedPct).toBe(150);
      } finally {
        api.replay = origReplay;
      }
    }));

  test("example-ish seeds surface as placeholders, never as values or regex source (critique r1)", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /ci\.run\.failed/i);
      const repo = r.getByLabelText("repo") as HTMLInputElement;
      // The owner/name example must not be a pre-filled value that ships as
      // plausible garbage — it belongs in the placeholder, human-readable.
      expect(repo.value).toBe("");
      expect(repo.getAttribute("placeholder")).toBe("watt-mind/factory");
      // Pattern-constrained fields never show the raw regex source.
      const logArtifact = r.getByLabelText("logArtifact") as HTMLInputElement;
      expect(logArtifact.getAttribute("placeholder") ?? "").not.toContain("^");
    }));

  test("string arrays with minItems seed zero chips; the minItems warning covers the ask (critique r1)", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /factory\.status\.requested/i);
      // No bare unlabeled "×" chip from a seeded empty string.
      expect(r.queryAllByRole("button", { name: /^remove/i }).length).toBe(0);
      // The requirement is still surfaced, as a validation warning.
      expect(r.getByText(/fewer than minItems 1/i)).toBeTruthy();
    }));

  test("array-of-objects field renders a JSON sub-editor with parse indicator", () =>
    withSchemaApi(async (r) => {
      await selectTemplate(r, /demo\.requested/i);
      // `plan` is optional: open the optional-fields disclosure first.
      const disclosure = r.getByText(/optional fields/i);
      act(() => {
        fireEvent.click(disclosure);
      });
      const plan = r.getByLabelText("plan") as HTMLTextAreaElement;
      expect(plan.tagName.toLowerCase()).toBe("textarea");
      act(() => {
        changeInput(plan, "[{bad json");
      });
      expect(r.getByText(/invalid json/i)).toBeTruthy();
    }));
});

describe("InjectDialog template selection sync (OPS-344)", () => {
  test("clicking highlighted fallback blank chip does not wipe envelope textarea", async () => {
    // Mock api.agents to return sample templates
    const origAgents = api.agents;
    api.agents = async () =>
      ({
        agents: [
          {
            ref: "worker@1",
            id: "worker",
            version: 1,
            outputContract: "c/v1",
            workspace: { type: "ephemeral" as const },
            capabilities: {},
            limits: {},
            mutating: false,
            promptFile: "",
            prompt: "",
            inputSchemaFile: "",
            inputSchema: {},
            outputSchemaFile: "",
            outputSchema: {},
            pins: {},
            command: null,
            actionRegistry: null,
            hosts: null,
            eventTypes: [],
          },
        ],
        eventTypes: [
          { type: "worker.started", agent: "worker@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
          { type: "worker.stopped", agent: "worker@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
        ],
        edges: {},
        contracts: {},
        schemaHash: "hash123",
        publishedAt: new Date().toISOString(),
      }) as unknown as AgentsView;

    try {
      const r = renderWithClient(<InjectDialog onClose={() => {}} />);
      // Wait for template to appear
      const templateChip = await r.findByRole("radio", { name: /worker\.started/i });
      expect(templateChip).toBeTruthy();

      // Click worker.started template
      act(() => {
        fireEvent.click(templateChip);
      });
      expect(templateChip.getAttribute("aria-checked")).toBe("true");

      const textarea = r.getByLabelText(/event envelope json/i) as HTMLTextAreaElement;
      expect(textarea.value).toContain('"worker.started"');

      // Edit textarea to simulate custom edits
      act(() => {
        changeInput(textarea, '{\n  "custom": "value",\n  "type": "worker.started"\n}');
      });
      expect(textarea.value).toContain('"custom": "value"');

      // Filter templates with search so worker.started vanishes
      const searchInput = r.getByPlaceholderText(/search/i) as HTMLInputElement;
      act(() => {
        changeInput(searchInput, "nonexistent");
      });

      // The blank chip is now checked as the fallback tabbable radio
      const blankChip = r.getByRole("radio", { name: /blank envelope/i });
      expect(blankChip.getAttribute("aria-checked")).toBe("true");
      expect(blankChip.getAttribute("tabindex")).toBe("0");

      // Clicking the already-highlighted blank chip must NOT wipe the custom textarea edits
      act(() => {
        fireEvent.click(blankChip);
      });
      expect(textarea.value).toContain('"custom": "value"');
      expect(textarea.value).toContain('"worker.started"');

      // Clear search so worker.started is visible again
      act(() => {
        changeInput(searchInput, "");
      });
      const workerStoppedChip = r.getByRole("radio", { name: /worker\.stopped/i });

      // Explicitly clicking another template updates text
      act(() => {
        fireEvent.click(workerStoppedChip);
      });
      expect(textarea.value).toContain('"worker.stopped"');

      // Explicitly clicking blank envelope now resets to blank starter
      act(() => {
        fireEvent.click(blankChip);
      });
      expect(textarea.value).toContain('"type": ""');
    } finally {
      api.agents = origAgents;
    }
  });
});
