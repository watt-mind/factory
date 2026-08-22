# Factory mark — round four: synthesize the aperture

Continue the same Factory identity session. This is a final, narrow optical synthesis after rendering round three in the real dark brand harness at hero and 48 px sizes.

## Rendered findings

`09 Dynamic Aperture` has the best silhouette and motion. Its paired lower-left chamfers give the mark energy and distinguish it from a generic square spiral. However, the central circle reads as an arbitrary button/eyeball, and the multiple turns still lean toward a maze.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420">
  <circle cx="272" cy="210" r="16" fill="#dde4e1" />
  <path d="M 272 210 H 328 V 154 H 216 V 226 L 256 266 H 384 V 98 H 160 V 250 L 232 322 H 480" fill="none" stroke="#dde4e1" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M 352 322 H 416" fill="none" stroke="#4fdbc8" stroke-width="16" stroke-linecap="butt" />
</svg>
```

`11 Reduced Aperture` is the cleanest and most logo-like. Self-similarity communicates recursion more quickly than a spiral. But the two brackets feel disconnected, and the long teal tail reads as color coding rather than a load-bearing verification gate.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420">
  <path d="M 384 266 V 98 H 160 V 322 H 384" fill="none" stroke="#dde4e1" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M 384 322 H 480" fill="none" stroke="#4fdbc8" stroke-width="16" stroke-linecap="round" />
  <path d="M 332 226 V 150 H 212 V 270 H 348" fill="none" stroke="#dde4e1" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />
</svg>
```

## Produce exactly two final synthesis candidates

1. **12 Chamfered Recursion** — use nested self-similar apertures, each with a matching measured chamfer so the recursion and forward energy are both obvious. Remove the core dot. Make the inner aperture point or feed toward the outer aperture so they feel causally related, not like two unrelated brackets.
2. **13 Continuous Recursion** — attempt the same idea as one coherent path or one visually continuous system: inner bounded execution unfolds into the outer boundary and crosses a short teal verification gate before a warm-white accepted exit. The teal should be a gate/transition, not the whole tail.

The final accepted result will be selected between these two based on optical balance and 32–48 px legibility. Do not restart the metaphor search.

## Hard constraints

- Return exactly two complete standalone SVG strings plus a concise rationale for each.
- Exact `viewBox="0 0 640 420"`; no width or height attributes.
- Dark-ground palette only: warm white `#dde4e1`, teal `#4fdbc8`.
- Transparent background; no text, wordmark, gradient, filter, shadow, animation, raster, or external resource.
- Maximum 5 visible geometry elements per candidate, excluding accessible `title` and `desc`.
- Consistent visual stroke weight; rounded joins/caps where optically appropriate.
- Unique accessible `title` and `desc` IDs.
- Legible at 32–48 px and balanced at 640 × 420.
- Avoid dots, literal arrows, check marks, letterforms, padlocks, browser windows, infinity signs, gears, and circuit decoration.
- Avoid a maze. The nested/self-similar relationship and verified exit must register immediately.
- Keep the silhouette compact, calm, rigorous, and ownable.
