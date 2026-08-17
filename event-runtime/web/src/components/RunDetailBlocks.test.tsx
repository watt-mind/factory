import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { api } from "../api";
import { ARTIFACT_RAW_KEY } from "./ArtifactView";
import { RunDetailBlocks, eventTicket, isCancellable, modelTierText, pinnedModelText } from "./RunDetailBlocks";
import { TicketDecisions, buildTicketDecisions, decisionHeadline } from "./TicketDecisions";
import {
  createAgentsFixture,
  createEventFixture,
  createLifecycleEventFixture,
  createProposalFixture,
  createRunDetailFixture,
  createRunListItemFixture,
  createRunSpecFixture,
  renderWithClient,
  restoreApi,
  stubApi,
} from "../test-render";
import type { RunDetail, RunState } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
});

const noop = () => {};

function renderBlocks(d: RunDetail, overrides?: Partial<Parameters<typeof RunDetailBlocks>[0]>) {
  return renderWithClient(
    <RunDetailBlocks
      d={d}
      now={Date.now()}
      connected={true}
      origin={null}
      onJumpAgent={noop}
      onJumpEvent={noop}
      onCancel={noop}
      onRetry={noop}
      onForceRetry={noop}
      retryPending={false}
      verbError={null}
      {...overrides}
    />,
  );
}

function detailWith(state: RunState, input: unknown): RunDetail {
  return createRunDetailFixture({
    run: { state, spec: { input } } as RunDetail["run"],
  });
}

describe("RunDetailBlocks field tiering (WM-129)", () => {
  test("promotes flat spec.input keys to first-class glance rows", () => {
    const r = renderBlocks(detailWith("RUNNING", { repo: "factory", ticket: "WM-64" }));
    expect(r.getByText("input.repo")).toBeTruthy();
    expect(r.getByText("factory")).toBeTruthy();
    expect(r.getByText("input.ticket")).toBeTruthy();
    expect(r.getByText("WM-64")).toBeTruthy();
  });

  test("renders a single input row for non-object inputs and none for empty ones", () => {
    const scalar = renderBlocks(detailWith("RUNNING", "raw-string-input"));
    expect(scalar.getByText("input")).toBeTruthy();
    expect(scalar.getByText("raw-string-input")).toBeTruthy();
    cleanup();
    const empty = renderBlocks(detailWith("RUNNING", {}));
    expect(empty.queryByText("input")).toBeNull();
  });

  test("demotes ids, hashes, and paths into a collapsed internals disclosure", () => {
    const d = createRunDetailFixture({ workspace: "/tmp/workspaces/run_test_1001" });
    const r = renderBlocks(d);
    const details = Array.from(r.container.querySelectorAll("details"));
    const internals = details.find((el) => el.textContent?.includes("internals"));
    expect(internals).toBeTruthy();
    expect(internals!.open).toBe(false);
    // The demoted rows live inside that disclosure, not on the glance tier.
    // Scoped to the disclosure: labels like `workspace` also appear on the
    // attempt cards, so a document-wide query would match more than one.
    for (const key of ["idempotencyKey", "specHash", "inputHash", "workspace", "promptVersion", "policyVersion"]) {
      const labels = Array.from(internals!.querySelectorAll("span")).filter((s) => s.textContent === key);
      expect(labels.length).toBe(1);
    }
    // The RunSpec ground truth stays, collapsed.
    const spec = details.find((el) => el.textContent?.includes("immutable RunSpec"));
    expect(spec).toBeTruthy();
    expect(spec!.open).toBe(false);
  });

  test("shows the Deadlines clocks for an in-flight run and hides them for a terminal one", () => {
    const running = renderBlocks(createRunDetailFixture({ run: { state: "RUNNING" } as RunDetail["run"] }));
    expect(running.getByText("Deadlines")).toBeTruthy();
    expect(running.getByText("lease owner")).toBeTruthy();
    cleanup();
    const done = renderBlocks(
      createRunDetailFixture({
        run: { state: "COMPLETED" } as RunDetail["run"],
        attempts: [],
      }),
    );
    expect(done.queryByText("Deadlines")).toBeNull();
  });

  test("shows active attempt and lease clocks while a run is VERIFYING (WM-249)", () => {
    const verifying = renderBlocks(
      createRunDetailFixture({ run: { state: "VERIFYING" } as RunDetail["run"] }),
    );

    expect(verifying.getByText("Deadlines")).toBeTruthy();
    expect(verifying.getByTitle(/^timeout in /)).toBeTruthy();
    expect(verifying.getByTitle(/^reaped in /)).toBeTruthy();
  });

  test("attempt cards carry started/finished timestamps", () => {
    const r = renderBlocks(createRunDetailFixture({}));
    // Once in the Deadlines clock, once on the attempt card — the card row is the one this test owns.
    expect(r.getAllByText(/started/).length).toBeGreaterThanOrEqual(2);
  });

  test("isCancellable correctly identifies cancellable states (WM-129)", () => {
    expect(isCancellable("QUEUED")).toBe(true);
    expect(isCancellable("LEASED")).toBe(true);
    expect(isCancellable("RUNNING")).toBe(true);
    // VERIFYING has already exited its agent — not cancellable, same rule as the panel.
    expect(isCancellable("VERIFYING")).toBe(false);
    expect(isCancellable("COMPLETED")).toBe(false);
    expect(isCancellable("FAILED")).toBe(false);
    expect(isCancellable("TIMED_OUT")).toBe(false);
    expect(isCancellable("CANCELLED")).toBe(false);
    expect(isCancellable("REFUSED")).toBe(false);
  });
});

