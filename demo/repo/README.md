# factory-demo-repo

Bundled starter project for `factory demo`. It is not a published package.

The committed tree is intentionally incomplete: ticket `DEMO-1` (see
`tickets/DEMO-1.md`) asks the factory to add `greet(name)`. The quickstart
runs that ticket against a temp copy using the in-memory control plane — no
Linear, GitHub, or model credentials.

```bash
bin/factory demo --dry    # plan only
bin/factory demo          # claim → implement → verify → PR → merge
```
