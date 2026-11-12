// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoVerdict } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { describe, protectedEvidence, wipeEvidence } from './decision/action.ts';
import { hash } from './decision/bounds.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { ordinaryBoundaries, symlinkCorpus } from './testing/no-limits-symlink-corpus.ts';

const capture = process.env.NLSYM_CAPTURE_BASE === '1';
const snapshotPath = 'server/testing/fixtures/no-limits-symlink-full-base.json';
const baselinePath = 'evidence/nlsym/C0-owner-base.json';
const snapshots: Record<string,unknown> = capture ? {} : JSON.parse(readFileSync(snapshotPath,'utf8')).rows;
const baseline: Record<string,unknown> = {};
const roots: string[] = [];
afterEach(()=>{ for(const root of roots.splice(0)) removeTempDirSync(root); });
afterAll(()=>{ if(capture){
  writeFileSync(snapshotPath,JSON.stringify({commit:'be6823cf1d12e4ce561d8e17cb6fe242315491ad',rows:snapshots},null,2)+'\n');
  mkdirSync('evidence/nlsym',{recursive:true});
  writeFileSync(baselinePath,JSON.stringify({commit:'be6823cf1d12e4ce561d8e17cb6fe242315491ad',rows:baseline},null,2)+'\n');
} });
const bot = {id:'nlsym-fixture',autoApprove:true,fullAccess:true,noLimits:true};
const owner = {fullAccessOrigin:'owner' as const,ownerStarted:true,outsideRead:null};

function fixture(setup: string | undefined, safe: boolean) {
  const root=mkdtempSync(join(tmpdir(),'murage-nlsym-')); roots.push(root);
  for(const dir of ['data','one','two','sub','src','source','work/deep','backup/deep','dst/src','d/src','out']) mkdirSync(join(root,dir),{recursive:true});
  for(const file of ['plain','blob','hosts','h','two/src','one/h','source/h','src/blob']) writeFileSync(join(root,file),'fixture');
  const link=(name:string,target='/etc/hosts')=>{
    // Fixtures never mutate or execute a protected path; only their own names.
    const path=join(root,name);removeTempDirSync(path);
    symlinkSync(safe?join(root,'plain'):target,path);
  };
  if(setup==='h')link('h');
  if(setup==='dangling')link('h','/etc/murage-fixture-absent');
  if(setup==='tree') {mkdirSync(join(root,'a'));mkdirSync(join(root,'other'));link('a/h');writeFileSync(join(root,'other/h'),'ordinary');}
  if(setup==='copy'){link('src/f');link('dst/src/f');}
  if(setup==='backup')link('work/deep/h');
  if(setup==='child')link('d/blob');
  if(setup==='children'){writeFileSync(join(root,'d/blob'),'ordinary');link('d/plain');}
  if(setup==='rsync'){link('d/blob');link('d/src/blob');}
  if(setup==='cwd'){
    mkdirSync(join(root,'safe/deep'),{recursive:true});
    symlinkSync(safe?join(root,'safe/deep'):'/etc/ssl',join(root,'e'));
  }
  if(setup==='chain')for(let i=0;i<45;i++)symlinkSync(i===44?join(root,'plain'):`h${i+1}`,join(root,`h${i}`));
  return root;
}
function normalize(value:unknown,root:string):unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(root,'$FX').replaceAll(homedir(),'$HOME'));
}

