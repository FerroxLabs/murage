// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { globRegExp, globValue, type GlobSpec } from './glob.ts';
import { known } from './types.ts';
import { operand } from './expand.ts';

it.each([
 ['Use[r]s','Users',true],['Use[a-r]s','Users',true],['Use[!a-q]s','Users',true],
 ['Use[!r]s','Users',false],['Use?*','Users',true],['Use`*','Use*',true],['Use`*','Users',false],
 ['Use`[r`]s','Use[r]s',true],['[abc','[abc',true],['[z-a]','[z-a]',true],
 ['[]a]',']',true],['[-a]','-',true],['[a-]','-',true],['a.b','axb',false],
 ['a+b','a+b',true],['*','a/b',false],['**','a/b',false],['U*','users',false],
] as const)('pwsh segment %s against %s → %s',(pattern,name,expected)=>{
 expect(globRegExp(pattern,'pwsh').test(name)).toBe(expected);
});
it('drive case folding is explicit and POSIX remains case sensitive',()=>{
 expect(globRegExp('Use[r]s','pwsh',true).test('uSERS')).toBe(true);
 expect(globRegExp('Ho*','sh').test('home')).toBe(false);
});
it.each([
 ['sh','a\\*','a*',true],['sh','a\\*','abc',false],['pwsh','a\\*','a\\bc',true],
 ['cmd','a`*','a`bc',true],['pwsh','a`?','a?',true],
] as const)('%s escapes in %s match %s → %s',(dialect,pattern,name,expected)=>{
 expect(globRegExp(pattern,dialect).test(name)).toBe(expected);
});
it.each(['sh','pwsh','cmd'] as const)('%s final star models cwd contents',dialect=>{
 expect(globValue('*',dialect)).toMatchObject({k:'known',s:'.',wholeDirGlob:true});
 expect(globValue('**',dialect)).toMatchObject({wholeDirGlob:true,recursiveGlob:true});
 expect(globValue('*',dialect,true)).toMatchObject({k:'known',s:'*'});
 expect(globValue('*',dialect,true)).not.toHaveProperty('wholeDirGlob');
});
it.each([
 ['Use*','.', ['Use*']],['.\\Use*','.', ['Use*']],['..\\Us*','..',['Us*']],
 ['C:Use*','C:.',['Use*']],['\\Use*','/',['Use*']],['C:\\Us*\\Other*','C:/',['Us*','Other*']],
 ['C:\\Us*\\*','C:/',['Us*']],['C:\\Us*\\**','C:/',['Us*']],
] as const)('glob %s retains base %s and every segment',(pattern,base,segments)=>{
 const value=globValue(pattern,'pwsh');expect(value.k).toBe('known');
 if(value.k==='known')expect(value.glob).toMatchObject({base,segments,dialect:'pwsh'});
});
it('sh directory-only globs retain the project cleanup exception',()=>{
 expect(globValue('./*/','sh')).toMatchObject({s:'.',wholeDirGlob:true,dirsOnly:true});
});
it('cmd *.* retains whole-directory semantics',()=>expect(globValue('C:\\scratch\\*.*','cmd')).toMatchObject({s:'C:/scratch',wholeDirGlob:true}));
it('backtick escaped wildcard is a literal provider name',()=>{
 expect(globValue('C:\\Use`*','pwsh')).toMatchObject({s:'C:\\Use*'});
 expect(globValue('C:\\Use`*','pwsh')).not.toHaveProperty('glob');
});
it('a relative wildcard base resolves at the provider cwd',()=>{
 const value=operand(globValue('C:Use*','pwsh'),known('C:/'),{platform:'win32',drive:'C:'});
 expect(value.k).toBe('known');if(value.k==='known')expect((value.glob as GlobSpec).dir.replaceAll('\\','/')).toBe('C:/.');
});
