---
name: principle-proceed-with-gates
description: "Apply when choosing autonomous action vs. human approval: proceed on reversible work; stop on editorial, security, or Never-auto-merge gates."
disable-model-invocation: true
---

# Proceed With Gates

On reversible local work, proceed without asking unnecessary permission—resolve conventions from the codebase, finish the work, and report any reversible assumptions clearly.

## Hard Gates — Escalate or Stop

Never auto-merge or bypass human authorization across any of these boundaries:

- **Pre-push `Blocked` holds:** Stop, move to `Blocked` + `ai:blocked`, and notify (`factory notify`) on out-of-scope security entanglement, missing credentials/external access, inseparable `Owned Paths` gaps, genuine unrecorded product-intent forks, or missing human authorization in autonomous `dispatch@` gates.
- **In-scope escalation gates (`Never auto-merge` & `escalate_paths`):** For in-scope ticket changes touching auth/authz, payments/money, credentials/secrets, destructive DB migrations, production infra, `CLNT` security behavior, or protected deploy branches (`master`/`main`), implement, verify, and open an escalated PR (`ai:escalated` + `escalated` + `factory notify "ESCALATED ..."`) for human review without auto-merging.
- **Editorial & publishing gates:** Never promote drafts to published or publish external marketing/content without explicit human/editorial approval.
- **Data honesty & safety gates:** Never guess or fabricate missing pricing, legal citations, PII/customer data, or unverified claims—leave explicit `unknown`/gap markers and escalate when human verification is required.
