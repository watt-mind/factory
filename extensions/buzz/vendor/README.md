# Vendored crypto (MIT, Paul Miller / noble)

Copies of `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, and `@scure/base`
so the extension stays self-contained: CI runs `bun install` at the factory
root and never sees this directory's `package.json`. Curves' `@noble/hashes/*`
imports were rewritten to relative `../hashes/` paths.

Upstream versions are pinned in `../package.json`. Re-vendor by copying the
published `.js` files (not `src/`) and repeating the rewrite.
