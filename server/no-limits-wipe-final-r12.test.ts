// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert commands only: classifier and isolated decision fixtures never execute SQL.
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {rawDynamicExecution,fullExecutionScan} from '../shared/no-limits-raw-wipe.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
import {removeTempDir} from './testing/cleanup.ts';
for(const [id,command] of [
 ['H1',String.raw`echo x\ #; eval "$OPAQUE"`],
 ['H2',"cat <<'EOF'\ntext\\\nEOF\neval \"$OPAQUE\"\nEOF"],
 ['H5','echo * | psql'],
] as const)it(`R12 ${id} review repro CARD`,()=>{
 expect(fullExecutionScan(command),'never-discard scan').toBe(true);
 expect(rawDynamicExecution(command),'shared').toBe(true);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe(command,'/home/fixture',0,'posix','/w'),'Pi').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'}),'server').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const f=fixture();try{expect(d.decide(f.open('r12',{command,cwd:'/w'}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
async function withFiles(check:(cwd:string,files:Set<string>)=>void){
 const root=mkdtempSync(join(tmpdir(),'wipe-r12-')),cwd=join(root,'w');
 try{
  mkdirSync(cwd);mkdirSync(join(root,'other/deep'),{recursive:true});
  symlinkSync(join(root,'other/deep'),join(cwd,'sub'));
  writeFileSync(join(cwd,'input.sql'),'SELECT 1');writeFileSync(join(cwd,'payload.sql'),'DROP TABLE t;');
  writeFileSync(join(root,'other/input.sql'),'DROP TABLE t;');
  check(cwd,new Set([join(cwd,'input.sql')]));
 }finally{await removeTempDir(root);}
}
for(const [id,command] of [
 ['H3','uniq payload.sql input.sql; psql < input.sql'],
 ['H4','psql < sub/../input.sql'],
] as const)it(`R12 ${id} review repro CARD`,()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd,writtenScripts:files}),'server').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const f=fixture();try{expect(d.decide(f.open('r12',{command,cwd}),baseRun).kind).toBe('run');}finally{f.dispose();}
}));
for(const command of [
 "echo ? | psql","echo [a] | psql","echo {a,b} | psql","echo ~ | psql",
 'echo "$SQL" | psql','printf %s `payload` | psql',
 "echo 'SELECT 1' | uniq | psql",
])it(`R12 expansion or unknown database producer CARD ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'})).toBeNull();
});
for(const command of [
 "echo 'SELECT 1' | psql","printf '%s' 'SELECT 1' | psql",
 "psql <<'EOF'\nSELECT 1\nEOF","cat <<'EOF'\nordinary text\nEOF",
 'cat plain.txt','echo plain','cat <<EOF\nordinary text\nEOF',
])it(`R12 common subset RUN ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(false);
 expect(noLimitsWipe(command,{cwd:'/w'})).toBeNull();
});
for(const command of [
 'psql < input.sql','cat input.sql | psql','psql -f input.sql',
 'head input.sql; psql < input.sql','tail input.sql; psql < input.sql',
 'wc input.sql; psql < input.sql','sort input.sql; psql < input.sql',
 "grep SELECT input.sql; psql < input.sql","cut -c 1 input.sql; psql < input.sql",
 "tr a b < input.sql; psql < input.sql",'true; psql < input.sql',
 'test -f input.sql; psql < input.sql',
])it(`R12 authenticated file subset RUN ${command}`,()=>withFiles((cwd,files)=>{
 expect(noLimitsWipe(command,{cwd,writtenScripts:files})).toBeNull();
}));
for(const command of [
 'uniq payload.sql input.sql; psql < input.sql',
 'psql < input.sql; uniq payload.sql input.sql',
 'sort -o input.sql payload.sql; psql < input.sql',
 'sort --output=input.sql payload.sql; psql < input.sql',
 'grep -r SELECT input.sql; psql < input.sql',
 'tee unrelated.txt; psql < input.sql','awk 1 payload.sql; psql < input.sql',
 'env cat payload.sql; psql < input.sql',
])it(`R12 whole list read-only inventory CARD ${command}`,()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd,writtenScripts:files})).toBeNull();
}));
it('R12 symlink certificate must name physical file',()=>withFiles((cwd,files)=>{
 symlinkSync(join(cwd,'input.sql'),join(cwd,'alias.sql'));
 expect(noLimitsWipe('psql < alias.sql',{cwd,writtenScripts:files})).toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe('psql < alias.sql',{cwd,writtenScripts:new Set([join(cwd,'alias.sql')])})).toBeNull();
}));
it('R12 bracket test is an allowlisted command',()=>withFiles((cwd,files)=>{
 expect(noLimitsWipe('[ -f input.sql ] && psql < input.sql',{cwd,writtenScripts:files})).toBeNull();
}));
it('R12 parent component in a cwd change cannot certify a different physical file',()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe('cd sub/.. && psql < input.sql',{cwd,writtenScripts:files})).toBeNull();
}));
it('R12 shared file reader cannot certify a list containing uniq',()=>{
 expect(rawDynamicExecution('uniq payload.sql input.sql; psql < input.sql',()=> 'SELECT 1')).toBe(true);
});
