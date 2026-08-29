## Optional presentation

For a human-facing terminal result, you may add a `presentation` beside
`artifact` using `factory.presentation/v1`.

- Lead with the one-sentence finding as a `heading`.
- Put every number, identifier, and verdict the reader should trust behind a
  `$ref` into `artifact`; literal prose is interpretation, not evidence.
- Use a toned `list` for the items that need attention.
- Put method and caveats in a collapsed `section`.
- Stay inside the contract bounds: at most 40 blocks and 16 KiB overall; do
  not nest sections.
- Do not restate the whole artifact. The schema-derived artifact view renders
  immediately below the presentation.
