import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { renderCellsGuide } from "./cells-guide.mjs";
import { createWorkspace } from "./workspace.mjs";

describe("Capability-Gated Cell Guide Injection (CELLS.md)", () => {
  it("renders structured CELLS.md guide with declared capabilities", () => {
    const guide = renderCellsGuide({
      cells: [
        {
          binding: "ARTICLE_CELL",
          access: "data-only",
          description: "Article sources and drafts",
        },
      ],
      cellEndpoint: "http://100.74.142.98:8080",
    });

    expect(guide).toContain(
      "# Cells & Durable Objects Interaction Guide (CELLS.md)",
    );
    expect(guide).toContain("`ARTICLE_CELL`");
    expect(guide).toContain("data-only");
    expect(guide).toContain("http://100.74.142.98:8080");
    expect(guide).toContain("GET /v1/state");
    expect(guide).toContain("POST /v1/revisions");
    expect(guide).toContain("curl -s");
  });

  it("materializes CELLS.md into workspace only when capabilities.cells is present", () => {
    const root = path.resolve("/tmp/test-factory-workspace-" + Date.now());

    // 1. Workspace WITH cell capabilities
    const wsWithCells = createWorkspace({
      root,
      runId: "run-cell-test",
      attempt: 1,
      input: {
        cellEndpoint: "http://100.74.142.98:8080",
        articleId: "editorial:article:coachwatts.com:test-001",
      },
      capabilities: {
        cells: [{ binding: "ARTICLE_CELL", access: "data-only" }],
      },
    });

    const cellsMdPath = path.join(wsWithCells.dir, "CELLS.md");
    expect(existsSync(cellsMdPath)).toBe(true);
    const content = readFileSync(cellsMdPath, "utf8");
    expect(content).toContain("ARTICLE_CELL");
    expect(content).toContain("http://100.74.142.98:8080");

    // 2. Workspace WITHOUT cell capabilities
    const wsWithoutCells = createWorkspace({
      root,
      runId: "run-no-cell-test",
      attempt: 1,
      input: { ticket: "OPS-123" },
      capabilities: { cells: [] },
    });

    const noCellsMdPath = path.join(wsWithoutCells.dir, "CELLS.md");
    expect(existsSync(noCellsMdPath)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});
