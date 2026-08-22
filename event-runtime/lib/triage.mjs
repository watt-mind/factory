/**
 * Trusted-author and body-hash-pin gate primitives (WM: GH-879).
 *
 * Pure, tracker-agnostic helpers shared by the github control plane (which
 * fetches/stamps the facts) and the dispatch admission gate in planner.mjs
 * (which refuses on them). Kept dependency-free besides canonical.mjs so
 * either side can import it without a cycle.
 */
import { hashJson } from "./canonical.mjs";

/**
 * GitHub's `authorAssociation` values the factory treats as trusted enough
 * to have their issue content run as dispatch instructions (Verification
 * Command, Owned Paths). Every other value — including a legitimate
 * CONTRIBUTOR/NONE/FIRST_TIME_CONTRIBUTOR from a stranger, and an
 * unfetchable/unknown association — fails closed.
 */
export const TRUSTED_ASSOCIATIONS = Object.freeze([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export function isTrustedAssociation(association) {
  return (
    typeof association === "string" &&
    TRUSTED_ASSOCIATIONS.includes(association)
  );
}

const READY_PIN_PREFIX = "factory:ready-pin";
const READY_PIN_RE = /<!--\s*factory:ready-pin\s+(sha256:[0-9a-f]{64})\s*-->/;

/**
 * The structured marker stamped as an issue comment when `ai:agent-ready`
 * is applied (WM-879 gate 2). It pins the current description hash — reusing
 * the same `hashJson` convention as `evidenceTicket().descriptionHash` — so
 * dispatch admission can recompute the hash from the live body and refuse on
 * mismatch. A comment, not a body footer: the footer would have to be
 * stripped back out before hashing, and a comment can't self-poison the hash
 * it pins.
 */
export function readyPinMarker(description) {
  return `<!-- ${READY_PIN_PREFIX} ${hashJson(description ?? "")} -->`;
}

/** Extract the pinned hash from a comment body, or null if it is not a pin. */
export function parseReadyPin(commentBody) {
  const m = READY_PIN_RE.exec(String(commentBody ?? ""));
  return m ? m[1] : null;
}
