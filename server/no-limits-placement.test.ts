// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex, literalText, type Word } from './shell/lex.ts';
import { newContext, simpleCommand } from './shell/walk.ts';
import { effectiveDestinations } from './no-limits-placement.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(protectedChild=false){
 const cwd=mkdtempSync(join(tmpdir(),'nl-place-'));roots.push(cwd);
 for(const dir of ['d/src','src','home','safe'])mkdirSync(join(cwd,dir),{recursive:true});
 for(const file of ['blob','plain','src/blob','src/plain'])writeFileSync(join(cwd,file),'fixture');
 symlinkSync(protectedChild?'/etc/hosts':join(cwd,'plain'),join(cwd,'d/blob'));
 symlinkSync(protectedChild?'/etc/hosts':join(cwd,'plain'),join(cwd,'d/src/blob'));
 return {cwd,home:join(cwd,'home')};
}
function placed(text:string,ctx:ReturnType<typeof fixture>){
 const words=lex(text).filter(token=>token.kind==='word').map(token=>(token as {kind:'word';word:Word}).word);
 const walk=newContext(ctx.cwd);
 return effectiveDestinations(simpleCommand(literalText(words[0]!)!,words.slice(1),walk),ctx,walk)!;
}
describe('C2b E32 effective destinations independently of taint',()=>{
 it.each(['cp','mv','install','ln','rsync'])('observes existing directory child for %s and ordinary replacement twin',program=>{
  for(const safe of [false,true]){
   const ctx=fixture(!safe),result=placed(`${program} blob d`,ctx);
   const child=result.destinations.find(item=>item.path==='d/blob')!;
   expect(child).toBeDefined();expect(child.decisions.some(decision=>decision.reason==='effective-destination')).toBe(!safe);
   if(program==='cp')expect(child).toMatchObject({semantics:'write-through',followFinal:true});
   else expect(child).toMatchObject({semantics:'replace-entry',followFinal:false});
   if(safe)expect(child.decisions).toEqual([]);
   else expect(child.decisions.find(decision=>decision.reason==='effective-destination')).toMatchObject({observedDestinationResolution:{kind:'known',physical:'/etc/hosts'},destinationPlacement:{sourceOperandId:'source:0',child:'d/blob'}});
  }
 });
 it.each(['cp','mv','install','ln'])('honors every GNU target-directory form and last source for %s',program=>{
  const ctx=fixture(true);symlinkSync('/etc/hosts',join(ctx.cwd,'d/plain'));
  for(const option of ['-t d','-td','--target-directory=d','--target-directory d']){
   const result=placed(`${program} ${option} blob plain`,ctx);
   expect(result.destinations.map(item=>item.path)).toEqual(['d/blob','d/plain']);
   expect(result.destinations[1]!.decisions.some(decision=>decision.reason==='effective-destination')).toBe(true);
  }
 });
 it('retains directory/slash/multiple-source placement and -T named-entry semantics',()=>{
  const ctx=fixture(true);
  expect(placed('cp blob d/',ctx).destinations[0]!.path).toBe('d/blob');
  expect(placed('cp blob plain d',ctx).destinations.map(item=>item.path)).toEqual(['d/blob','d/plain']);
  expect(placed('cp -T blob d',ctx).destinations.map(item=>item.path)).toEqual(['d']);
  symlinkSync('/etc/hosts',join(ctx.cwd,'entry'));
  expect(placed('mv -T blob entry',ctx).destinations[0]).toMatchObject({followFinal:false,decisions:[]});
  expect(placed('cp -T blob entry',ctx).destinations[0]!.decisions.some(decision=>decision.reason==='direct-path')).toBe(true);
 });
 it('replacement preflight holds protected child without pretending to write its inode',()=>{
  const ctx=fixture();writeFileSync(join(ctx.home,'.zshrc'),'fixture');
  unlinkSync(join(ctx.cwd,'d/blob'));linkSync(join(ctx.home,'.zshrc'),join(ctx.cwd,'d/blob'));
  const copy=placed('cp blob d',ctx).destinations[0]!;
  expect(copy.decisions.some(decision=>decision.reason==='protected-inode')).toBe(true);
  for(const command of ['mv blob d','install blob d','ln -sf blob d','cp --remove-destination blob d','rsync blob d/']){
   const replacement=placed(command,ctx).destinations[0]!;
   expect(replacement.followFinal).toBe(false);
   expect(replacement.decisions.some(decision=>decision.reason==='protected-inode')).toBe(false);
  }
 });
 it('distinguishes ln -n entry replacement from following a directory symlink',()=>{
  const ctx=fixture(true);symlinkSync('d',join(ctx.cwd,'linkdir'));
  expect(placed('ln -sf blob linkdir',ctx).destinations[0]!.path).toBe('linkdir/blob');
  expect(placed('ln -snf blob linkdir',ctx).destinations[0]).toMatchObject({path:'linkdir',followFinal:false,decisions:[]});
  expect(placed('ln -snf -t linkdir blob',ctx).destinations[0]!.path).toBe('linkdir/blob');
 });
 it('rsync contents/named directory/inplace/time options keep their own placement',()=>{
  const ctx=fixture(true);
  const contents=placed('rsync -rt src/ d/',ctx);
  expect(contents.destinations.map(item=>item.path)).toContain('d/blob');
  expect(contents.destinations.map(item=>item.path)).not.toContain('d/src');
  expect(contents.destinations.find(item=>item.path==='d/blob')).toMatchObject({followFinal:false,decisions:expect.arrayContaining([expect.objectContaining({reason:'effective-destination'})])});
  const named=placed('rsync -r src d/',ctx);
  expect(named.destinations.map(item=>item.path)).toContain('d/src/blob');
  expect(named.destinations.find(item=>item.path==='d/src/blob')!.decisions.some(decision=>decision.reason==='effective-destination')).toBe(true);
  expect(placed('rsync -r --inplace src/ d/',ctx).destinations.find(item=>item.path==='d/blob')!.followFinal).toBe(true);
  expect(placed('rsync -rt src/ safe/',ctx).destinations.every(item=>item.decisions.length===0)).toBe(true);
 });
 it('rsync --relative and /./ cut-point retain nested effective names',()=>{
  const ctx=fixture();mkdirSync(join(ctx.cwd,'one/src'),{recursive:true});writeFileSync(join(ctx.cwd,'one/src/f'),'fixture');
  const names=placed('rsync -r --relative one/./src d/',ctx).destinations.map(item=>item.path);
  expect(names).toContain('d/src');expect(names).toContain('d/src/f');expect(names).not.toContain('d/one/src');
 });
 it('install -d and mode/owner values are never treated as copy sources',()=>{
  const ctx=fixture();
  expect(placed('install -d -m 0700 -o fixture d safe',ctx).destinations.map(item=>item.path)).toEqual(['d','safe']);
  expect(placed('install -m 0600 -o fixture -g fixture blob d',ctx).destinations.map(item=>item.path)).toEqual(['d/blob']);
 });
 it('implicit ln destination, -- operands, source trailing slash retain basenames',()=>{
  const ctx=fixture();
  expect(placed('ln blob',ctx).destinations[0]!.path).toBe('./blob');
  expect(placed('cp -- blob d',ctx).destinations[0]!.path).toBe('d/blob');
  expect(placed('mv src/ d',ctx).destinations[0]!.path).toBe('d/src');
 });
 it('keeps original protected directory evidence when a source basename is unknown',()=>{
  const ctx=fixture();
  expect(placed('cp "$source" /etc',ctx).decisions).toContainEqual(expect.objectContaining({reason:'direct-path',lexical:'/etc'}));
  expect(placed('cp "$source" d',ctx).decisions).toEqual([]);
 });
 it('cp link and preserved-symlink modes create entries with ordinary replacement twins',()=>{
  const ctx=fixture();symlinkSync('plain',join(ctx.cwd,'h'));
  for(const command of ['cp -s blob d','cp -l blob d','cp -a h d']){
   const result=placed(command,ctx);expect(result.destinations[0]!.followFinal).toBe(false);expect(result.decisions).toEqual([]);
  }
 });
 it('retains quoted tilde as a literal directory, alongside the expanded home twin',()=>{
  const ctx=fixture();mkdirSync(join(ctx.cwd,'~/d'),{recursive:true});mkdirSync(join(ctx.home,'d'));
  symlinkSync('/etc/hosts',join(ctx.home,'d/blob'));
  const literal=placed("cp blob '~/d'",ctx);
  expect(literal.destinations[0]!.observed).toMatchObject({kind:'known',physical:`${ctx.cwd}/~/d/blob`});
  expect(literal.decisions).toEqual([]);
  const walk=newContext(ctx.cwd);walk.bound.set('dest',[{parts:[{kind:'lit',text:'~/d',quote:'single'}]}]);
  const args=lex('blob "$dest"').filter(token=>token.kind==='word').map(token=>(token as {kind:'word';word:Word}).word);
  const expanded=effectiveDestinations(simpleCommand('cp',args,walk),ctx,walk)!;
  expect(expanded.destinations[0]!.observed).toMatchObject({kind:'known',physical:`${ctx.cwd}/~/d/blob`});
  expect(placed('cp blob ~/d',ctx).decisions.some(decision=>decision.reason==='effective-destination')).toBe(true);
 });
 it('uses each call location expansion instead of a command definition snapshot',()=>{
  const ctx=fixture();symlinkSync('/etc/hosts',join(ctx.cwd,'d/plain'));
  const definition=newContext(ctx.cwd),call=newContext(ctx.cwd);
  definition.bound.set('source',[{parts:[{kind:'lit',text:'blob',quote:'single'}]}]);
  call.bound.set('source',[{parts:[{kind:'lit',text:'plain',quote:'single'}]}]);
  const args=lex('"$source" d').filter(token=>token.kind==='word').map(token=>(token as {kind:'word';word:Word}).word);
  const command=simpleCommand('cp',args,definition);
  const result=effectiveDestinations(command,ctx,call)!;
  expect(result.destinations.map(item=>item.path)).toEqual(['d/plain']);
  expect(result.decisions.some(decision=>decision.reason==='effective-destination')).toBe(true);
 });
 it('fresh placement observation catches a child rebound after inspection',()=>{
  const ctx=fixture();expect(placed('cp blob d',ctx).destinations[0]!.decisions).toEqual([]);
  unlinkSync(join(ctx.cwd,'d/blob'));symlinkSync('/etc/hosts',join(ctx.cwd,'d/blob'));
  expect(placed('cp blob d',ctx).destinations[0]!.decisions.some(decision=>decision.reason==='effective-destination')).toBe(true);
 });
 it('a glob-shaped variable does not invent known child writes after --',()=>{
  const ctx=fixture();writeFileSync(join(ctx.cwd,'*'),'fixture');writeFileSync(join(ctx.cwd,'h'),'fixture');
  symlinkSync('/etc/hosts',join(ctx.cwd,'d/h'));
  const walk=newContext(ctx.cwd);walk.bound.set('source',[{parts:[{kind:'glob',text:'*'}]}]);
  const args=lex('-- "$source" d').filter(token=>token.kind==='word').map(token=>(token as {kind:'word';word:Word}).word);
  const result=effectiveDestinations(simpleCommand('cp',args,walk),ctx,walk)!;
  expect(result.unknown).toBe(true);expect(result.decisions).toEqual([]);
  expect(result.destinations.map(value=>value.path)).not.toContain('d/h');
 });
});
