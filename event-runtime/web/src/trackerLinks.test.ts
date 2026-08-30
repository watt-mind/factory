import { describe, expect, test } from "bun:test";
import { issueUrl, teamUrl } from "./trackerLinks";

describe("trackerLinks", () => {
  test("returns Linear issue and team URLs", () => {
    expect(issueUrl("WM-546")).toBe(
      "https://linear.app/watt-mind/issue/WM-546",
    );
    expect(teamUrl("WM")).toBe("https://linear.app/watt-mind/team/WM/active");
    expect(teamUrl("WM", "triage")).toBe(
      "https://linear.app/watt-mind/team/WM/triage",
    );
  });

  test("returns GitHub issue and repository URLs", () => {
    expect(issueUrl("watt-mind/factory#1573")).toBe(
      "https://github.com/watt-mind/factory/issues/1573",
    );
    expect(teamUrl("watt-mind/factory")).toBe(
      "https://github.com/watt-mind/factory/issues?q=is%3Aopen",
    );
    expect(teamUrl("watt-mind/factory", "triage")).toBe(
      "https://github.com/watt-mind/factory/issues?q=is%3Aopen",
    );
  });

  test("returns null for unsupported identifiers", () => {
    expect(issueUrl("not a ticket")).toBeNull();
    expect(teamUrl("not/a/team/path")).toBeNull();
    expect(issueUrl(null)).toBeNull();
    expect(teamUrl(null)).toBeNull();
  });
});
