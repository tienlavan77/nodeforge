// Verifies extensible committed browser scenarios, early capability checks and complete Node-owned receipts.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertCodingBrowserStep } from "../../src/modules/supervisor/browser/browser-coding-contract.js";
import { assertTicketVerificationContract } from "../../src/modules/governance/ticket-verification-contract.js";
import { preflightBrowserVerification } from "../../src/modules/supervisor/browser/browser-verification-preflight.js";
import { loadProjectBrowserScenario } from "../../src/modules/supervisor/browser/browser-project-scenario.js";
import { runBrowserVerification } from "../../src/modules/supervisor/browser/browser-verification-runner.js";
import { matchesBrowserEvidence } from "../../src/modules/supervisor/browser/browser-verification-evidence.js";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket/ticket-verification-plan.js";
import { buildCodexTicketPrompt, buildToolTicketPrompt, COMPLEXITY_FALLBACK } from "../../src/modules/supervisor/nodeforge-task-prompts.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

const step = { kind: "browser", criterion_ids: ["AC-1"], viewports: [375, 768, 1440], assertions: ["Button updates the status", "Viewport is the approved width"], scenario_path: "ui/nextjs/tests/example.browser.mjs" };
const moduleSource = String.raw`import assert from 'node:assert/strict';
export async function createBrowserFixture() {return {html:'<!doctype html><button onclick="document.querySelector(\'output\').textContent=\'Saved\'">Save</button><output>Idle</output>', assets:{}}}
export const browserAssertions = {
  'Button updates the status': async ({page}) => {await page.getByRole('button', {name:'Save'}).click(); assert.equal(await page.locator('output').textContent(),'Saved')},
  'Viewport is the approved width': async ({page,viewport}) => {assert.equal(await page.evaluate(()=>innerWidth),viewport)}
};`;

