/**
 * Splicing the operating floor into a repo's AGENTS.md.
 *
 * Its own module, not part of build/emit.mjs, because emit.mjs writes the whole
 * generated tree the moment it is imported — so a test that wanted this function
 * regenerated plugins/ and dist/ as a side effect.
 *
 * Why AGENTS.md at all: the plugin reaches Claude Code only, and a cloud sandbox
 * without GitHub auth for a private repo gets nothing and fails closed without
 * knowing it. AGENTS.md travels with the checkout and every harness reads it, so
 * it is the only layer guaranteed to arrive.
 */
export const FLOOR_BEGIN = "<!-- FACTORY:FLOOR:BEGIN -->";
export const FLOOR_END = "<!-- FACTORY:FLOOR:END -->";

/**
 * Return `existing` with `floorBlock` spliced in between the markers.
 *
 * Marker-delimited rather than whole-file: a repo's AGENTS.md carries its own
 * hard-won rules ("NEVER prisma db push") that this must never clobber. Both
 * markers must be present and ordered before anything is replaced — a
 * half-written file gets an append, not a splice that would swallow everything
 * after the opening marker.
 */
export function spliceFloor(existing, floorBlock) {
  const body = existing ?? "";
  const i = body.indexOf(FLOOR_BEGIN);
  const j = body.indexOf(FLOOR_END);
  if (i !== -1 && j !== -1 && j > i) {
    return body.slice(0, i) + floorBlock.trim() + body.slice(j + FLOOR_END.length);
  }
  // Append rather than prepend: a human opening AGENTS.md should see the repo's
  // own orientation first, not 100 lines of boilerplate.
  const sep = body.trim() ? body.replace(/\s*$/, "") + "\n\n" : "";
  return sep + floorBlock.trim() + "\n";
}

/** True when the repo's AGENTS.md already carries exactly this floor. */
export const floorIsCurrent = (existing, floorBlock) =>
  Boolean(existing) && existing.includes(FLOOR_BEGIN) && spliceFloor(existing, floorBlock) === existing;
