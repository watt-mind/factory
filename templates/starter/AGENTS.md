# Factory instance operating guide

This repository is a **Factory instance**. It owns local configuration,
policies, packs, and the work that adapts Factory to this organization. The
kernel is the pinned `@watt-mind/factory` dependency; do not copy or edit its
source here.

## Before changing this instance

1. Keep changes to local configuration, local packs, and instance docs in this
   repository.
2. Keep schedules disabled until an operator has reviewed the loop and its
   admission criteria.
3. Never put credentials in `config/`; inject secrets through the runtime
   environment instead.
4. When the change belongs in the reusable kernel, open a proposal or pull
   request against `watt-mind/factory` rather than carrying a local kernel fork.

Read [`README.md`](README.md) and the installed kernel's
[`docs/instances.md`](node_modules/@watt-mind/factory/docs/instances.md) before
enabling a loop or adding a pack.
