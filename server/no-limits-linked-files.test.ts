// SPDX-License-Identifier: AGPL-3.0-or-later
// Real temporary files; hooks change a linked source during the production read.
import {afterEach,expect,it,vi} from 'vitest';
const hooks=vi.hoisted(()=>{vi.resetModules();return {inode:undefined as number|undefined,afterRead:undefined as undefined|(()=>void)};});
vi.mock('node:fs',async importOriginal=>{
 const fs=await importOriginal<typeof import('node:fs')>();
 const finish=(fd:number)=>{if(hooks.inode===undefined||fs.fstatSync(fd).ino!==hooks.inode)return;const hook=hooks.afterRead;hooks.afterRead=undefined;hook?.();};
 return {...fs,readSync:(...args:any[])=>{const n=(fs.readSync as (...args:any[])=>number)(...args);finish(args[0]);return n;},
  readFileSync:(...args:any[])=>{const data=(fs.readFileSync as (...args:any[])=>any)(...args);if(typeof args[0]==='number')finish(args[0]);return data;}};
});
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,linkSync,unlinkSync,existsSync,lstatSync,utimesSync,lutimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './decision/fixture.ts';
import {initializeArtifacts,registerArtifact} from './artifacts.ts';
import {listSite} from './publish/site-files.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
let root='';
afterEach(()=>{hooks.afterRead=undefined;hooks.inode=undefined;if(root)removeTempDirSync(root);root='';});
function files(){root=mkdtempSync(join(tmpdir(),'nl-linked-integrity-'));const site=join(root,'site');mkdirSync(site);writeFileSync(join(site,'index.html'),'fixture');writeFileSync(join(site,'source.txt'),'first');writeFileSync(join(site,'other.txt'),'other');return site;}
it.each(['publish','artifact'] as const)('H2 %s keeps out-of-folder symlinks outside its authorized scope',kind=>{
 const f=fixture(),site=files();writeFileSync(join(root,'outside.txt'),'outside');symlinkSync(join(root,'outside.txt'),join(site,'alias.txt'));
 if(kind==='publish')expect(()=>listSite(site,undefined,true)).toThrow('outside');
 else{initializeArtifacts(f.db);expect(()=>registerArtifact(f.db,join(root,'saved'),{botId:'b',threadId:'t',relativePath:'alias.txt'},{owner:true,scopes:[{botId:'b',botName:'Fixture',threadId:'t',runId:'g',workspaceRoot:site}]})).toThrow('Linked files');}
});
it.each(['symlink','hardlink'].flatMap(link=>['publish','artifact'].map(kind=>({link,kind}))))('H2 $kind refuses a $link changed during its verified read',({link,kind})=>{
 const f=fixture(),site=files(),alias=join(site,'alias.txt');
 (link==='symlink'?symlinkSync:linkSync)(join(site,'source.txt'),alias);
 hooks.inode=lstatSync(join(site,'source.txt')).ino;
 hooks.afterRead=()=>{if(link==='symlink'){unlinkSync(alias);symlinkSync(join(site,'other.txt'),alias);lutimesSync(alias,100,100);}else{writeFileSync(join(site,'source.txt'),'later');utimesSync(join(site,'source.txt'),100,100);}};
 if(kind==='publish')expect(()=>listSite(site,undefined,true)).toThrow('changed');
 else{
  initializeArtifacts(f.db);
  expect(()=>registerArtifact(f.db,join(root,'saved'),{botId:'b',threadId:'t',relativePath:'alias.txt'},{owner:true,scopes:[{botId:'b',botName:'Fixture',threadId:'t',runId:'g',workspaceRoot:site}]})).toThrow('changed');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()?.n).toBe(0);expect(existsSync(join(root,'saved'))).toBe(false);
 }
 expect(hooks.afterRead,'the hook must run on the verified source handle').toBeUndefined();
});

it.each(['symlink','hardlink'] as const)('H2 a verified %s site entry keeps its own frozen bytes at No limits',link=>{
 const site=files();(link==='symlink'?symlinkSync:linkSync)(join(site,'source.txt'),join(site,'alias.txt'));
 const listing=listSite(site,undefined,true);const alias=listing.files.find(file=>file.rel==='alias.txt')!;
 expect(alias.data.toString()).toBe('first');expect(alias.size).toBe(5);
 writeFileSync(join(site,'source.txt'),'later');expect(alias.data.toString()).toBe('first');
});
