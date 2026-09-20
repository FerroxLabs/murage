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
 cache=mkdtempSync(join(tmpdir(),"murage-schedule-ui-"));
 vite=await createServer({configFile:false,envFile:false,root,cacheDir:cache,resolve:{alias:{"@":join(root,"src")}},server:{host:"127.0.0.1",watch:null,hmr:false},plugins:[react(),tailwindcss(),{
  name:"schedule-ui-fixture",resolveId(id){if(id==="/__schedule.js")return "\0schedule-ui";},load(id){if(id!=="\0schedule-ui")return;return `import React from'react';import{createRoot}from'react-dom/client';import{BackupSettings}from'/src/components/BackupSettings.tsx';import'/src/styles.css';window.unmountFixture=()=>app.unmount();const app=createRoot(document.getElementById('root'));app.render(React.createElement(BackupSettings));`;},
  configureServer(server){server.middlewares.use((req,res,next)=>{
   if(new URL(req.url??"/","http://fixture").pathname!=="/__schedule")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><html lang="en" data-schedule-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scheduled backup fixture</title><style>html[data-schedule-fixture],html[data-schedule-fixture] body{height:auto;min-height:100%;position:static;overflow:auto}html[data-schedule-fixture] #root{height:auto;overflow:visible}</style></head><body><main style="max-width:720px;margin:auto;padding:16px"><h1 class="text-ink text-lg">Settings</h1><h2 class="text-ink text-base">Backups</h2><div id="root"></div></main><script type="module" src="/__schedule.js"></script></body></html>');
  });},
 }]});await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await vite?.close();safeWipeSync(cache);});
