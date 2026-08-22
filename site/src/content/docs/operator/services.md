---
title: Service Management
description: Configuring launchd (macOS) and systemd (Linux) daemons
---

Factory provides production service definitions for unattended 24/7 operations.

## macOS (launchd)

Generate the operator-specific launch agents, then load the generated service files from `~/Library/LaunchAgents`:

```bash
bun deploy/gen.mjs
mkdir -p ~/Library/LaunchAgents
install -m 0644 deploy/launchd/com.wattmind.factory.event-serve.plist ~/Library/LaunchAgents/
install -m 0644 deploy/launchd/com.wattmind.factory.event-work.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.wattmind.factory.event-serve.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.wattmind.factory.event-work.plist
```

The generated files contain machine-specific paths. Review them before loading, and use `launchctl bootout` when replacing an already loaded definition.

## Linux (systemd)

The repository does not currently ship generated systemd units. On Linux, create equivalent `factory serve` and `factory events work` services with:

- the Factory checkout as `WorkingDirectory`;
- an explicit `PATH` containing Bun and `factory`;
- separate restart policies for API and worker processes; and
- operator-owned environment files with restrictive permissions.

Run `factory doctor` under the same service user before enabling the units.
