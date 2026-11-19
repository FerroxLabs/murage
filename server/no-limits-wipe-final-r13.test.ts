// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert command strings and files in an isolated temporary fixture.
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {simpleCertificationSubset,rawDynamicExecution} from '../shared/no-limits-raw-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {removeTempDir} from './testing/cleanup.ts';
for(const command of ['cat ~','cat ~/schema.sql','cd ~/sub && cat ../schema.sql','echo "~user"'])it(`A1 subset RUN ${command}`,()=>expect(simpleCertificationSubset(command)).toBe(true));
for(const command of ['cat ~user/schema.sql','cat a~/schema.sql','cat ~/a~','cat x~','cat ""~/schema.sql'])it(`A1 outside subset ${command}`,()=>expect(simpleCertificationSubset(command)).toBe(false));
async function files(check:(cwd:string,home:string,tracked:Set<string>)=>void){
 const root=mkdtempSync(join(tmpdir(),'wipe-r13-')),cwd=join(root,'w'),home=join(root,'owner');
 try{
  mkdirSync(join(cwd,'sub'),{recursive:true});mkdirSync(join(home,'sub'),{recursive:true});
  mkdirSync(join(root,'other/deep'),{recursive:true});
  symlinkSync(join(root,'other/deep'),join(cwd,'link'));
  writeFileSync(join(cwd,'schema.sql'),'SELECT 1');writeFileSync(join(home,'schema.sql'),'SELECT 2');
  writeFileSync(join(root,'other/schema.sql'),'DROP TABLE fixture;');
  check(cwd,home,new Set([realpathSync(join(cwd,'schema.sql')),realpathSync(join(home,'schema.sql'))]));
 }finally{await removeTempDir(root);}
}
for(const command of ['psql < ~/schema.sql','cat ~/schema.sql | psql','psql -f ~/schema.sql','cd ~/sub && psql < ../schema.sql','cd sub && psql < ../schema.sql','cd sub && cat ../schema.sql | psql','cd sub && psql -f ../schema.sql'])it(`A1 A2 owner physical file RUN ${command}`,()=>files((cwd,home,tracked)=>expect(noLimitsWipe(command,{cwd,home,writtenScripts:tracked})).toBeNull()));
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
for(const command of ['psql < link/../schema.sql','cd link/.. && psql < schema.sql','cd link && cd .. && psql < schema.sql',"echo bad > sub/../schema.sql; psql < schema.sql",'psql < ~/schema.sql; uniq payload.sql ~/schema.sql'])it(`A2 physical mismatch or writer CARD ${command}`,()=>files((cwd,home,tracked)=>expect(noLimitsWipe(command,{cwd,home,writtenScripts:tracked})).toBeNull()));
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
for(const command of ["psql < '~/schema.sql'",'psql < "~/schema.sql"',"cd '~' && psql < schema.sql"])it(`A1 quoted tilde stays literal CARD ${command}`,()=>files((cwd,home,tracked)=>expect(noLimitsWipe(command,{cwd,home,writtenScripts:tracked})).toBeNull()));
it('A2 certificate names the physical file even through a parent and symlink',()=>files((cwd,home,tracked)=>{
 const physical=realpathSync(join(cwd,'../other/schema.sql'));
 writeFileSync(physical,'SELECT 3');tracked.add(physical);
 expect(noLimitsWipe('psql < link/../schema.sql',{cwd,home,writtenScripts:tracked})).toBeNull();
}));

 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
for(const command of ["cat ~/schema.sql < '~/schema.sql' | psql","cat '~/schema.sql' < ~/schema.sql | psql"])it(`A1 ambiguous tilde spellings CARD ${command}`,()=>files((cwd,home,tracked)=>expect(noLimitsWipe(command,{cwd,home,writtenScripts:tracked})).toBeNull()));

for(const command of ["psql <<< ~","echo ~ | psql","echo 'DROP TABLE t' | psql -e 'SELECT 1'","echo 'DROP TABLE t' | psql -c 'SELECT 1' -f-","echo 'DROP TABLE t' | mysql -e 'source /dev/stdin'","echo 'DROP TABLE t' | sqlite3 -init /dev/stdin fixture.db 'SELECT 1'"])it(`A1 explicit input-use safety CARD ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'})).toBeNull();
});
