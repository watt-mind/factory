/** Shared HTTP primitives for the loopback control API. */

/** §14 size limit: a control-plane payload has no business being megabytes. */
const MAX_BODY_BYTES = 1024 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

export function parseJson(buffer) {
  try {
    return { value: JSON.parse(buffer.toString("utf8")) };
  } catch (err) {
    return { error: `invalid JSON body: ${err.message}` };
  }
}

/** Loopback host validation (OPS-408): defend against DNS rebinding. */
export function isLoopbackHost(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") return false;
  const raw = hostHeader.trim();
  let host;
  if (raw.startsWith("[")) {
    const closeBracket = raw.indexOf("]");
    if (closeBracket === -1) return false;
    host = raw.slice(1, closeBracket);
  } else {
    host = raw.split(":")[0];
  }
  const lower = host.toLowerCase();
  return (
    lower === "127.0.0.1" ||
    lower.startsWith("127.") ||
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower.endsWith(".local")
  );
}

/** Loopback Origin validation (OPS-408, WM-61): defend against CSRF. */
export function isLoopbackOrigin(originHeader) {
  if (!originHeader || typeof originHeader !== "string") return false;
  try {
    const url = new URL(originHeader);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "127.0.0.1" ||
      host.startsWith("127.") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}
