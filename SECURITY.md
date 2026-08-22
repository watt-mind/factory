# Security Policy

## Reporting a vulnerability

Do not open a public GitHub issue for a suspected vulnerability. Email
[laszlo@watt-mind.com](mailto:laszlo@watt-mind.com) with the subject
`[factory security] <short summary>`.

Include, where possible:

- the affected commit, version, component, and configuration;
- a minimal reproduction or proof of concept;
- the impact and the trust boundary that is crossed;
- whether the issue is already public; and
- a safe way to contact you for follow-up.

Do not include live credentials, personal data, or client data. Use synthetic
data and the least destructive reproduction possible. If encrypted disclosure
is necessary, ask for a current public key in an initial message.

We aim to acknowledge reports within three business days and provide an initial
assessment within seven business days. Remediation timing depends on severity
and operational risk. We will keep the reporter informed when those targets
cannot be met.

## Supported versions

Security fixes are made on the repository's active development branch and then
included in the next release. The kernel is published to npm as
[`@watt-mind/factory`](https://www.npmjs.com/package/@watt-mind/factory);
only the latest published version and the repository's active development
branch are supported. Older commits, older npm versions, and unmaintained
forks are not supported. If you are unsure whether a deployment is affected,
include its `@watt-mind/factory` version (or commit SHA, for a Git-checkout
deployment) in the report.

## Autonomous-agent threat model

Factory orchestrates coding agents and gives some processes access to source
trees, command execution, issue trackers, and source-control APIs. Treat model
output and all text an agent reads—including tickets, repository files, tool
output, and web content—as untrusted input. An agent's instruction or claim is
not authorization; authorization comes from the surrounding policy, scoped
credentials, approval gates, and independently observed checks.

Reports are particularly valuable when untrusted input can:

- execute commands or access files outside the declared worktree or owned
  paths;
- read, disclose, or persist credentials or data that the task did not require;
- cross one agent's, repository's, tenant's, or run's isolation boundary;
- bypass claim fencing, review, human-approval, or protected-operation gates;
- forge or tamper with run state, verification evidence, receipts, or audit
  history;
- inject shell arguments, paths, webhook data, artifacts, or dependency content
  in a way that crosses a privilege boundary; or
- escape an enabled sandbox or obtain capabilities not declared for the run.

The security boundary does **not** assume that an autonomous model is reliable,
truthful, prompt-injection resistant, or able to judge its own output. The
system must remain safe when the model is mistaken or adversarial. Reports that
only demonstrate poor suggestions, hallucinations, or policy-compliant actions
performed with credentials and approval explicitly granted to the operator are
normally product-quality issues rather than vulnerabilities. A model failure
that crosses one of the boundaries above is a security issue.

## CI runner and public contribution isolation

Workflows triggered by external pull requests from forks execute strictly in isolated, ephemeral GitHub-hosted environments (`ubuntu-latest`) with read-only repository permissions and withheld Actions secrets. Internal self-hosted runner infrastructure is reserved exclusively for trusted repository branches and maintainer workflows.

## Disclosure policy

Please allow us a reasonable opportunity to investigate and remediate before
publishing details. We prefer coordinated disclosure and will work with you on
a publication date, credit, and the level of technical detail. As a default,
we target disclosure within 90 days of a validated report, sooner when a fix is
available and users have had time to update, or later by mutual agreement when
disclosure would create disproportionate risk.

We ask researchers to act in good faith: avoid privacy violations, service
degradation, persistence, lateral movement, and access beyond what is necessary
to demonstrate the issue. We will not pursue action against good-faith research
that follows this policy.
