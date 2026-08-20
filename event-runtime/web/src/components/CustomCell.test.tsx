import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  CustomCell,
  formatCellValue,
  readCellUi,
  schemaForCellPath,
} from "./CustomCell";
import { renderWithClient, restoreApi, withApi } from "../test-render";
import type { RepoItem } from "../types";

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  restoreApi();
  globalThis.fetch = realFetch;
});

function repo(name: string, team: string | null): RepoItem {
  return {
    name,
    path: `/tmp/${name}`,
    github: `watt-mind/${name}`,
    team,
    project: null,
    base: "develop",
    deployBranch: null,
    reportOnly: false,
    maxInFlight: null,
    worktreeRoot: null,
    hasWorktreeUp: false,
    hasWorktreeDown: false,
    hasWorktreeWarm: false,
    verify: null,
  };
}

const reposApi = () => ({
  repos: mock(async () => ({
    repos: [repo("factory", "WM"), repo("bj29", "CLNT")],
  })),
});

/** A cell only renders inside a row; hydration warns otherwise. */
function renderCell(cell: React.ReactElement) {
  return renderWithClient(
    <table>
      <tbody>
        <tr>{cell}</tr>
      </tbody>
    </table>,
  );
}

describe("formatCellValue", () => {
  test("formats primitives, arrays and objects as before", () => {
    expect(formatCellValue(undefined)).toMatchObject({
      text: "—",
      isComplex: false,
    });
    expect(formatCellValue(true)).toMatchObject({
      text: "true",
      isComplex: false,
    });
    expect(formatCellValue(7)).toMatchObject({ text: "7", isComplex: false });
    expect(formatCellValue("hi")).toMatchObject({
      text: "hi",
      isComplex: false,
    });
    expect(formatCellValue([1, 2, 3])).toMatchObject({
      text: "[3]",
      isComplex: true,
    });
    expect(formatCellValue({ a: 1, b: 2, c: 3 })).toMatchObject({
      text: "{a, b…}",
      isComplex: true,
    });
  });

  test("view format issue marks a scalar cell as a ticket reference", () => {
    expect(formatCellValue("wm-701", "issue")).toMatchObject({
      text: "WM-701",
      kind: "ticket",
    });
  });

  test("view format issue never claims a complex value", () => {
    expect(formatCellValue({ id: "WM-701" }, "issue").kind).toBeNull();
    expect(formatCellValue(null, "issue").kind).toBeNull();
  });
});

describe("schema annotations", () => {
  test("reads a ticket annotation from the matching input-schema path", () => {
    const schema = {
      type: "object",
      properties: {
        ticket: { type: "string", "x-ui": { kind: "ticket" } },
      },
    };
    expect(readCellUi(schemaForCellPath(schema, "payload.ticket"))).toEqual({
      kind: "ticket",
    });
    expect(readCellUi(schemaForCellPath(schema, "spec.input.ticket"))).toEqual({
      kind: "ticket",
    });
  });
});

describe("CustomCell", () => {
  test("a view format=issue column links the whole cell to the ticket journey", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell
          row={{ payload: { ticket: "WM-701" } }}
          path="payload.ticket"
          format="issue"
        />,
      );
      const link = await waitFor(() => r.getByRole("link", { name: "WM-701" }));
      expect(link.getAttribute("href")).toBe("#/tickets/WM-701");
    });
  });

  test("a view format=issue column normalizes the id it links to", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell
          row={{ ticket: " clnt-526 " }}
          path="ticket"
          format="issue"
        />,
      );
      await waitFor(() =>
        expect(
          r.getByRole("link", { name: "CLNT-526" }).getAttribute("href"),
        ).toBe("#/tickets/CLNT-526"),
      );
    });
  });

  // The annotation is what the free-text scan cannot do: a column that says it
  // holds a ticket is believed even when the team is not one this factory runs.
  test("a view format=issue column links a team the free-text scan would skip", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell row={{ ticket: "FOO-12" }} path="ticket" format="issue" />,
      );
      await waitFor(() =>
        expect(
          r.getByRole("link", { name: "FOO-12" }).getAttribute("href"),
        ).toBe("#/tickets/FOO-12"),
      );
    });
  });

  test("the caller passes the view format, not a schema annotation", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell row={{ ticket: "FOO-12" }} path="ticket" format="issue" />,
      );
      await waitFor(() =>
        expect(
          r.getByRole("link", { name: "FOO-12" }).getAttribute("href"),
        ).toBe("#/tickets/FOO-12"),
      );
    });
  });

  test("a schema x-ui ticket column links a team the free-text scan skips", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell
          row={{ payload: { ticket: "FOO-12" } }}
          path="payload.ticket"
          schema={{
            type: "object",
            properties: {
              ticket: { type: "string", "x-ui": { kind: "ticket" } },
            },
          }}
        />,
      );
      await waitFor(() =>
        expect(
          r.getByRole("link", { name: "FOO-12" }).getAttribute("href"),
        ).toBe("#/tickets/FOO-12"),
      );
    });
  });

  test("the same value without a view format stays plain text", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell row={{ ticket: "FOO-12" }} path="ticket" />,
      );
      await waitFor(() => expect(r.container.textContent).toContain("FOO-12"));
      expect(r.queryByRole("link")).toBeNull();
    });
  });

  test("free-text cells linkify lowercase ids and leave the rest of the text intact", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell
          row={{ summary: "merged wm-642 after a UTF-8 fix" }}
          path="summary"
        />,
      );
      await waitFor(() =>
        expect(
          r.getByRole("link", { name: "wm-642" }).getAttribute("href"),
        ).toBe("#/tickets/WM-642"),
      );
      expect(r.container.textContent).toContain(
        "merged wm-642 after a UTF-8 fix",
      );
      expect(r.queryByRole("link", { name: /UTF-8/ })).toBeNull();
    });
  });

  test("a sha-like value is never mistaken for a ticket", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell row={{ digest: "SHA-256:6dbaab46a7f3" }} path="digest" />,
      );
      await waitFor(() => expect(r.container.textContent).toContain("SHA-256"));
      expect(r.queryByRole("link")).toBeNull();
    });
  });

  test("complex values keep their JSON preview badge and stay unlinked", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell
          row={{ refs: { ticket: "WM-701", pr: 499 } }}
          path="refs"
        />,
      );
      await waitFor(() =>
        expect(r.container.textContent).toContain("{ticket, pr}"),
      );
      expect(r.queryByRole("link")).toBeNull();
    });
  });

  test("a linkified id routes through the navigation handler when one is wired", async () => {
    const onNavigateTicket = mock(() => {});
    await withApi(reposApi(), async () => {
      const r = renderCell(
        <CustomCell
          row={{ ticket: "WM-701" }}
          path="ticket"
          format="issue"
          onNavigateTicket={onNavigateTicket}
        />,
      );
      const link = await waitFor(() => r.getByRole("link", { name: "WM-701" }));
      fireEvent.click(link);
      expect(onNavigateTicket).toHaveBeenCalledWith("WM-701");
    });
  });

  test("the cell still renders booleans, numbers and empties without a ticket lookup", async () => {
    await withApi(reposApi(), async () => {
      const r = renderCell(<CustomCell row={{ ok: false }} path="ok" />);
      expect(r.container.textContent).toContain("false");
      cleanup();
      const empty = renderCell(<CustomCell row={{}} path="missing" />);
      expect(empty.container.textContent).toContain("—");
    });
  });
});
