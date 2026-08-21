/**
 * Buzz connector (WM-921). Speaks the Buzz HTTP bridge with NIP-98 + NIP-OA,
 * posts inbox items as kind-9 in the configured channel, maps 👍/👎/💤 (and
 * numbered reactions) onto inbox.decide, and accepts a closed command grammar.
 */
import { createBuzzRuntime } from "../lib/runtime.mjs";

export const id = "wattmind/buzz:buzz";

export default async function start(ctx) {
  const runtime = createBuzzRuntime({
    config: ctx.config ?? {},
    secrets: ctx.secrets ?? {},
    client: ctx.client,
    log: ctx.log ?? (() => {}),
    fetchImpl: ctx.fetch ?? fetch,
    webUrl: ctx.config?.webUrl ?? process.env.FACTORY_WEB_URL,
  });
  const unsubscribe = ctx.client?.inbox?.subscribe?.((event) => {
    runtime.onInboxEvent(event).catch((err) => {
      ctx.log?.(`inbox event failed: ${err.message}`);
    });
  });
  // Run lifecycle transitions are NOT wired through client.runs.subscribe:
  // that bus is process-local and the worker that executes RUNNING /
  // COMPLETED / etc runs in a separate process (OPS-233), so it would never
  // fire here. runtime.poll() tails the durable journal instead (WM-975).
  const timer = setInterval(() => {
    runtime.poll().catch((err) => ctx.log?.(`poll failed: ${err.message}`));
  }, runtime.pollSeconds * 1000);
  timer.unref?.();
  runtime
    .poll()
    .catch((err) => ctx.log?.(`initial poll failed: ${err.message}`));

  const onAbort = () => {
    clearInterval(timer);
    unsubscribe?.();
  };
  ctx.signal?.addEventListener?.("abort", onAbort, { once: true });

  return {
    async stop() {
      ctx.signal?.removeEventListener?.("abort", onAbort);
      clearInterval(timer);
      unsubscribe?.();
    },
    health() {
      return runtime.health();
    },
  };
}
