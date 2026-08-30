import { describe, expect, test } from "bun:test";
import { parseListLimit } from "./api-params.mjs";

describe("parseListLimit", () => {
  test("uses the default for an omitted limit", () => {
    expect(
      parseListLimit(new URL("http://localhost/list"), {
        defaultLimit: 25,
        maxLimit: 100,
      }),
    ).toBe(25);
  });

  test("rejects non-integers and values outside the configured range", () => {
    for (const value of ["abc", "0", "101"]) {
      expect(() =>
        parseListLimit(new URL(`http://localhost/list?limit=${value}`), {
          defaultLimit: 25,
          maxLimit: 100,
        }),
      ).toThrow("limit must be an integer between 1 and 100");
    }
  });
});
