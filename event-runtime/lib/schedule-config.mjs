/** Schedule grammar shared by registry validation and runtime scheduling. */
export const CATCH_UP_MODES = ["none", "last", "all"];
export const APPROVAL_MODES = ["watched", "auto"];

/** "60m" / "30s" / "2h" / "1d" → seconds. Intervals only: no cron, no timezone. */
export function parseCadence(every) {
  const match = /^(\d+)([smhd])$/.exec(String(every ?? "").trim());
  if (!match)
    throw new Error(`unparseable cadence "${every}" — use 30s, 15m, 2h or 1d`);
  const value = Number(match[1]);
  if (value <= 0) throw new Error(`cadence "${every}" must be positive`);
  return value * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
}
