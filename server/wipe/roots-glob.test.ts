// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { RootClassifier, canonicalPath } from './roots.ts';
import { globValue } from './glob.ts';
import { known, type WipeContext } from './types.ts';
import { RootRegistry } from './registry.ts';
import { pwshEffects } from './pwsh-model.ts';
import { decide } from './decide.ts';
import { type Invocation } from './types.ts';
import { operand } from './expand.ts';

const port={realpath:(p:string)=>p,stat:()=>({dev:1,ino:1}),lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),isBlockDevice:()=>false};
function fixture(options:WipeContext={}) {
 const context:WipeContext={cwd:'C:/scratch',home:'C:/Users/member',project:'C:/work/project',platform:'win32',dialect:'pwsh',pathPort:port,mountInventory:{contains:()=>false},...options};
 const classifier=new RootClassifier(context,{contains:()=>false},true);
 const classify=(pattern:string)=>classifier.classify(operand(globValue(pattern,context.dialect??'pwsh'),known(context.cwd!),{platform:context.platform,drive:'C:'}));
 return {classifier,classify};
}
it.each(['C:/Us*/*','C:/U?e[r]s/*','c:/uSE*/*','C:/work/pro*','C:/w*/pro*'])('walks all wildcard segments: %s',pattern=>{
 expect(fixture().classify(pattern)).toBeDefined();
});
it.each(['Use*','.\\Use*','C:Use*','\\Use*','U?ers','Use[r]s'])('relative pattern %s resolves at drive cwd',pattern=>{
 expect(fixture({cwd:'C:/'}).classify(pattern)).toBe('homes-parent');
});
it('intermediate wildcard ancestors do not imply a wipe of a protected directory',()=>{
 expect(fixture().classify('C:/Us*/member/build*')).toBeUndefined();
 expect(fixture().classify('C:/work/*/dist')).toBeUndefined();
});
it('globstar visits only protected candidates and can match zero segments',()=>{
 expect(fixture().classify('C:/**/pro*')).toBe('os-dir');
 expect(fixture().classify('C:/**/proj*')).toBe('home'); // May select another user's home named project.
 expect(fixture().classify('C:/work/**/pro*')).toBe('project-root');
});
it('registry protected children participate in a segmented path walk',()=>{
 const roots=['/work/other-root','/work/shared'];
 const classifier=new RootClassifier({cwd:'/',home:'/home/member',project:'/work/project',platform:'linux',dialect:'sh',pathPort:port,mountInventory:{contains:()=>false}}, {
  protectedChildren:dir=>dir==='/work'?roots:[],contains:path=>roots.some(root=>root===path||root.startsWith(path+'/')),
 },true);
 expect(classifier.classify(globValue('/w*/other-*','sh'))).toBe('project-root');
 expect(classifier.classify(globValue('/work/sh[ae]red','sh'))).toBe('project-root');
 expect(classifier.classify(globValue('/work/other-*/dist','sh'))).toBeUndefined();
});
it('legacy one-segment values remain supported while A changes Value.glob',()=>{
 expect(fixture().classifier.classify({...known('C:/Use*'),glob:{dir:'C:/',pattern:'Use*'}})).toBe('homes-parent');
});
it.each(['/Home/member','/users','/home/MEMBER/build','/Ho*/*','/uSers'])('L6/L8 missing wrong-case POSIX target %s runs',pattern=>{
 const missing={...port,stat:()=>null,lstat:()=>null,realpath:()=>null};
 const {classifier,classify}=fixture({cwd:'/',home:'/home/member',project:'/work/project',platform:'linux',dialect:'sh',pathPort:missing});
 expect(classifier.classify(known(pattern))).toBeUndefined();
 expect(classify(pattern)).toBeUndefined();
});
it('classifyLexical has no path probes and protects every lexical home alternative',()=>{
 let probes=0;
 const fail=()=>{probes++;throw Error('unexpected path IO');};
 const classifier=new RootClassifier({cwd:'/work/project/pkg',home:'/home/member',project:'/work/project',platform:'linux',pathPort:{realpath:fail,stat:fail,lstat:fail,isBlockDevice:fail}}, {contains:path=>path==='/registered/root'},true);
 for(const path of ['/','/etc','/home/other','/Users/another','/var/root','/registered/root','/work/project','..'])expect(classifier.classifyLexical(path)).toBeDefined();
 expect(classifier.classifyLexical('dist')).toBeUndefined();
 expect(classifier.classifyLexical('/Home/member')).toBeUndefined();
 expect(classifier.classifyLexical({...known('build'),candidates:['dist','/home/other']})).toBe('home');
 expect(probes).toBe(0);
});
it('lexical drive roots and home paths match case insensitively',()=>{
 const {classifier}=fixture();
 expect(classifier.classifyLexical('c:/')).toBe('drive-root');
 expect(classifier.classifyLexical('c:/uSeRs/OTHER')).toBe('home');
 expect(classifier.classifyLexical('c:/WORK/PROJECT')).toBe('project-root');
 expect(fixture({cwd:'C:/'}).classifier.classifyLexical('C:Users')).toBe('homes-parent');
 expect(fixture({cwd:'C:/'}).classifier.classify(globValue('C:Use*','pwsh'))).toBe('homes-parent');
});
it('literal wildcards never acquire a GlobSpec or match protected names',()=>{
 const {classifier}=fixture();
 expect(classifier.classify(globValue('C:/Use*','pwsh',true))).toBeUndefined();
 expect(classifier.classify(globValue('C:/Use`*','pwsh'))).toBeUndefined();
});
it('registry failures leave static lexical classification available',()=>{
 const classifier=new RootClassifier({cwd:'/',home:'/home/member',platform:'linux',pathPort:port},{contains:()=>{throw Error('fixture registry unavailable');}},true);
 expect(classifier.classifyLexical('/home/other')).toBe('home');
 expect(classifier.classifyLexical('/scratch/build')).toBeUndefined();
});
it('canonicalPath retains the existing POSIX case rule',()=>{
 expect(canonicalPath('/Home/member','linux')).toBe('/Home/member');
});

