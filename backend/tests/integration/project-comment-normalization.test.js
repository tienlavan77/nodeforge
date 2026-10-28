// Verifies English comment normalization and comment-only mutation safety during project intake (AC-1, AC-2, AC-5).
// Business purpose: ensures imported projects with existing source code receive English file and symbol comments (`comment_language: "en"`) before AST extraction, Purpose Summary persistence, and vector embedding, while strictly rejecting and rolling back executable code edits or file splitting (> 250 lines).
// Technical description: exercises `normalizeProjectComments`, `validateCommentOnlyMutation`, and full `createProjectLifecycle` intake against temporary project roots with uncommented, Vietnamese-commented, and > 250-line legacy files.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { purposeSummaryInput } from "../../src/modules/index/purpose-summary-input.js";
import { countBudgetLines } from "../../src/tools/agent-code-conventions.js";
import {
  inspectFileCommentNeeds,
  isEnglishComment,
  normalizeProjectComments,
  validateCommentOnlyMutation
} from "../../src/modules/projects/project-comment-normalization.js";

const createTempWorkspace = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nf-comment-norm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projectRoot = join(dir, "imported-app");
  await mkdir(projectRoot, { recursive: true });
  return { dir, projectRoot, catalogPath: join(dir, "global", "projects.json") };
};

const watcherFactory = () => {
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  setImmediate(() => watcher.emit("ready"));
  return watcher;
};

test("AC-1 & AC-5: intake scans eligible source files and normalizes English comments before AST, Purpose Summary, and embedding", async (t) => {
  const { projectRoot, catalogPath } = await createTempWorkspace(t);
  const uncommentedJs = "export function calculateInvoiceTotal(subtotal, tax) {\n  return subtotal + tax;\n}\n";
  const vietnameseJs = "// Module xử lý thanh toán đơn hàng.\n\n// Tính toán phí vận chuyển cho đơn hàng.\nexport function computeShippingFee(weight) {\n  return weight * 15;\n}\n";
  await writeFile(join(projectRoot, "billing.js"), uncommentedJs, "utf8");
  await writeFile(join(projectRoot, "shipping.js"), vietnameseJs, "utf8");

  assert.equal(inspectFileCommentNeeds("billing.js", uncommentedJs).needsNormalization, true);
  assert.equal(inspectFileCommentNeeds("shipping.js", vietnameseJs).needsNormalization, true);

  const embeddedInputs = [];
  const coderCalls = [];
  const lifecycle = await createProjectLifecycle({
    catalogPath,
    logger: { error() {}, warn() {} },
    startRuntime: (options) => startProjectRuntime({
      ...options,
      watcherFactory,
      embeddingProvider: {
        async embed(text) {
          embeddedInputs.push(text);
          return [1, 0, 0];
        }
      },
      coderNormalizer: async ({ path, content }) => {
        coderCalls.push(path);
        const result = await normalizeProjectComments({ projectRoot, force: true });
        assert.ok(result.succeeded);
        return readFile(join(projectRoot, path), "utf8");
      }
    })
  });
  t.after(() => lifecycle.close());

  const created = await lifecycle.rest.intake({ name: "Imported Billing App", root: projectRoot });
  assert.equal(created.comment_language, "en");
  assert.deepEqual(coderCalls.sort(), ["billing.js", "shipping.js"]);

  for (const fileName of ["billing.js", "shipping.js"]) {
    const updatedSource = await readFile(join(projectRoot, fileName), "utf8");
    const check = inspectFileCommentNeeds(fileName, updatedSource, { commentLanguage: "en" });
    assert.equal(check.needsNormalization, false, `Expected ${fileName} to have complete English comments`);
    const validation = validateCommentOnlyMutation(
      fileName === "billing.js" ? uncommentedJs : vietnameseJs,
      updatedSource,
      { filePath: fileName, commentLanguage: "en" }
    );
    assert.equal(validation.valid, true, validation.message ?? "");
  }

  const runtime = await lifecycle.get(projectRoot);
  assert.ok(runtime, "Runtime must be ready after intake completes");
  const files = runtime.database.all("SELECT path, summary FROM files ORDER BY path");
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.ok(file.summary, `Expected indexed file summary for ${file.path}`);
    assert.equal(isEnglishComment(file.summary), true);
  }

  const symbols = runtime.database.all("SELECT name, kind, summary, symbol_id FROM symbols ORDER BY name");
  assert.deepEqual(symbols.map((s) => s.name), ["calculateInvoiceTotal", "computeShippingFee"]);
  for (const symbol of symbols) {
    assert.ok(symbol.summary, `Expected indexed symbol summary for ${symbol.name}`);
    assert.equal(isEnglishComment(symbol.summary), true);
    const embedding = runtime.database.all("SELECT content_checksum FROM symbol_embeddings WHERE symbol_id = ?", [symbol.symbol_id])[0];
    assert.ok(embedding, `Expected vector embedding for ${symbol.name}`);
    assert.equal(embedding.content_checksum, purposeSummaryInput(symbol.summary).checksum);
  }
  assert.equal(embeddedInputs.length, 2);
  assert.ok(embeddedInputs.every((text) => isEnglishComment(text)));
});

