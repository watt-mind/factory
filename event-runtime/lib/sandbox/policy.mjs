/**
 * Sandbox policy normalization (WM-185; RFC docs/eval-gondolin-sandbox.md §5, §6).
 *
 * A sandbox policy is the declarative half of the Gondolin integration: what
 * the guest may reach on the network, which secrets the host will substitute
 * on its behalf, and which host directories are visible inside the VM. It is
 * pure data with pure validation, so every rule here is unit-testable without
 * QEMU, a VM, or a network — the parts that need a hypervisor live in
 * gondolin.mjs and runner.mjs.
 *
 * Two rules are load-bearing and deliberately stricter than the upstream SDK:
 *
 * 1. **Omitting `allowedHosts` means deny-all, not allow-all.** The SDK treats
 *    an omitted allowlist as "allow everything" and only an explicit `[]` as
 *    deny-all. That default is backwards for a worker sandbox: a definition
 *    that forgets the key would get unrestricted egress, which is the exact
 *    thing this sandbox exists to prevent. Here, absent means empty means
 *    nothing gets out.
 *
 * 2. **A secret may only name hosts the allowlist already permits.** A secret
 *    scoped to a host that egress blocks can never be substituted, so the
 *    definition is stating something untrue about how the run will behave.
 *    That is a config bug worth failing on, not a no-op worth tolerating.
 *
 * Secret *values* never appear in a policy — a definition names the host
 * environment variable to read, and resolution happens at execution time via
 * `resolveSecretValues()`. That keeps agent definitions (which are content-
 * hashed, committed, and pinned in lib/registry.mjs) free of credentials by
 * construction.
 */

export const SUPPORTED_PROVIDERS = ["gondolin"];
export const DEFAULT_WORKSPACE_MOUNT = "/workspace";
export const DEFAULT_MEMORY = "1G";
export const DEFAULT_CPUS = 2;

export class SandboxPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SandboxPolicyError";
    this.code = "sandbox_policy_invalid";
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SandboxPolicyError(`${label} must be an object`);
  }
  return value;
}