// Creates an isolated source archive containing the approved module without touching runtime ticket data.
async function fixture(context, source = moduleSource, insideProject = false) {
  await mkdir(join(process.cwd(), ".forge/scratch"), { recursive: true });
  const root = await mkdtemp(join(insideProject ? join(process.cwd(), ".forge/scratch/") : tmpdir(), "browser-scenario-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "ui/nextjs/tests"), { recursive: true });
  await writeFile(join(root, step.scenario_path), source);
  return root;
}

test("custom browser assertions use a schema-valid source path and schedule the real runner", async () => {
  assert.doesNotThrow(() => assertCodingBrowserStep(step));
  assert.equal(assertTicketVerificationContract({ acceptance_criteria: ["Save works"], verification_plan: [step] }), true);
  const [command] = await buildTicketVerificationPlan([], process.cwd(), { verificationPlan: [step] });
  assert.equal(command.kind, "browser");
  assert.deepEqual(JSON.parse(Buffer.from(command.argv[2], "base64url").toString()), step);
  for (const path of ["/tmp/test.browser.mjs", "ui/nextjs/tests/../outside.browser.mjs", ".forge/runtime/test.browser.mjs", "backend/src/test.browser.mjs", "ui/nextjs/tests/test.test.js", "ui/nextjs/tests/a\\b.browser.mjs"]) {
    assert.throws(() => assertCodingBrowserStep({ ...step, scenario_path: path }), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
    assert.throws(() => assertTicketVerificationContract({ acceptance_criteria: ["Save"], verification_plan: [{ ...step, scenario_path: path }] }), { code: "TICKET_VERIFICATION_PLAN_INVALID" });
  }
});

test("Codex and Claude Coder prompts include the same executable browser contract", () => {
  for (const buildPrompt of [buildCodexTicketPrompt, buildToolTicketPrompt]) {
    const prompt = buildPrompt({ acceptance_criteria: ["Save works"], verification_plan: [step] }, null, ["ui/nextjs/"], COMPLEXITY_FALLBACK);
    assert.ok(prompt.includes(`scenario_path=${step.scenario_path}`));
    assert.ok(prompt.includes("createBrowserFixture({sourceRoot,build})"));
    assert.ok(prompt.includes("browserAssertions"));
    assert.ok(step.assertions.every((assertion) => prompt.includes(assertion)));
  }
});

test("preflight accepts a planned module without requiring its future implementation", async () => {
  let checked = false;
  await preflightBrowserVerification([step], { loadTools: () => ({ chromium: { executablePath: () => "/installed/chromium", launch: async () => ({ close: async () => {} }) } }), exists: (path) => { checked = true; return path === "/installed/chromium"; } });
  assert.equal(checked, true);
  await assert.rejects(() => preflightBrowserVerification([step], { loadTools: () => ({ chromium: { executablePath: () => "/installed/chromium", launch: async () => { throw new Error("Missing host library"); } } }), exists: () => true }), (error) => error.code === "VERIFY_BROWSER_TOOLS_MISSING" && /Missing host library/.test(error.message));
  await assert.rejects(() => preflightBrowserVerification([step], { loadTools: () => ({ chromium: { executablePath: () => "/missing/chromium" } }), exists: () => false }), { code: "VERIFY_BROWSER_TOOLS_MISSING" });
  await preflightBrowserVerification([{ kind: "test" }], { loadTools: () => { throw new Error("Unneeded browser tools"); } });
  await assert.rejects(() => preflightBrowserVerification([{ ...step, scenario_path: undefined }], { loadTools: () => { throw new Error("Must validate scenario first"); } }), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
});

test("unsupported browser requirements fail before workspace mutation or Coder reservation", async () => {
  const unexpected = () => { throw new Error("Preflight must happen before mutation/agent selection"); };
  const integration = createNodeforgeTaskIntegration({ supervisorManager: { startTask: unexpected }, eventBus: { publish: unexpected }, handoffQueue: { enqueue: unexpected }, agentResolver: { resolveAvailable: unexpected }, agentOccupancy: { claim: unexpected }, resolveTicketWorkspace: unexpected });
  await assert.rejects(integration.submitTicket({ ticket: { id: "TICKET-BROWSER", verification_plan: [{ ...step, scenario_path: undefined }] } }), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
});

test("committed module must exist and implement every assertion instead of exporting a claimed receipt", async (context) => {
  const root = await fixture(context, "export const browserAssertions = {}; export const receipt = {passed:true};");
  await assert.rejects(loadProjectBrowserScenario(step, root), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
  await assert.rejects(loadProjectBrowserScenario({ ...step, scenario_path: "ui/nextjs/tests/missing.browser.mjs" }, root), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
  await writeFile(join(root, step.scenario_path), "export function createBrowserFixture() {} export const browserAssertions = {'Button updates the status':()=>{}};");
  // A new module path avoids the ESM cache and simulates a separate committed archive.
  await writeFile(join(root, "ui/nextjs/tests/incomplete.browser.mjs"), "export function createBrowserFixture() {} export const browserAssertions = {'Button updates the status':()=>{}};");
  await assert.rejects(loadProjectBrowserScenario({ ...step, scenario_path: "ui/nextjs/tests/incomplete.browser.mjs" }, root), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
});

test("scenario symlinks may not read another source revision or escape the archive", async (context) => {
  const root = await fixture(context);
  const other = await fixture(context);
  const path = join(root, "ui/nextjs/tests/link.browser.mjs");
  await symlink(join(other, step.scenario_path), path);
  await assert.rejects(loadProjectBrowserScenario({ ...step, scenario_path: "ui/nextjs/tests/link.browser.mjs" }, root), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
});

test("Chromium preflight launches and closes the installed browser before Coder work", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1", timeout: 30000 }, async () => {
  await preflightBrowserVerification([step], { projectRoot: process.cwd() });
});

test("Chromium executes every custom assertion at every approved viewport", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1", timeout: 60000 }, async (context) => {
  const root = await fixture(context, moduleSource, true);
  const receipt = await runBrowserVerification({ step, sourceRoot: root, projectRoot: process.cwd() });
  assert.equal(matchesBrowserEvidence(step, receipt), true);
  assert.equal(receipt.results.length, 3);
  assert.ok(receipt.results.every((result) => result.assertions.length === 2));
});

test("Chromium rejects failed behavior, uncaught page errors and external requests", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1", timeout: 60000 }, async (context) => {
  const cases = [
    moduleSource.replace("textContent=\\'Saved\\'", "textContent=\\'Wrong\\'"),
    moduleSource.replace("<output>Idle</output>", "<output>Idle</output><script>throw new Error(42)</script>")
  ];
  for (const source of cases) {
    assert.notEqual(source, moduleSource);
    const root = await fixture(context, source, true);
    await assert.rejects(runBrowserVerification({ step, sourceRoot: root, projectRoot: process.cwd() }), /Browser assertion failed at 375px/);
  }
  const blocked = await fixture(context, moduleSource.replace("assert.equal(await page.evaluate(()=>innerWidth),viewport)", "assert.equal(await page.evaluate(async()=>{try {await fetch('http://127.0.0.1:1/private'); return false} catch(error) {return error instanceof TypeError}}),true)"), true);
  const receipt = await runBrowserVerification({ step, sourceRoot: blocked, projectRoot: process.cwd() });
  assert.equal(matchesBrowserEvidence(step, receipt), true);
});
