import { fail, withClient } from "./shared.mjs";

export const CANCEL_CONCURRENCY = 4;

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${option} requires a value`);
  }
  return value;
}

/** Parse one explicit target set or an exact server-side state/agent selection. */
export function parseCancelArgs(args) {
  const options = { ids: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reason") {
      options.reason = optionValue(args, index, arg);
      index += 1;
    } else if (arg === "--state") {
      options.state = optionValue(args, index, arg).toUpperCase();
      index += 1;
    } else if (arg === "--agent") {
      options.agent = optionValue(args, index, arg);
      index += 1;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg.startsWith("--")) {
      fail(`unknown cancel option: ${arg}`);
    } else {
      options.ids.push(arg);
    }
  }

  if (options.state) {
    if (options.ids.length) fail("--state cannot be combined with run IDs");
    return options;
  }
  if (options.agent || options.yes || options.dryRun) {
    fail("--agent, --yes, and --dry-run require --state");
  }
  if (!options.ids.length) {
    fail(
      "usage: cancel <run-id>... [--reason <text>] | cancel --state <state> [--agent <id>] [--reason <text>] [--yes] [--dry-run]",
    );
  }

  // Runtime-generated IDs always start with `run_`. Preserve the old
  // `cancel <run-id> <reason>` spelling when the second positional argument
  // is not another canonical run ID; batches use `--reason` to be unambiguous.
  if (
    options.reason === undefined &&
    options.ids.length === 2 &&
    options.ids[0].startsWith("run_") &&
    !options.ids[1].startsWith("run_")
  ) {
    options.reason = options.ids.pop();
  }
  return options;
}

function printTargets(ids) {
  for (const id of ids) console.log(id);
}

async function cancelAll(client, ids, reason) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const res = await client.cancel(id, reason);
        if (res?.ambiguousOpenProposals?.length) {
          console.log(
            `cancelled ${id} (warning: ${res.ambiguousOpenProposals[0].count} open proposals remain ambiguous)`,
          );
        } else {
          console.log(`cancelled ${id}`);
        }
      } catch (error) {
        failed = true;
        console.log(`cancel failed ${id}: ${error.message}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CANCEL_CONCURRENCY, ids.length) }, worker),
  );
  return !failed;
}

export default function cancel(args) {
  const options = parseCancelArgs(args);
  return withClient(async (client) => {
    let ids = options.ids;
    if (options.state) {
      const page = await client.runs({
        state: options.state,
        ...(options.agent ? { agent: options.agent } : {}),
      });
      ids = (page.runs ?? []).map((run) => run.runId);
      printTargets(ids);
      if (options.dryRun || !ids.length) return;
      if (ids.length > 1 && !options.yes) {
        console.error("refusing to cancel multiple runs without --yes");
        process.exitCode = 1;
        return;
      }
    }
    if (!(await cancelAll(client, ids, options.reason))) {
      process.exitCode = 1;
    }
  });
}
