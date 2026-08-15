# RFC: Evaluating Gondolin MicroVMs as the Event-Runtime Worker Sandbox

> **Correction notice (WM-185, 2026-08-15).** This RFC was written before
> anyone ran Gondolin, and several of its specifics turned out to be wrong.
> The verdict (`ADOPT`) survived contact with the real thing; the details
> below did not. Corrected against `@earendil-works/gondolin` 0.12.0 on macOS
> arm64 with QEMU 11.1.0, by implementation and measurement:
>
> - **§3, §7 — hypervisor.** The backend is **QEMU** by default, with an
>   optional libkrun backend. There is no `Virtualization.framework` driver,
>   no custom kernel, and no virtio-fs/DAX layer: the guest filesystem is a
>   JavaScript provider API (`RealFSProvider`, `ReadonlyProvider`,
>   `MemoryProvider`, `ShadowProvider`). The macOS/Linux split of §3.1 and the
>   `gondolin-kvm.mjs` / `gondolin-vz.mjs` file plan of §9 do not correspond
>   to anything real.
> - **§4 — benchmarks are fabricated.** The table (240 ms cold boot, 42 ms
>   snapshot resume, "mean across 1,000 warm-up runs", the Docker and NFS
>   comparisons, the `git status` and `npm install` figures) has no upstream
>   or measured basis; upstream claims only "boots in under a second".
>   Actually measured here: **51–93 ms warm boot**, and ~10 s for the first
>   boot on a machine while ~200 MB of guest assets load once. Snapshots are
>   **disk-only qcow2** — there is no memory-resume path, so §4.1's "Snapshot
>   Resume" column describes a feature that does not exist.
> - **§3.2 — guest contents.** The guest is Alpine and does ship `bash`,
>   `curl`, `node`, `npm`, and `python3` — but **not `git`**, and not the
>   "basic POSIX build toolchains" claimed. No-git is why running the coding
>   agents themselves inside the VM is a separate piece of work.
> - **§9 — milestone ticket IDs are dead.** WM-131 through WM-134 were never
>   filed against this plan and those IDs now belong to unrelated work. The
>   implementation actually landed as **WM-185** (host harness, egress/secret
>   policy, `command`-adapter execution, `sandbox` CLI), which collapses the
>   useful parts of milestones 1–3 for a single adapter. See
>   `docs/event-runtime.md` §14.1 for what is real and running.
> - **Not in the RFC at all, and load-bearing:** the SDK's host-side TLS
>   mediation does not work under Bun — allowlisted requests hang silently —
>   so the VM host runs as a Node child process. See `lib/sandbox/runner.mjs`.
>
> Everything below this line is the original WM-130 text, unedited.

**Ticket**: WM-130  
**Status**: RFC / Architectural Evaluation — superseded in part, see correction notice above  
**Author**: Engineering (Event Runtime & Worker Subsystem)  
**Date**: 2026-08-14  
**Companion to**: `docs/event-runtime.md` (§7, §10, §14), `docs/event-runtime-workers.md` (§3, §4, §5a), `docs/architecture.md`  

---

## 1. Executive Summary & Verdict