describe("Lifecycle timeline (WM-136)", () => {
  test("renders exactly one dot per transition and aligns actors at a constant column", () => {
    const now = new Date().toISOString();
    const lifecycle = [
      createLifecycleEventFixture(1, "run_x", null, "PROPOSED", null, now),
      createLifecycleEventFixture(2, "run_x", "PROPOSED", "APPROVED", null, now),
      createLifecycleEventFixture(3, "run_x", "APPROVED", "RUNNING", null, now),
    ];
    const d = createRunDetailFixture({ run: { state: "RUNNING" } as RunDetail["run"], lifecycle });
    const r = renderBlocks(d);

    // The rail contributes one dot per row; StateBadge's own dot is
    // suppressed there so a transition never shows two.
    const rows = r.container.querySelectorAll("li");
    expect(rows.length).toBe(3);
    for (const row of Array.from(rows)) {
      expect(row.querySelectorAll(".rounded-full").length).toBe(1);
    }

    // Every badge column is the same fixed width, so the actor after it
    // starts at one x regardless of how long the state name is.
    const badgeColumns = Array.from(r.container.querySelectorAll("li .w-\\[100px\\]"));
    expect(badgeColumns.length).toBe(3);
  });

  test("shows the from-state only where the chain actually breaks", () => {
    const now = new Date().toISOString();
    const lifecycle = [
      createLifecycleEventFixture(1, "run_x", null, "QUEUED", null, now),
      createLifecycleEventFixture(2, "run_x", "QUEUED", "RUNNING", null, now),
      // A gap: this event's `from` disagrees with the previous row's `to`.
      createLifecycleEventFixture(3, "run_x", "LEASED", "TIMED_OUT", null, now),
    ];
    const d = createRunDetailFixture({ run: { state: "TIMED_OUT" } as RunDetail["run"], lifecycle });
    const r = renderBlocks(d);
    expect(r.queryByText("QUEUED→")).toBeNull();
    expect(r.getByText("LEASED→")).toBeTruthy();
  });
});

describe("Lifecycle reason readability (WM-145)", () => {
  const LONG_REASON =
    "planner refused: the worker exceeded the attempt budget after waiting on a hung adapter handshake that never completed";

  test("exposes a long lifecycle reason via title, not actor-only, and does not truncate it", () => {
    const now = new Date().toISOString();
    const lifecycle = [
      createLifecycleEventFixture(1, "run_x", null, "QUEUED", null, now),
      createLifecycleEventFixture(2, "run_x", "QUEUED", "FAILED", LONG_REASON, now),
    ];
    const d = createRunDetailFixture({ run: { state: "FAILED" } as RunDetail["run"], lifecycle });
    const r = renderBlocks(d);

    const failedRow = Array.from(r.container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes(LONG_REASON),
    );
    expect(failedRow).toBeTruthy();

    const expectedTitle = `worker_test · ${LONG_REASON}`;
    const titled = Array.from(failedRow!.querySelectorAll("[title]")).filter(
      (el) => el.getAttribute("title") === expectedTitle,
    );
    // Both the reason wrapper and the nested ActorRef jump link expose the
    // composite title, so hovering the actor cannot mask the reason.
    expect(titled.length).toBe(2);
    expect(failedRow!.querySelector("button")?.getAttribute("title")).toBe(expectedTitle);

    const truncated = Array.from(failedRow!.querySelectorAll(".truncate")).filter((el) =>
      el.textContent?.includes(LONG_REASON),
    );
    expect(truncated.length).toBe(0);
  });
});

