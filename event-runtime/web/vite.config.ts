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
    if (packages.some((pkg) => rest === pkg || rest.startsWith(`${pkg}/`)))
      return chunk;
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
// WM-257 measured the entry at 472.95 kB locally after restoring those splits
// and set 480 kB, about 7 kB of slack, to keep the previous 540 kB ratchet from
// returning. Keep the xyflow and lazy-route chunks visible in build output
// before considering any future re-baseline.
//
// WM-332 re-baselined to 500 kB on 2026-08-15. Four web features landed in one
// evening (#290 keyboard navigation and copy chords, #324 artifact preview,
// #326 view announcements, #333 grouped column picker) and took the entry from
// 472.95 kB to 480.23 kB, past the limit. The vendor split was verified healthy
// first — the xyflow chunk measured an identical 197.04 kB either side — so
// this is real feature growth, not a dep escaping VENDOR_CHUNKS.
//
// The slack is 20 kB rather than 7 kB deliberately. At 7 kB the guard had drifted
// to 0.1% of the limit, where it stops measuring app growth and starts firing on
// build nondeterminism: the same source produced 479.51 kB in the operator's
// checkout and 480.23 kB in a fresh worktree, so develop went red on the variance
// rather than on a change. A ratchet that trips on noise sends whoever hits it
// hunting a bug they did not introduce. If a future raise buys less headroom than
// this, split the entry instead of moving the number again.
//
// WM-483 re-baselined to 550 kB on 2026-08-17. The attribute-icon registry
// (`components/attrIcons.tsx`, §5.2 tier 4) hangs off `KV` in `ui.tsx`, which
// every eager view imports, so its ~35 Radix glyphs land in the entry by design:
// 488.48 kB → 522.66 kB. Tree-shaking was verified first (only the imported
// glyphs appear in the output; the package is `sideEffects: false`), and the
// vendor split is unchanged. The operator accepted the larger entry for one
// consistent icon set over per-route duplication. Slack is ~27 kB (5%), the same
// proportion as the WM-332 raise.
//
// WM-286 re-baselined to 575 kB on 2026-08-17. develop had crept to ~548 kB
// through the polish round (#512 context strip, #518 trace errors, #519
// artifacts) — 2 kB of slack, i.e. the same 0.4% drift WM-332 warned about —
// and the Inbox view's eager-path additions (route + nav badge in App.tsx,
// three api client calls, the Overview "Waiting on you" tile; the view itself
// is a lazy chunk) took the entry to 550.29 kB. Vendor split verified: xyflow
// still 197.04 kB, elk still its own chunk. Slack ~25 kB (4.5%). If the next
// raise buys less than this, split Overview's stage cards instead.
//
// WM-563 re-baselined to 600 kB on 2026-08-17. The table windowing work took
// the entry to 574.99 kB — 10 bytes of slack — so the review fixes on top of it
// (the sub-header ancestry walk in `hooks.ts`, the footer key guard in
// `ui.tsx`) tipped it to 575.10 kB. Vendor split verified unchanged: xyflow
// still 197.04 kB, elk still its own chunk. Slack ~25 kB (4.3%), the same
// proportion as the WM-286 and WM-483 raises. If the next raise buys less than
// this, split Overview's stage cards instead.
const ENTRY_CHUNK_BUDGET_BYTES = 600 * 1000;

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
          oversized.push(
            `${output.fileName} is ${(bytes / 1000).toFixed(2)} kB`,
          );
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
