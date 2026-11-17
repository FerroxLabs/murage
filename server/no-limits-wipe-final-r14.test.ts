// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULINGS H1/H2: inert SQL and isolated files; no database is executed.
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {rawDynamicExecution} from '../shared/no-limits-raw-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {currentDatabaseInputs,shellDatabaseWipe} from './no-limits-database-input.ts';
import {forEachOwnerSegment} from './no-limits-shell.ts';
import {removeTempDir} from './testing/cleanup.ts';
async function files(check:(cwd:string,tracked:Set<string>)=>void){
 const root=mkdtempSync(join(tmpdir(),'wipe-r14-')),cwd=join(root,'w');
 try{
  for(const dir of ['w/safe','w/sub','other/deep'])mkdirSync(join(root,dir),{recursive:true});
  symlinkSync(join(root,'other/deep'),join(cwd,'link'));
  writeFileSync(join(cwd,'schema.sql'),'DROP TABLE t;');
  writeFileSync(join(root,'other/schema.sql'),'SELECT 1');
  writeFileSync(join(cwd,'appdb'),'SELECT 1');
  writeFileSync(join(cwd,'safe.sql'),'SELECT 1');
  writeFileSync(join(cwd,'sub/schema.sql'),'SELECT 1');
  check(cwd,new Set(['other/schema.sql','w/appdb','w/safe.sql','w/sub/schema.sql'].map(p=>join(root,p))));
 }finally{await removeTempDir(root);}
}
for(const client of ['mysql -f appdb','mariadb -f appdb','psql -f safe.sql','psql --file=safe.sql',"psql -c 'SELECT 1'","mysql -e 'SELECT 1'",'sqlite3 appdb',"sqlite3 appdb 'SELECT 1'",'psql --help']){
 const command=`echo 'DROP TABLE t;' | ${client}`;
 it(`R14 H1 stdin always CARD ${client}`,()=>files((cwd,tracked)=>{
  expect(rawDynamicExecution(command,()=> 'SELECT 1')).toBe(true);
  expect(shellDatabaseWipe(command,currentDatabaseInputs(cwd,tracked,command))).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(noLimitsWipe(command,{cwd,writtenScripts:tracked})).toBeNull();
 }));
}
for(const command of ['mysql -f appdb','sqlite3 appdb','mysql --file safe.sql','sqlite3 --input-file safe.sql'])it(`R14 H1 non-script operands never read ${command}`,()=>{
 const reads:string[]=[];
 rawDynamicExecution(command,file=>{reads.push(file);return 'SELECT 1';});
 shellDatabaseWipe(command,file=>{reads.push(file);return 'SELECT 1';});
 expect(reads).toEqual([]);
});
for(const command of ['psql -f safe.sql','psql --file=safe.sql','psql --file safe.sql'])it(`R14 H1 psql file RUN ${command}`,()=>files((cwd,tracked)=>expect(noLimitsWipe(command,{cwd,writtenScripts:tracked})).toBeNull()));
for(const command of ['cd link/.. && pushd safe && popd && psql < schema.sql','cd link/.. && pushd safe && pushd && psql < schema.sql','cd link/.. && pushd safe && cd - && psql < schema.sql'])it(`R14 H2 restored uncertainty CARD ${command}`,()=>files((cwd,tracked)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd,writtenScripts:tracked})).toBeNull();
 const restored:Array<{logical?:string;physical?:string;unknownCause?:string}>=[];
 forEachOwnerSegment(command,cwd,row=>{if(row.roles.program==='psql')restored.push(...row.candidates.map(({logical,physical,unknownCause})=>({logical,physical,unknownCause})));},'posix',undefined,0,{home:cwd});
 // MAIN RULING INT-CONFLICT-DEFAULT 661854e833 / c08609816b: logical cd resolves link/.. before lookup; the stack restores the exact known cwd.
 expect(restored).toEqual([{logical:cwd,physical:cwd,unknownCause:undefined}]);
}));
it('R14 H2 plain directory stack RUN',()=>files((cwd,tracked)=>{
 expect(noLimitsWipe('pushd sub && psql < schema.sql && popd',{cwd,writtenScripts:tracked})).toBeNull();
}));
