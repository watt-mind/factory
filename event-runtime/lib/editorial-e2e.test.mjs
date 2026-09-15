import { describe, it, expect } from "bun:test";
import { SiteCellClient, ArticleCellClient } from "./editorial-cells.mjs";
import { createMockCellFetch } from "./mock-cells.mjs";
import { CmsAdapter } from "./cms-adapter.mjs";

describe("Editorial End-to-End Workflow with CMS Publishing", () => {
  it("executes the full slice from topic scan to CMS publish with retry idempotency", async () => {
    const mockFetch = createMockCellFetch();

    // 1. Initialize SiteCell
    const site = new SiteCellClient({
      endpoint: "http://mock-cells.local",
      siteId: "editorial:site:coachwatts.com",
      fetch: mockFetch,
    });

    await site.setPolicy({
      tone: "Authoritative, data-driven endurance coaching",
      audience: "Endurance athletes",
      pillars: ["Physiology", "Nutrition & Recovery"],
      safetyRules: ["No unreferenced medical claims"],
    });

    // 2. Step 1: Topic Scan -> Propose Topics
    const proposed = await site.proposeTopics([
      {
        id: "topic-heat-prep",
        title: "Heat Acclimation Protocols for Summer Marathons",
        slug: "heat-acclimation-protocols-marathon",
        angle:
          "Plasma volume expansion through passive sauna and active training",
        priority: 9,
      },
    ]);
    expect(proposed.ok).toBe(true);

    // 3. Step 2: Claim Topic & Spawn ArticleCell
    const articleId = "editorial:article:coachwatts.com:heat-prep-001";
    await site.createArticle({
      topicId: "topic-heat-prep",
      articleId,
    });

    const article = new ArticleCellClient({
      endpoint: "http://mock-cells.local",
      articleId,
      fetch: mockFetch,
    });

    await article.setBrief({
      title: "Heat Acclimation Protocols for Summer Marathons",
      slug: "heat-acclimation-protocols-marathon",
      targetAudience: "Marathon runners and triathletes",
      intent:
        "Provide practical sauna and training guidelines for heat acclimation",
    });

    // 4. Step 3: Research Agent -> Extract Sources
    await article.addSources([
      {
        id: "src-sawka-2011",
        title: "Physiological adaptations to heat stress in athletes",
        url: "https://pubmed.ncbi.nlm.nih.gov/21808000/",
        relevanceScore: 0.98,
        claims: [
          "5-10 days of heat exposure increases plasma volume by 4.5-10%",
          "Sweating threshold shifts earlier and sweat sodium concentration decreases",
        ],
      },
    ]);

    let state = await article.getState();
    expect(state.state).toBe("researched");

    // 5. Step 4: Draft Agent -> Markdown Revision 1
    const draftRes = await article.commitRevision({
      title: "Heat Acclimation Protocols for Summer Marathons",
      body: "# Heat Acclimation Protocols for Summer Marathons\n\nAcclimating to heat stress is one of the most effective physiological interventions...",
      revisionNumber: 1,
    });
    expect(draftRes.ok).toBe(true);
    const revHash = draftRes.revisionHash;

    // 6. Step 5: Review Agent -> APPROVE Verdict
    const reviewRes = await article.submitReview({
      revisionHash: revHash,
      verdict: "APPROVE",
      score: 0.95,
      findings: [
        {
          category: "Physiology",
          severity: "INFO",
          description: "Plasma volume citations verified.",
        },
      ],
      instructions: "Approved for publication",
    });
    expect(reviewRes.verdict).toBe("APPROVE");

    // 7. Step 6: Operator Approval
    const approveRes = await article.approveRevision({
      revisionHash: revHash,
      approvedBy: "laszlo@coachwatts.com",
      reason: "Ready for blog release",
    });
    expect(approveRes.ok).toBe(true);

    // 8. Step 7: Closed CMS Adapter -> Publish Draft
    let externalCmsCalls = 0;
    const cms = new CmsAdapter({
      target: "mock",
      baseUrl: "https://coachwatts.com",
      customPublisher: async ({ title, slug }) => {
        externalCmsCalls++;
        expect(title).toContain("Heat Acclimation");
        expect(slug).toBe("heat-acclimation-protocols-marathon");
      },
    });

    const pubRes1 = await cms.publishDraft({
      articleCell: article,
      siteCell: site,
      revisionHash: revHash,
    });

    expect(pubRes1.ok).toBe(true);
    expect(pubRes1.cmsPostId).toContain("heat-acclimation-protocols-marathon");
    expect(externalCmsCalls).toBe(1);

    state = await article.getState();
    expect(state.state).toBe("published");
    expect(state.receipt.cms_post_id).toBe(pubRes1.cmsPostId);

    // 9. Step 8: Assert Idempotency (Replaying Publish Does Not Duplicate External Posts)
    const pubRes2 = await cms.publishDraft({
      articleCell: article,
      siteCell: site,
      revisionHash: revHash,
    });

    expect(pubRes2.ok).toBe(true);
    expect(pubRes2.alreadyPublished).toBe(true);
    expect(externalCmsCalls).toBe(1); // Still 1, zero duplicate external requests!
  });
});