// Settings → Backups moved these panels out of General and renamed their copy.
// Old → new strings used below: "Schedule Off." → "Daily backups are off.";
// "Choose destination and recovery key" → "Choose backup folder and recovery key";
// "Enable scheduled backups" → "Turn on daily backups"; "Disable schedule" → "Turn off";
// "Daily time" → "Time each day"; "Timezone" → "Time zone"; "Catch-up window (hours)" →
// "Late start allowed (hours)"; "Maximum run duration (minutes)" → "Maximum run time (minutes)";
// "Allow Murage to close an idle workspace for this backup and reopen it afterward." →
// "Murage may close and reopen this window when it's idle to take the backup.";
// "Remote backup (optional)" → "Off-site copy (optional)"; "Refresh remote backup status" →
// "Refresh off-site status"; limits, refresh buttons, the closed-app job controls and
// removal clean-up now sit under "Advanced", remote recovery under "Restore".
async function openPanel(page:Page,name:"Advanced"|"Restore"|"Off-site copy (optional)"){
 const toggle=page.getByRole("button",{name,exact:true});if(await toggle.getAttribute("aria-expanded")!=="true")await toggle.click();await expect(toggle).toHaveAttribute("aria-expanded","true");
 return page.getByRole("region",{name,exact:true});
}
const refreshSchedule=async(page:Page)=>{await openPanel(page,"Advanced");await page.getByRole("button",{name:"Refresh schedule status",exact:true}).click();};
const refreshRemote=async(page:Page)=>{await openPanel(page,"Advanced");await page.getByRole("button",{name:"Refresh off-site status",exact:true}).click();};
async function setup(page:Page,withRemote=false,optional=false){
 await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.addInitScript(({withRemote,optional})=>{
  const w=window as any;w.calls=[];w.mode="ok";w.statusFail=false;
  w.state={supported:true,pending:false,enabled:false,revision:1,phase:"idle",schedule:{enabled:false,preUpgrade:false}};
  w.refs={installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",destinationLabel:"Fixture backups",recoveryLabel:"Independent recovery.age"};
  w.muragebox={backup:{status:async()=>({supported:true,pending:false}),restart:async()=>{w.calls.push({action:"manual"});return{restarting:false};}},backupSchedule:{
   status:async()=>{w.calls.push({action:"status"});if(w.statusFail)throw Error("PRIVATE_PATH_CANARY");return structuredClone(w.state);},
   selectReferences:async()=>{w.calls.push({action:"select"});if(w.mode==="cancel")return{cancelled:true};if(w.mode==="hold")await new Promise(resolve=>w.release=resolve);w.state={...w.state,refs:w.refs};return structuredClone(w.state);},
   configure:async(revision:number,choices:any)=>{w.calls.push({action:"configure",revision,choices});if(w.mode==="conflict"){w.state.revision++;throw Error("BACKUP_SCHEDULE_CHANGED PRIVATE_KEY_CANARY");}if(w.mode==="error")throw Error("PRIVATE_KEY_CANARY");if(w.mode==="hold")await new Promise(resolve=>w.release=resolve);if(revision!==w.state.revision)throw Error("BACKUP_SCHEDULE_CHANGED");const{allowIdleRestart,...schedule}=choices;w.state={...w.state,enabled:schedule.enabled,schedule,revision:revision+1};return structuredClone(w.state);}
  }};
  if(withRemote){
   w.remoteMode="ok";w.remoteFail=false;w.remoteState=JSON.parse(sessionStorage.getItem("fixtureRemoteStatus")??"null")??{supported:true,pending:false,configured:false,state:"unconfigured",revision:0};
   w.state.lastVerified={jobId:"a".repeat(64),bytes:1024,verifiedAt:1700000000000};
   w.muragebox.backupRemote={
    status:async()=>{if(w.remoteFail)throw Error("PRIVATE_REMOTE_CANARY");return structuredClone(w.remoteState);},
    save:async(revision:number,input:any)=>{w.calls.push({action:"remote-save",revision,input});if(w.remoteMode==="save-fail")throw Error("PRIVATE_REMOTE_CANARY");w.remoteState={supported:true,pending:false,configured:true,state:"password-required",revision:revision+1,remoteRef:"remote-one",label:input.label,passwordSelected:false};return{saved:true};},
    selectRepositoryPassword:async(ref:string,revision:number)=>{w.calls.push({action:"remote-password",ref,revision});if(w.remoteMode==="cancel")return{cancelled:true};w.remoteState={...w.remoteState,state:"disconnected",revision:revision+1,passwordSelected:true};return{selected:true};},
    connect:async(ref:string,revision:number)=>{w.calls.push({action:"remote-connect",ref,revision});w.remoteState.state="connected";return{connected:true,remoteRef:ref,revision,repositoryId:"b".repeat(64)};},
    uploadLatest:async(ref:string,revision:number,jobId:string)=>{w.calls.push({action:"remote-upload",ref,revision,jobId});if(w.remoteMode==="hold")await new Promise(resolve=>w.remoteRelease=resolve);const state=w.remoteMode==="uncertain"?"needs-review":"verified";w.remoteState.lastUpload={state,jobId};sessionStorage.setItem("fixtureRemoteStatus",JSON.stringify(w.remoteState));return{state,jobId,remoteRef:ref,revision,snapshotId:"c".repeat(64)};},
    reconcileLatest:async(ref:string,revision:number,jobId:string)=>{w.calls.push({action:"remote-reconcile",ref,revision,jobId});w.remoteState.lastUpload={state:"verified",jobId};sessionStorage.setItem("fixtureRemoteStatus",JSON.stringify(w.remoteState));return{state:"verified",jobId,snapshotId:"c".repeat(64)};},
    listBackups:async(ref:string,revision:number)=>{w.calls.push({action:"remote-list",ref,revision});return{repositoryId:"b".repeat(64),backups:[{snapshotId:"d".repeat(64),jobId:"a".repeat(64),createdAt:1700000000000,verified:false}],ignored:1};},
    downloadBackup:async(ref:string,revision:number,snapshotId:string)=>{w.calls.push({action:"remote-download",ref,revision,snapshotId});return w.remoteMode==="cancel"?{cancelled:true}:{saved:true,archivePath:"/fixture-downloads/Murage-backup/backup.age",directory:"/fixture-downloads/Murage-backup"};},
    saveMaintenanceCredentials:async(ref:string,revision:number,credentials:any)=>{w.calls.push({action:"remote-maintenance",ref,revision,keyLength:String(credentials?.accessKeyId).length});if(w.remoteMode==="maintenance-fail")throw Error("PRIVATE_REMOTE_CANARY");w.remoteState={...w.remoteState,maintenanceSelected:true};return{saved:true};},
    previewRetention:async(ref:string,revision:number,policy:any)=>{w.calls.push({action:"remote-preview",ref,revision,policy});w.previewCount=(w.previewCount??0)+1;return{previewId:String(w.previewCount).repeat(64),remove:["e".repeat(64),"f".repeat(64)],keep:1};},
    applyRetention:async(ref:string,revision:number,policy:any,previewId:string)=>{w.calls.push({action:"remote-apply",ref,revision,policy,previewId});if(w.remoteMode==="retention-changed")throw Error("BACKUP_REMOTE_RETENTION_CHANGED PRIVATE_REMOTE_CANARY");const review=w.remoteMode==="retention-review";w.remoteState={...w.remoteState,retention:review?{state:"needs-review",removed:2,previewId,error:"repository-locked",lockRelease:"unconfirmed"}:{state:"complete",removed:2,previewId}};return review?{state:"needs-review",previewId,removed:2,error:"repository-locked",lockRelease:"unconfirmed"}:{state:"complete",previewId,removed:2};},
    clearRetentionReview:async(ref:string,revision:number,previewId:string)=>{w.calls.push({action:"remote-clear",ref,revision,previewId});const next={...w.remoteState};delete next.retention;w.remoteState=next;return{cleared:true};},
   };
  }
 if(optional){
   // Optional desktop methods; older apps do not offer them.
   w.keyMode="ok";w.runMode="ok";
   w.muragebox.backupSchedule.setUp=async(...args:any[])=>{w.calls.push({action:"set-up",args});if(w.keyMode==="cancel")return{cancelled:true};if(w.keyMode==="error")throw Error("PRIVATE_KEY_CANARY");if(w.keyMode==="inside")throw Error("BACKUP_RECOVERY_KEY_INSIDE_DESTINATION");
    w.state={...w.state,refs:w.refs};
    return{...structuredClone(w.state),created:{label:"Murage recovery key.age",publicKey:"age1"+"q".repeat(58),folder:"Documents",secretKey:"AGE-SECRET-KEY-CANARY"}};};
   w.muragebox.backup.saveRecoveryKeyCopy=async(...args:unknown[])=>{w.calls.push({action:"copy-key",args});if(w.keyMode==="cancel")return{cancelled:true};if(w.keyMode==="error")throw Error("PRIVATE_KEY_CANARY");if(w.keyMode==="inside")throw Error("BACKUP_RECOVERY_KEY_INSIDE_DESTINATION");if(w.keyMode==="exists")return{refused:"BACKUP_RECOVERY_KEY_EXISTS"};return{saved:true,label:"usb-key.txt",publicKey:"age1"+"q".repeat(58),secretKey:"AGE-SECRET-KEY-CANARY"};};
   w.muragebox.backupSchedule.runNow=async(revision:number,...rest:unknown[])=>{w.calls.push({action:"run-now",revision,rest:rest.length});const codes:Record<string,string>={consent:"BACKUP_SCHEDULE_CONSENT_REQUIRED",active:"BACKUP_WORK_ACTIVE",busy:"BACKUP_BUSY",unknown:"PRIVATE_RUN_CANARY"};if(w.runMode==="active")w.state={...w.state,phase:"skipped"};if(codes[w.runMode])throw Error(codes[w.runMode]);w.state={...w.state,phase:"due"};return structuredClone(w.state);};
  }
 },{withRemote,optional});
 await page.goto(origin+"/__schedule");await page.waitForLoadState("networkidle");await expect(page.getByText("Daily backups are off.",{exact:false})).toBeVisible();
}
async function fill(page:Page){
 await page.getByLabel("Time each day",{exact:true}).fill("22:15");await page.getByLabel("Time zone",{exact:true}).fill("Asia/Bangkok");
 await openPanel(page,"Advanced");
 await page.getByLabel("Late start allowed (hours)",{exact:true}).fill("2");await page.getByLabel("Maximum backup size (GiB)",{exact:true}).fill("1");await page.getByLabel("Maximum run time (minutes)",{exact:true}).fill("10");
}
// M57: a permission with the reassurance attached, never an instruction to quit.
const CONSENT="Allow Murage to close and reopen its own window when it's idle, so it can take the backup. Murage does that itself, so you never need to quit it.";
async function inspect(page:Page,info:TestInfo,name:string,width:number){
 await page.setViewportSize({width,height:900});await page.evaluate(()=>window.scrollTo(0,0));
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.evaluate(axe);const result=await page.evaluate(async()=>(window as any).axe.run(document));writeFileSync(info.outputPath(`${name}-axe-${width}.json`),JSON.stringify(result,null,2));expect(result.violations).toEqual([]);
 await page.screenshot({path:info.outputPath(`${name}-${width}.png`),fullPage:true});
}
async function keyboardAudit(page:Page,info:TestInfo){
 await page.locator("body").click({position:{x:1,y:1}});
 const total=await page.evaluate(()=>{const all=[...document.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')].filter(el=>el.getBoundingClientRect().height>0);all.forEach((el,i)=>el.dataset.tabAudit=String(i));return all.length;});
 const seen=new Set<string>();
 const cdp=await page.context().newCDPSession(page),nativeEvidence=[];
 try{
  // Native time controls retarget activeElement to their host even while the
  // clock button inside the UA shadow tree owns focus and its visible outline.
  for(let i=0;i<total*4+4;i++){
   await page.keyboard.press("Tab");await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   const item=await page.evaluate(()=>{const el=document.activeElement as HTMLElement,s=getComputedStyle(el);return{id:el.dataset.tabAudit,type:el.getAttribute("type"),focus:el.matches(":focus"),focusWithin:el.matches(":focus-within"),visible:s.outlineStyle!=="none"&&parseFloat(s.outlineWidth)>0||s.boxShadow!=="none"};});
   if(item.id===undefined)continue;
   let visible=item.visible;
   if(!visible&&item.type==="time"&&item.focusWithin&&!item.focus){
    const {root}=await cdp.send("DOM.getDocument",{depth:-1,pierce:true});
    const walk=(nodes:any[]):any[]=>nodes.flatMap(node=>[node,...walk([...(node.children??[]),...(node.shadowRoots??[])])]);
    const all=walk([root]);expect(all.length).toBeLessThan(5000);
    const host=all.find(node=>{const attrs=node.attributes??[];const at=attrs.indexOf("data-tab-audit");return node.nodeName==="INPUT"&&at>=0&&attrs[at+1]===item.id;});
    expect(host).toBeTruthy();const descendants=walk(host.shadowRoots??[]).filter(node=>node.nodeType===1);expect(descendants.length).toBeGreaterThan(0);expect(descendants.length).toBeLessThan(100);
    const focused=[];
    for(const node of descendants){
     const {object}=await cdp.send("DOM.resolveNode",{nodeId:node.nodeId,objectGroup:"b21-native-focus"});
     const result=await cdp.send("Runtime.callFunctionOn",{objectId:object.objectId,returnByValue:true,functionDeclaration:'function(){const s=getComputedStyle(this),r=this.getBoundingClientRect();return{focused:this.matches(":focus"),tag:this.tagName,pseudo:this.getAttribute("pseudo"),id:this.id,outline:s.outline,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor,boxShadow:s.boxShadow,opacity:s.opacity,visibility:s.visibility,width:r.width,height:r.height};}'});
     expect(result.exceptionDetails).toBeUndefined();if(result.result.value?.focused)focused.push(result.result.value);
    }
    expect(focused).toHaveLength(1);const target=focused[0];
    visible=target.width>0&&target.height>0&&target.visibility==="visible"&&Number(target.opacity)>0&&((target.outlineStyle!=="none"&&parseFloat(target.outlineWidth)>0&&target.outlineColor!=="rgba(0, 0, 0, 0)")||target.boxShadow!=="none");
    nativeEvidence.push({tabStep:i+1,host:item,target,visible});await page.screenshot({path:info.outputPath(`native-time-focus-${nativeEvidence.length}.png`),fullPage:true});
   }
   expect(visible).toBe(true);seen.add(item.id);
  }
  expect(seen.size).toBe(total);
 }finally{
  writeFileSync(info.outputPath("native-focus-check.json"),JSON.stringify(nativeEvidence,null,2));await cdp.send("Runtime.releaseObjectGroup",{objectGroup:"b21-native-focus"});await cdp.detach();
 }
}
test("B21 bounded native time focus observation",async({page},info)=>{
 test.skip(process.env.MURAGE_B21_FOCUS_OBSERVATION!=="1","Only explicitly admitted diagnostic observation");
 await page.setViewportSize({width:1440,height:900});await setup(page);await page.getByRole("button",{name:"Choose backup folder and recovery key",exact:true}).click();await fill(page);await page.getByRole("checkbox",{name:CONSENT,exact:true}).check();await page.locator("body").click({position:{x:1,y:1}});
 const capture=()=>page.evaluate(()=>{
  const el=document.activeElement as HTMLElement,label=el.closest("label");
  const style=(node:Element)=>{const s=getComputedStyle(node);return{focus:node.matches(":focus"),focusVisible:node.matches(":focus-visible"),focusWithin:node.matches(":focus-within"),outline:s.outline,boxShadow:s.boxShadow};};
  return{tag:el.tagName,type:el.getAttribute("type"),value:(el as HTMLInputElement).value,text:el.textContent?.slice(0,100),active:style(el),label:label?{text:label.textContent,style:style(label)}:null};
 });
 const observations=[];
 for(let step=1;step<=7;step++){
  await page.keyboard.press("Tab");const immediate=await capture();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));const settled=await capture();
  await page.screenshot({path:info.outputPath(`focus-step-${step}.png`),fullPage:true});const afterScreenshot=await capture();observations.push({step,immediate,settled,afterScreenshot});
 }
 writeFileSync(info.outputPath("focus-observation.json"),JSON.stringify(observations,null,2));
});
test("explicit setup, keyboard enable/disable and safe reference replacement at three widths",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await setup(page);
 const choose=page.getByRole("button",{name:"Choose backup folder and recovery key",exact:true}),enable=page.getByRole("button",{name:"Turn on daily backups",exact:true}),consent=page.getByRole("checkbox",{name:CONSENT,exact:true});
 await expect(enable).toBeDisabled();await expect(page.getByText("No recovery key is created or exported here.",{exact:false})).toBeVisible();
 // No optional desktop methods in this fixture: neither extra button is offered.
 await expect(page.getByRole("button",{name:"Create my recovery key"})).toHaveCount(0);await expect(page.getByRole("button",{name:"Back up now"})).toHaveCount(0);
 for(const width of [360,390,820,1440])await inspect(page,info,"off",width);
 await page.evaluate(()=>{(window as any).mode="cancel";});await choose.click();await expect(page.getByText("Selection cancelled. Schedule unchanged.")).toBeVisible();await expect(enable).toBeDisabled();
 // Was: "References selected. Scheduling has not been enabled."
 await page.evaluate(()=>{(window as any).mode="ok";});await choose.focus();await page.keyboard.press("Enter");await expect(page.getByText("Backup folder and recovery key chosen. Daily backups are not on yet.")).toBeVisible();
 await fill(page);await expect(enable).toBeDisabled();await consent.focus();await page.keyboard.press("Space");await expect(enable).toBeEnabled();
 await keyboardAudit(page,info);for(const width of [360,390,820,1440])await inspect(page,info,"ready",width);
 // Turning on collapses setup into the Schedule card: the choose button and
 // time input leave the page, and the limits under Advanced lock.
 await enable.focus();await page.keyboard.press("Enter");const disable=page.getByRole("button",{name:"Turn off",exact:true});await expect(disable).toBeEnabled();await expect(choose).toHaveCount(0);await expect(page.getByLabel("Time each day",{exact:true})).toHaveCount(0);await expect(page.getByLabel("Late start allowed (hours)",{exact:true})).toBeDisabled();
 await expect(page.getByRole("region",{name:"Schedule",exact:true})).toContainText("Daily at 22:15 (Asia/Bangkok)");await expect(page.getByRole("region",{name:"Your backups",exact:true})).toContainText("On · daily at 22:15 (Asia/Bangkok)");
 const first=await page.evaluate(()=>(window as any).calls.find((c:any)=>c.action==="configure"));expect(first).toEqual({action:"configure",revision:1,choices:{enabled:true,preUpgrade:false,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",time:"22:15",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},allowIdleRestart:true}});
 for(const width of [360,390,820,1440])await inspect(page,info,"enabled",width);
 await disable.focus();await page.keyboard.press("Enter");await expect(choose).toBeEnabled();await expect(page.getByText("An existing transfer is not cancelled.",{exact:false})).toBeVisible();
 const second=await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="configure")[1]);const{allowIdleRestart,...prior}=first.choices;expect(second).toEqual({action:"configure",revision:2,choices:{...prior,enabled:false}});
 await expect(consent).not.toBeChecked();
 // Backup mode moved to the Restore card, opened from "Restore…".
 await page.getByRole("button",{name:"Restore…",exact:true}).click();await expect(page.getByRole("button",{name:"Restore",exact:true})).toBeFocused();
 await page.getByRole("button",{name:"Restart into Backup mode",exact:true}).click();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="manual").length)).toBe(1);
 expect(errors).toEqual([]);
});
test("pre-upgrade opt-in is capability gated, preserves schedule choices and renews consent",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page);
 const preUpgrade=page.getByRole("checkbox",{name:"Back up before installing an in-app update.",exact:true}),consent=page.getByRole("checkbox",{name:CONSENT,exact:true}),enable=page.getByRole("button",{name:"Turn on daily backups",exact:true});
 await expect(preUpgrade).toHaveCount(0);await page.evaluate(()=>{(window as any).state.preUpgradeSupported=false;});await refreshSchedule(page);await expect(preUpgrade).toHaveCount(0);
 await page.evaluate(()=>{(window as any).state.preUpgradeSupported=true;});await refreshSchedule(page);await expect(preUpgrade).not.toBeChecked();expect(await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==="configure"))).toEqual([]);
 await page.getByRole("button",{name:"Choose backup folder and recovery key",exact:true}).click();await fill(page);await consent.check();await expect(enable).toBeEnabled();
 await preUpgrade.focus();await page.keyboard.press("Space");await expect(preUpgrade).toBeChecked();await expect(consent).not.toBeChecked();await expect(enable).toBeDisabled();await consent.focus();await page.keyboard.press("Space");await expect(enable).toBeEnabled();
 await keyboardAudit(page,info);for(const width of [390,820,1440])await inspect(page,info,"pre-upgrade-opt-in",width);
 await enable.focus();await page.keyboard.press("Enter");const disable=page.getByRole("button",{name:"Turn off",exact:true});await expect(disable).toBeEnabled();await expect(preUpgrade).toBeChecked();await expect(preUpgrade).toBeDisabled();
 const first=await page.evaluate(()=>(window as any).calls.find((call:any)=>call.action==="configure"));expect(first).toEqual({action:"configure",revision:1,choices:{enabled:true,preUpgrade:true,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",time:"22:15",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},allowIdleRestart:true}});
 for(const width of [390,820,1440])await inspect(page,info,"pre-upgrade-enabled",width);
 await disable.click();await expect(preUpgrade).toBeChecked();await expect(preUpgrade).toBeEnabled();const second=await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==="configure")[1]);const{allowIdleRestart,...saved}=first.choices;expect(second).toEqual({action:"configure",revision:2,choices:{...saved,enabled:false}});
 await page.evaluate(()=>{(window as any).state.preUpgradeSupported=false;});await refreshSchedule(page);await expect(preUpgrade).toHaveCount(0);await expect(page.getByRole("region",{name:"Set up backups"}).getByText("Pre-upgrade backups are unavailable in this app.",{exact:false})).toBeVisible();await expect(enable).toBeDisabled();expect(await page.evaluate(()=>(window as any).state.schedule.preUpgrade)).toBe(true);
 await page.evaluate(()=>{(window as any).state.preUpgradeSupported=true;});await refreshSchedule(page);await expect(preUpgrade).toBeChecked();await expect(page.getByLabel("Time each day",{exact:true})).toHaveValue("22:15");await expect(page.getByLabel("Maximum run time (minutes)",{exact:true})).toHaveValue("10");
 const setupCard=page.getByRole("region",{name:"Set up backups"});
 for(const[phase,label,locked]of [["install-requested","Update installation requested",true],["upgrade-complete","Update completed after backup",false],["upgrade-cancelled","Update cancelled",false]]as const){await page.evaluate(phase=>{(window as any).state.phase=phase;},phase);await refreshSchedule(page);await expect(setupCard.getByText(label,{exact:false})).toBeVisible();if(locked)await expect(preUpgrade).toBeDisabled();else await expect(preUpgrade).toBeEnabled();}
 await consent.check();await preUpgrade.uncheck();await expect(consent).not.toBeChecked();await expect(enable).toBeDisabled();await consent.check();await enable.click();const last=await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==="configure").at(-1));expect(last.choices).toEqual({...first.choices,preUpgrade:false});expect(errors).toEqual([]);
});
test("pending, conflicts, stale state, review and verified receipt remain truthful",async({page},info)=>{
 await setup(page);const choose=page.getByRole("button",{name:"Choose backup folder and recovery key",exact:true});await openPanel(page,"Advanced");const refresh=page.getByRole("button",{name:"Refresh schedule status",exact:true});
 await page.evaluate(()=>{(window as any).mode="hold";});await choose.click();await expect(choose).toBeDisabled();await expect(refresh).toBeDisabled();await page.evaluate(()=>(window as any).release());await expect(choose).toBeEnabled();
 await fill(page);await page.getByRole("checkbox",{name:CONSENT,exact:true}).check();await page.evaluate(()=>{(window as any).mode="conflict";});await page.getByRole("button",{name:"Turn on daily backups",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Settings changed");await expect(page.getByLabel("Time each day",{exact:true})).toHaveValue("22:15");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="configure").length)).toBe(1);
 await page.evaluate(()=>{(window as any).mode="error";});await page.getByRole("button",{name:"Turn on daily backups",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Your data is preserved");await expect(page.getByText("PRIVATE_KEY_CANARY",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{const w=window as any;w.state.pending=true;w.state.phase="capturing";});await refresh.click();await expect(choose).toBeDisabled();await expect(page.getByText("Backup work is pending.",{exact:false})).toBeVisible();
 await expect(page.getByRole("region",{name:"Your backups"})).toContainText("A backup is running. Settings are locked until it finishes.");
 for(const width of [390,820,1440])await inspect(page,info,"pending",width);
 await page.evaluate(()=>{(window as any).statusFail=true;});await refresh.click();await expect(page.getByText("Status refresh failed.",{exact:false})).toBeVisible();await expect(choose).toBeDisabled();
 await expect(page.getByRole("region",{name:"Your backups"})).toContainText("Schedule status couldn't be refreshed.");
 await page.evaluate(()=>{const w=window as any;w.statusFail=false;w.state.pending=false;w.state.enabled=true;w.state.schedule={enabled:true,preUpgrade:false,time:"22:15",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}};w.state.phase="needs-review";w.mode="ok";});await refresh.click();
 // The review state shows on the Schedule card and in the summary's attention list.
 await expect(page.getByRole("region",{name:"Schedule",exact:true}).getByText("backups are paused until you clear it",{exact:false})).toBeVisible();await expect(page.getByRole("region",{name:"Your backups"})).toContainText("backups are paused until you clear it");await expect(choose).toHaveCount(0);await expect(page.getByRole("button",{name:"Turn off",exact:true})).toBeEnabled();
 for(const width of [390,820,1440])await inspect(page,info,"review",width);
 await page.getByRole("button",{name:"Turn off",exact:true}).click();await expect(page.getByRole("button",{name:"Choose a different folder",exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"Turn on daily backups",exact:true})).toBeDisabled();
 // Was: "Last locally verified backup: … 2,048 bytes. This is not a restore-drill result."
 await page.evaluate(()=>{const w=window as any;w.state.phase="returned";w.state.lastVerified={verifiedAt:1700000000000,bytes:2048};});await refresh.click();await expect(page.getByRole("region",{name:"Your backups"})).toContainText("2 KB");await expect(page.getByText("To be sure a restore works, try one from Restore.",{exact:false})).toBeVisible();await expect(page.getByText("restore-drill",{exact:false})).toHaveCount(0);
 // Pending status changes arrive through polling; unmount ends the timer.
 await page.evaluate(()=>{(window as any).state.pending=true;});await refresh.click();await page.evaluate(()=>{(window as any).state.pending=false;});await expect(page.getByText("Backup work is pending.",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).state.pending=true;});await refresh.click();await page.evaluate(()=>(window as any).unmountFixture());const count=await page.evaluate(()=>(window as any).calls.length);await page.waitForTimeout(2200);expect(await page.evaluate(()=>(window as any).calls.length)).toBe(count);
});
test("a backup that stopped unconfirmed can be cleared from Your backups, and backing up works again",async({page},info)=>{
 await setup(page,false,true);
 await page.evaluate(()=>{const w=window as any;w.state={...w.state,refs:w.refs,enabled:true,phase:"needs-review",reviewReason:"capture-unconfirmed",schedule:{enabled:true,preUpgrade:false,time:"22:15",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}}};
  w.muragebox.backupSchedule.clearReview=async(revision:number)=>{w.calls.push({action:"clear-review",revision});if(revision!==w.state.revision)throw Error("BACKUP_SCHEDULE_CHANGED");const{reviewReason,...rest}=w.state;w.state={...rest,phase:"idle"};return structuredClone(w.state);};});
 await refreshSchedule(page);
 const summary=page.getByRole("region",{name:"Your backups"});
 await expect(summary).toContainText("The last backup stopped before Murage could confirm it, so backups are paused.");
 await expect(summary.getByRole("button",{name:"Back up now",exact:true})).toBeDisabled();
 for(const width of [390,1440])await inspect(page,info,"clear-review",width);
 await summary.getByRole("button",{name:"Clear and try again",exact:true}).click();
 await expect(summary.getByRole("button",{name:"Clear and try again",exact:true})).toHaveCount(0);
 await expect(page.getByText("Cleared. Back up now or the next daily backup will try again.",{exact:true})).toBeVisible();
 await expect(summary.getByRole("button",{name:"Back up now",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="clear-review").length)).toBe(1);
});
test("unsupported and missing native bridge never expose schedule mutation",async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).state.supported=false;});await refreshSchedule(page);await expect(page.getByRole("button",{name:"Choose backup folder and recovery key",exact:true})).toHaveCount(0);
 await page.addInitScript(()=>{delete(window as any).muragebox.backupSchedule;});await page.reload();await expect(page.getByText("Scheduling unavailable in this window")).toBeVisible();await expect(page.locator("input")).toHaveCount(0);
});
test("Windows says plainly that backing up while Murage is closed is not available there yet",async({page})=>{
 await setup(page);await page.addInitScript(()=>{(window as any).muragebox.platform="win32";});await page.reload();
 await expect(page.getByText("Backing up while Murage is closed isn't available on Windows yet. Backups while Murage is open work without it.",{exact:true})).toBeVisible();
 await expect(page.getByText(/needs a supported desktop app/)).toHaveCount(0);
});
test("closed-app checkbox sets up the job, keeps consent, stale status and disable-all journey",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page);
 await page.evaluate(()=>{
  const w=window as any;w.closedState={supported:true,state:"unconfigured",closedApp:false};w.closedMode="ok";
  w.muragebox.backupClosed={
   status:async()=>{if(w.closedMode==="stale")throw Error("PRIVATE_CLOSED_CANARY");return structuredClone(w.closedState);},
   stage:async(...args:any[])=>{w.calls.push({action:"closed-stage",args});w.closedState.state="staged";return structuredClone(w.closedState);},
   install:async(...args:any[])=>{w.calls.push({action:"closed-install",args});if(w.closedMode==="cancel")return{...w.closedState,cancelled:true};if(w.closedMode==="error")throw Error("PRIVATE_CLOSED_CANARY");w.closedState.state="installed";w.state.closedAppSupported=true;return structuredClone(w.closedState);},
   disable:async(...args:any[])=>{w.calls.push({action:"closed-disable",args});w.state.enabled=false;w.state.schedule.enabled=false;w.state.revision++;w.closedState={...w.closedState,closedApp:false,state:"disabled-removal-pending"};return structuredClone(w.closedState);},
  };
 });
 // This test installs its fake bridge after mount. Opening Advanced re-renders
 // with that bridge before the refresh runs, so one refresh reads its status.
 // (Previously two refreshes, with "Checking closed-app job status…" between.)
 await refreshSchedule(page);await expect(page.getByText("No closed-app job prepared",{exact:true})).toBeVisible();
 // Was: "Allow scheduled backups while Murage is closed, while I am signed in." — a
 // separate prepare/register step had to come first. One checkbox now runs them.
 const permission=page.getByRole("checkbox",{name:"Also back up when Murage is closed",exact:true});
 const consent=page.getByRole("checkbox",{name:CONSENT,exact:true});
 const enable=page.getByRole("button",{name:"Turn on daily backups",exact:true});
 const closedCalls=()=>page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action.startsWith("closed-")).map((c:any)=>c.action));
 await expect(permission).toBeEnabled();await expect(permission).not.toBeChecked();expect(await closedCalls()).toEqual([]);
 await page.evaluate(()=>{(window as any).closedMode="cancel";});await permission.click();await expect(page.getByText("Job registration cancelled. Scheduling settings are unchanged.")).toBeVisible();await expect(permission).not.toBeChecked();
 expect(await closedCalls()).toEqual(["closed-stage","closed-install"]);await expect(page.getByText("Job prepared, not registered",{exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).closedMode="error";});await permission.click();await expect(page.getByRole("alert")).toContainText("Your data is preserved");await expect(page.getByText("PRIVATE_CLOSED_CANARY",{exact:false})).toHaveCount(0);await expect(permission).not.toBeChecked();
 expect(await closedCalls()).toEqual(["closed-stage","closed-install","closed-install"]);
 await page.evaluate(()=>{(window as any).closedMode="ok";});await permission.focus();await page.keyboard.press("Space");await expect(page.getByText("Job registration confirmed",{exact:true})).toBeVisible();await expect(permission).toBeChecked();
 expect(await closedCalls()).toEqual(["closed-stage","closed-install","closed-install","closed-install"]);
 await page.getByRole("button",{name:"Choose backup folder and recovery key",exact:true}).click();await fill(page);await consent.check();
 // Changing the closed-app choice renews idle-restart consent; re-ticking a registered job makes no calls.
 await permission.focus();await page.keyboard.press("Space");await expect(permission).not.toBeChecked();await expect(consent).not.toBeChecked();await consent.check();await permission.focus();await page.keyboard.press("Space");await expect(permission).toBeChecked();await expect(consent).not.toBeChecked();await expect(enable).toBeDisabled();await consent.check();
 expect((await closedCalls()).length).toBe(4);
 await page.evaluate(()=>{(window as any).closedMode="stale";});await refreshSchedule(page);await expect(enable).toBeDisabled();await expect(page.getByText("Job status could not be refreshed.",{exact:false})).toBeVisible();
 await page.evaluate(()=>{(window as any).closedMode="ok";});await refreshSchedule(page);await expect(enable).toBeEnabled();
 for(const width of [360,390,820,1440])await inspect(page,info,"closed-ready",width);
 await enable.focus();await page.keyboard.press("Enter");await expect(page.getByRole("button",{name:"Turn off",exact:true})).toBeEnabled();
 const call=await page.evaluate(()=>(window as any).calls.find((c:any)=>c.action==="configure"));expect(call.choices).toMatchObject({closedApp:true,allowClosedApp:true,allowIdleRestart:true});
 await page.evaluate(()=>{(window as any).state.lastClosedResult={status:"verified",at:1700000000000,revision:2};});await refreshSchedule(page);await expect(page.getByText("Last closed-app result:",{exact:false})).toContainText("Backup verified");
 await page.getByRole("button",{name:"Disable all scheduled backups and remove job",exact:true}).click();await expect(page.getByText("Daily backups are off.",{exact:false})).toBeVisible();await expect(page.getByText("All scheduled backups are disabled. Job removal is pending; any running backup is not cancelled.")).toBeVisible();await expect(permission).toBeChecked();await expect(enable).toBeDisabled();
 await expect(page.getByRole("region",{name:"Your backups"})).toContainText("Removing the background job still needs attention.");
 for(const width of [390,820,1440])await inspect(page,info,"closed-removal-pending",width);
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action.startsWith("closed-")).every((c:any)=>c.args.length===0))).toBe(true);expect(errors).toEqual([]);
});
test("optional recovery-key and back-up-now methods: success, cancel and errors stay truthful",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page,false,true);
 // M57: one button starts setup; the key the desktop made is reported back so
 // the page can offer the one thing left to do with it.
 const start=page.getByRole("button",{name:"Turn on backups",exact:true}),now=page.getByRole("button",{name:"Back up now",exact:true}),status=page.getByRole("region",{name:"Your backups"});
 await expect(now).toBeDisabled();
 await page.evaluate(()=>{(window as any).keyMode="cancel";});await start.click();await expect(page.getByText("Setup cancelled. Nothing was changed.")).toBeVisible();
 await page.evaluate(()=>{(window as any).keyMode="error";});await start.click();await expect(page.getByRole("alert")).toContainText("Your data is preserved");await expect(page.getByText("PRIVATE_KEY_CANARY",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).keyMode="ok";});await start.focus();await page.keyboard.press("Enter");
 await expect(page.getByText("Your recovery key is Murage recovery key.age, saved in Documents.")).toBeVisible();
 await expect(page.getByText("nobody, including you",{exact:false})).toBeVisible();
 // Setup ends protected, not merely configured: the schedule is on and the
 // first backup was requested in the same act.
 await expect(page.getByRole("region",{name:"Schedule",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="run-now").length)).toBe(1);
 await expect(page.getByText("age1"+"q".repeat(58))).toBeHidden();await page.getByText("Show public key",{exact:true}).click();await expect(page.getByText("age1"+"q".repeat(58))).toBeVisible();
 expect(await page.content()).not.toContain("AGE-SECRET-KEY");
 // Keeping a copy is one action, and a refusal never claims a copy was made.
 const copy=page.getByRole("button",{name:"Save a copy…",exact:true});
 await page.evaluate(()=>{(window as any).keyMode="inside";});await copy.click();await expect(page.getByRole("alert")).toContainText("Save the recovery key outside your backup folder.");
 await expect(page.getByText("A copy was saved as",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).keyMode="cancel";});await copy.click();await expect(page.getByText("No copy was saved. Your recovery key is unchanged.")).toBeVisible();
 await page.evaluate(()=>{(window as any).keyMode="ok";});await copy.click();await expect(page.getByText("A copy was saved as usb-key.txt.")).toBeVisible();
 await expect(now).toBeEnabled();
 for(const width of [360,390,820,1440])await inspect(page,info,"optional-methods",width);
 // M57: setup already took the first backup, so one run-now has happened.
 await now.click();await expect(status.getByText("Murage will close and reopen this window to take the backup.")).toBeVisible();await status.getByRole("button",{name:"Cancel",exact:true}).click();await expect(now).toBeEnabled();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="run-now").length)).toBe(1);
 for(const [mode,message] of [["consent","Backups aren't switched on yet. Turn them on first: Murage takes a backup by closing and reopening its own window, and Murage does that itself, so you never need to quit it."],["active","Finish or stop current work first."],["busy","A backup is already running."],["unknown","Backup settings could not be updated. Your data is preserved."]] as const){
  await page.evaluate(mode=>{(window as any).runMode=mode;},mode);await now.click();await status.getByRole("button",{name:"Continue",exact:true}).click();await expect(status.getByRole("alert")).toContainText(message);
 }
 await expect(page.getByText("PRIVATE_RUN_CANARY",{exact:false})).toHaveCount(0);
 // Active work makes the host record a skipped backup; the summary says so plainly.
 await expect(status).toContainText("Backup skipped. Murage was busy, so no backup was taken.");
 await page.evaluate(()=>{(window as any).runMode="ok";});await now.click();await status.getByRole("button",{name:"Continue",exact:true}).click();await expect(status.getByText("Backup requested.",{exact:false})).toBeVisible();
 const calls=await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="run-now"||c.action==="copy-key"));
 expect(calls.filter((c:any)=>c.action==="copy-key").every((c:any)=>c.args.length===0)).toBe(true);
 // Six: the one setup took, then the five this test drove.
 const revision=await page.evaluate(()=>(window as any).state.revision);expect(calls.filter((c:any)=>c.action==="run-now")).toEqual(Array(6).fill({action:"run-now",revision,rest:0}));
 expect(errors).toEqual([]);
});
test("a refused key save clears the earlier saved line, and a refused background job says why beside its checkbox",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page,false,true);
 await page.getByRole("button",{name:"Turn on backups",exact:true}).click();
 await expect(page.getByText("Your recovery key is Murage recovery key.age, saved in Documents.")).toBeVisible();
 const copy=page.getByRole("button",{name:"Save a copy…",exact:true});
 await copy.click();await expect(page.getByText("A copy was saved as usb-key.txt.")).toBeVisible();
 // The desktop app answers "that name exists" as a value, not a thrown error.
 await page.evaluate(()=>{(window as any).keyMode="exists";});await copy.click();
 await expect(page.getByRole("alert")).toContainText("A file with that name already exists.");
 await page.evaluate(()=>{(window as any).keyMode="inside";});await copy.click();await expect(page.getByRole("alert")).toContainText("outside your backup folder");
 // The key itself is unchanged by a refused copy: it is still named on the page.
 await expect(page.getByText("Your recovery key is Murage recovery key.age, saved in Documents.")).toBeVisible();
 // No systemd user session: registering fails, and afterwards the job cannot be read.
 await page.evaluate(()=>{
  const w=window as any;w.closedState={supported:true,state:"unconfigured",closedApp:false};
  w.muragebox.backupClosed={
   status:async()=>structuredClone(w.closedState),
   stage:async()=>{w.closedState.state="staged";return structuredClone(w.closedState);},
   install:async()=>{if(w.closedGone)w.closedState.state="unavailable";throw Error("BACKUP_CLOSED_REVIEW_REQUIRED");},
   disable:async()=>structuredClone(w.closedState),
  };
 });
 await refreshSchedule(page);
 const permission=page.getByRole("checkbox",{name:"Also back up when Murage is closed",exact:true});
 const reason="Your system didn't let Murage register a background job, so backups run only while Murage is open.";
 await expect(permission).toBeEnabled();await expect(page.getByText(reason)).toHaveCount(0);
 // Registration refused but the prepared job is still readable: the box can be
 // tried again, and the reason is already beside it.
 await permission.click();await expect(page.getByText(reason)).toBeVisible();await expect(permission).not.toBeChecked();await expect(permission).toBeEnabled();
 await page.evaluate(()=>{(window as any).closedGone=true;});
 await permission.click();
 await expect(page.getByText(reason)).toBeVisible();await expect(permission).not.toBeChecked();await expect(permission).toBeDisabled();
 await expect(permission).toHaveAccessibleDescription(new RegExp(reason.replace(/[.,']/g,".")));
 // Beside the checkbox, not only under Advanced.
 const [box,line]=await Promise.all([permission.boundingBox(),page.getByText(reason).boundingBox()]);expect(line!.y-box!.y).toBeLessThan(120);
 for(const width of [390,1440])await inspect(page,info,"closed-refused",width);
 expect(errors).toEqual([]);
});
test("remote backup explicit save connect upload and uncertainty",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page,true);
 const panel=await openPanel(page,"Off-site copy (optional)"),refresh=async()=>refreshRemote(page);
 // Was: "Save remote destination".
 const save=panel.getByRole("button",{name:"Save off-site destination",exact:true});await expect(save).toBeDisabled();
 for(const [name,value]of [["Destination name","Fixture remote"],["S3 endpoint (HTTPS)","https://s3.example.invalid"],["Bucket name","fixture-bucket"],["Repository folder","murage"],["Region","auto"],["Access key ID","FAKE_ACCESS"],["Secret access key","FAKE_SECRET"]])await panel.getByLabel(name,{exact:true}).fill(value);
 await expect(save).toBeEnabled();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action.startsWith("remote-")).length)).toBe(0);
 await page.evaluate(()=>{(window as any).remoteMode="save-fail";});await save.click();await expect(panel.getByLabel("Secret access key",{exact:true})).toHaveValue("");await expect(panel.getByText("PRIVATE_REMOTE_CANARY",{exact:false})).toHaveCount(0);await expect(save).toBeDisabled();
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await refresh();await panel.getByLabel("Access key ID",{exact:true}).fill("FAKE_ACCESS");await panel.getByLabel("Secret access key",{exact:true}).fill("FAKE_SECRET");
 await save.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Destination saved securely. Nothing has been connected or uploaded.")).toBeVisible();await expect(panel.getByLabel("Secret access key",{exact:true})).toHaveCount(0);
 // Was: "Choose repository-password file".
 const password=panel.getByRole("button",{name:"Choose off-site password file",exact:true}),connect=panel.getByRole("button",{name:"Connect existing repository",exact:true}),upload=panel.getByRole("button",{name:"Upload latest verified backup",exact:true}),consent=panel.getByRole("checkbox");
 await expect(connect).toBeDisabled();await page.evaluate(()=>{(window as any).remoteMode="cancel";});await password.click();await expect(panel.getByText("Password selection cancelled. Saved settings are unchanged.")).toBeVisible();await expect(connect).toBeDisabled();
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await password.click();await expect(connect).toBeEnabled();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-connect").length)).toBe(0);
 // Was: status "Repository connection confirmed".
 await connect.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Off-site storage connected",{exact:true})).toBeVisible();await expect(upload).toBeDisabled();await consent.focus();await page.keyboard.press("Space");await expect(upload).toBeEnabled();
 await page.evaluate(()=>{(window as any).remoteFail=true;});await refresh();await expect(upload).toBeDisabled();await expect(consent).not.toBeChecked();await expect(page.getByRole("region",{name:"Your backups"})).toContainText("Off-site status needs a refresh.");await page.evaluate(()=>{(window as any).remoteFail=false;});await refresh();await consent.check();
 for(const width of [390,820,1440])await inspect(page,info,"remote-ready",width);
 await page.evaluate(()=>{(window as any).remoteMode="hold";});await upload.click();await expect(panel.getByRole("button",{name:"Uploading and verifying…",exact:true})).toBeDisabled();await expect(password).toBeDisabled();
 await page.evaluate(()=>{const w=window as any;w.remoteMode="uncertain";w.remoteRelease();});await expect(panel.getByText("Upload needs review.",{exact:false})).toBeVisible();await expect(consent).not.toBeChecked();await expect(upload).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-upload"))).toEqual([{action:"remote-upload",ref:"remote-one",revision:2,jobId:"a".repeat(64)}]);
 // Was: "Recorded remote result for the latest backup:". A configured off-site copy opens expanded.
 await page.reload();await page.waitForLoadState("networkidle");await expect(panel.getByText("Recorded off-site result for the latest backup:",{exact:false})).toContainText("needs review; no automatic retry");await expect(page.getByRole("region",{name:"Your backups"})).toContainText("The last off-site upload needs review.");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-upload").length)).toBe(0);
 for(const width of [390,820,1440])await inspect(page,info,"remote-review",width);
 // Was: "Check existing remote copy" / "Existing remote copy verified. Nothing was uploaded again."
 const reconcile=panel.getByRole("button",{name:"Check existing off-site copy",exact:true});await expect(reconcile).toBeEnabled();await reconcile.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Existing off-site copy verified. Nothing was uploaded again.")).toBeVisible();await expect(panel.getByText("Recorded off-site result for the latest backup:",{exact:false})).toContainText("copy verified by readback");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-upload").length)).toBe(0);
 // Was: "A supported desktop build with its verified Restic tool is required."
 await page.evaluate(()=>{(window as any).remoteState.supported=false;});await refresh();await expect(password).toHaveCount(0);await expect(panel.getByText("Off-site copies need a supported desktop build with its verified backup tool.",{exact:false})).toBeVisible();expect(errors).toEqual([]);
});
test("remote destination form keyboard and narrow layout",async({page},info)=>{
 await setup(page,true);const panel=await openPanel(page,"Off-site copy (optional)");await panel.locator("summary").click();
 const total=await panel.evaluate(node=>{const elements=[...node.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary")].filter(el=>el.getBoundingClientRect().height>0);elements.forEach((el,index)=>el.dataset.remoteTab=String(index));return elements.length;});
 expect(total).toBeGreaterThan(8);await panel.locator('[data-remote-tab="0"]').focus();await page.keyboard.press("Shift+Tab");const seen=new Set<string>();
 for(let i=0;i<total;i++){
  await page.keyboard.press("Tab");const focus=await page.evaluate(()=>{const el=document.activeElement as HTMLElement,style=getComputedStyle(el);return{id:el.dataset.remoteTab,visible:style.outlineStyle!=="none"&&parseFloat(style.outlineWidth)>0||style.boxShadow!=="none"};});
  expect(focus.id).toBeDefined();expect(focus.visible).toBe(true);seen.add(focus.id!);
 }
 expect(seen.size).toBe(total);
 for(const width of [390,820,1440]){
  await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(axe);const report=await page.evaluate(async()=>(window as any).axe.run(document));expect(report.violations).toEqual([]);writeFileSync(info.outputPath(`remote-form-axe-${width}.json`),JSON.stringify(report));await panel.screenshot({path:info.outputPath(`remote-form-${width}.png`)});
 }
});
test("remote recovery without local record requires explicit find download and backup-mode action",async({page},info)=>{
 // Off-site recovery moved to the Restore card.
 await setup(page,true);
 await page.evaluate(()=>{const w=window as any;delete w.state.lastVerified;w.remoteState={supported:true,pending:false,configured:true,state:"connected",revision:1,remoteRef:"remote-one",label:"Fixture recovery",passwordSelected:true};});await refreshRemote(page);
 const panel=await openPanel(page,"Restore");
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-list"||c.action==="remote-download"||c.action==="manual").length)).toBe(0);
 // Was: "Find remote backups".
 const find=panel.getByRole("button",{name:"Find off-site backups",exact:true});await expect(find).toBeEnabled();await find.focus();await page.keyboard.press("Enter");
 const select=panel.getByRole("combobox",{name:"Backup to recover",exact:true}),download=panel.getByRole("button",{name:"Download verified copy",exact:true});await expect(download).toBeDisabled();await select.selectOption("d".repeat(64));await expect(download).toBeEnabled();await expect(panel.getByText("Listed copies are not verified yet.",{exact:false})).toBeVisible();
 await page.evaluate(()=>{(window as any).remoteMode="cancel";});await download.click();await expect(panel.getByText("Download cancelled. Your current installation is unchanged.")).toBeVisible();await expect(panel.getByRole("button",{name:"Open Backup mode to restore",exact:true})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await download.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Encrypted backup downloaded and verified. Nothing has been restored or restarted.")).toBeVisible();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="manual").length)).toBe(0);
 for(const width of [390,820,1440]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(axe);const report=await page.evaluate(async()=>(window as any).axe.run(document));expect(report.violations).toEqual([]);writeFileSync(info.outputPath(`recovery-axe-${width}.json`),JSON.stringify(report));await panel.screenshot({path:info.outputPath(`recovery-${width}.png`)});}
 await panel.getByRole("button",{name:"Open Backup mode to restore",exact:true}).focus();await page.keyboard.press("Enter");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="manual").length)).toBe(1);await expect(panel.getByText("Backup mode was not opened. The downloaded copy is still saved.")).toBeVisible();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-download").every((c:any)=>c.ref==="remote-one"&&c.revision===1&&c.snapshotId==="d".repeat(64)))).toBe(true);
});
test("automatic remote uploads require explicit consent and preserve review pause",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page,true);
 const panel=page.getByRole("region",{name:"Off-site copy (optional)"}),refresh={click:()=>refreshRemote(page)};
 await page.evaluate(()=>{const w=window as any;w.remoteState={supported:true,pending:false,configured:true,state:"disconnected",revision:2,remoteRef:"remote-one",label:"Fixture automatic backup",passwordSelected:true};
  w.muragebox.backupRemote.setAutomaticUpload=async(ref:string,revision:number,enabled:boolean)=>{w.calls.push({action:"remote-automatic",ref,revision,enabled});if(w.remoteMode==="hold")await new Promise(resolve=>w.remoteRelease=resolve);if(ref!==w.remoteState.remoteRef||revision!==w.remoteState.revision)throw Error("BACKUP_REMOTE_CHANGED");w.remoteState.automaticUpload={enabled,state:enabled?"enabled":"disabled"};return{saved:true};};
 });await refresh.click();
 const enable=panel.getByRole("button",{name:"Enable automatic uploads",exact:true}),disable=panel.getByRole("button",{name:"Disable automatic uploads",exact:true});
 await expect(enable).toBeDisabled();await expect(panel.getByText("Automatic uploads are off.",{exact:true})).toBeVisible();
 await panel.getByRole("button",{name:"Connect existing repository",exact:true}).click();await expect(enable).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-automatic"||c.action==="remote-upload"))).toEqual([]);
 await expect(panel.getByText("When enabled, future locally verified backups",{exact:false})).toContainText("while Murage is open");
 await expect(panel.getByText("When enabled, future locally verified backups",{exact:false})).toContainText("Existing backups are not uploaded");
 await enable.focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");await expect(enable).toBeFocused();
 expect(await enable.evaluate(el=>{const s=getComputedStyle(el);return s.outlineStyle!=="none"&&parseFloat(s.outlineWidth)>0||s.boxShadow!=="none";})).toBe(true);
 await page.evaluate(()=>{(window as any).remoteMode="hold";});await page.keyboard.press("Enter");await expect(panel.getByRole("button",{name:"Saving automatic upload setting…",exact:true})).toBeDisabled();
 await page.evaluate(()=>{const w=window as any;w.remoteMode="ok";w.remoteRelease();});await expect(disable).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-automatic"))).toEqual([{action:"remote-automatic",ref:"remote-one",revision:2,enabled:true}]);
 await refresh.click();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-automatic").length)).toBe(1);
 await page.evaluate(()=>{const w=window as any;w.remoteState.automaticUpload={enabled:true,state:"needs-review"};w.remoteState.state="disconnected";});await refresh.click();
 await expect(panel.getByText("Automatic uploads paused for review.",{exact:true})).toBeVisible();await expect(disable).toBeEnabled();
 await expect(panel.getByText("Review the uncertain upload first.",{exact:false})).toContainText("This does not retry the same backup");
 for(const width of [390,820,1440]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(axe);const report=await page.evaluate(async()=>(window as any).axe.run(document));expect(report.violations).toEqual([]);writeFileSync(info.outputPath(`automatic-axe-${width}.json`),JSON.stringify(report));await panel.screenshot({path:info.outputPath(`automatic-${width}.png`)});}
 await disable.focus();await page.keyboard.press("Enter");await expect(enable).toBeDisabled();await expect(panel.getByText("Automatic uploads are off.",{exact:true})).toBeVisible();
 await page.evaluate(()=>{const w=window as any;w.remoteState.state="connected";delete w.muragebox.backupRemote.setAutomaticUpload;});await refresh.click();await expect(enable).toBeDisabled();await expect(panel.getByText("Automatic uploads require an updated desktop app.")).toBeVisible();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-upload"))).toEqual([]);expect(errors).toEqual([]);
});
test("remote retention requires a separate maintenance key, an exact preview and explicit removal consent",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 await page.addInitScript(()=>{if(!sessionStorage.getItem("fixtureRemoteStatus"))sessionStorage.setItem("fixtureRemoteStatus",JSON.stringify({supported:true,pending:false,configured:true,state:"connected",revision:2,remoteRef:"remote-one",label:"Fixture remote",passwordSelected:true,maintenanceSelected:false}));});
 await setup(page,true);
 // Maintenance key and removal clean-up moved under Advanced.
 const panel=await openPanel(page,"Advanced"),refresh=panel.getByRole("button",{name:"Refresh off-site status",exact:true});
 const saveKey=panel.getByRole("button",{name:"Save maintenance access key",exact:true}),previewButton=panel.getByRole("button",{name:"Preview removals",exact:true}),keepLast=panel.getByLabel("Keep latest copies",{exact:true});
 await expect(panel.getByText("Maintenance access key: not saved.",{exact:false})).toBeVisible();await expect(saveKey).toBeDisabled();await expect(previewButton).toBeDisabled();
 await keepLast.fill("1");await expect(previewButton).toBeDisabled();
 await page.evaluate(()=>{(window as any).remoteMode="maintenance-fail";});
 await panel.getByLabel("Maintenance access key ID",{exact:true}).fill("FAKE_MAINTENANCE");await panel.getByLabel("Maintenance secret access key",{exact:true}).fill("FAKE_MAINTENANCE_SECRET");
 await saveKey.click();await expect(panel.getByLabel("Maintenance secret access key",{exact:true})).toHaveValue("");await expect(panel.getByText("PRIVATE_REMOTE_CANARY",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await refresh.click();
 await panel.getByLabel("Maintenance access key ID",{exact:true}).fill("FAKE_MAINTENANCE");await panel.getByLabel("Maintenance secret access key",{exact:true}).fill("FAKE_MAINTENANCE_SECRET");
 await saveKey.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Maintenance access key saved securely. Nothing was removed.")).toBeVisible();await expect(panel.getByText("Maintenance access key: saved.",{exact:false})).toBeVisible();
 for(const value of ["0","1001","2.5"]){await keepLast.fill(value);await expect(previewButton).toBeDisabled();}
 await keepLast.fill("1");await expect(previewButton).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>["remote-preview","remote-apply"].includes(c.action)).length)).toBe(0);
 // Was: "2 remote copies would be removed."
 await previewButton.focus();await page.keyboard.press("Enter");await expect(panel.getByText("2 off-site copies would be removed.",{exact:false})).toBeVisible();
 const consent=panel.getByRole("checkbox",{name:"Permanently remove exactly these previewed copies and reclaim unused storage. This cannot be undone."}),removeButton=panel.getByRole("button",{name:"Remove previewed copies",exact:true});
 await expect(removeButton).toBeDisabled();
 for(const width of [390,820,1440])await inspect(page,info,"remote-retention-preview",width);
 await keepLast.fill("2");await expect(removeButton).toHaveCount(0);await keepLast.fill("1");await expect(removeButton).toHaveCount(0);
 await previewButton.click();await expect(removeButton).toBeDisabled();await consent.focus();await page.keyboard.press("Space");await expect(removeButton).toBeEnabled();
 await page.evaluate(()=>{(window as any).remoteMode="retention-changed";});await removeButton.click();
 await expect(panel.getByText("The repository changed since the preview. Nothing was removed.",{exact:false})).toBeVisible();await expect(panel.getByText("PRIVATE_REMOTE_CANARY",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await refresh.click();await expect(removeButton).toHaveCount(0);
 await previewButton.click();await consent.check();await page.evaluate(()=>{(window as any).remoteMode="retention-review";});await removeButton.focus();await page.keyboard.press("Enter");
 await expect(panel.getByText("Removal needs review. Nothing will be retried automatically.")).toBeVisible();
 await expect(panel.getByText("Last removal: needs review",{exact:false})).toContainText("the repository stayed locked");
 const clear=panel.getByRole("button",{name:"Mark removal reviewed",exact:true});await expect(clear).toBeEnabled();
 for(const width of [390,820,1440])await inspect(page,info,"remote-retention-review",width);
 await clear.click();await expect(panel.getByText("Removal review cleared. Preview again before removing anything.")).toBeVisible();await expect(clear).toHaveCount(0);
 const calls=await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action.startsWith("remote-")));
 expect(calls.filter((c:any)=>c.action==="remote-apply")).toEqual([{action:"remote-apply",ref:"remote-one",revision:2,policy:{keepLast:1},previewId:"2".repeat(64)},{action:"remote-apply",ref:"remote-one",revision:2,policy:{keepLast:1},previewId:"3".repeat(64)}]);
 expect(calls.filter((c:any)=>c.action==="remote-clear")).toEqual([{action:"remote-clear",ref:"remote-one",revision:2,previewId:"3".repeat(64)}]);
 expect(JSON.stringify(calls)).not.toContain("FAKE_MAINTENANCE");expect(errors).toEqual([]);
});