test("AC-2: safety check allows comment-only English additions on >250-line files without splitting and rolls back executable or file-split mutations", async (t) => {
  const { projectRoot } = await createTempWorkspace(t);
  const legacyLines = [];
  for (let i = 1; i <= 265; i += 1) {
    legacyLines.push(`export var legacyCounter${i} = function(x) { return x + ${i}; };`);
  }
  const largeLegacySource = legacyLines.join("\n") + "\n";
  const largeFilePath = join(projectRoot, "legacy-monolith.js");
  await writeFile(largeFilePath, largeLegacySource, "utf8");
  assert.equal(countBudgetLines(largeLegacySource), 265);

  // 1. Rejects and rolls back an attempt by Agent Coder to split a > 250-line file into multiple files.
  await assert.rejects(
    normalizeProjectComments({
      projectRoot,
      coderNormalizer: async () => {
        await writeFile(join(projectRoot, "legacy-monolith-part2.js"), "// Part 2\nexport var extra = 1;\n", "utf8");
        return "// Header\n" + legacyLines.slice(0, 100).join("\n") + "\n";
      }
    }),
    (error) => error.code === "FILE_SPLIT_FORBIDDEN" && error.rolledBack === true
  );
  assert.equal(await readFile(largeFilePath, "utf8"), largeLegacySource);
  assert.deepEqual(await readdir(projectRoot), ["legacy-monolith.js"]);

  // 2. Rejects and rolls back an attempt by Agent Coder to modernize executable statements (var -> const or logic change).
  await assert.rejects(
    normalizeProjectComments({
      projectRoot,
      coderNormalizer: async ({ content }) => "// English file header.\n\n// English symbol comment.\n" + content.replace("export var legacyCounter1", "export const legacyCounter1")
    }),
    (error) => error.code === "EXECUTABLE_CODE_CHANGED" && error.rolledBack === true
  );
  assert.equal(await readFile(largeFilePath, "utf8"), largeLegacySource);

  // 3. Rejects and rolls back non-English comments when comment_language is "en".
  await assert.rejects(
    normalizeProjectComments({
      projectRoot,
      coderNormalizer: async ({ content }) => "// Tài liệu mô tả module bằng tiếng Việt.\n\n" + content
    }),
    (error) => error.code === "COMMENT_LANGUAGE_INVALID" && error.rolledBack === true
  );
  assert.equal(await readFile(largeFilePath, "utf8"), largeLegacySource);

  // 4. Succeeds when adding English comments only, preserving all 265 executable lines in the single file without splitting.
  const safeResult = await normalizeProjectComments({ projectRoot });
  assert.equal(safeResult.succeeded, true);
  assert.equal(safeResult.normalizedFiles, 1);
  const normalizedLarge = await readFile(largeFilePath, "utf8");
  assert.equal(countBudgetLines(normalizedLarge), 265);
  assert.deepEqual(await readdir(projectRoot), ["legacy-monolith.js"]);
  const check = validateCommentOnlyMutation(largeLegacySource, normalizedLarge, { filePath: "legacy-monolith.js", commentLanguage: "en" });
  assert.equal(check.valid, true);
});
