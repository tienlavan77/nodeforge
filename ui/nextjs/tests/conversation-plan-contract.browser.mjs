// Bundles the real Coding plan review modal and drives it with a controlled plan transport for browser proof.
// Business purpose: the owner must see, on the Coding page, exactly the Markdown plan and revision Node
// rendered in the conversation, and approving it must reach the existing decisions and handoff endpoints with
// the captured revision and SHA-256 while never granting RUN authority. Node executes this module in Chromium
// at every approved viewport; only the plan transport is replaced, while the modal, its decision controls, and
// the real URL-building client come from the committed project source.
// Technical description: the revision displayed here is produced before any expectation exists by calling the
// unchanged Node conversation rendering contract directly (parseArchitecturePlanJSON, canonicalizeArchitecturePlanJSON
// and renderArchitecturePlanMarkdown from backend/src/modules/governance/architecture-plan-json.js), then hashing
// those exact bytes the same way the real Markdown plan store does. The same computed digest is the only value
// handed to the page, so the assertions compare the modal and its outgoing requests against genuine
// Node-rendered conversation Markdown rather than handwritten fixture constants. The fixture imports
// PlanReviewModal and createNodeClient directly and serves that revision from a mocked window.fetch, so the
// assertions observe the real client request paths, Bearer token, and body identities end to end.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalizeArchitecturePlanJSON, parseArchitecturePlanJSON, renderArchitecturePlanMarkdown } from "../../../backend/src/modules/governance/architecture-plan-json.js";

const PLAN_ID = "PLAN-CONTRACT-1";

// One canonical Architecture payload in the shape the conversation planning service receives from Architecture.
const PLAN_PAYLOAD = {
  title: "Contract plan", objective: "Keep conversation, Coding UI and API bytes identical.",
  background: "Owner created the plan in chat; discovery complete over the repository. Assumption: approval stays conversation-scoped.",
  scope: ["Rendered Markdown identity", "Decision and handoff contracts"],
  outcomes: [{ id: "O6", outcome: "Identical contract bytes", acceptance_criteria: ["The rendered Markdown bytes match their recorded SHA-256"], guardrails: ["Approval never starts RUN"] }],
  evidence: [{ path: "backend/src/application/conversation-plan-approval-service.js", location: "L1", fact: "Node alone records approval." }],
  assumptions: ["Owner reviews the rendered revision."], constraints: ["Markdown remains the handed-off contract"],
  risks: ["Stale revision approval"], verification: "Focused integration and browser tests."
};

// Replays the unchanged Node conversation rendering contract for this viewport run and derives the same
// digests the real Markdown plan store records, so every browser expectation is read out of rendered bytes.
function nodeRenderedConversationRevision() {
  const sourceSha256 = createHash("sha256").update(canonicalizeArchitecturePlanJSON(parseArchitecturePlanJSON(JSON.stringify(PLAN_PAYLOAD)))).digest("hex");
  const markdown = renderArchitecturePlanMarkdown({ plan: PLAN_PAYLOAD, planId: PLAN_ID, revision: 1, sourceSha256 });
  return { markdown, source_sha256: sourceSha256, sha256: createHash("sha256").update(markdown).digest("hex") };
}

const RENDERED = nodeRenderedConversationRevision();
export const PLAN_MARKDOWN = RENDERED.markdown;
export const PLAN_SHA256 = RENDERED.sha256;
export const PLAN_SOURCE_SHA256 = RENDERED.source_sha256;

// Returns the rendered immutable Markdown revision exactly as the plan store hands it to the Coding page.
function markdownRevision(status = "awaiting_human_approval") {
  return { plan_id: PLAN_ID, revision: 1, project_id: "PROJECT-BROWSER", file_path: `.forge/runtime/nf/plans/${PLAN_ID}/plan-r1.md`, sha256: PLAN_SHA256, source_path: `.forge/runtime/nf/plans/${PLAN_ID}/plan-source-r1.json`, source_sha256: PLAN_SOURCE_SHA256, conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_at: "2026-10-20T00:00:00Z", format: "markdown", markdown: PLAN_MARKDOWN, status, handoff_status: null };
}