function registeredFixture(paths:string[]) {
 // This fixture exercises lexical registry edges, without inventing shared inode aliases.
 const registry=new RootRegistry({realpath:port.realpath,isBlockDevice:port.isBlockDevice});
 paths.forEach((path,i)=>registry.replace('bot:fixture:task-'+i,[path]));
 const classifier=new RootClassifier({cwd:'C:/scratch',home:'C:/Users/member',project:'C:/active/project',platform:'win32',dialect:'pwsh',pathPort:port,mountInventory:{contains:()=>false}},registry,true);
 const verdict=(pattern:string)=>{
  const inv:Invocation={program:'Remove-Item',argv:['-Recurse','-Force',pattern].map(known),rawArgv:[],redirects:[],cwd:known('C:/scratch'),dialect:'pwsh',platform:'win32',drive:'C:'};
  return decide(pwshEffects(inv),classifier).k;
 };
 return {registry,classifier,verdict};
}
it('R2 registry-only intermediate ancestors survive a segmented wildcard',()=>{
 const {verdict,classifier}=registeredFixture(['C:/archive/team/project']);
 expect(verdict('C:/archive/*/project')).toBe('card');
 expect(verdict('c:/ARCHIVE/t*/proje[c]t')).toBe('card');
 expect(classifier.classifyLexical(globValue('C:/archive/*/project','pwsh'))).toBe('project-root');
 expect(verdict('C:/archive/*/project/dist')).toBe('run');
});
it('R3 registry wildcard enumeration retains siblings after entry 256',()=>{
 const {verdict,registry}=registeredFixture(Array.from({length:257},(_,i)=>'C:/archive/p'+String(i).padStart(3,'0')));
 expect(verdict('C:/archive/p25[6]')).toBe('card');
 expect(verdict('C:/archive/p25[7]')).toBe('run');
 registry.drop('bot:fixture:task-256');
 expect(verdict('C:/archive/p25[6]')).toBe('run');
});
it('R2 registry trie edges update after replacement and removal',()=>{
 const {verdict,registry}=registeredFixture(['C:/archive/team/project']);
 registry.replace('bot:fixture:task-0',['C:/archive/other/project']);
 expect(verdict('C:/archive/t*/project')).toBe('run');
 expect(verdict('C:/archive/o*/project')).toBe('card');
 registry.clear();expect(verdict('C:/archive/*/project')).toBe('run');
});
// secret-scan: fixture (generic fixture home names only; no host data)
