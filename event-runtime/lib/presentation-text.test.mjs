import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveRefs } from "./presentation.mjs";
import { renderText } from "./presentation-text.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/presentation-cases.json", import.meta.url),
    "utf8",
  ),
);

describe("renderText", () => {
  test("snapshots every fixture block as bounded plain text", () => {
    const presentation = resolveRefs(
      fixture.cases[0].presentation,
      fixture.artifact,
    );
    expect(renderText(presentation, { width: 60 }))
      .toBe(`# 58 issues in Triage; 14 can be made agent-ready today

Most of the backlog is under-specified rather than wrong.

Recommendation: DISPATCH
Issues seen: 58
Note: computed by hand

Needs a human
! WM-312 — production infra; incompatible deploy paths
! WM-336 — tool allowlist; wants a security owner

Duplicates
Issue  | Duplicate of
-------+-------------
WM-201 | WM-201
WM-118 | WM-118

✓ DISPATCH

    { "ok": true }

Method:
  How this was computed.

Repo <https://github.com/watt-mind/factory>`);
  });

  test("honours the width when aligning long table cells", () => {
    const output = renderText(
      {
        blocks: [
          {
            type: "table",
            columns: ["A", "B"],
            rows: [["a very long value", "another long value"]],
          },
        ],
      },
      { width: 24 },
    );
    expect(
      Math.max(...output.split("\n").map((line) => line.length)),
    ).toBeLessThanOrEqual(24);
    const physicalRows = output.split("\n").slice(2);
    expect(physicalRows.map((line) => line.split("|")[0].trim()).join("")).toBe(
      "a very long value",
    );
    expect(physicalRows.map((line) => line.split("|")[1].trim()).join("")).toBe(
      "another long value",
    );
  });

  test("uses the target as the label when a link has no label", () => {
    expect(
      renderText({
        blocks: [
          {
            type: "links",
            items: [
              { url: "https://example.test/runs/1" },
              { issue: "WM-1289" },
              { label: "", url: "https://example.test/runs/2" },
              { label: "  \t", url: "https://example.test/runs/3" },
            ],
          },
        ],
      }),
    ).toBe(
      "https://example.test/runs/1 <https://example.test/runs/1>\nWM-1289 <WM-1289>\nhttps://example.test/runs/2 <https://example.test/runs/2>\nhttps://example.test/runs/3 <https://example.test/runs/3>",
    );
  });
});
