/**
 * Connector rows on the status projection (WM-919).
 *
 * `GET /status` is composed in lib/status-view.mjs, which is outside this
 * ticket's Owned Paths. Call `attachConnectorStatus(payload)` from that
 * handler to publish `connectors: [...]`. Until that follow-up lands,
 * `serve` still starts connectors and start-failure anomalies already
 * appear under `/status.anomalies.configuration` via `registry.anomalies`.
 *
 * Doctor (`cli/status.mjs`) and `extensions list` similarly sit outside
 * Owned Paths; `loadExtensions` already records connector counts on each
 * extension so `--json` shows them.
 */
import { connectorStatus } from "./connectors.mjs";

/** Snapshot of every loaded connector for `/status.connectors`. */
export function connectorsStatus() {
  return connectorStatus();
}

/**
 * Merge the connector snapshot onto a status payload without mutating it.
 *
 * @param {object} payload
 * @returns {object}
 */
export function attachConnectorStatus(payload) {
  return {
    ...payload,
    connectors: connectorsStatus(),
  };
}
