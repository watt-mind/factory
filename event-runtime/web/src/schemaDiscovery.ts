/**
 * Row inspection and candidate field discovery for DisplayOptions (WM-214).
 * Inspects a sample of loaded rows to suggest candidate payload / input keys.
 */

export interface DiscoveredField {
  path: string;
  sampleValue: string;
  occurrenceCount: number;
}

const MAX_SCAN_ROWS = 60;
const MAX_SCAN_DEPTH = 3;

/**
 * Scan rows to auto-discover nested keys from payload, spec.input, labels, limits, etc.
 */
export function discoverPayloadFields<T>(rows: T[], activeCustomColumns: string[]): DiscoveredField[] {
  if (!rows?.length) return [];
  const sample = rows.slice(0, MAX_SCAN_ROWS);
  const counts = new Map<string, { count: number; sampleValue: string }>();
  const activeSet = new Set(activeCustomColumns.map((c) => c.replace(/^custom:/, "")));

  function walk(obj: unknown, prefix: string, depth: number) {
    if (depth > MAX_SCAN_DEPTH || obj == null) return;
    if (typeof obj !== "object" || Array.isArray(obj)) return;

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key.startsWith("_") || key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      const fullPath = prefix ? `${prefix}.${key}` : key;

      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value, fullPath, depth + 1);
      } else {
        if (!activeSet.has(fullPath) && !activeSet.has(key)) {
          const entry = counts.get(fullPath);
          let valStr = "";
          if (value === undefined || value === null) valStr = "—";
          else if (typeof value === "string") valStr = value;
          else if (typeof value === "number" || typeof value === "boolean") valStr = String(value);
          else if (Array.isArray(value)) valStr = `[${value.length}]`;
          else valStr = "{…}";

          if (entry) {
            entry.count += 1;
          } else {
            counts.set(fullPath, { count: 1, sampleValue: valStr });
          }
        }
      }
    }
  }

  for (const row of sample) {
    const r = row as any;
    if (r.envelope?.payload) walk(r.envelope.payload, "payload", 1);
    else if (r.envelope) walk(r.envelope, "envelope", 1);

    if (r.spec?.input) walk(r.spec.input, "spec.input", 1);
    if (r.result) walk(r.result, "result", 1);
    if (r.labels) walk(r.labels, "labels", 1);
    if (r.limits) walk(r.limits, "limits", 1);
  }

  return Array.from(counts.entries())
    .map(([path, data]) => ({
      path,
      sampleValue: data.sampleValue,
      occurrenceCount: data.count,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.path.localeCompare(b.path));
}
