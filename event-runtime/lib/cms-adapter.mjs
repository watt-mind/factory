/**
 * CMS Adapter for publishing approved ArticleCell drafts to CMS targets (WordPress, Nuxt, Mock).
 */

export class CmsAdapterError extends Error {
  constructor(message, { code, details } = {}) {
    super(message);
    this.name = "CmsAdapterError";
    this.code = code;
    this.details = details;
  }
}

export class CmsAdapter {
  constructor({
    target = "mock",
    baseUrl = "https://coachwatts.com",
    customPublisher = null,
  } = {}) {
    this.target = target;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.customPublisher = customPublisher;
  }

  async publishDraft({ articleCell, siteCell, revisionHash }) {
    if (!articleCell) {
      throw new CmsAdapterError("articleCell client is required", {
        code: "missing_article_cell",
      });
    }

    // 1. Read state from ArticleCell
    const state = await articleCell.getState();
    if (!state || !state.brief) {
      throw new CmsAdapterError("Article brief not found on cell", {
        code: "missing_brief",
      });
    }

    // 2. Check for existing publication receipt (Idempotency)
    if (state.receipt && state.receipt.revision_hash === revisionHash) {
      return {
        ok: true,
        alreadyPublished: true,
        receiptId: state.receipt.id,
        cmsPostId: state.receipt.cms_post_id,
        cmsUrl: state.receipt.cms_url,
        revisionHash,
      };
    }

    // 3. Verify approval receipt exists for this exact revision hash
    if (!state.approval || state.approval.revision_hash !== revisionHash) {
      throw new CmsAdapterError(
        `Revision ${revisionHash} does not have a valid approval receipt`,
        {
          code: "unapproved_revision",
          details: { approval: state.approval, revisionHash },
        },
      );
    }

    // 4. Fetch the revision body
    const revision = await articleCell.getLatestRevision();
    if (!revision || revision.hash !== revisionHash) {
      throw new CmsAdapterError(
        `Revision hash ${revisionHash} is not the latest revision on cell`,
        {
          code: "revision_mismatch",
        },
      );
    }

    const { title, slug } = state.brief;
    const cmsPostId = `cms-${slug}-${revisionHash.slice(0, 8)}`;
    const cmsUrl = `${this.baseUrl}/blog/${slug}`;

    // 5. Execute external CMS publish
    if (this.customPublisher) {
      await this.customPublisher({
        title,
        slug,
        markdown: revision.body,
        cmsPostId,
        cmsUrl,
      });
    }

    // 6. Record publication receipt in ArticleCell
    const receiptRes = await articleCell.recordPublicationReceipt({
      cmsPostId,
      cmsUrl,
      cmsStatus: "draft",
      revisionHash,
    });

    // 7. Update SiteCell coverage index if siteCell is supplied
    if (siteCell && typeof siteCell.indexCoverage === "function") {
      await siteCell
        .indexCoverage({
          slug,
          title,
          articleId: articleCell.articleId,
          url: cmsUrl,
        })
        .catch(() => {
          /* non-blocking */
        });
    }

    return {
      ok: true,
      receiptId: receiptRes.receiptId,
      cmsPostId,
      cmsUrl,
      revisionHash,
    };
  }
}
