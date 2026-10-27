// Exercises the production directory, cards, dialog and lifecycle stores in Chromium.
// HTTP fixtures provide backend snapshots; all rendering, recovery and admission behavior
// comes from bundled application components rather than replacement DOM implementations.
import assert from "node:assert/strict";
import { join } from "node:path";

// Bundle real application components and expose controlled external responses for lifecycle transition checks.
export async function createBrowserFixture({sourceRoot,build}) {
  const source = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectDirectory} from './components/project-directory.jsx';
import * as selection from './lib/project-selection.js';
import * as lifecycle from './lib/project-lifecycle-client.js';
import './app/globals.css';
window.api={...selection,...lifecycle};window.calls=[];
window.mock={outage:false,directoryFailure:false,lost:false,nextStatus:'running',operations:{},members:[
{project_id:'PROJECT-A',root:'/server/a',readiness:'unavailable',operation:{attempt_id:1,status:'failed',diagnostic:null},diagnostic:{message:'Startup failed'},retryable:true},
{project_id:'PROJECT-B',root:'/server/b',readiness:'ready',operation:{attempt_id:1,status:'succeeded',diagnostic:null},diagnostic:null,retryable:false}]};
window.makeOperation=(key,update={})=>({operation_id:'OPRO-'+key,request_key:key,request_fingerprint:'a'.repeat(64),kind:'add',root:'/server/a',attempt:1,revision:1,stage:'attempted',status:'failed',diagnostic:{code:'index',message:'Index failed'},counters:{transitions:1,attempts:1},timestamps:{created_at:'2026-10-27T00:00:00Z',updated_at:'2026-10-27T00:00:00Z'},...update});
window.mock.operations.seed=window.makeOperation('seed');
window.fetch=async(input,init={})=>{
const url=new URL(input,location.origin),body=init.body?JSON.parse(init.body):null,method=init.method||'GET';
window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body,headers:init.headers});
if(window.mock.outage)throw new Error('Node disconnected');
if(url.pathname.endsWith('/lifecycle/directory')){
if(window.mock.directoryFailure)throw new Error('Directory refresh failed');
return Response.json({version:'1',projects:window.mock.members});}
if(url.pathname.endsWith('/lifecycle/list'))return Response.json({projects:window.mock.members.filter(p=>p.readiness==='ready').map(p=>({project_id:p.project_id,root:p.root}))});
if(url.pathname.endsWith('/operations/status'))return Response.json({version:'1',operation:window.mock.operations[url.searchParams.get('request_key')]});
if(url.pathname.endsWith('/operations/retry')){
const previous=window.mock.operations[body.request_key],next={...previous,attempt:previous.attempt+1,revision:previous.revision+1,status:'running'};
delete next.diagnostic;window.mock.operations[body.request_key]=next;return Response.json({version:'1',operation:next});}
if(method==='POST'){
const kind=url.pathname.split('/').at(-1),operation=window.makeOperation(body.request_key,{root:body.root,kind,status:window.mock.nextStatus});
if(operation.status!=='failed')delete operation.diagnostic;
window.mock.operations[body.request_key]=operation;
if(window.mock.lost){window.mock.lost=false;throw new Error('Mutation response lost');}
return Response.json({version:'1',operation});}
throw new Error('Unexpected request '+url.pathname);};
lifecycle.reloadOperation('seed').then(()=>{
const root=createRoot(document.getElementById('root'));window.leave=()=>root.unmount();root.render(<ProjectDirectory/>);
});`;
  const compiled=await build({stdin:{contents:source,resolveDir:join(sourceRoot,"ui/nextjs"),loader:"jsx"},bundle:true,write:false,jsx:"automatic",outfile:"fixture.js",
    alias:{react:join(sourceRoot,"ui/nextjs/node_modules/react"),"react-dom":join(sourceRoot,"ui/nextjs/node_modules/react-dom")},
    define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL":'""',"process.env":"{}"}});
  return {html:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets:Object.fromEntries(compiled.outputFiles.map(file=>[file.path.endsWith(".css")?"/fixture.css":"/fixture.js",file.text]))};
}

// Start each independent scenario with authoritative two-project membership and a failed tracked operation.
async function open(page,origin) {
  await page.goto(origin);await page.locator('[data-project-id="PROJECT-A"]').waitFor();
  await page.getByRole("link",{name:"Open b"}).waitFor();
}

// Traverse native keyboard focus order until the target is reached, failing if a control is inaccessible.
async function tabTo(page,locator) {
  for(let index=0;index<60;index++){
    if(await locator.evaluate(element=>element===document.activeElement))return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard could not reach control");
}

// Submit server paths with keyboard input through the actual dialog, including its native action selector.
async function submit(page,kind,path) {
  await tabTo(page,page.getByRole("button",{name:"Add project",exact:true}));await page.keyboard.press("Enter");
  const dialog=page.getByRole("dialog");await dialog.waitFor();
  await tabTo(page,dialog.getByLabel("Action"));await page.keyboard.press(kind==="create"?"Home":"End");
  await page.keyboard.press("Tab");await page.keyboard.type(path);
  await tabTo(page,dialog.getByRole("button",{name:kind==="create"?"Create project":"Add project",exact:true}));
  await page.keyboard.press("Enter");
}

// Count external mutation requests independently of observation traffic to detect accidental lifecycle replay.
async function mutations(page){return page.evaluate(()=>window.calls.filter(call=>call.method==="POST"));}

export const browserAssertions={
"Startup or index failure retains a card with the same project identity, current diagnostic and safe retry action; pre-membership failure appears only as an operation or form error.":async({page,origin})=>{
await open(page,origin);const card=page.locator('[data-project-id="PROJECT-A"]');
assert.match(await card.innerText(),/Index failed/);assert.equal(await card.getByRole("button",{name:"Retry operation"}).count(),1);
await page.evaluate(()=>{window.mock.nextStatus='failed';});await submit(page,"create","/server/preflight");
await page.getByRole("dialog").waitFor({state:"hidden"});assert.equal(await page.locator("[data-project-id]").count(),2);
assert.match(await page.getByRole("region",{name:"Tracked operations"}).innerText(),/Index failed/);
},
"A project without current serving readiness cannot open a workspace through its card or a stale selection.":async({page,origin})=>{
await open(page,origin);assert.equal(await page.locator('[data-project-id="PROJECT-A"] a').count(),0);
assert.equal(await page.evaluate(()=>{try{window.api.selectProject('PROJECT-A');return false;}catch(error){return Boolean(error.message);}}),true);
await page.evaluate(async()=>{window.api.selectProject('PROJECT-B');window.mock.members[1].readiness='unavailable';await window.api.refreshProjects();});
assert.equal(await page.evaluate(()=>window.api.getProjectSelection().projectId),null);
await page.waitForFunction(()=>!document.querySelector('[data-project-id="PROJECT-B"] a'));
},
"Retry retains the project card and identity, displays the new attempt, ignores stale attempt updates and removes the old current error after success.":async({page,origin})=>{
await open(page,origin);const card=page.locator('[data-project-id="PROJECT-A"]');
await card.getByRole("button",{name:"Retry operation"}).click();
await page.waitForFunction(()=>document.querySelector('[data-project-id="PROJECT-A"]').textContent.includes('attempt 2'));
assert.doesNotMatch(await card.innerText(),/Index failed/);
await page.evaluate(()=>{window.mock.operations.seed=window.makeOperation('seed',{attempt:2,revision:4,status:'succeeded',diagnostic:undefined});window.mock.members[0].readiness='ready';});
await card.getByRole("button",{name:"Reload status"}).click();
await page.evaluate(async()=>{window.mock.operations.seed=window.makeOperation('seed',{attempt:1,revision:99});await window.api.reloadOperation('seed');});
assert.match(await card.innerText(),/succeeded; attempt 2/);assert.doesNotMatch(await card.innerText(),/Index failed/);
assert.equal(await card.getByRole("link",{name:"Open a"}).count(),1);
},
"Unknown index totals render indeterminate progress without a fabricated percentage or ETA, and file/function totals render the backend committed counters separately from embedding status.":async({page,origin})=>{
await open(page,origin);
await page.evaluate(async()=>{window.mock.operations.seed=window.makeOperation('seed',{status:'running',diagnostic:undefined,progress:{stage:'scan/index',stages:{preflight:'completed','scan/index':'running'},counters:{indexed:7,failed:2},checkpoint:{files:7,functions:19,version:3},embedding:{status:'running',pending:5,processing:1,succeeded:2,failed:0}}});await window.api.reloadOperation('seed');});
const card=page.locator('[data-project-id="PROJECT-A"]');await card.locator("progress").waitFor();
assert.equal(await card.locator("progress").getAttribute("value"),null);
assert.match(await card.innerText(),/Committed files: 7; functions: 19/);assert.match(await card.innerText(),/Embedding: running; pending: 5/);
assert.doesNotMatch(await card.innerText(),/%|ETA/);
},
"After a successful mutation followed by a failed directory refresh, the UI reports mutation success with stale directory data and offers reload without sending another Create or Add mutation.":async({page,origin})=>{
await open(page,origin);await page.evaluate(()=>{window.mock.nextStatus='succeeded';window.mock.directoryFailure=true;});
await submit(page,"add","/server/new");await page.getByText("Operation succeeded.",{exact:true}).waitFor();
await page.getByRole("button",{name:"Reload directory"}).click();assert.equal((await mutations(page)).length,1);
assert.equal(await page.locator("[data-project-id]").count(),2);
assert.match(await page.locator("body").innerText(),/directory data has not reloaded|last known project list/);
},
"During an outage the existing snapshot and selection are retained with a stale indication, another project is not selected, and only an authoritative unavailable or removal response revokes the corresponding admission.":async({page,origin})=>{
await open(page,origin);const previous=await page.evaluate(()=>{window.api.selectProject('PROJECT-B');window.mock.outage=true;return window.api.getProjectSelection();});
await page.waitForFunction(()=>document.body.textContent.includes('last known project list'));
assert.deepEqual(await page.evaluate(()=>{const s=window.api.getProjectSelection();return[s.projectId,s.generation];}),[previous.projectId,previous.generation]);
assert.equal(await page.locator("[data-project-id]").count(),2);
await page.evaluate(()=>{window.mock.outage=false;window.mock.members=window.mock.members.filter(p=>p.project_id!=='PROJECT-B');});
await page.getByRole("button",{name:"Reload directory"}).click();await page.waitForFunction(()=>window.api.getProjectSelection().projectId===null);
},
"Retrying a failed operation and reloading its status invoke distinct actions, and an unknown initial mutation result is reconciled with the original request key.":async({page,origin})=>{
await open(page,origin);const card=page.locator('[data-project-id="PROJECT-A"]');
await card.getByRole("button",{name:"Reload status"}).click();assert.equal((await mutations(page)).length,0);
await card.getByRole("button",{name:"Retry operation"}).click();assert.equal((await mutations(page))[0].path.endsWith('/retry'),true);
await page.evaluate(()=>{window.mock.lost=true;});await submit(page,"add","/server/unknown");await page.getByRole("dialog").waitFor({state:"hidden"});
const calls=await mutations(page),key=calls.at(-1).body.request_key;
await page.getByRole("region",{name:"Tracked operations"}).getByRole("button",{name:"Reload status"}).click();
assert.equal((await mutations(page)).length,2);
assert.equal(await page.evaluate(key=>window.calls.some(call=>call.query.request_key===key),key),true);
},
"Create and Add can be selected and submitted using only the keyboard with a labeled absolute server path, and both follow the backend operation returned for the request.":async({page,origin})=>{
await open(page,origin);await submit(page,"create","/server/create");await page.getByRole("dialog").waitFor({state:"hidden"});
await submit(page,"add","/server/add");await page.getByRole("dialog").waitFor({state:"hidden"});
assert.deepEqual((await mutations(page)).map(call=>[call.path.split('/').at(-1),call.body.root]),[['create','/server/create'],['add','/server/add']]);
assert.equal(await page.getByRole("region",{name:"Tracked operations"}).getByRole("button",{name:"Reload status"}).count(),2);
},
"Form, card and status controls provide keyboard operation, appropriate focus behavior and aria-live status updates, with distinct field, project and connection error presentations.":async({page,origin})=>{
await open(page,origin);await submit(page,"add","relative");const input=page.getByLabel("Absolute server path");
assert.equal(await input.getAttribute("aria-invalid"),"true");assert.match(await page.locator('[data-error="field"]').innerText(),/absolute server path/);
await page.getByRole("dialog").getByRole("button",{name:"Cancel"}).click();
assert.equal(await page.getByRole("button",{name:"Add project",exact:true}).evaluate(element=>element===document.activeElement),true);
assert.equal(await page.locator('[data-error="project"]').count(),1);await page.evaluate(()=>{window.mock.outage=true;});
await page.locator('[data-project-id="PROJECT-A"]').getByRole("button",{name:"Reload status"}).click();
await page.locator('[data-error="connection"]').waitFor();assert.ok(await page.locator('[aria-live="polite"]').count()>0);
},
"Leaving the tracking UI stops observation without sending a backend cancellation or another lifecycle mutation.":async({page,origin})=>{
await open(page,origin);await submit(page,"add","/server/running");await page.getByRole("dialog").waitFor({state:"hidden"});
await page.evaluate(()=>window.leave());const before=await page.evaluate(()=>window.calls.length);await page.waitForTimeout(1800);
assert.equal(await page.evaluate(()=>window.calls.length),before);assert.equal((await mutations(page)).length,1);
}
};

// Allow focused verification to invoke the same Node-owned browser runner before committing.
// Deferred execution lets the runner import this module's completed exports without a circular wait.
if (process.argv[1]?.endsWith("project-lifecycle.browser.mjs")) {
  setImmediate(async () => {
    try {
      const { runBrowserVerification } = await import("../../../backend/src/modules/supervisor/browser-verification-runner.js");
      const receipt = await runBrowserVerification({ projectRoot: process.cwd(), sourceRoot: process.cwd(),
        step: { kind: "browser", scenario_path: "ui/nextjs/tests/project-lifecycle.browser.mjs", criterion_ids: ["AC-1"],
          viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions) } });
      console.log(JSON.stringify(receipt));
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
