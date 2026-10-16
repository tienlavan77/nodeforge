// Checks owner-facing planning recovery directs discovery failures to retry, not session reload.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { architectureClarificationError } from "../../../ui/nextjs/lib/architecture-clarification-error.js";

// Distinguishes Architecture evidence failures from stale owner sessions without leaking technical English to the wizard.
test("discovery errors explain missing evidence and never suggest reload", () => {
  for (const error of [{ code: "DISCOVERY_INCOMPLETE", message: "Repository discovery must complete" }, { error_code: "DISCOVERY_INCOMPLETE" }]) {
    const result = architectureClarificationError(error);
    assert.equal(result.reload, false);
    assert.match(result.message, /Thử tạo plan lại/);
    assert.match(result.message, /dẫn chứng/);
    assert.doesNotMatch(result.message, /Repository discovery must complete/);
  }
  assert.equal(architectureClarificationError({ code: "ARCHITECTURE_SESSION_STALE" }).reload, true);
  assert.equal(architectureClarificationError({ code: "ARCHITECTURE_SOURCE_CHANGED" }).reload, false);
  assert.equal(architectureClarificationError(new Error("Owner token invalid")).message, "Owner token invalid");
});

// Renders the actual failed-generation card to verify retry is reachable without re-answering questions or reloading.
test("failed discovery card presents saved decisions and a retry action rather than reload", async (context) => {
  const root = await mkdtemp(join(process.cwd(), ".forge/test-tmp/clarification-error-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "card.cjs");
  await build({ stdin: { contents: `import React from './ui/nextjs/node_modules/react/index.js'; import {renderToStaticMarkup} from './ui/nextjs/node_modules/react-dom/server.node.js'; import {ArchitectureClarificationCard} from './ui/nextjs/components/architecture-clarification-card.jsx'; exports.render = session => renderToStaticMarkup(<ArchitectureClarificationCard session={session} />);`, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, outfile: output, platform: "node", format: "cjs", jsx: "automatic", alias: { react: join(process.cwd(), "ui/nextjs/node_modules/react") } });
  const { render } = createRequire(import.meta.url)(output);
  const html = render({ session_id: "CLARIFY-TEST", version: 4, status: "generation_failed", error_code: "DISCOVERY_INCOMPLETE", source_path: "workflows/input.md", selections: { STORAGE: "SERVER" }, notes: {}, questions: [{ id: "STORAGE", title: "Storage", options: [{ id: "SERVER", label: "Server", description: "Saved policy" }] }] });
  assert.match(html, /Thử tạo plan lại/);
  assert.match(html, /Xem lại quyết định/);
  assert.match(html, /Saved policy/);
  assert.doesNotMatch(html, /Tải lại phiên|Repository discovery must complete/);
});
