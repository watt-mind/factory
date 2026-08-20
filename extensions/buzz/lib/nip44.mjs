/**
 * NIP-44 v2 payload encryption (secp256k1 ECDH, HKDF, ChaCha20, HMAC-SHA256).
 * Conversation-key + encrypt vectors from NIP-44.
 */
import { secp256k1 } from "../vendor/curves/secp256k1.js";
import { chacha20 } from "../vendor/ciphers/chacha.js";
import { expand, extract } from "../vendor/hashes/hkdf.js";
import { hmac } from "../vendor/hashes/hmac.js";
import { sha256 } from "../vendor/hashes/sha2.js";
import {
  concatBytes,
  hexToBytes,
  normalizeHex,
  randomBytes,
  utf8ToBytes,
} from "./bytes.mjs";

const SALT = utf8ToBytes("nip44-v2");

function compressedPubkey(pubkeyHex) {
  const hex = normalizeHex(pubkeyHex);
  if (!hex) throw new Error("pubkey must be 64 hex chars");
  return concatBytes(new Uint8Array([0x02]), hexToBytes(hex));
}

export function conversationKey(secretHex, peerPubkeyHex) {
  const shared = secp256k1.getSharedSecret(
    hexToBytes(secretHex),
    compressedPubkey(peerPubkeyHex),
    true,
  );
  const sharedX = shared.length === 33 ? shared.slice(1) : shared.slice(-32);
  return extract(sha256, sharedX, SALT);
}

function messageKeys(conversation, nonce) {
  if (conversation.length !== 32) throw new Error("invalid conversation_key");
  if (nonce.length !== 32) throw new Error("invalid nonce");
  const keys = expand(sha256, conversation, nonce, 76);
  return {
    chachaKey: keys.slice(0, 32),
    chachaNonce: keys.slice(32, 44),
    hmacKey: keys.slice(44, 76),
  };
}

export function calcPaddedLen(unpaddedLen) {
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

function pad(plaintext) {
  const unpadded = utf8ToBytes(plaintext);
  const unpaddedLen = unpadded.length;
  if (unpaddedLen < 1 || unpaddedLen > 0xffffffff)
    throw new Error("invalid plaintext length");
  let prefix;
  if (unpaddedLen >= 65536) {
    prefix = new Uint8Array(6);
    const view = new DataView(prefix.buffer);
    view.setUint32(2, unpaddedLen);
  } else {
    prefix = new Uint8Array(2);
    new DataView(prefix.buffer).setUint16(0, unpaddedLen);
  }
  const paddedLen = calcPaddedLen(unpaddedLen);
  const out = new Uint8Array(prefix.length + paddedLen);
  out.set(prefix, 0);
  out.set(unpadded, prefix.length);
  return out;
}

function hmacAad(key, message, aad) {
  if (aad.length !== 32)
    throw new Error("AAD associated data must be 32 bytes");
  return hmac(sha256, key, concatBytes(aad, message));
}

export function encrypt(plaintext, conversation, nonce = randomBytes(32)) {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce);
  const padded = pad(plaintext);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  const payload = concatBytes(new Uint8Array([2]), nonce, ciphertext, mac);
  return Buffer.from(payload).toString("base64");
}

export function decrypt(payload, conversation) {
  if (typeof payload !== "string" || payload.length === 0)
    throw new Error("unknown version");
  if (payload[0] === "#") throw new Error("unknown version");
  if (payload.length < 132) throw new Error("invalid payload size");
  const data = Uint8Array.from(Buffer.from(payload, "base64"));
  if (data.length < 99) throw new Error("invalid data size");
  if (data[0] !== 2) throw new Error(`unknown version ${data[0]}`);
  const nonce = data.slice(1, 33);
  const ciphertext = data.slice(33, data.length - 32);
  const mac = data.slice(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce);
  const calculated = hmacAad(hmacKey, ciphertext, nonce);
  if (calculated.length !== mac.length || !timingSafeEqual(calculated, mac))
    throw new Error("invalid MAC");
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  return unpad(padded);
}

function unpad(padded) {
  if (padded.length < 2) throw new Error("invalid padding");
  const view = new DataView(
    padded.buffer,
    padded.byteOffset,
    padded.byteLength,
  );
  const firstTwo = view.getUint16(0);
  let unpaddedLen;
  let prefixLen;
  if (firstTwo === 0) {
    unpaddedLen = view.getUint32(2);
    if (unpaddedLen < 65536) throw new Error("invalid padding");
    prefixLen = 6;
  } else {
    unpaddedLen = firstTwo;
    prefixLen = 2;
  }
  const unpadded = padded.slice(prefixLen, prefixLen + unpaddedLen);
  if (
    unpaddedLen === 0 ||
    unpadded.length !== unpaddedLen ||
    padded.length !== prefixLen + calcPaddedLen(unpaddedLen)
  ) {
    throw new Error("invalid padding");
  }
  return new TextDecoder().decode(unpadded);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
