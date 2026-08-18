import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { STATE_HUES } from "./ui";
import { ChainStateBar } from "./ChainStateBar";

afterEach(cleanup);

describe("ChainStateBar", () => {
  test("renders mixed states as a hue bar in STATE_HUES order", () => {
    const rendered = render(
      <ChainStateBar states={{ FAILED: 1, COMPLETED: 2 }} runCount={3} />,
    );
    const bar = rendered.getByRole("img", { name: "COMPLETED 2, FAILED 1" });
    expect(bar.getAttribute("title")).toBe("COMPLETED 2, FAILED 1");
    expect(bar.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["w-24", "h-1.5", "rounded-full"]),
    );

    const segments = [...bar.querySelectorAll("[data-state]")];
    expect(segments.map((el) => el.getAttribute("data-state"))).toEqual([
      "COMPLETED",
      "FAILED",
    ]);
    const canonical = Object.keys(STATE_HUES);
    expect(canonical.indexOf("COMPLETED")).toBeLessThan(
      canonical.indexOf("FAILED"),
    );
  });

  test("empty / zero runs is an empty track, not an em dash or badges", () => {
    const rendered = render(<ChainStateBar states={{}} runCount={0} />);
    const bar = rendered.getByRole("img");
    expect(bar.className).toContain("bg-(--surface-2)");
    expect(bar.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["w-24", "h-1.5", "rounded-full"]),
    );
    expect(bar.querySelectorAll("[data-state]").length).toBe(0);
    expect(bar.textContent).toBe("");
    expect(rendered.queryByText("—")).toBeNull();
    expect(rendered.queryByText("FAILED ×1")).toBeNull();
  });
});
