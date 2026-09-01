import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SiteCellClient, ArticleCellClient } from "./editorial-cells.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CELLS_DIR = path.join(REPO_ROOT, "cells");
const TMP_TEST_DIR = path.resolve(
  REPO_ROOT,
  ".test-editorial-cells-" + Date.now(),
);

const TEST_PORT = 9985;
const TEST_ENDPOINT = `http://127.0.0.1:${TEST_PORT}`;

let celldProcess = null;

function startCelld(customPort = TEST_PORT, storageProjectDir = TMP_TEST_DIR) {
  return spawn(
    "celld",
    [
      "dev",
      storageProjectDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(customPort),
    ],
    {
      cwd: storageProjectDir,
      stdio: "pipe",
    },
  );
}

async function waitForHealth(endpoint = TEST_ENDPOINT, maxAttempts = 35) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${endpoint}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "healthy") return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

describe.skipIf(!Bun.which("celld"))(
  "Editorial Agent Runtime Vertical Slice",
  () => {
    beforeAll(async () => {
      if (existsSync(TMP_TEST_DIR))
        rmSync(TMP_TEST_DIR, { recursive: true, force: true });
      mkdirSync(TMP_TEST_DIR, { recursive: true });
      cpSync(CELLS_DIR, TMP_TEST_DIR, { recursive: true });

      celldProcess = startCelld(TEST_PORT, TMP_TEST_DIR);
      const healthy = await waitForHealth();
      expect(healthy).toBe(true);
    });

    afterAll(() => {
      if (celldProcess) {
        try {
          celldProcess.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      if (existsSync(TMP_TEST_DIR))
        rmSync(TMP_TEST_DIR, { recursive: true, force: true });
    });

    it("1. Initializes SiteCell policy and editorial snapshot", async () => {
      const site = new SiteCellClient({
        endpoint: TEST_ENDPOINT,
        siteId: "coachwatts.com",
      });

      // Set site policy
      const setRes = await site.setPolicy({
        tone: "Authoritative, data-driven, practical endurance coaching",
        audience: "Competitive cyclists, triathletes, and distance runners",
        pillars: [
          "Cardiovascular Physiology",
          "Training Methodology",
          "Nutrition & Recovery",
        ],
        safetyRules: [
          "No unsubstantiated medical claims",
          "Cite peer-reviewed exercise physiology",
        ],
      });
      expect(setRes.ok).toBe(true);
      expect(setRes.policyVersion).toBe(1);

      // Get snapshot
      const snapshot = await site.getSnapshot();
      expect(snapshot.policy.policyVersion).toBe(1);
      expect(snapshot.policy.pillars).toContain("Cardiovascular Physiology");
      expect(snapshot.openTopics.length).toBe(0);
    });

    it("2. Proposes topic candidates via topic-scan and claims one for creation", async () => {
      const site = new SiteCellClient({
        endpoint: TEST_ENDPOINT,
        siteId: "coachwatts.com",
      });

      // Topic scanner proposes candidates
      const proposeRes = await site.proposeTopics([
        {
          id: "topic-vo2max-intervals",
          title: "Optimizing VO2max: 30/15 vs 4x4min Intervals for Cyclists",
          slug: "optimizing-vo2max-intervals-cycling",
          angle:
            "Comparative analysis of short micro-intervals vs classic long bouts",
          priority: 9,
        },
        {
          id: "topic-carb-fueling",
          title: "High-Carb Fueling (120g/hr): Gut Training Protocols",
          slug: "high-carb-fueling-gut-training",
          angle:
            "Practical ramp-up strategy for high-carb intake during long races",
          priority: 8,
        },
      ]);
      expect(proposeRes.ok).toBe(true);
      expect(proposeRes.createdCount).toBe(2);

      // Assert open topics listed
      const topicsList = await site.listTopics("proposed");
      expect(topicsList.count).toBe(2);
      expect(topicsList.topics[0].id).toBe("topic-vo2max-intervals");

      // Operator claims and initializes ArticleCell
      const claimRes = await site.createArticle({
        topicId: "topic-vo2max-intervals",
        articleId: "article:coachwatts:vo2max-intervals-001",
      });
      expect(claimRes.ok).toBe(true);

      const updatedTopics = await site.listTopics("in_progress");
      expect(updatedTopics.count).toBe(1);
      expect(updatedTopics.topics[0].article_id).toBe(
        "article:coachwatts:vo2max-intervals-001",
      );
    });

    it("3. Executes full ArticleCell lifecycle: Research -> Draft -> Review -> Approval -> Publication", async () => {
      const article = new ArticleCellClient({
        endpoint: TEST_ENDPOINT,
        articleId: "coachwatts:vo2max-intervals-001",
      });

      // Step A: Set Brief
      await article.setBrief({
        title: "Optimizing VO2max: 30/15 vs 4x4min Intervals for Cyclists",
        slug: "optimizing-vo2max-intervals-cycling",
        targetAudience: "Competitive endurance cyclists",
        intent:
          "Provide definitive scientific guidance on interval duration selection",
      });

      let state = await article.getState();
      expect(state.state).toBe("briefed");
      expect(state.brief.title).toContain("Optimizing VO2max");

      // Step B: Research Agent appends scientific sources
      await article.addSources([
        {
          id: "src-ronnestad-2015",
          title:
            "Short intervals induce superior training adaptations compared with long intervals in cyclists",
          url: "https://pubmed.ncbi.nlm.nih.gov/24714538/",
          relevanceScore: 0.98,
          claims: [
            "30/15 micro-intervals elicit greater fractional utilization of VO2max",
            "Power output at 4mmol/L lactate increased significantly more with short intervals",
          ],
        },
        {
          id: "src-seiler-2013",
          title:
            "Adaptations to aerobic interval training: Interactive effects of interval duration and intensity",
          url: "https://pubmed.ncbi.nlm.nih.gov/21812822/",
          relevanceScore: 0.95,
          claims: [
            "Accumulating 32 minutes of work at 90-95% HRmax induces robust mitochondrial biogenesis",
            "4x8min bouts balanced physiological stress and recovery better than 4x16min",
          ],
        },
      ]);

      state = await article.getState();
      expect(state.state).toBe("researched");
      expect(state.sourcesCount).toBe(2);

      // Step C: Draft Agent commits Markdown revision 1
      const draftMarkdown = `# Optimizing VO2max: 30/15 vs 4x4min Intervals for Cyclists

For decades, exercise physiologists and endurance coaches have debated the optimal interval format for eliciting maximal aerobic adaptations.

## The Physiology of VO2max Stimulation
To stimulate maximal cardiovascular adaptations, an athlete must accumulate time near their maximal oxygen uptake ($>90\\% \\text{VO}_2\\text{max}$).

### Short Micro-Intervals (30s on / 15s off)
Research by Rønnestad et al. (2015) demonstrated that repeated short work bouts allow athletes to sustain a higher average power output while maintaining high cardiac output and myoglobin oxygenation.

### Long Work Bouts (4x4min to 4x8min)
Classic Seiler intervals (4x4 to 4x8 minutes at 90-95% HRmax) provide continuous metabolic strain that forces mitochondrial density adaptations.

## Practical Recommendations
1. **Early Season:** Utilize 4x4min to build fundamental aerobic capacity.
2. **Pre-Race Peak:** Switch to 3x(10x30/15s) to maximize top-end fractional utilization without excessive neuro-muscular fatigue.
`;

      const draftRes = await article.commitRevision({
        title: "Optimizing VO2max: 30/15 vs 4x4min Intervals for Cyclists",
        body: draftMarkdown,
        revisionNumber: 1,
      });
      expect(draftRes.ok).toBe(true);
      expect(draftRes.revisionNumber).toBe(1);
      expect(draftRes.wordCount).toBeGreaterThan(100);
      const revHash = draftRes.revisionHash;

      const latestRev = await article.getLatestRevision();
      expect(latestRev.hash).toBe(revHash);

      // Step D: Review Agent submits quality review verdict
      const reviewRes = await article.submitReview({
        revisionHash: revHash,
        verdict: "APPROVE",
        score: 0.94,
        findings: [
          {
            category: "Physiology",
            severity: "INFO",
            description: "Clear citations to Rønnestad and Seiler.",
          },
          {
            category: "Structure",
            severity: "INFO",
            description: "Strong actionable takeaways.",
          },
        ],
        instructions: "Draft is publication ready.",
      });
      expect(reviewRes.ok).toBe(true);
      expect(reviewRes.verdict).toBe("APPROVE");

      state = await article.getState();
      expect(state.state).toBe("reviewed");
      expect(state.latestReview.score).toBe(0.94);

      // Step E: Operator approves exact revision hash
      const approveRes = await article.approveRevision({
        revisionHash: revHash,
        approvedBy: "laszlo@coachwatts.com",
        reason: "Excellent scientific rigor and clear coach advice.",
      });
      expect(approveRes.ok).toBe(true);
      expect(approveRes.state).toBe("approved");

      // Step F: Closed CMS adapter records draft publication receipt
      const pubRes = await article.recordPublicationReceipt({
        cmsPostId: "cw-post-9842",
        cmsUrl:
          "https://coachwatts.com/blog/optimizing-vo2max-intervals-cycling",
        cmsStatus: "draft",
        revisionHash: revHash,
      });
      expect(pubRes.ok).toBe(true);
      expect(pubRes.state).toBe("published");

      const finalState = await article.getState();
      expect(finalState.state).toBe("published");
      expect(finalState.receipt.cms_post_id).toBe("cw-post-9842");
    });

    it("4. Verifies persistence across daemon restart", async () => {
      // Kill running celld process
      if (celldProcess) {
        celldProcess.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 600));
      }

      // Start new celld instance on a new port using the SAME storage directory
      const NEW_PORT = 9989;
      const NEW_ENDPOINT = `http://127.0.0.1:${NEW_PORT}`;
      celldProcess = startCelld(NEW_PORT, TMP_TEST_DIR);

      const healthy = await waitForHealth(NEW_ENDPOINT);
      expect(healthy).toBe(true);

      // Read back SiteCell
      const site = new SiteCellClient({
        endpoint: NEW_ENDPOINT,
        siteId: "coachwatts.com",
      });
      const snapshot = await site.getSnapshot();
      expect(snapshot.policy.pillars).toContain("Cardiovascular Physiology");

      // Read back ArticleCell
      const article = new ArticleCellClient({
        endpoint: NEW_ENDPOINT,
        articleId: "coachwatts:vo2max-intervals-001",
      });
      const finalState = await article.getState();
      expect(finalState.state).toBe("published");
      expect(finalState.sourcesCount).toBe(2);
      expect(finalState.latestRevision.title).toContain("Optimizing VO2max");
      expect(finalState.receipt.cms_post_id).toBe("cw-post-9842");
    });
  },
);
