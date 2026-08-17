/** Metrics endpoints. */
import {
  MetricsQueryError,
  metricsBreakdownView,
  metricsView,
} from "./metrics.mjs";

export function handleMetricsApiRoute({ route, url, send, db, nowMs }) {
  if (route === "GET /metrics") {
    try {
      return send(
        200,
        metricsView(db, {
          now: nowMs,
          window: url.searchParams.get("window") ?? "24h",
          bucket: url.searchParams.get("bucket") ?? "1h",
          series: url.searchParams.get("series"),
        }),
      );
    } catch (err) {
      if (err instanceof MetricsQueryError) return send(422, err.body);
      throw err;
    }
  }

  if (route === "GET /metrics/breakdown") {
    try {
      return send(
        200,
        metricsBreakdownView(db, {
          now: nowMs,
          window: url.searchParams.get("window") ?? "24h",
          by: url.searchParams.get("by"),
          metric: url.searchParams.get("metric"),
          limit: url.searchParams.get("limit"),
        }),
      );
    } catch (err) {
      if (err instanceof MetricsQueryError) return send(422, err.body);
      throw err;
    }
  }

  return false;
}
