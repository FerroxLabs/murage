// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {inspectOwnerOperation} from './no-limits-inspection.ts';
import {quote} from './no-limits-shell.ts';
import {noLimitsProtectedWrite} from './no-limits-protected.ts';
import {describeOwnerNoLimits} from './decision/action.ts';
it.each([
 ['py',"open('/etc/hosts','w').write('fixture')"],
 ['py',"from pathlib import Path; p=Path('/etc/hosts'); p.write_text('fixture')"],
 ['js',"require('fs').writeFileSync('/etc/hosts','fixture')"],
])('%s code API retains exact protected write effects',(lang,text)=>{
 const result=inspectOwnerOperation({kind:'code',lang:lang as 'py'|'js',text,cwd:'/tmp',cwdInvalid:false});
 expect(result.decisions).toContainEqual(expect.objectContaining({reason:'direct-path',op:'write',lexical:'/etc/hosts'}));
 expect(describeOwnerNoLimits({tool:lang==='py'?'python':'node',input:{code:text,cwd:'/tmp'}}).ownerAuthority.decisions.some((d:any)=>d.protectedDecision?.physical==='/etc/hosts')).toBe(true);
});
it.each([
 ['py',"open('/etc/hosts').read()"],
 ['py',"open('/tmp/ordinary','w').write('/etc/hosts')"],
 ['js',"require('fs').writeFileSync('/tmp/ordinary','/etc/hosts')"],
 ['js',"require('fs').readFileSync('/etc/hosts')"],
 ['js',"require('fs').openSync('/etc/hosts')"],
])('%s protected data/read remains RUN',(lang,text)=>{
 expect(inspectOwnerOperation({kind:'code',lang:lang as 'py'|'js',text,cwd:'/tmp',cwdInvalid:false}).decisions).toEqual([]);
 expect(noLimitsProtectedWrite((lang==='py'?'python3 -c ':'node -e ')+quote(text),{commandCwd:'/tmp'})).toBeNull();
});
it.each([
 "python3 -c \"open('/etc/hosts','w').write('fixture')\"",
 "node -e \"require('fs').writeFileSync('/etc/hosts','fixture')\"",
 'eval '+quote('python3 -c '+quote('open("/etc/hosts","w").write("fixture")')),
])('shell-carried code has complete structured effects: %s',text=>{
 const result=inspectOwnerOperation({kind:'exec',dialect:'sh',text,cwd:'/tmp',cwdInvalid:false});
 expect(result.decisions.some(d=>d.reason==='direct-path'&&d.physical==='/etc/hosts')).toBe(true);
 expect(describeOwnerNoLimits({tool:'Bash',input:{command:text,cwd:'/tmp'}}).ownerAuthority.decisions.some((d:any)=>d.protectedDecision?.physical==='/etc/hosts')).toBe(true);
});
it('native API alias operations share one envelope and keep ordinary literal twins',()=>{
 const text="import os; os.symlink('/etc/hosts','./new'); open('./new','w').write('fixture')";
 expect(inspectOwnerOperation({kind:'code',lang:'py',text,cwd:'/tmp',cwdInvalid:false}).decisions).toContainEqual(expect.objectContaining({reason:'alias-taint',op:'write',lexical:'/tmp/new'}));
 expect(inspectOwnerOperation({kind:'code',lang:'py',text:text.replace('/etc/hosts','./ordinary'),cwd:'/tmp',cwdInvalid:false}).decisions).toEqual([]);
});

