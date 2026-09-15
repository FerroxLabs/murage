import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
interface Fixture {info:{url:string;dataDir:string};close():Promise<void>}
let fixture:Fixture,vite:ViteDevServer,origin:string,headers:Record<string,string>,routine:any,firstRevision:string,axeSource:string;
const botId="procedure-ui-bot",threadId="procedure-ui-thread",skill="reviewed-method";
async function api(path:string,method="GET",body?:unknown){const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});expect(response.ok).toBe(true);return response.json();}
test.beforeAll(async()=>{
  const require=createRequire(import.meta.url);axeSource=process.env.MURAGE_B32_AXE_SOURCE??require.resolve("axe-core/axe.min.js");
  if(!existsSync(axeSource))throw Error("B32 requires a readable axe-core script before browser verification");
  const root=fileURLToPath(new URL("../../",import.meta.url));
  const {launchVerificationServer}=await import(new URL("../../scripts/control-murage.ts",import.meta.url).href) as {launchVerificationServer:(env:NodeJS.ProcessEnv,unused?:undefined,options?:{instrumentationSource:string})=>Promise<Fixture>};
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const fs=await import('node:fs'),path=await import('node:path');const at=Date.now();
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'${threadId}',name:'Version fixture',title:'',description:'',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'${threadId}',title:'Version task',createdAt:at,resumeCursors:{}}],chiefOfStaff:false,autoApprove:false,composio:false,computer:'off',browser:false}]));
    const skills=await import(${JSON.stringify(new URL("../../server/skills.ts",import.meta.url).href)});
    const make=(description,action)=>{const stage=skills.stageSkillWrite('${botId}',{action,targetName:action==='update'?'${skill}':undefined,source:'learn:ui-fixture',files:[{path:'SKILL.md',content:'---\\nname: ${skill}\\ndescription: '+description+'\\n---\\nCheck the saved result.\\n'}]});if(stage.error)throw Error(stage.error);const applied=skills.applyStagedSkillWrite('${botId}',stage.id);if(applied.error)throw Error(applied.error);return stage.id;};
    const first=make('Original reviewed method','create');make('Improved reviewed method','update');fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'procedure-ui-versions.json'),JSON.stringify({first}));
  `});
  try{
    const proof=await (await fetch(fixture.info.url+"/api/desktop-secret")).json();headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
    firstRevision=JSON.parse(readFileSync(join(fixture.info.dataDir,"procedure-ui-versions.json"),"utf8")).first;
    routine=(await api("/api/routines","POST",{name:"Reviewed routine",botId,prompt:"Original routine instructions",enabled:false,schedule:{type:"once",at:Date.now()+86400000}})).routine;
    routine=(await api(`/api/routines/${routine.id}`,"PATCH",{prompt:"Improved routine instructions"})).routine;
    vite=await createServer({configFile:false,root,envFile:false,cacheDir:join(fixture.info.dataDir,"b32-ui-vite"),resolve:{alias:{"@":join(root,"src")}},server:{host:"127.0.0.1",watch:null,hmr:false,proxy:{"/api":{target:fixture.info.url}}},plugins:[react(),tailwindcss(),{name:"procedure-ui-fixture",enforce:"pre",resolveId(id){if(id==="@/state/store")return "\0procedure-api";if(id==="/__procedure.js")return "\0procedure-entry";},load(id){
      if(id==="\0procedure-api")return `export async function api(path,init={}){const response=await fetch(path,{...init,headers:{'content-type':'application/json',...init.headers}});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'Request failed'),{status:response.status});return value;}`;
      if(id==="\0procedure-entry")return `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SkillVersionHistory,RoutineVersionHistory}from'/src/components/ProcedureVersionHistory.tsx';import'/src/styles.css';function Fixture(){const[current,setCurrent]=useState(${JSON.stringify(routine)}),[thread,setThread]=useState('${threadId}');window.clearProcedureThread=()=>setThread(undefined);return React.createElement('main',{className:'mx-auto max-w-2xl p-4 text-ink',style:{height:'100dvh',overflowY:'auto'}},React.createElement('h1',{className:'text-lg font-medium'},'Procedure history'),React.createElement(SkillVersionHistory,{botId:'${botId}',name:'${skill}',threadId:thread,canEdit:true}),React.createElement(RoutineVersionHistory,{routine:current,onRestored:setCurrent}));}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
    },configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/__procedure")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><html lang="en" data-skin="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Procedure history fixture</title></head><body><div id="root"></div><script type="module" src="/__procedure.js"></script></body></html>');});}}]});
    await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("B32 renderer did not bind");origin=`http://127.0.0.1:${address.port}`;
  }catch(error){await vite?.close();await fixture.close();throw error;}
});
test.afterAll(async()=>{try{await vite?.close();}finally{await fixture?.close();}});
test("actual history endpoints restore with owner CAS, retain audience on failure and support keyboard at all widths",async({page},info)=>{
  await page.route("**/api/**",route=>route.continue({headers:{...route.request().headers(),...headers}}));
  await page.goto(`${origin}/__procedure`);
  await page.locator("summary").filter({hasText:"Skill version history"}).click();
  const skillRegion=page.getByRole("region",{name:"Skill version history"});
  await skillRegion.getByRole("button",{name:`Restore version ${firstRevision}`,exact:true}).click();
  await skillRegion.getByRole("button",{name:"Confirm restore",exact:true}).click();
  await expect(skillRegion.getByRole("status").filter({hasText:"Version restored"})).toContainText("Version restored");
  let history=await api(`/api/bots/${botId}/skills/${skill}/history`);expect(history.current.description).toBe("Original reviewed method");
  // Independent owner change establishes a real stale-CAS response.
  await api(`/api/bots/${botId}/skills/${skill}/rollback`,"POST",{expectedRevision:history.currentRevision,targetRevision:firstRevision});
  await skillRegion.getByRole("button",{name:`Restore version ${firstRevision}`,exact:true}).click();await skillRegion.getByRole("button",{name:"Confirm restore",exact:true}).click();
  await expect(skillRegion.getByRole("alert")).toContainText("Refresh versions");
  await expect(skillRegion.getByRole("button",{name:`Restore version ${firstRevision}`,exact:true})).toBeDisabled();
  await skillRegion.getByRole("button",{name:"Refresh versions",exact:true}).click();await expect(skillRegion.getByRole("button",{name:`Restore version ${firstRevision}`,exact:true})).toBeEnabled();
  await page.locator("summary").filter({hasText:"Instruction version history"}).click();
  const routineRegion=page.getByRole("region",{name:"Instruction version history"}),target=routine.instructionHistory.find((item:any)=>item.id!==routine.instructionRevision);
  await routineRegion.getByRole("button",{name:`Restore version ${target.id}`,exact:true}).click();await routineRegion.getByRole("button",{name:"Confirm restore",exact:true}).click();await expect(routineRegion.getByRole("status").filter({hasText:"Version restored"})).toContainText("Version restored");
  const restored=(await api("/api/routines")).routines.find((item:any)=>item.id===routine.id);expect(restored.prompt).toBe(target.prompt);expect(restored.schedule).toEqual(routine.schedule);expect(restored.enabled).toBe(false);expect(restored.botId).toBe(routine.botId);
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:1100});const selector=page.getByRole("combobox",{name:"Skill history audience"});await selector.focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");await expect(selector).toBeFocused();expect(await selector.evaluate(element=>getComputedStyle(element).outlineStyle)).not.toBe("none");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.addScriptTag({path:axeSource});const audit=await page.evaluate(async()=>(window as any).axe.run(document.querySelector("main"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}));await info.attach(`axe-${width}.json`,{body:JSON.stringify(audit),contentType:"application/json"});expect(audit.violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`procedure-history-${width}.png`),fullPage:true});
  }
  await page.evaluate(()=>(window as any).clearProcedureThread());await page.getByRole("combobox",{name:"Skill history audience"}).selectOption("task");await page.locator("summary").filter({hasText:"Skill version history"}).click();
  await expect(skillRegion.getByRole("alert")).toContainText("Global history was not opened");await expect(page.getByRole("combobox",{name:"Skill history audience"})).toHaveValue("task");
});
