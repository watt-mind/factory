# factory documentation site

Static documentation website for [factory](https://github.com/watt-mind/factory), built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build).

## Development

Run from repository root:

```bash
bun run docs:dev    # starts local preview server at http://localhost:4321/factory/
bun run docs:build  # builds static output and Pagefind search index to site/dist/
```

Or from `site/`:

```bash
bun install
bun run dev
bun run build
```

## Structure

- `src/content/docs/` — Markdown & MDX content pages organized by track:
  - `getting-started/`
  - `concepts/`
  - `harnesses/`
  - `packs/`
  - `operator/`
  - `contributing/`
  - `reference/`
- `astro.config.mjs` — Starlight navigation, sidebar structure, and plugins.
