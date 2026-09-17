import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { axeScriptPath } from "./axe";
interface Fixture {info:{url:string;dataDir:string};close():Promise<void>}
let fixture:Fixture,vite:ViteDevServer,origin:string,headers:Record<string,string>,axeSource:string;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function api(path:string,body?:unknown){const response=await fetch(fixture.info.url+path,{method:body===undefined?"GET":"POST",headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});expect(response.ok).toBe(true);return response.json();}
test.beforeAll(async()=>{
  axeSource=process.env.MURAGE_B33_AXE_SOURCE??axeScriptPath;
  const root=fileURLToPath(new URL("../../",import.meta.url));
  const {launchVerificationServer}=await import(new URL("../../scripts/control-murage.ts",import.meta.url).href) as {launchVerificationServer:(env:NodeJS.ProcessEnv)=>Promise<Fixture>};
  fixture=await launchVerificationServer(process.env);
  try{
    const proof=await (await fetch(fixture.info.url+"/api/desktop-secret")).json();headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
    await api("/api/memory/action",{action:"configure",mode:"capture",extractorInstanceId:null});
    vite=await createServer({configFile:false,root,envFile:false,cacheDir:join(fixture.info.dataDir,"b33-controls-vite"),resolve:{alias:{"@":join(root,"src")}},server:{host:"127.0.0.1",watch:null,hmr:false,proxy:{"/api":{target:fixture.info.url}}},plugins:[react(),tailwindcss(),{name:"evolution-controls-fixture",enforce:"pre",resolveId(id){if(id==="@/state/store")return "\0evolution-api";if(id==="/__evolution.js")return "\0evolution-entry";},load(id){
      if(id==="\0evolution-api")return `export async function api(path,init={}){const response=await fetch(path,{...init,headers:{'content-type':'application/json',...init.headers}});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'Request failed'),{status:response.status});return value;}`;
      if(id==="\0evolution-entry")return `import React,{useState,useEffect,useCallback}from'react';import{createRoot}from'react-dom/client';import{MemoryEvolutionControls}from'/src/components/MemoryEvolutionControls.tsx';import{ProcedureEvaluationAdmissions}from'/src/components/ProcedureEvaluationAdmissions.tsx';import{api}from'@/state/store';import'/src/styles.css';function Fixture(){const[status,setStatus]=useState(null);const refresh=useCallback(async()=>setStatus(await api('/api/memory/status')),[]);useEffect(()=>{void refresh();},[refresh]);return React.createElement('main',{id:'bounded-memory-scroll',style:{height:'100dvh',overflowY:'auto',padding:16}},React.createElement('div',{style:{maxWidth:720,margin:'0 auto'}},React.createElement('h1',{className:'mb-4 text-lg font-medium text-ink'},'Memory settings'),React.createElement(MemoryEvolutionControls,{status:status?.evolution??null,onRefresh:refresh}),React.createElement(MemoryEvolutionControls,{kind:'classification',status:status?.classificationEvolution??null,onRefresh:refresh}),React.createElement(ProcedureEvaluationAdmissions,{status:status?.procedureEvolution??null,onRefresh:refresh})));}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
    },configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/__evolution")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><html lang="en" data-skin="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recall improvement controls</title></head><body><div id="root"></div><script type="module" src="/__evolution.js"></script></body></html>');});}}]});
    await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("B33 renderer did not bind");origin=`http://127.0.0.1:${address.port}`;
  }catch(error){await vite?.close();await fixture.close();throw error;}
});
test.afterAll(async()=>{try{await vite?.close();}finally{await fixture?.close();}});
test("owner enable and explicit interrupted-job retry remain truthful and accessible in the bounded settings scroller",async({page},info)=>{
  await page.route("**/api/**",route=>route.continue({headers:{...route.request().headers(),...headers}}));await page.goto(`${origin}/__evolution`);
  const controls=page.getByRole("region",{name:"Tested recall improvements"});
  await expect(controls.getByText("These checks cover recall selection.",{exact:false})).toBeVisible();
  const authorization=page.waitForResponse(response=>response.url().endsWith("/api/memory/action")&&response.request().postDataJSON()?.action==="evolution-authorize");
  await controls.getByRole("button",{name:"Enable tested recall improvements"}).click();const authorizedResponse=await authorization;expect(authorizedResponse.ok()).toBe(true);expect(authorizedResponse.request().postDataJSON()).toEqual({action:"evolution-authorize"});
  await expect(controls.getByText("Authorized for shipped synthetic examples",{exact:true})).toBeVisible();
  await expect.poll(async()=>(await api("/api/memory/status")).evolution.job.status,{timeout:20000}).toBe("waiting");
  const initial=await api("/api/memory/status");expect(initial.configuration.extractorInstanceId).toBeNull();expect(initial.evolution.job.started).toBe(false);
  // Seed only an interrupted receipt in this fixture's private database. No
  // model/worker is configured; retry proves the actual owner action route.
  const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"));
  try{
    const row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(initial.evolution.job.id)!;const job=JSON.parse(String(row.intent));
    job.status="deferred";job.reason="MEMORY_EVOLUTION_INTERRUPTED";
    job.snapshot={requestId:job.id,scopeId:job.scopeId,target:{kind:"memory-policy",ownerId:"workspace-owner",artifactId:"memory-policy",threadId:"memory-policy",scopeId:job.scopeId,baseRevision:initial.evolution.policy.revision,bundleId:hash(initial.evolution.policy)},policyRevision:initial.policyRevision,deletionEpoch:initial.deletionEpoch,learningRevision:initial.learning.revision,evidence:[],evidenceDigest:hash([]),outcomeBasis:"source-reported"};
    db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(job),job.id);
  }finally{db.close();}
  await controls.getByRole("button",{name:"Refresh recall status"}).click();await expect(controls.getByRole("button",{name:"Retry interrupted check"})).toBeVisible();await expect(controls.getByText("Cost unavailable.",{exact:false})).toBeVisible();
  const retry=page.waitForResponse(response=>response.url().endsWith("/api/memory/action")&&response.request().postDataJSON()?.action==="evolution-retry");
  await controls.getByRole("button",{name:"Retry interrupted check"}).click();expect((await retry).ok()).toBe(true);
  await expect(controls.getByText("Retry requested for this check.",{exact:true})).toBeVisible();expect((await api("/api/memory/status")).evolution.job.id).toBe(initial.evolution.job.id);
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:1100});await controls.scrollIntoViewIfNeeded();
    const refresh=controls.getByRole("button",{name:"Refresh recall status"});await refresh.focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");await expect(refresh).toBeFocused();expect(await refresh.evaluate(element=>getComputedStyle(element).outlineStyle)).not.toBe("none");
    expect(await page.locator("#bounded-memory-scroll").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await page.addScriptTag({path:axeSource});const audit=await page.evaluate(async()=>(window as any).axe.run(document.querySelector('[aria-label="Tested recall improvements"]'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}));await info.attach(`axe-${width}.json`,{body:JSON.stringify(audit),contentType:"application/json"});expect(audit.violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`memory-evolution-${width}.png`)});
  }
});

