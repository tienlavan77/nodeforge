// Verifies real owner-message recall stays with the selected agent and project through keyboard navigation, switching and browser reload.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";

// Uses browser keyboard input to exercise the composer's actual submit and history handlers.
async function press(page, key, windowsVirtualKeyCode) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode });
}

test("Chromium: each agent recalls only its own messages across project switches and reload", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  const directory = await mkdtemp(join(process.cwd(), ".forge/runtime/conversation-input-history-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = `import React,{useState} from './ui/nextjs/node_modules/react/index.js';
    import {createRoot} from './ui/nextjs/node_modules/react-dom/client.js';
    import {HomeChatComposer} from './ui/nextjs/components/home-chat-composer.jsx';
    localStorage.setItem('nodeforge:project-chat-history',JSON.stringify(['Legacy shared message']));window.sent=[];
    // Switches real agent and project props without remounting the outer composer by hand.
    function Fixture(){const [projectId,setProjectId]=useState('PROJECT-A');const [agentId,setAgentId]=useState('architecture-agent');return <>
      <button id='architecture' onClick={()=>setAgentId('architecture-agent')}>Architecture</button><button id='engineer' onClick={()=>setAgentId('engineer-agent')}>System Engineer</button>
      <button id='project-a' onClick={()=>setProjectId('PROJECT-A')}>Project A</button><button id='project-b' onClick={()=>setProjectId('PROJECT-B')}>Project B</button>
      <HomeChatComposer projectId={projectId} agentId={agentId} onSend={(text)=>window.sent.push({projectId,agentId,text})}/></>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const compiled = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, jsx: "automatic", alias: { react: join(process.cwd(), "ui/nextjs/node_modules/react") }, define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/app.js" ? compiled.outputFiles[0].text : '<!doctype html><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(directory, "profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("Boolean(document.querySelector('textarea'))");
  await page.click("document.querySelector('textarea')"); await press(page, "ArrowUp", 38);
  assert.equal(await page.evaluate("document.querySelector('textarea').value"), "");
  await page.send("Input.insertText", { text: "Architecture message" }); await press(page, "Enter", 13);
  await page.wait("document.querySelector('textarea').value === '' && window.sent.length === 1");
  await page.click("document.querySelector('#engineer')"); await page.click("document.querySelector('textarea')"); await press(page, "ArrowUp", 38);
  assert.equal(await page.evaluate("document.querySelector('textarea').value"), "");
  await page.send("Input.insertText", { text: "Engineer message" }); await press(page, "Enter", 13);
  await page.wait("document.querySelector('textarea').value === '' && window.sent.length === 2");
  await page.click("document.querySelector('#architecture')"); await page.click("document.querySelector('textarea')"); await press(page, "ArrowUp", 38);
  await page.wait("document.querySelector('textarea').value === 'Architecture message'");
  await page.click("document.querySelector('#project-b')"); await page.click("document.querySelector('textarea')"); await press(page, "ArrowUp", 38);
  assert.equal(await page.evaluate("document.querySelector('textarea').value"), "");
  await page.send("Input.insertText", { text: "Another project message" }); await press(page, "Enter", 13);
  await page.wait("window.sent.length === 3");
  await page.click("document.querySelector('#project-a')"); await page.click("document.querySelector('#engineer')");
  await page.click("document.querySelector('textarea')"); await press(page, "ArrowUp", 38);
  await page.wait("document.querySelector('textarea').value === 'Engineer message'");
  await page.click("document.querySelector('#architecture')");
  assert.equal(await page.evaluate("document.querySelector('textarea').value"), "");
  await page.send("Page.reload"); await page.wait("Boolean(document.querySelector('textarea'))");
  await page.click("document.querySelector('textarea')"); await press(page, "ArrowUp", 38);
  await page.wait("document.querySelector('textarea').value === 'Architecture message'");
  assert.deepEqual(await page.evaluate("JSON.parse(localStorage.getItem('nodeforge:project-chat-history:PROJECT-A:architecture-agent'))"), ["Architecture message"]);
  assert.deepEqual(await page.evaluate("JSON.parse(localStorage.getItem('nodeforge:project-chat-history:PROJECT-A:engineer-agent'))"), ["Engineer message"]);
  assert.deepEqual(await page.evaluate("JSON.parse(localStorage.getItem('nodeforge:project-chat-history:PROJECT-B:architecture-agent'))"), ["Another project message"]);
  assert.deepEqual(await page.evaluate("JSON.parse(localStorage.getItem('nodeforge:project-chat-history'))"), ["Legacy shared message"]);
  console.log(`Conversation input history verification: ${browser.version.product}, per-agent/project recall and reload PASS.`);
});
