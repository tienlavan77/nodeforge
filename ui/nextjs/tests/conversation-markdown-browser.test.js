// Verifies legacy plain-text agent replies, streaming updates, and project Markdown file previews in a real browser.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";

test("Chromium: Markdown displays for existing and live agent replies without changing protocol metadata", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  const directory = await mkdtemp(join(process.cwd(), ".forge/runtime/conversation-markdown-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = `import React,{useState} from './ui/nextjs/node_modules/react/index.js';
    import {createRoot} from './ui/nextjs/node_modules/react-dom/client.js';
    import {ConversationResponseReveal} from './ui/nextjs/components/conversation-response-reveal.jsx';
    import {MarkdownPreviewPanel} from './ui/nextjs/components/markdown-preview-panel.jsx';
    const saved={from:'agent',content_type:'text/plain',text:'# Saved reply\\n\\n**Readable**\\n\\n[Plan](workflows/plan.md)'};
    window.saved=saved;window.reads=[];
    const client={getMarkdownFile:async(project,path)=>{window.reads.push({project,path});return {content:'# Project plan\\n\\n- Scoped work'};}};
    // Uses the page display policy while leaving the original record unchanged.
    function Fixture(){const [live,setLive]=useState('');const [path,setPath]=useState('');window.updateReply=setLive;
      return <><section id='saved'><ConversationResponseReveal text={saved.text} contentType={saved.from==='agent'?'text/markdown':'text/plain'} onMarkdownOpen={setPath}/></section>
      <section id='owner'><ConversationResponseReveal text={'# Literal owner'} contentType='text/plain'/></section>
      <section id='live'><ConversationResponseReveal text={live} contentType='text/markdown' reveal/></section>
      {path&&<MarkdownPreviewPanel client={client} projectId='PROJECT-TEST' path={path} onClose={()=>setPath('')}/>}</>;}
    createRoot(document.getElementById('root')).render(<Fixture/>);`;
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
  await page.wait("document.querySelector('#saved h1')?.textContent === 'Saved reply'");
  assert.equal(await page.evaluate("document.querySelector('#saved strong').textContent"), "Readable");
  assert.equal(await page.evaluate("document.querySelector('#owner h1')"), null);
  assert.equal(await page.evaluate("window.saved.content_type"), "text/plain");
  await page.evaluate("window.updateReply('# Live reply\\n\\n**Streaming**')");
  await page.wait("document.querySelector('#live strong')?.textContent === 'Streaming'");
  await page.click("document.querySelector('#live [aria-label=\"Show plain text\"]')");
  await page.evaluate("window.updateReply('# Live reply\\n\\n**Streaming**\\n\\n- Complete')");
  await page.wait("document.querySelector('#live .conversation-plaintext')?.textContent.endsWith('- Complete')");
  assert.equal(await page.evaluate("document.querySelector('#live li')"), null);
  assert.equal(await page.evaluate("document.querySelector('#saved h1').textContent"), "Saved reply");
  await page.click("document.querySelector('#live [aria-label=\"Show Markdown\"]')");
  await page.wait("document.querySelector('#live li')?.textContent === 'Complete'");
  await page.click("document.querySelector('#saved [aria-label=\"Show plain text\"]')");
  await page.wait("Boolean(document.querySelector('#saved .conversation-plaintext'))");
  assert.equal(await page.evaluate("document.querySelector('#saved .conversation-plaintext').textContent === window.saved.text"), true);
  assert.equal(await page.evaluate("document.querySelector('#saved h1')"), null);
  assert.equal(await page.evaluate("document.querySelector('#live li').textContent"), "Complete");
  assert.equal(await page.evaluate("window.saved.content_type"), "text/plain");
  assert.equal(await page.evaluate("document.querySelector('#owner .conversation-format-toggle')"), null);
  await page.click("document.querySelector('#saved [aria-label=\"Show Markdown\"]')");
  await page.wait("document.querySelector('#saved h1')?.textContent === 'Saved reply'");
  await page.click("document.querySelector('#saved .conversation-markdown-link')");
  await page.wait("document.querySelector('.markdown-preview-panel h1')?.textContent === 'Project plan'");
  assert.deepEqual(await page.evaluate("window.reads"), [{ project: "PROJECT-TEST", path: "workflows/plan.md" }]);
  await page.click("document.querySelector('[aria-label=\"Close Markdown preview\"]')");
  await page.wait("!document.querySelector('.markdown-preview-panel')");
});
