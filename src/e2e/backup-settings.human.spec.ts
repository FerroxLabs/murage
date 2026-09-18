import {test,expect,type Page,type TestInfo} from "@playwright/test";
import {createServer,type ViteDevServer} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {safeWipeSync} from "../../server/testing/safe-wipe.mjs";
import { axeScriptPath } from "./axe";
let vite:ViteDevServer,origin:string,cache:string;
const root=fileURLToPath(new URL("../../",import.meta.url));
const axe=readFileSync(axeScriptPath,"utf8");
test.beforeAll(async()=>{
 cache=mkdtempSync(join(tmpdir(),"murage-backup-ui-"));
 vite=await createServer({configFile:false,envFile:false,root,cacheDir:cache,resolve:{alias:{"@":join(root,"src")}},server:{host:"127.0.0.1",watch:null,hmr:false},plugins:[react(),tailwindcss(),{
  name:"backup-ui-fixture",resolveId(id){if(id==="/__backup.js")return "\0backup-ui";},load(id){if(id!=="\0backup-ui")return;return `import React from'react';import{createRoot}from'react-dom/client';import{BackupSettings}from'/src/components/BackupSettings.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(BackupSettings));`;},
  configureServer(server){server.middlewares.use((req,res,next)=>{
   const path=new URL(req.url??"/","http://fixture").pathname;
   if(path.startsWith("/__recovery/")){const name=path.slice("/__recovery/".length);if(!["index.html","recovery.css","renderer.js"].includes(name)){res.statusCode=404;res.end();return;}res.setHeader("content-type",name.endsWith("html")?"text/html":name.endsWith("css")?"text/css":"text/javascript");res.end(readFileSync(join(root,"electron/recovery",name)));return;}
   if(path!=="/__backup")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><html lang="en" data-backup-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Backup settings fixture</title><style>html[data-backup-fixture],html[data-backup-fixture] body{height:auto;min-height:100%;position:static;overflow:auto}html[data-backup-fixture] #root{height:auto;overflow:visible}</style></head><body><main style="max-width:720px;margin:auto;padding:16px"><h1 class="text-ink text-lg">Settings</h1><h2 class="text-ink text-base">Backups</h2><div id="root"></div></main><script type="module" src="/__backup.js"></script></body></html>');
  });},
 }]});await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await vite?.close();safeWipeSync(cache);});
