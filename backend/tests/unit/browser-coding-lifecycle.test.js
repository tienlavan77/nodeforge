// Verifies registered new Coding lifecycle assertions run in Chromium against an isolated copy of the exact failed ticket commit.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { CODING_BROWSER_ASSERTIONS, assertCodingBrowserStep } from "../../src/modules/supervisor/browser-coding-contract.js";
import { runBrowserVerification } from "../../src/modules/supervisor/browser-verification-runner.js";
import { matchesBrowserEvidence } from "../../src/modules/supervisor/browser-verification-evidence.js";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket-verification-plan.js";
import { verifyCodingAssertion } from "../../src/modules/supervisor/browser-coding-scenarios.js";
import { launchProjectChromium } from "../helpers/chromium-cdp.js";

const step = { criterion_ids: ["AC-1", "AC-2", "AC-4", "AC-6", "AC-7", "AC-9", "AC-10"], kind: "browser", viewports: [375, 768, 1440], assertions: CODING_BROWSER_ASSERTIONS.slice(10, 13) };

// Reuses real scenario functions through the project's existing Chromium CDP helper when the shell lacks Playwright's Node runtime.
function scenarioPage(page) {
  const evaluate = (callback, input) => page.evaluate(`(${callback.toString()})(${JSON.stringify(input) ?? "undefined"})`);
  const waitForFunction = (callback, input) => page.wait(`Boolean((${callback.toString()})(${JSON.stringify(input) ?? "undefined"}))`);
  // Wraps real DOM queries and Chromium input, without substituting registry behavior or scenario outcomes.
  function locator(expression) {
    return {
      count: () => page.evaluate(`${expression}.length`),
      textContent: () => page.evaluate(`${expression}[0]?.textContent`),
      getAttribute: (name) => page.evaluate(`${expression}[0]?.getAttribute(${JSON.stringify(name)})`),
      evaluate: (callback) => page.evaluate(`(${callback.toString()})(${expression}[0])`),
      focus: () => page.evaluate(`${expression}[0].focus()`),
      click: () => page.click(`${expression}[0]`),
      locator: (selector) => locator(`Array.from(${expression}[0].querySelectorAll(${JSON.stringify(selector)}))`)
    };
  }
  return { evaluate, waitForFunction,
    locator: (selector) => locator(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`),
    getByRole: (role, { name }) => {
      assert.equal(role, "button");
      return locator(`Array.from(document.querySelectorAll('button')).filter(element=>element.getAttribute('aria-label')===${JSON.stringify(name)})`);
    },
    keyboard: { press: async (key) => {
      assert.equal(key, "Enter");
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    } }
  };
}

// Serves the committed production fixture and runs shared scenario assertions on actual DOM and keyboard/pointer input.
async function verifyWithCdp(context, sourceRoot, indices, widths) {
  const bundle = await build({ entryPoints: ["backend/src/modules/supervisor/browser-coding-fixture.js"], bundle: true, write: false, outdir: "browser-fixture", platform: "browser", jsx: "automatic",
    alias: { "@ticket/ui": join(sourceRoot, "ui/nextjs"), react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  const assets = new Map(bundle.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]));
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url?.endsWith(".js") ? "application/javascript" : request.url?.endsWith(".css") ? "text/css" : "text/html");
    response.end(assets.get(request.url) ?? '<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await mkdir(join(process.cwd(), ".forge/scratch"), { recursive: true });
  const profile = await mkdtemp(join(process.cwd(), ".forge/scratch/coding-lifecycle-profile-"));
  context.after(() => rm(profile, { recursive: true, force: true }));
  const browser = await launchProjectChromium(profile);
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}`);
  await page.wait("Boolean(window.browserFixture?.update)");
  for (const width of widths) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.evaluate("window.innerWidth"), width);
    for (const index of indices) await verifyCodingAssertion(index, scenarioPage(page));
  }
  return browser.version.product;
}

test("new approved identity and lifecycle prose is registered without accepting unrelated assertions", async () => {
  assert.equal(step.assertions.length, 3);
  assert.doesNotThrow(() => assertCodingBrowserStep(step));
  const commands = await buildTicketVerificationPlan([], process.cwd(), { verificationPlan: [step] });
  assert.deepEqual(commands[0].browser_step, step);
  for (const invalid of ["Close all panels", step.assertions[2] + " Skip reopening", "Skip storage failures"]) {
    assert.throws(() => assertCodingBrowserStep({ ...step, assertions: [invalid] }), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
  }
});

test("Chromium: exact ticket commit satisfies the three approved assertions at every approved viewport", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  await mkdir(join(process.cwd(), ".forge/scratch"), { recursive: true });
  const sourceRoot = await mkdtemp(join(process.cwd(), ".forge/scratch/browser-coding-lifecycle-"));
  context.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const commit = process.env.NODEFORGE_BROWSER_COMMIT ?? "HEAD";
  const archive = execFileSync("git", ["archive", commit, "ui/nextjs"], { cwd: process.cwd(), env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, maxBuffer: 20 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", sourceRoot], { input: archive });
  await symlink(join(process.cwd(), "ui/nextjs/node_modules"), join(sourceRoot, "ui/nextjs/node_modules"), "dir");
  const version = await verifyWithCdp(context, sourceRoot, [10, 11, 12], step.viewports);
  console.log(`Committed Coding lifecycle scenario verification via CDP: ${commit}, ${version}, 3 assertions x 3 viewports PASS (not a ticket artifact)`);
});

test("Chromium: existing identity/activity panel scenarios retain their registered behavior", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  await verifyWithCdp(context, process.cwd(), Array.from({ length: 9 }, (_, index) => index), [375, 1440]);
});

test("Playwright: production runner emits the complete approved receipt", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" || Number(process.versions.node.split(".")[0]) < 20 }, async () => {
  const receipt = await runBrowserVerification({ step, sourceRoot: process.cwd(), projectRoot: process.cwd() });
  assert.equal(matchesBrowserEvidence(step, receipt), true);
});
