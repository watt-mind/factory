# Adopters

There is no telemetry. If you run Factory in production, or ship a product
that depends on it, add yourself here. The list is the public adoption
signal, together with GitHub Discussions.

Entries are added by pull request against `develop`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, commit style, and the CLA.

## Who belongs on this list

- **Organizations** running Factory against one or more product repositories
  (internal or public).
- **Open-source projects** whose maintainers use Factory to admit, verify,
  and merge work.

Do not list a confidential or unreleased use. If you cannot name the
organization or project in public, do not open a PR. A listing is a public
claim that you use Factory, not a private reference.

## Required fields

Every row must include:

| Field        | Meaning                                                                 |
| :----------- | :---------------------------------------------------------------------- |
| **Name**     | Organization or project name, as you want it shown                      |
| **Homepage** | Public URL (site, GitHub org, or canonical repository)                  |
| **Kind**     | `organization` or `open-source project`                                 |
| **Use**      | One sentence: what Factory does for you (wedge, pack, or control plane) |

Optional: a public pack or extension you ship, linked from [PACKS.md](PACKS.md).

Do not add logos, marketing copy, or more than one sentence of description.
Do not include personal contact details.

## How to add yourself

1. Fork the repository and branch from `develop`.
2. Add **one new row** to the table below. Keep the table sorted
   alphabetically by **Name** (ASCII, case-insensitive).
3. Use the template. Do not reformat other rows.
4. Open a pull request titled `docs(adopters): add <Name>`.
5. Sign the CLA when the check asks; see [CLA.md](CLA.md).

A listing PR should touch only this file. Reviewers check that the homepage
resolves, the kind is one of the two values above, and the use sentence is
specific (not "we use Factory").

### Row template

Copy this into the table, then fill the three cells:

```markdown
| [Name](https://example.com) | organization | One sentence about how you use Factory. |
```

The table's columns are **Name**, **Kind**, **Use**. Put the homepage on the
name, not in a fourth column.

## Adopters

| Name                                      | Kind         | Use                                                                              |
| :---------------------------------------- | :----------- | :------------------------------------------------------------------------------- |
| [Watt Mind](https://github.com/watt-mind) | organization | Runs Factory against this repository: tickets become isolated worktrees and PRs. |

If you are the first external adopter, replace nothing — insert your row so
the table stays alphabetical.
