/**
 * Hex / UTF-8 helpers used by the Nostr stack. Thin wrappers so the rest of
 * the extension does not import noble utils in every file.
 */
import { bytesToHex, hexToBytes } from "../vendor/curves/utils.js";
import { utf8ToBytes } from "../vendor/hashes/utils.js";

export { bytesToHex, hexToBytes, utf8ToBytes };

export function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase().replace(/^0x/, "");
  return isHex64(hex) ? hex : null;
}
