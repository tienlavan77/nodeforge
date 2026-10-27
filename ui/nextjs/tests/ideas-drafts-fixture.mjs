/**
 * Bundles the real project admission workspace, Ideas dock, project selection and HTTP client.
 * Only external HTTP is replaced: test controls can delay responses, advance server versions,
 * remove admission, and commit a mutation before losing its acknowledgement. Session drafts
 * remain entirely owned by production components; the fixture never reconstructs notebook UI.
 */
import { join } from "node:path";

/** Serve an isolated project workspace whose transport can reproduce adverse response ordering. */
export async function createBrowserFixture({ sourceRoot, build }) {
  const source = `
import React from "react";
import {createRoot} from "react-dom/client";
import {ProjectWorkspace} from "./components/project-workspace.jsx";
import {IdeasDock} from "./components/ideas-dock.jsx";
import "./app/styles/ideas-panel.css";
window.calls=[];window.control={holdRead:null,holdWrite:false,fail:null,loss:false,removed:false};
window.records=[
 {id:"a1",project_id:"A",content:"Server A",version:1,status:"open"},
 {id:"b1",project_id:"B",content:"Server B",version:1,status:"open"}
];
window.readWaiters=[];window.writeWaiters=[];
window.releaseReads=()=>{window.control.holdRead=null;window.readWaiters.splice(0).forEach(resolve=>resolve());};
window.releaseWrites=()=>{window.control.holdWrite=false;window.writeWaiters.splice(0).forEach(resolve=>resolve());};
window.fetch=async(input,init={})=>{
 const url=new URL(input,location.origin),method=init.method||"GET",body=init.body?JSON.parse(init.body):null;
 const project=url.searchParams.get("project_id")||body?.project_id;
 window.calls.push({path:url.pathname,method,body,project});
 if(url.pathname.endsWith("/lifecycle/list"))return Response.json({projects:window.control.removed?[{project_id:"B"}]:[{project_id:"A"},{project_id:"B"}]});
 if(!url.pathname.includes("/ideas"))return Response.json([]);
 if(method==="GET"&&window.control.holdRead===project)await new Promise(resolve=>window.readWaiters.push(resolve));
 if(method!=="GET"&&window.control.holdWrite)await new Promise(resolve=>window.writeWaiters.push(resolve));
 const mode=window.control.fail;
 if(mode && (method!=="GET" || mode==="offline")){
  if(mode==="offline")throw new TypeError("Network unavailable");
  return Response.json({error:{code:mode==="removed"?"PROJECT_NOT_ADMITTED":"SERVER_ERROR",message:"Unavailable"}},{status:mode==="removed"?404:503});
 }
 const id=decodeURIComponent(url.pathname.split("/").at(-1));
 const item=window.records.find(record=>record.id===id);
 if(method==="GET")return Response.json(id==="ideas"?window.records.filter(record=>record.project_id===project):item??null);
 let result;
 if(method==="POST"){
  result={id:"new-"+window.calls.length,project_id:project,content:body.content,status:"open",version:1};
  window.records.push(result);
 }else{
  const version=method==="PATCH"?body.expected_version:Number(url.searchParams.get("expected_version"));
  if(!item||version!==item.version)return Response.json({error:{code:"VERSION_CONFLICT",message:"Version conflict"}},{status:409});
  if(method==="PATCH"){Object.assign(item,body,{version:item.version+1});delete item.expected_version;result=item;}
  if(method==="DELETE"){window.records=window.records.filter(record=>record!==item);result={deleted:true,id};}
 }
 if(window.control.loss)throw new TypeError("Response lost after possible commit");
 return Response.json(result);
};
const root=createRoot(document.getElementById("root"));
window.project="A";window.mount=0;
window.renderWorkspace=()=>root.render(<ProjectWorkspace key={window.project+window.mount} projectId={window.project}><IdeasDock/></ProjectWorkspace>);
window.choose=project=>{window.project=project;window.renderWorkspace();};
window.remount=()=>{window.mount++;window.renderWorkspace();};
window.renderWorkspace();
`;
  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "fixture.js",
    alias: { react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env": "{}" }
  });
  return {
    html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map(file => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]))
  };
}
