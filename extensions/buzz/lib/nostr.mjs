/**
 * NIP-01 event signing, NIP-98 HTTP auth, NIP-OA auth-tag parse, bech32 nsec/npub.
 * Vectors: NIP-OA signed-event example + auth-tag test vector.
 */
import { schnorr } from "../vendor/curves/secp256k1.js";
import { sha256 } from "../vendor/hashes/sha2.js";
import { bech32 } from "../vendor/base/index.js";
import { bytesToHex, hexToBytes, normalizeHex, utf8ToBytes } from "./bytes.mjs";

export const KIND_TEXT = 1;
export const KIND_REACTION = 7;
export const KIND_CHAT = 9;
export const KIND_DM_RUMOR = 14;
export const KIND_SEAL = 13;
export const KIND_GIFT_WRAP = 1059;
export const KIND_HTTP_AUTH = 27235;
export const KIND_CHANNEL_METADATA = 39000;

const NSEC_HRP = "nsec";
const NPUB_HRP = "npub";

export function decodeNsec(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  const hex = normalizeHex(trimmed);
  if (hex) return hex;
  try {
    const { prefix, words } = bech32.decode(trimmed, 90);
    if (prefix !== NSEC_HRP) return null;
    const bytes = bech32.fromWords(words);
    if (bytes.length !== 32) return null;
    return bytesToHex(bytes);
  } catch {
    return null;
  }
}

export function encodeNpub(pubkeyHex) {
  const hex = normalizeHex(pubkeyHex);
  if (!hex) throw new Error("pubkey must be 64 hex chars");
  return bech32.encode(NPUB_HRP, bech32.toWords(hexToBytes(hex)), 90);
}

export function decodeNpub(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const hex = normalizeHex(trimmed);
  if (hex) return hex;
  try {
    const { prefix, words } = bech32.decode(trimmed, 90);
    if (prefix !== NPUB_HRP) return null;
    const bytes = bech32.fromWords(words);
    if (bytes.length !== 32) return null;
    return bytesToHex(bytes);
  } catch {
    return null;
  }
}

export function pubkeyFromSecret(secretHex) {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
}

export function serializeEvent(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export function eventId(event) {
  return bytesToHex(sha256(utf8ToBytes(serializeEvent(event))));
}

export function signEvent(partial, secretHex, { createdAt } = {}) {
  const secret = hexToBytes(secretHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const event = {
    pubkey,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    kind: partial.kind,
    tags: partial.tags ?? [],
    content: partial.content ?? "",
  };
  const id = eventId(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret));
  return { id, ...event, sig };
}

export function verifyEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.id !== eventId(event)) return false;
  try {
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    return false;
  }
}

/**
 * Parse a NIP-OA tag from JSON text or an already-parsed array.
 * Returns `{ tag, owner, conditions, sig, json }` or null.
 */
export function parseAuthTag(raw) {
  let tag = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    try {
      tag = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(tag) || tag.length !== 4) return null;
  if (tag[0] !== "auth") return null;
  const owner = normalizeHex(tag[1]);
  if (!owner) return null;
  if (typeof tag[2] !== "string") return null;
  if (typeof tag[3] !== "string" || !/^[0-9a-f]{128}$/i.test(tag[3]))
    return null;
  const normalized = ["auth", owner, tag[2], tag[3].toLowerCase()];
  return {
    tag: normalized,
    owner,
    conditions: tag[2],
    sig: normalized[3],
    json: JSON.stringify(normalized),
  };
}

/** SHA-256 of `nostr:agent-auth:<agent-pubkey>:<conditions>` (NIP-OA preimage). */
export function nipOaDigest(agentPubkey, conditions) {
  return sha256(utf8ToBytes(`nostr:agent-auth:${agentPubkey}:${conditions}`));
}

export function verifyAuthTag(parsed, agentPubkey) {
  if (!parsed) return false;
  const digest = nipOaDigest(agentPubkey, parsed.conditions);
  try {
    return schnorr.verify(
      hexToBytes(parsed.sig),
      digest,
      hexToBytes(parsed.owner),
    );
  } catch {
    return false;
  }
}

function sha256Hex(bytes) {
  return bytesToHex(sha256(bytes));
}

/**
 * NIP-98 Authorization header for one HTTP request. Includes `payload` when
 * a body is present, and a `nonce` so rapid retries are not replay-rejected.
 */
export function nip98Header(secretHex, { url, method, body, createdAt } = {}) {
  const tags = [
    ["u", url],
    ["method", method],
    ["nonce", crypto.randomUUID()],
  ];
  if (body !== undefined && body !== null) {
    const bytes =
      typeof body === "string" ? utf8ToBytes(body) : new Uint8Array(body);
    tags.push(["payload", sha256Hex(bytes)]);
  }
  const event = signEvent(
    { kind: KIND_HTTP_AUTH, tags, content: "" },
    secretHex,
    { createdAt },
  );
  const json = JSON.stringify(event);
  return `Nostr ${Buffer.from(json, "utf8").toString("base64")}`;
}

export function withAuthTag(tags, parsed) {
  if (!parsed) return tags ?? [];
  const next = [...(tags ?? [])];
  if (next.some((t) => Array.isArray(t) && t[0] === "auth")) return next;
  next.push(parsed.tag);
  return next;
}
