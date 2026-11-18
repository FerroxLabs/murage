// Opt-in per-test native evidence for the Windows park qualification run.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { beforeEach, afterEach, expect } from 'vitest';
import { windowsSecuritySessionDebug } from '../channels/signal/windows-security-session.ts';
const parkFile=/[\\/]channels[\\/]signal[\\/]park[^\\/]*[.]test[.]ts$/;
if(process.env.SIGNAL_SPAWN_TRACE==='1'&&parkFile.test(expect.getState().testPath??'')){
 const childProcess=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
 let counts={children:0,powershell:0,icacls:0,whoami:0},restore:(()=>void)|undefined;
 let sessionBefore=windowsSecuritySessionDebug();
 beforeEach(()=>{
  sessionBefore=windowsSecuritySessionDebug();
  counts={children:0,powershell:0,icacls:0,whoami:0};const original=childProcess.execFileSync;
  childProcess.execFileSync=((file:string,...args:unknown[])=>{
   counts.children++;if(/powershell[.]exe$/i.test(file))counts.powershell++;
   if(/icacls[.]exe$/i.test(file))counts.icacls++;if(/whoami[.]exe$/i.test(file))counts.whoami++;
   return Reflect.apply(original,childProcess,[file,...args]);
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();restore=()=>{childProcess.execFileSync=original;syncBuiltinESMExports();};
 });
 afterEach(()=>{
  restore?.();restore=undefined;const after=windowsSecuritySessionDebug(),resident=after.spawns-sessionBefore.spawns;
  console.log('SIGNAL_PARK_NATIVE_SPAWNS',JSON.stringify({test:expect.getState().currentTestName,platform:process.platform,...counts,
   children:counts.children+resident,powershell:counts.powershell+resident,securityRequests:after.requests-sessionBefore.requests}));
 });
}
