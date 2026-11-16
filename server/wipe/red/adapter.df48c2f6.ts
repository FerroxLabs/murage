// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck -- copied only onto its named historical API.
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
const {wipeBreaker,nativeWipeBreaker}=await import('../../wipe-breaker.ts');
const {relayClaudeBash}=await import('../../drivers/claude-bash-hook.ts');
export const {captureWipeInput}=await import('../../decision/wipe-input.ts');
const {inspectReleaseWipes}=await import('../../decision/release-guard.ts');
export const {decideFixture,releaseFixture,fixture,d,baseRun}=await import('./fixture-support.ts');
let roots:string[]=[];
export const shell=(text:string,ctx:any={})=>wipeBreaker(text,{...ctx,projects:roots});
export const native=(tool:string,input:unknown,ctx:any={})=>nativeWipeBreaker(tool,input,{...ctx,projects:roots});
export const effects=(items:any[],ctx:any={})=>native(items[0]?.op==='rename'?'move_file':'delete_directory',items[0],ctx);
export const registerRoots=(paths:string[])=>{roots=paths;};
export const productionCounters=async(_count:number)=>({unavailable:'production-wiring-not-extracted-before-C1'});
export const realpathCounter=()=>{const value=counter.calls;counter.calls=0;return value;};
export async function recovery(input:any,ctx:any={}){const out:any=await relayClaudeBash('/tmp/absent-wipe-acceptance.sock',input,new AbortController().signal,ctx);return out.hookSpecificOutput.permissionDecision;}
export const defaultContext={platform:'linux' as const,home:'/home/u',env:{HOME:'/home/u',UNSET:undefined},dataDir:'/home/u/.murage',cwd:'/work/project',project:'/work/project',pathPort:{realpath(p:string){counter.calls++;return p;},isBlockDevice(p:string){return ['/dev/sda','/dev/sdb1','/dev/nvme0n1'].includes(p)?true:null;}}};
export const windowsContext={...defaultContext,platform:'win32' as const,home:'C:\\Users\\u',env:{HOME:'C:\\Users\\u',USERPROFILE:'C:\\Users\\u',HOMEDRIVE:'C:',HOMEPATH:'\\Users\\u'},cwd:'C:\\Users\\u\\proj',project:'C:\\Users\\u\\proj'};
// Explicit n/a cells: this export does not exist on these pinned APIs.
export const releaseContextProbe=(context:any)=>typeof inspectReleaseWipes==='function'?inspectReleaseWipes({kind:'native',cwdInvalid:false,effects:[{op:'delete',path:context.dataDir,followFinal:false}]}):[];
beforeEach(()=>{registerRoots(['/work/project','/work/other']);counter.calls=0;});
