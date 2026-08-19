# Enterprise extension boundary

The `ee/` directory is the reserved seam for enterprise-only extensions to
Factory's Apache-licensed core. It documents an architectural and licensing
boundary; no enterprise implementation is present today.

## Boundary rules

- The core must remain useful, buildable, and testable without `ee/`.
- Core code must not import unpublished enterprise code or require private
  services, credentials, or artifacts to pass its standard checks.
- Shared contracts and extension points belong in the core. An enterprise
  implementation may depend on those contracts, not the reverse.
- A change that affects both sides should keep generic behavior in the core and
  isolate only enterprise-specific policy or integration in `ee/`.
- Do not use this directory to hide a generally useful bug fix or to duplicate
  the core as a long-lived fork.

All files currently in this repository, including this document, are licensed
under the repository's [Apache License 2.0](../LICENSE). If separately licensed
enterprise source is added in the future, its files must carry an explicit
license notice and the applicable terms must be documented here. The directory
name alone does not change a file's license.

Contributors should open an issue before proposing work for this boundary so
maintainers can confirm placement and licensing expectations.
