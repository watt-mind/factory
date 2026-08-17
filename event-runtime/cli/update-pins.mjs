import { updatePins } from "../lib/registry.mjs";
import { fail } from "./shared.mjs";

export default function updatePinsCommand(args = []) {
  if (
    args.length !== 0 &&
    (args.length !== 2 ||
      args[0] !== "--pack" ||
      !args[1] ||
      args[1].startsWith("--"))
  ) {
    fail("usage: update-pins [--pack NAME]");
  }
  try {
    const changed = args.length === 0 ? updatePins() : updatePins({ pack: args[1] });
    console.log(
      changed.length
        ? `re-pinned: ${changed.join(", ")}`
        : "pins already current",
    );
  } catch (err) {
    fail(`update-pins: ${err.message}`);
  }
}