function requireHostPattern(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SandboxPolicyError(`${label} must be a non-empty host pattern`);
  }
  if (value.includes("/") || value.includes(" ")) {
    throw new SandboxPolicyError(`${label} must be a bare host pattern ("api.github.com"), not a URL or path: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Guest mount points are absolute, normalized, and never traverse upward —
 * a mount at "/workspace/../etc" would quietly re-expose the guest root.
 */
function requireGuestPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new SandboxPolicyError(`${label} must be an absolute guest path`);
  }
  if (value.split("/").includes("..")) {
    throw new SandboxPolicyError(`${label} must not contain ".." segments: ${JSON.stringify(value)}`);
  }
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function requireHostPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new SandboxPolicyError(`${label} must be an absolute host path`);
  }
  return value;
}

/**
 * Normalize and validate a raw `sandbox` block from an agent definition or a
 * CLI invocation. Fails closed on anything ambiguous.
 *
 * @param {object} raw - the declared policy
 * @param {{ workspaceDir?: string }} [context] - host dir bound to the workspace mount
 * @returns {{
 *   provider: string,
 *   allowedHosts: string[],
 *   secrets: Array<{ name: string, envVar: string, hosts: string[] }>,
 *   mounts: Array<{ guestPath: string, hostPath: string, readonly: boolean }>,
 *   workspaceMount: string,
 *   memory: string,
 *   cpus: number,
 * }}
 */
export function normalizePolicy(raw, { workspaceDir } = {}) {
  const policy = requireObject(raw, "sandbox policy");

  if (!SUPPORTED_PROVIDERS.includes(policy.provider)) {
    throw new SandboxPolicyError(
      `unknown sandbox provider ${JSON.stringify(policy.provider ?? null)} — supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  // Absent allowlist = deny all. See rule 1 in the module header.
  const allowedHosts = [];
  if (policy.allowedHosts !== undefined) {
    if (!Array.isArray(policy.allowedHosts)) {
      throw new SandboxPolicyError("sandbox.allowedHosts must be an array of host patterns");
    }
    for (const [i, host] of policy.allowedHosts.entries()) {
      allowedHosts.push(requireHostPattern(host, `sandbox.allowedHosts[${i}]`));
    }
  }

  const secrets = [];
  if (policy.secrets !== undefined) {
    const declared = requireObject(policy.secrets, "sandbox.secrets");
    for (const [name, value] of Object.entries(declared)) {
      const entry = requireObject(value, `sandbox.secrets.${name}`);
      if (typeof entry.value === "string") {
        // A literal credential in a committed, content-hashed definition is
        // never what the author meant, and pinning it would publish it.
        throw new SandboxPolicyError(
          `sandbox.secrets.${name} must not carry a literal value — name the host env var via "env" instead`,
        );
      }
      if (!Array.isArray(entry.hosts) || entry.hosts.length === 0) {
        throw new SandboxPolicyError(`sandbox.secrets.${name}.hosts must be a non-empty array`);
      }
      const hosts = entry.hosts.map((h, i) => requireHostPattern(h, `sandbox.secrets.${name}.hosts[${i}]`));
      for (const host of hosts) {
        if (!allowedHosts.includes(host)) {
          // See rule 2 in the module header.
          throw new SandboxPolicyError(
            `sandbox.secrets.${name} is scoped to ${host}, which sandbox.allowedHosts does not permit — the secret could never be substituted`,
          );
        }
      }
      const envVar = entry.env ?? name;
      if (typeof envVar !== "string" || envVar.trim() === "") {
        throw new SandboxPolicyError(`sandbox.secrets.${name}.env must be a non-empty environment variable name`);
      }
      secrets.push({ name, envVar, hosts });
    }
  }

  const workspaceMount = requireGuestPath(policy.workspaceMount ?? DEFAULT_WORKSPACE_MOUNT, "sandbox.workspaceMount");

  const mounts = [];
  if (workspaceDir !== undefined) {
    mounts.push({
      guestPath: workspaceMount,
      hostPath: requireHostPath(workspaceDir, "workspace directory"),
      readonly: false,
    });
  }
  if (policy.mounts !== undefined) {
    const declared = requireObject(policy.mounts, "sandbox.mounts");
    for (const [guestPathRaw, value] of Object.entries(declared)) {
      const guestPath = requireGuestPath(guestPathRaw, `sandbox.mounts["${guestPathRaw}"]`);
      const spec = typeof value === "string" ? { path: value } : requireObject(value, `sandbox.mounts["${guestPathRaw}"]`);
      const hostPath = requireHostPath(spec.path, `sandbox.mounts["${guestPathRaw}"].path`);
      if (mounts.some((m) => m.guestPath === guestPath)) {
        throw new SandboxPolicyError(`sandbox.mounts["${guestPathRaw}"] collides with an existing mount at ${guestPath}`);
      }
      mounts.push({ guestPath, hostPath, readonly: spec.readonly === true });
    }
  }

  const cpus = policy.cpus ?? DEFAULT_CPUS;
  if (!Number.isInteger(cpus) || cpus < 1) {
    throw new SandboxPolicyError("sandbox.cpus must be a positive integer");
  }
  const memory = policy.memory ?? DEFAULT_MEMORY;
  if (typeof memory !== "string" || !/^\d+[KMGT]?$/.test(memory)) {
    throw new SandboxPolicyError(`sandbox.memory must be a qemu size string like "1G", got ${JSON.stringify(memory)}`);
  }

  return { provider: policy.provider, allowedHosts, secrets, mounts, workspaceMount, memory, cpus };
}

/**
 * Resolve declared secrets against the host environment at execution time.
 *
 * Fails closed on a missing variable rather than substituting an empty
 * string: an agent that silently authenticates as nobody produces a confusing
 * 401 deep inside the guest instead of a clear refusal on the host.
 *
 * @returns {Record<string, { hosts: string[], value: string }>} keyed by guest env var name
 */
export function resolveSecretValues(policy, env = process.env) {
  const resolved = {};
  for (const secret of policy.secrets) {
    const value = env[secret.envVar];
    if (typeof value !== "string" || value === "") {
      throw new SandboxPolicyError(
        `sandbox secret ${secret.name} reads host env var ${secret.envVar}, which is unset or empty`,
      );
    }
    resolved[secret.name] = { hosts: secret.hosts, value };
  }
  return resolved;
}
