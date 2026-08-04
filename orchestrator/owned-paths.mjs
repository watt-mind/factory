/**
 * Owned Paths collision detection.
 *
 * Two tickets may run concurrently only when their `Owned Paths` glob sets are
 * disjoint. This replaces title-keyword matching, which both over- and
 * under-fires: "Fix login button copy" and "Rewrite auth middleware" share the
 * keyword "auth"-adjacent vocabulary while touching unrelated files, and
 * "Onboarding wizard polish" collides with "Profile page spacing" without
 * sharing a single word.
 *
 * `Owned Paths` is a mandatory section of every ai:agent-ready ticket
 * (linear.md §5), so the machine-readable answer already exists — parse it
 * rather than guessing from prose.
 *
 * Deliberately dependency-free: this runs from launchd with the system node and
 * must not require an install step to work.
 */

/**
 * Extract the `## Owned Paths` bullet list from a Linear issue description.
 * Returns [] when the section is missing — the caller decides what that means
 * (dispatch treats it as "not agent-ready", never as "collides with nothing").
 */
export function parseOwnedPaths(description = "") {
  const section = description.split(/^##\s+/m).find((s) => /^Owned Paths/i.test(s));
  if (!section) return [];

  // Real tickets write this section three different ways — bullet lists, fenced
  // code blocks, and indented code — often mixing them with prose ("Plus, only
  // if you add coverage below:"). Reading only bullets rejected a perfectly
  // good spec and made the ticket undispatchable, which looks like a triage
  // failure and isn't. Accept all three, then filter to things shaped like
  // paths.
  const out = [];
  let inFence = false;

  for (const raw of section.split("\n").slice(1)) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    const line = raw.trim();
    if (!line) continue;

    if (inFence) { out.push(line); continue; }
    if (/^[-*]\s+/.test(line)) { out.push(line.replace(/^[-*]\s*/, "")); continue; }
    if (/^ {4,}\S/.test(raw)) out.push(line);           // indented code block
  }

  return out
    .map((s) => s.replace(/`/g, "").replace(/[,;]$/, "").trim())
    // Tickets routinely annotate a path with its change kind — "(new)",
    // "(modified)", "(deleted)" — right after the backtick. Left in place that
    // annotation is prose, not part of the path, and used to sink the whole
    // line: `foo.ts (new)` has a space, so it read as prose and got dropped,
    // silently downgrading a perfectly good path to "no Owned Paths".
    .map((s) => s.replace(/\s*\([^()]*\)\s*$/, "").trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith("#"))
    // A path has no spaces and looks like a path: a separator, a wildcard, or an
    // extension. This drops the prose that legitimately appears in the section.
    .filter((s) => !/\s/.test(s) && (s.includes("/") || s.includes("*") || /\.[a-z0-9]+$/i.test(s)));
}

/** Escape regex metacharacters that are not glob syntax. */
function escapeLiteral(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob to a RegExp.
 *
 * Supports the subset that actually appears in Owned Paths: `**` (any depth,
 * including none), `*` (one segment), `?`, and `{a,b}` alternation. A trailing
 * `/` or a bare directory means "everything under it".
 */
export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, "");
  // A path with no glob metacharacters and no extension is treated as a prefix:
  // `app/services` owns everything beneath it. It also names a real, concrete
  // path in its own right (`Dockerfile`, `Makefile` — extensionless files are
  // common at repo root), so it must match itself too, not just descendants.
  // A path with an explicit trailing slash (`app/services/`) means "contents
  // only" and does not get this treatment.
  const matchSelf = !g.endsWith("/") && !/[*?{}]/.test(g) && !/\.[a-z0-9]+$/i.test(g);
  if (g.endsWith("/")) g += "**";
  else if (matchSelf) g += "/**";

  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` should also match zero segments, so `a/**/b.ts` matches `a/b.ts`.
        if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = g.indexOf("}", i);
      if (close === -1) { re += "\\{"; continue; }
      const alts = g.slice(i + 1, close).split(",").map((a) => escapeLiteral(a.trim()));
      re += `(?:${alts.join("|")})`;
      i = close;
    } else re += escapeLiteral(c);
  }
  // The "/**" appended above compiles to a trailing literal "/.*"; make the
  // "/" + anything optional so the bare path matches itself as well.
  if (matchSelf) re = re.replace(/\/\.\*$/, "(?:/.*)?");
  return new RegExp(`^${re}$`);
}

/**
 * Do two globs describe any common file?
 *
 * Exact intersection of two glob languages is more machinery than this needs,
 * so we approximate in the safe direction: reduce each glob to its literal
 * prefix (the part before the first wildcard) and treat prefix containment as
 * overlap, then confirm with direct matching. False positives cost a serialized
 * pair of tickets; false negatives cost two agents editing one file. Bias to
 * the former, always.
 */
export function globsOverlap(a, b) {
  if (a === b) return true;

  const ra = globToRegExp(a);
  const rb = globToRegExp(b);
  const isConcrete = (g) => !/[*?{]/.test(g);

  // At least one side names an actual path: decide by matching, which is exact.
  if (isConcrete(a) && isConcrete(b)) return ra.test(b) || rb.test(a);
  if (isConcrete(a)) return rb.test(a);
  if (isConcrete(b)) return ra.test(b);

  // Both wildcarded: compare literal directory prefixes. A prefix of "" means
  // the glob starts with a wildcard and can reach anywhere, so it overlaps
  // everything -- which is why this is computed only for wildcarded globs.
  // (Reducing a concrete root-level file like `AGENTS.md` to "" here would make
  // it collide with every ticket in the repo.)
  const literalPrefix = (g) => {
    const i = g.search(/[*?{]/);
    return (i === -1 ? g : g.slice(0, i)).replace(/[^/]*$/, "");
  };
  const la = literalPrefix(a);
  const lb = literalPrefix(b);
  return la.startsWith(lb) || lb.startsWith(la);
}

/** Do two tickets' Owned Paths sets intersect? */
export function pathsCollide(setA = [], setB = []) {
  return setA.some((a) => setB.some((b) => globsOverlap(a, b)));
}

/**
 * Pick the next ticket that can start right now.
 *
 * `candidates` are queue-ordered (priority asc, createdAt asc); `inFlight` is
 * whatever is actually running at this instant — re-read at every claim, never
 * computed once per batch, because rolling dispatch changes it continuously.
 */
export function nextDispatchable(candidates, inFlight) {
  const busy = inFlight.flatMap((t) => t.ownedPaths ?? []);
  return candidates.find((t) => {
    const own = t.ownedPaths ?? [];
    if (own.length === 0) return false; // no Owned Paths => not dispatchable
    return !pathsCollide(own, busy);
  });
}