test("classification authorization is separate; procedure previews require an explicit exact-scope grant",async({page},info)=>{
  let previewCount=0,authorized=false;const grants:Array<Record<string,unknown>>=[],retries:Array<Record<string,unknown>>=[];
  const reviews=["supported","unsupported"].map(id=>({id,target:{kind:"skill",ownerId:"bot",artifactId:`checked-${id}`,scopeId:"owner-scope",threadId:"fixture-thread",baseRevision:"fixture-revision"},status:"pending",reason:null,started:false}));
  await page.route("**/api/**",async route=>{
    const request=route.request(),requestHeaders={...request.headers(),...headers};
    if(request.url().endsWith("/api/memory/status")){
      const response=await route.fetch({headers:requestHeaders});const body=await response.json();await route.fulfill({response,json:{...body,procedureEvolution:{reviews,max:32}}});return;
    }
    const body=request.method()==="POST"?request.postDataJSON():null;
    // Controlled UI DTOs below prove review/consent behavior. Backend scope,
    // grant ancestry and privacy are qualified by the separate server fixtures.
    if(body?.action==="procedure-evaluation-preview"){
      const supported=body.reviewId==="supported";if(supported)previewCount++;
      await route.fulfill({json:{previewId:`preview-${previewCount}`,reviewId:body.reviewId,instruction:previewCount>1?"Owner revised instruction. Verify the saved result.":"PRIVATE PROCEDURE CANARY\n<script data-user-instruction>never execute this text</script>",target:{kind:"skill",artifactId:`checked-${body.reviewId}`,ownerId:"bot",scopeId:"owner-scope"},audienceLabel:"Owner's private bot",model:{identity:"fixture-model",label:"Selected learning connection"},corpus:{id:"procedure-outcome-groups",version:"1",kind:"synthetic",description:"Synthetic procedure outcomes"},eventEvidenceIncluded:false,eligible:supported,reason:supported?null:"PROCEDURE_CORPUS_UNAVAILABLE",reusableGrant:supported&&authorized}});return;
    }
    if(body?.action==="procedure-evaluation-authorize"){
      grants.push(body);if(grants.length===1){await route.fulfill({status:409,json:{error:"Procedure preview changed"}});return;}
      authorized=true;const selected=reviews.find(review=>review.id==="supported")!;selected.status="deferred";selected.started=true;await route.fulfill({json:{authorized:true,reviewId:"supported"}});return;
    }
    if(body?.action==="procedure-evaluation-retry"){
      retries.push(body);reviews.find(review=>review.id===body.reviewId)!.status="pending";await route.fulfill({json:{authorized:true,reviewId:body.reviewId}});return;
    }
    await route.continue({headers:requestHeaders});
  });
  await page.goto(`${origin}/__evolution`);
  const classification=page.getByRole("region",{name:"Tested classification improvements"});
  const request=page.waitForResponse(response=>response.url().endsWith("/api/memory/action")&&response.request().postDataJSON()?.action==="evolution-authorize-classification");
  await classification.getByRole("button",{name:"Enable tested classification improvements"}).click();expect((await request).ok()).toBe(true);
  await expect(classification.getByText("Authorized for shipped synthetic examples",{exact:true})).toBeVisible();
  const procedures=page.getByRole("region",{name:"Procedure evaluation permissions"}),selector=procedures.getByRole("combobox",{name:"Waiting procedure review"});
  await selector.selectOption("unsupported");await expect(procedures.getByRole("button",{name:"Allow this procedure evaluation"})).toBeDisabled();expect(grants).toEqual([]);
  await selector.selectOption("supported");const exact=procedures.getByLabel("Exact procedure instructions");await expect(exact).toContainText("PRIVATE PROCEDURE CANARY");await expect(page.locator("script[data-user-instruction]")).toHaveCount(0);
  await expect(procedures.getByText("Retained conversation evidence stays local.",{exact:false})).toBeVisible();expect(grants).toEqual([]);await expect(procedures.locator('input[type="checkbox"]')).toHaveCount(0);
  await procedures.getByRole("button",{name:"Allow this procedure evaluation"}).click();await expect(procedures.getByRole("alert")).toContainText("This preview changed");await expect(procedures.getByRole("button",{name:"Allow this procedure evaluation"})).toBeDisabled();
  await procedures.getByRole("button",{name:"Refresh procedure preview"}).click();await expect(exact).toContainText("Owner revised instruction");await procedures.getByRole("button",{name:"Allow this procedure evaluation"}).click();
  await expect(procedures.getByRole("status")).toContainText("Evaluation allowed");
  expect(grants).toEqual([{action:"procedure-evaluation-authorize",previewId:"preview-1"},{action:"procedure-evaluation-authorize",previewId:"preview-2"}]);await selector.selectOption("supported");await expect(procedures.getByText("Already authorized for this scope.",{exact:true})).toBeVisible();await expect(procedures.getByRole("button",{name:"Allow this procedure evaluation"})).toHaveCount(0);expect(grants).toHaveLength(2);
  await procedures.getByRole("button",{name:"Retry evaluation",exact:true}).click();await expect(procedures.getByRole("status")).toContainText("Retry requested using the existing procedure permission");
  expect(retries).toEqual([{action:"procedure-evaluation-retry",reviewId:"supported"}]);expect(grants).toHaveLength(2);
  await selector.selectOption("supported");await expect(procedures.getByRole("button",{name:"Retry evaluation",exact:true})).toHaveCount(0);await expect(exact).toBeVisible();
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:1100});await procedures.scrollIntoViewIfNeeded();await exact.focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");await expect(exact).toBeFocused();expect(await exact.evaluate(element=>getComputedStyle(element).outlineStyle)).not.toBe("none");
    expect(await page.locator("#bounded-memory-scroll").evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await page.addScriptTag({path:axeSource});const audit=await page.evaluate(async()=>(window as any).axe.run(document.querySelector('[aria-label="Procedure evaluation permissions"]'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}));await info.attach(`procedure-admission-axe-${width}.json`,{body:JSON.stringify(audit),contentType:"application/json"});expect(audit.violations).toEqual([]);await page.screenshot({path:info.outputPath(`procedure-admission-${width}.png`)});
  }
});
