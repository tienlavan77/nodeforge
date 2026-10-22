// Exercise real chat controls through Escape, Discard, delayed status responses and queued messages.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: "jsx", contents: `
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SystemExecutionControls } from "./ui/nextjs/components/system-execution-controls.jsx";
import { ArchitectureExecutionControls } from "./ui/nextjs/components/architecture-execution-controls.jsx";
import { usePendingConversationQueue } from "./ui/nextjs/components/conversation-pending-queue.jsx";
import { applyOwnerExecutionDecision } from "./ui/nextjs/lib/owner-execution-decision.js";

// Mount either chat role against a server whose initial status request returns late.
window.mount = (role) => {
  const running = { conversation_id: "C", execution_id: "E", status: "running" };
  const ready = { ...running, status: "interrupted", can_continue: true, can_restart: true, can_discard: true };
  let reads = 0;
  window.actions = [];
  const client = {
    listOwnerExecutions: () => ++reads === 1 ? new Promise((resolve) => {
      window.releaseStale = () => resolve({ items: [running] });
    }) : Promise.resolve({ items: [ready] }),
    decideOwnerExecution: async (project, conversation, execution, action) => {
      window.actions.push(action);
      return { ...ready, status: action === "pause" ? "pausing" : "discarded" };
    }
  };
  // Retain the actual parent activity and queue behavior used by both workspace pages.
  function Chat() {
    const [working, setAgentTyping] = useState(true);
    const [messages, setMessages] = useState([{ correlation_id: "E", pending: true, stream: true }]);
    const [state, setChatState] = useState("");
    const [sent, setSent] = useState(0);
    const lastSentRef = useRef({ correlationId: "E" });
    const { pendingMessages, submitMessage } = usePendingConversationQueue({
      agentId: "A", scopeKey: "C", isWorking: working,
      onSend: () => setSent((count) => count + 1)
    });
    const Controls = role === "system" ? SystemExecutionControls : ArchitectureExecutionControls;
    return <><output id="working">{String(working)}</output><output id="pending">{pendingMessages.length}</output>
      <output id="sent">{sent}</output><output id="messages">{JSON.stringify(messages)}</output><output>{state}</output>
      <button id="send" onClick={() => submitMessage("next message")}>Send</button>
      <Controls client={client} projectId="P" conversationId="C" executionId="E" agentTyping={working}
        onDecision={(decision) => applyOwnerExecutionDecision({ ...decision, setAgentTyping, setMessages, setChatState, lastSentRef })} />
    </>;
  }
  createRoot(document.getElementById("root")).render(<Chat />);
};`
  }, nodePaths: [`${process.cwd()}/ui/nextjs/node_modules`], bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }
});

const browser = await chromium.launch({ headless: true });
try {
  for (const role of ["system", "architecture"]) {
    for (const queued of [false, true]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((name) => window.mount(name), role);
      await page.locator("#working").waitFor();
      if (queued) {
        await page.locator("#send").click();
        assert.equal(await page.locator("#pending").textContent(), "1");
      }
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const discard = page.getByRole("button", { name: "Discard interrupted action" });
      await discard.waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Discard interrupted action"]').disabled);
      await discard.click();
      await page.waitForFunction(() => document.querySelector("#working").textContent === "false");
      await page.evaluate(() => window.releaseStale());
      await page.waitForTimeout(600);
      assert.equal(await discard.count(), 0, "late status must not restore discarded controls");
      assert.deepEqual(await page.evaluate(() => window.actions), ["pause", "discard"]);
      assert.equal(await page.locator("#pending").textContent(), "0");
      assert.deepEqual(JSON.parse(await page.locator("#messages").textContent()), [{ correlation_id: "E", pending: false, stream: false }]);
      if (queued) assert.equal(await page.locator("#sent").textContent(), "1");
      else {
        await page.locator("#send").click();
        await page.waitForFunction(() => document.querySelector("#sent").textContent === "1");
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${role}: single Discard, stale response ignored, ${queued ? "queued message released" : "new message sent without reload"}`);
      await page.close();
    }
  }
} finally { await browser.close(); }
