import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
let fixture:VerificationServer,vite:ViteDevServer,origin:string,headers:Record<string,string>,bot:any,artifact:any,workspace:string;
const original="# B11\n",edited="# B11 working copy\n\nEdited in the current Files sidebar.\n";
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
async function api(method:string,path:string,body?:unknown){const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();expect(response.ok,JSON.stringify({path,status:response.status,data})).toBe(true);return data;}
async function identify(){headers={"x-murage-surface":"desktop","x-murage-surface-secret":(await api("GET","/api/desktop-secret")).secret};}
async function saved(){const response=await fetch(fixture.info.url+`/api/artifacts/${artifact.id}/download`,{headers});expect(response.ok).toBe(true);return response.text();}
test.beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`const fetchOriginal=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('External network disabled in output journey');return fetchOriginal(input,init);};`});
  await identify();await api("POST","/api/memory/action",{action:"configure",mode:"off"});
  bot=(await api("POST","/api/bots",{name:"Output journey bot"})).bot;
  await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false});
  await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:"Create HTML, MD and TXT files named b11-joined"});
  const cards=async()=>(await api("GET",`/api/threads/${bot.threadId}/messages?limit=100`)).messages.filter((message:any)=>message.artifactIds?.length);
  await expect.poll(async()=>(await cards()).length,{timeout:15000}).toBe(1);
  const ids=(await cards())[0].artifactIds;
  for(const id of ids){const candidate=(await api("GET",`/api/artifacts/${id}`)).artifact;if(candidate.relativePath.endsWith("b11-joined.md"))artifact=candidate;}
  expect(artifact).toMatchObject({botId:bot.id,threadId:bot.threadId,sha256:sha(original),savedState:"available",sourceState:"current"});
  const rootState=await api("GET",`/api/workspace-files/root?botId=${bot.id}&threadId=${bot.threadId}`);expect(rootState).toMatchObject({state:"ready",managed:true});workspace=rootState.displayPath;
  expect(workspace).toBe(join(realpathSync.native(fixture.info.dataDir),"workspaces",bot.id,"threads",bot.threadId));
  expect(readFileSync(join(workspace,artifact.relativePath),"utf8")).toBe(original);expect(await saved()).toBe(original);
  const root=fileURLToPath(new URL("../../",import.meta.url));vite=await createServer({configFile:false,envFile:false,root,cacheDir:join(fixture.info.dataDir,"output-vite"),resolve:{alias:{"@":join(root,"src")}},plugins:[react(),tailwindcss()],server:{host:"127.0.0.1",watch:null,hmr:false,proxy:{"/api":{target:fixture.info.url}}}});
  await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{try{await vite?.close();}finally{await fixture?.close();}if(fixture)expect(existsSync(fixture.info.dataDir)).toBe(false);});

test("registered engine Markdown opens beside chat, edits only working bytes and survives restart",async({page},info)=>{
  await page.addInitScript(()=>{localStorage.setItem("murage-email-gate","skipped");localStorage.setItem("murage-flux-invite-dismissed","1");});
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);
  await page.getByRole("button",{name:/^Output journey bot Rename/}).click();
  const card=page.getByTestId("chat-scroll").locator(`[data-artifact-id="${artifact.id}"]`);await expect(card).toBeVisible();
  await card.locator('[data-pane-action="open-here"]').click();
  const pane=page.getByTestId("workspace-pane");await expect(pane).toBeVisible();
  await expect(pane.getByTestId("workspace-pane-scope")).toContainText("Output journey bot");
  await expect(pane.getByTestId("workspace-markdown-preview")).toContainText("B11");
  await expect(pane.getByTestId("workspace-document")).toHaveAttribute("aria-label",artifact.relativePath);
  await page.screenshot({path:info.outputPath("registered-card-files-preview.png"),fullPage:true});
  await pane.getByTestId("workspace-document-edit").click();
  await pane.getByRole("button",{name:"Source",exact:true}).click();
  const source=pane.getByRole("textbox",{name:"Markdown source",exact:true});await expect(source).toHaveValue(original);await source.fill(edited);
  await pane.getByRole("button",{name:"Save",exact:true}).click();await expect(pane.getByTestId("markdown-file-status")).toHaveText("File saved");
  expect(readFileSync(join(workspace,artifact.relativePath),"utf8")).toBe(edited);expect(await saved()).toBe(original);
  expect((await api("GET",`/api/artifacts/${artifact.id}`)).artifact).toMatchObject({sha256:sha(original),sourceState:"changed",botId:bot.id,threadId:bot.threadId});
  await page.screenshot({path:info.outputPath("working-edit-immutable-artifact.png"),fullPage:true});
  await fixture.restart();await identify();
  expect(readFileSync(join(workspace,artifact.relativePath),"utf8")).toBe(edited);expect(await saved()).toBe(original);
  const transcript=(await api("GET",`/api/threads/${bot.threadId}/messages?limit=100`)).messages;
  expect(transcript.filter((message:any)=>message.artifactIds?.includes(artifact.id))).toHaveLength(1);
  await page.reload();await page.getByRole("button",{name:/^Output journey bot Rename/}).click();await expect(card).toBeVisible();
  await expect(card.getByText("Original file has changed.",{exact:false})).toBeVisible();
  expect((await api("GET",`/api/workspace-files/root?botId=${bot.id}&threadId=${bot.threadId}`)).displayPath).toBe(workspace);
});
