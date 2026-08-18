/**
 * Reusable cell renderer for dynamic / custom payload columns (WM-214).
 * Extracts nested path values safely and formats primitives, code badges, and objects.
 */
import { extractRowValue } from "../pathExtractor";

export function formatCellValue(value: unknown): {
  text: string;
  isComplex: boolean;
  title?: string;
} {
  if (value === undefined || value === null)
    return { text: "—", isComplex: false };
  if (typeof value === "boolean")
    return { text: value ? "true" : "false", isComplex: false };
  if (typeof value === "number")
    return { text: String(value), isComplex: false };
  if (typeof value === "string") {
    return { text: value, isComplex: false, title: value };
  }
  if (Array.isArray(value)) {
    const preview = `[${value.length}]`;
    return {
      text: preview,
      isComplex: true,
      title: JSON.stringify(value, null, 2),
    };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    const preview = `{${keys.slice(0, 2).join(", ")}${keys.length > 2 ? "…" : ""}}`;
    return {
      text: preview,
      isComplex: true,
      title: JSON.stringify(value, null, 2),
    };
  }
  return { text: String(value), isComplex: false };
}

export function CustomCell({ row, path }: { row: unknown; path: string }) {
  const cleanPath = path.replace(/^custom:/, "");
  const value = extractRowValue(row, cleanPath);
  const { text, isComplex, title } = formatCellValue(value);

  const isMono =
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
      ) : (
        <span className={isMono ? "mono" : ""}>{text}</span>
      )}
    </td>
  );
}
