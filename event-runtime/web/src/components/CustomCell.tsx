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
 * Registry schemas from compatible producers can additionally use an `x-ui`
 * annotation to declare the same semantic intent for dynamic table columns.
 */
import { extractRowValue, parsePath } from "../pathExtractor";
import type { ArtifactFormat } from "../types";
import { TicketHoverCard, TicketText } from "./TicketHoverCard";

export interface CellFormat {
  text: string;
  isComplex: boolean;
  title?: string;
  /** `ticket` when the view format (or equivalent) says the whole cell is one issue id. */
  kind: string | null;
}

/** The optional presentation annotation attached to a JSON-schema property. */
export interface CellUi {
  kind?: string | null;
}

/**
 * Read an `x-ui` annotation defensively. Schemas arrive from the registry, so
 * an incomplete or third-party schema must leave the ordinary cell intact.
 */
export function readCellUi(schema: unknown): CellUi | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return null;
  const annotation = (schema as Record<string, unknown>)["x-ui"];
  if (
    !annotation ||
    typeof annotation !== "object" ||
    Array.isArray(annotation)
  )
    return null;
  const kind = (annotation as Record<string, unknown>).kind;
  return typeof kind === "string" && kind.length > 0 ? { kind } : null;
}

/**
 * Resolve the input-schema node for a dynamic table path. Dynamic columns may
 * name their value directly or retain the Events/Runs scope discovered by the
 * display picker (`payload.ticket`, `spec.input.ticket`, etc.).
 */
export function schemaForCellPath(schema: unknown, path: string): unknown {
  const parts = [...parsePath(path.replace(/^custom:/, ""))];
  if (parts[0] === "envelope" && parts[1] === "payload") parts.splice(0, 2);
  else if (parts[0] === "spec" && parts[1] === "input") parts.splice(0, 2);
  else if (parts[0] === "payload" || parts[0] === "input") parts.shift();

  let node = schema;
  for (const part of parts) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties) &&
      part in properties
    ) {
      node = (properties as Record<string, unknown>)[part];
    } else if (/^\d+$/.test(part) && record.items) {
      node = record.items;
    } else {
      return null;
    }
  }
  return node;
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
  schema,
  ui,
  onNavigateTicket,
}: {
  row: unknown;
  path: string;
  /** Closed `formats` value from the active view, when the caller has one. */
  format?: ArtifactFormat | null;
  /** Input schema for this row's agent, when the host has registry metadata. */
  schema?: unknown;
  /** Resolved schema UI annotation; takes precedence over a raw schema node. */
  ui?: CellUi | null;
  onNavigateTicket?: (ticketId: string) => void;
}) {
  const cleanPath = path.replace(/^custom:/, "");
  const value = extractRowValue(row, cleanPath);
  const schemaUi = ui ?? readCellUi(schemaForCellPath(schema, cleanPath));
  const { text, isComplex, title, kind } = formatCellValue(
    value,
    schemaUi?.kind === "ticket" ? "issue" : format,
  );

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
