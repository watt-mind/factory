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
});
