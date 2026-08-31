import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent } from "@testing-library/react";
import { EventEnvelopeView } from "./EventEnvelopeView";
import { renderWithClient } from "../test-render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("EventEnvelopeView", () => {
  test("formats operational identifiers as navigable semantic values", () => {
    const r = renderWithClient(
      <EventEnvelopeView
        now={Date.now()}
        envelope={{
          payload: {
            repo: "watt-mind/factory",
            runId: 42,
            ticket: "WM-2122",
            prNumber: 81,
            headSha: "0123456789abcdef",
            receivedAt: "2025-01-01T00:00:00.000Z",
          },
        }}
      />,
    );

    expect(
      r.getByRole("link", { name: "watt-mind/factory" }).getAttribute("href"),
    ).toBe("https://github.com/watt-mind/factory");
    expect(r.getByRole("link", { name: "run #42" }).getAttribute("href")).toBe(
      "https://github.com/watt-mind/factory/actions/runs/42",
    );
    expect(r.getByRole("link", { name: "WM-2122" }).getAttribute("href")).toBe(
      "#/tickets/WM-2122",
    );
    expect(r.getByRole("link", { name: "#81" }).getAttribute("href")).toBe(
      "https://github.com/watt-mind/factory/pull/81",
    );
    expect(r.getByRole("link", { name: "01234567" }).getAttribute("href")).toBe(
      "https://github.com/watt-mind/factory/commit/0123456789abcdef",
    );
  });

  test("persists the View / Raw choice", () => {
    const r = renderWithClient(
      <EventEnvelopeView
        now={Date.now()}
        envelope={{ payload: { repo: "watt-mind/factory" } }}
      />,
    );

    fireEvent.click(r.getByRole("button", { name: "Raw" }));
    expect(localStorage.getItem("evrt-artifact-raw")).toBe("1");
    expect(r.getByText('"watt-mind/factory"')).toBeTruthy();
  });

  test("uses the routed agent input view with the envelope payload", () => {
    const r = renderWithClient(
      <EventEnvelopeView
        now={Date.now()}
        envelope={{ payload: { repo: "watt-mind/factory" } }}
        inputView={{
          schemaVersion: "factory.artifact-view/v1",
          title: "Routed input",
          summary: "/repo",
          sections: [],
        }}
      />,
    );

    expect(r.getByText("Routed input")).toBeTruthy();
    expect(r.getByText("watt-mind/factory")).toBeTruthy();
  });

  test("Raw prints the envelope in both the semantic and input-view branches", () => {
    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId: "evt_raw_scope",
      type: "demo.type",
      payload: { repo: "watt-mind/factory" },
    };
    const inputView = {
      schemaVersion: "factory.artifact-view/v1" as const,
      title: "Routed input",
      summary: "/repo",
      sections: [],
    };

    for (const view of [undefined, inputView]) {
      const r = renderWithClient(
        <EventEnvelopeView
          now={Date.now()}
          envelope={envelope}
          inputView={view}
        />,
      );
      fireEvent.click(r.getByRole("button", { name: "Raw" }));
      const rawJson =
        Array.from(r.container.querySelectorAll("pre"))
          .map((el) => el.textContent ?? "")
          .find((text) => text.includes("evt_raw_scope")) ?? "";
      expect(rawJson).toContain('"schemaVersion"');
      expect(rawJson).toContain('"evt_raw_scope"');
      expect(rawJson).toContain('"demo.type"');
      cleanup();
      localStorage.clear();
    }
  });

  test("a payload-less envelope is JSON, not a field list of envelope metadata", () => {
    const r = renderWithClient(
      <EventEnvelopeView
        now={Date.now()}
        envelope={{
          schemaVersion: "factory.event/v1",
          eventId: "evt_no_payload",
          type: "demo.type",
        }}
      />,
    );

    expect(r.container.querySelector("dl")).toBeNull();
    expect(r.queryByRole("button", { name: "Raw" })).toBeNull();
    expect(r.container.querySelector("pre")?.textContent).toContain(
      "evt_no_payload",
    );
  });

  test("undefined payload fields render an em dash rather than an empty cell", () => {
    const r = renderWithClient(
      <EventEnvelopeView
        now={Date.now()}
        envelope={{
          payload: { repo: "watt-mind/factory", optional: undefined },
        }}
      />,
    );

    const row = r.getByText("optional").closest("div");
    expect(row?.textContent).toContain("—");
    expect(row?.querySelector("dd")?.textContent).toBe("—");
  });
});