it('shell code uses physical and logical cwd candidates instead of a legacy cwd projection',()=>{
 const source="cd /etc && python3 -c \"open('hosts','w').write('fixture')\"";
 expect(inspectOwnerOperation({kind:'exec',dialect:'sh',text:source,cwd:'/tmp',cwdInvalid:false}).decisions.some(d=>d.physical==='/etc/hosts')).toBe(true);
 const unknown="cd \"$(opaque-dir)\"; python3 -c \"open('hosts','w').write('fixture')\"";
 expect(inspectOwnerOperation({kind:'exec',dialect:'sh',text:unknown,cwd:'/tmp',cwdInvalid:false}).decisions.some(d=>d.reason==='unknown-cwd-protected-suffix')).toBe(true);
 expect(inspectOwnerOperation({kind:'exec',dialect:'sh',text:unknown.replace("'hosts'","'notes'"),cwd:'/tmp',cwdInvalid:false}).decisions).toEqual([]);
});
it('revisited function code keeps one source identity and an ordinary native link remains RUN',()=>{
 const text='f() { python3 -c '+quote("import os; os.symlink('./ordinary','./new')")+'; }; f';
 expect(inspectOwnerOperation({kind:'exec',dialect:'sh',text,cwd:'/tmp',cwdInvalid:false}).decisions).toEqual([]);
});
it.each([
 ['py',"open(1,'w').write('/etc/hosts')",false],
 ['js',"require('fs').openSync('/etc/hosts',0)",false],
 ['js',"require('fs').openSync('/etc/hosts',1)",true],
])('%s numeric descriptors and open flags keep write semantics',(lang,text,held)=>{
 expect(inspectOwnerOperation({kind:'code',lang:lang as 'py'|'js',text,cwd:'/tmp',cwdInvalid:false}).decisions.some(d=>d.reason==='direct-path')).toBe(held);
});

it.each([
 ['py',"import os; os.chdir('/etc'); open('hosts','w').write('fixture')"],
 ['js',"process.chdir('/etc'); require('fs').writeFileSync('hosts','fixture')"],
 ['py',"import os; os.chdir('/etc'); os.system('printf x > hosts')"],
])('%s code cwd mutation cannot reuse the original request cwd',(lang,text)=>{
 const operation={kind:'code' as const,lang:lang as 'py'|'js',text,cwd:'/tmp',cwdInvalid:false};
 expect(inspectOwnerOperation(operation).decisions.some(d=>d.physical==='/etc/hosts'||d.reason==='unknown-cwd-protected-suffix')).toBe(true);
 expect(inspectOwnerOperation({...operation,text:text.replaceAll('/etc','/tmp').replaceAll('hosts','notes')}).decisions).toEqual([]);
});

it.each([
 ['py',"import os; os.chdir('/etc'); open('notes','w').write('fixture')"],
 ['js',"process.chdir('/etc'); require('fs').writeFileSync('notes','fixture')"],
])('%s code cwd keeps known protected candidates as well as unknown suffixes',(lang,text)=>{
 const operation={kind:'code' as const,lang:lang as 'py'|'js',text,cwd:'/tmp',cwdInvalid:false};
 expect(inspectOwnerOperation(operation).decisions.some(d=>d.physical==='/etc/notes')).toBe(true);
 const opaque=text.replace("'/etc'",'opaqueDirectory()');
 expect(inspectOwnerOperation({...operation,text:opaque}).decisions).toEqual([]);
});

it('a known absolute code cwd candidate survives an initially invalid request cwd',()=>{
 const operation={kind:'code' as const,lang:'py' as const,text:"import os; os.chdir('/etc'); open('notes','w').write('fixture')",cwd:'/tmp',cwdInvalid:true};
 expect(inspectOwnerOperation(operation).decisions.some(d=>d.physical==='/etc/notes')).toBe(true);
});

it.each([
 ['py',"import os; os.chdir(opaqueDirectory()); open('hosts','w').write('fixture')"],
 ['js',"process.chdir(opaqueDirectory()); require('fs').writeFileSync('hosts','fixture')"],
])('%s opaque code cwd holds protected suffixes and keeps ordinary names runnable',(lang,text)=>{
 const operation={kind:'code' as const,lang:lang as 'py'|'js',text,cwd:'/tmp',cwdInvalid:false};
 expect(inspectOwnerOperation(operation).decisions.some(d=>d.reason==='unknown-cwd-protected-suffix')).toBe(true);
 expect(inspectOwnerOperation({...operation,text:text.replaceAll('hosts','notes')}).decisions).toEqual([]);
});
it.each([
 ['py',"import os; os.chdir('/tmp'); os.symlink('./ordinary','./new'); open('./new','w').write('fixture')"],
 ['js',"process.chdir('/tmp'); require('fs').symlinkSync('./ordinary','./new'); require('fs').writeFileSync('./new','fixture')"],
])('%s known ordinary code cwd does not invent an unknown producer',(lang,text)=>{
 expect(inspectOwnerOperation({kind:'code',lang:lang as 'py'|'js',text,cwd:'/tmp',cwdInvalid:false}).decisions).toEqual([]);
});
