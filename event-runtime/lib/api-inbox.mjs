/** Human inbox endpoints. */
import {
  ackInboxItem,
  createInboxItem,
  deliverInboxItem,
  listInboxPage,
  resolveInboxItem,
} from "./inbox.mjs";
import { ApiParameterError, parseListLimit } from "./api-params.mjs";

export async function handleInboxApiRoute({
  route,
  req,
  url,
  send,
  db,
  nowMs,
  readBody,
  parseJson,
  actor = "operator",
  inboxCommand,
  inboxSend,
  inboxWebUrl,
}) {
  if (route === "POST /inbox") {
    const parsed = parseJson(await readBody(req));
    if (parsed.error) return send(422, { error: parsed.error });
    try {
      const item = createInboxItem(db, parsed.value, { now: nowMs });
      if (item.attached) {
        const { attached: _attached, ...publicItem } = item;
        return send(201, {
          item: publicItem,
          delivery: {
            ok: true,
            skipped: "deduped",
            exitCode: null,
            error: null,
          },
        });
      }
      // Item first, projection second: even a failed transport leaves a
      // queryable row and records the delivery error on it.
      const delivery = await deliverInboxItem(db, item.id, {
        command: inboxCommand,
        send: inboxSend,
        webUrl: inboxWebUrl,
        now: nowMs,
      });
      return send(201, {
        item: delivery.item,
        delivery: {
          ok: delivery.ok,
          exitCode: delivery.exitCode,
          error: delivery.error,
        },
      });
    } catch (err) {
      return send(422, { error: err.message });
    }
  }

  if (route === "GET /inbox") {
    const status = url.searchParams.get("status") ?? "open";
    try {
      return send(200, listInboxPage(db, { status, ...listPage(url) }));
    } catch (err) {
      if (err instanceof ApiParameterError) return send(422, err.body);
      throw err;
    }
  }

  const inboxVerb = url.pathname.match(/^\/inbox\/([^/]+)\/(ack|resolve)$/);
  if (req.method === "POST" && inboxVerb) {
    const id = decodeURIComponent(inboxVerb[1]);
    const verb = inboxVerb[2];
    const raw = await readBody(req);
    const parsed = raw.length === 0 ? { value: {} } : parseJson(raw);
    if (parsed.error) return send(422, { error: parsed.error });
    if (
      !parsed.value ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      return send(422, { error: "body must be an object" });
    }
    if (verb === "resolve") {
      if (
        typeof parsed.value.reason !== "string" ||
        parsed.value.reason.trim() === ""
      ) {
        return send(422, { error: "reason must be a non-empty string" });
      }
    } else if (
      parsed.value.reason !== undefined &&
      typeof parsed.value.reason !== "string"
    ) {
      return send(422, { error: "reason must be a string" });
    }
    try {
      const item =
        verb === "ack"
          ? ackInboxItem(db, id, { now: nowMs })
          : resolveInboxItem(db, id, {
              now: nowMs,
              resolvedBy: actor,
              reason: parsed.value.reason.trim(),
            });
      return send(200, { item });
    } catch (err) {
      const status = String(err.message).startsWith("unknown inbox item")
        ? 404
        : 409;
      return send(status, { error: err.message });
    }
  }

  return false;
}

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 200;

function listPage(url) {
  const limit = parseListLimit(url, {
    defaultLimit: LIST_DEFAULT_LIMIT,
    maxLimit: LIST_MAX_LIMIT,
  });
  const rawBefore = url.searchParams.get("before");
  if (!rawBefore) return { limit, before: null };
  try {
    const before = JSON.parse(
      Buffer.from(rawBefore, "base64url").toString("utf8"),
    );
    if (
      !before ||
      typeof before.createdAt !== "string" ||
      !Number.isFinite(Date.parse(before.createdAt)) ||
      !Number.isSafeInteger(before.rowid) ||
      before.rowid < 1
    ) {
      throw new Error("invalid cursor");
    }
    return { limit, before };
  } catch {
    throw new ApiParameterError(
      "invalid_before",
      "before must be a valid cursor",
    );
  }
}
