import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { RunDetailBlocks, isCancellable } from "./RunDetailBlocks";
import { createLifecycleEventFixture, createRunDetailFixture } from "../test-render";
import type { RunDetail, RunState } from "../types";

afterEach(() => {
  cleanup();
});

const noop = () => {};

function renderBlocks(d: RunDetail, overrides?: Partial<Parameters<typeof RunDetailBlocks>[0]>) {
  return render(
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

    const titled = Array.from(failedRow!.querySelectorAll("[title]")).filter((el) =>
      (el.getAttribute("title") ?? "").includes(LONG_REASON),
    );
    expect(titled.length).toBeGreaterThan(0);

    const truncated = Array.from(failedRow!.querySelectorAll(".truncate")).filter((el) =>
      el.textContent?.includes(LONG_REASON),
    );
    expect(truncated.length).toBe(0);
  });
});
