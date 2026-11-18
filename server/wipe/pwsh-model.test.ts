// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { bindParams, cmdletFor, produced, pwshEffects, sourcesOf } from './pwsh-model.ts';
import { known, opaque, type Invocation, type Value } from './types.ts';
import { globValue } from './glob.ts';

function inv(program:string,args:(string|Value)[]=[],pipedFrom?:Invocation,cwd='C:/scratch'):Invocation {
 return {program,argv:args.map(v=>typeof v==='string'?known(v):v),rawArgv:[],redirects:[],cwd:known(cwd),dialect:'pwsh',platform:'win32',home:'C:/Users/member',drive:'C:',pipedFrom};
}
const strings=(values:Value[])=>values.flatMap(v=>v.k==='known'?[v.s.replaceAll('\\','/')]:[]);
it('one binder handles case, unique prefixes, aliases and colon values',()=>{
 const bound=bindParams(inv('RI',['-pAtH:C:/Users','-r','-fo','-ea','Stop','-Confirm:$false']));
 expect(strings(bound.values.get('path')!)).toEqual(['C:/Users']);
 expect(bound.flags.has('recurse')).toBe(true);expect(bound.flags.has('force')).toBe(true);
 expect(bound.flags.has('confirm')).toBe(false);expect(bound.uncertain).toBe(false);
 expect(strings(bound.values.get('erroraction')!)).toEqual(['Stop']);
 expect(cmdletFor('Microsoft.PowerShell.Management\\Remove-Item')?.name).toBe('Remove-Item');
});
it('exact Path beats the PipelineVariable prefix and LiteralPath aliases bind once',()=>{
 const bound=bindParams(inv('Remove-Item',['-LP','C:/Users','-Recurse']));
 expect(strings(bound.values.get('literalpath')!)).toEqual(['C:/Users']);expect(bound.uncertain).toBe(false);
 expect(bound.values.has('path')).toBe(false);
});
it('ambiguous and missing parameter values remain uncertain',()=>{
 expect(bindParams(inv('Remove-Item',['-f','C:/Users'])).uncertain).toBe(true);
 const bound=bindParams(inv('Remove-Item',['-Path','-Recurse','C:/Users']));
 expect(bound.uncertain).toBe(true);expect(bound.flags.has('recurse')).toBe(true);
 expect(strings(bound.values.get('path')!)).toEqual(['C:/Users']);
});
it.each(['Move-Item','Rename-Item'])('%s distinguishes positional source and destination',name=>{
 const bound=bindParams(inv(name,['C:/Users','C:/backup']));
 expect(strings(bound.values.get('path')!)).toEqual(['C:/Users']);
 expect(strings(bound.values.get(name==='Move-Item'?'destination':'newname')!)).toEqual(['C:/backup']);
 expect(strings(sourcesOf(inv(name,['C:/scratch/build','C:/Users'])))).toEqual(['C:/scratch/build']);
});
it('explicit Path and LiteralPath sources are unioned with every pipeline value',()=>{
 const from=inv('\0values',['C:/Users','C:/work/project']);
 const sources=sourcesOf(inv('Move-Item',['-Path','C:/scratch/build','-LiteralPath','C:/scratch/Use*','-Destination','C:/backup'],from));
 expect(strings(sources)).toEqual(['C:/scratch/build','C:/scratch/Use*','C:/Users','C:/work/project']);
 expect(sources[1]).not.toHaveProperty('glob');
});
it('producer paths resolve at producer cwd while explicit paths use consumer cwd',()=>{
 const from=inv('gi',['.'],undefined,'C:/work/project');
 const sources=sourcesOf(inv('Move-Item',['build','-Destination','C:/backup'],from,'C:/scratch'));
 expect(strings(sources)).toEqual(['C:/scratch/build','C:/work/project/.']);
});
it('default Get-ChildItem path and recursive listing preserve child provenance',()=>{
 const values=produced(inv('gci',['-Recurse','-Force'],undefined,'C:/work/project'));
 expect(values[0]).toMatchObject({wholeDirGlob:true,entryOf:{start:'C:/work/project/.',wholeTree:true,rootSelf:false}});
 expect(pwshEffects(inv('Remove-Item',[],inv('gci',['-Recurse'],undefined,'C:/work/project')))[0]).toMatchObject({k:'delete',recursive:true});
});
it('recursive globs trigger recursive deletion without a Recurse switch',()=>{
 expect(pwshEffects(inv('Remove-Item',['C:/Users/**']))[0]).toMatchObject({k:'delete',recursive:true});
 expect(pwshEffects(inv('Remove-Item',['C:/Us*/**']))[0]).toMatchObject({k:'delete',recursive:true});
});
it('plain Get-Item does not invent recursive deletion',()=>{
 expect(pwshEffects(inv('Remove-Item',[],inv('Get-Item',['C:/Users'])))[0]).toMatchObject({k:'delete',recursive:false});
});
it.each(['-Filter','-Include','-Exclude','-Depth','-Directory','-Name'])('restricted listing %s ends whole-child provenance',option=>{
 const args=['-Directory','-Name'].includes(option)?[option]:[option,'*'];
 // MAIN RULING 1114-WIPE-REVIEW-BOUND: -Directory still delivers children (CROSS-wg-text request 3).
 const result=produced(inv('gci',['C:/work/project',...args]));
 if(option==='-Directory')expect(result[0]).toMatchObject({entryOf:{start:'C:/work/project',rootSelf:false}});
 else expect(result).toEqual([]);
});
it('Select-Object checks prefix-bound selection and retained PSPath',()=>{
 const from=inv('gci',['C:/work/project']);
 expect(produced(inv('select',['-fi','1'],from))).toEqual([]);
 expect(produced(inv('select',['-p','Name'],from))).toEqual([]);
 expect(produced(inv('select',['-Property','PSPath'],from))).toHaveLength(1);
});
it('Write-Output explicit objects union with pipeline objects',()=>{
 expect(strings(produced(inv('write-output',['C:/Users'],inv('gi',['C:/work/project']))))).toEqual(['C:/work/project','C:/Users']);
});
it('producer path binding unions explicit sources with upstream items',()=>{
 const upstream=inv('\0values',['C:/Users']);
 expect(strings(produced(inv('Get-Item',['C:/work/project'],upstream)))).toEqual(['C:/work/project','C:/Users']);
});
it('pass-through chains keep all literal objects without recursive traversal',()=>{
 let from=inv('\0values',['C:/Users']);
 for(let i=0;i<1000;i++)from=inv('Sort-Object',[],from);
 expect(strings(produced(from))).toEqual(['C:/Users']);
});
it('literal arrays retain all items beyond old four-item bounds',()=>{
 const from=inv('\0values',['build\0,dist\0,target\0,cache\0,C:/Users\0,output']);
 expect(produced(from)).toHaveLength(6);expect(strings(produced(from))).toContain('C:/Users');
});
it('unread options preserve the binding premise and exclude destination evidence',()=>{
 const effects=pwshEffects(inv('Move-Item',[opaque('unresolved-variable'),'C:/scratch/build','-Destination','C:/Users']));
 const uncertain=effects.find(effect=>effect.k==='uncertain-operands');
 expect(uncertain).toBeDefined();if(uncertain?.k==='uncertain-operands')expect(strings(uncertain.words)).not.toContain('C:/Users');
 expect(pwshEffects(inv('Remove-Item',['-c','value','-Recurse','~'])).some(effect=>effect.k==='delete'&&effect.target.k==='known'&&effect.target.s==='C:/Users/member')).toBe(true);
});
it('WhatIf false restores effects and non-pwsh rm remains with its own grammar',()=>{
 expect(pwshEffects(inv('ri',['-r','C:/Users','-WhatIf']))).toEqual([]);
 expect(pwshEffects(inv('ri',['-r','C:/Users','-WhatIf:$false']))).toHaveLength(1);
 expect(pwshEffects({...inv('rm',['-rf','/']),dialect:'sh'})).toEqual([]);
});
it('provider escapes survive the shared expansion API without becoming wildcards again',()=>{
 const effects=pwshEffects(inv('ri',['-Recurse',globValue('C:/Use`*','pwsh')]));
 expect(effects[0]).toMatchObject({k:'delete',target:{s:'C:/Use*'}});
 if(effects[0]?.k==='delete'&&effects[0].target.k==='known')expect(effects[0].target.glob).toBeUndefined();
});
it('LiteralPath restores a star collapsed by the shared expansion API',()=>{
 const sources=sourcesOf(inv('ri',['-LiteralPath',globValue('C:/Users/*','pwsh'),'-Recurse']));
 expect(strings(sources)).toEqual(['C:/Users/*']);expect(sources[0]).not.toHaveProperty('wholeDirGlob');
});
it('colon Path parameters retain their wildcard after the shared expansion API',()=>{
 expect(strings(sourcesOf(inv('ri',[globValue('-Path:C:/Users/*','pwsh'),'-Recurse'])))).toEqual(['C:/Users']);
});
it('producer cycles terminate without a second depth-based producer model',()=>{
 const from=inv('sort');from.pipedFrom=from;expect(produced(from)).toEqual([]);
});

