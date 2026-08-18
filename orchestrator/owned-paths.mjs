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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Extract the Owned Paths bullet list (levels 2-4) from a Linear issue description.
 * Returns [] when the section is missing or fails to parse — for dispatch,
 * use `effectiveOwnedPaths`, which turns that into "collides with
 * everything" rather than "not dispatchable".
 */
export function parseOwnedPaths(description = "") {
  const section = description.split(/^#{2,4}\s+/m).find((s) => {
    const heading = s.split("\n")[0];
    return /\bOwned Paths\b/i.test(heading);
  });
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

/**
 * Owned Paths for collision/dispatch purposes.
 *
 * A ticket whose Owned Paths section is missing or fails to parse used to be
 * permanently undispatchable — `parseOwnedPaths` returning [] read as "not
 * agent-ready" to every caller, so a ticket with a real spec but a parse miss
 * (an unusual format, a typo in the heading) sat in Todo forever, silently,
 * until stuck.mjs's "unparseable owned paths" report caught it. That's a
 * human-in-the-loop requirement for what should be a self-healing case.
 *
 * Empty now means "unknown scope", which collision-wise is the maximal glob:
 * the ticket is still dispatchable, but only when nothing else is in flight,
 * and nothing else can start while it's running. Same bias as globsOverlap —
 * a false "collides with everything" costs one serialized ticket; a false
 * "collides with nothing" risks two agents editing the same file.
 */
