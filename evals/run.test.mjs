/**
 * Tests for the eval case runner (watt-mind/factory#1073).
 *
 * Covers discovery, the pass/fail exit contract, `--skill` filtering, timeout
 * handling, and `--compare` regression detection — all against a fake grader
 * and a fake subject. No test makes a real model call.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverCases, readCase } from "./lib/discover.mjs";
import { parseVerdict, buildGraderPrompt } from "./lib/grade.mjs";
import { readYamlScalar, resolveGraderModel } from "./lib/policy.mjs";
import { buildRunRecord, compareRuns } from "./lib/results.mjs";
import { main, runEvals, withDeadline } from "./run.mjs";

/** Build a throwaway factory-shaped tree: <tmp>/evals + <tmp>/shared/skills. */
function makeFixture() {
  const factoryRoot = mkdtempSync(path.join(tmpdir(), "evals-fixture-"));
  const root = path.join(factoryRoot, "evals");
  const addCase = (skill, name, { input = "in", expect = "out" } = {}) => {
    const dir = path.join(root, "cases", skill, name);
    mkdirSync(dir, { recursive: true });
    if (input !== null) writeFileSync(path.join(dir, "input.md"), input);
    if (expect !== null) writeFileSync(path.join(dir, "expect.md"), expect);
  };
  const addSkill = (skill) => {
    const dir = path.join(factoryRoot, "shared", "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `# ${skill}\nDo the thing.`);
  };
  return {
    factoryRoot,
    root,
    addCase,
    addSkill,
    cleanup: () => rmSync(factoryRoot, { recursive: true, force: true }),
  };
}

/** A fake grader: PASS unless the expect text contains a word in `failOn`. */
const fakeGrader =
  (failOn = []) =>
  async ({ expect: expectText }) => {
    const fail = failOn.some((w) => expectText.includes(w));
    return {
      pass: !fail,
      reason: fail ? `violates ${failOn}` : "meets expectations",
    };
  };

const fakeSubject = async ({ input }) => ({ response: `did: ${input}` });

describe("discoverCases", () => {
  test("finds cases across skills, sorted, with skill source resolved", () => {
    const fx = makeFixture();
    try {
      fx.addSkill("skill-a");
      fx.addCase("skill-a", "beta");
      fx.addCase("skill-a", "alpha");
      fx.addCase("skill-b", "only");
      const cases = discoverCases({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
      });
      expect(cases.map((c) => `${c.skill}/${c.name}`)).toEqual([
        "skill-a/alpha",
        "skill-a/beta",
        "skill-b/only",
      ]);
      const a = cases.find((c) => c.skill === "skill-a");
      expect(a.skillSource).toBe(
        path.join("shared", "skills", "skill-a", "SKILL.md"),
      );
      // skill-b has no SKILL.md — source is honestly null, not invented
      expect(cases.find((c) => c.skill === "skill-b").skillSource).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  test("--skill filters to one skill's cases", () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "one");
      fx.addCase("skill-b", "two");
      const cases = discoverCases({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
        skill: "skill-b",
      });
      expect(cases).toHaveLength(1);
      expect(cases[0].skill).toBe("skill-b");
    } finally {
      fx.cleanup();
    }
  });

  test("a case missing expect.md is surfaced as an error, not dropped", () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "broken", { expect: null });
      const [c] = discoverCases({ root: fx.root, factoryRoot: fx.factoryRoot });
      expect(c.error).toBe("missing expect.md");
      expect(() => readCase(c)).toThrow();
    } finally {
      fx.cleanup();
    }
  });
});

describe("grade parsing", () => {
  test("parses PASS/FAIL and the one-line reason", () => {
    expect(parseVerdict("VERDICT: PASS\nREASON: names a real command")).toEqual(
      {
        pass: true,
        reason: "names a real command",
      },
    );
    expect(
      parseVerdict("verdict: fail\nreason: promoted a blocked ticket"),
    ).toEqual({ pass: false, reason: "promoted a blocked ticket" });
  });

  test("unparseable grader output fails closed", () => {
    const v = parseVerdict("I think it's probably fine?");
    expect(v.pass).toBe(false);
  });

  test("grader prompt carries both expectations and response", () => {
    const p = buildGraderPrompt({ expect: "MUST cite", response: "cited X" });
    expect(p).toContain("MUST cite");
    expect(p).toContain("cited X");
  });
});