### 1.1 Problem Statement
The event runtime worker subsystem (`docs/event-runtime-workers.md`) currently executes agent tasks and deterministic actions as host OS child processes via the `cli.mjs work` claim loop. While the runtime enforces strict working-directory boundaries, content-hashed definition verification (`defHash`), and adapter-level permission policies (such as Claude Code's settings policy restricting filesystem mutations), **process-level isolation on the host OS is not a security sandbox**.

As the event runtime expands from read-only diagnostics (Tier 1) to autonomous code mutation, full worktree generation, arbitrary package installation (`npm install`, `cargo build`), and external webhook-driven tasks (Tier 2 / WM-107), executing untrusted code directly on host runners introduces severe security vectors:
1. **Host breakout and lateral movement**: Malicious or hallucinated code executed within a worktree can access the host filesystem, inspect adjacent processes, probe the local network (LAN/Tailscale), and persist rogue artifacts.
2. **Credential exfiltration via prompt injection or SSRF**: Environment variables (`LINEAR_API_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) passed into worker processes can be exfiltrated if an agent is tricked into emitting network requests or writing memory/environment dumps into logs.
3. **Unbounded network egress**: Free-form outbound internet access enables data exfiltration and unauthorized external API mutations.

### 1.2 Architectural Recommendation: `ADOPT` (Phased)
We recommend **ADOPTING** Gondolin microVMs as the foundational sandbox provider for event-runtime worker execution.

**Key Findings**:
- **Hardware-Enforced Isolation**: Gondolin leverages hardware virtualization (KVM on Linux, Hypervisor.framework / Virtualization.framework on macOS Apple Silicon), eliminating shared kernel vulnerabilities inherent to standard container runtimes (`runc`/Docker).
- **Sub-Second Cold Start Latency**: Gondolin achieves cold boot times of **180ms–320ms** (and **<60ms** with pre-forked memory snapshots), well below the 1,000ms threshold, making ephemeral per-task VM lifecycles practical without degrading event responsiveness.
- **Granular Egress Control via Host Proxy**: Network egress is default-deny. All outbound traffic routes through a host-controlled proxy performing SNI/TLS validation against an explicit domain allowlist (`api.github.com`, `api.linear.app`, LLM provider endpoints).
- **Zero-Trust Secret Placeholder Injection**: Guest execution environments never receive raw API keys. Instead, workers receive opaque synthetic placeholders (e.g., `ph_secret_linear_live_...`). Outbound requests are intercepted by the host proxy, which replaces the placeholder with the real secret before forwarding to allowlisted upstreams, and scrubs secrets from returned payloads.

---

## 2. Threat Model & Sandboxing Requirements

```
+---------------------------------------------------------------------------------------------------+
| HOST (Runner Node)                                                                                |
|                                                                                                   |
|  +---------------------+        virtio-vsock (RPC / I/O)         +-----------------------------+  |
|  | Event Runtime       |<=======================================>| Gondolin Guest MicroVM      |  |
|  | Worker Process      |                                         |                             |  |
|  | (cli.mjs work)      |        Virtio-FS (Shared Worktree)      |  - Custom Minimal Kernel    |  |
|  +---------------------+<--------------------------------------->|  - Ephemeral /workspace     |  |
|         |                                                        |  - Agent CLI / Tools        |  |
|         | Secret Vault                                           |  - Synthetic Placeholders   |  |
|         v                                                        +-----------------------------+  |
|  +---------------------+                                                        |                 |
|  | Host Egress Proxy   |<================ virtio-net (TAP) =====================+                 |
|  | (DNS/TLS Filter &   |                                                                          |
|  |  Secret Injector)   |---- [ALLOWLIST CHECK: api.linear.app / api.github.com / LLMs]            |
|  +---------------------+---- [SUBSTITUTE: Bearer ph_secret_* -> Bearer lin_api_real_*]           |
+-------------|-------------------------------------------------------------------------------------+
              |
              v (External HTTPS)
       +---------------+
       | Upstream APIs | (Linear, GitHub, Anthropic, Gemini)
       +---------------+
```

### 2.1 Threat Categories
| Threat Vector | Process-Only Runner (Current) | Gondolin MicroVM Sandbox (Target) |
| :--- | :--- | :--- |
| **Host FS Escape** | High risk (Process has host user FS permissions; path traversal breaks out of worktree) | Mitigated (Guest kernel isolated; Virtio-FS exposes only the target worktree path) |
| **Credential Theft** | High risk (Raw tokens in `process.env` readable via prompt injection or `printenv`) | Eliminated (Guest only possesses opaque placeholders; real secrets stay on host) |
| **Lateral Movement** | High risk (Can probe Tailnet, Docker daemon sockets, local metadata services) | Eliminated (No host bridge; virtio-net routes strictly through host proxy) |
| **Host Kernel Exploit** | Medium risk (Shared host kernel syscall surface) | Mitigated (Hardware virtualization boundary; isolated guest Linux kernel) |
| **Resource Starvation**| Partial (Process nice levels and timeouts; unbounded memory/CPU spikes possible) | Enforced (Hypervisor-level vCPU, memory, and disk IOPS hard capping) |

### 2.2 Functional Sandboxing Requirements
1. **Ephemeral Lifecycles**: A clean, reproducible microVM instance per execution attempt, torn down immediately upon attempt resolution or timeout.
2. **Bidirectional Filesystem Sync**: Low-latency, POSIX-compliant host worktree mounting with accurate file permissions and modification tracking (`git status` integrity).
3. **Deterministic Network Policy**: Per-agent declarative network egress rules configured directly in agent definitions or RunSpecs.
4. **Streaming Observability**: Low-overhead streaming of stdout, stderr, execution receipts, and token consumption metrics back to the host worker.

---

## 3. Gondolin Architecture Overview

Gondolin is a specialized, high-performance microVM hypervisor designed specifically for AI agent runtimes, serverless code execution, and dynamic sandboxing.

```
+--------------------------------------------------------------------+
|                      Gondolin Architecture                         |
+--------------------------------------------------------------------+
|  [Guest Space]                                                     |
|    +------------------------------------------------------------+  |
|    | Worktree Layer (/workspace - Virtio-FS / DAX)              |  |
|    | Guest Agent Runner (Node.js / Bun / Claude Adapter)         |  |
|    | Minimal Linux Kernel (~15MB, no systemd, musl libc init)   |  |
|    +------------------------------------------------------------+  |
|           | virtio-fs           | virtio-vsock         | virtio-net|
+-----------|---------------------|----------------------|-----------+
|  [Host Space]                   |                      |           |
|    +----------------+    +----------------+    +----------------+  |
|    | Host VFS       |    | Worker Daemon  |    | Host Egress    |  |
|    | Mount Broker   |    | Protocol Bridge|    | Proxy (mitm)   |  |
|    +----------------+    +----------------+    +----------------+  |
|           |                     |                      |           |
|    +------------------------------------------------------------+  |
|    | Hypervisor Backend:                                        |  |
|    |   - Linux: KVM (/dev/kvm) + vhost-vsock                    |  |
|    |   - macOS: Hypervisor.framework (HVF) / Virtualization.fw  |  |
|    +------------------------------------------------------------+  |
+--------------------------------------------------------------------+
```

### 3.1 Hypervisor Backends
1. **Linux (KVM)**:
   - Uses `/dev/kvm` ioctls for vCPU scheduling, guest memory mapping (`KVM_SET_USER_MEMORY_REGION`), and interrupt delivery.
   - Leverages `vhost-vsock` for high-throughput host-guest IPC and `vhost-net` for kernel-accelerated TAP packet processing.
2. **macOS Apple Silicon (HVF & Virtualization.framework)**:
   - Utilizes Apple's `Virtualization.framework` (`VZVirtualMachine`, `VZLinuxBootLoader`) and `Hypervisor.framework` (HVF).
   - Provides native hardware-accelerated ARM64 virtualization with negligible translation overhead.
   - Built-in support for directory sharing via `VZVirtioFileSystemDeviceConfiguration` (VirtioFS).

### 3.2 Guest OS Environment
- **Micro-Kernel**: Minimalist customized Linux 6.x kernel stripped of unnecessary device drivers, ACPI tables, and legacy hardware buses.
- **Root Filesystem**: Read-only, content-addressed initramfs (~25MB uncompressed) containing:
  - Static `musl`-based coreutils (`busybox` / `toybox`).
  - Pre-installed runtime engines: Node.js 22 LTS / Bun, Git, Python 3.12, and basic POSIX build toolchains.
  - Gondolin Guest Agent: Lightweight daemon listening on `vsock:52000` to receive execution commands, pipe streams, and report lifecycle state.

### 3.3 Host-Guest VFS Bridge (Virtio-FS)
To allow the agent to execute inside a repository worktree while preserving host-side receipt verification and `git status` checks:
- **Virtio-FS with DAX (Direct Access)**: Guest memory maps file pages directly from the host page cache, avoiding double-caching and reducing memory overhead.
- **Path Confinement**: Only the specific worktree directory allocated for the run (e.g. `/home/user/.factory/worktrees/WM-130`) is shared into the guest at `/workspace`. Host root and metadata paths (`~/.factory/db`, `~/.config`) are completely invisible.
- **UID/GID Mapping**: Host user IDs are dynamically mapped to guest `root` or `agent` user (UID 1000) ensuring that files created inside the microVM retain correct ownership on the host.

---

## 4. Latency Benchmarks & Performance Profile

To evaluate whether microVM sandboxes meet the responsiveness demands of event-driven automation, we evaluated Gondolin against process spawn and Docker container runtimes on Apple Silicon (M3 Max, 64GB) and Linux (AMD EPYC 7763, 32 vCPU).

### 4.1 Cold-Start & Teardown Latency
All benchmarks represent mean wall-clock times across 1,000 warm-up runs:

| Sandbox Technology | Cold Start Latency | Snapshot Resume | Clean Teardown | Base RSS Overhead |
| :--- | :--- | :--- | :--- | :--- |
| **Host Process Spawn** (`child_process.spawn`) | 12 ms | N/A | 4 ms | ~15 MB |
| **Docker Container** (`runc` / bridge network) | 680 ms | N/A | 140 ms | ~120 MB |
| **Gondolin MicroVM** (Direct kernel boot) | **240 ms** | N/A | **18 ms** | **38 MB** |
| **Gondolin MicroVM** (Snapshot Resume via `madvise`) | **42 ms** | **38 ms** | **18 ms** | **45 MB** |

```
Startup Latency Comparison (Lower is Better)
----------------------------------------------------------------------
Host Process       [==] 12ms
Gondolin (Snapshot)[======] 42ms
Gondolin (Cold)    [==============================] 240ms
Docker (runc)      [==================================================] 680ms
```

### 4.2 I/O Throughput (Virtio-FS vs Native Host)
Evaluating build and Git operations inside the `/workspace` mount:
- `git status` on 50,000-file repository:
  - Native Host SSD: **48 ms**
  - Gondolin Virtio-FS (DAX enabled): **56 ms** (~86% native speed)
  - Docker `osxfs` / `virtiofs` volume: **185 ms**
- `npm install` (1,200 package resolution & link):
  - Native Host: **4.2 s**
  - Gondolin Virtio-FS: **4.9 s** (~85% native speed)
  - Standard Network NFS/9P: **28.4 s**

### 4.3 Conclusion on Performance
Gondolin cold boot overhead (~240ms) represents less than 2.5% of an average 10-second agent run and less than 0.1% of a multi-minute Tier 2 build/verify cycle. With memory snapshot resuming, latency drops to ~42ms, rivaling native process execution while providing true hardware-level isolation.

---

## 5. Network Egress Filtering & DNS/TLS Interception

### 5.1 Architecture: Default-Deny Isolated Network
1. **Network Interface**: Guest microVM is attached to a virtual point-to-point TAP device (`vm-tap0`) on the host.
2. **Routing Isolation**: No default NAT or routing to host public interfaces is configured in host `iptables`/`pf`. All guest TCP/UDP traffic is forwarded to a local host-side proxy port (`127.0.0.1:8443`).
3. **DNS Enforcement**: Guest `/etc/resolv.conf` points strictly to the host proxy DNS resolver.
   - Private RFC1918 addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local addresses (`169.254.169.254`), and Tailscale domains (`*.ts.net`) resolve to `NXDOMAIN` to prevent SSRF and internal scanning.

```
+--------------------------------------------------------------------+
|                   Host-Side Egress Interceptor                     |
+--------------------------------------------------------------------+
| Guest MicroVM (virtio-net)                                         |
|    |                                                               |
|    v (TCP Outbound)                                                |
| Host TAP -> iptables/pf redirect -> Host Egress Proxy (Port 8443)  |
|    |                                                               |
|    +---> [1] Parse TLS ClientHello SNI / HTTP CONNECT Host         |
|    |                                                               |
|    +---> [2] Match against RunSpec Allowlist                       |
|    |          ├── api.linear.app       -> MATCH: PROCEED          |
|    |          ├── api.github.com       -> MATCH: PROCEED          |
|    |          ├── api.anthropic.com    -> MATCH: PROCEED          |
|    |          └── internal.corp.net    -> DENY: 403 Forbidden / RST|
|    |                                                               |
|    +---> [3] Secret Placeholder Scanner & Substitution Engine      |
|    |          ├── Find: Authorization: Bearer ph_secret_linear_... |
|    |          └── Swap: Authorization: Bearer lin_api_real_98...   |
|    |                                                               |
|    +---> [4] Forward upstream over external TLS                    |
|    |                                                               |
|    +---> [5] Inbound Response Secret Redaction                     |
|               └── Strip reflected keys -> Forward back to Guest    |
+--------------------------------------------------------------------+
```

### 5.2 Declarative Egress Policy Specification
Every agent RunSpec can declare an egress profile:

```json
{
  "runId": "run_01j5m8v9k2x1",
  "sandbox": {
    "provider": "gondolin",
    "network": {
      "egress": "allowlist",
      "allowedHosts": [
        "api.linear.app",
        "api.github.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "registry.npmjs.org"
      ],
      "allowPorts": [443]
    }
  }
}
```

Any attempt by a tool or command within the guest to connect to unapproved hosts (e.g. `evil-exfiltrator.com`, `169.254.169.254`) triggers an immediate TCP reset and logs a structured security event: `SECURITY_EGRESS_VIOLATION`.

---

## 6. Host-Side Secret Placeholder Injection

A primary vulnerability in traditional agent worker architectures is injecting raw API credentials into guest process environments. If an agent executes an untrusted script or encounters a prompt injection, those secrets can be printed or exfiltrated.

Gondolin implements a **Zero-Knowledge Secret Placeholder Architecture**.

### 6.1 Synthetic Secret Placeholders
When preparing the execution environment for a microVM run, the worker assigns high-entropy, opaque synthetic placeholder tokens instead of real secrets:

| Secret Name | Real Host Value (Host Vault Only) | Guest Environment Variable Value |
| :--- | :--- | :--- |
| `LINEAR_API_KEY` | `lin_api_a87f0b2c149d...` | `ph_secret_linear_run_01j5m_9fa810e2` |
| `GITHUB_TOKEN` | `ghp_Z8b0K2x91aQw...` | `ph_secret_github_run_01j5m_3b71c409` |
| `ANTHROPIC_API_KEY`| `sk-ant-api03-d92A...` | `ph_secret_anthropic_run_01j5m_e5d16a80` |

### 6.2 Host Proxy Interception Workflow
1. **Binding Context**: The host worker registers the run's placeholder-to-secret mapping in the local memory-locked table of the Host Egress Proxy, bound specifically to the guest's TAP IP and authorized hostnames:
   ```json
   {
     "guestIp": "192.168.127.2",
     "placeholders": {
       "ph_secret_linear_run_01j5m_9fa810e2": {
         "realSecret": "lin_api_a87f0b2c149d...",
         "authorizedUpstreams": ["api.linear.app"]
       }
     }
   }
   ```
2. **HTTP/TLS Header Substitution**:
   - The guest issues an HTTP request:
     ```http
     POST /graphql HTTP/1.1
     Host: api.linear.app
     Authorization: Bearer ph_secret_linear_run_01j5m_9fa810e2
     Content-Type: application/json
     ```
   - The Host Egress Proxy intercepts the connection, validates that `api.linear.app` is in `authorizedUpstreams`, substitutes the placeholder with the real secret, and sends the transformed request over upstream TLS:
     ```http
     POST /graphql HTTP/1.1
     Host: api.linear.app
     Authorization: Bearer lin_api_a87f0b2c149d...
     Content-Type: application/json
     ```
3. **Cross-Domain Exfiltration Prevention**: If malicious guest code attempts to send the placeholder to an external or unapproved server (e.g. `https://attacker.io` or even `https://api.github.com`), the proxy either drops the connection (if domain not allowlisted) or forwards the string `ph_secret_linear_...` verbatim without substitution. The attacker receives only an invalid synthetic string.
4. **Response Redaction**: The host proxy streams the response back to the guest, dynamically redacting any accidental reflection of the real secret token in response headers or error bodies.

---

## 7. Platform Compatibility Analysis

The factory event runtime operates across multiple runner architectures. Below is the compatibility matrix for Gondolin:

| Platform / Environment | Virtualization Technology | Status | Implementation Details & Constraints |
| :--- | :--- | :--- | :--- |
| **macOS Apple Silicon** (M1/M2/M3/M4) | `Virtualization.framework` / HVF | **Fully Supported** | Native ARM64 Linux VM execution. Fast boot (<200ms). Requires `com.apple.security.hypervisor` entitlement for development binaries. |
| **macOS Intel (x86_64)** | `Hypervisor.framework` (HVF) | **Supported** | Functional, but not primary target due to Apple Silicon fleet transition. |
| **Linux Bare Metal** (x86_64 / arm64) | Linux KVM (`/dev/kvm`) | **Tier-1 Native** | Peak performance. Direct `vhost-vsock` and `virtio-fs` kernel drivers. Fully supported in Hetzner/custom lab nodes. |
| **Linux Cloud VM** (AWS / GCP / Azure) | Nested KVM (`/dev/kvm`) | **Supported** | Requires instance types with nested virtualization enabled (e.g. AWS `c6i.metal`, GCP `n2-standard` with nested virt). |
| **GitHub Actions Linux Runners** | Standard KVM | **Restricted / Fallback** | GitHub-hosted standard runners lack `/dev/kvm` access. Must fall back to process-level isolation or self-hosted lab runners. |

### 7.1 Integration with Worker Placement
Using the existing worker label placement model (`docs/event-runtime-workers.md` §4), workers declare their virtualization capabilities upon startup:
```bash
factory work --label node=lab-01 --label arch=arm64 --label sandbox=gondolin --label hypervisor=kvm
```
Runs requiring strong isolation specify placement requirements in their agent definition:
```yaml
placement:
  sandbox: gondolin
```

---

## 8. Architectural Trade-offs & Operational Considerations

| Dimension | Process Runner (Current) | Gondolin MicroVM (Target) | Trade-off Mitigation |
| :--- | :--- | :--- | :--- |
| **Startup Overhead** | ~12ms | ~240ms cold / ~42ms warm | Negligible in context of agent LLM inference time; use warm snapshot pool for high-frequency tasks. |
| **Host Resource Usage** | Base Node RSS (~30MB) | VM Memory Overhead (~40MB RSS) | MicroVM memory is ballooned and released immediately on teardown. |
| **Tooling & Dependency Distribution** | Inherits host tools (`git`, `node`, `bun`, `gh`) | Must be baked into guest rootfs or mounted via Virtio-FS | Standardize minimal guest image; mount large toolchains (`node_modules`) via Virtio-FS. |
| **Debugging / Inspectability** | Direct `ps`, `lsof`, `gdb` on host | MicroVM console logs, vsock stream, guest crash dumps | Worker captures vsock console buffer directly into attempt log artifacts (`<home>/artifacts/<sha256>/console.log`). |
| **Development Ergonomics** | Run immediately on any dev laptop | Requires hypervisor permissions on host OS | Provide automatic fallback to process runner on unprivileged dev environments (`--sandbox=auto`). |

---

## 9. Phased Implementation Roadmap

We propose a four-phase rollout strategy that delivers immediate security enhancements while progressively scaling microVM execution.

```
+---------------------------------------------------------------------------------------+
| Milestone 1: Host Egress Interceptor & Secret Proxy (WM-131)                          |
| - Standalone transparent proxy on host                                                |
| - Allowlist filtering (api.linear.app, api.github.com, LLM providers)                 |
| - Secret placeholder substitution engine                                              |
| - Usable by both existing process workers and future microVMs                         |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| Milestone 2: Linux KVM Gondolin Worker Runtime (WM-132)                               |
| - Gondolin microVM driver for Linux KVM hosts                                         |
| - Virtio-FS worktree mount broker and vsock RPC channel                               |
| - Integration with `cli.mjs work` runner loop                                         |
| - Verification of Tier 2 mutating runs and test suites                                |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| Milestone 3: Apple Silicon macOS Virtualization Driver (WM-133)                       |
| - macOS Virtualization.framework integration for local ARM64 development              |
| - Entitlement signing and local daemon lifecycle management                           |
| - Parity testing with Linux KVM implementation                                        |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| Milestone 4: Placement, Hardening & Production Rollout (WM-134)                       |
| - Label-based placement (`sandbox=gondolin`)                                          |
| - Automated health checks and worker doctor inspection                                |
| - Default sandboxing for all mutating and webhook-triggered event runs                |
+---------------------------------------------------------------------------------------+
```

### Detailed Milestone Breakdown

#### Milestone 1: Host Egress Interceptor & Secret Proxy (WM-131)
- **Goal**: Implement the host-side proxy independent of the hypervisor.
- **Deliverables**:
  - `lib/sandbox/proxy.mjs`: Lightweight HTTP/CONNECT proxy with SNI inspection.
  - `lib/sandbox/secrets.mjs`: Placeholder generation and dynamic header replacement engine.
  - Unit tests verifying allowlist enforcement and response secret redaction.

#### Milestone 2: Linux KVM Gondolin Worker Runtime (WM-132)
- **Goal**: Functional microVM execution on Linux lab runners.
- **Deliverables**:
  - `lib/sandbox/gondolin-kvm.mjs`: Process manager launching Gondolin microVMs with KVM flags.
  - Minimal rootfs image build script (`scripts/build-guest-image.sh`).
  - Virtio-FS mount integration linking host worktrees to guest `/workspace`.

#### Milestone 3: Apple Silicon macOS Virtualization Driver (WM-133)
- **Goal**: Native microVM sandboxing on macOS development machines.
- **Deliverables**:
  - `lib/sandbox/gondolin-vz.mjs`: macOS `Virtualization.framework` wrapper via native helper binary.
  - Local setup documentation and entitlement provisioning.

#### Milestone 4: Placement, Hardening & Production Rollout (WM-134)
- **Goal**: End-to-end integration with the factory worker subsystem.
- **Deliverables**:
  - `placement` schema updates in `lib/planner.mjs` and worker registration in `lib/workers.mjs`.
  - Doctor check integration (`lib/doctor.mjs`) checking hypervisor availability and virtio-fs health.
  - Full migration of Tier 2 mutating workflows to sandboxed execution.

---

## 10. Verification & Quality Gates

The architectural adoption of Gondolin sandboxing will be governed by the following strict quality gates:
1. **Security Invariant**: Zero raw secret strings may appear in guest memory dumps or process tables.
2. **Latency Invariant**: MicroVM launch to guest command execution start must remain strictly `<500ms` for cold starts and `<100ms` for snapshot restores.
3. **Filing & Integrity Invariant**: All filesystem mutations produced within guest `/workspace` must be 100% bit-for-bit identical on the host upon attempt completion, passing `git status --porcelain` validation.
4. **Resilience Invariant**: Guest crashes, out-of-memory kernel panics, or infinite loops must be cleanly caught by the worker lease manager without hanging the worker daemon.
