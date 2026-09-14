import {test,expect,type Page,type TestInfo} from "@playwright/test";
import {createServer,type ViteDevServer} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {safeWipeSync} from "../../server/testing/safe-wipe.mjs";
let vite:ViteDevServer,origin:string,cache:string;
const root=fileURLToPath(new URL("../../",import.meta.url));
const axe=readFileSync("/Users/seandonahoe/.sable/web/tools/node_modules/axe-core/axe.min.js","utf8");
test.beforeAll(async()=>{
 cache=mkdtempSync(join(tmpdir(),"murage-schedule-ui-"));
 vite=await createServer({configFile:false,envFile:false,root,cacheDir:cache,resolve:{alias:{"@":join(root,"src")}},server:{host:"127.0.0.1",watch:null,hmr:false},plugins:[react(),tailwindcss(),{
  name:"schedule-ui-fixture",resolveId(id){if(id==="/__schedule.js")return "\0schedule-ui";},load(id){if(id!=="\0schedule-ui")return;return `import React from'react';import{createRoot}from'react-dom/client';import{BackupSettings}from'/src/components/BackupSettings.tsx';import'/src/styles.css';window.unmountFixture=()=>app.unmount();const app=createRoot(document.getElementById('root'));app.render(React.createElement(BackupSettings));`;},
  configureServer(server){server.middlewares.use((req,res,next)=>{
   if(new URL(req.url??"/","http://fixture").pathname!=="/__schedule")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><html lang="en" data-schedule-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scheduled backup fixture</title><style>html[data-schedule-fixture],html[data-schedule-fixture] body{height:auto;min-height:100%;position:static;overflow:auto}html[data-schedule-fixture] #root{height:auto;overflow:visible}</style></head><body><main style="max-width:720px;margin:auto;padding:16px"><h1 class="text-ink text-lg">Settings</h1><h2 class="text-ink text-base">General</h2><div id="root"></div></main><script type="module" src="/__schedule.js"></script></body></html>');
  });},
 }]});await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await vite?.close();safeWipeSync(cache);});
