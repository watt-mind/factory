/**
 * The smallest connector that satisfies the contract (docs/extensions.md
 * § Connectors): a string `id` and a default `start(ctx)` that returns
 * `{ stop, health }`. It subscribes to inbox writes, logs them, and
 * exposes a health snapshot so loader/start/stop tests can watch the
 * lifecycle without talking to an external network.
 */
export const id = "factory/sample:echo";

export default async function start(ctx) {
  let events = 0;
  let lastEventAt;
  const unsubscribe = ctx.client.inbox.subscribe((event) => {
    events += 1;
    lastEventAt =
      typeof event?.at === "string" ? event.at : new Date().toISOString();
    const itemId = event?.item?.id ?? "";
    ctx.log(`inbox ${event?.type ?? "change"}${itemId ? ` ${itemId}` : ""}`);
  });
  const onAbort = () => {
    unsubscribe?.();
  };
  ctx.signal?.addEventListener?.("abort", onAbort, { once: true });
  return {
    async stop() {
      ctx.signal?.removeEventListener?.("abort", onAbort);
      unsubscribe?.();
    },
    health() {
      return {
        ok: true,
        detail: `echo subscribed (${events} inbox events)`,
        lastEventAt,
      };
    },
  };
}