describe("model surfacing (WM-221)", () => {
  const modelDetail = (spec: Partial<RunDetail["run"]["spec"]>, observedModel: string | null = null) =>
    createRunDetailFixture({
      run: { spec: { adapter: "claude", ...spec } } as RunDetail["run"],
      observedModel,
    });

  test("shows tier, pinned model, and observed model beside the adapter", () => {
    const r = renderBlocks(
      modelDetail({ modelTier: "standard", model: "sonnet" }, "claude-sonnet-5"),
    );
    expect(r.getByText("model tier")).toBeTruthy();
    expect(r.getByText("standard")).toBeTruthy();
    expect(r.getByText("model (pinned)")).toBeTruthy();
    expect(r.getByText("sonnet")).toBeTruthy();
    expect(r.getByText("model (observed)")).toBeTruthy();
    expect(r.getByText("claude-sonnet-5")).toBeTruthy();
  });

  test("renders the `default` sentinel distinctly, never as a missing value", () => {
    const r = renderBlocks(modelDetail({ modelTier: "strong", model: "default" }, "claude-fable-5"));
    const pinned = r.getByText("default (CLI)");
    expect(pinned).toBeTruthy();
    expect(pinned.getAttribute("title")).toContain("sentinel");
    // The sentinel is exactly the case the observed row exists to answer.
    expect(r.getByText("claude-fable-5")).toBeTruthy();
  });

  test("a spec that declares nothing still reads as the CLI's default, not a blank", () => {
    const r = renderBlocks(modelDetail({}));
    expect(r.getByText("not declared")).toBeTruthy();
    expect(r.getByText("default (CLI)")).toBeTruthy();
    expect(r.getByText("not recorded")).toBeTruthy();
  });

  test("an exact-id override with no tier reads as `override`", () => {
    const r = renderBlocks(modelDetail({ model: "claude-opus-4-1" }));
    expect(r.getByText("override")).toBeTruthy();
    expect(r.getByText("claude-opus-4-1")).toBeTruthy();
  });

  test("a non-model adapter gets one explicit n/a row, never three blanks", () => {
    const r = renderBlocks(
      createRunDetailFixture({ run: { spec: { adapter: "command" } } as RunDetail["run"] }),
    );
    const na = r.getByText("n/a");
    expect(na).toBeTruthy();
    expect(na.getAttribute("title")).toContain("fixed argv");
    expect(r.queryByText("model (pinned)")).toBeNull();
    expect(r.queryByText("model (observed)")).toBeNull();
  });

  test("a tier declared on a non-model adapter is named in the tooltip, not dropped", () => {
    const r = renderBlocks(
      createRunDetailFixture({
        run: { spec: { adapter: "command", modelTier: "light", model: null } } as RunDetail["run"],
      }),
    );
    expect(r.getByText("n/a").getAttribute("title")).toContain("light");
  });
});

describe("pinnedModelText / modelTierText (WM-221)", () => {
  test("splits the two meanings of a null model the way the Agents view does", () => {
    expect(pinnedModelText("claude", "sonnet")).toBe("sonnet");
    expect(pinnedModelText("claude", "default")).toBe("default (CLI)");
    expect(pinnedModelText("pi", null)).toBe("default (CLI)");
    expect(pinnedModelText("pi", undefined)).toBe("default (CLI)");
    // No model by construction — a different fact from "pinned nothing".
    expect(pinnedModelText("command", null)).toBe("n/a");
    expect(pinnedModelText("actions", "sonnet")).toBe("n/a");
  });

  test("tier text prefers the declaration, then the override, then honest absence", () => {
    expect(modelTierText({ adapter: "claude", modelTier: "strong", model: "default" })).toBe("strong");
    expect(modelTierText({ adapter: "claude", modelTier: null, model: "claude-opus-4-1" })).toBe("override");
    expect(modelTierText({ adapter: "claude", modelTier: null, model: null })).toBe("not declared");
    expect(modelTierText({ adapter: "fake", modelTier: null, model: null })).toBe("n/a");
    // A declared tier survives even where the adapter cannot use it.
    expect(modelTierText({ adapter: "command", modelTier: "light", model: null })).toBe("light");
  });
});

