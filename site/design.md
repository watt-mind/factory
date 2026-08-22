# Design — Factory documentation

A locked adaptation of the Watt Mind website design system for the Factory
documentation portal. The authoritative upstream reference is
`/Users/hdkiller/Develop/pets/wm/wm-home/docs/DESIGN_SYSTEM.md`.

## Genre

Modern-minimal, dark-first, technical, and restrained.

## Content-page system

- Keep Starlight's documentation information architecture and navigation.
- Use an asymmetric typographic marquee on the homepage: a large factual
  statement, compact supporting copy and actions, then one bounded execution
  rail. Do not repeat the brand mark as a floating hero illustration.
- Use a long-document rhythm: readable prose measure, quiet dividers, and dense
  reference surfaces.
- Keep prose and diagram surfaces clean. Do not use background grids: they
  compete with body text and create seams when diagrams are embedded.
- The homepage alone may use the subtle 40px grid as an identity surface behind
  its marketing content.

## Theme

- Surface: `#0e1513`
- Text: `#dde4e1`
- Muted text: `#bbcac6`
- Phosphor accent: `#4fdbc8`
- Borders and grid: `#3c4947`

Exact OKLCH conversions live in `src/styles/tokens.css`.

## Typography

- Display: Plus Jakarta Sans, 700–800, roman, tight tracking.
- Body: Inter, 400–600.
- Metadata and code: JetBrains Mono, 400–600.

## Spacing and components

- 4px base scale, 24px content gutters.
- Cards use translucent `surface-container`, a 12px blur, and a one-pixel
  `outline-variant` border.
- Interactive emphasis uses phosphor teal. Avoid decorative gradients outside
  restrained hero focus and diagram grid treatments.
- Motion is limited to transform and opacity, with reduced-motion support.

## Page consistency

All documentation routes share the same palette, typography, card voice, code
surface, table styling, and focus treatment. Individual pages vary through
content and diagrams, not through theme changes.
