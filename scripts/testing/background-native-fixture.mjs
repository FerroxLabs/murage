import { app,BrowserWindow,Tray,Menu,nativeImage,ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createBackgroundLifecycle } from "../../electron/background-lifecycle.mjs";

app.setPath("userData",process.env.MURAGE_BACKGROUND_USER_DATA);app.setPath("sessionData",process.env.MURAGE_BACKGROUND_USER_DATA);app.setName("Murage background verification");
app.on("window-all-closed",()=>{}); // The fixture writes its receipt before its own final quit.
let win,lifecycle,tray,menu,login=false,loginWrites=0,inbox=0,explained=0,quitRequested=false;
const diagnostics={runId:process.env.MURAGE_BACKGROUND_RUN_ID,platform:process.platform,electron:process.versions.electron,stage:"initializing",probes:[],errors:[]};
const saveDiagnostics=()=>writeFileSync(process.env.MURAGE_BACKGROUND_DIAGNOSTICS,JSON.stringify(diagnostics,null,2));
const until=async check=>{for(let n=0;n<100;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error("Native fixture condition timed out");};
void app.whenReady().then(async()=>{
try{
  const root=fileURLToPath(new URL("../../",import.meta.url));
  ipcMain.on("desktop:surface-secret",event=>{event.returnValue="isolated-fixture";});
  win=new BrowserWindow({width:900,height:760,show:true,webPreferences:{contextIsolation:true,preload:join(root,"electron/preload.cjs")}});
  lifecycle=createBackgroundLifecycle({platform:process.platform,window:()=>win,loadPreferences:()=>({}),savePreferences:()=>{},
    login:{read:()=>({supported:true,openAtLogin:login}),write:value=>{login=value;loginWrites++;}},
    createTray:open=>{const image=nativeImage.createFromPath(join(root,"electron/resources/app-icon.png"));const resized=image.resize({width:18,height:18});diagnostics.image={empty:image.isEmpty(),size:image.getSize(),trayEmpty:resized.isEmpty(),traySize:resized.getSize()};tray=new Tray(resized);tray.on("click",open);return tray;},
    setTrayMenu:(_tray,items)=>{menu=items;tray.setContextMenu(Menu.buildFromTemplate(items));},probeTray:()=>{try{const rect=tray.getBounds();diagnostics.probes.push({at:Date.now(),destroyed:tray.isDestroyed(),bounds:rect});return rect.width>0&&rect.height>0;}catch(error){diagnostics.probes.push({at:Date.now(),error:String(error)});throw error;}},
    openWindow:()=>{win.show();win.focus();},openInbox:()=>{inbox++;},explainClose:async()=>{explained++;return "keep";},quit:()=>{quitRequested=true;},
    automationStatus:async()=>({paused:false}),setAutomationsPaused:async paused=>({paused}),
    onChange:state=>{if(!win.isDestroyed())win.webContents.send("startup-background:changed",state);},onError:error=>{diagnostics.errors.push(String(error));throw error;},
  });
  win.on("close",event=>lifecycle.handleClose(event));
  ipcMain.handle("startup-background:status",event=>{assert.equal(event.sender,win.webContents);return lifecycle.status();});
  ipcMain.handle("startup-background:update",(event,patch)=>{assert.equal(event.sender,win.webContents);return lifecycle.update(patch);});
  diagnostics.stage="tray-readiness";
  await lifecycle.start();await until(async()=>{await lifecycle.refresh();return lifecycle.status().trayAvailable;});assert.equal(lifecycle.status().trayAvailable,true);
  diagnostics.stage="native-controls";saveDiagnostics();
  await win.loadURL(process.env.MURAGE_BACKGROUND_URL);await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Start when I sign in"]')`));
  assert.equal(loginWrites,0);
  await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Start when I sign in"]').click()`);await until(()=>loginWrites===1);assert.equal(login,true);
  await until(()=>win.webContents.executeJavaScript(`document.querySelector('[aria-label="Start when I sign in"]').getAttribute('aria-checked')==='true'`));
  writeFileSync(process.env.MURAGE_BACKGROUND_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
  diagnostics.stage="native-close-reopen-quit";
  win.close();await lifecycle.settledClose();assert.equal(win.isDestroyed(),false);assert.equal(win.isVisible(),false);assert.equal(explained,1);
  menu.find(item=>item.label==="Inbox").click();assert.equal(win.isVisible(),true);assert.equal(inbox,1);
  win.close();await lifecycle.settledClose();assert.equal(explained,1);
  menu.find(item=>item.label==="Quit Murage").click();assert.equal(quitRequested,true);win.close();await until(()=>win.isDestroyed());
  writeFileSync(process.env.MURAGE_BACKGROUND_OUTPUT,JSON.stringify({runId:process.env.MURAGE_BACKGROUND_RUN_ID,platform:process.platform,electron:process.versions.electron,nativeTray:true,nativeCloseHideReopen:true,inboxAction:true,firstExplanationOnce:true,quitBypassesHide:true,realPreloadStartupControl:true,loginWritesWereMocked:true},null,2));
  diagnostics.stage="complete";
}catch(error){diagnostics.errors.push(String(error));console.error(error);process.exitCode=1;}
finally{diagnostics.status=lifecycle?.status();saveDiagnostics();lifecycle?.dispose();if(win&&!win.isDestroyed())win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