for(const phase of ["forgetting","pruning"]){
 test(`remote unfinished ${phase} offers review and requires fresh preview`,async({page},info)=>{
  await page.addInitScript(phase=>sessionStorage.setItem("fixtureRemoteStatus",JSON.stringify({supported:true,pending:false,configured:true,state:"connected",revision:2,remoteRef:"remote-one",label:"Fixture remote",passwordSelected:true,maintenanceSelected:true,retention:{state:phase,previewId:"f".repeat(64),removed:2}})),phase);
  await setup(page,true);const panel=await openPanel(page,"Advanced");
  await expect(panel.getByText("Last removal: not finished; needs review.",{exact:false})).toBeVisible();
  const clear=panel.getByRole("button",{name:"Mark removal reviewed",exact:true});await expect(clear).toBeEnabled();
  for(const width of [390,820,1440])await inspect(page,info,`unfinished-${phase}`,width);
  await page.evaluate(()=>{(window as any).remoteState.pending=true;});await panel.getByRole("button",{name:"Refresh off-site status",exact:true}).click();await expect(clear).toBeDisabled();
  await page.evaluate(()=>{(window as any).remoteState.pending=false;});await panel.getByRole("button",{name:"Refresh off-site status",exact:true}).click();await expect(clear).toBeEnabled();
  await clear.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Removal review cleared. Preview again before removing anything.")).toBeVisible();await expect(clear).toHaveCount(0);
  await expect(panel.getByRole("button",{name:"Remove previewed copies",exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>["remote-clear","remote-apply","remote-preview"].includes(c.action)))).toEqual([{action:"remote-clear",ref:"remote-one",revision:2,previewId:"f".repeat(64)}]);
 });
}
