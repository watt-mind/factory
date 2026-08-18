/** The single placeholder for an absent value in a table cell or key/value row. */
export const EMPTY = "—";

/** A semantic empty: the value does not apply to the adapter rather than being unknown. */
export const NOT_APPLICABLE = "n/a";

/** Compact whole-second durations, from seconds through days. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return EMPTY;

  let remaining = Math.max(0, Math.floor(seconds));
  const units = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const;
  const parts: string[] = [];

  for (const [size, suffix] of units) {
    const value = Math.floor(remaining / size);
    if (value > 0 || (size === 1 && parts.length === 0)) parts.push(`${value}${suffix}`);
    remaining %= size;
  }

  return parts.join(" ");
}

/** Binary byte units with the same one-decimal precision at every scaled size. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return EMPTY;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Compact relative time for timestamps in the past. */
export function formatRelative(
  timestamp: string | number | Date | null | undefined,
  now = Date.now(),
): string {
  if (timestamp == null) return EMPTY;
  const at = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (Number.isNaN(at)) return EMPTY;

  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
