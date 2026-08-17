import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactView as ArtifactViewDoc } from "../types";
import { ARTIFACT_RAW_KEY, ArtifactPanel, ArtifactView } from "./ArtifactView";

const AGENTS = path.resolve(import.meta.dir, "../../../agents");
const readView = (name: string): ArtifactViewDoc =>
  JSON.parse(readFileSync(path.join(AGENTS, `${name}.view.json`), "utf8"));
const triageView = readView("triage-scan");
const mergeView = readView("merge-scan");

const triageArtifact = {
  recommendation: "TRIAGE",
  repo: "factory",
  summary: "Three issues moved; one needs a human.",
  plan: [
    { issueId: "WM-1", action: "label-agent-ready", reason: "Complete spec." },
    {
      issueId: "WM-2",
      action: "needs-human",
      reason: "Scope unclear.",
      detail: "## Acceptance Criteria\n- decide the scope",
      ownedPaths: ["src/a.ts", "src/b.ts"],
    },
    { issueId: "WM-3", action: "label-agent-ready", reason: "Ready." },
  ],
};

/** Real shape (GET /api/runs/run_44fa5716-… on the live instance): escalations only, empty plan/fix. */
const mergeArtifact = {
  base: "develop",
  deployBranch: "main",
  escalate: [
    { headSha: "c3d50c8d494caeca7de97b5a7dd598463098a6d0", pr: 471, reason: "Existing draft hold.", ticket: "WM-210" },
    { headSha: "e1b1942fb255dc588d35fde9c8b03419ec81527e", pr: 474, reason: "CI in progress.", ticket: "WM-193" },
  ],
  fix: [],
  github: "watt-mind/factory",
  plan: [],
  recommendation: "ESCALATE",
  repo: "factory",
  summary: "Thirteen open PRs; no PR met the MERGE bar.",
};

beforeEach(() => localStorage.removeItem(ARTIFACT_RAW_KEY));
afterEach(() => {
  cleanup();
  localStorage.removeItem(ARTIFACT_RAW_KEY);
});

