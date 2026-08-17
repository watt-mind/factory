import "../test-dom";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ATTR_ICON_KEYS, attrIcon, normalizeAttr } from "./attrIcons";

const svg = (label: string) => renderToStaticMarkup(<>{attrIcon(label)}</>);

describe("attribute icon registry (§5.2 tier 4, WM-483)", () => {
  test("normalises label spellings so one attribute has one key", () => {
    expect(normalizeAttr("modelTier")).toBe("modeltier");
    expect(normalizeAttr("model tier")).toBe("modeltier");
    expect(normalizeAttr("model-tier")).toBe("modeltier");
    expect(normalizeAttr("model (pinned)")).toBe("modelpinned");
    expect(normalizeAttr("input.repoPin")).toBe("input");
  });

  test("the same attribute resolves to the same glyph regardless of the view's label style", () => {
    expect(svg("modelTier")).toBe(svg("model tier"));
    expect(svg("outputContract")).toBe(svg("output contract"));
    expect(svg("input.repo")).toBe(svg("input"));
    expect(svg("adapter")).not.toBe("");
    expect(svg("adapter")).not.toBe(svg("agent"));
  });

  test("identity and state labels are unmapped so they render an empty, reserved slot", () => {
    for (const k of ["id", "run", "runId", "version", "specHash", "idempotencyKey", "state", "status", "decision", "pid"]) {
      expect(attrIcon(k)).toBeNull();
    }
  });

  test("every registered glyph is a currentColor svg (hue stays with the label)", () => {
    for (const key of ATTR_ICON_KEYS) {
      const out = svg(key);
      expect(out.startsWith("<svg")).toBe(true);
      expect(out).toContain('fill="currentColor"');
    }
  });
});
