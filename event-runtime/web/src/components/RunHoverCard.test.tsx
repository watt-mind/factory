import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  RunHoverCard,
  artifactCount,
  runDurationSeconds,
  runOrigin,
} from "./RunHoverCard";
import {
  createRunDetailFixture,
  createRunListItemFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { ArtifactRef, Attempt, RunDetail, RunListItem } from "../types";

function artifactRef(uri: string, fill: string): ArtifactRef {
  return { kind: "report", uri, sha256: fill.repeat(64), sizeBytes: 128 };
}

afterEach(() => {
  cleanup();
  restoreApi();
});

const T0 = "2026-08-18T12:00:00.000Z";
const T1 = "2026-08-18T12:02:30.000Z";
const NOW_MS = Date.parse("2026-08-18T12:05:00.000Z");

function attempt(overrides?: Partial<Attempt>): Attempt {
  return {
    run_id: "run_test_1001",
    attempt: 1,
    lease_owner: "worker_test",
    lease_expires_at: null,
    started_at: T0,
    finished_at: T1,
    terminal_state: "COMPLETED",
    reason_code: null,
    workspace_path: "/tmp/ws",
    ...overrides,
  };
}

function stubRun(overrides?: Partial<RunListItem>): RunListItem {
  return createRunListItemFixture({
    runId: "run_test_1001",
    state: "COMPLETED",
    attempts: 2,
    maxAttempts: 3,
    agent: "merge-scan",
    adapter: "claude-code",
    eventSource: "github",
    eventId: "evt_1001",
    created_at: T0,
    updated_at: T1,
    ...overrides,
  });
}

function stubDetail(overrides?: Partial<RunDetail>): RunDetail {
  return createRunDetailFixture({
    run: {
      runId: "run_test_1001",
      state: "COMPLETED",
      attempts: 2,
    } as RunDetail["run"],
    attempts: [attempt()],
    result: {
      terminalState: "COMPLETED",
      reasonCode: null,
      artifacts: [
        artifactRef("report.md", "a"),
        artifactRef("diff.patch", "b"),
      ],
    },
    ...overrides,
  });
}

/** The wrapper the primitive puts the popup ARIA state on. */
function triggerOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[aria-haspopup='dialog']");
  if (!el) throw new Error("hover card trigger not found");
  return el;
}

describe("runDurationSeconds", () => {
  test("spans the first attempt's start to the last attempt's finish", () => {
    expect(runDurationSeconds(stubRun(), stubDetail(), NOW_MS)).toBe(150);
  });

  test("runs the clock to now while an attempt is still open", () => {
    const detail = stubDetail({
      attempts: [attempt({ finished_at: null, terminal_state: null })],
    });
    expect(runDurationSeconds(stubRun(), detail, NOW_MS)).toBe(300);
  });

  test("falls back to the list row's own timestamps before the detail arrives", () => {
    expect(runDurationSeconds(stubRun(), undefined, NOW_MS)).toBe(150);
  });

  test("ticks an in-flight list fallback to now instead of updated_at", () => {
    const run = stubRun({ state: "RUNNING", startedAt: T0, updated_at: T1 });
    expect(runDurationSeconds(run, undefined, NOW_MS)).toBe(300);
  });

  test("leaves queued and proposed list fallbacks empty", () => {
    expect(
      runDurationSeconds(stubRun({ state: "QUEUED" }), undefined, NOW_MS),
    ).toBeNull();
    expect(
      runDurationSeconds(stubRun({ state: "PROPOSED" }), undefined, NOW_MS),
    ).toBeNull();
  });

  test("is null when nothing dates the run", () => {
    const detail = stubDetail({ attempts: [] });
    const run = stubRun({ created_at: "", updated_at: "" });
    expect(runDurationSeconds(run, detail, NOW_MS)).toBeNull();
  });
});

describe("artifactCount", () => {
  test("counts the stored artifacts a run produced", () => {
    expect(artifactCount(stubDetail())).toBe(2);
  });

  test("counts the single legacy artifact hash as one", () => {
    const detail = stubDetail({
      result: {
        terminalState: "COMPLETED",
        reasonCode: null,
        artifactHash: "c".repeat(64),
      },
    });
    expect(artifactCount(detail)).toBe(1);
  });

  test("is zero for a run with no result yet", () => {
    expect(artifactCount(stubDetail({ result: null }))).toBe(0);
    expect(artifactCount(undefined)).toBe(0);
  });
});

describe("runOrigin", () => {
  test("names the schedule that ticked, not a webhook that did not", () => {
    const origin = runOrigin(
      stubRun({ eventSource: "schedule", eventId: "manual:merge-scan" }),
    );
    expect(origin.kind).toBe("schedule");
  });

  test("names the origin event for an event-triggered run", () => {
    expect(runOrigin(stubRun())).toEqual({
      kind: "event",
      source: "github",
      eventId: "evt_1001",
    });
  });

  test("has no origin when the run names no event", () => {
    expect(runOrigin(stubRun({ eventSource: null, eventId: null })).kind).toBe(
      "none",
    );
  });
});