describe("artifact position renders the agent's view (WM-455)", () => {
  const TRIAGE_VIEW = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../../agents/triage-scan.view.json"), "utf8"));
  const triageAgent = {
    ref: "triage-scan@1",
    id: "triage-scan",
    outputSchema: { title: "triage plan" },
    outputView: TRIAGE_VIEW,
  };
  const artifact = {
    recommendation: "TRIAGE",
    repo: "factory",
    summary: "One issue is ready.",
    plan: [{ issueId: "WM-7", action: "label-agent-ready", reason: "Complete." }],
  };
  const withArtifact = () =>
    createRunDetailFixture({
      run: { state: "COMPLETED", spec: { agent: "triage-scan@1" } } as RunDetail["run"],
      result: { terminalState: "COMPLETED", reasonCode: null, artifact },
    });

  afterEach(() => localStorage.removeItem(ARTIFACT_RAW_KEY));

  test("with a view from /agents: summary, status, plan table with an issue chip, and a Raw toggle back to JSON", async () => {
    stubApi({ agents: mock(async () => createAgentsFixture({ agents: [triageAgent] as never })) });
    const r2 = renderBlocks(withArtifact());
    expect(await r2.findByText("One issue is ready.")).toBeTruthy();
    expect(r2.getByText("TRIAGE")).toBeTruthy();
    expect((r2.getByRole("link", { name: "WM-7" }) as HTMLAnchorElement).getAttribute("href")).toBe(
      "https://linear.app/watt-mind/issue/WM-7",
    );
    fireEvent.click(r2.getByRole("button", { name: "Raw" }));
    expect(r2.queryByRole("table")).toBeNull();
    const pre = Array.from(r2.container.querySelectorAll("pre")).find((el) => el.textContent?.includes('"issueId": "WM-7"'));
    expect(pre).toBeTruthy();
    expect(localStorage.getItem(ARTIFACT_RAW_KEY)).toBe("1");
  });

  test("no view for the agent → the JSON block, unchanged, and no toggle", async () => {
    stubApi({ agents: mock(async () => createAgentsFixture({ agents: [{ ...triageAgent, outputView: null }] as never })) });
    const r = renderBlocks(withArtifact());
    await waitFor(() => expect(api.agents).toHaveBeenCalled());
    expect(r.queryByRole("group", { name: "Artifact rendering" })).toBeNull();
    expect(r.queryByRole("table")).toBeNull();
    const pre = Array.from(r.container.querySelectorAll("pre")).find((el) => el.textContent?.includes('"issueId": "WM-7"'));
    expect(pre).toBeTruthy();
  });
});

