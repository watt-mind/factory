import { FACTORY_ROOT } from "../config.mjs";

export const BASE_INHERITED_ENV = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
];

export const RUNTIME_IDENTITY_ENV = [
  "FACTORY_EVENT_HOME",
  "FACTORY_EVENT_PORT",
  "FACTORY_EVENT_SECRET",
  "FACTORY_EVENT_ENV",
];

// These are assigned from a dispatch RunSpec by the worker, rather than
// inherited from the worker process. Keep the list explicit so adapters do
// not accidentally strip the identity the dispatch prompt needs for its PR
// handoff.
export const DISPATCH_IDENTITY_ENV = [
  "FACTORY_RUN_ID",
  "FACTORY_TICKET",
  "FACTORY_REPO",
];

export const PUSH_CREDENTIAL_ENV = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

export const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  // Nested-session markers, not keys; all adapters strip them to avoid inheriting Claude Code's interactive context.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
];

/**
 * Build an adapter child environment from the worker allowlist.
 *
 * Only an explicit boolean mutating value grants push credentials. Adapters
 * express their intentional differences through the options rather than
 * maintaining copies of this authority boundary.
 */
export function safeChildEnvironment(
  env = {},
  defOrOpts = {},
  {
    factoryRoot = FACTORY_ROOT,
    inheritRuntimeIdentity = false,
    extraStrip = [],
    stripPrefixes = [],
  } = {},
) {
  const isMutating =
    typeof defOrOpts === "boolean" ? defOrOpts : defOrOpts?.mutating === true;
  const inherited = [
    ...BASE_INHERITED_ENV,
    ...(inheritRuntimeIdentity ? RUNTIME_IDENTITY_ENV : []),
    ...(isMutating ? PUSH_CREDENTIAL_ENV : []),
  ];
  const childEnv = Object.fromEntries(
    inherited.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );

  Object.assign(childEnv, env);
  childEnv.FACTORY_ROOT = factoryRoot;

  for (const key of [...PROVIDER_CREDENTIAL_ENV, ...extraStrip]) {
    delete childEnv[key];
  }
  for (const key of Object.keys(childEnv)) {
    if (stripPrefixes.some((prefix) => key.startsWith(prefix))) {
      delete childEnv[key];
    }
  }
  if (!isMutating) {
    for (const key of PUSH_CREDENTIAL_ENV) {
      delete childEnv[key];
    }
  }
  // Dispatch identity is supplied explicitly by the worker from the RunSpec;
  // re-assert it after the strip loops so an `extraStrip` entry or a
  // `stripPrefixes: ["FACTORY_"]` adapter cannot silently remove it.
  for (const key of DISPATCH_IDENTITY_ENV) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }

  return childEnv;
}
