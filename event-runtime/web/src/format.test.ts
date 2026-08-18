import { describe, expect, test } from "bun:test";
import { EMPTY, formatBytes, formatDuration, formatRelative } from "./format";

describe("formatDuration", () => {
  test.each([
    [59, "59s"],
    [60, "1m"],
    [3_599, "59m 59s"],
    [3_600, "1h"],
    [4_200, "1h 10m"],
    [86_400, "1d"],
    [604_800, "7d"],
  ])("formats %i seconds", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  test("uses the shared empty placeholder", () => {
    expect(formatDuration(null)).toBe(EMPTY);
  });
});

describe("formatBytes", () => {
  test.each([
    [1_023, "1023 B"],
    [1024 ** 2, "1.0 MB"],
    [1024 ** 3, "1.0 GB"],
  ])("formats %i bytes", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-01-02T00:00:00.000Z");

  test.each([
    ["2026-01-01T23:59:01.000Z", "59s ago"],
    ["2026-01-01T23:59:00.000Z", "1m ago"],
    ["2026-01-01T23:00:00.000Z", "1h ago"],
    ["2026-01-01T00:00:00.000Z", "1d ago"],
  ])("formats %s", (timestamp, expected) => {
    expect(formatRelative(timestamp, now)).toBe(expected);
  });

  test("uses the shared empty placeholder", () => {
    expect(formatRelative(undefined, now)).toBe(EMPTY);
  });
});
