// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirSync } from './testing/cleanup.ts';
import { symlinkCorpus } from './testing/no-limits-symlink-corpus.ts';
import * as actions from './decision/action.ts';
import { autoVerdict } from './auto-approve.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
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


const bot={id:'nlsym',autoApprove:true,fullAccess:true,noLimits:true};
const owner={fullAccessOrigin:'owner' as const,ownerStarted:true,outsideRead:null};
const describeOwner=(actions as any).describeOwnerNoLimits??actions.describe;
it.each(symlinkCorpus)('$id compatibility and S1 retain structured owner decisions',row=>{
 const cwd=fixture(row.setup,false),text=row.command.replaceAll('$FX',cwd);
 const tool=row.tool==='pwsh'?'powershell':row.tool==='cmd'?'shell':'Bash';
 const action=describeOwner({tool,input:{command:text,cwd}});
 expect(action.ownerAuthority?.decisions.some((d:any)=>d.protectedDecision),JSON.stringify(action)).toBe(true);
 expect(autoVerdict(bot,tool,text,{...owner,commandCwd:cwd,commandText:text}).approve).toBeTruthy();
 const ordinary=fixture(row.setup,true),twin=row.twin.replaceAll('$FX',ordinary);
 expect(autoVerdict(bot,tool,twin,{...owner,commandCwd:ordinary,commandText:twin}).approve).toBeTruthy();
 expect(describeOwner({tool,input:{command:twin,cwd:ordinary}}).ownerAuthority?.decisions).toEqual([]);
});
it('C33 physical and logical twins use the same protected disk fixture',()=>{
 const cwd=fixture('cwd',false);
 const check=(mode:string)=>{
  const text=`cd -${mode} e && cd .. && printf x > hosts`;
  return {action:describeOwner({tool:'Bash',input:{command:text,cwd}}),verdict:autoVerdict(bot,'Bash',text,{...owner,commandCwd:cwd,commandText:text})};
 };
 expect(check('P').verdict.approve).toBeTruthy();
 expect(check('P').action.ownerAuthority?.decisions.some((d:any)=>d.protectedDecision?.physical==='/etc/hosts')).toBe(true);
 expect(check('L').verdict.approve).toBeTruthy();
 expect(check('L').action.ownerAuthority?.decisions).toEqual([]);
});

it('H12 native compatibility and S1 retain exact named inode evidence, ordinary unlink RUN',()=>{
 const cwd=fixture(undefined,true),named=join(homedir(),'.zshrc'),created=!existsSync(named);
 if(created)writeFileSync(named,'isolated named inode fixture');
 try{
  const alias=join(cwd,'ordinary-alias');linkSync(named,alias);
  const action=describeOwner({tool:'write_file',input:{path:alias,cwd}});
  expect(action.ownerAuthority?.decisions.some((d:any)=>d.protectedDecision?.reason==='protected-inode'&&d.protectedDecision.namedProtectedPath===named)).toBe(true);
  const context={...owner,commandCwd:cwd,call:{toolCall:{name:'write_file',input:{path:alias}}},realPaths:[alias]};
  expect(autoVerdict(bot,'write_file','fixture native write',context).approve).toBeTruthy();
  expect(describeOwner({tool:'delete_file',input:{path:alias,cwd}}).ownerAuthority?.decisions).toEqual([]);
 }finally{if(created)removeTempDirSync(named);}
});
it.each([
 ['python',"import os; os.truncate('./h',0)","import os; os.truncate('./plain',0)"],
 ['node',"require('child_process').execSync('tee ./h')","require('child_process').execSync('tee ./plain')"],
])('code API %s keeps language and refreshes exposed filesystem effects',(tool,code,twin)=>{
 const cwd=fixture('h',false);
 const action=describeOwner({tool,input:{code,cwd}});
 expect(action.ownerAuthority?.decisions.some((d:any)=>d.protectedDecision?.physical==='/etc/hosts')).toBe(true);
 expect(autoVerdict(bot,tool,'fixture code',{...owner,commandCwd:cwd,call:{toolCall:{name:tool,input:{code,cwd}}}}).approve).toBeTruthy();
 expect(describeOwner({tool,input:{code:twin,cwd}}).ownerAuthority?.decisions).toEqual([]);
});
