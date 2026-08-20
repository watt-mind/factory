/**
 * Buzz connector runtime: egress, ingress, bounded outage queue, health.
 *
 * `start()` in connectors/buzz.mjs wires this to ctx. Tests drive it with a
 * fake relay and a fake loopback client.
 */
import {
  DM_KINDS,
  DEFAULT_POST_KINDS,
  fieldsForOption,
  formatInboxMessage,
  formatOptions,
  formatResolvedReply,
  inboxDeepLink,
  isApprover,
  optionNeedsReason,
  parseCommand,
  reactionToOptionId,
} from "./format.mjs";
import { hashJson } from "./hash.mjs";
import { giftWrapDm } from "./nip17.mjs";
import {
  KIND_CHAT,
  KIND_REACTION,
  decodeNsec,
  encodeNpub,
  parseAuthTag,
  pubkeyFromSecret,
  signEvent,
  verifyAuthTag,
  verifyEvent,
  withAuthTag,
} from "./nostr.mjs";
import { postEvent, queryEvents } from "./relay.mjs";

export const QUEUE_LIMIT = 32;
export const REJECT_REASON_PROMPT = "reply with a reason to reject";

function asList(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

export function resolveIdentity({ secrets = {}, config = {} } = {}) {
  const secretHex = decodeNsec(secrets.agentNsec);
  const auth = parseAuthTag(secrets.authTag);
  const pubkey = secretHex ? pubkeyFromSecret(secretHex) : null;
  const approvers = asList(
    config.approvers,
    auth?.owner ? [auth.owner] : [],
  ).map((p) => p.toLowerCase());
  const authValid = auth && pubkey ? verifyAuthTag(auth, pubkey) : null;
  return {
    secretHex,
    auth,
    authValid,
    pubkey,
    approvers,
    npub: pubkey ? encodeNpub(pubkey) : null,
  };
}

function decideResponse(item, optionId, text) {
  return {
    schemaVersion: "factory.decision-response/v1",
    requestHash: hashJson(item.decision),
    optionId,
    fields: fieldsForOption(item.decision, optionId, text),
  };
}

function channelMessage({
  secretHex,
  auth,
  channel,
  content,
  replyTo,
  createdAt,
}) {
  const tags = [["h", channel]];
  if (replyTo) tags.push(["e", replyTo, "", "reply"]);
  return signEvent(
    { kind: KIND_CHAT, tags: withAuthTag(tags, auth), content },
    secretHex,
    { createdAt },
  );
}

export function createBuzzRuntime({
  config = {},
  secrets = {},
  client,
  log = () => {},
  fetchImpl = fetch,
  now = () => Date.now(),
  webUrl = process.env.FACTORY_WEB_URL,
} = {}) {
  const relayUrl = config.relayUrl ?? "https://watt-mind.communities.buzz.xyz";
  const channel = config.channel ?? "91572011-2505-5288-b6f5-4a7d74abf106";
  const postKinds = new Set(asList(config.postKinds, DEFAULT_POST_KINDS));
  const pollSeconds = clampInt(config.pollSeconds, 5, 120, 15);
  const dmBlockedTo =
    typeof config.dmBlockedTo === "string" &&
    /^[0-9a-f]{64}$/i.test(config.dmBlockedTo)
      ? config.dmBlockedTo.toLowerCase()
      : null;

  const identity = resolveIdentity({ secrets, config });
  const posted = new Map(); // itemId -> { eventId, postedAt, optionMap, kind }
  const seenIngress = new Set();
  const pendingReject = new Map(); // rootEventId -> { itemId, optionId }
  const queue = [];
  let lastRelayAt = null;
  let lastPollAt = null;
  let lastError = null;
  let lastErrorStatus = null;
  let droppedPosts = 0;
  let since = Math.floor(now() / 1000) - 60;

  const relayOpts = () => ({
    secretHex: identity.secretHex,
    authTagJson: identity.auth?.json ?? null,
    fetchImpl,
  });

  function health() {
    if (!identity.secretHex) {
      return {
        ok: false,
        detail: "FACTORY_EXT_BUZZ_AGENT_NSEC is unset",
        lastEventAt: lastRelayAt,
      };
    }
    if (identity.auth && identity.authValid === false) {
      return {
        ok: false,
        detail: "FACTORY_EXT_BUZZ_AUTH_TAG failed verification",
        lastEventAt: lastRelayAt ?? lastPollAt,
      };
    }
    if (identity.approvers.length === 0) {
      return {
        ok: false,
        detail: "no approvers configured",
        lastEventAt: lastRelayAt ?? lastPollAt,
      };
    }
    if (lastError && !lastRelayAt) {
      return { ok: false, detail: lastError, lastEventAt: lastPollAt };
    }
    if (lastError) {
      return {
        ok: false,
        detail: lastError,
        lastEventAt: lastRelayAt ?? lastPollAt,
      };
    }
    return {
      ok: true,
      detail: `relay ok; posted ${posted.size}; queue ${queue.length}; dropped ${droppedPosts}; last poll ${lastPollAt ?? "never"}`,
      lastEventAt: lastRelayAt ?? lastPollAt,
    };
  }

  async function publish(event) {
    const result = await postEvent(relayUrl, event, relayOpts());
    if (!result.ok) {
      lastErrorStatus = result.status;
      lastError = `relay POST /events ${result.status}: ${String(result.text).slice(0, 180)}`;
      throw new Error(lastError);
    }
    lastError = null;
    lastErrorStatus = null;
    lastRelayAt = new Date(now()).toISOString();
    return event;
  }

  function enqueue(job) {
    if (queue.length >= QUEUE_LIMIT) {
      queue.shift();
      droppedPosts += 1;
      log(
        `outage queue overflow: dropped oldest post (limit ${QUEUE_LIMIT}, dropped total ${droppedPosts})`,
      );
    }
    queue.push(job);
  }

  async function flushQueue() {
    while (queue.length > 0) {
      const job = queue[0];
      try {
        await job();
        queue.shift();
      } catch {
        return;
      }
    }
  }

  async function postItem(item) {
    if (!item?.id) return;
    if (posted.has(item.id)) return;
    if (item.delivery?.buzz?.eventId) {
      posted.set(item.id, {
        eventId: item.delivery.buzz.eventId,
        postedAt: item.delivery.buzz.postedAt,
        optionMap: formatOptions(item.decision).map,
        kind: item.kind,
      });
      return;
    }
    if (!postKinds.has(item.kind)) return;
    const content = formatInboxMessage(item, { webUrl });
    const event = channelMessage({
      secretHex: identity.secretHex,
      auth: identity.auth,
      channel,
      content,
    });
    await publish(event);
    const postedAt = new Date(now()).toISOString();
    const record = {
      eventId: event.id,
      postedAt,
      optionMap: formatOptions(item.decision).map,
      kind: item.kind,
    };
    posted.set(item.id, record);
    await markDelivered(item.id, record);
    if (dmBlockedTo && DM_KINDS.has(item.kind)) {
      const wrap = giftWrapDm(
        identity.secretHex,
        dmBlockedTo,
        `${item.kind}: ${item.title}\n${inboxDeepLink(item.id, webUrl)}`,
      );
      await publish(wrap);
    }
  }

  async function markDelivered(id, record) {
    const fn = client?.inbox?.markDelivered;
    if (typeof fn !== "function") return;
    try {
      await fn(id, {
        buzz: { eventId: record.eventId, postedAt: record.postedAt },
      });
    } catch (err) {
      log(`markDelivered failed: ${err.message}`);
    }
  }

  async function postResolvedReply(item) {
    const record = posted.get(item.id) ?? item.delivery?.buzz;
    if (!record?.eventId) return;
    if (record.resolvedReplyId) return;
    const event = channelMessage({
      secretHex: identity.secretHex,
      auth: identity.auth,
      channel,
      content: formatResolvedReply(item),
      replyTo: record.eventId,
    });
    await publish(event);
    posted.set(item.id, { ...record, resolvedReplyId: event.id });
  }

  async function onInboxEvent(event) {
    if (!identity.secretHex) return;
    const item = event?.item;
    if (!item) return;
    const run = async () => {
      if (item.resolvedAt || item.decidedAt) {
        await postResolvedReply(item);
        return;
      }
      await postItem(item);
    };
    try {
      await run();
    } catch {
      enqueue(run);
    }
  }

  async function decideItem(item, optionId, actor, text) {
    if (
      optionNeedsReason(item.decision, optionId) &&
      !String(text ?? "").trim()
    ) {
      return { needReason: true };
    }
    const response = decideResponse(item, optionId, text);
    try {
      const result = await client.inbox.decide(item.id, response, {
        actor: `buzz:${actor}`,
      });
      return { result };
    } catch (err) {
      log(`decide ${item.id}: ${err.message}`);
      return { error: err.message };
    }
  }

  function itemForEventId(eventId) {
    for (const [id, record] of posted) {
      if (record.eventId === eventId) {
        return { id, record, item: client.inbox.get(id) };
      }
    }
    return null;
  }

  function optionLabel(item, optionId) {
    const options = Array.isArray(item?.decision?.options)
      ? item.decision.options
      : [];
    return options.find((o) => o.id === optionId)?.label ?? optionId;
  }

  function reasonPrompt(item, optionId) {
    return `reply with a reason to ${String(optionLabel(item, optionId)).toLowerCase()}`;
  }

  async function replyInThread(replyTo, content) {
    const reply = channelMessage({
      secretHex: identity.secretHex,
      auth: identity.auth,
      channel,
      content,
      replyTo,
    });
    try {
      await publish(reply);
    } catch {
      enqueue(() => publish(reply));
    }
  }

  async function handleReaction(event) {
    if (seenIngress.has(event.id)) return;
    seenIngress.add(event.id);
    if (!isApprover(event.pubkey, identity.approvers)) return;
    const eTag = (event.tags ?? []).find((t) => t[0] === "e");
    if (!eTag?.[1]) return;
    const found = itemForEventId(eTag[1]);
    if (!found?.item) return;
    const optionId = reactionToOptionId(event.content, found.record.optionMap);
    if (!optionId) return;
    const decided = await decideItem(found.item, optionId, identity.npub);
    if (decided.needReason) {
      pendingReject.set(found.record.eventId, {
        itemId: found.id,
        optionId,
      });
      await replyInThread(
        found.record.eventId,
        reasonPrompt(found.item, optionId),
      );
      return;
    }
    if (decided.error) {
      await replyInThread(
        found.record.eventId,
        `decide failed: ${decided.error}`,
      );
    }
  }

  async function handleReply(event) {
    if (seenIngress.has(event.id)) return;
    seenIngress.add(event.id);
    if (event.pubkey === identity.pubkey) return;
    if (!isApprover(event.pubkey, identity.approvers)) return;
    const eTags = (event.tags ?? []).filter((t) => t[0] === "e");
    const rootId = eTags.find((t) => t[3] === "root")?.[1] ?? eTags[0]?.[1];
    if (!rootId) return;

    const command = parseCommand(event.content);
    if (command?.type === "status") {
      await replyStatus(rootId);
      return;
    }
    if (command?.type === "dispatch") {
      await handleDispatch(command, event, rootId);
      return;
    }

    const pending = pendingReject.get(rootId);
    if (pending) {
      const item = client.inbox.get(pending.itemId);
      if (!item) return;
      const decided = await decideItem(
        item,
        pending.optionId,
        identity.npub,
        event.content,
      );
      pendingReject.delete(rootId);
      if (decided.error) {
        await replyInThread(rootId, `decide failed: ${decided.error}`);
      }
    }
  }

  async function replyStatus(replyTo) {
    let open;
    try {
      open = (client.inbox.list({ status: "open" }) ?? []).length;
    } catch {
      open = -1;
    }
    const h = health();
    const statusSuffix = h.ok
      ? ""
      : lastErrorStatus
        ? ` (status ${lastErrorStatus})`
        : "";
    const content = [
      `inbox open: ${open < 0 ? "?" : open}`,
      `connector: ${h.ok ? "ok" : "down"}${statusSuffix}`,
      `in-flight: not visible through connector client`,
    ].join("\n");
    const event = channelMessage({
      secretHex: identity.secretHex,
      auth: identity.auth,
      channel,
      content,
      replyTo,
    });
    await publish(event);
  }

  async function handleDispatch(command, sourceEvent, replyTo) {
    if (!command.repo) {
      const event = channelMessage({
        secretHex: identity.secretHex,
        auth: identity.auth,
        channel,
        content:
          "need repo=<name>, e.g. `@factory dispatch WM-123 repo=factory`",
        replyTo,
      });
      await publish(event);
      return;
    }
    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId: `buzz:${sourceEvent.id}`,
      type: "factory.dispatch.requested",
      source: `connector:wattmind/buzz:${identity.npub}`,
      occurredAt: new Date(now()).toISOString(),
      payload: { repo: command.repo, ticket: command.ticket },
    };
    let reply;
    try {
      const admitted = await client.inject(envelope);
      if (admitted?.admitted) {
        reply = `queued ${command.ticket} (${command.repo}) eventId=${envelope.eventId}`;
      } else if (admitted?.duplicate) {
        reply = `noop: already admitted ${envelope.eventId}`;
      } else {
        reply = `noop: ${JSON.stringify(admitted?.errors ?? admitted)}`;
      }
    } catch (err) {
      reply = `noop: ${err.message}`;
    }
    const event = channelMessage({
      secretHex: identity.secretHex,
      auth: identity.auth,
      channel,
      content: reply,
      replyTo,
    });
    await publish(event);
  }

  async function handleChannelCommand(event) {
    if (seenIngress.has(event.id)) return;
    const command = parseCommand(event.content);
    if (!command) return;
    seenIngress.add(event.id);
    if (!isApprover(event.pubkey, identity.approvers)) return;
    if (command.type === "status") {
      await replyStatus(event.id);
      return;
    }
    if (command.type === "dispatch") {
      await handleDispatch(command, event, event.id);
    }
  }

  async function poll() {
    if (!identity.secretHex) return;
    lastPollAt = new Date(now()).toISOString();
    try {
      await flushQueue();
      try {
        const open = client.inbox.list({ status: "open" }) ?? [];
        for (const item of open) await postItem(item);
      } catch (err) {
        log(`inbox.list failed: ${err.message}`);
      }
      const postedIds = [...posted.values()].map((r) => r.eventId);
      const filters = [];
      if (postedIds.length > 0) {
        // Idempotent on the reaction/reply event id (seenIngress), so these
        // are not bounded by `since` — a reaction posted during downtime
        // must not be lost when the connector restarts.
        filters.push({ kinds: [KIND_REACTION], "#e": postedIds });
        filters.push({ kinds: [KIND_CHAT], "#e": postedIds });
      }
      filters.push({ kinds: [KIND_CHAT], "#h": [channel], since });
      const result = await queryEvents(relayUrl, filters, relayOpts());
      if (!result.ok) {
        lastErrorStatus = result.status;
        lastError = `relay POST /query ${result.status}: ${String(result.text).slice(0, 180)}`;
        return;
      }
      lastError = null;
      lastErrorStatus = null;
      lastRelayAt = lastPollAt;
      const events = Array.isArray(result.json) ? result.json : [];
      let maxCreated = since;
      for (const event of events) {
        if (!verifyEvent(event)) continue;
        if (
          typeof event.created_at === "number" &&
          event.created_at > maxCreated
        ) {
          maxCreated = event.created_at;
        }
        if (event.kind === KIND_REACTION) await handleReaction(event);
        else if (event.kind === KIND_CHAT) {
          const isThread = (event.tags ?? []).some((t) => t[0] === "e");
          if (isThread) await handleReply(event);
          else await handleChannelCommand(event);
        }
      }
      since = maxCreated;
    } catch (err) {
      lastError = err.message;
      log(`poll failed: ${err.message}`);
    }
  }

  return {
    identity,
    health,
    poll,
    onInboxEvent,
    pollSeconds,
    posted,
    queue,
    pendingReject,
    seenIngress,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