describe("ArtifactView with the shipped triage-scan view (WM-455)", () => {
  test("summary first, status badge in the header, grouped plan rows with issue chips, expand behind a disclosure", () => {
    const r = render(<ArtifactView artifact={triageArtifact} view={triageView} />);
    expect(r.getByText("Triage plan")).toBeTruthy();
    expect(r.getByText("TRIAGE")).toBeTruthy();
    expect(r.getByText("Three issues moved; one needs a human.")).toBeTruthy();

    // Grouped by action, first-seen order, with counts.
    const groups = r.getAllByRole("button", { name: /label-agent-ready|needs-human/ });
    expect(groups.map((g) => g.textContent?.replace(/\s+/g, "").trim())).toEqual([
      "label-agent-ready2",
      "needs-human1",
    ]);

    // Issue chips link to Linear.
    const chip = r.getByRole("link", { name: "WM-2" }) as HTMLAnchorElement;
    expect(chip.getAttribute("href")).toBe("https://linear.app/watt-mind/issue/WM-2");
    expect(chip.getAttribute("target")).toBe("_blank");

    // Expand columns hide until the row's disclosure opens.
    expect(r.queryByText("detail")).toBeNull();
    const expanders = r.getAllByRole("button", { name: "Expand row" });
    expect(expanders).toHaveLength(1);
    fireEvent.click(expanders[0]);
    expect(r.getByText("detail")).toBeTruthy();
    expect(r.getByText(/decide the scope/)).toBeTruthy();
    expect(r.getByText("src/a.ts")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Collapse row" }));
    expect(r.queryByText("detail")).toBeNull();

    // Collapsing a group hides its rows.
    fireEvent.click(groups[0]);
    expect(r.queryByRole("link", { name: "WM-1" })).toBeNull();
    expect(r.getByRole("link", { name: "WM-2" })).toBeTruthy();

    // Repo keyvalue.
    expect(r.getByText("Repo")).toBeTruthy();
    expect(r.getByText("factory")).toBeTruthy();
  });

  test("a missing optional path renders without that section", () => {
    const r = render(
      <ArtifactView artifact={{ recommendation: "NOOP", summary: "Nothing to do.", repo: "factory" }} view={triageView} />,
    );
    expect(r.getByText("Nothing to do.")).toBeTruthy();
    expect(r.getByText("NOOP")).toBeTruthy();
    expect(r.queryByText("Plan")).toBeNull();
    expect(r.queryByRole("table")).toBeNull();
    expect(r.getByText("Repo")).toBeTruthy();
  });
});

describe("ArtifactPanel — Raw toggle and fallback", () => {
  test("no view → JsonBlock only, no toggle", () => {
    const r = render(<ArtifactPanel artifact={triageArtifact} view={null} />);
    expect(r.queryByRole("group", { name: "Artifact rendering" })).toBeNull();
    expect(r.queryByRole("table")).toBeNull();
    expect(r.container.querySelector("pre")?.textContent).toContain('"recommendation": "TRIAGE"');
  });

  test("Raw toggle round-trips between the view and JsonBlock and persists", () => {
    const r = render(<ArtifactPanel artifact={triageArtifact} view={triageView} />);
    expect(r.getByRole("table")).toBeTruthy();
    expect(r.container.querySelector("pre")).toBeNull();

    const group = r.getByRole("group", { name: "Artifact rendering" });
    const raw = within(group).getByRole("button", { name: "Raw" });
    const view = within(group).getByRole("button", { name: "View" });
    expect(view.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(raw);
    expect(r.queryByRole("table")).toBeNull();
    expect(r.container.querySelector("pre")?.textContent).toContain('"issueId": "WM-1"');
    expect(localStorage.getItem(ARTIFACT_RAW_KEY)).toBe("1");
    expect(within(r.getByRole("group", { name: "Artifact rendering" })).getByRole("button", { name: "Raw" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(r.getByRole("group", { name: "Artifact rendering" })).getByRole("button", { name: "View" }));
    expect(r.getByRole("table")).toBeTruthy();
    expect(localStorage.getItem(ARTIFACT_RAW_KEY)).toBe("0");
  });

  test("a persisted Raw preference opens on JSON", () => {
    localStorage.setItem(ARTIFACT_RAW_KEY, "1");
    const r = render(<ArtifactPanel artifact={triageArtifact} view={triageView} />);
    expect(r.queryByRole("table")).toBeNull();
    expect(r.container.querySelector("pre")).toBeTruthy();
    expect(r.getByRole("group", { name: "Artifact rendering" })).toBeTruthy();
  });

  test("a view that says nothing about this artifact falls back to JSON without a toggle", () => {
    const r = render(<ArtifactPanel artifact={{ type: "assistant", message: "hi" }} view={triageView} />);
    expect(r.queryByRole("group", { name: "Artifact rendering" })).toBeNull();
    expect(r.container.querySelector("pre")).toBeTruthy();
  });
});

describe("ArtifactView with the shipped merge-scan view", () => {
  test("renders the real merge-plan shape: status, escalate table with pr and ticket chips, whole-artifact keyvalue", () => {
    const r = render(<ArtifactView artifact={mergeArtifact} view={mergeView} />);
    expect(r.getByText("Merge plan")).toBeTruthy();
    expect(r.getByText("ESCALATE")).toBeTruthy();
    expect(r.getByText("Thirteen open PRs; no PR met the MERGE bar.")).toBeTruthy();

    // Empty tables are labelled and honest, not dropped (the pointer resolves).
    expect(r.getByText("Merge")).toBeTruthy();
    expect(r.getByText("Fix")).toBeTruthy();
    expect(r.getAllByText("None.")).toHaveLength(2);

    const pr = r.getByRole("link", { name: "#471" }) as HTMLAnchorElement;
    expect(pr.getAttribute("href")).toBe("https://github.com/watt-mind/factory/pull/471");
    expect((r.getByRole("link", { name: "WM-210" }) as HTMLAnchorElement).getAttribute("href")).toBe(
      "https://linear.app/watt-mind/issue/WM-210",
    );
    expect(r.getByText("Existing draft hold.")).toBeTruthy();

    // headSha is expand-only, shortened to 12 with the full sha in the title.
    expect(r.queryByText("c3d50c8d494c")).toBeNull();
    fireEvent.click(r.getAllByRole("button", { name: "Expand row" })[0]);
    expect(r.getByText("c3d50c8d494c").getAttribute("title")).toBe("c3d50c8d494caeca7de97b5a7dd598463098a6d0");

    // `path: ""` keyvalue over the whole artifact, `keys` subset, absent noopReason dropped.
    expect(r.getByText("github")).toBeTruthy();
    expect(r.getByText("watt-mind/factory")).toBeTruthy();
    expect(r.getByText("deployBranch")).toBeTruthy();
    expect(r.getByText("main")).toBeTruthy();
    expect(r.queryByText("noopReason")).toBeNull();
  });

  test("run chips call onJumpRun when the host provides it, else link to #/runs/<id>", () => {
    const view: ArtifactViewDoc = {
      schemaVersion: "factory.artifact-view/v1",
      sections: [{ path: "/runs", as: "list", label: "Runs", formats: { "": "run" } }],
    };
    const artifact = { runs: ["run_44fa5716-0304-49b1-8b65-a45500d0d784"] };
    const jumped: string[] = [];
    const r = render(<ArtifactView artifact={artifact} view={view} onJumpRun={(id) => jumped.push(id)} />);
    fireEvent.click(r.getByRole("button", { name: "run_44fa5716" }));
    expect(jumped).toEqual(["run_44fa5716-0304-49b1-8b65-a45500d0d784"]);
    cleanup();
    const r2 = render(<ArtifactView artifact={artifact} view={view} />);
    expect((r2.getByRole("link", { name: "run_44fa5716" }) as HTMLAnchorElement).getAttribute("href")).toBe(
      "#/runs/run_44fa5716-0304-49b1-8b65-a45500d0d784",
    );
  });
});
