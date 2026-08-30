/** Plain-text renderer for `factory.presentation/v1` (design §3.4). */

const GLYPHS = {
  ok: "✓",
  warn: "!",
  error: "×",
  muted: "·",
  neutral: "•",
};

const sourceValue = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.hasOwn(value, "value") &&
  typeof value.ref === "string"
    ? value.value
    : value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.$ref === "string"
      ? value.$ref
      : value;

const text = (value) => {
  const resolved = sourceValue(value);
  if (resolved === undefined || resolved === null || resolved === "")
    return "—";
  if (typeof resolved === "string") return resolved;
  if (["number", "boolean"].includes(typeof resolved)) return String(resolved);
  return JSON.stringify(resolved);
};

const indent = (lines, spaces) => {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
};

function tableLines(block, width) {
  const rows = [block.columns, ...block.rows.map((row) => row.map(text))];
  const available = Math.max(8, width - (block.columns.length - 1) * 3);
  const maxCell = Math.max(4, Math.floor(available / block.columns.length));
  const widths = block.columns.map((_, column) =>
    Math.min(
      maxCell,
      Math.max(...rows.map((row) => String(row[column] ?? "").length)),
    ),
  );
  const wrap = (value, column) => {
    const raw = String(value ?? "");
    const limit = widths[column];
    if (!raw) return [""];
    const chunks = [];
    for (let start = 0; start < raw.length; start += limit) {
      chunks.push(raw.slice(start, start + limit));
    }
    return chunks;
  };
  const lines = (row) => {
    const cells = row.map(wrap);
    const height = Math.max(...cells.map((cell) => cell.length));
    return Array.from({ length: height }, (_, physicalRow) =>
      cells
        .map((cell, column) => (cell[physicalRow] ?? "").padEnd(widths[column]))
        .join(" | ")
        .trimEnd(),
    );
  };
  return [
    ...lines(block.columns),
    widths.map((n) => "-".repeat(n)).join("-+-"),
    ...block.rows.flatMap((row) => lines(row.map(text))),
  ];
}

function renderBlock(block, width) {
  switch (block.type) {
    case "heading":
      return [`# ${block.text}`];
    case "markdown":
      return String(block.text).split("\n");
    case "keyvalue":
      return block.items.map((item) => `${item.label}: ${text(item.value)}`);
    case "list":
      return [
        ...(block.label ? [block.label] : []),
        ...block.items.map(
          (item) => `${GLYPHS[item.tone ?? "neutral"]} ${item.text}`,
        ),
      ];
    case "table":
      return [
        ...(block.label ? [block.label] : []),
        ...tableLines(block, width),
      ];
    case "badge":
      return [`${GLYPHS[block.tone] ?? "•"} ${block.text}`];
    case "code":
      return String(block.text)
        .split("\n")
        .map((line) => `    ${line}`);
    case "section": {
      const children = block.blocks.flatMap((child, index) => [
        ...(index ? [""] : []),
        ...renderBlock(child, Math.max(20, width - 2)),
      ]);
      return [`${block.label}:`, ...indent(children, 2)];
    }
    case "links":
      return block.items.map((item) => {
        const key = ["issue", "pr", "run", "url"].find(
          (candidate) =>
            item[candidate] !== undefined && item[candidate] !== null,
        );
        const target = key ? text(item[key]) : "—";
        const label =
          typeof item.label === "string" && item.label.trim()
            ? item.label
            : target;
        return `${label} <${target}>`;
      });
    default:
      return [];
  }
}

/** Linearise a validated (optionally reference-resolved) presentation. */
export function renderText(presentation, { width = 80 } = {}) {
  const lineWidth = Number.isFinite(width)
    ? Math.max(20, Math.floor(width))
    : 80;
  if (!presentation || !Array.isArray(presentation.blocks)) return "";
  return presentation.blocks
    .flatMap((block, index) => [
      ...(index ? [""] : []),
      ...renderBlock(block, lineWidth),
    ])
    .join("\n");
}
