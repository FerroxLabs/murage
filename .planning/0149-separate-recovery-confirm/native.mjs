import { app,BrowserWindow,dialog,ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { openInstallationRecoveryWindow } from '../../electron/installation-recovery-window.mjs';
const output=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(output,'../..');
app.setPath('userData',process.env.MURAGE_RECOVERY_FIXTURE_DATA);app.setPath('sessionData',process.env.MURAGE_RECOVERY_FIXTURE_DATA);app.setName('Murage recovery verification');
let win;const events=[];const save=stage=>writeFileSync(path.join(output,'native-state.json'),JSON.stringify({stage,pid:process.pid,events},null,2));
const timer=setTimeout(()=>{save('TIMEOUT');app.exit(1);},120000);
void app.whenReady().then(async()=>{try{
  const opened=openInstallationRecoveryWindow({BrowserWindow,ipcMain,dialog:{...dialog,showOpenDialog:async()=>({canceled:false,filePaths:['/isolated-fixture/backup.zip']})},baseDir:path.join(root,'electron'),
    context:{skin:'light',reason:'Isolated recovery verification. No customer files.',dataDirectory:'/isolated-fixture/foreign-original'},isAvailable:()=>false,canRestoreSeparate:()=>true,
    planSeparate:()=>({dataDirectory:'/isolated-fixture/new-installation/data'}),run:async()=>({ok:true,operation:'plan-restore',sha256:'a'.repeat(64),snapshotId:'00000000-0000-4000-8000-000000000001',activationAvailable:false}),
    runSeparate:async(parameters,plan)=>{events.push({parameters,plan});return {ok:true,operation:'restore',status:'restored-review-required'};},retry:async()=>events.push('retry'),openDiagnostics:async()=>{},onClosed:()=>{}});
  win=opened.window;await opened.loaded;
  const selection=await win.webContents.executeJavaScript("window.murageRecovery.action('choose-separate-backup')");
  const script=`window.murageRecovery.action('restore-separate',${JSON.stringify(selection.selection.id)})`;
  save('CANCEL_NATIVE_DIALOG');await win.webContents.executeJavaScript(script);
  assert.equal(events.length,0);save('APPROVE_NATIVE_DIALOG');await win.webContents.executeJavaScript(script);
  assert.deepEqual(events,[{parameters:{archive:'/isolated-fixture/backup.zip',sha256:'a'.repeat(64)},plan:{dataDirectory:'/isolated-fixture/new-installation/data'}},'retry']);
  save('PASS');
}catch(error){events.push({error:String(error)});save('FAIL');process.exitCode=1;}finally{clearTimeout(timer);if(win&&!win.isDestroyed())win.destroy();app.quit();}});
