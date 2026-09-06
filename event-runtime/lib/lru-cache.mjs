/** Create a small, bounded least-recently-used cache with optional TTL expiry. */
export function createLruCache({ limit, ttlMs } = {}) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new TypeError("limit must be a positive integer");
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs < 0))
    throw new TypeError("ttlMs must be a non-negative finite number");

  const entries = new Map();

  return {
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    get(key, nowMs = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (ttlMs !== undefined && nowMs - entry.timestamp >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, nowMs = Date.now()) {
      entries.delete(key);
      while (entries.size >= limit) entries.delete(entries.keys().next().value);
      entries.set(key, { value, timestamp: nowMs });
    },
  };
}
