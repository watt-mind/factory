/**
 * Canonical JSON sha256 — same algorithm as event-runtime/lib/canonical.mjs
 * so inbox.decide requestHash matches the runtime without importing it.
 */
import { createHash } from "node:crypto";

function sortValue(value, path) {
  if (value === undefined)
    throw new TypeError(`undefined at ${path} is not representable`);
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`non-finite number at ${path}`);
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((v, i) => sortValue(v, `${path}[${i}]`));
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    sorted[key] = sortValue(value[key], `${path}.${key}`);
  }
  return sorted;
}

export function hashJson(value) {
  const json = JSON.stringify(sortValue(value, "$"));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}