// Renders the committed Coding plan review modal against one controlled plan transport.
const FIXTURE_SOURCE = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {PlanReviewModal} from './components/plan-review-modal.jsx';
import {createNodeClient} from './lib/node-client.js';
window.calls=[];window.errors=[];window.decisionResult=null;window.handoffResult=null;window.client=createNodeClient();
window.addEventListener('error',event=>window.errors.push(event.error?.stack??event.message));
window.addEventListener('unhandledrejection',event=>window.errors.push(String(event.reason?.stack??event.reason)));
// The only replaced boundary: plan transport responses, so request identities stay observable end to end.
window.fetch=async(input,init={})=>{
  const url=new URL(input,location.origin);
  const body=init.body?JSON.parse(init.body):null;
  const revision=markdownRevisionObject();
  window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:init.method??'GET',headers:Object.fromEntries(Object.entries(init.headers??{})),body});
  if(url.pathname.endsWith('/decisions')){window.decisionResult={revision:revision.revision,sha256:body.sha256,decision:body.decision,decision_id:body.decision_id};return Response.json({ok:true,revision:revision.revision,sha256:revision.sha256,decision:body.decision});}
  if(url.pathname.endsWith('/handoff')){window.handoffResult={revision:revision.revision,sha256:body.sha256};return Response.json({status:'handed_to_sprint_leader',sprint_id:'SPRINT-BROWSER',plan_handoff:true,run_started:false});}
  if(url.pathname.endsWith('/plans'))return Response.json([{plan_id:revision.plan_id,revision:revision.revision,project_id:revision.project_id,created_at:revision.created_at,format:'markdown'}]);
  if(url.pathname.match(/\\\\/plans\\\\/[^/]+\\\\/\\\\d+$/u))return Response.json({...revision});
  return Response.json({items:[]});
};
window.markdownRevisionObject=()=>(${JSON.stringify(markdownRevision())});
createRoot(document.getElementById('root')).render(
  <PlanReviewModal client={window.client} projectId="PROJECT-BROWSER" planId="${PLAN_ID}" onClose={()=>{}} onChanged={()=>{}} />
);`;

// Bundles the real plan review modal with only the plan transport replaced.
export async function createBrowserFixture({ sourceRoot, build }) {
  const compiled = await build({
    stdin: { contents: FIXTURE_SOURCE, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "fixture.js",
    alias: { react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": "\"production\"", "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": "\"\"", "process.env": "{}" }
  });
  return {
    html: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]))
  };
}

// Waits for a transport-driven DOM transition and reports real page diagnostics when it fails.
async function waitFor(page, predicate, label, argument) {
  try { await page.waitForFunction(predicate, argument); }
  catch (error) { throw new Error(`${label}: ${error.message}; ${await page.evaluate(() => JSON.stringify({ errors: window.errors, calls: window.calls.map((call) => `${call.method} ${call.path}`), decision: window.decisionResult, handoff: window.handoffResult, text: document.body.innerText.slice(0, 3000) }))}`); }
}

// Loads the Coding plan review for the conversation-created Markdown revision.
async function openPlanReview(page, origin) {
  await page.goto(origin);
  await waitFor(page, () => document.querySelector("pre.plan-review-markdown")?.textContent?.includes("## 5. Outcomes") === true, "Plan review shows the Markdown body");
}

export const browserAssertions = {
  "The existing Coding plan review displays the exact plan.markdown content and revision returned for the conversation-created Markdown plan.": async ({ page, origin }) => {
    await openPlanReview(page, origin);
    const shown = await page.evaluate(() => ({
      body: document.querySelector("pre.plan-review-markdown")?.textContent ?? "",
      identity: document.querySelector(".plan-review-content")?.innerText ?? "",
      errors: window.errors,
      revisionCalls: window.calls.filter((call) => /\/plans\/[^/]+\/\d+$/u.test(call.path)).map((call) => ({ path: call.path, project: call.query.project }))
    }));
    assert.deepEqual(shown.errors, [], "the real modal renders without page errors");
    assert.equal(shown.body, PLAN_MARKDOWN, "the displayed bytes equal the conversation-rendered plan.markdown exactly");
    assert.match(shown.identity, new RegExp(PLAN_ID, "u"), "the displayed plan identity matches the conversation revision");
    assert.match(shown.identity, /revision 1/u, "the displayed revision number matches the returned revision");
    assert.ok(shown.identity.includes(PLAN_SHA256), "the displayed SHA-256 equals the Node-rendered checksum");
    assert.equal(shown.revisionCalls.length, 1, "the modal loads the exact revision through the existing plan revision endpoint");
    assert.equal(shown.revisionCalls[0].path, `/forge/v1/plans/${PLAN_ID}/1`);
    assert.equal(shown.revisionCalls[0].project, "PROJECT-BROWSER", "the revision read stays project-scoped");
  },
  "Approving the displayed plan sends its captured revision and SHA-256 to the existing decisions and handoff endpoints and displays the successful handoff without starting RUN.": async ({ page, origin }) => {
    await openPlanReview(page, origin);
    await page.getByLabel("Owner token").fill("OWNER-TOKEN");
    await page.getByLabel("Review comments").fill("Approve the reviewed bytes.");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await waitFor(page, () => window.calls.some((call) => call.path.endsWith("/handoff")) && /Revision 1: approved/u.test(document.body.innerText), "Handoff request reaches the endpoint and the page reports approval");
    const evidence = await page.evaluate(() => ({
      decisions: window.calls.filter((call) => call.path.endsWith("/decisions")),
      handoffs: window.calls.filter((call) => call.path.endsWith("/handoff")),
      run: window.calls.filter((call) => /:run|\/run$|\/code\/run|\/tickets\//u.test(call.path)),
      decision: window.decisionResult, handoff: window.handoffResult, errors: window.errors,
      status: [...document.querySelectorAll("[role='status']")].map((element) => element.textContent).join(" | "),
      text: document.body.innerText
    }));
    assert.deepEqual(evidence.errors, [], "approval completes without page errors");
    assert.equal(evidence.decisions.length, 1, "one decision request reaches the decisions endpoint");
    const decision = evidence.decisions[0];
    assert.equal(decision.path, `/forge/v1/plans/${PLAN_ID}/1/decisions`, "the decisions path carries the captured plan id and revision");
    assert.equal(decision.method, "POST");
    assert.equal(decision.headers.authorization, "Bearer OWNER-TOKEN", "the decision stays authenticated with the owner token");
    assert.equal(decision.body.sha256, PLAN_SHA256, "the decision binds the exact SHA-256 Node rendered in chat");
    assert.equal(decision.body.project_id, "PROJECT-BROWSER");
    assert.equal(decision.body.decision, "approved");
    assert.match(decision.body.decision_id, /^DECISION-/u, "the client sends its idempotent decision identity");
    assert.equal(Object.hasOwn(decision.body, "selections"), false, "Markdown plans never send legacy selections");
    assert.equal(evidence.handoffs.length, 1, "approval continues through the existing handoff endpoint");
    const handoff = evidence.handoffs[0];
    assert.equal(handoff.path, `/forge/v1/plans/${PLAN_ID}/1/handoff`, "the handoff path carries the same captured revision");
    assert.equal(handoff.body.sha256, PLAN_SHA256, "the handoff continues the exact reviewed checksum");
    assert.equal(handoff.headers.authorization, "Bearer OWNER-TOKEN");
    assert.deepEqual(evidence.decision, { revision: 1, sha256: PLAN_SHA256, decision: "approved", decision_id: decision.body.decision_id }, "the captured revision and checksum reach the decisions endpoint");
    assert.deepEqual(evidence.handoff, { revision: 1, sha256: PLAN_SHA256 }, "the captured revision and checksum reach the handoff endpoint");
    assert.deepEqual(evidence.run, [], "approval never dispatches RUN");
    assert.match(evidence.status, /Revision 1: approved/u, "the page reports the approved revision");
    assert.doesNotMatch(evidence.text, /RUN started|ticket dispatched|Coder dispatched|started RUN/iu, "the success state grants no execution authority");
  }
};
