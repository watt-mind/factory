/**
 * Typed client adapters for Editorial Agent Runtime Cells (SiteCell & ArticleCell).
 */

export class EditorialCellError extends Error {
  constructor(message, { status, data, code } = {}) {
    super(message);
    this.name = "EditorialCellError";
    this.status = status;
    this.data = data;
    this.code = code || (data && data.code) || "cell_error";
  }
}

async function doFetch(
  url,
  { method = "GET", body = null, headers = {}, fetch = globalThis.fetch } = {},
) {
  const reqHeaders = { Accept: "application/json", ...headers };
  let reqBody = null;
  if (body !== null && body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    reqBody = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers: reqHeaders, body: reqBody });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new EditorialCellError(
      data.message || `Cell HTTP error ${res.status}`,
      {
        status: res.status,
        data,
        code: data.code || (res.status === 403 ? "forbidden" : "http_error"),
      },
    );
  }
  return data;
}

export class SiteCellClient {
  constructor({
    endpoint,
    siteId,
    access = "malleable",
    fetch = globalThis.fetch,
    authToken = null,
  } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.siteId = siteId.startsWith("site:") ? siteId : `site:${siteId}`;
    this.access = access;
    this._fetch = fetch;
    // Shared-secret bearer token for the loopback cell spike. Defaults to the
    // daemon's own CELL_AUTH_TOKEN so a client in the same environment works
    // without extra wiring.
    this.authToken =
      authToken ?? globalThis.process?.env?.CELL_AUTH_TOKEN ?? null;
  }

  _headers() {
    return {
      "X-Cell-Access": this.access,
      ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
    };
  }

  _url(path) {
    const cleanPath = path.replace(/^\/+/, "");
    return `${this.endpoint}/cells/${encodeURIComponent(this.siteId)}/${cleanPath}`;
  }

  async getPolicy() {
    return doFetch(this._url("v1/policy"), {
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async setPolicy(policy) {
    return doFetch(this._url("v1/policy"), {
      method: "PUT",
      body: policy,
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async getSnapshot() {
    return doFetch(this._url("v1/snapshot"), {
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async proposeTopics(candidates) {
    return doFetch(this._url("v1/topics/propose"), {
      method: "POST",
      body: { candidates },
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async createArticle({ topicId, articleId }) {
    return doFetch(this._url("v1/articles/create"), {
      method: "POST",
      body: { topicId, articleId },
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async listTopics(status = null) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return doFetch(this._url(`v1/topics${query}`), {
      headers: this._headers(),
      fetch: this._fetch,
    });
  }
}

export class ArticleCellClient {
  constructor({
    endpoint,
    articleId,
    access = "malleable",
    fetch = globalThis.fetch,
    authToken = null,
  } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.articleId = articleId.startsWith("article:")
      ? articleId
      : `article:${articleId}`;
    this.access = access;
    this._fetch = fetch;
    // See SiteCellClient — same loopback-only shared-secret stop-gap.
    this.authToken =
      authToken ?? globalThis.process?.env?.CELL_AUTH_TOKEN ?? null;
  }

  _headers() {
    return {
      "X-Cell-Access": this.access,
      ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
    };
  }

  _url(path) {
    const cleanPath = path.replace(/^\/+/, "");
    return `${this.endpoint}/cells/${encodeURIComponent(this.articleId)}/${cleanPath}`;
  }

  async getState() {
    return doFetch(this._url("v1/state"), {
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async getBrief() {
    return doFetch(this._url("v1/brief"), {
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async setBrief(brief) {
    return doFetch(this._url("v1/brief"), {
      method: "PUT",
      body: brief,
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async addSources(sources) {
    return doFetch(this._url("v1/sources"), {
      method: "POST",
      body: { sources },
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async commitRevision({ title, body, revisionNumber }) {
    return doFetch(this._url("v1/revisions"), {
      method: "POST",
      body: { title, body, revisionNumber },
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async getLatestRevision() {
    return doFetch(this._url("v1/revisions/latest"), {
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async submitReview({ revisionHash, verdict, score, findings, instructions }) {
    return doFetch(this._url("v1/reviews"), {
      method: "POST",
      body: { revisionHash, verdict, score, findings, instructions },
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async approveRevision({ revisionHash, approvedBy, reason }) {
    return doFetch(this._url("v1/approvals"), {
      method: "POST",
      body: { revisionHash, approvedBy, reason },
      headers: this._headers(),
      fetch: this._fetch,
    });
  }

  async recordPublicationReceipt({
    cmsPostId,
    cmsUrl,
    cmsStatus,
    revisionHash,
  }) {
    return doFetch(this._url("v1/publication-receipt"), {
      method: "POST",
      body: { cmsPostId, cmsUrl, cmsStatus, revisionHash },
      headers: this._headers(),
      fetch: this._fetch,
    });
  }
}
