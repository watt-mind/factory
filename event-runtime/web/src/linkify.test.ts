import { describe, expect, test } from "bun:test";
import { linkifyText } from "./linkify";

describe("linkifyText", () => {
  test("linkifies a plain URL", () => {
    expect(linkifyText("See https://example.com/runs/42.")).toEqual([
      { kind: "text", text: "See " },
      {
        kind: "link",
        text: "https://example.com/runs/42",
        href: "https://example.com/runs/42",
        title: "https://example.com/runs/42",
      },
      { kind: "text", text: "." },
    ]);
  });

  test("shortens GitHub pull request URLs and excludes closing delimiters", () => {
    const url = "https://github.com/watt-mind/factory/pull/486";
    expect(linkifyText(`<${url}>`)).toEqual([
      { kind: "text", text: "<" },
      {
        kind: "link",
        text: "watt-mind/factory#486",
        href: url,
        title: url,
      },
      { kind: "text", text: ">" },
    ]);
  });

  test("links Linear-style ticket ids", () => {
    expect(linkifyText("Fixes WM-546")).toEqual([
      { kind: "text", text: "Fixes " },
      {
        kind: "link",
        text: "WM-546",
        href: "https://linear.app/watt-mind/issue/WM-546",
        title: "WM-546",
      },
    ]);
  });

  test("links GitHub issue identifiers without matching URLs or longer paths", () => {
    expect(linkifyText("See watt-mind/factory#1573.")).toEqual([
      { kind: "text", text: "See " },
      {
        kind: "link",
        text: "watt-mind/factory#1573",
        href: "https://github.com/watt-mind/factory/issues/1573",
        title: "watt-mind/factory#1573",
      },
      { kind: "text", text: "." },
    ]);
    expect(linkifyText("https://example.com/watt-mind/factory#1573")).toEqual([
      {
        kind: "link",
        text: "https://example.com/watt-mind/factory#1573",
        href: "https://example.com/watt-mind/factory#1573",
        title: "https://example.com/watt-mind/factory#1573",
      },
    ]);
    expect(linkifyText("see docs/protocol.md#4")).toEqual([
      { kind: "text", text: "see docs/protocol.md#4" },
    ]);
    expect(linkifyText("event-runtime/web.ts#3 and build/emit.mjs#2")).toEqual([
      { kind: "text", text: "event-runtime/web.ts#3 and build/emit.mjs#2" },
    ]);
    expect(linkifyText("at example.com/factory#1573")).toEqual([
      { kind: "text", text: "at example.com/factory#1573" },
    ]);
    expect(linkifyText("x/watt-mind/factory#1573")).toEqual([
      { kind: "text", text: "x/watt-mind/factory#1573" },
    ]);
  });

  test("leaves text without matches unchanged", () => {
    expect(linkifyText("Nothing to link here.")).toEqual([
      { kind: "text", text: "Nothing to link here." },
    ]);
  });
});
