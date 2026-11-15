---
name: principle-proceed-with-gates
description: "Proceed autonomously on reversible local work and present the result; always stop and escalate on human, editorial, security, Never-auto-merge, or data-honesty gates."
disable-model-invocation: true
---

# Proceed With Gates

On reversible local work, proceed without asking unnecessary permission—resolve conventions from the codebase, finish the work, and report any reversible assumptions clearly.

## Hard Gates — Always Stop and Escalate

Never apply autonomous momentum across any of these boundaries:

- **Factory Floor gates:** `Never auto-merge` paths (auth/authz, payments/money, credentials/secrets, destructive DB migrations, production infra, `CLNT` security behavior), `escalate_paths`, protected branches (`develop`/`master`/`main`), and `Blocked` + `factory notify` holds.
- **Editorial & publishing gates:** Never promote drafts to published or publish external marketing/content without explicit human/editorial approval.
- **Data honesty & safety gates:** Never guess or fabricate missing pricing, legal citations, PII/customer data, or unverified claims—leave explicit `unknown`/gap markers and escalate when human verification is required.
