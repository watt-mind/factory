import { expect, test } from "bun:test";
import { greet } from "./greet.mjs";

test("greets by name", () => {
  expect(greet("Ada")).toBe("Hello, Ada!");
});

test("rejects an empty name", () => {
  expect(() => greet("")).toThrow("greet requires a name");
  expect(() => greet("   ")).toThrow("greet requires a name");
  expect(() => greet(null)).toThrow("greet requires a name");
});
