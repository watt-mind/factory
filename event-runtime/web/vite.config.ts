import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Graph view's two heavyweights get their own chunks (OPS-255). Left in
// the entry chunk they made Overview/Events/Runs pay ~2 MB before painting a
// single row. `elk` is also async — Graph.tsx imports the layout module
// dynamically, so the layout engine is fetched only when a graph is drawn.
//
// Accepted warning: the `elk` chunk is ~1.4 MB and still trips Vite's 500 kB
// notice. elkjs ships as one pre-minified GWT artifact (a single module, no
// tree-shakeable surface), so there is nothing left to split — the only lever
// is dropping the dependency, and hand-rolled DAG layout is worse. We do not
// raise build.chunkSizeWarningLimit to silence it: that would also stop the
// warning from firing on the entry chunk, which is the one worth watching.
const VENDOR_CHUNKS: Array<[chunk: string, packages: string[]]> = [
  ["elk", ["elkjs"]],
  [
    "xyflow",
    [
      "@xyflow/react",
      "@xyflow/system",
      "classcat",
      "zustand",
      "use-sync-external-store",
      "d3-color",
      "d3-dispatch",
      "d3-drag",
      "d3-ease",
      "d3-interpolate",
      "d3-selection",
      "d3-timer",
      "d3-transition",
      "d3-zoom",
    ],
  ],
];

function vendorChunk(id: string): string | undefined {
  const marker = "/node_modules/";
  const at = id.lastIndexOf(marker);
  if (at === -1) return undefined;
  const rest = id.slice(at + marker.length);
  for (const [chunk, packages] of VENDOR_CHUNKS) {
    if (packages.some((pkg) => rest === pkg || rest.startsWith(`${pkg}/`))) return chunk;
  }
  return undefined;
}

// VENDOR_CHUNKS hardcodes @xyflow/react's transitive deps, so a rename or a new
// one on the next bump silently rejoins the entry chunk and the entry grows back
// with nothing failing (OPS-288). Vite's own 500 kB notice is not that guard:
// it is a warning, and the accepted elk one above trains everyone to skim past
// it. Budget the entry chunk only — async chunks (elk, xyflow) are not entries,
// are fetched on demand, and are deliberately over the limit. kB is 1000 bytes
// here to match how Vite reports sizes.
//
// This budget protects first paint on the operator dashboard: the shared shell
// and the primary Overview, Runs, and Events views stay eager, while secondary
// routes (including Agents, Workers, and full-run detail) and occasional dialogs
// load on demand. Moving one of those surfaces back into the entry is therefore
// a first-paint tradeoff, not routine feature growth.
//
// WM-257 measured the entry at 472.95 kB locally after restoring those splits;
// 480 kB leaves about 7 kB of slack while keeping the previous 540 kB ratchet
// from returning. Keep the xyflow and lazy-route chunks visible in build output
// before considering any future re-baseline.
const ENTRY_CHUNK_BUDGET_BYTES = 480 * 1000;

function entryChunkBudget(): Plugin {
  return {
    name: "entry-chunk-budget",
    apply: "build",
    writeBundle(_options, bundle) {
      const oversized: string[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || !output.isEntry) continue;
        const bytes = Buffer.byteLength(output.code, "utf8");
        if (bytes > ENTRY_CHUNK_BUDGET_BYTES) {
          oversized.push(`${output.fileName} is ${(bytes / 1000).toFixed(2)} kB`);
        }
      }
      if (oversized.length === 0) return;
      // Vite's size reporter runs later in writeBundle; throwing here skips it,
      // so print the inventory ourselves instead of pointing at missing output.
      const inventory = Object.values(bundle)
        .filter((output) => output.type === "chunk")
        .map(
          (output) =>
            `${output.fileName} ${(Buffer.byteLength(output.code, "utf8") / 1000).toFixed(2)} kB`,
        )
        .join("\n  ");
      const detail = oversized.join(", ");
      throw new Error(
        `Entry chunk budget exceeded: ${detail} (budget ${ENTRY_CHUNK_BUDGET_BYTES / 1000} kB).\n` +
          `Chunks:\n  ${inventory}\n` +
          "Check the list above: if the xyflow chunk shrank or vanished, a " +
          "@xyflow/react transitive dep is missing from VENDOR_CHUNKS in vite.config.ts — add it " +
          "there (or code-split the new import) rather than raising the budget. If the split " +
          "chunks look right and this is genuine app growth, re-baseline ENTRY_CHUNK_BUDGET_BYTES " +
          "to the measured size plus a little slack, in its own commit, so the raise is a " +
          "reviewable decision instead of a silent drift.",
      );
    },
  };
}

// Dev-server proxy mirrors serve.mjs: the browser sees one origin, /api/*
// forwards to the loopback control API (webui spec §3).
export default defineConfig({
  plugins: [react(), tailwindcss(), entryChunkBudget()],
  build: {
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.FACTORY_EVENT_PORT || 7381}`,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
