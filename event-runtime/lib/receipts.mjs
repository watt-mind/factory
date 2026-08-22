/**
 * Receipt attestation and verification for event-runtime (docs/event-runtime.md §9).
 *
 * Ensures approved specs attest the exact content sha256 of the agent definition
 * in receipts (OPS-409).
 */
import { hashJson } from "./canonical.mjs";

/**
 * Compute the deterministic content sha256 of an agent definition.
 * Omits runtime-injected filesystem-specific fields (promptPath, inputSchema, outputSchema).
 *
 * @param {object} def - The agent definition object
 * @returns {string|null} sha256:... hash or null if def is falsy
 */
export function computeDefHash(def) {
  if (!def) return null;
  const { promptPath, inputSchema, outputSchema, ...rest } = def;
  return hashJson(rest);
}

/**
 * Verify that the agent definition matches the spec's declared defHash (if present).
 *
 * @param {object} spec - The RunSpec
 * @param {object} def - The agent definition from registry
 * @returns {boolean} true if matches or no defHash in spec, false if mismatched
 */
export function verifyDefHash(spec, def) {
  if (!spec?.defHash || !def) return true;
  return spec.defHash === computeDefHash(def);
}

/**
 * Attest agent definition content hash in a receipt.
 *
 * @param {object} receipt - Existing receipt
 * @param {{ def?: object, spec?: object }} [opts]
 * @returns {object} Receipt containing defHash attestation
 */
export function attestReceipt(receipt, { def, spec } = {}) {
  const defHash = spec?.defHash ?? (def ? computeDefHash(def) : null);
  return {
    ...receipt,
    ...(defHash ? { defHash } : {}),
  };
}

/**
 * Create a receipt with full attestation including agent definition content hash.
 *
 * @param {{
 *   runId: string,
 *   spec?: object,
 *   def?: object,
 *   artifactHash?: string|null,
 *   evidenceSetHash?: string|null,
 *   journalHead?: string|null,
 *   verificationStatus?: string,
 *   harnessPins?: Record<string, string>|null,
 *   extraReceipt?: object
 * }} opts
 * @returns {object} Compact receipt
 */
export function createReceipt({
  runId,
  spec,
  def,
  artifactHash = null,
  evidenceSetHash = null,
  journalHead = null,
  verificationStatus = "passed",
  harnessPins = null,
  extraReceipt = null,
}) {
  const base = extraReceipt ?? {
    runId: spec?.runId ?? runId,
    runSpecHash: spec ? hashJson(spec) : null,
    artifactHash,
    evidenceSetHash,
    journalHead,
    verificationStatus,
  };
  const defHash = spec?.defHash ?? (def ? computeDefHash(def) : null);
  const receiptHarnessPins =
    harnessPins && Object.keys(harnessPins).length > 0
      ? harnessPins
      : base.harnessPins && Object.keys(base.harnessPins).length > 0
        ? base.harnessPins
        : null;
  return {
    ...base,
    runId: base.runId ?? spec?.runId ?? runId,
    runSpecHash: base.runSpecHash ?? (spec ? hashJson(spec) : null),
    ...(defHash ? { defHash } : {}),
    artifactHash:
      base.artifactHash !== undefined ? base.artifactHash : artifactHash,
    evidenceSetHash:
      base.evidenceSetHash !== undefined
        ? base.evidenceSetHash
        : evidenceSetHash,
    journalHead: journalHead ?? base.journalHead ?? null,
    verificationStatus: base.verificationStatus ?? verificationStatus,
    ...(receiptHarnessPins ? { harnessPins: receiptHarnessPins } : {}),
  };
}