it.each(symlinkCorpus.flatMap(row=>[false,true].map(safe=>({...row,safe,label:safe?'RUN':'HOLD'}))))('$id $label inspection',row=>{
    const safe=row.safe;
    const root=fixture(row.setup,safe),command=(safe?row.twin:row.command).replaceAll('$FX',root);
    const context={...owner,commandCwd:root,commandText:command};
    const tool=row.tool==='pwsh'?'powershell':row.tool==='cmd'?'shell':'Bash';
    const hit=noLimitsProtectedWrite(command,context,row.tool==='pwsh'?'pwsh':undefined);
    const verdict=autoVerdict(bot,tool,command,context);
    const id=`${row.id}-${safe?'RUN':'HOLD'}`;
    // Stable action input makes hashes comparable without replacing their bytes.
    // The verdict above still inspects the actual fresh on-disk fixture.
    const action=describe({tool,input:{command:command.replaceAll(root,'/tmp/murage-nlsym-snapshot'),cwd:'/tmp/murage-nlsym-snapshot'}});
    const fullVerdict=autoVerdict({...bot,noLimits:false},tool,command,context);
    // Hash AFTER replacing ephemeral fixture identities, with no evidence fields dropped.
    const full=normalize({action,protected:protectedEvidence(action),wipe:wipeEvidence(action),denySourceInputs:action.targets,verdict:fullVerdict},root);
    const bytes=JSON.stringify(full);
    const snapshot={bytes,actionHash:hash(full)};
    if(capture){snapshots[id]=snapshot;baseline[id]=normalize({hit,verdict},root);}
    else {
      expect(snapshot,`${id} Full access bytes`).toEqual(snapshots[id]);
      if(process.env.NLSYM_FULL_ONLY!=='1'){
        if(safe)expect(verdict.approve,`${id}: ${JSON.stringify(verdict)}`).toBeTruthy();
        else expect(verdict.approve,`${id}: Sean 2026-11-12 02:05Z, protected writes run`).toBeTruthy();
      }
    }
});

it.each(ordinaryBoundaries)('%s ordinary boundary stays RUN',(id,command)=>{
  const root=fixture(undefined,true),context={...owner,commandCwd:root,commandText:command};
  const verdict=autoVerdict(bot,'Bash',command,context);
  if(capture)baseline[id]=normalize({verdict},root);
  else expect(verdict.approve,JSON.stringify(verdict)).toBeTruthy();
});

// Additional owner wipe controls use fresh links and leave the frozen Full access
// corpus and its base hashes intact. No command is executed by these tests.
for(const target of ['/',homedir(),'/etc'])it.each([false,true])(`C3 recursive deletion through a link to ${target}, ordinary=%s`,ordinary=>{
 const root=fixture(undefined,true),destination=ordinary?join(root,'data'):target;
 symlinkSync(destination,join(root,'wipe-link'));
 const command='rm -rf ./wipe-link/*',context={...owner,commandCwd:root,commandText:command};
 const verdict=autoVerdict(bot,'Bash',command,context);
 expect(verdict.approve===null).toBe(!ordinary);
 if(!ordinary){expect(verdict.source).toBe('always-ask');expect(verdict.rule).toMatch(/^delete-(?:root|home|system-folder)$/);}
 const unlink='rm -f ./wipe-link';
 expect(autoVerdict(bot,'Bash',unlink,{...context,commandText:unlink}).approve).toBeTruthy();
});
it.each([['home',homedir(),'delete-home'],['root','/','delete-root'],['system','/etc','delete-system-folder']] as const)('R6 wipe-reader follows a traversed %s link but never confuses an ordinary linked write with a wipe',(_name,target,rule)=>{
 const root=mkdtempSync(join(tmpdir(),'nolim-wipe-link-'));roots.push(root);
 const link=join(root,'target');symlinkSync(target,link,'junction');
 const command=`rm -rf '${link}/'`;
 const held=autoVerdict(bot,'Bash',command,{...owner,commandText:command,commandCwd:root});
 expect(held).toMatchObject({approve:null,source:'always-ask',rule});
 expect(autoVerdict(bot,'Bash',`touch '${link}/fixture'`,{...owner,commandText:`touch '${link}/fixture'`,commandCwd:root})).toMatchObject({approve:expect.any(String),source:'no-limits'});
 // Removing the link itself does not traverse its final component.
 expect(autoVerdict(bot,'Bash',`rm -rf '${link}'`,{...owner,commandText:`rm -rf '${link}'`,commandCwd:root})).toMatchObject({approve:expect.any(String),source:'no-limits'});
});
