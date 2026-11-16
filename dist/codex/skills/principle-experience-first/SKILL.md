---
name: principle-experience-first
description: "Apply on product, UX, typography, or copy work. Render actual pixels, run at least one cold visual self-polish pass over rough first drafts, and surface 1-4 bounded screenshots by default."
disable-model-invocation: true
---

# Experience First

Choose user clarity, legibility, and visual craft over implementation convenience — a working DOM is the starting line, not the finish line.

- **Render pixels, not just DOM:** Accessibility snapshots and component tests prove structure, not visual craft. On any UI-affecting change (including isolated styling, copy-in-layout, or admin views), render the live surface and inspect real pixels — plus target-language copy and accents (such as Hungarian diacritics and domain terminology).
- **Cold visual self-polish (≥1 pass):** Treat the first working layout as a rough draft. Critique hierarchy, spacing/padding rhythm, baseline alignment, contrast, truncation, touch targets, and empty/loading/error states coldly, then iterate **at least once** before verification so developer-default scaffolding never ships unpolished.
- **Show, don't pad — and surface visual proof by default:** Fewer clear, accurate controls beat crowded dashboards or noisy placeholders. Retain **1–4 bounded screenshots** (`≤ 1 MB` each, preferring mobile or element-scoped captures outside the repo; never `Read` captures back into context): embed/link 1–3 in interactive replies or walkthrough artifacts by default, and publish `ux-screenshot` artifacts + `## UX screenshots` links in autonomous PRs.

## Guardrails

- Never trade away tenant isolation, authentication/authorization checks, or data honesty (never fabricate live indicators or zero costs) for visual convenience.
- Never commit screenshot binaries into the repository or `Read` captured PNGs back into context.
