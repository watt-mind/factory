/**
 * Typed client adapters for Editorial Agent Runtime Cells (SiteCell & ArticleCell).
 */

export class EditorialCellError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.name = "EditorialCellError";
    this.status = status;
    this.data = data;
  }
}

async function doFetch(url, { method = "GET", body = null, fetch = globalThis.fetch } = {}) {
  const headers = { Accept: "application/json" };
  let reqBody = null;
  if (body !== null && body !== undefined) {
    headers["Content-Type"] = "application/json";
    reqBody = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: reqBody });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new EditorialCellError(data.message || `Cell HTTP error ${res.status}`, {
      status: res.status,
      data
    });
  }
  return data;
}

export class SiteCellClient {
  constructor({ endpoint, siteId, fetch = globalThis.fetch } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.siteId = siteId.startsWith("site:") ? siteId : `site:${siteId}`;
    this._fetch = fetch;
  }

  _url(path) {
    const cleanPath = path.replace(/^\/+/, "");
    return `${this.endpoint}/cells/${encodeURIComponent(this.siteId)}/${cleanPath}`;
  }

  async getPolicy() {
    return doFetch(this._url("v1/policy"), { fetch: this._fetch });
  }

  async setPolicy(policy) {
    return doFetch(this._url("v1/policy"), { method: "PUT", body: policy, fetch: this._fetch });
  }

  async getSnapshot() {
    return doFetch(this._url("v1/snapshot"), { fetch: this._fetch });
  }

  async proposeTopics(candidates) {
    return doFetch(this._url("v1/topics/propose"), {
      method: "POST",
      body: { candidates },
      fetch: this._fetch
    });
  }

  async createArticle({ topicId, articleId }) {
    return doFetch(this._url("v1/articles/create"), {
      method: "POST",
      body: { topicId, articleId },
      fetch: this._fetch
    });
  }

  async listTopics(status = null) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return doFetch(this._url(`v1/topics${query}`), { fetch: this._fetch });
  }
}

export class ArticleCellClient {
  constructor({ endpoint, articleId, fetch = globalThis.fetch } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.articleId = articleId.startsWith("article:") ? articleId : `article:${articleId}`;
    this._fetch = fetch;
  }

  _url(path) {
    const cleanPath = path.replace(/^\/+/, "");
    return `${this.endpoint}/cells/${encodeURIComponent(this.articleId)}/${cleanPath}`;
  }

  async getState() {
    return doFetch(this._url("v1/state"), { fetch: this._fetch });
  }

  async getBrief() {
    return doFetch(this._url("v1/brief"), { fetch: this._fetch });
  }

  async setBrief(brief) {
    return doFetch(this._url("v1/brief"), { method: "PUT", body: brief, fetch: this._fetch });
  }

  async addSources(sources) {
    return doFetch(this._url("v1/sources"), { method: "POST", body: { sources }, fetch: this._fetch });
  }

  async commitRevision({ title, body, revisionNumber }) {
    return doFetch(this._url("v1/revisions"), {
      method: "POST",
      body: { title, body, revisionNumber },
      fetch: this._fetch
    });
  }

  async getLatestRevision() {
    return doFetch(this._url("v1/revisions/latest"), { fetch: this._fetch });
  }

  async submitReview({ revisionHash, verdict, score, findings, instructions }) {
    return doFetch(this._url("v1/reviews"), {
      method: "POST",
      body: { revisionHash, verdict, score, findings, instructions },
      fetch: this._fetch
    });
  }

  async approveRevision({ revisionHash, approvedBy, reason }) {
    return doFetch(this._url("v1/approvals"), {
      method: "POST",
      body: { revisionHash, approvedBy, reason },
      fetch: this._fetch
    });
  }

  async recordPublicationReceipt({ cmsPostId, cmsUrl, cmsStatus, revisionHash }) {
    return doFetch(this._url("v1/publication-receipt"), {
      method: "POST",
      body: { cmsPostId, cmsUrl, cmsStatus, revisionHash },
      fetch: this._fetch
    });
  }
}
