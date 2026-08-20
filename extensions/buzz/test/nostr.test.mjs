import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes } from "../lib/bytes.mjs";
import {
  KIND_HTTP_AUTH,
  decodeNsec,
  encodeNpub,
  eventId,
  nip98Header,
  parseAuthTag,
  pubkeyFromSecret,
  serializeEvent,
  signEvent,
  verifyAuthTag,
  verifyEvent,
} from "../lib/nostr.mjs";

const OWNER_SECRET = "0".repeat(63) + "1";
const AGENT_SECRET = "0".repeat(63) + "2";
const OWNER_PUB =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AGENT_PUB =
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const AUTH_SIG =
  "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";
const CONDITIONS = "kind=1&created_at<1713957000";

describe("NIP-OA / NIP-01 vectors (WM-905 selftest)", () => {
  test("agent and owner pubkeys match the NIP-OA vector", () => {
    expect(pubkeyFromSecret(OWNER_SECRET)).toBe(OWNER_PUB);
    expect(pubkeyFromSecret(AGENT_SECRET)).toBe(AGENT_PUB);
  });

  test("auth tag digest and signature verify", () => {
    const parsed = parseAuthTag(["auth", OWNER_PUB, CONDITIONS, AUTH_SIG]);
    expect(parsed.owner).toBe(OWNER_PUB);
    expect(verifyAuthTag(parsed, AGENT_PUB)).toBe(true);
  });

  test("signed-event example recomputes the published id and verifies sig", () => {
    const tags = [["auth", OWNER_PUB, CONDITIONS, AUTH_SIG]];
    const event = {
      pubkey: AGENT_PUB,
      created_at: 1713956400,
      kind: 1,
      tags,
      content: "owner-attested agent event",
      sig: "7fd38992b70b5e9e113644e51b4c8ee2227f3bdd402b1855f8786c0600394ab3ec2621742a7bad0b0000b93d4d1ae6e39525f286a3c1029f43f46c3359a6c76f",
    };
    event.id = eventId(event);
    expect(event.id).toBe(
      "d892a65e7677e0554ebb70ee16deeb6a0727dba46450fb4bc001291d7bff971b",
    );
    expect(verifyEvent(event)).toBe(true);
  });

  test("signEvent produces a verifiable event around the same payload", () => {
    const signed = signEvent(
      {
        kind: 1,
        tags: [["auth", OWNER_PUB, CONDITIONS, AUTH_SIG]],
        content: "owner-attested agent event",
      },
      AGENT_SECRET,
      { createdAt: 1713956400 },
    );
    expect(signed.pubkey).toBe(AGENT_PUB);
    expect(signed.id).toBe(
      "d892a65e7677e0554ebb70ee16deeb6a0727dba46450fb4bc001291d7bff971b",
    );
    expect(verifyEvent(signed)).toBe(true);
  });
});

describe("bech32 nsec / npub", () => {
  test("hex nsec round-trips and npub encodes the agent key", () => {
    expect(decodeNsec(AGENT_SECRET)).toBe(AGENT_SECRET);
    const npub = encodeNpub(AGENT_PUB);
    expect(npub.startsWith("npub1")).toBe(true);
  });
});

describe("NIP-98 header", () => {
  test("Authorization is Nostr <base64 kind-27235 event> with u/method/payload", () => {
    const body = JSON.stringify({ hello: "relay" });
    const header = nip98Header(AGENT_SECRET, {
      url: "https://watt-mind.communities.buzz.xyz/events",
      method: "POST",
      body,
    });
    expect(header.startsWith("Nostr ")).toBe(true);
    const json = Buffer.from(header.slice("Nostr ".length), "base64").toString(
      "utf8",
    );
    const event = JSON.parse(json);
    expect(event.kind).toBe(KIND_HTTP_AUTH);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ["u", "https://watt-mind.communities.buzz.xyz/events"],
        ["method", "POST"],
      ]),
    );
    expect(event.tags.some((t) => t[0] === "payload")).toBe(true);
    expect(event.tags.some((t) => t[0] === "nonce")).toBe(true);
    expect(verifyEvent(event)).toBe(true);
  });
});

describe("serializeEvent is NIP-01 array form", () => {
  test("no extra whitespace", () => {
    const event = {
      pubkey: AGENT_PUB,
      created_at: 1,
      kind: 9,
      tags: [["h", "abc"]],
      content: "hi",
    };
    expect(serializeEvent(event)).toBe(
      JSON.stringify([0, AGENT_PUB, 1, 9, [["h", "abc"]], "hi"]),
    );
    expect(bytesToHex(hexToBytes(AGENT_PUB))).toBe(AGENT_PUB);
  });
});
