import { expect, test } from "bun:test";
import {
  deployedRevision,
  deploymentState,
  formatAge,
  metadataUrl,
  resolveStatusBranches,
} from "./repo-status.mjs";

test("resolves status branches with loader-compatible defaults", () => {
  expect(resolveStatusBranches({})).toEqual({
    baseBranch: "main",
    deployBranch: null,
    metadataBranch: "main",
  });
  expect(resolveStatusBranches({ base: "develop" })).toEqual({
    baseBranch: "develop",
    deployBranch: null,
    metadataBranch: "develop",
  });
  expect(
    resolveStatusBranches({ base: "develop", deploy_branch: "main" }),
  ).toEqual({
    baseBranch: "develop",
    deployBranch: "main",
    metadataBranch: "main",
  });
  expect(resolveStatusBranches({ deployment: { branch: "release" } })).toEqual({
    baseBranch: "main",
    deployBranch: null,
    metadataBranch: "release",
  });
});

test("uses a configured revision field and accepts common revision payloads", () => {
  expect(
    deployedRevision({ revision: "abc", commit: "def" }, "revision"),
  ).toEqual({ field: "revision", value: "abc" });
  expect(deployedRevision({ commit: "def" })).toEqual({
    field: "commit",
    value: "def",
  });
  expect(deployedRevision({ status: "ok" })).toBeNull();
});

test("preserves exact metadata endpoint and supplies version.json for an origin", () => {
  expect(metadataUrl("https://app.example.test")).toBe(
    "https://app.example.test/version.json",
  );
  expect(metadataUrl("https://app.example.test/healthz")).toBe(
    "https://app.example.test/healthz",
  );
});

test("reports deployed revision freshness without claiming a failed lookup is stale", () => {
  expect(deploymentState({ deployed: "abc", remoteSha: "abc" }).state).toBe(
    "current",
  );
  expect(
    deploymentState({ deployed: "abc", remoteSha: "def", localContains: true })
      .state,
  ).toBe("stale");
  expect(
    deploymentState({ deployed: "abc", remoteSha: "def", localContains: false })
      .state,
  ).toBe("diverged");
  expect(deploymentState({ deployed: null, remoteSha: "def" }).state).toBe(
    "unknown",
  );
  expect(formatAge(null)).toBe("never recorded");
});
