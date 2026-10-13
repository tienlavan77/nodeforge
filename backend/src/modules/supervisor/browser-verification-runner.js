// Runs approved Coding assertions in real Chromium against the committed ticket UI, never the live API.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCodingBrowserStep, CODING_BROWSER_ASSERTIONS } from "./browser-coding-contract.js";
import { verifyCodingAssertion } from "./browser-coding-scenarios.js";
import { browserStepSha } from "./browser-verification-evidence.js";

// Loads explicitly installed browser tools without downloading packages or browser binaries during a ticket RUN.
export function loadBrowserTools(projectRoot) {
  const toolsRoot = join(projectRoot, "node_modules");
  const require = createRequire(join(projectRoot, "package.json"));
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
    return { chromium: require(join(toolsRoot, "playwright")).chromium, build: require(join(toolsRoot, "esbuild")).build, versions: { playwright: require(join(toolsRoot, "playwright/package.json")).version, esbuild: require(join(toolsRoot, "esbuild/package.json")).version } };
  } catch (error) {
    throw Object.assign(new Error(`Browser tools are unavailable: ${error.message}. Run pnpm install at the project root, then pnpm browser:install before ticket verification.`), { code: "VERIFY_BROWSER_TOOLS_MISSING", cause: error });
  }
}

// Serves only the compiled ticket fixture on loopback and returns a complete assertion-by-viewport receipt.
export async function runBrowserVerification({ step, sourceRoot, projectRoot, tools = loadBrowserTools(projectRoot) }) {
  assertCodingBrowserStep(step);
  if (resolve(sourceRoot) !== resolve(projectRoot) && !resolve(sourceRoot).startsWith(`${resolve(projectRoot)}${sep}`)) throw new Error("Browser source must remain inside the project root.");
  const bundle = await tools.build({ entryPoints: [fileURLToPath(new URL("./browser-coding-fixture.js", import.meta.url))], bundle: true, write: false, outdir: "browser-fixture", platform: "browser", jsx: "automatic",
    alias: { "@ticket/ui": resolve(sourceRoot, "ui/nextjs"), react: resolve(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": resolve(sourceRoot, "ui/nextjs/node_modules/react-dom") }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  const assets = new Map(bundle.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]));
  const server = createServer((request, response) => {
    if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); }
    else if (assets.has(request.url)) { response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : "text/javascript"); response.end(assets.get(request.url)); }
    else { response.statusCode = 404; response.end(); }
  });
  let browser;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await tools.chromium.launch({ headless: true });
    const results = [];
    for (const width of step.viewports) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(10000);
        await page.goto(origin);
        if (await page.evaluate(() => window.innerWidth) !== width) throw new Error("Browser viewport does not match the approved width.");
        await page.waitForFunction(() => Boolean(window.browserFixture?.update));
        for (const assertion of step.assertions) await verifyCodingAssertion(CODING_BROWSER_ASSERTIONS.indexOf(assertion), page);
        if (errors.length) throw new Error(`Browser page errors: ${errors.join("; ")}`);
        results.push({ viewport: width, assertions: [...step.assertions], passed: true });
      } finally { await context.close(); }
    }
    return { step_sha256: browserStepSha(step), browser_version: browser.version(), tool_versions: tools.versions, results };
  } finally {
    try { await browser?.close(); }
    finally { if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); }
  }
}
