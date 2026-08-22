/**
 * bun test tools/onboard.test.mjs
 *
 * The dangerous part is the tracker selection. `factory onboard` hands its
 * output to an agent that will follow it literally, so the two failure modes
 * that matter are silent: a leaked block tells the agent to configure the
 * tracker the human did not choose, and a swallowed step (a marker mismatch
 * eating everything to the end of file) removes the exit gate that is the only
 * definition of done. Both look like a perfectly reasonable prompt.
 *
 * The real `docs/onboarding/connect-repo.md` is exercised too, not just
 * synthetic fixtures — the invariant "every numbered step exists in both
 * variants" lives in that file's markup, and prose cross-references ("see step
 * 8") break the moment someone wraps a whole numbered step in a marker.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import {
  CONTROL_PLANES,
  PROMPT_PATH,
  fillPlaceholders,
  parseRemote,
  renderOnboarding,
  resolvePath,
  selectControlPlane,
} from "./onboard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT = readFileSync(path.join(ROOT, PROMPT_PATH), "utf8");

const FIXTURE = [
  "shared intro",
  "<!-- factory:onboard:github -->",
  "gh only",
  "<!-- /factory:onboard -->",
  "<!-- factory:onboard:linear -->",
  "linear only",
  "<!-- /factory:onboard -->",
  "shared outro",
  "",
].join("\n");

test("selectControlPlane keeps only the chosen tracker's blocks", () => {
  const gh = selectControlPlane(FIXTURE, "github");
  expect(gh).toContain("gh only");
  expect(gh).not.toContain("linear only");

  const linear = selectControlPlane(FIXTURE, "linear");
  expect(linear).toContain("linear only");
  expect(linear).not.toContain("gh only");
});

test("selectControlPlane keeps shared prose in both variants", () => {
  for (const plane of CONTROL_PLANES) {
    const out = selectControlPlane(FIXTURE, plane);
    expect(out).toContain("shared intro");
    expect(out).toContain("shared outro");
  }
});

test("selectControlPlane strips every marker", () => {
  for (const plane of CONTROL_PLANES) {
    expect(selectControlPlane(PROMPT, plane)).not.toContain("factory:onboard:");
  }
});

test("selectControlPlane rejects an unknown control plane", () => {
  expect(() => selectControlPlane(FIXTURE, "jira")).toThrow(
    /unknown control plane/,
  );
});

test("selectControlPlane rejects malformed markers rather than swallowing text", () => {
  const unclosed = "<!-- factory:onboard:github -->\nbody\n";
  expect(() => selectControlPlane(unclosed, "github")).toThrow(/unclosed/);

  const nested = [
    "<!-- factory:onboard:github -->",
    "<!-- factory:onboard:linear -->",
    "body",
    "<!-- /factory:onboard -->",
    "<!-- /factory:onboard -->",
  ].join("\n");
  expect(() => selectControlPlane(nested, "github")).toThrow(/nested/);

  const orphan = "body\n<!-- /factory:onboard -->\n";
  expect(() => selectControlPlane(orphan, "github")).toThrow(/unmatched/);

  const unknownBlock = [
    "<!-- factory:onboard:jira -->",
    "body",
    "<!-- /factory:onboard -->",
  ].join("\n");
  expect(() => selectControlPlane(unknownBlock, "github")).toThrow(
    /unknown block/,
  );
});

test("every numbered step survives both variants, in the same order", () => {
  const steps = (text) => text.match(/^## \d+\..*$/gm) ?? [];
  const gh = steps(selectControlPlane(PROMPT, "github"));
  const linear = steps(selectControlPlane(PROMPT, "linear"));
  expect(gh.length).toBeGreaterThan(0);
  // Not just the same count: identical headings, so the prose cross-references
  // ("see step 8") point at the same step in either variant.
  expect(linear).toEqual(gh);
  expect(steps(PROMPT)).toEqual(gh);
});

test("the exit gate is present in both variants", () => {
  for (const plane of CONTROL_PLANES) {
    const out = selectControlPlane(PROMPT, plane);
    expect(out).toContain("factory doctor");
    expect(out).toContain("factory queue --repo");
  }
});

test("the real prompt routes tracker-specific setup to the right variant", () => {
  const gh = selectControlPlane(PROMPT, "github");
  expect(gh).toContain("### GitHub Issues");
  expect(gh).toContain("--control-plane github");
  expect(gh).toContain("Projects v2");
  expect(gh).not.toContain("### Linear");
  expect(gh).not.toContain("Set `LINEAR_API_KEY` in the environment");

  const linear = selectControlPlane(PROMPT, "linear");
  expect(linear).toContain("### Linear");
  expect(linear).toContain("Set `LINEAR_API_KEY` in the environment");
  expect(linear).not.toContain("### GitHub Issues");
  expect(linear).not.toContain("--control-plane github");
});

test("fillPlaceholders substitutes known values everywhere they appear", () => {
  const out = fillPlaceholders("<FACTORY_ROOT> and <FACTORY_ROOT>", {
    factoryRoot: "/f",
  });
  expect(out).toBe("/f and /f");
});

test("fillPlaceholders leaves unknown values as placeholders", () => {
  // A guessed OWNER/REPO would be followed without question; the placeholder
  // is an instruction to go and look.
  const out = fillPlaceholders("<TARGET_REPO_PATH> <OWNER/REPO>", {
    repoPath: "/r",
  });
  expect(out).toBe("/r <OWNER/REPO>");
});

test("renderOnboarding selects and substitutes in one pass", () => {
  const out = renderOnboarding(
    [
      "<!-- factory:onboard:github -->",
      "at <FACTORY_ROOT>",
      "<!-- /factory:onboard -->",
    ].join("\n"),
    { controlPlane: "github", factoryRoot: "/f" },
  );
  expect(out.trim()).toBe("at /f");
});

test("renderOnboarding defaults to the github control plane", () => {
  expect(renderOnboarding(FIXTURE)).toContain("gh only");
});

test("parseRemote reads both GitHub remote forms", () => {
  expect(parseRemote("git@github.com:watt-mind/factory.git")).toBe(
    "watt-mind/factory",
  );
  expect(parseRemote("https://github.com/watt-mind/factory.git")).toBe(
    "watt-mind/factory",
  );
  expect(parseRemote("https://github.com/watt-mind/factory")).toBe(
    "watt-mind/factory",
  );
  expect(parseRemote("git@gitlab.com:o/r.git")).toBeNull();
  expect(parseRemote("")).toBeNull();
  expect(parseRemote(null)).toBeNull();
});

test("resolvePath expands ~ and relative paths", () => {
  expect(resolvePath("~/Develop/x", { home: "/Users/x" })).toBe(
    "/Users/x/Develop/x",
  );
  expect(resolvePath("~", { home: "/Users/x" })).toBe("/Users/x");
  expect(resolvePath("sub", { cwd: "/work" })).toBe("/work/sub");
  expect(resolvePath("/abs", { cwd: "/work" })).toBe("/abs");
  // A path that merely starts with ~ is not a home reference.
  expect(resolvePath("~weird", { home: "/Users/x", cwd: "/work" })).toBe(
    "/work/~weird",
  );
});
