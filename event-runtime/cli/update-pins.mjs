import path from "node:path";
import { updatePins } from "../lib/registry.mjs";
import { updateHarnessPins } from "../lib/pins.mjs";
import { collectHarnessRoots } from "../lib/extensions.mjs";
import { FACTORY_ROOT } from "../lib/config.mjs";
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

export default async function updatePinsCommand(args = []) {
  const { pack, check } = parseUpdatePinsArgs(args);
  try {
    const changed =
      pack === undefined
        ? await updatePins({ check })
        : await updatePins({ pack, check });
    // Harness content (contributes.harness, WM-849) is pack-independent —
    // one top-level event-runtime/pins.json covers shared/ plus every
    // policy-listed extension, so it only re-pins on the bare invocation.
    if (pack === undefined) {
      const { roots, anomalies } = collectHarnessRoots({
        root: FACTORY_ROOT,
        builtin: path.join(FACTORY_ROOT, "shared"),
      });
      for (const anomaly of anomalies) console.error(`harness: ${anomaly}`);
      const harnessChanged = updateHarnessPins({ roots, check });
      changed.push(...harnessChanged.map((name) => `harness:${name}`));
    }
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
