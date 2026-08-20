/**
 * NIP-17 gift-wrapped DMs: unsigned kind-14 rumor → kind-13 seal → kind-1059 wrap.
 */
import {
  KIND_DM_RUMOR,
  KIND_GIFT_WRAP,
  KIND_SEAL,
  signEvent,
} from "./nostr.mjs";
import { conversationKey, encrypt } from "./nip44.mjs";
import { bytesToHex, randomBytes } from "./bytes.mjs";

function rumorJson({ pubkey, created_at, content, tags }) {
  return JSON.stringify({
    pubkey,
    created_at,
    kind: KIND_DM_RUMOR,
    tags,
    content,
  });
}

/**
 * Build a kind-1059 gift wrap addressed to `recipientHex` carrying `content`.
 * The wrap is signed by an ephemeral key; the rumor is authored by `secretHex`.
 */
export function giftWrapDm(
  secretHex,
  recipientHex,
  content,
  { createdAt } = {},
) {
  const created_at = createdAt ?? Math.floor(Date.now() / 1000);
  const senderPub = signEvent(
    { kind: KIND_DM_RUMOR, tags: [], content: "" },
    secretHex,
    { createdAt: created_at },
  ).pubkey;
  const rumor = rumorJson({
    pubkey: senderPub,
    created_at,
    content,
    tags: [["p", recipientHex]],
  });
  const seal = signEvent(
    {
      kind: KIND_SEAL,
      tags: [],
      content: encrypt(rumor, conversationKey(secretHex, recipientHex)),
    },
    secretHex,
    { createdAt: created_at },
  );
  const wrapSecret = bytesToHex(randomBytes(32));
  return signEvent(
    {
      kind: KIND_GIFT_WRAP,
      tags: [["p", recipientHex]],
      content: encrypt(
        JSON.stringify(seal),
        conversationKey(wrapSecret, recipientHex),
      ),
    },
    wrapSecret,
    { createdAt: created_at },
  );
}