// Review regressions: documented Select-Object and provider parameter semantics.
it.each([[['-Unique']],[['-ExpandProperty','PSPath']],[['-Unique','-Property','PSPath']]])('R1 Select-Object %j preserves a surviving project',args=>{
 const from=inv('Select-Object',args,inv('Get-Item',['C:/work/project']));
 expect(strings(sourcesOf(inv('Remove-Item',['-Recurse'],from)))).toEqual(['C:/work/project']);
});
it('M1 Get-ChildItem binds positional Filter without inventing another Path',()=>{
 const from=inv('Get-ChildItem',['C:/work/project','*.tmp']);
 const bound=bindParams(from);
 expect(strings(bound.values.get('path')!)).toEqual(['C:/work/project']);
 expect(strings(bound.values.get('filter')!)).toEqual(['*.tmp']);
 expect(produced(from)).toEqual([]);
 expect(produced(inv('gci',['-LiteralPath','C:/work/project','*.tmp']))).toEqual([]);
 expect(produced(inv('gci',['-Path','C:/work/project','*.tmp']))).toEqual([]);
});
it('M2 wi alias suppresses preview and explicit false restores deletion',()=>{
 expect(pwshEffects(inv('Remove-Item',['-Recurse','-wi','C:/work/project']))).toEqual([]);
 expect(pwshEffects(inv('Remove-Item',['-Recurse','-wi:$false','C:/work/project']))).toHaveLength(1);
});
it.each(['Convert-Path','Write-Output','\0values'])('M3 %s emits strings without a PSPath property',program=>{
 const from=inv(program,['C:/work/project']);
 expect(produced(inv('select',['PSPath'],from))).toEqual([]);
 expect(produced(inv('select',['-Property','*'],from))).toEqual([]);
 expect(produced(inv('select',['-ExpandProperty','PSPath'],from))).toEqual([]);
 expect(strings(produced(inv('select',['-Unique'],from)))).toEqual(['C:/work/project']);
});
it('R1 expanding PSPath produces strings, and a second PSPath selection has no target',()=>{
 const expanded=inv('select',['-ExpandProperty','PSPath'],inv('gi',['C:/work/project']));
 expect(strings(produced(expanded))).toEqual(['C:/work/project']);
 expect(produced(inv('select',['PSPath'],expanded))).toEqual([]);
});
it('M4 explicit-source work stays linear in the number of literal arguments',()=>{
 const args=Array.from({length:1000},(_,i)=>known('build'+i)), members=new Set(args);
 let visits=0;
 const iterator=Array.prototype[Symbol.iterator];
 Array.prototype[Symbol.iterator]=function*(){for(let i=0;i<this.length;i++){const v=this[i];if(members.has(v))visits++;yield v;}return undefined;};
 try {
  const argv=new Proxy(args,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))visits++;return Reflect.get(target,key,receiver);}});
  const values=sourcesOf({...inv('Remove-Item'),argv});
  expect(values).toHaveLength(args.length);
 } finally {Array.prototype[Symbol.iterator]=iterator;}
 expect(visits).toBeLessThan(20*args.length);
});

