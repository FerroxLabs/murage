// SPDX-License-Identifier: AGPL-3.0-or-later
import { vi,beforeEach } from 'vitest';
export { expect,it,beforeEach,afterEach,vi } from 'vitest';
const counter=vi.hoisted(()=>({calls:0}));
vi.mock('node:fs',async importOriginal=>{
 const fs=await importOriginal<typeof import('node:fs')>();
 const real=fs.realpathSync,native=real.native;
 const count=(p:any,...args:any[])=>{counter.calls++;return (real as any)(p,...args);};
 count.native=(p:any,...args:any[])=>{counter.calls++;return (native as any)(p,...args);};
 return {...fs,realpathSync:count};
});
// setup.ts loads server dependencies first. Re-import them under this filesystem spy.
vi.resetModules();
const {wipeBreaker,nativeWipeBreaker,nativeEffectsWipe}=await import('../../wipe-breaker.ts');
const {relayClaudeBash}=await import('../../drivers/claude-bash-hook.ts');
export const {captureWipeInput}=await import('../../decision/wipe-input.ts');
const {inspectReleaseWipes}=await import('../../decision/release-guard.ts');
export const {decideFixture,releaseFixture,fixture,d,baseRun}=await import('./fixture-support.ts');
const {productionTurnCounters}=await import('./production-support.ts');
const {registeredWipeProjects}=await import('../registry.ts');
const {installWipeRootWiring}=await import('../root-wiring.ts');
const {installWipeContextReader}=await import('../context.ts');
export const shell=wipeBreaker,native=nativeWipeBreaker,effects=nativeEffectsWipe;
export const registerRoots=(paths:string[])=>registeredWipeProjects.replace('acceptance',paths);
export const productionCounters=(count:number)=>productionTurnCounters(installWipeRootWiring,registeredWipeProjects,count,()=>{counter.calls=0;},()=>counter.calls);
export const realpathCounter=()=>{const value=counter.calls;counter.calls=0;return value;};
export async function recovery(input:any,ctx:any={}){const out:any=await relayClaudeBash('/tmp/absent-wipe-acceptance.sock',input,new AbortController().signal,ctx);return out.hookSpecificOutput.permissionDecision;}
export const defaultContext={platform:'linux' as const,home:'/home/u',env:{HOME:'/home/u',UNSET:undefined},dataDir:'/home/u/.murage',cwd:'/work/project',project:'/work/project',mountInventory:{contains:(p:string)=>p==='/Volumes/Backup'},pathPort:{realpath(p:string){counter.calls++;return p;},isBlockDevice(p:string){return ['/dev/sda','/dev/sdb1','/dev/nvme0n1'].includes(p)?true:null;}}};
export const windowsContext={...defaultContext,platform:'win32' as const,home:'C:\\Users\\u',env:{HOME:'C:\\Users\\u',USERPROFILE:'C:\\Users\\u',HOMEDRIVE:'C:',HOMEPATH:'\\Users\\u'},cwd:'C:\\Users\\u\\proj',project:'C:\\Users\\u\\proj'};
export function releaseContextProbe(context:any){const undo=installWipeContextReader(()=>context);try{return inspectReleaseWipes({kind:'native',cwdInvalid:false,effects:[{op:'delete',path:context.dataDir,followFinal:false}]});}finally{undo();}}
beforeEach(()=>{registeredWipeProjects.clear();registerRoots(['/work/project','/work/other']);counter.calls=0;});
