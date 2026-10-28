// Verifies Option B project readiness locking across the full intake pipeline (AC-3, AC-6).
// Business purpose: guarantees that a project's readiness state remains locked at `running` throughout `preflight` -> `comment_normalization` -> `scan/index` -> `resolve` -> `embedding`, and transitions to `ready` only after all stages have completed 100%.
// Technical description: coordinates deterministic barriers inside `coderNormalizer` and `embeddingProvider.embed` during `lifecycle.rest.intake`, asserting stage progression and `readiness === "running"` before final settlement.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { generateEnglishCommentsForFile } from "../../src/modules/projects/project-comment-normalization.js";

const watcherFactory = () => {
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  setImmediate(() => watcher.emit("ready"));
  return watcher;
};

test("AC-3 & AC-6: Option B locks project readiness at running across preflight, comment_normalization, scan/index, resolve, and embedding until 100% complete", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "nf-option-b-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const projectRoot = join(baseDir, "option-b-project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "orders.js"), "export function processOrder(id) {\n  return { id, processed: true };\n}\n", "utf8");

  let onCommentStageEntered;
  let releaseCommentStage;
  const commentStageEntered = new Promise((resolve) => { onCommentStageEntered = resolve; });
  const commentStageGate = new Promise((resolve) => { releaseCommentStage = resolve; });

  let onEmbeddingStageEntered;
  let releaseEmbeddingStage;
  const embeddingStageEntered = new Promise((resolve) => { onEmbeddingStageEntered = resolve; });
  const embeddingStageGate = new Promise((resolve) => { releaseEmbeddingStage = resolve; });

  const observedStages = [];
  const lifecycle = await createProjectLifecycle({
    catalogPath: join(baseDir, "global", "projects.json"),
    logger: { error() {}, warn() {} },
    runtimeOptions: {
      onProgress(snapshot) {
        if (observedStages.at(-1) !== snapshot.stage) observedStages.push(snapshot.stage);
      }
    },
    startRuntime: (options) => startProjectRuntime({
      ...options,
      watcherFactory,
      coderNormalizer: async ({ path, content }) => {
        onCommentStageEntered();
        await commentStageGate;
        return generateEnglishCommentsForFile(path, content, { commentLanguage: "en" });
      },
      embeddingProvider: {
        async embed() {
          onEmbeddingStageEntered();
          await embeddingStageGate;
          return [1, 0, 0];
        }
      }
    })
  });
  t.after(() => lifecycle.close());

  const intakePromise = lifecycle.rest.intake({ name: "Option B Service", root: projectRoot });

  // 1. Inspect state while paused in comment_normalization.
  await commentStageEntered;
  const dirDuringComments = lifecycle.directory();
  assert.equal(dirDuringComments.length, 1);
  assert.equal(dirDuringComments[0].readiness, "running");
  assert.equal(dirDuringComments[0].operation.status, "running");
  assert.equal(await lifecycle.get(projectRoot), undefined);

  const listDuringComments = await lifecycle.rest.list();
  assert.equal(listDuringComments[0].readiness, "running");
  assert.equal(listDuringComments[0].progress.stage, "comment_normalization");
  assert.equal(listDuringComments[0].progress.status, "running");
  assert.equal(listDuringComments[0].progress.stages.preflight, "completed");
  assert.equal(listDuringComments[0].progress.stages.comment_normalization, "running");
  assert.equal(listDuringComments[0].progress.stages["scan/index"], "pending");
  assert.equal(listDuringComments[0].progress.stages.resolve, "pending");
  assert.equal(listDuringComments[0].progress.stages.embedding, "pending");

  // 2. Release comment_normalization and inspect state while paused in embedding (after scan/index and resolve).
  releaseCommentStage();
  await embeddingStageEntered;

  const dirDuringEmbedding = lifecycle.directory();
  assert.equal(dirDuringEmbedding[0].readiness, "running");
  assert.equal(await lifecycle.get(projectRoot), undefined);

  const listDuringEmbedding = await lifecycle.rest.list();
  assert.equal(listDuringEmbedding[0].readiness, "running");
  assert.equal(listDuringEmbedding[0].progress.stage, "embedding");
  assert.equal(listDuringEmbedding[0].progress.status, "running");
  assert.equal(listDuringEmbedding[0].progress.stages.preflight, "completed");
  assert.equal(listDuringEmbedding[0].progress.stages.comment_normalization, "completed");
  assert.equal(listDuringEmbedding[0].progress.stages["scan/index"], "completed");
  assert.equal(listDuringEmbedding[0].progress.stages.resolve, "completed");
  assert.equal(listDuringEmbedding[0].progress.stages.embedding, "running");

  // 3. Release embedding and verify transition to ready only after 100% completion.
  releaseEmbeddingStage();
  const admitted = await intakePromise;
  assert.ok(admitted.project_id);

  const dirAfter = lifecycle.directory();
  assert.equal(dirAfter[0].readiness, "ready");
  assert.equal(dirAfter[0].operation.status, "succeeded");
  assert.ok(await lifecycle.get(projectRoot));

  const listAfter = await lifecycle.rest.list();
  assert.equal(listAfter[0].readiness, "ready");
  assert.equal(listAfter[0].progress.status, "succeeded");
  assert.equal(listAfter[0].progress.embedding.status, "succeeded");
  assert.equal(listAfter[0].progress.embedding.succeeded, 1);
  for (const stageName of ["preflight", "comment_normalization", "scan/index", "resolve", "embedding", "startup/readiness"]) {
    assert.equal(listAfter[0].progress.stages[stageName], "completed", `Expected stage ${stageName} to be completed`);
  }

  for (const requiredStage of ["preflight", "comment_normalization", "scan/index", "resolve", "embedding"]) {
    assert.ok(observedStages.includes(requiredStage), `Expected stage ${requiredStage} in progression ${observedStages.join(" -> ")}`);
  }
  assert.ok(observedStages.indexOf("preflight") < observedStages.indexOf("comment_normalization"));
  assert.ok(observedStages.indexOf("comment_normalization") < observedStages.indexOf("scan/index"));
  assert.ok(observedStages.indexOf("scan/index") < observedStages.indexOf("resolve"));
  assert.ok(observedStages.indexOf("resolve") < observedStages.indexOf("embedding"));
});