async function inspect(page:Page,info:TestInfo,surface:string,width:number){
 await page.setViewportSize({width,height:900});await page.evaluate(()=>window.scrollTo(0,0));
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.evaluate(axe);const result=await page.evaluate(async()=>(window as any).axe.run(document));writeFileSync(info.outputPath(`${surface}-axe-${width}.json`),JSON.stringify(result,null,2));expect(result.violations).toEqual([]);
 await page.screenshot({path:info.outputPath(`${surface}-${width}.png`),fullPage:true});
 const buttons=page.locator('button:visible:not(:disabled)');const count=await buttons.count();
 for(let index=0;index<count;index++){await buttons.nth(index).focus();await expect(buttons.nth(index)).toBeFocused();expect(await buttons.nth(index).evaluate(node=>{const s=getComputedStyle(node);return s.outlineStyle!=="none"&&parseFloat(s.outlineWidth)>0||s.boxShadow!=="none";})).toBe(true);}
}
test("BackupSettings exposes truthful states and only zero-argument host actions",async({page},info)=>{
 await page.addInitScript(()=>{const w=window as any;w.calls=[];w.outcome="cancel";w.muragebox={backup:{status:async(...args:unknown[])=>{w.calls.push({action:"status",args});return{supported:new URLSearchParams(location.search).get("supported")!=="false",pending:false};},restart:async(...args:unknown[])=>{w.calls.push({action:"restart",args});if(w.outcome==="busy")throw Error("BACKUP_WORK_ACTIVE");if(w.outcome==="error")throw Error("PRIVATE_BACKUP_CANARY");if(w.outcome==="hold")return new Promise(resolve=>{w.finish=()=>resolve({restarting:false});});return{restarting:false};}}};});
 // Backup mode now lives in the Backups section's Restore card, opened from "Restore…".
 // Opened by keyboard so the focus-ring audit below keeps keyboard modality.
 const openRestore=async()=>{await page.getByRole("button",{name:"Restore…",exact:true}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("button",{name:"Restore",exact:true})).toHaveAttribute("aria-expanded","true");};
 await page.goto(origin+"/__backup");await openRestore();const restart=page.getByRole("button",{name:"Restart into Backup mode",exact:true});await expect(restart).toBeEnabled();
 for(const width of [390,820,1440])await inspect(page,info,"settings",width);
 await restart.focus();await page.keyboard.press("Enter");await expect(restart).toBeEnabled();
 await page.evaluate(()=>{(window as any).outcome="busy";});await restart.click();await expect(page.getByRole("alert")).toContainText("Work is still active");
 await page.evaluate(()=>{(window as any).outcome="error";});await restart.click();await expect(page.getByRole("alert")).toContainText("Your data is preserved");await expect(page.getByText("PRIVATE_BACKUP_CANARY")).toHaveCount(0);
 await page.evaluate(()=>{(window as any).outcome="hold";});await restart.click();await expect(page.getByRole("button",{name:"Preparing Backup mode…",exact:true})).toBeDisabled();await page.evaluate(()=>(window as any).finish());await expect(restart).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).calls.every((call:any)=>call.args.length===0))).toBe(true);expect(await page.locator('input').count()).toBe(0);
 await page.goto(origin+"/__backup?supported=false");await openRestore();await expect(restart).toBeDisabled();
 // The schedule and remote panels now render their own status lines beside
 // this one, so the encrypted-backup status is picked out by its subject. Was:
 //   await expect(page.getByRole("status")).toContainText("verified backup tool");
 await expect(page.getByRole("status").filter({hasText:"Encrypted backup requires"})).toContainText("verified backup tool");
});
test("actual recovery renderer distinguishes encrypted and ZIP actions with opaque selections",async({page},info)=>{
 await page.addInitScript(()=>{const w=window as any;w.recoveryCalls=[];w.recoveryState={context:{backupMode:true,skin:"dark",reason:"Intentional offline backup",dataDirectory:"Fixture installation"},available:true,encryptedAvailable:true,busy:false,separateAvailable:false,captureAvailable:false};w.murageRecovery={action:async(name:string,id?:string)=>{w.recoveryCalls.push({name,id});const state=w.recoveryState;if(name==="choose-encrypted-backup")state.selection={id:"encrypted-selection",name:"Fixture encrypted backup",encrypted:true,snapshotId:"snapshot-fixture",sha256:"a".repeat(64),coverage:{includedCount:4,excludedCount:2}};if(name==="choose-backup")state.selection={id:"zip-selection",name:"Fixture recovery ZIP",encrypted:false,snapshotId:"snapshot-zip",sha256:"b".repeat(64)};return structuredClone(state);}};});
 await page.goto(origin+"/__recovery/index.html");await expect(page.getByRole("heading",{name:"Backup mode",exact:true})).toBeVisible();await expect(page.getByRole("heading",{name:"Projected recovery ZIP",exact:true})).toBeVisible();
 await expect(page.getByText("not encrypted",{exact:false})).toBeVisible();
 for(const width of [390,820,1440])await inspect(page,info,"recovery",width);
 await page.getByRole("button",{name:"Create encrypted backup",exact:true}).focus();await page.keyboard.press("Enter");
 await page.getByRole("button",{name:"Inspect encrypted backup",exact:true}).click();await expect(page.getByText("This is not a full installation copy.",{exact:false})).toBeVisible();
 await page.getByRole("button",{name:"Restore encrypted backup separately for review",exact:true}).click();
 await page.getByRole("button",{name:"Choose backup",exact:true}).click();await expect(page.getByRole("button",{name:"Restore encrypted backup separately for review",exact:true})).toBeHidden();await page.getByRole("button",{name:"Restore and keep paused",exact:true}).click();
 const calls=await page.evaluate(()=>(window as any).recoveryCalls);expect(calls).toContainEqual({name:"restore-encrypted-new",id:"encrypted-selection"});expect(calls).toContainEqual({name:"restore",id:"zip-selection"});
 expect(calls.every((call:any)=>["state","backup-encrypted","choose-encrypted-backup","restore-encrypted-new","choose-backup","restore"].includes(call.name)&&[undefined,"encrypted-selection","zip-selection"].includes(call.id))).toBe(true);expect(await page.locator('input').count()).toBe(0);
});
