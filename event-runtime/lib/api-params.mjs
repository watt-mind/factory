/** Shared validation for bounded control-API list parameters. */
export class ApiParameterError extends Error {
  constructor(error, message) {
    super(message);
    this.body = { error, message };
  }
}

export function parseListLimit(url, { defaultLimit, maxLimit }) {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit === null) return defaultLimit;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new ApiParameterError(
      "invalid_limit",
      `limit must be an integer between 1 and ${maxLimit}`,
    );
  }
  return limit;
}

export function parseNonNegativeSince(url) {
  const rawSince = url.searchParams.get("since");
  if (rawSince === null) return 0;
  const since = Number(rawSince);
  if (rawSince.trim() === "" || !Number.isSafeInteger(since) || since < 0) {
    throw new ApiParameterError(
      "invalid_since",
      "since must be a non-negative integer",
    );
  }
  return since;
}
