// Independent C3 hazard preparation; archive integration is deliberately absent.
import { afterEach, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noLimitsDisk, type NoLimitsDisk } from './no-limits-fs.ts';
import { producerHazards, type ProducerOperand } from './no-limits-producer-hazards.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const cwd=mkdtempSync(join(tmpdir(),'nl-hazard-'));roots.push(cwd);mkdirSync(join(cwd,'home'));mkdirSync(join(cwd,'a'));mkdirSync(join(cwd,'data'));writeFileSync(join(cwd,'plain'),'fixture');return {cwd,home:join(cwd,'home')};}
const operand=(value:string,tree=false):ProducerOperand=>({id:'source',role:'source',value,tree});
it('D31 dotdot is Unknown while file..txt remains an independent ordinary name',()=>{
 const ctx=fixture();
 expect(producerHazards('op',[operand('./data/../data')],[],ctx)).toContainEqual(expect.objectContaining({cause:'dotdot-value',resolution:{kind:'unknown',cause:'dotdot-value',lexical:`${ctx.cwd}/data`}}));
 expect(producerHazards('op',[operand('./file..txt')],[],ctx)).toEqual([]);
});
it('POSIX literal backslashes are not parent components; Windows separators are',()=>{
 const ctx=fixture();
 expect(producerHazards('op',[operand('name\\..\\leaf')],[],ctx)).toEqual([]);
 expect(producerHazards('op',[operand('name\\..\\leaf')],[],{...ctx,cwd:'C:/work',windows:true,remote:true}).some(hit=>hit.cause==='dotdot-value')).toBe(true);
});
it('D31 dependencies are order independent, including absent targets, excluding own roots',()=>{
 const ctx=fixture(),roots=[{operationId:'other',path:'./future'}];
 expect(producerHazards('op',[operand('./future/notes')],roots,ctx)).toContainEqual(expect.objectContaining({cause:'producer-dependency',dependencyOperationIds:['other']}));
 expect(producerHazards('op',[operand('./future/notes')],[{operationId:'op',path:'./future'}],ctx)).toEqual([]);
 expect(producerHazards('op',[operand('./data')],[{operationId:'other',path:'./cur'}],ctx)).toEqual([]);
});
it('dependencies exposed through existing link text survive initial absence',()=>{
 const ctx=fixture();symlinkSync('./future',join(ctx.cwd,'cur'));
 expect(producerHazards('op',[operand('./cur')],[{operationId:'other',path:'./future'}],ctx).some(h=>h.cause==='producer-dependency')).toBe(true);
});
it('tree dependencies use actual affected roots rather than common parent prefixes',()=>{
 const ctx=fixture();
 expect(producerHazards('op',[operand('./a',true)],[{operationId:'other',path:'./a/future'}],ctx).some(h=>h.cause==='producer-dependency')).toBe(true);
 expect(producerHazards('op',[operand('./a',true)],[{operationId:'other',path:'./unrelated'}],ctx)).toEqual([]);
});
it('subtree aliases retain protected source evidence and ordinary RUN twin',()=>{
 const ctx=fixture();symlinkSync('/etc/hosts',join(ctx.cwd,'a/h'));
 const hazards=producerHazards('op',[operand('./a',true)],[],ctx);
 expect(hazards.some(h=>h.cause==='protected'&&h.decisions.some(d=>d.physical==='/etc/hosts'&&d.op==='alias-hazard'))).toBe(true);
 const ordinary=fixture();symlinkSync(join(ordinary.cwd,'plain'),join(ordinary.cwd,'a/h'));
 expect(producerHazards('op',[operand('./a',true)],[],ordinary)).toEqual([]);
});
it('relative dotdot link text is Unknown even when it currently points to an ordinary file',()=>{
 const ctx=fixture();symlinkSync('../plain',join(ctx.cwd,'a/h'));
 expect(producerHazards('op',[operand('./a',true)],[],ctx).some(h=>h.cause==='dotdot-value')).toBe(true);
});
it('unreadable tree entries preserve evidence and continue to protected siblings',()=>{
 const ctx=fixture();writeFileSync(join(ctx.cwd,'a/0-denied'),'fixture');symlinkSync('/etc/hosts',join(ctx.cwd,'a/h'));
 const disk:NoLimitsDisk={...noLimitsDisk,lstat:path=>{if(path.endsWith('/0-denied'))throw Object.assign(new Error('denied'),{code:'EACCES'});return noLimitsDisk.lstat(path);}};
 const hazards=producerHazards('op',[operand('./a',true)],[],{...ctx,disk});
 expect(hazards.some(h=>h.cause==='other-unknown')).toBe(true);
 expect(hazards.some(h=>h.cause==='protected'&&h.decisions.some(d=>d.physical==='/etc/hosts'))).toBe(true);
});
it('named protected inode source evidence remains lossless',()=>{
 const ctx=fixture();writeFileSync(join(ctx.home,'.zshrc'),'fixture');linkSync(join(ctx.home,'.zshrc'),join(ctx.cwd,'a/h'));
 expect(producerHazards('op',[operand('./a',true)],[],ctx).some(h=>h.decisions.some(d=>d.reason==='protected-inode'&&d.namedProtectedPath===`${ctx.home}/.zshrc`))).toBe(true);
});
it('ordinary multiply linked operands never enter the protected inode registry',()=>{
 const ctx=fixture();linkSync(join(ctx.cwd,'plain'),join(ctx.cwd,'a/ordinary'));
 expect(producerHazards('op',[operand('./plain'),operand('./a',true)],[],ctx)).toEqual([]);
});
it('bounded subtree dirents and depth are explicit Unknown causes',()=>{
 const ctx=fixture();const at=join(ctx.cwd,'a');
 const fake=(directory:boolean)=>({dev:1n,ino:2n,nlink:1n,isDirectory:()=>directory,isFile:()=>!directory,isSymbolicLink:()=>false});
 const wide:NoLimitsDisk={...noLimitsDisk,readdir:path=>path===at?Array.from({length:4097},(_,i)=>`f${i}`):[],lstat:path=>path.startsWith(at+'/')?fake(false):noLimitsDisk.lstat(path)};
 expect(producerHazards('op',[operand('./a',true)],[],{...ctx,disk:wide}).some(h=>h.detail==='subtree-overflow')).toBe(true);
 const deep:NoLimitsDisk={...noLimitsDisk,readdir:()=>['n'],lstat:path=>path.startsWith(at+'/')?fake(true):noLimitsDisk.lstat(path)};
 expect(producerHazards('op',[operand('./a',true)],[],{...ctx,disk:deep}).some(h=>h.detail==='subtree-overflow')).toBe(true);
});
it('unknown producer operands taint, opaque archive contents and remote disk do not invent hazards',()=>{
 const ctx=fixture();writeFileSync(join(ctx.cwd,'plain.tar'),'opaque fixture');
 expect(producerHazards('op',[{id:'value',role:'target',unknownCause:'dynamic-producer-value'}],[],ctx).some(h=>h.cause==='unknown-expansion')).toBe(true);
 expect(producerHazards('op',[operand('./plain.tar')],[],ctx)).toEqual([]);
 let probes=0;const fail=()=>{probes++;throw new Error('host probe');};const disk:NoLimitsDisk={lstat:fail,stat:fail,readlink:fail,readdir:fail};
 expect(producerHazards('op',[operand('./plain')],[],{...ctx,disk,remote:true})).toEqual([]);expect(probes).toBe(0);
});
