# Factory core-tenet icon systems

Design two coherent SVG icon-system directions for the four Factory core tenets below. These will be reviewed in the existing Factory brand lab before any set is placed on the documentation homepage.

The icons are compact identity-supporting symbols, not explanatory diagrams. They sit beside prose that already explains the concept. Each must read immediately at 32–48 px and remain visually balanced at 160 px.

## Tenets

1. **One Ticket, One Worktree** — complete filesystem, database, and port isolation; parallel work is safe because Owned Paths are disjoint.
2. **Verification as a Gate** — an agent report is commentary; the test exit code is evidence; nothing merges on self-attestation.
3. **Pluggable Control Plane** — works with GitHub Issues and Linear; truth lives in git while tasks live in the tracker.
4. **Multi-Harness Architecture** — one Factory control plane drives several coding-agent harnesses.

## Existing visual language

The current recommended Factory mark is a pair of nested, self-similar chamfered apertures. A short teal segment is a load-bearing verification gate joining inner execution to the accepted exit.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420">
  <path d="M 384 242 V 90 H 160 V 258 L 232 330 H 480" fill="none" stroke="#dde4e1" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M 328 242 V 166 H 216 V 250 L 252 286 H 376" fill="none" stroke="#dde4e1" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M 384 242 V 322" fill="none" stroke="#4fdbc8" stroke-width="16" stroke-linecap="butt" />
</svg>
```

## Produce exactly two complete systems

### System A — Aperture family

Descend directly from the recommended mark: square/chamfered boundaries, nested apertures, short load-bearing teal gates, warm-white paths. Each icon must be distinct while visibly belonging to the same family.

### System B — Rail family

Use the same palette, stroke weight, radius, and restraint, but reduce the metaphor to paths, rails, lanes, and gates. This system should be slightly more literal and operational than System A, without becoming a generic icon pack.

For each system produce one SVG for each tenet, eight SVGs total. Suggested semantics—not mandatory literal drawings:

- Worktree isolation: two disjoint bounded regions or one admitted ticket creating its own boundary.
- Verification gate: one path crossing a short gate, with the rejected side visibly bounded and the accepted side continuing.
- Control plane: one stable control spine docking cleanly with two interchangeable tracker ports.
- Multi-harness: one control input fanning into three or four independent bounded lanes, with no connector ambiguity.

## Hard constraints

- Return exactly 8 complete standalone SVG strings and concise rationales, grouped into systems A and B.
- Filenames: `a-01-worktree.svg`, `a-02-verification.svg`, `a-03-control-plane.svg`, `a-04-multi-harness.svg`, then matching `b-*` names.
- Exact `viewBox="0 0 160 160"`; no width or height attributes.
- Transparent background.
- Palette only: warm white `#dde4e1`, teal `#4fdbc8`.
- Use a consistent 8px primary stroke across all eight icons; rounded joins/caps where appropriate.
- Coordinates, dimensions, and gaps must use a 4px grid.
- Maximum 5 visible geometry elements per icon, excluding `title` and `desc`.
- Each SVG needs `role="img"`, a unique `aria-labelledby`, and useful `title` and `desc`.
- No text, letters, digits, logos, labels, arrows, check marks, shields, puzzle pieces, gears, laptops, browser windows, gradients, filters, shadows, animation, raster data, or external resources.
- Avoid decorative dots and generic infinity signs.
- One teal semantic accent per icon; it must communicate isolation, verification, docking, or control—not decoration.
- The four icons in a system must share silhouette scale, optical weight, terminal treatment, and negative-space rhythm.
- Prefer deletion. These are symbols beside copy, so do not encode every clause of the prose.

Judge both systems as a family at 32 px, not as eight independent diagrams.
