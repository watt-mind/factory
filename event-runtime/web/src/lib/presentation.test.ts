import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Presentation } from "../types";
import { resolveRefs, validatePresentation } from "./presentation";

interface PresentationFixture {
  artifact: unknown;
  cases: Array<{ name: string; valid: boolean; presentation: Presentation }>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../lib/fixtures/presentation-cases.json", import.meta.url),
    "utf8",
  ),
) as PresentationFixture;

describe("browser presentation port", () => {
  test("agrees with every server fixture verdict", () => {
    for (const entry of fixture.cases) {
      expect(
        validatePresentation(entry.presentation, fixture.artifact).valid,
        entry.name,
      ).toBe(entry.valid);
    }
  });

  test("resolves values while retaining their source pointer", () => {
    const resolved = resolveRefs(fixture.cases[0].presentation, fixture.artifact);
    const keyvalue = resolved.blocks[2] as {
      items: Array<{ value: unknown }>;
    };
    expect(keyvalue.items[0].value).toEqual({
      value: "DISPATCH",
      ref: "/recommendation",
    });
  });
});
