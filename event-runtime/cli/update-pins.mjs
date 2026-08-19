import { updatePins } from "../lib/registry.mjs";
import { fail } from "./shared.mjs";

const USAGE = "usage: update-pins [--pack NAME] [--check]";

function parseUpdatePinsArgs(args = []) {
  let pack;
  let check = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--pack") {
      const name = args[i + 1];
      if (!name || name.startsWith("--")) fail(USAGE);
      pack = name;
      i += 1;
      continue;
    }
    fail(USAGE);
  }
  return { pack, check };
}

export default function updatePinsCommand(args = []) {
  const { pack, check } = parseUpdatePinsArgs(args);
  try {
    const changed =
      pack === undefined ? updatePins({ check }) : updatePins({ pack, check });
    if (check && changed.length) {
      fail(
        `pins stale: ${changed.join(", ")} — run: bun event-runtime/cli.mjs update-pins`,
      );
    }
    console.log(
      changed.length
        ? `re-pinned: ${changed.join(", ")}`
        : "pins already current",
    );
  } catch (err) {
    fail(`update-pins: ${err.message}`);
  }
}
