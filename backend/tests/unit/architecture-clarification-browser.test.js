// Verifies the real question wizard persists choices through reload and writes those decisions into an unapproved plan.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { clarificationFixture, question } from "./architecture-clarification-fixture.js";
import { launchProjectChromium } from "../helpers/chromium-cdp.js";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { routeArchitectureClarifications } from "../../src/transport/http/forge-v1-clarification-routes.js";
import { readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";

test("Chromium: explicit answers, reload recovery, review and confirm generate exactly one source-bound plan", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  const fixture = await clarificationFixture(context, [question, { ...question, id: "CLOSURE", title: "Đóng panel đang chạy?", options: [{ id: "HIDE", label: "Chỉ ẩn panel", description: "Execution vẫn tiếp tục" }, { id: "STOP", label: "Dừng execution", description: "Hủy công việc khi đóng panel" }], recommended_option_id: "HIDE" }]);
  const pending = await fixture.start();
  const ownerChatService = createOwnerChatService({ bus: { send() {}, sendFast() {} }, commandService: fixture.command, agentStream: async function* ({ payload }) { yield { text: await fixture.provider(payload.text) }; } });
  const source = `import React,{useState,useEffect} from "./ui/nextjs/node_modules/react/index.js"; import {createRoot} from "./ui/nextjs/node_modules/react-dom/client.js"; import {ArchitectureClarificationCard} from "./ui/nextjs/components/architecture-clarification-card.jsx";
  function Fixture(){ const [session,setSession]=useState(null); async function refresh(){const result=await fetch('/session');const value=await result.json();setSession(value);window.session=value;} window.refresh=refresh; useEffect(()=>{refresh()},[]);
  async function save(current,selections,notes,token,cancel){const response=await fetch('/session',{method:'PATCH',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({version:current.version,source_sha256:current.source_sha256,selections,notes,cancel})});const result=await response.json();if(!response.ok)throw new Error(result.message);setSession(result);window.session=result;return result;}
  async function confirm(current,token){const response=await fetch('/confirm',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({version:current.version,source_sha256:current.source_sha256})});const result=await response.json();if(!response.ok)throw new Error(result.message);await refresh();}
  return session?<ArchitectureClarificationCard session={session} onSave={save} onConfirm={confirm} onReload={refresh} onReanalyze={refresh}/>:null; } createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const compiled = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, jsx: "automatic", alias: { react: join(process.cwd(), "ui/nextjs/node_modules/react") }, define: { "process.env.NODE_ENV": '"production"' } });
  const styles = await build({ entryPoints: ["ui/nextjs/app/globals.css"], bundle: true, write: false });
  const css = styles.outputFiles[0].text;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/app.js") { response.setHeader("Content-Type", "application/javascript"); response.end(compiled.outputFiles[0].text); return; }
      if (request.url === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}body{min-width:0;max-width:780px;margin:0 auto;padding:12px}.claude-composer-wrap{margin-inline:auto}</style></head><body><div class="claude-composer-wrap"><div id="root" class="architecture-clarifications"></div></div><script src="/app.js"></script></body></html>`); return; }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") { response.end(JSON.stringify(await fixture.command.planningSessions.get(pending.session_id))); return; }
      let text = ""; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const parts = ["conversations", "CONV-A", "plan-clarifications", pending.session_id, ...(request.url === "/confirm" ? ["confirm"] : [])];
      const result = await routeArchitectureClarifications({ method: request.method, parts, body, projectId: "PROJECT-A", conversation: { id: "CONV-A", project_id: "PROJECT-A", agent_id: "architecture-manager" }, headers: request.headers, ownerChatService, planOwnerAuth: { verify: (headers) => { if (headers.authorization !== "Bearer TEST-OWNER") throw new Error("Unauthorized test owner"); return "OWNER-A"; } } });
      response.statusCode = result.status; response.end(JSON.stringify(result.body));
    } catch (error) { response.statusCode = error.statusCode ?? 500; response.end(JSON.stringify({ code: error.code, message: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(fixture.root, "browser-profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("window.session && document.querySelectorAll('input[type=radio]').length === 2");
  assert.equal(await page.evaluate("document.querySelectorAll('input[type=radio]:checked').length"), 0);
  assert.equal(fixture.records.length, 0);
  await page.click("document.querySelectorAll('.architecture-clarification-option')[1]");
  await page.wait("document.querySelectorAll('input[type=radio]')[1].checked");
  assert.deepEqual((await fixture.command.planningSessions.get(pending.session_id)).selections, {});
  assert.equal(await page.evaluate("document.body.textContent.includes('chưa được lưu')"), true);
  await page.evaluate("window.refresh()");
  await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await page.evaluate("document.querySelectorAll('input[type=radio]')[1].checked"), true);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    for (const width of [1280, 375]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 375 });
      assert.equal(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
      assert.equal(await page.evaluate("[...document.querySelectorAll('.architecture-clarification-card, .architecture-clarification-card *')].every(element => getComputedStyle(element).fontSize === '12px')"), true);
      assert.equal(await page.evaluate("document.querySelector('.architecture-clarification-card').scrollWidth <= document.querySelector('.architecture-clarification-card').clientWidth"), true);
      assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.architecture-clarification-option:has(input:checked)')).borderTopColor === getComputedStyle(document.querySelector('input[type=radio]')).accentColor"), true);
      assert.equal(await page.evaluate("getComputedStyle(document.querySelector('textarea')).backgroundColor === getComputedStyle(document.querySelector('input[type=password]')).backgroundColor"), true);
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(`.forge/runtime/architecture-clarification-${theme}-${width}.png`, Buffer.from(screenshot.data, "base64"));
    }
  }
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate("document.documentElement.dataset.theme = 'dark'");
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Tiếp theo →')");
  await page.wait("document.querySelector('legend').textContent.includes('Đóng panel')");
  await page.click("document.querySelectorAll('.architecture-clarification-option')[0]");
  await page.wait("document.querySelectorAll('input[type=radio]')[0].checked");
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xem lại quyết định')");
  await page.wait("document.querySelector('h4')?.textContent === 'Xem lại quyết định'");
  assert.equal(await page.evaluate("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xác nhận & tạo plan').disabled"), true);
  assert.deepEqual((await fixture.command.planningSessions.get(pending.session_id)).selections, {});
  await page.send("Page.reload");
  await page.wait("window.session && document.querySelectorAll('input[type=radio]').length === 2");
  assert.equal(await page.evaluate("document.querySelectorAll('input[type=radio]:checked').length"), 0);
  await page.click("document.querySelector('input[type=password]')"); await page.send("Input.insertText", { text: "TEST-OWNER" });
  await page.click("document.querySelectorAll('input[type=radio]')[1]");
  await page.wait("window.session.selections.STORAGE === 'SERVER'");
  await page.send("Page.reload");
  await page.wait("window.session && document.querySelectorAll('input[type=radio]:checked').length === 1");
  assert.equal(await page.evaluate("document.querySelector('input[type=password]').value"), "");
  assert.equal(await page.evaluate("window.session.selections.STORAGE"), "SERVER");
  await page.click("document.querySelector('input[type=password]')"); await page.send("Input.insertText", { text: "TEST-OWNER" });
  await page.click("document.querySelector('textarea')"); await page.send("Input.insertText", { text: "Owner chọn đồng bộ server" });
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Tiếp theo →')");
  await page.wait("document.querySelector('legend').textContent.includes('Đóng panel')");
  assert.equal(await page.evaluate("document.querySelectorAll('input[type=radio]:checked').length"), 0);
  await page.click("document.querySelectorAll('input[type=radio]')[0]"); await page.wait("window.session.selections.CLOSURE === 'HIDE'");
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xem lại quyết định')");
  await page.wait("document.querySelector('h4')?.textContent === 'Xem lại quyết định'");
  assert.equal(await page.evaluate("document.body.textContent.includes('Owner chọn đồng bộ server')"), true);
  assert.equal(fixture.records.length, 0);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xác nhận & tạo plan')");
  await page.wait("window.session.status === 'completed'");
  assert.equal(await page.evaluate("Boolean(document.querySelector('.architecture-clarification-card'))"), false);
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0].status, "awaiting_human_approval");
  const decisions = readArchitectureDecisions(fixture.records[0].markdown);
  assert.deepEqual(decisions.decisions.map((decision) => decision.option_id), ["SERVER", "HIDE"]);
  assert.equal(decisions.owner_id, "OWNER-A");
  assert.equal(decisions.decisions[0].owner_note, "Owner chọn đồng bộ server");
  const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
  await writeFile(".forge/runtime/architecture-clarification-browser.png", Buffer.from(screenshot.data, "base64"));
  console.log(`Architecture owner-choice browser verification: ${browser.version.product}, explicit selection and reload PASS`);
});
