import { describe, it, expect } from "bun:test";
import { SiteCellClient, ArticleCellClient } from "./editorial-cells.mjs";
import { createMockCellFetch } from "./mock-cells.mjs";

describe("Editorial Cells Pure In-Memory Unit Test (No live server, no subprocess)", () => {
  it("executes full editorial workflow 100% in-memory", async () => {
    // Injected in-memory mock fetch
    const mockFetch = createMockCellFetch();

    // 1. SiteCell Policy
    const site = new SiteCellClient({
      endpoint: "http://mock-cell.local",
      siteId: "coachwatts.com",
      fetch: mockFetch
    });

    await site.setPolicy({
      tone: "Authoritative endurance coaching",
      audience: "Cyclists and runners",
      pillars: ["Physiology", "Nutrition"],
      safetyRules: ["No unreferenced medical claims"]
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
        priority: 10
      }
    ]);

    await site.createArticle({
      topicId: "topic-zone2-training",
      articleId: "article:coachwatts:zone2-guide"
    });

    // 3. ArticleCell Brief & Research
    const article = new ArticleCellClient({
      endpoint: "http://mock-cell.local",
      articleId: "coachwatts:zone2-guide",
      fetch: mockFetch
    });

    await article.setBrief({
      title: "Zone 2 Training: Mitochondrial Biogenesis Guide",
      slug: "zone-2-mitochondrial-biogenesis",
      targetAudience: "Endurance athletes",
      intent: "Explain cellular adaptations of low intensity exercise"
    });

    await article.addSources([
      {
        id: "src-san-millan-2020",
        title: "Assessment of Metabolic Flexibility and Lactate Clearance in Elite Cyclists",
        url: "https://pubmed.ncbi.nlm.nih.gov/32298782/",
        relevanceScore: 0.99,
        claims: ["Zone 2 optimizes fat oxidation and clears blood lactate efficiently"]
      }
    ]);

    // 4. Draft Revision 1
    const draft = await article.commitRevision({
      title: "Zone 2 Training: Mitochondrial Biogenesis Guide",
      body: "# Zone 2 Training\n\nZone 2 training stimulates mitochondrial volume density...",
      revisionNumber: 1
    });
    expect(draft.ok).toBe(true);

    // 5. Review & Approval
    const review = await article.submitReview({
      revisionHash: draft.revisionHash,
      verdict: "APPROVE",
      score: 0.96,
      findings: [{ category: "Accuracy", severity: "INFO", description: "Solid science." }]
    });
    expect(review.verdict).toBe("APPROVE");

    await article.approveRevision({
      revisionHash: draft.revisionHash,
      approvedBy: "laszlo@coachwatts.com"
    });

    await article.recordPublicationReceipt({
      cmsPostId: "cw-post-1001",
      cmsUrl: "https://coachwatts.com/blog/zone-2-mitochondrial-biogenesis",
      cmsStatus: "draft",
      revisionHash: draft.revisionHash
    });

    const state = await article.getState();
    expect(state.state).toBe("published");
    expect(state.receipt.cms_post_id).toBe("cw-post-1001");
  });
});
