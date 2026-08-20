import { describe, expect, test } from "bun:test";
import { hexToBytes } from "../lib/bytes.mjs";
import {
  calcPaddedLen,
  conversationKey,
  decrypt,
  encrypt,
} from "../lib/nip44.mjs";
import { giftWrapDm } from "../lib/nip17.mjs";
import {
  KIND_GIFT_WRAP,
  pubkeyFromSecret,
  verifyEvent,
} from "../lib/nostr.mjs";

const SEC1 = "0".repeat(63) + "1";
const SEC2 = "0".repeat(63) + "2";
const PUB2 = pubkeyFromSecret(SEC2);
const CONV = "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d";
const PAYLOAD =
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";

describe("NIP-44 v2 vectors", () => {
  test("conversation key matches the published vector", () => {
    const key = conversationKey(SEC1, PUB2);
    expect(Buffer.from(key).toString("hex")).toBe(CONV);
  });

  test("encrypt of 'a' with nonce=1 matches the published payload", () => {
    const nonce = hexToBytes("0".repeat(63) + "1");
    const key = conversationKey(SEC1, PUB2);
    expect(encrypt("a", key, nonce)).toBe(PAYLOAD);
    expect(decrypt(PAYLOAD, key)).toBe("a");
  });

  test("calcPaddedLen buckets", () => {
    expect(calcPaddedLen(1)).toBe(32);
    expect(calcPaddedLen(32)).toBe(32);
    expect(calcPaddedLen(33)).toBe(64);
  });
});

describe("NIP-17 gift wrap", () => {
  test("produces a verifiable kind-1059 addressed to the recipient", () => {
    const wrap = giftWrapDm(SEC1, PUB2, "BLOCKED: something");
    expect(wrap.kind).toBe(KIND_GIFT_WRAP);
    expect(wrap.tags).toEqual([["p", PUB2]]);
    expect(verifyEvent(wrap)).toBe(true);
    expect(wrap.pubkey).not.toBe(pubkeyFromSecret(SEC1));
  });
});
