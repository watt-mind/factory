import { describe, expect, test } from "bun:test";
import { groupDiscoveredFields, type DiscoveredField } from "./schemaDiscovery";

const field = (path: string): DiscoveredField => ({
  path,
  sampleValue: `${path}-sample`,
  occurrenceCount: 1,
});

describe("groupDiscoveredFields", () => {
  test("turns an ungrouped discovery list into stable root groups", () => {
    const groups = groupDiscoveredFields([
      field("payload.repo"),
      field("spec.input.model"),
      field("payload.owner"),
      field("id"),
      field("labels.priority"),
    ]);

    expect(groups.map((group) => group.root)).toEqual(["payload", "spec", "top-level", "labels"]);
    expect(groups[0].fields.map((item) => item.path)).toEqual(["payload.repo", "payload.owner"]);
    expect(groups[2].fields.map((item) => item.path)).toEqual(["id"]);
  });
});
