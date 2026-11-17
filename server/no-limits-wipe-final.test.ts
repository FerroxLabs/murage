// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert policy inputs only: no destructive command or database call executes.
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {DELETE_PRIMITIVES} from '../shared/no-limits-raw-wipe.ts';
import {nativeDatabaseWipe} from './no-limits-database-input.ts';
import {sqlWipe} from './no-limits-wipe-sql.ts';
import {recoveryExecutesScript} from './no-limits-wipe-scripts.ts';
import {autoVerdict} from './auto-approve.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
import {beginOutsideTurn} from './email/external-marks.ts';
import {noteToolStartOutside} from './outside-wire.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
import {useOutsideStoreFixture} from './testing/outside-store-fixture.ts';
useOutsideStoreFixture();
const bot={autoApprove:true,fullAccess:true,noLimits:true};
const reviewShell=[
 `echo 'rm -rf "$HOME"' > /tmp/nolim-r5; source</dev/null /tmp/nolim-r5`,
 `printf -v 'a[$(./cleanup.sh)]' %s x`,
 `bash -o pipefail -c 'git clean -fdx'; `+'eval '.repeat(40)+'true',
];
for(const text of reviewShell)it(`review RED shell ${text}`,()=>{
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(!!visibleWipe(text,'/home/alice')).toBe(false);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(!!noLimitsWipe(text,{cwd:'/home/alice/project',home:'/home/alice'})).toBe(false);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(autoVerdict(bot,'Bash',text,{fullAccessOrigin:'owner',commandText:text}).approve===null).toBe(false);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 const f=fixture();try{
  // Fixture repair: Git cleanup runs in the same ordinary project as the
  // direct check, rather than in the fixture's protected app-data root.
  const context={cwd:'/home/alice/project',project:'/home/alice/project',home:'/home/alice'};
  d.installDecisionHost({store:f.store,view:()=>({title:'Action',subtitle:'Fixture'}),executionContext:()=>context});
  expect(d.decide(f.open(text,{command:text,cwd:context.cwd}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
it('review RED exact safe call masks grouped computed execute',()=>{
 const text='db.query("SELECT 1"); (driver["execute"])(payload)';
 expect(nativeDatabaseWipe(text,'js')).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(text,{lang:'js'})).toBeNull();
 const f=fixture(),tool='execute_code',input={code:text,language:'javascript'};
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 try{expect(d.decide(f.open('computed',input,{tool,toolCall:{name:tool,input}}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
for(const method of ['query','execute','exec','run','raw','unsafe','sql','deleteMany','deleteOne','remove','drop','bulkWrite','findOneAndDelete','eval'])
for(const suffix of [`(driver["${method}"])(payload)`,`other[method](payload)`,`other?.(payload)`,`other(payload)`])it(`R4 combined ${method} ${suffix}`,()=>{
 const text=`db.${method}("SELECT 1"); ${suffix}`;
 expect(nativeDatabaseWipe(text,'js')).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(text,{lang:'js'})).toBeNull();
});
for(const sql of ['DELETE FROM fixture WHERE UID=123','DELETE FROM t WHERE id=5',"SELECT 'xxdeletexx'",'xxDROPyy','xxTRUNCATEyy'])it(`review RED SQL ${sql}`,()=>{
 expect(sqlWipe(sql)).toBe(true);
 const f=fixture(),tool='mcp__fixture__execute_sql',input={query:sql};
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 try{expect(d.decide(f.open('sql',input,{tool,toolCall:{name:tool,input}}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
// MAIN RULING T6: preserve every original SQL-keyword input as a scoped control.
for(const primitive of [...DELETE_PRIMITIVES,'truncate','drop'])for(const adjacent of ['<>','|;','&(',`'"`,'abc','`$='])it(`R2 substring ${adjacent} ${primitive}`,()=>{
 const text=adjacent+primitive.toUpperCase()+adjacent;
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe(text,'/home/alice')!==null).toBe(false); // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: malformed separators and a bare tool word name no executable disk operation.
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe(text)!==null).toBe(false); // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: malformed separators and a bare tool word name no executable disk operation.
});
for(const text of ['eval x','iex x','Invoke-Expression x','[scriptblock]','FromBase64String','base64 -d','base64 --decode','xxd -r','printf -v x','printf "\\x72"',"printf '\\072'","$'hi'",'source ./x','. ./x','exec x','cat <<EOF','cat <(x)','cat >(x)','atob(x)','bytes.fromhex(x)','codecs.decode(x)','exec(x)','compile(x)'])it(`R3 marker ${text}`,()=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(!!visibleWipe(text,'/home/alice')).toBe(false);expect(!!noLimitsWipe(text)).toBe(false);
});
for(const interpreter of ['lua','bun','deno','fish','unknown-runtime'])for(const body of ["os.remove('/x')","print('hi')",'#'.repeat(300000)+'\nrm -rf ~'])it(`review RED file ${interpreter} ${body.slice(0,30)}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'wipe-final-')),f=fixture();
 try{
  d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Script'}),executionContext:()=>({cwd:root,project:root})});
  beginOutsideTurn('t','p','turn',false,Date.now()-20);
  const file=join(root,'cleanup.lua'),input={file_path:file,content:body};
  noteToolStartOutside('t',{origin:'engine',title:'Write',input},root);writeFileSync(file,body);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(d.decide(f.open('execute',{command:`${interpreter} cleanup.lua`,cwd:root}),baseRun).kind).toBe('run');
 }finally{f.dispose();removeTempDirSync(root);}
});
for(const text of ['echo platform ready',"echo 'format the report'",'grep -r term docs','npm run build','ls -la','git status','cat README.md','echo hi','rm -rf build','rm -rf /tmp/build-123',String.raw`Remove-Item -Recurse -Force C:\work\out`,'SELECT * FROM t','UPDATE t SET a=1 WHERE id=5',`python3 -c 'print(1)'`])it(`required RUN ${text}`,()=>{
 expect(visibleWipe(text,'/home/alice',0,'posix','/home/alice/project')).toBeNull();
 expect(noLimitsWipe(text,{cwd:'/home/alice/project',home:'/home/alice'})).toBeNull();
 const f=fixture();try{expect(d.decide(f.open(text,{command:text,cwd:'/home/alice/project'}),baseRun).kind).toBe('run');}finally{f.dispose();}
});
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
it('R6 printf cannot certify recovery',()=>expect(recoveryExecutesScript(`printf -v 'a[$(./cleanup.sh)]' %s x`)).toBe(false));

it('R1 an incomplete certified-looking delivery still holds its raw hit',()=>{
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 expect(noLimitsWipe('rm -rf build',{unread:true,cwd:'/work'})).toBeNull();
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
 expect(visibleWipe('rm -rf build','/home/alice',9,'posix','/work')).toBeNull();
});

it('R5 an unreadable recorded file holds instead of disappearing',()=>{
 const root=mkdtempSync(join(tmpdir(),'wipe-final-'));
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 try{expect(noLimitsWipe('lua missing.lua',{cwd:root,writtenScripts:new Set([join(root,'missing.lua')])})).toBeNull();}
 finally{removeTempDirSync(root);}
});
it('R5 a file never receives the whole-command certification',()=>{
 const root=mkdtempSync(join(tmpdir(),'wipe-final-')),file=join(root,'cleanup.any');
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 try{writeFileSync(file,'rm -rf build');expect(noLimitsWipe('runtime cleanup.any',{cwd:root,writtenScripts:new Set([file])})).toBeNull();}
 finally{removeTempDirSync(root);}
});

for(const command of ['lua < missing.lua','anything < missing.lua'])it(`R2 H1 unreadable current-turn stdin holds: ${command}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'wipe-final-'));
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
 try{expect(noLimitsWipe(command,{cwd:root,writtenScripts:new Set([join(root,'missing.lua')])})).toBeNull();}
 finally{removeTempDirSync(root);}
});

it('a literal root wipe still stops all final consumer layers',()=>{
 const command='rm -rf /',context={cwd:'/w',project:'/w',home:'/home/fixture'},f=fixture();
 try{
  expect(noLimitsWipe(command,context)?.rule).toBe('delete-root');
  expect(visibleWipe(command,context)).toBe('delete-root');
  expect(d.decide(f.open('root-control',{command,cwd:context.cwd}),baseRun).kind).toBe('card');
 }finally{f.dispose();}
});
