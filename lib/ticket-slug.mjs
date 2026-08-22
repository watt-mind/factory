/**
 * Filesystem- and git-ref-safe name for a ticket id (#884).
 *
 * GitHub identifiers are `owner/repo#123`. Several subsystems use the ticket
 * id as a **path component** — the worktree directory, the worker-lease file,
 * the preservation report — and `/` nests a directory while `#` is awkward in
 * refs and shells. On the WM-1006 cutover that surfaced as:
 *
 *   ENOENT: .../worker-leases/factory-watt-mind/factory#863.json.<pid>.tmp
 *
 * after the claim had already landed, leaving a claimed ticket with no work.
 *
 * This MUST stay byte-identical to `ticket_slug()` in `bin/worktree-common.sh`
 * (#881): bash creates the worktree directory, JS looks it up. If the two
 * disagree the runtime searches a path that was never created, and the failure
 * reads as "worktree_up succeeded but produced nothing". `ticket-slug.test.mjs`
 * pins them together by invoking the bash function and comparing.
 *
 * Idempotent: `slug(slug(x)) === slug(x)`. Callers slugify defensively over
 * values that may already be slugs (a directory name from a prune loop), and a
 * non-idempotent version yields `gh-gh-123`.
 */

const TRACKER_KEY = /^[A-Z]+-\d+(-[A-Za-z0-9][A-Za-z0-9-]*)?$/;
const ALREADY_SLUG = /^gh-\d+$/;
const GITHUB_ID = /(?:^|#)(\d+)$/;

/**
 * @param {string} ticket `ABC-123`, `ABC-123-scratch`, `owner/repo#123`, `#123`
 * @returns {string} a name safe as a single path component and a git ref segment
 */
export function ticketSlug(ticket) {
  const id = String(ticket ?? "").trim();
  if (ALREADY_SLUG.test(id)) return id;
  if (TRACKER_KEY.test(id)) return id;
  const m = GITHUB_ID.exec(id);
  if (m) return `gh-${m[1]}`;
  throw new Error(
    `ticket must look like ABC-123 or owner/repo#123 (got ${JSON.stringify(ticket)})`,
  );
}

/** True when `ticketSlug` can name this id without throwing. */
export function isSluggableTicket(ticket) {
  try {
    ticketSlug(ticket);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONLY sanctioned way to put a ticket id into a path or filename.
 *
 * Five separate sites got this wrong one at a time (#881, #884, #887, #891),
 * each caught only when dispatch died on it in production. Every fix was
 * correct and every regex written to prevent the next one was too narrow:
 * a variable named `ticket` vs `t.identifier`, `[^)]*` that cannot cross a
 * nested call, and finally a template literal that no path-shaped pattern
 * matched at all.
 *
 * A helper is the mechanism a regex was standing in for. Build the whole
 * name here and the id can never reach a path un-slugged.
 *
 * @param {string} ticket
 * @param {{ prefix?: string, suffix?: string, ext?: string }} [parts]
 * @returns {string} a single path component, e.g. `factory-gh-862-2026...jsonl`
 */
export function ticketFileName(
  ticket,
  { prefix = "", suffix = "", ext = "" } = {},
) {
  const slug = ticketSlug(ticket);
  const name = [prefix, slug, suffix].filter(Boolean).join("-");
  return ext ? `${name}.${ext.replace(/^\./, "")}` : name;
}
