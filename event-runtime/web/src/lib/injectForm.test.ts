import { describe, expect, test } from "bun:test";
import { errorsByField, fieldErrorVisible, schemaFields } from "./injectForm";

describe("fieldErrorVisible (WM-78)", () => {
  test("hides errors until the field is touched or submit is attempted", () => {
    expect(fieldErrorVisible("repo", {}, false)).toBe(false);
    expect(fieldErrorVisible("repo", { repo: true }, false)).toBe(true);
    expect(fieldErrorVisible("repo", {}, true)).toBe(true);
    expect(fieldErrorVisible("repo", { other: true }, false)).toBe(false);
  });
});

const MOUNT_SCHEMA = {
  type: "object",
  required: ["mount"],
  properties: {
    mount: { type: "string", pattern: "^/[A-Za-z0-9/._-]*$" },
    repoPin: {
      type: "object",
      properties: { sha: { type: "string", pattern: "^[0-9a-f]{40}$" } },
    },
  },
};

describe("errorsByField pattern humanization (WM-86)", () => {
  test("replaces raw regex with a placeholder-based format hint", () => {
    const fields = schemaFields(MOUNT_SCHEMA) ?? [];
    const mapped = errorsByField(
      ["$.mount: does not match pattern ^/[A-Za-z0-9/._-]*$"],
      fields,
    );
    const msg = (mapped.get("mount") ?? []).join(" ");
    expect(msg).not.toContain("^/");
    expect(msg).not.toMatch(/A-Za-z0-9/);
    expect(msg).toMatch(/expected format/i);
    expect(msg).toContain("/absolute/path");
  });

  test("does not leak regex when no placeholder is available", () => {
    const mapped = errorsByField(["$.logArtifact: does not match pattern ^[0-9a-f]{64}$"]);
    const msg = (mapped.get("logArtifact") ?? []).join(" ");
    expect(msg).not.toContain("^");
    expect(msg).toMatch(/expected format/i);
  });
});
