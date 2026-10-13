// Verifies the running Agents page uses its UI proxy, displays timeout errors and retries through real Chromium interactions.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";

test("Chromium: Agents loads through the UI proxy and recovers from a stalled API without page reload", { skip: process.env.NODEFORGE_AGENTS_BROWSER_TEST !== "1" }, async (context) => {
  const root = await mkdtemp(`${process.cwd()}/.forge/runtime/agents-browser-`);
  const browser = await launchProjectChromium(`${root}/profile`);
  context.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
  const page = await browser.page("about:blank");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__agentsProbe={hang:true,urls:[],streamUrls:[],errors:[]};window.EventSource=new Proxy(window.EventSource,{construct(Target,args){window.__agentsProbe.streamUrls.push(String(args[0]));return Reflect.construct(Target,args)}});const nativeFetch=window.fetch;window.fetch=(url,init={})=>{if(new URL(url,location.href).pathname==='/forge/v1/agents'){window.__agentsProbe.urls.push(String(url));if(window.__agentsProbe.hang)return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})})}return nativeFetch(url,init)};const nativeTimeout=window.setTimeout;window.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,delay===15000?100:delay,...args);window.addEventListener('error',event=>window.__agentsProbe.errors.push(event.message));` });
  await page.send("Page.navigate", { url: process.env.NODEFORGE_AGENTS_UI_URL ?? "http://127.0.0.1:3000/agents" });
  await page.wait("Boolean(document.querySelector('.agents-directory-state.error'))");
  assert.match(await page.evaluate("document.querySelector('.agents-directory-state.error').textContent"), /timed out/);
  assert.equal(await page.evaluate("Boolean([...document.querySelectorAll('.agents-directory-state')].find(element=>element.textContent.includes('Loading agents')))"), false);
  await page.evaluate("window.__agentsProbe.hang=false");
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Retry')");
  await page.wait("Boolean(document.querySelector('.agents-card-grid') && document.querySelectorAll('.agent-directory-card').length>1)");
  await page.wait("Boolean(document.querySelector('[title=\"Project stream connected.\"]'))");
  const probe = await page.evaluate("({urls:window.__agentsProbe.urls,streamUrls:window.__agentsProbe.streamUrls,errors:window.__agentsProbe.errors,origin:location.origin,alert:!!document.querySelector('.agents-directory-state.error'),cards:document.querySelectorAll('.agent-directory-card').length,navigationCount:performance.getEntriesByType('navigation').length})");
  assert.equal(probe.alert, false); assert.equal(probe.navigationCount, 1); assert.deepEqual(probe.errors, []);
  assert.ok(probe.urls.length > 1); assert.ok(probe.urls.every((url) => new URL(url, probe.origin).origin === probe.origin));
  assert.ok(probe.streamUrls.length > 0); assert.ok(probe.streamUrls.every((url) => new URL(url, probe.origin).origin === probe.origin));
  console.log(`Agents browser verification: ${browser.version.product}, ${probe.cards - 1} profiles, same-origin timeout and Retry PASS`);
});
