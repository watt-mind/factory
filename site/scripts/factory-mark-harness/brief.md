You are the visual-design collaborator for GitHub issue #896 in the
watt-mind/factory repository. The user explicitly asked for multiple improved
Factory logo-mark directions. Work directly in this checkout, but you are not
alone: preserve all existing edits and do not modify, revert, format, or delete
any existing file.

Read these sources before designing:

- site/design.md
- site/src/styles/tokens.css
- site/src/assets/factory-mark-dark.svg
- site/src/assets/factory-mark-light.svg

Create exactly four new, materially different, symbol-only SVG candidates:

- site/src/assets/factory-mark-candidates/01-precision-loop.svg
- site/src/assets/factory-mark-candidates/02-control-plane.svg
- site/src/assets/factory-mark-candidates/03-recursive-gate.svg
- site/src/assets/factory-mark-candidates/04-bounded-flow.svg

Design requirements:

- Communicate autonomous software delivery, bounded execution, verification,
  feedback, and durable evidence without illustrating all five literally.
- Do not merely polish the existing infinity mark. Explore distinct silhouettes
  and structural ideas; only candidate 01 should retain an infinity/continuous
  loop as its primary silhouette.
- Strong at 48px and distinctive at 200–320px.
- Transparent canvas, viewBox `0 0 640 420`, no embedded raster images, no
  external resources, no scripts, no text or wordmark.
- Use only flat geometry: paths, lines, polygons, circles, masks, or clip paths.
  No gradients, glow, shadows, blur, or decorative texture.
- Use Watt Mind colors only: surface `#0e1513`, light ink `#dde4e1`, dark ink
  `#0e1513`, primary `#4fdbc8`, primary-container `#14b8a6`.
- Each file should be the dark-background presentation: light ink plus teal.
  Do not draw a background rectangle.
- Prefer 10–18px main strokes, square or deliberately rounded caps—not a mix.
- Use at most three teal nodes/accents. Every accent must carry meaning.
- One clear over/under relationship at most. Avoid tangled intersections,
  excessive arrowheads, tiny circuit traces, symmetry-for-symmetry's sake, and
  generic recycling/DevOps clip-art.
- Use a 4px coordinate grid wherever practical.
- Include concise `<title>` and `<desc>` elements and meaningful IDs.
- Ensure valid XML and a complete 640×420 composition with comfortable margins.

Before finishing, inspect each SVG source for malformed paths, clipping risks,
and details likely to disappear at 48px. Make any fixes yourself. Do not create
comparison HTML, documentation, PNGs, or any other files. In your final response,
name each direction and give one sentence explaining its idea.
