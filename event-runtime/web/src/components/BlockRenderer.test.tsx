import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Presentation } from "../types";
import { BlockRenderer, PresentationPanel } from "./BlockRenderer";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const presentation: Presentation = {
  schemaVersion: "factory.presentation/v1",
  blocks: [
    { type: "heading", text: "Finding" },
    { type: "markdown", text: "Interpretation" },
    {
      type: "keyvalue",
      items: [{ label: "Count", value: { $ref: "/count" }, format: "count" }],
    },
    {
      type: "list",
      label: "Attention",
      items: [{ text: "Review this", ref: "/issue", tone: "warn" }],
    },
    {
      type: "table",
      label: "Rows",
      columns: ["Issue"],
      rows: [[{ $ref: "/issue" }]],
      formats: ["issue"],
    },
    { type: "badge", text: "SHIP", tone: "ok" },
    { type: "code", language: "json", text: "{}" },
    {
      type: "section",
      label: "Method",
      collapsed: true,
      blocks: [{ type: "markdown", text: "Details" }],
    },
    { type: "links", items: [{ label: "Run", run: { $ref: "/run" } }] },
  ],
};
const artifact = { count: 1200, issue: "WM-12", run: "run_1234567890" };

test("renders every block and exposes resolved sources", () => {
  const view = render(
    <BlockRenderer presentation={presentation} artifact={artifact} />,
  );
  expect(view.getByText("Finding")).toBeTruthy();
  expect(view.getByText("Interpretation")).toBeTruthy();
  expect(
    view
      .getByText("1,200")
      .closest("[data-presentation-source]")
      ?.getAttribute("title"),
  ).toBe("Source: /count");
  expect(view.getByText("!")).toBeTruthy();
  expect(view.getAllByText("WM-12").length).toBeGreaterThan(0);
  expect(view.getByText("SHIP")).toBeTruthy();
  expect(view.getByText("{}")).toBeTruthy();
  const method = view.getByText("Method").closest("details");
  expect(method?.open).toBe(false);
  expect(view.getByText("run_12345678")).toBeTruthy();
});

test("presentation owns an independent raw toggle", () => {
  const view = render(
    <PresentationPanel presentation={presentation} artifact={artifact} />,
  );
  fireEvent.click(view.getByText("Raw"));
  expect(view.container.querySelector("[data-presentation-view]")).toBeNull();
  expect(view.getByText("View")).toBeTruthy();
});

test("rejects a malformed client document without throwing", () => {
  const view = render(
    <PresentationPanel
      presentation={
        {
          schemaVersion: "factory.presentation/v1",
          blocks: [{ type: "list", items: "not-an-array" }],
        } as unknown as Presentation
      }
      artifact={artifact}
    />,
  );
  expect(
    view.getByText("the agent's summary was dropped: 1 errors"),
  ).toBeTruthy();
  expect(view.queryByText("Raw")).toBeNull();
});

test("run chips preserve the active project context", () => {
  window.location.hash = "#/runs?project=factory";
  const view = render(
    <BlockRenderer presentation={presentation} artifact={artifact} />,
  );
  expect(
    view.getByText("run_12345678").closest("a")?.getAttribute("href"),
  ).toBe("#/runs/run_1234567890?project=factory");
});