describe("runEvals — pass/fail exit contract", () => {
  test("all pass -> anyFail false", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "one");
      fx.addCase("skill-a", "two");
      const res = await runEvals({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
        runSkill: fakeSubject,
        grade: fakeGrader([]),
        graderModel: "fake-model",
        persist: false,
      });
      expect(res.anyFail).toBe(false);
      expect(res.record.summary).toEqual({ total: 2, passed: 2, failed: 0 });
    } finally {
      fx.cleanup();
    }
  });

  test("any fail -> anyFail true and the record records the reason", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "good", { expect: "fine" });
      fx.addCase("skill-a", "bad", { expect: "TRAP here" });
      const res = await runEvals({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
        runSkill: fakeSubject,
        grade: fakeGrader(["TRAP"]),
        graderModel: "fake-model",
        persist: false,
      });
      expect(res.anyFail).toBe(true);
      const bad = res.record.cases.find((c) => c.name === "bad");
      expect(bad.pass).toBe(false);
      expect(bad.reason).toContain("violates");
    } finally {
      fx.cleanup();
    }
  });

  test("a malformed case fails the run rather than being skipped", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "broken", { input: null });
      const res = await runEvals({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
        runSkill: fakeSubject,
        grade: fakeGrader([]),
        graderModel: "fake-model",
        persist: false,
      });
      expect(res.anyFail).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe("runEvals — timeout handling", () => {
  test("a hung grader fails its case, not the run", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "hang");
      fx.addCase("skill-a", "ok");
      const hungGrader = ({ testCase }) =>
        testCase.name === "hang"
          ? new Promise(() => {}) // never resolves
          : Promise.resolve({ pass: true, reason: "fine" });
      const res = await runEvals({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
        runSkill: fakeSubject,
        grade: hungGrader,
        graderModel: "fake-model",
        perCaseTimeoutMs: 30,
        persist: false,
      });
      const hang = res.record.cases.find((c) => c.name === "hang");
      const ok = res.record.cases.find((c) => c.name === "ok");
      expect(hang.pass).toBe(false);
      expect(hang.reason).toContain("timed out");
      expect(ok.pass).toBe(true); // the run continued past the hang
    } finally {
      fx.cleanup();
    }
  });

  test("total cap fails remaining cases instead of hanging the run", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "a");
      fx.addCase("skill-a", "b");
      // clock jumps past the cap after the first case
      let ticks = 0;
      const clock = () => {
        ticks += 1;
        return ticks === 1 ? 0 : 10_000;
      };
      const res = await runEvals({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
        runSkill: fakeSubject,
        grade: fakeGrader([]),
        graderModel: "fake-model",
        totalTimeoutMs: 100,
        clock,
        persist: false,
      });
      expect(res.totalCapped).toBe(true);
      expect(res.anyFail).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe("withDeadline", () => {
  test("resolves to the timeout value when the promise never settles", async () => {
    const v = await withDeadline(new Promise(() => {}), 10, () => "timed-out");
    expect(v).toBe("timed-out");
  });
  test("passes the resolved value through when it settles first", async () => {
    const v = await withDeadline(
      Promise.resolve("done"),
      1000,
      () => "timed-out",
    );
    expect(v).toBe("done");
  });
});

