import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GH_SECRET,
  PV,
  SECRET,
  apiClient,
  deregisterWorker,
  envelope,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  makeServer,
  mkdirSync,
  mkdtempSync,
  observedModelFromTranscript,
  openDb,
  os,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  rejection,
  repoNamesFromInput,
  registry,
  runOnce,
  sign,
  startApi,
  utimesSync,
  writeFileSync,
} from "./api-test-helpers.mjs";

describe("model surfacing on run views (WM-221)", () => {
  test("reads the claude harness's own init line", () => {
    const head = [
      `{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}`,
      `{"type":"system","subtype":"init","cwd":"/tmp/ws","model":"claude-opus-5[1m]","tools":["Read"]}`,
      `{"type":"assistant","message":{"content":[]}}`,
      ``,
    ].join("\n");
    expect(observedModelFromTranscript(head)).toBe("claude-opus-5[1m]");
  });

  test("rejoins pi's provider so the observed id compares to the pinned one", () => {
    const head = [
      `{"type":"session","version":3,"id":"01a0"}`,
      `{"type":"message_start","message":{"role":"assistant","provider":"openai-codex","model":"gpt-5.6-terra"}}`,
      ``,
    ].join("\n");
    expect(observedModelFromTranscript(head)).toBe(
      "openai-codex/gpt-5.6-terra",
    );
  });

  test("leaves an already-qualified id alone and tolerates a missing provider", () => {
    const qualified = `{"type":"message_start","message":{"provider":"openai-codex","model":"openai-codex/gpt-5.6-luna"}}\n\n`;
    expect(observedModelFromTranscript(qualified)).toBe(
      "openai-codex/gpt-5.6-luna",
    );
    const bare = `{"type":"message_start","message":{"model":"gpt-5.6-luna"}}\n\n`;
    expect(observedModelFromTranscript(bare)).toBe("gpt-5.6-luna");
  });

  test("a transcript that names no model is null, never a guess", () => {
    expect(observedModelFromTranscript("")).toBeNull();
    expect(observedModelFromTranscript(null)).toBeNull();
    // `model` appears, but as prose inside a prompt — not a harness field.
    expect(
      observedModelFromTranscript(
        `{"type":"user","message":{"content":[{"text":"pick a \\"model\\""}]}}\n\n`,
      ),
    ).toBeNull();
  });

  test("survives the partial last line a bounded read always ends on", () => {
    const truncated =
      `{"type":"system","subtype":"init","model":"claude-opus-5[1m]"}\n` +
      `{"type":"assistant","message":{"model":"claude-son`;
    expect(observedModelFromTranscript(truncated)).toBe("claude-opus-5[1m]");
    // The model only appears on the severed line: unparseable, so unknown.
    expect(
      observedModelFromTranscript(
        `{"type":"system","subtype":"init","model":"claude-op`,
      ),
    ).toBeNull();
  });

  test("the run list carries the plan-time pins and the detail carries observedModel", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-home-"));
    const { db, server, port, close } = await makeServer({
      env: { name: "test", home },
    });
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "model-1" }));
      planAdmittedEvents(db, registry, {
        policyVersion: PV,
        adapterOverride: "fake",
      });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      const summary = await runOnce(
        db,
        registry,
        { pi: fake, fake },
        {
          workspacesRoot: path.join(home, "workspaces"),
          artifactStore: path.join(home, "artifacts"),
          owner: "test-worker",
          policyVersion: PV,
        },
      );

      const row = (await client.runs()).runs.find(
        (r) => r.runId === summary.runId,
      );
      // Flattened out of the spec so the Model column never reads the run detail.
      expect(row).toHaveProperty("modelTier");
      expect(row).toHaveProperty("model");
      const spec = JSON.parse(
        db
          .query(`SELECT spec_json FROM runs WHERE run_id = ?`)
          .get(summary.runId).spec_json,
      );
      expect(row.modelTier).toBe(spec.modelTier ?? null);
      expect(row.model).toBe(spec.model ?? null);

      const view = await client.run(summary.runId);
      // Always present, so the panel distinguishes "not recorded" from an old
      // runtime; the fake adapter's transcript names no model, hence null.
      expect(view).toHaveProperty("observedModel");
      expect(view.observedModel).toBeNull();

      // And the value really comes off the stored bytes: rewrite that same
      // transcript with a harness init line and the next read reports it.
      const transcript = view.result.artifacts.find(
        (a) => a.kind === "transcript",
      );
      expect(transcript).toBeTruthy();
      writeFileSync(
        path.join(home, "artifacts", transcript.sha256),
        `{"type":"system","subtype":"init","model":"claude-opus-5[1m]"}\n`,
        "utf8",
      );
      expect((await client.run(summary.runId)).observedModel).toBe(
        "claude-opus-5[1m]",
      );
    } finally {
      close();
    }
  });
});
