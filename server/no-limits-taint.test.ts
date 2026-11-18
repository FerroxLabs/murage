// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirSync } from './testing/cleanup.ts';
import { inspectNoLimits } from './no-limits-taint.ts';
import { symlinkCorpus, ordinaryBoundaries } from './testing/no-limits-symlink-corpus.ts';
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

it.each(symlinkCorpus.filter(row=>row.selected&&row.id!=='B01-dir'&&!/^(?:W12|E32|C33|S08|B09)/.test(row.id)))('$id selected consumer retains taint and complete causes',row=>{
 const cwd=fixture(row.setup,false);
 const inspection=inspectNoLimits({kind:'exec',text:row.command.replaceAll('$FX',cwd),cwd,cwdInvalid:false,dialect:'sh'});
 const selected=inspection.decisions.filter(d=>d.reason==='alias-taint'&&(row.id==='A04'||d.op==='write')&&(d.lexical.endsWith('/'+row.selected)||row.id==='A04'&&d.lexical.includes('/dst/')));
 expect(selected,JSON.stringify(inspection)).not.toEqual([]);
 for(const cause of row.cause?.split(',')??[])expect(selected.some(d=>d.taintCauses?.includes(cause as any))).toBe(true);
 expect(selected.every(d=>d.taintTriggers?.length)).toBe(true);
 const ordinary=fixture(row.setup,true);
 expect(inspectNoLimits({kind:'exec',text:row.twin.replaceAll('$FX',ordinary),cwd:ordinary,cwdInvalid:false,dialect:'sh'}).decisions).toEqual([]);
});
it.each(ordinaryBoundaries)('%s remains RUN without an invented producer',(_id,text)=>{
 const cwd=fixture(undefined,true);
 expect(inspectNoLimits({kind:'exec',text,cwd,cwdInvalid:false,dialect:'sh'}).decisions).toEqual([]);
});
it('native batches share taint and preserve protected source evidence',()=>{
 const cwd=fixture(undefined,false);
 const inspection=inspectNoLimits({kind:'native',cwd,cwdInvalid:false,effects:[{op:'link',path:'./new',targetValue:'/etc/hosts',linkKind:'symbolic',followFinal:false},{op:'write',path:'./new',followFinal:true}]});
 expect(inspection.decisions).toContainEqual(expect.objectContaining({reason:'alias-taint',op:'write',lexical:cwd+'/new',taintTriggers:expect.any(Array)}));
});

it('B01 explicit backup tree selected consumer is independently held',()=>{
 const cwd=fixture('backup',false);
 const text=`rsync -ab --backup-dir=${cwd}/backup/deep ./source/ ./work/deep/; tee ./backup/deep/h`;
 const result=inspectNoLimits({kind:'exec',text,cwd,cwdInvalid:false,dialect:'sh'});
 expect(result.decisions,JSON.stringify(result.operations)).toContainEqual(expect.objectContaining({reason:'alias-taint',op:'write',lexical:cwd+'/backup/deep/h'}));
 const ordinary=fixture('backup',true);
 expect(inspectNoLimits({kind:'exec',text:text.replaceAll(cwd,ordinary),cwd:ordinary,cwdInvalid:false,dialect:'sh'}).decisions).toEqual([]);
});
