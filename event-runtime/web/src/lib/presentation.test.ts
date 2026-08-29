import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// The server contract is JavaScript and intentionally has no web-facing types.
// @ts-expect-error compare this browser port directly with the canonical module.
import { validatePresentation as validateServerPresentation } from "../../../lib/presentation.mjs";
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
      const server = validateServerPresentation(
        entry.presentation,
        fixture.artifact,
      );
      const browser = validatePresentation(
        entry.presentation,
        fixture.artifact,
      );
      expect(browser.valid, entry.name).toBe(server.valid);
      expect(browser.valid, `${entry.name} fixture expectation`).toBe(
        entry.valid,
      );
    }
  });

  test("resolves values while retaining their source pointer", () => {
    const resolved = resolveRefs(
      fixture.cases[0].presentation,
      fixture.artifact,
    );
    const keyvalue = resolved.blocks[2] as {
      items: Array<{ value: unknown }>;
    };
    expect(keyvalue.items[0].value).toEqual({
      value: "DISPATCH",
      ref: "/recommendation",
    });
  });

  test("rejects schema bounds before malformed blocks reach React", () => {
    const invalid = {
      schemaVersion: "factory.presentation/v1",
      blocks: [
        {
          type: "section",
          label: "",
          blocks: [
            {
              type: "code",
              text: "ok",
              language: "x".repeat(41),
            },
          ],
        },
      ],
    };
    const result = validatePresentation(invalid, fixture.artifact);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("label"))).toBe(true);
    expect(result.errors.some((error) => error.includes("language"))).toBe(
      true,
    );
  });
});
