/**
 * Bundles the real admitted project workspace, conversation, monitors, Ideas dock and client.
 * Only HTTP, EventSource and framework navigation are controlled. The fixture records external
 * calls and transport lifetime, and persists simulated backend records across document reloads
 * so browser scenarios can observe durable responses without touching runtime project data.
 */
import { join } from "node:path";

/** Build a browser-served production component bundle with deterministic external I/O. */
export async function createBrowserFixture({ sourceRoot, build }) {
  const source = `
import React from "react";
import {createRoot} from "react-dom/client";
import ArchitectureWorkspace from "./components/architecture-workspace.jsx";
import {ProjectWorkspace} from "./components/project-workspace.jsx";
import "./app/globals.css";
window.calls=[]; window.sources=[]; window.streamCloseCount=0;
window.fixtureErrors=[];window.addEventListener("error",event=>window.fixtureErrors.push(event.message));
window.control={failList:false,failMutation:false,holdList:false,holdMutation:false};
localStorage.clear();
window.records=JSON.parse(sessionStorage.getItem("ideas-fixture-records")||"[]");
window.persist=()=>sessionStorage.setItem("ideas-fixture-records",JSON.stringify(window.records));
const noAgent=location.hash.includes("noAgent")||sessionStorage.getItem("ideas-fixture-no-agent")==="1";window.fixtureNoAgent=noAgent;
window.fetch=async(input,init={})=>{
 const url=new URL(input,location.origin),method=init.method||"GET",body=init.body?JSON.parse(init.body):null;
 window.calls.push({path:url.pathname,method,body,query:Object.fromEntries(url.searchParams)});
 if(url.pathname.endsWith("/lifecycle/list"))return Response.json({projects:[{project_id:"PROJECT-A",root:"/fixture/a"}]});
 if(url.pathname.endsWith("/agents"))return Response.json(noAgent?[]:[
  {agent_id:"AM-1",agent_name:"First agent",role:"architecture_manager",enabled:true},
  {agent_id:"AM-2",agent_name:"Second agent",role:"architecture_manager",enabled:true}]);
 if(url.pathname.endsWith("/conversations"))return Response.json([{id:"CONV-1",title:"First conversation"},{id:"CONV-2",title:"Second conversation"}]);
 if(url.pathname.includes("/messages"))return Response.json({items:[],has_more:false});
 if(url.pathname.endsWith("/plan-clarifications"))return Response.json([]);
 if(url.pathname.endsWith("/git/status"))return Response.json({branch:"main",files:[]});
 if(url.pathname.includes("/ideas")){
  if(method==="GET"&&window.control.holdList)await new Promise(resolve=>window.releaseList=()=>{window.control.holdList=false;resolve();});
  if(method==="GET"&&window.control.failList)return Response.json({error:{message:"Ideas unavailable"}},{status:503});
  if(method!=="GET"&&window.control.holdMutation)await new Promise(resolve=>window.releaseMutation=()=>{window.control.holdMutation=false;resolve();});
  if(method!=="GET"&&window.control.failMutation)return Response.json({error:{message:"Idea save failed"}},{status:503});
  const id=decodeURIComponent(url.pathname.split("/").at(-1)),item=window.records.find(entry=>entry.id===id);
  if(method==="GET")return Response.json(id==="ideas"?window.records:item);
  if(method==="POST"){
   const created={id:"idea-"+Date.now(),project_id:body.project_id,content:body.content,status:"open",version:1};
   window.records.push(created);window.persist();return Response.json(created,{status:201});
  }
  const version=method==="PATCH"?body.expected_version:Number(url.searchParams.get("expected_version"));
  if(!item||item.version!==version)return Response.json({error:{message:"Idea version conflict"}},{status:409});
  if(method==="PATCH"){Object.assign(item,body,{version:item.version+1});delete item.expected_version;window.persist();return Response.json(item);}
  if(method==="DELETE"){window.records=window.records.filter(entry=>entry!==item);window.persist();return Response.json({deleted:true,id});}
 }
 return Response.json({items:[],requests:[],status:"idle"});
};
/** Model only the external SSE transport; production parsing and workspace reconciliation remain real. */
class FixtureEventSource extends EventTarget{
 constructor(url){super();this.url=url;this.readyState=1;window.sources.push(this);queueMicrotask(()=>{this.onopen?.(new Event("open"));this.dispatchEvent(new Event("open"));});}
 close(){if(this.readyState!==2){window.streamCloseCount++;this.readyState=2;}}
}
window.EventSource=FixtureEventSource;
window.emit=(type,payload)=>{
 const event={schema_version:1,event_id:"event-"+Math.random(),event_type:type,project_id:"PROJECT-A",timestamp:new Date().toISOString(),payload};
 for(const source of window.sources)if(source.readyState!==2)source.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(event),lastEventId:event.event_id}));
};
createRoot(document.getElementById("root")).render(<ProjectWorkspace projectId="PROJECT-A"><ArchitectureWorkspace/></ProjectWorkspace>);
`;
  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "fixture.js",
    alias: { react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env": "{}" },
    plugins: [{
      name: "fixture-navigation",
      setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("link")
            ? 'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}'
            : 'export const useParams=()=>({projectId:"PROJECT-A"});export const usePathname=()=>"/PROJECT-A";export const useRouter=()=>({push:()=>{},replace:()=>{},refresh:()=>{}});',
          loader: "js"
        }));
      }
    }]
  });
  return {
    html: '<!doctype html><html lang="vi"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]))
  };
}