async function setup(page:Page,withRemote=false){
 await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.addInitScript(withRemote=>{
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
   };
  }
 },withRemote);
 await page.goto(origin+"/__schedule");await page.waitForLoadState("networkidle");await expect(page.getByText("Schedule Off.",{exact:false})).toBeVisible();
}
async function fill(page:Page){
 await page.getByLabel("Daily time",{exact:true}).fill("22:15");await page.getByLabel("Timezone",{exact:true}).fill("Asia/Bangkok");
 await page.getByLabel("Catch-up window (hours)",{exact:true}).fill("2");await page.getByLabel("Maximum backup size (GiB)",{exact:true}).fill("1");await page.getByLabel("Maximum run duration (minutes)",{exact:true}).fill("10");
}
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
 await page.setViewportSize({width:1440,height:900});await setup(page);await page.getByRole("button",{name:"Choose destination and recovery key",exact:true}).click();await fill(page);await page.getByRole("checkbox").check();await page.locator("body").click({position:{x:1,y:1}});
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
 const choose=page.getByRole("button",{name:"Choose destination and recovery key",exact:true}),enable=page.getByRole("button",{name:"Enable scheduled backups",exact:true});
 await expect(enable).toBeDisabled();await expect(page.getByText("No recovery key is created or exported here.",{exact:false})).toBeVisible();
 for(const width of [390,820,1440])await inspect(page,info,"off",width);
 await page.evaluate(()=>{(window as any).mode="cancel";});await choose.click();await expect(page.getByText("Selection cancelled. Schedule unchanged.")).toBeVisible();await expect(enable).toBeDisabled();
 await page.evaluate(()=>{(window as any).mode="ok";});await choose.focus();await page.keyboard.press("Enter");await expect(page.getByText("References selected. Scheduling has not been enabled.")).toBeVisible();
 await fill(page);await expect(enable).toBeDisabled();await page.getByRole("checkbox").focus();await page.keyboard.press("Space");await expect(enable).toBeEnabled();
 await keyboardAudit(page,info);for(const width of [390,820,1440])await inspect(page,info,"ready",width);
 await enable.focus();await page.keyboard.press("Enter");const disable=page.getByRole("button",{name:"Disable schedule",exact:true});await expect(disable).toBeEnabled();await expect(choose).toBeDisabled();await expect(page.getByLabel("Daily time",{exact:true})).toBeDisabled();
 const first=await page.evaluate(()=>(window as any).calls.find((c:any)=>c.action==="configure"));expect(first).toEqual({action:"configure",revision:1,choices:{enabled:true,preUpgrade:false,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",time:"22:15",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},allowIdleRestart:true}});
 for(const width of [390,820,1440])await inspect(page,info,"enabled",width);
 await disable.focus();await page.keyboard.press("Enter");await expect(choose).toBeEnabled();await expect(page.getByText("An existing transfer is not cancelled.",{exact:false})).toBeVisible();
 const second=await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="configure")[1]);const{allowIdleRestart,...prior}=first.choices;expect(second).toEqual({action:"configure",revision:2,choices:{...prior,enabled:false}});
 await expect(page.getByRole("checkbox")).not.toBeChecked();await page.getByRole("button",{name:"Restart into Backup mode",exact:true}).click();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="manual").length)).toBe(1);
 expect(errors).toEqual([]);
});
test("pre-upgrade opt-in is capability gated, preserves schedule choices and renews consent",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page);
 const refresh=page.getByRole("button",{name:"Refresh schedule status",exact:true}),preUpgrade=page.getByRole("checkbox",{name:"Back up before installing an in-app update.",exact:true}),consent=page.getByRole("checkbox",{name:"Allow Murage to close an idle workspace for this backup and reopen it afterward.",exact:true}),enable=page.getByRole("button",{name:"Enable scheduled backups",exact:true});
 await expect(preUpgrade).toHaveCount(0);await page.evaluate(()=>{(window as any).state.preUpgradeSupported=false;});await refresh.click();await expect(preUpgrade).toHaveCount(0);
 await page.evaluate(()=>{(window as any).state.preUpgradeSupported=true;});await refresh.click();await expect(preUpgrade).not.toBeChecked();expect(await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==="configure"))).toEqual([]);
 await page.getByRole("button",{name:"Choose destination and recovery key",exact:true}).click();await fill(page);await consent.check();await expect(enable).toBeEnabled();
 await preUpgrade.focus();await page.keyboard.press("Space");await expect(preUpgrade).toBeChecked();await expect(consent).not.toBeChecked();await expect(enable).toBeDisabled();await consent.focus();await page.keyboard.press("Space");await expect(enable).toBeEnabled();
 await keyboardAudit(page,info);for(const width of [390,820,1440])await inspect(page,info,"pre-upgrade-opt-in",width);
 await enable.focus();await page.keyboard.press("Enter");const disable=page.getByRole("button",{name:"Disable schedule",exact:true});await expect(disable).toBeEnabled();await expect(preUpgrade).toBeChecked();await expect(preUpgrade).toBeDisabled();
 const first=await page.evaluate(()=>(window as any).calls.find((call:any)=>call.action==="configure"));expect(first).toEqual({action:"configure",revision:1,choices:{enabled:true,preUpgrade:true,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",time:"22:15",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},allowIdleRestart:true}});
 for(const width of [390,820,1440])await inspect(page,info,"pre-upgrade-enabled",width);
 await disable.click();await expect(preUpgrade).toBeChecked();await expect(preUpgrade).toBeEnabled();const second=await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==="configure")[1]);const{allowIdleRestart,...saved}=first.choices;expect(second).toEqual({action:"configure",revision:2,choices:{...saved,enabled:false}});
 await page.evaluate(()=>{(window as any).state.preUpgradeSupported=false;});await refresh.click();await expect(preUpgrade).toHaveCount(0);await expect(page.getByText("Pre-upgrade backups are unavailable in this app.",{exact:false})).toBeVisible();await expect(enable).toBeDisabled();expect(await page.evaluate(()=>(window as any).state.schedule.preUpgrade)).toBe(true);
 await page.evaluate(()=>{(window as any).state.preUpgradeSupported=true;});await refresh.click();await expect(preUpgrade).toBeChecked();await expect(page.getByLabel("Daily time",{exact:true})).toHaveValue("22:15");await expect(page.getByLabel("Maximum run duration (minutes)",{exact:true})).toHaveValue("10");
 for(const[phase,label,locked]of [["install-requested","Update installation requested",true],["upgrade-complete","Update completed after backup",false],["upgrade-cancelled","Update cancelled",false]]as const){await page.evaluate(phase=>{(window as any).state.phase=phase;},phase);await refresh.click();await expect(page.getByText(label,{exact:false})).toBeVisible();if(locked)await expect(preUpgrade).toBeDisabled();else await expect(preUpgrade).toBeEnabled();}
 await consent.check();await preUpgrade.uncheck();await expect(consent).not.toBeChecked();await expect(enable).toBeDisabled();await consent.check();await enable.click();const last=await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==="configure").at(-1));expect(last.choices).toEqual({...first.choices,preUpgrade:false});expect(errors).toEqual([]);
});
test("pending, conflicts, stale state, review and verified receipt remain truthful",async({page},info)=>{
 await setup(page);const choose=page.getByRole("button",{name:"Choose destination and recovery key",exact:true}),refresh=page.getByRole("button",{name:"Refresh schedule status",exact:true});
 await page.evaluate(()=>{(window as any).mode="hold";});await choose.click();await expect(choose).toBeDisabled();await expect(refresh).toBeDisabled();await page.evaluate(()=>(window as any).release());await expect(choose).toBeEnabled();
 await fill(page);await page.getByRole("checkbox").check();await page.evaluate(()=>{(window as any).mode="conflict";});await page.getByRole("button",{name:"Enable scheduled backups",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Settings changed");await expect(page.getByLabel("Daily time",{exact:true})).toHaveValue("22:15");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="configure").length)).toBe(1);
 await page.evaluate(()=>{(window as any).mode="error";});await page.getByRole("button",{name:"Enable scheduled backups",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Your data is preserved");await expect(page.getByText("PRIVATE_KEY_CANARY",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{const w=window as any;w.state.pending=true;w.state.phase="capturing";});await refresh.click();await expect(choose).toBeDisabled();await expect(page.getByText("Backup work is pending.",{exact:false})).toBeVisible();
 for(const width of [390,820,1440])await inspect(page,info,"pending",width);
 await page.evaluate(()=>{(window as any).statusFail=true;});await refresh.click();await expect(page.getByText("Status refresh failed.",{exact:false})).toBeVisible();await expect(choose).toBeDisabled();
 await page.evaluate(()=>{const w=window as any;w.statusFail=false;w.state.pending=false;w.state.enabled=true;w.state.schedule={enabled:true,preUpgrade:false,time:"22:15",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}};w.state.phase="needs-review";w.mode="ok";});await refresh.click();await expect(page.getByText("automatic retry is paused",{exact:false})).toBeVisible();await expect(choose).toBeDisabled();await expect(page.getByRole("button",{name:"Disable schedule",exact:true})).toBeEnabled();
 for(const width of [390,820,1440])await inspect(page,info,"review",width);
 await page.getByRole("button",{name:"Disable schedule",exact:true}).click();await expect(choose).toBeDisabled();await expect(page.getByRole("button",{name:"Enable scheduled backups",exact:true})).toBeDisabled();
 await page.evaluate(()=>{const w=window as any;w.state.phase="returned";w.state.lastVerified={verifiedAt:1700000000000,bytes:2048};});await refresh.click();await expect(page.getByText("Last locally verified backup:",{exact:false})).toContainText("2,048 bytes");await expect(page.getByText("This is not a restore-drill result.",{exact:false})).toBeVisible();
 // Pending status changes arrive through polling; unmount ends the timer.
 await page.evaluate(()=>{(window as any).state.pending=true;});await refresh.click();await page.evaluate(()=>{(window as any).state.pending=false;});await expect(page.getByText("Backup work is pending.",{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).state.pending=true;});await refresh.click();await page.evaluate(()=>(window as any).unmountFixture());const count=await page.evaluate(()=>(window as any).calls.length);await page.waitForTimeout(2200);expect(await page.evaluate(()=>(window as any).calls.length)).toBe(count);
});
test("unsupported and missing native bridge never expose schedule mutation",async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).state.supported=false;});await page.getByRole("button",{name:"Refresh schedule status",exact:true}).click();await expect(page.getByRole("button",{name:"Choose destination and recovery key",exact:true})).toHaveCount(0);
 await page.addInitScript(()=>{delete(window as any).muragebox.backupSchedule;});await page.reload();await expect(page.getByText("Scheduling unavailable in this window")).toBeVisible();await expect(page.locator("input")).toHaveCount(0);
});
test("closed-app registration, consent, stale status and disable-all journey",async({page},info)=>{
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
 const refresh=page.getByRole("button",{name:"Refresh schedule status",exact:true});await refresh.click();
 // This test installs its fake bridge after mount. The first schedule refresh
 // renders that bridge; the next refresh uses the newly rendered callback.
 await expect(page.getByText("Checking closed-app job status…",{exact:true})).toBeVisible();await refresh.click();
 const permission=page.getByRole("checkbox",{name:"Allow scheduled backups while Murage is closed, while I am signed in.",exact:true});
 const consent=page.getByRole("checkbox",{name:"Allow Murage to close an idle workspace for this backup and reopen it afterward.",exact:true});
 const enable=page.getByRole("button",{name:"Enable scheduled backups",exact:true});
 await expect(permission).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action.startsWith("closed-")).length)).toBe(0);
 await page.getByRole("button",{name:"Prepare closed-app job",exact:true}).click();await expect(page.getByText("Job prepared, not registered",{exact:true})).toBeVisible();
 const register=page.getByRole("button",{name:"Register prepared job",exact:true});
 await page.evaluate(()=>{(window as any).closedMode="cancel";});await register.click();await expect(page.getByText("Job registration cancelled. Scheduling settings are unchanged.")).toBeVisible();await expect(permission).toBeDisabled();
 await page.evaluate(()=>{(window as any).closedMode="error";});await register.click();await expect(page.getByText("PRIVATE_CLOSED_CANARY",{exact:false})).toHaveCount(0);await expect(permission).toBeDisabled();
 await page.evaluate(()=>{(window as any).closedMode="ok";});await register.focus();await page.keyboard.press("Enter");await expect(page.getByText("Job registration confirmed",{exact:true})).toBeVisible();await expect(permission).toBeEnabled();await expect(permission).not.toBeChecked();
 await page.getByRole("button",{name:"Choose destination and recovery key",exact:true}).click();await fill(page);await consent.check();await permission.focus();await page.keyboard.press("Space");await expect(consent).not.toBeChecked();await expect(enable).toBeDisabled();await consent.check();
 await page.evaluate(()=>{(window as any).closedMode="stale";});await refresh.click();await expect(enable).toBeDisabled();await expect(page.getByText("Job status could not be refreshed.",{exact:false})).toBeVisible();
 await page.evaluate(()=>{(window as any).closedMode="ok";});await refresh.click();await expect(enable).toBeEnabled();
 for(const width of [390,820,1440])await inspect(page,info,"closed-ready",width);
 await enable.focus();await page.keyboard.press("Enter");await expect(page.getByRole("button",{name:"Disable schedule",exact:true})).toBeEnabled();
 const call=await page.evaluate(()=>(window as any).calls.find((c:any)=>c.action==="configure"));expect(call.choices).toMatchObject({closedApp:true,allowClosedApp:true,allowIdleRestart:true});
 await page.evaluate(()=>{(window as any).state.lastClosedResult={status:"verified",at:1700000000000,revision:2};});await refresh.click();await expect(page.getByText("Last closed-app result:",{exact:false})).toContainText("Backup verified");
 await page.getByRole("button",{name:"Disable all scheduled backups and remove job",exact:true}).click();await expect(page.getByText("Schedule Off.",{exact:false})).toBeVisible();await expect(page.getByText("All scheduled backups are disabled. Job removal is pending; any running backup is not cancelled.")).toBeVisible();await expect(permission).toBeChecked();await expect(enable).toBeDisabled();
 for(const width of [390,820,1440])await inspect(page,info,"closed-removal-pending",width);
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action.startsWith("closed-")).every((c:any)=>c.args.length===0))).toBe(true);expect(errors).toEqual([]);
});
test("remote backup explicit save connect upload and uncertainty",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page,true);
 const panel=page.getByRole("region",{name:"Remote backup (optional)"}),refresh=panel.getByRole("button",{name:"Refresh remote backup status",exact:true});
 const save=panel.getByRole("button",{name:"Save remote destination",exact:true});await expect(save).toBeDisabled();
 for(const [name,value]of [["Destination name","Fixture remote"],["S3 endpoint (HTTPS)","https://s3.example.invalid"],["Bucket name","fixture-bucket"],["Repository folder","murage"],["Region","auto"],["Access key ID","FAKE_ACCESS"],["Secret access key","FAKE_SECRET"]])await panel.getByLabel(name,{exact:true}).fill(value);
 await expect(save).toBeEnabled();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action.startsWith("remote-")).length)).toBe(0);
 await page.evaluate(()=>{(window as any).remoteMode="save-fail";});await save.click();await expect(panel.getByLabel("Secret access key",{exact:true})).toHaveValue("");await expect(panel.getByText("PRIVATE_REMOTE_CANARY",{exact:false})).toHaveCount(0);await expect(save).toBeDisabled();
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await refresh.click();await panel.getByLabel("Access key ID",{exact:true}).fill("FAKE_ACCESS");await panel.getByLabel("Secret access key",{exact:true}).fill("FAKE_SECRET");
 await save.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Destination saved securely. Nothing has been connected or uploaded.")).toBeVisible();await expect(panel.getByLabel("Secret access key",{exact:true})).toHaveCount(0);
 const password=panel.getByRole("button",{name:"Choose repository-password file",exact:true}),connect=panel.getByRole("button",{name:"Connect existing repository",exact:true}),upload=panel.getByRole("button",{name:"Upload latest verified backup",exact:true}),consent=panel.getByRole("checkbox");
 await expect(connect).toBeDisabled();await page.evaluate(()=>{(window as any).remoteMode="cancel";});await password.click();await expect(panel.getByText("Password selection cancelled. Saved settings are unchanged.")).toBeVisible();await expect(connect).toBeDisabled();
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await password.click();await expect(connect).toBeEnabled();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-connect").length)).toBe(0);
 await connect.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Repository connection confirmed",{exact:true})).toBeVisible();await expect(upload).toBeDisabled();await consent.focus();await page.keyboard.press("Space");await expect(upload).toBeEnabled();
 await page.evaluate(()=>{(window as any).remoteFail=true;});await refresh.click();await expect(upload).toBeDisabled();await expect(consent).not.toBeChecked();await page.evaluate(()=>{(window as any).remoteFail=false;});await refresh.click();await consent.check();
 for(const width of [390,820,1440])await inspect(page,info,"remote-ready",width);
 await page.evaluate(()=>{(window as any).remoteMode="hold";});await upload.click();await expect(panel.getByRole("button",{name:"Uploading and verifying…",exact:true})).toBeDisabled();await expect(password).toBeDisabled();
 await page.evaluate(()=>{const w=window as any;w.remoteMode="uncertain";w.remoteRelease();});await expect(panel.getByText("Upload needs review.",{exact:false})).toBeVisible();await expect(consent).not.toBeChecked();await expect(upload).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-upload"))).toEqual([{action:"remote-upload",ref:"remote-one",revision:2,jobId:"a".repeat(64)}]);
 await page.reload();await page.waitForLoadState("networkidle");await expect(panel.getByText("Recorded remote result for the latest backup:",{exact:false})).toContainText("needs review; no automatic retry");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-upload").length)).toBe(0);
 for(const width of [390,820,1440])await inspect(page,info,"remote-review",width);
 const reconcile=panel.getByRole("button",{name:"Check existing remote copy",exact:true});await expect(reconcile).toBeEnabled();await reconcile.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Existing remote copy verified. Nothing was uploaded again.")).toBeVisible();await expect(panel.getByText("Recorded remote result for the latest backup:",{exact:false})).toContainText("copy verified by readback");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-upload").length)).toBe(0);
 await page.evaluate(()=>{(window as any).remoteState.supported=false;});await refresh.click();await expect(password).toHaveCount(0);await expect(panel.getByText("A supported desktop build with its verified Restic tool is required.",{exact:false})).toBeVisible();expect(errors).toEqual([]);
});
test("remote destination form keyboard and narrow layout",async({page},info)=>{
 await setup(page,true);const panel=page.getByRole("region",{name:"Remote backup (optional)"});await panel.locator("summary").click();
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
 await setup(page,true);const panel=page.getByRole("region",{name:"Remote backup (optional)"});
 await page.evaluate(()=>{const w=window as any;delete w.state.lastVerified;w.remoteState={supported:true,pending:false,configured:true,state:"connected",revision:1,remoteRef:"remote-one",label:"Fixture recovery",passwordSelected:true};});await panel.getByRole("button",{name:"Refresh remote backup status",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-list"||c.action==="remote-download"||c.action==="manual").length)).toBe(0);
 const find=panel.getByRole("button",{name:"Find remote backups",exact:true});await expect(find).toBeEnabled();await find.focus();await page.keyboard.press("Enter");
 const select=panel.getByRole("combobox",{name:"Backup to recover",exact:true}),download=panel.getByRole("button",{name:"Download verified copy",exact:true});await expect(download).toBeDisabled();await select.selectOption("d".repeat(64));await expect(download).toBeEnabled();await expect(panel.getByText("Listed copies are not verified yet.",{exact:false})).toBeVisible();
 await page.evaluate(()=>{(window as any).remoteMode="cancel";});await download.click();await expect(panel.getByText("Download cancelled. Your current installation is unchanged.")).toBeVisible();await expect(panel.getByRole("button",{name:"Open Backup mode to restore",exact:true})).toHaveCount(0);
 await page.evaluate(()=>{(window as any).remoteMode="ok";});await download.focus();await page.keyboard.press("Enter");await expect(panel.getByText("Encrypted backup downloaded and verified. Nothing has been restored or restarted.")).toBeVisible();expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="manual").length)).toBe(0);
 for(const width of [390,820,1440]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(axe);const report=await page.evaluate(async()=>(window as any).axe.run(document));expect(report.violations).toEqual([]);writeFileSync(info.outputPath(`recovery-axe-${width}.json`),JSON.stringify(report));await panel.screenshot({path:info.outputPath(`recovery-${width}.png`)});}
 await panel.getByRole("button",{name:"Open Backup mode to restore",exact:true}).focus();await page.keyboard.press("Enter");expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="manual").length)).toBe(1);await expect(panel.getByText("Backup mode was not opened. The downloaded copy is still saved.")).toBeVisible();
 expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.action==="remote-download").every((c:any)=>c.ref==="remote-one"&&c.revision===1&&c.snapshotId==="d".repeat(64)))).toBe(true);
});
test("automatic remote uploads require explicit consent and preserve review pause",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await setup(page,true);
 const panel=page.getByRole("region",{name:"Remote backup (optional)"}),refresh=panel.getByRole("button",{name:"Refresh remote backup status",exact:true});
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
