/**
 * Reusable cell renderer for dynamic / custom payload columns (WM-214).
 *
 * A column can declare what a value *means* with the active artifact-view
 * `formats` map (WM-897): `issue` says the whole cell is one ticket id, so
 * it renders as a hover-card link rather than as a string that happens to
 * look like one. Everything else is still scanned for embedded ids, because
 * the useful ticket reference is usually buried in a summary line, not in a
 * column anybody thought to annotate.
 *
 * The `x-ui` schema annotation (WM-701) is gone — `lib/schema.mjs` fails
 * closed on unknown keywords, so nothing could legally send it.
 */
import { extractRowValue } from "../pathExtractor";
import type { ArtifactFormat } from "../types";
import { TicketHoverCard, TicketText } from "./TicketHoverCard";

export interface CellFormat {
  text: string;
  isComplex: boolean;
  title?: string;
  /** `ticket` when the view format (or equivalent) says the whole cell is one issue id. */
  kind: string | null;
}

export function formatCellValue(
  value: unknown,
  format?: ArtifactFormat | null,
): CellFormat {
  if (value === undefined || value === null)
    return { text: "—", isComplex: false, kind: null };
  if (typeof value === "boolean")
    return { text: value ? "true" : "false", isComplex: false, kind: null };
  if (typeof value === "number")
    return { text: String(value), isComplex: false, kind: null };
  if (typeof value === "string") {
    // Only a scalar string can be the ticket the format promised; a column
    // annotated `issue` whose value arrived as an object is a payload bug,
    // and linking it would hide that.
    if (format === "issue")
      return {
        text: value.trim().toUpperCase(),
        isComplex: false,
        title: value,
        kind: "ticket",
      };
    return { text: value, isComplex: false, title: value, kind: null };
  }
  if (Array.isArray(value)) {
    return {
      text: `[${value.length}]`,
      isComplex: true,
      title: JSON.stringify(value, null, 2),
      kind: null,
    };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return {
      text: `{${keys.slice(0, 2).join(", ")}${keys.length > 2 ? "…" : ""}}`,
      isComplex: true,
      title: JSON.stringify(value, null, 2),
      kind: null,
    };
  }
  return { text: String(value), isComplex: false, kind: null };
}

export function CustomCell({
  row,
  path,
  format,
  onNavigateTicket,
}: {
  row: unknown;
  path: string;
  /** Closed `formats` value from the active view, when the caller has one. */
  format?: ArtifactFormat | null;
  onNavigateTicket?: (ticketId: string) => void;
}) {
  const cleanPath = path.replace(/^custom:/, "");
  const value = extractRowValue(row, cleanPath);
  const { text, isComplex, title, kind } = formatCellValue(value, format);

  const isMono =
    format === "sha" ||
    format === "repo" ||
    cleanPath.toLowerCase().includes("id") ||
    cleanPath.toLowerCase().includes("sha") ||
    cleanPath.toLowerCase().includes("hash") ||
    cleanPath.toLowerCase().includes("commit") ||
    cleanPath.toLowerCase().includes("branch") ||
    cleanPath.toLowerCase().includes("repo");

  return (
    <td
      className="max-w-44 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-dim)"
      title={title}
    >
      {isComplex ? (
        <span className="mono rounded bg-(--surface-2) px-1 py-0.5 text-xs text-(--text-faint)">
          {text}
        </span>
      ) : typeof value === "boolean" ? (
        <span className="mono text-[11px] text-(--text-faint)">{text}</span>
      ) : typeof value === "number" ? (
        <span className="mono tabular-nums">{text}</span>
      ) : kind === "ticket" ? (
        <TicketHoverCard ticketId={text} onNavigateTicket={onNavigateTicket} />
      ) : typeof value === "string" ? (
        <span className={isMono ? "mono" : ""}>
          <TicketText text={text} onNavigateTicket={onNavigateTicket} />
        </span>
      ) : (
        <span className={isMono ? "mono" : ""}>{text}</span>
      )}
    </td>
  );
}
