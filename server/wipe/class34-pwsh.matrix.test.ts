// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { known, type Invocation, type Value } from './types.ts';
import { pwshEffects } from './pwsh-model.ts';
import { globValue } from './glob.ts';
import { operand } from './expand.ts';
import { RootClassifier } from './roots.ts';
import { decide } from './decide.ts';

// Independent, hand-written spellings/oracle; never import the product cmdlet table.
// https://learn.microsoft.com/powershell/module/microsoft.powershell.management/remove-item
// https://learn.microsoft.com/powershell/module/microsoft.powershell.management/move-item
// https://learn.microsoft.com/powershell/module/microsoft.powershell.management/rename-item
// https://learn.microsoft.com/powershell/module/microsoft.powershell.management/convert-path
// https://learn.microsoft.com/powershell/module/microsoft.powershell.management/get-childitem
// https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/select-object
// https://learn.microsoft.com/powershell/scripting/developer/cmdlet/supporting-wildcard-characters-in-cmdlet-parameters
const home = 'C:/Users/member', project = 'C:/work/project';
const pathPort = {realpath:(p:string)=>p,stat:()=>({dev:1,ino:1}),lstat:()=>({dev:1,ino:1,isSymbolicLink:()=>false}),isBlockDevice:()=>false};
function invocation(program:string, args:(string|Value)[]=[], cwd='C:/scratch', pipedFrom?:Invocation):Invocation {
 return {program,argv:args.map(arg=>typeof arg==='string'?known(arg):arg),rawArgv:[],redirects:[],cwd:known(cwd),dialect:'pwsh',platform:'win32',drive:'C:',home,pipedFrom};
}
function verdict(inv:Invocation) {
 return decide(pwshEffects(inv),new RootClassifier({cwd:inv.cwd.k==='known'?inv.cwd.s:undefined,home,project,platform:'win32',dialect:'pwsh',pathPort,mountInventory:{contains:()=>false}},{contains:()=>false},true)).k;
}
type Producer = {name:string; strings?:boolean; make:(path:string)=>Invocation};
const producers:Producer[] = [
 {name:'Get-ChildItem -Path',make:path=>invocation('Get-ChildItem',['-Path',path])},
 {name:'gci positional',make:path=>invocation('gci',[path])},
 {name:'ls -LiteralPath',make:path=>invocation('ls',['-LiteralPath',path])},
 {name:'dir positional',make:path=>invocation('dir',[path])},
 {name:'Get-Item -Path',make:path=>invocation('Get-Item',['-Path',path])},
 {name:'gi positional',make:path=>invocation('gi',[path])},
 {name:'Resolve-Path positional',make:path=>invocation('Resolve-Path',[path])},
 {name:'rvpa -LiteralPath',make:path=>invocation('rvpa',['-LiteralPath',path])},
 {name:'Convert-Path positional',strings:true,make:path=>invocation('Convert-Path',[path])},
 {name:'cvpa -Path',strings:true,make:path=>invocation('cvpa',['-Path',path])},
 {name:'Get-Location provider cwd',make:path=>invocation('Get-Location',[],path)},
 {name:'gl provider cwd',make:path=>invocation('gl',[],path)},
 {name:'pwd provider cwd',make:path=>invocation('pwd',[],path)},
 {name:'literal array / $PWD values',strings:true,make:path=>invocation('\0values',['C:/scratch/build',path])},
 {name:'Write-Output -InputObject',strings:true,make:path=>invocation('Write-Output',['-InputObject',path])},
 {name:'echo positional',strings:true,make:path=>invocation('echo',[path])},
];
const chains:{name:string; selectsProperties?:boolean; make:(from:Invocation)=>Invocation}[] = [
 {name:'direct',make:from=>from},
 {name:'Sort-Object',make:from=>invocation('Sort-Object',[],undefined,from)},
 {name:'tee -Variable',make:from=>invocation('tee',['-Variable','items'],undefined,from)},
 {name:'Write-Output',make:from=>invocation('Write-Output',[],undefined,from)},
 {name:'select -Property *',selectsProperties:true,make:from=>invocation('select',['-Property','*'],undefined,from)},
 {name:'sort | Select-Object PSPath',selectsProperties:true,make:from=>invocation('Select-Object',['PSPath'],undefined,invocation('sort',[],undefined,from))},
];
const consumers:{name:string; make:(from:Invocation)=>Invocation}[] = [
 {name:'Remove-Item -r -fo',make:from=>invocation('Remove-Item',['-r','-fo'],undefined,from)},
 {name:'Move-Item -Destination',make:from=>invocation('Move-Item',['-Destination','C:/backup'],undefined,from)},
 {name:'Rename-Item -NewName',make:from=>invocation('Rename-Item',['-NewName','saved'],undefined,from)},
];
describe('class 3 independent producer × pass-through × consumer matrix',()=>{
 for(const producer of producers)for(const chain of chains)for(const consumer of consumers) {
  // Convert-Path, literals and Write-Output emit strings, which lack a PSPath property.
  it.each([[project,producer.strings&&chain.selectsProperties?'run':'card'],['C:/scratch/build','run']] as const)(`${producer.name} | ${chain.name} | ${consumer.name}: %s → %s`,(path,expected)=>{
   expect(verdict(consumer.make(chain.make(producer.make(path))))).toBe(expected);
  });
 }
});
const aliases:[string,string[]][] = [
 ['ri',['-Recurse']],['rm',['-rec','-Force']],['del',['-R']],['erase',['-Recurse:$true']],
 ['rd',['-RECURSE']],['rmdir',['-Recurse','-Force']],['mi',['-Destination','C:/backup']],
 ['mv',['-dest','C:/backup']],['move',['-d','C:/backup']],['rni',['-NewName','saved']],
 ['ren',['-new','saved']],['Remove-Item',['-Path',project,'-r','-fo']],
];
it.each(aliases)('class 3 hand-written alias %s retains a piped project', (name,args)=>{
 expect(verdict(invocation(name,args,undefined,invocation('gi',[project])))).toBe('card');
});