export function effectiveOwnedPaths(description = "") {
  const own = parseOwnedPaths(description);
  return own.length ? own : ["**"];
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
 * Every overlapping pair between two Owned Paths sets, for advisory evidence.
 * Same predicate as pathsCollide, but returns the pairs instead of a boolean so
 * a proposal can name what it overlaps with rather than just refusing.
 */
export function pathOverlaps(setA = [], setB = []) {
  const out = [];
  for (const a of setA) for (const b of setB) if (globsOverlap(a, b)) out.push({ a, b });
  return out;
}

/**
 * The narrow set of overlaps that still refuse dispatch under advisory mode
 * (WM-677): two claims that are the SAME concrete file, or a `**` claim on
 * either side. Everything else — shared directory prefixes, qualified globs,
 * wildcards that merely could reach the same file — is textual overlap that
 * git resolves at rebase far more often than not, so it is recorded on the
 * proposal and dispatch proceeds.
 */
export function hardPathConflicts(setA = [], setB = []) {
  const isConcrete = (g) => !/[*?{]/.test(g);
  const norm = (g) => String(g ?? "").trim().replace(/^\.\//, "").replace(/\/$/, "");
  return pathOverlaps(setA, setB).filter(({ a, b }) => {
    const na = norm(a);
    const nb = norm(b);
    if (na === "**" || nb === "**") return true;
    return isConcrete(na) && isConcrete(nb) && na === nb;
  });
}

function walkFiles(rootDir, baseDir = rootDir, out = []) {
  for (const dirent of readdirSync(rootDir, { withFileTypes: true })) {
    const nextPath = path.join(rootDir, dirent.name);
    const rel = path.relative(baseDir, nextPath).replace(/\\/g, "/");
    if (dirent.isDirectory()) {
      walkFiles(nextPath, baseDir, out);
      continue;
    }
    if (dirent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function matchingManifestPaths(repoPath, manifestGlobs = []) {
  if (!Array.isArray(manifestGlobs) || manifestGlobs.length === 0) return [];
  if (!existsSync(repoPath)) {
    throw new Error(`owned-path closure check failed: repo path does not exist: ${repoPath}`);
  }
  const files = walkFiles(repoPath);
  const matched = new Set();
  for (const pattern of manifestGlobs) {
    const matcher = globToRegExp(pattern);
    for (const file of files) {
      if (matcher.test(file)) matched.add(file);
    }
  }
  return [...matched].sort();
}

function parsePinnedPaths(manifestPath) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`owned-path closure check failed: cannot parse pin manifest ${manifestPath}: ${err.message}`);
  }
  const raw = payload?.pins;
  if (raw == null) return [];
  if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
    throw new Error(`owned-path closure check failed: pin manifest ${manifestPath} has invalid "pins" value`);
  }
  return Object.keys(raw)
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Gather every pin manifest and the paths it pins from a repo.
 *
 * Throws when a manifest can't be read or parsed; dispatch/state promotion is
 * fail-closed around those config or content errors.
 */
export function readPinManifestRequirements(repoPath, manifestGlobs = []) {
  const absoluteRepo = path.resolve(repoPath);
  const manifests = matchingManifestPaths(absoluteRepo, manifestGlobs);
  const out = [];

  for (const manifest of manifests) {
    const manifestPath = path.join(absoluteRepo, manifest);
    const pinnedPaths = parsePinnedPaths(manifestPath);
    out.push({ manifestPath: manifest, pinnedPaths });
  }

  return out;
}

/**
 * Pure closure check: do the declared Owned Paths satisfy local closure policy?
 *
 * A ticket can dispatch only if every required path is also owned, and every
 * manifest used by those paths is also owned.
 */
export function ownedPathsClosureGaps({
  ownedPaths = [],
  ownedPathsPolicy = { direct: [], pinManifests: [] },
  pinManifestRequirements = [],
} = {}) {
  const own = Array.isArray(ownedPaths) ? ownedPaths : [];
  const policy = {
    direct: Array.isArray(ownedPathsPolicy?.direct) ? ownedPathsPolicy.direct : [],
    pinManifests: Array.isArray(ownedPathsPolicy?.pinManifests) ? ownedPathsPolicy.pinManifests : [],
  };

  const gaps = [];
  const seen = new Set();

  const addGap = (gap) => {
    const key = `${gap.requiredPath}::${gap.rule}::${gap.requiredBy}::${gap.manifestPath ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    gaps.push(gap);
  };

  for (const rule of policy.direct) {
    if (!rule?.source || !Array.isArray(rule?.requires)) continue;
    if (!own.some((owned) => globsOverlap(owned, rule.source))) continue;
    for (const requiredPath of rule.requires) {
      if (!own.some((owned) => globsOverlap(owned, requiredPath))) {
        addGap({
          rule: "direct",
          requiredPath,
          requiredBy: rule.source,
        });
      }
    }
  }

  for (const manifestRequirement of pinManifestRequirements) {
    const pinnedPaths = Array.isArray(manifestRequirement?.pinnedPaths) ? manifestRequirement.pinnedPaths : [];
    const manifestPath = manifestRequirement?.manifestPath;
    if (!manifestPath || !Array.isArray(pinnedPaths)) continue;
    if (!pinnedPaths.some((pinnedPath) => own.some((owned) => globsOverlap(owned, pinnedPath)))) continue;
    if (!own.some((owned) => globsOverlap(owned, manifestPath))) {
      const requiredBy = pinnedPaths.find((pinnedPath) => own.some((owned) => globsOverlap(owned, pinnedPath)));
      addGap({
        rule: "pin-manifest",
        requiredPath: manifestPath,
        requiredBy: requiredBy ?? pinnedPaths[0],
        manifestPath,
      });
    }
  }

  return gaps;
}

/** Render closure gaps as operator-facing one-line hints. */
export function formatOwnedPathClosureGaps(gaps = []) {
  return gaps.map((gap) => {
    if (gap.rule === "direct") {
      return `Missing required Owned Paths entry: ${gap.requiredPath} (required by ${gap.requiredBy})`;
    }
    return `Missing required Owned Paths entry: ${gap.requiredPath} (required by ${gap.requiredBy} from ${gap.manifestPath})`;
  });
}

/**
 * Pick the next ticket that can start right now.
 *
 * `candidates` are queue-ordered (priority asc, createdAt asc); `inFlight` is
 * whatever is actually running at this instant — re-read at every claim, never
 * computed once per batch, because rolling dispatch changes it continuously.
 */
export function nextDispatchable(candidates, inFlight) {
  const scope = (t) => (t.ownedPaths?.length ? t.ownedPaths : ["**"]);
  const busy = inFlight.flatMap(scope);
  return candidates.find((t) => !pathsCollide(scope(t), busy));
}