describe("RunHoverCard", () => {
  test("opens on hover with agent, state, attempts, duration and artifact count", async () => {
    await withApi({ run: async () => stubDetail() }, async () => {
      const r = renderWithClient(
        <RunHoverCard run={stubRun()} chainId="corr_1001">
          <span>run_test_1001</span>
        </RunHoverCard>,
      );

      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      const card = r.getByRole("dialog");
      expect(card.getAttribute("aria-label")).toBe("Run run_test_1001");
      expect(card.textContent).toContain("COMPLETED");
      expect(card.textContent).toContain("merge-scan");
      expect(card.textContent).toContain("2/3");
      await waitFor(() => {
        expect(r.getByRole("dialog").textContent).toContain("2m 30s");
        expect(r.getByRole("dialog").textContent).toContain("2 artifacts");
      });
    });
  });

  test("holds the detail query until the card opens and reuses it on reopen", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return stubDetail();
    };

    await withApi({ run }, async () => {
      const r = renderWithClient(
        <RunHoverCard run={stubRun()}>
          <span>run_test_1001</span>
        </RunHoverCard>,
      );

      // Sweeping the pointer down a runs table must not fetch one detail per row.
      expect(calls).toBe(0);

      const trigger = triggerOf(r.container);
      fireEvent.mouseEnter(trigger);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      await waitFor(() => expect(calls).toBe(1));

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(r.queryByRole("dialog")).toBeNull());

      fireEvent.mouseEnter(trigger);
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(calls).toBe(1);
    });
  });

  test("links the triggering event and routes it through the view's navigation", async () => {
    const onJumpEvent = mock(() => {});
    await withApi({ run: async () => stubDetail() }, async () => {
      const r = renderWithClient(
        <RunHoverCard run={stubRun()} onJumpEvent={onJumpEvent}>
          <span>run_test_1001</span>
        </RunHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));
      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());

      const link = r.getByRole("link", { name: /evt_1001/ });
      expect(link.getAttribute("href")).toBe("#/events/github/evt_1001");
      fireEvent.click(link);
      expect(onJumpEvent).toHaveBeenCalledWith("github", "evt_1001");
    });
  });

  test("says a scheduled run was triggered by its loop, not by a webhook", async () => {
    await withApi({ run: async () => stubDetail() }, async () => {
      const r = renderWithClient(
        <RunHoverCard
          run={stubRun({
            eventSource: "schedule",
            eventId: "clock.tick.merge-scan",
          })}
        >
          <span>run_test_1001</span>
        </RunHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() =>
        expect(r.getByRole("dialog").textContent).toContain("Schedule"),
      );
    });
  });

  test("offers the chain and the full run view as real links", async () => {
    await withApi({ run: async () => stubDetail() }, async () => {
      const r = renderWithClient(
        <RunHoverCard run={stubRun()} chainId="corr_1001">
          <span>run_test_1001</span>
        </RunHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(
        r.getByRole("link", { name: /View chain/i }).getAttribute("href"),
      ).toBe("#/chain/corr_1001/run%3Arun_test_1001");
      expect(
        r.getByRole("link", { name: /Open run/i }).getAttribute("href"),
      ).toBe("#/run/run_test_1001");
    });
  });

  test("omits the chain action when no correlation id reaches the card", async () => {
    await withApi({ run: async () => stubDetail() }, async () => {
      const r = renderWithClient(
        <RunHoverCard run={stubRun()}>
          <span>run_test_1001</span>
        </RunHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(r.queryByRole("link", { name: /View chain/i })).toBeNull();
      expect(r.getByRole("link", { name: /Open run/i })).toBeTruthy();
    });
  });

  test("renders attempts alone, without a stray slash, when the bounded GET /runs summary omits maxAttempts (WM-982)", async () => {
    await withApi({ run: async () => stubDetail() }, async () => {
      const r = renderWithClient(
        <RunHoverCard run={stubRun({ maxAttempts: undefined })}>
          <span>run_test_1001</span>
        </RunHoverCard>,
      );
      fireEvent.mouseEnter(triggerOf(r.container));

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      const card = r.getByRole("dialog");
      expect(card.textContent).toContain("2");
      expect(card.textContent).not.toContain("2/undefined");
      expect(card.textContent).not.toContain("undefined");
    });
  });

  test("opens on keyboard focus so the card is not mouse-only", async () => {
    await withApi({ run: async () => stubDetail() }, async () => {
      const r = renderWithClient(
        <RunHoverCard run={stubRun()}>
          <span>run_test_1001</span>
        </RunHoverCard>,
      );
      const trigger = triggerOf(r.container);
      expect(trigger.getAttribute("tabindex")).toBe("0");

      trigger.focus();
      fireEvent.focus(trigger);

      await waitFor(() => expect(r.getByRole("dialog")).toBeTruthy());
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
  });
});
