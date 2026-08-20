import { createAdapterRegistry } from "../lib/adapters/index.mjs";
import { loadExtensions } from "../lib/extensions.mjs";

/**
 * Read-only listing of the adapter registry (WM-837): the same registry
 * `work` and `serve` build, so what this prints is what a worker would
 * execute with. Local — it needs no running serve.
 */
export default async function adaptersCommand(args = []) {
  const registry = createAdapterRegistry();
  const loaded = await loadExtensions({ adapterRegistry: registry });
  for (const anomaly of loaded.anomalies) console.error(`anomaly: ${anomaly}`);
  const rows = registry.list();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ adapters: rows }, null, 2));
    return rows;
  }
  const width = Math.max(8, ...rows.map((row) => row.name.length + 3));
  console.log(`${"ADAPTER".padEnd(width)}${"SOURCE".padEnd(12)}SANDBOX`);
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(width)}${row.source.padEnd(12)}${row.sandboxSupport}`,
    );
  }
  return rows;
}
