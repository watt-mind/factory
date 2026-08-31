/**
 * factory-cells — cell Durable Objects and ingress worker (spikes #2144, #2149).
 *
 * SECURITY / DEPLOYMENT WARNING:
 *   This is a loopback-only development spike. It is intended to be reached
 *   exclusively over 127.0.0.1 via `celld dev`. The only access control here is
 *   a shared-secret bearer token read from `env.CELL_AUTH_TOKEN`, which is a
 *   stop-gap, not an authentication system: there is no per-caller identity, no
 *   rotation, no rate limiting, and no authorization on which cell a caller may
 *   touch. Requests are refused outright when the secret is unset (fail closed).
 *
 *   This worker MUST NOT be deployed to a public or shared environment until
 *   real authentication and per-cell authorization are in place.
 */

export { GenericCell } from "./base/generic-cell.mjs";
export { SiteCell } from "./editorial/site-cell.mjs";
export { ArticleCell } from "./editorial/article-cell.mjs";
export { CellRouter, defaultRouter, checkAuth } from "./router.mjs";

import { defaultRouter } from "./router.mjs";

export default {
  async fetch(request, env) {
    return defaultRouter.handle(request, env);
  },
};
