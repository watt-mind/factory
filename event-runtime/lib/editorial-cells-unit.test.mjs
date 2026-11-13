import { describe, it, expect } from "bun:test";
import { SiteCellClient, ArticleCellClient } from "./editorial-cells.mjs";
import { CellClient } from "./cell-client.mjs";
import { createMockCellFetch } from "./mock-cells.mjs";

describe("Editorial Cells Pure In-Memory Unit Test (No live server, no subprocess)", () => {
  it("executes full editorial workflow 100% in-memory", async () => {
    // Injected in-memory mock fetch
    const mockFetch = createMockCellFetch();

    // 1. SiteCell Policy
    const site = new SiteCellClient({
      endpoint: "http://mock-cell.local",
      siteId: "coachwatts.com",
      fetch: mockFetch,
    });

    await site.setPolicy({
      tone: "Authoritative endurance coaching",
      audience: "Cyclists and runners",
      pillars: ["Physiology", "Nutrition"],
      safetyRules: ["No unreferenced medical claims"],
    });

    const snapshot = await site.getSnapshot();
    expect(snapshot.policy.tone).toContain("endurance coaching");

    // 2. Propose & Claim Topic
    await site.proposeTopics([
      {
        id: "topic-zone2-training",
        title: "Zone 2 Training: Mitochondrial Biogenesis Guide",
        slug: "zone-2-mitochondrial-biogenesis",
        angle: "Why low intensity builds aerobic base",
        priority: 10,
      },
    ]);

    await site.createArticle({
      topicId: "topic-zone2-training",
      articleId: "article:coachwatts:zone2-guide",
    });

    // 3. ArticleCell Brief & Research
    const article = new ArticleCellClient({
      endpoint: "http://mock-cell.local",
      articleId: "coachwatts:zone2-guide",
      fetch: mockFetch,
    });

    await article.setBrief({
      title: "Zone 2 Training: Mitochondrial Biogenesis Guide",
      slug: "zone-2-mitochondrial-biogenesis",
      targetAudience: "Endurance athletes",
      intent: "Explain cellular adaptations of low intensity exercise",
    });

    await article.addSources([
      {
        id: "src-san-millan-2020",
        title:
          "Assessment of Metabolic Flexibility and Lactate Clearance in Elite Cyclists",
        url: "https://pubmed.ncbi.nlm.nih.gov/32298782/",
        relevanceScore: 0.99,
        claims: [
          "Zone 2 optimizes fat oxidation and clears blood lactate efficiently",
        ],
      },
    ]);

    // 4. Draft Revision 1
    const draft = await article.commitRevision({
      title: "Zone 2 Training: Mitochondrial Biogenesis Guide",
      body: "# Zone 2 Training\n\nZone 2 training stimulates mitochondrial volume density...",
      revisionNumber: 1,
    });
    expect(draft.ok).toBe(true);

    // 5. Review & Approval
    const review = await article.submitReview({
      revisionHash: draft.revisionHash,
      verdict: "APPROVE",
      score: 0.96,
      findings: [
        {
          category: "Accuracy",
          severity: "INFO",
          description: "Solid science.",
        },
      ],
    });
    expect(review.verdict).toBe("APPROVE");

    await article.approveRevision({
      revisionHash: draft.revisionHash,
      approvedBy: "laszlo@coachwatts.com",
    });

    await article.recordPublicationReceipt({
      cmsPostId: "cw-post-1001",
      cmsUrl: "https://coachwatts.com/blog/zone-2-mitochondrial-biogenesis",
      cmsStatus: "draft",
      revisionHash: draft.revisionHash,
    });

    const state = await article.getState();
    expect(state.state).toBe("published");
    expect(state.receipt.cms_post_id).toBe("cw-post-1001");
  });

  it("enforces access: data-only allowing entity/article writes while blocking DDL schema migrations", async () => {
    const mockFetch = createMockCellFetch();

    // 1. Data-Only Client can write data normally
    const article = new ArticleCellClient({
      endpoint: "http://mock-cell.local",
      articleId: "article:coachwatts:data-only-test",
      access: "data-only",
      fetch: mockFetch,
    });

    await article.setBrief({
      title: "Data Only Article",
      slug: "data-only-test",
    });

    const brief = await article.getBrief();
    expect(brief.title).toBe("Data Only Article");

    // 2. But generic DDL migration is refused with 403 Forbidden
    const genericClient = new CellClient({
      endpoint: "http://mock-cell.local",
      cellId: "article:coachwatts:data-only-test",
      access: "data-only",
      fetch: mockFetch,
    });

    let forbiddenThrown = false;
    try {
      await genericClient.migrate({
        migrationId: "002_forbidden_migration",
        sql: "CREATE TABLE secret_table (id TEXT);",
      });
    } catch (err) {
      forbiddenThrown = true;
      expect(err.status).toBe(403);
    }
    expect(forbiddenThrown).toBe(true);
  });

  it("enforces access: read-only rejecting any mutating PUT or POST request", async () => {
    const mockFetch = createMockCellFetch();

    const readOnlySite = new SiteCellClient({
      endpoint: "http://mock-cell.local",
      siteId: "coachwatts.com",
      access: "read-only",
      fetch: mockFetch,
    });

    // Reading policy is permitted
    const policy = await readOnlySite.getPolicy();
    expect(policy).not.toBeNull();

    // Writing policy is blocked with 403
    let writeForbidden = false;
    try {
      await readOnlySite.setPolicy({
        tone: "Mutated tone",
        audience: "All",
        pillars: [],
        safetyRules: [],
      });
    } catch (err) {
      writeForbidden = true;
      expect(err.status).toBe(403);
    }
    expect(writeForbidden).toBe(true);
  });

  it("fails closed: an undeclared X-Cell-Access tier is treated as read-only", async () => {
    const mockFetch = createMockCellFetch();
    const url =
      "http://mock-cell.local/cells/" +
      encodeURIComponent("site:coachwatts.com") +
      "/v1/policy";

    // A GET without the header is still allowed …
    const readRes = await mockFetch(url, { method: "GET", headers: {} });
    expect(readRes.status).toBe(200);

    // … but a write without the header is refused, rather than defaulting to
    // the most permissive tier.
    const writeRes = await mockFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tone: "x", audience: "y" }),
    });
    expect(writeRes.status).toBe(403);
    expect((await writeRes.json()).code).toBe("read_only_access");
  });

  it("rejects an unknown X-Cell-Access tier with 400", async () => {
    const mockFetch = createMockCellFetch();
    const res = await mockFetch(
      "http://mock-cell.local/cells/" +
        encodeURIComponent("site:coachwatts.com") +
        "/v1/policy",
      { method: "GET", headers: { "X-Cell-Access": "root" } },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("unknown_access_tier");
  });
});