it('M4 indexing retains provider escapes on synthetic literal sources',()=>{
 const from=inv('\0values',['C:/Use*']);
 from.rawArgv=[{raw:'C:/Use`*',parts:[]}];
 const values=produced(from);
 expect(strings(values)).toEqual(['C:/Use*']);
 expect(values[0]).not.toHaveProperty('glob');
});

it('MAIN 1114-WIPE-REVIEW-BOUND literal home does not change a simultaneous Path home',()=>{
 expect(strings(sourcesOf(inv('ri',['-Path','~','-LiteralPath','~','-Recurse'])))).toEqual(['C:/Users/member','C:/scratch/~']);
});
it('MAIN 1114-WIPE-REVIEW-BOUND POSIX rm habit preserves uncertain recursion in the model',()=>{
 expect(pwshEffects(inv('rm',['-rf','/']))).toContainEqual(expect.objectContaining({k:'uncertain-operands'}));
 expect(pwshEffects(inv('rm',['-rf','/','-WhatIf']))).toEqual([]);
});
it.each(['-Directory','-File'])('MAIN 1114-WIPE-REVIEW-BOUND %s producer retains child objects',flag=>{
 // MAIN RULING 1114-WIPE-REVIEW-BOUND: file children cannot be protected directories; retain objects without inventing a root.
 const item=produced(inv('gci',['C:/Users',flag]))[0];
 if(flag==='-File')expect(item).toMatchObject({k:'opaque',why:'file-children'});
 else expect(item).toMatchObject({entryOf:{start:'C:/Users',rootSelf:false},wholeDirGlob:true,dirsOnly:true});
 expect(produced(inv('gci',['C:/Users',flag,'-Filter','*.tmp']))).toEqual([]);
});
// secret-scan: fixture (generic fixture home names only; no host data)