describe("compareRuns", () => {
  test("detects a regression: passed before, fails now", () => {
    const before = buildRunRecord({
      graderModel: "m",
      timestamp: "t0",
      cases: [
        { skill: "s", name: "keep", pass: true },
        { skill: "s", name: "drop", pass: true },
      ],
    });
    const after = buildRunRecord({
      graderModel: "m",
      timestamp: "t1",
      cases: [
        { skill: "s", name: "keep", pass: true },
        { skill: "s", name: "drop", pass: false },
      ],
    });
    const diff = compareRuns(before, after);
    expect(diff.regressions).toEqual(["s/drop"]);
    expect(diff.fixed).toEqual([]);
  });

  test("reports fixed, added and removed cases", () => {
    const before = buildRunRecord({
      graderModel: "m",
      cases: [
        { skill: "s", name: "flaky", pass: false },
        { skill: "s", name: "gone", pass: true },
      ],
    });
    const after = buildRunRecord({
      graderModel: "m",
      cases: [
        { skill: "s", name: "flaky", pass: true },
        { skill: "s", name: "fresh", pass: true },
      ],
    });
    const diff = compareRuns(before, after);
    expect(diff.fixed).toEqual(["s/flaky"]);
    expect(diff.added).toEqual(["s/fresh"]);
    expect(diff.removed).toEqual(["s/gone"]);
  });
});

describe("policy — grader model pin", () => {
  test("reads a nested scalar out of simple YAML", () => {
    const yaml = ["evals:", "  grader:", '    model: "grader-x"', ""].join(
      "\n",
    );
    expect(readYamlScalar(yaml, ["evals", "grader", "model"])).toBe("grader-x");
  });

  test("falls back to models.claude.strong then the default sentinel", () => {
    const fx = makeFixture();
    try {
      const cfg = path.join(fx.factoryRoot, "config");
      mkdirSync(cfg, { recursive: true });
      writeFileSync(
        path.join(cfg, "policy.yaml"),
        ["models:", "  claude:", "    strong: strong-claude", ""].join("\n"),
      );
      const resolved = resolveGraderModel({ factoryRoot: fx.factoryRoot });
      expect(resolved.model).toBe("strong-claude");
      expect(resolved.source).toContain("models.claude.strong");
    } finally {
      fx.cleanup();
    }
  });

  test("no policy at all -> default sentinel, never a throw", () => {
    const fx = makeFixture();
    try {
      const resolved = resolveGraderModel({ factoryRoot: fx.factoryRoot });
      expect(resolved.model).toBe("default");
    } finally {
      fx.cleanup();
    }
  });
});

describe("main — CLI surface", () => {
  test("--help returns 0 and prints usage", async () => {
    const lines = [];
    const code = await main(["--help"], { out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("case runner");
  });

  test("--dry-run lists cases with skill source and makes no model calls", async () => {
    const fx = makeFixture();
    try {
      fx.addSkill("skill-a");
      fx.addCase("skill-a", "one");
      const lines = [];
      const code = await main(["--dry-run", "--root", fx.root], {
        out: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("skill-a/one");
      expect(text).toContain(path.join("shared", "skills", "skill-a"));
    } finally {
      fx.cleanup();
    }
  });

  test("exit code is 1 when a case fails (via injected fake grader)", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "trap", { expect: "TRAP" });
      const code = await main(
        ["--root", fx.root, "--json"],
        { out: () => {} },
        {
          runSkill: fakeSubject,
          grade: fakeGrader(["TRAP"]),
          persist: false,
        },
      );
      expect(code).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("exit code is 0 when every case passes", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "fine");
      const code = await main(
        ["--root", fx.root, "--json"],
        { out: () => {} },
        { runSkill: fakeSubject, grade: fakeGrader([]), persist: false },
      );
      expect(code).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  test("results are written to .results/<ts>.json", async () => {
    const fx = makeFixture();
    try {
      fx.addCase("skill-a", "fine");
      const res = await runEvals({
        root: fx.root,
        factoryRoot: fx.factoryRoot,
        runSkill: fakeSubject,
        grade: fakeGrader([]),
        graderModel: "fake-model",
      });
      expect(res.resultsFile).toBeTruthy();
      const files = readdirSync(path.join(fx.root, ".results"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.json$/);
    } finally {
      fx.cleanup();
    }
  });
});
