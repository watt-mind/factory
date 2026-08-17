import { updatePins } from "../lib/registry.mjs";

export default function updatePinsCommand() {
  const changed = updatePins();
  console.log(
    changed.length
      ? `re-pinned: ${changed.join(", ")}`
      : "pins already current",
  );
}
