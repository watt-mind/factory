#!/usr/bin/env bun
/**
 * Web control plane server (docs/event-runtime-webui.md §3).
 *
 * Static bundle + /api/* proxy to the loopback control API, so the browser
 * has one origin. Deliberately imports nothing from ../lib/ — it is a client
 * of the runtime, not part of it (spec §9). Loopback only; binding beyond
 * 127.0.0.1 is the moment auth becomes a precondition, so no --host flag
 * exists here. When the control API is token-gated (WM-1152), this proxy adds
 * the bearer from its own env so the browser stays token-free.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const WEB_PORT = Number(process.env.FACTORY_EVENT_WEB_PORT || 7382);
const API_PORT = Number(process.env.FACTORY_EVENT_PORT || 7381);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

// WM-973: extra Host values (beyond loopback) this server will answer for —
// e.g. a tailnet name published via `tailscale serve`, which proxies to the
// loopback port so the binding stays 127.0.0.1 and transport auth comes from
// the tailnet. Hostnames only, comma-separated, compared case-insensitively
// with any :port stripped. Unset = loopback-only, exactly the old behavior.
const ALLOWED_HOSTS = new Set(
  (process.env.FACTORY_EVENT_WEB_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

function hostOf(value) {
  if (typeof value !== "string" || value === "") return null;
  // Host header / Origin host: strip :port (IPv6 literals keep brackets).
  const m = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (m) return m[1].toLowerCase();
  return value.replace(/:\d+$/, "").toLowerCase();
}

// WM-1152: the bearer this proxy presents to the control API. When the API is
// token-gated (FACTORY_CONTROL_API_TOKEN set), the browser never sees or sends
// the token — this same-origin proxy adds it from its own env when forwarding
// to :7381. Unset = nothing added, exactly the old pass-through. Never logged.
const CONTROL_API_TOKEN = process.env.FACTORY_CONTROL_API_TOKEN || "";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function hostAllowed(value) {
  const host = hostOf(value);
  if (host === null) return false;
  return LOOPBACK_HOSTS.has(host) || ALLOWED_HOSTS.has(host);
}

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error(
    `no build at ${DIST} — build it first:\n  cd event-runtime/web && bun install && bun run build`,
  );
  process.exit(1);
}

function fatalProcessError(kind, error) {
  console.error(`[web] ${kind}:`, error);
  // A process-level failure may leave Bun.serve in an unknown state. Exit
  // non-zero so live-stack's supervisor replaces this process cleanly.
  process.exit(1);
}

process.on("uncaughtException", (error, origin) =>
  fatalProcessError(`uncaughtException (${origin})`, error),
);
process.on("unhandledRejection", (reason) =>
  fatalProcessError("unhandledRejection", reason),
);

Bun.serve({
  hostname: HOST,
  port: WEB_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // WM-973: answer only for loopback and explicitly allowed Hosts, and
    // reject cross-site Origins at this layer — the API's own loopback guard
    // stays untouched because the proxy below rewrites Host/Origin.
    if (!hostAllowed(req.headers.get("host")))
      return new Response(JSON.stringify({ error: "invalid_host" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    const origin = req.headers.get("origin");
    if (origin) {
      let originHost;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        originHost = null;
      }
      if (originHost === null || !hostAllowed(originHost))
        return new Response(
          JSON.stringify({ error: "cross_origin_rejected" }),
          {
            status: 403,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const target = `http://127.0.0.1:${API_PORT}${url.pathname.slice(4) || "/"}${url.search}`;
      // Pass-through, nothing added: the proxy exists only for same-origin.
      // WHATWG fetch rejects GET/HEAD when a body option is present, even when
      // the incoming client supplied one, so omit the option for those methods.
      const bodyless = req.method === "GET" || req.method === "HEAD";
      const headers = new Headers(req.headers);
      // WM-973: the upstream API enforces a loopback Host and Origin; this
      // proxy IS the same-origin boundary, so present as loopback upstream.
      headers.set("host", `127.0.0.1:${API_PORT}`);
      headers.delete("origin");
      // WM-1152: authenticate to a token-gated control API. Overwrite any
      // client-supplied header so the browser can never inject its own bearer.
      if (CONTROL_API_TOKEN)
        headers.set("authorization", `Bearer ${CONTROL_API_TOKEN}`);
      else headers.delete("authorization");
      const init = { method: req.method, headers };
      try {
        if (bodyless) {
          // Drain any non-standard incoming payload so a keep-alive connection
          // remains aligned for the client's next request. Its framing headers
          // must not describe a body that the upstream request intentionally omits.
          await req.arrayBuffer();
          headers.delete("content-length");
          headers.delete("transfer-encoding");
        } else {
          init.body = req.body;
        }
        return await fetch(target, init);
      } catch (error) {
        // Backend restarts are expected during deploys and watch-mode reloads.
        // Keep the static server alive and give clients an explicit retryable
        // response instead of allowing Bun's rejected fetch to escape.
        console.error(
          `[web] ${req.method} ${url.pathname} upstream unavailable:`,
          error,
        );
        return new Response(
          JSON.stringify({ error: "event runtime temporarily unavailable" }),
          {
            status: 503,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "retry-after": "1",
            },
          },
        );
      }
    }

    // Static, confined to dist/ — reject traversal rather than resolving it.
    const resolved = path.normalize(path.join(DIST, url.pathname));
    if (!resolved.startsWith(DIST))
      return new Response("not found", { status: 404 });
    const file = Bun.file(
      resolved === DIST ? path.join(DIST, "index.html") : resolved,
    );
    if (await file.exists()) return new Response(file);
    // A stale content-hashed import must fail as a missing module. Returning the
    // SPA document here disguises it as JavaScript and produces a misleading
    // MIME error before the route error boundary can recover.
    if (url.pathname === "/assets" || url.pathname.startsWith("/assets/")) {
      return new Response("asset not found", { status: 404 });
    }
    return new Response(Bun.file(path.join(DIST, "index.html")));
  },
});

console.log(
  `web control plane on http://${HOST}:${WEB_PORT} → API 127.0.0.1:${API_PORT}`,
);
