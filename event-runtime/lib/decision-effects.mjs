/**
 * Runtime-owned effects for inbox decisions.
 *
 * WM-391 fills in the stateful effects. This seam deliberately ships only the
 * side-effect-free dismiss operation; unsupported effects leave their item
 * open and can be retried after that implementation lands.
 */
export function applyDecisionEffect(_db, item, response) {
  const option = item?.decision?.options?.find(
    (candidate) => candidate.id === response?.optionId,
  );
  const kind = option?.effect ?? "unknown";
  if (kind === "dismiss") return { kind, outcome: "applied" };
  return { kind, outcome: "unsupported" };
}

export default applyDecisionEffect;