describe("Ticket decisions (WM-594)", () => {
  const T = "WM-542";
  const t = (offsetSeconds: number) => new Date(Date.UTC(2026, 7, 17, 12, 0, offsetSeconds)).toISOString();
  const dispatchEvent = (eventId: string, status: string, at: string, subject: string | null = T) =>
    createEventFixture({
      source: "linear",
      eventId,
      type: "dispatch.requested",
      subject,
      status,
      admittedAt: at,
      envelope: { schemaVersion: "factory.event/v1", eventId, type: "dispatch.requested", source: "linear", payload: { ticket: T } },
    });
  const fixture = () => {
    const events = [
      dispatchEvent("evt_plan", "planned", t(0)),
      dispatchEvent("evt_noop", "noop", t(60)),
      dispatchEvent("evt_other", "noop", t(70), "WM-999"),
      dispatchEvent("evt_refused", "planned", t(120)),
      // Names the ticket only in the payload — subject is a repo.
      { ...dispatchEvent("evt_payload_only", "admitted", t(200), "factory/repo") },
    ];
    const proposals = [
      createProposalFixture({ id: "prop_plan", decision: "run", status: "approved", created_at: t(1), eventId: "evt_plan", eventSource: "linear", runId: "run_ok" }),
      createProposalFixture({ id: "prop_noop", decision: "noop", status: "resolved", reason: "owned_paths_overlap", created_at: t(61), eventId: "evt_noop", eventSource: "linear", runId: null }),
      createProposalFixture({ id: "prop_other", decision: "noop", status: "resolved", reason: "ticket_assigned", created_at: t(71), eventId: "evt_other", eventSource: "linear", runId: null }),
      createProposalFixture({ id: "prop_refused", decision: "run", status: "approved", created_at: t(121), eventId: "evt_refused", eventSource: "linear", runId: "run_refused" }),
      // Attached to no listed event; its spec input names the ticket.
      createProposalFixture({ id: "prop_spec", decision: "noop", status: "resolved", reason: "ticket_security", created_at: t(150), eventId: "evt_missing", eventSource: "chain", runId: null, spec: { ...createRunSpecFixture("run_x"), input: { ticket: T } } }),
    ];
    const runs = [
      createRunListItemFixture({ runId: "run_ok", state: "COMPLETED", reasonCode: "ok", eventId: "evt_plan", eventSource: "linear", updated_at: t(30) }),
      createRunListItemFixture({ runId: "run_refused", state: "REFUSED", reasonCode: "needs_human", eventId: "evt_refused", eventSource: "linear", updated_at: t(130) }),
    ];
    return { events, proposals, runs };
  };

  test("eventTicket reads the subject, then payload.ticket", () => {
    expect(eventTicket(dispatchEvent("e", "noop", t(0)))).toBe(T);
    expect(eventTicket(dispatchEvent("e", "noop", t(0), "factory/repo"))).toBe(T);
    expect(eventTicket(createEventFixture({ subject: "factory/repo" }))).toBeNull();
  });

  test("joins events, proposals and refused runs for one ticket, oldest first", () => {
    const decisions = buildTicketDecisions(T, fixture());
    // The planner said yes to evt_refused (planned), then the gate said no (refused): both are decisions.
    expect(decisions.map((d) => [d.outcome, d.reason])).toEqual([
      ["planned", null],
      ["noop", "owned_paths_overlap"],
      ["planned", null],
      ["refused", "needs_human"],
      ["noop", "ticket_security"],
      ["admitted", null],
    ]);
    // Excludes WM-999, carries the joins for jump links.
    expect(decisions.some((d) => d.reason === "ticket_assigned")).toBe(false);
    expect(decisions[1]).toMatchObject({ proposalId: "prop_noop", event: { eventId: "evt_noop" } });
    expect(decisions[3]).toMatchObject({ runId: "run_refused", event: { eventId: "evt_refused" } });
    expect(decisions[5]).toMatchObject({ event: { eventId: "evt_payload_only" }, proposalId: null });
  });

  test("the headline is the latest decision, humanized", () => {
    const decisions = buildTicketDecisions(T, fixture());
    const now = Date.parse(t(260));
    expect(decisionHeadline(decisions[1], now)).toBe("noop · Owned paths overlap · 3m ago");
    expect(decisionHeadline(decisions[3], now)).toBe("refused · Needs human · 2m ago");
  });

  test("renders collapsed with the latest decision, expands to the full list with reason links", async () => {
    const f = fixture();
    stubApi({
      events: mock(async () => ({ events: f.events })),
      proposalHistory: mock(async () => ({ proposals: f.proposals })),
      runs: mock(async () => ({ runs: f.runs })),
    });
    const onJumpRun = mock(() => {});
    const r = renderWithClient(<TicketDecisions ticket={T} now={Date.parse(t(260))} onJumpRun={onJumpRun} />);
    const toggle = await r.findByRole("button", { name: /Show all 6 planner decisions for WM-542/ });
    expect(r.getByText("6 decisions")).toBeTruthy();
    // Collapsed: only the headline (latest = the admitted event awaiting the planner).
    expect(r.getByText("awaiting the planner")).toBeTruthy();
    expect(r.queryByRole("list", { name: "Planner decisions for WM-542" })).toBeNull();
    fireEvent.click(toggle);
    const list = r.getByRole("list", { name: "Planner decisions for WM-542" });
    expect(list.querySelectorAll("li").length).toBe(6);
    expect(r.getByText("Owned paths overlap")).toBeTruthy();
    expect(r.getByText("Needs human")).toBeTruthy();
    // The run reference on the refused decision jumps to the run.
    fireEvent.click(r.getAllByTitle("run_refused")[0]);
    expect(onJumpRun).toHaveBeenCalledWith("run_refused");
  });

  test("RunDetailBlocks renders the Decisions block for a run whose input names a ticket", async () => {
    const f = fixture();
    stubApi({
      events: mock(async () => ({ events: f.events })),
      proposalHistory: mock(async () => ({ proposals: f.proposals })),
      runs: mock(async () => ({ runs: f.runs })),
    });
    const r = renderBlocks(detailWith("REFUSED", { repo: "factory", ticket: T }));
    // TicketDecisions is a lazy chunk (bundle budget) — await the Suspense boundary.
    expect(await r.findByText("Decisions")).toBeTruthy();
    await r.findByText("6 decisions");
    cleanup();
    const r2 = renderBlocks(detailWith("RUNNING", { repo: "factory" }));
    expect(r2.queryByText("Decisions")).toBeNull();
  });
});