// Expected verdicts are specified independently for each of four provider cwds.
const cwds = ['C:/','C:/scratch',home,home+'/build'];
const wildcardRows:[string,string,boolean,readonly ('card'|'run')[]][] = [
 ['bare star','*',false,['card','run','card','run']],
 ['quoted star (same dequoted Path value)','*',false,['card','run','card','run']],
 ['dot relative','.\\*',false,['card','run','card','run']],
 ['parent relative','..\\*',false,['card','card','card','card']],
 ['relative prefix','Use*',false,['card','run','run','run']],
 ['dot relative prefix','.\\Use*',false,['card','run','run','run']],
 ['parent relative prefix','..\\Us*',false,['card','card','card','run']],
 ['question mark','U?ers',false,['card','run','run','run']],
 ['bracket set','Use[r]s',false,['card','run','run','run']],
 ['drive relative','C:Use*',false,['card','run','run','run']],
 ['drive root relative','\\Use*',false,['card','card','card','card']],
 ['multiple segments','C:\\Us*\\*',false,['card','card','card','card']],
 ['home relative','~\\*',false,['card','card','card','card']],
 ['literal path','C:\\Use*',true,['run','run','run','run']],
 ['backtick star','C:\\Use`*',false,['run','run','run','run']],
 ['bracket range','C:\\[T-V]sers',false,['card','card','card','card']],
 ['bracket negation','C:\\[!V]sers',false,['card','card','card','card']],
 ['drive case folded','c:\\uSE[r]S',false,['card','card','card','card']],
 ['recursive glob','C:\\Us*\\**',false,['card','card','card','card']],
];
describe('class 4 independent provider wildcard matrix',()=>{
 for(const [label,path,literal,expected] of wildcardRows)for(const [index,cwd] of cwds.entries())for(const consumer of ['Remove-Item','Move-Item','Rename-Item']) {
  it(`${label} in ${cwd} with ${consumer} → ${expected[index]}`,()=>{
   const args = [literal?'-LiteralPath':'-Path',path,...(consumer==='Remove-Item'?['-Recurse']:consumer==='Move-Item'?['-Destination','C:/backup']:['-NewName','saved'])];
   expect(verdict(invocation(consumer,args,cwd))).toBe(expected[index]);
  });
 }
});

const boundaryRows:[string,string[],('card'|'run')][] = [
 ['Select-Object',['-First','1'],'run'],['select',['-Last','1'],'run'],['select',['-Skip','1'],'run'],
 ['select',['-SkipLast','1'],'run'],['select',['-Index','0'],'run'],['select',['-Property','Name'],'run'],
 ['Select-Object',['-Unique'],'card'],['Select-Object',['-ExpandProperty','PSPath'],'card'],
 ['Select-Object',['-Property','PSPath'],'card'],['Select-Object',['-Property','Name\0,PSPath'],'card'],
 ['Select-Object',['-Property','*'],'card'],['Where-Object',['Name','-eq','dist'],'run'],
];
it.each(boundaryRows)('class 3 provenance boundary %s %j → %s',(name,args,expected)=>{
 expect(verdict(invocation('Remove-Item',['-Recurse'],undefined,invocation(name,args,undefined,invocation('gci',[project]))))).toBe(expected);
});
it.each(['Remove-Item','Move-Item','Rename-Item'])('explicit benign source unions protected pipeline for %s',name=>{
 const args = ['-Path','C:/scratch/build',...(name==='Remove-Item'?['-Recurse']:name==='Move-Item'?['-Destination','C:/backup']:['-NewName','saved'])];
 expect(verdict(invocation(name,args,undefined,invocation('Get-Item',[project])))).toBe('card');
});
it.each(['Remove-Item','Move-Item','Rename-Item'])('WhatIf suppresses %s',name=>{
 expect(verdict(invocation(name,['-Path',project,'-Recurse','-WhatIf']))).toBe('run');
});
it.each(['/ho*/*','/ho[m]e'])('class 4 sh twin %s retains protected roots',pattern=>{
 const value=operand(globValue(pattern,'sh'),known('/work/project'));
 const classifier=new RootClassifier({home:'/home/member',project:'/work/project',platform:'linux',pathPort,mountInventory:{contains:()=>false}},{contains:()=>false},true);
 expect(decide([{k:'delete',target:value,recursive:true}],classifier).k).toBe('card');
});
// secret-scan: fixture (generic fixture home names only; no host data)
