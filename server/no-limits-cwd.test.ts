// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedCwds, initialCwds, parseCdOptions, transitionCwd, unknownCwdSuffixDecisions } from './no-limits-cwd.ts';
import { inspectNativeEffects, type CwdCandidate, type NativeEffect } from './no-limits-fs.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const effect = (path: string): NativeEffect => ({ op: 'write', path, followFinal: true });
function fixture(safe = false) {
 const cwd=mkdtempSync(join(tmpdir(),'nl-cwd-'));roots.push(cwd);
 mkdirSync(join(cwd,'safe/deep'),{recursive:true});symlinkSync(safe?join(cwd,'safe/deep'):'/etc/ssl',join(cwd,'e'));
 return {cwd,home:cwd};
}
function holds(path:string,candidates:readonly CwdCandidate[],context:ReturnType<typeof fixture>):boolean {
 return candidates.some(candidate=>inspectNativeEffects([effect(path)],{...context,cwd:candidate.logical??candidate.physical}).verdict==='hold')||unknownCwdSuffixDecisions(effect(path),candidates,context).length>0;
}
describe('C2a C33 cwd pairs and suffix boundaries',()=>{
 it('parses physical/logical/e/@/-- options before the directory operand',()=>{
  expect(parseCdOptions(['-Pe','--','e'])).toMatchObject({mode:'physical',requirePhysical:true,operand:'e'});
  expect(parseCdOptions(['-P','-L','e'])).toMatchObject({mode:'logical',operand:'e'});
  expect(parseCdOptions(['-L','-P','-@','e'])).toMatchObject({mode:'physical',alternate:true,operand:'e'});
  expect(parseCdOptions(['--','-P'])).toMatchObject({mode:'logical',operand:'-P'});
 });
 it('C33a physical -P HOLD and && logical -L RUN; ordinary physical twin RUN',()=>{
  for(const safe of [false,true]){
   const ctx=fixture(safe),initial=initialCwds(ctx);
   const physical=transitionCwd(initial,'cd',['-P','e'],ctx).success;
   expect(physical[0]).toMatchObject({logical:safe?`${ctx.cwd}/safe/deep`:'/etc/ssl',physical:safe?`${ctx.cwd}/safe/deep`:'/etc/ssl'});
   const after=transitionCwd(physical,'cd',['..'],ctx).success;
   expect(holds('hosts',after,ctx)).toBe(!safe);
   const logical=transitionCwd(initial,'cd',['-L','e'],ctx).success;
   expect(logical[0]).toMatchObject({logical:`${ctx.cwd}/e`,physical:safe?`${ctx.cwd}/safe/deep`:'/etc/ssl'});
   expect(holds('hosts',transitionCwd(logical,'cd',['..'],ctx).success,ctx)).toBe(false);
  }
 });
 it('resolves e/.. physically and retains weak failure branches across ;',()=>{
  const ctx=fixture(),initial=initialCwds(ctx);
  const physical=transitionCwd(initial,'cd',['-P','e/..'],ctx);
  expect(physical.success[0]).toMatchObject({logical:'/etc',physical:'/etc'});
  expect(physical.all).toContainEqual(expect.objectContaining({logical:ctx.cwd}));
  const logical=transitionCwd(initial,'cd',['-L','e'],ctx);
  const after=transitionCwd(logical.all,'cd',['..'],ctx);
  expect(after.all.some(candidate=>candidate.physical==='/etc/ssl')).toBe(true);
 });
 it('C33b/c known expanded directory values and options retain physical resolution',()=>{
  const ctx=fixture(),initial=initialCwds(ctx);
  for(const flags of [['-P'],['-Pe'],['-P','-e'],['-e','-P']]){
   const next=transitionCwd(initial,'cd',[...flags,'$d'],ctx,[{value:'./e'}]).success;
   expect(next[0]).toMatchObject({logical:'/etc/ssl',physical:'/etc/ssl'});
   expect(holds('hosts',transitionCwd(next,'cd',['..'],ctx).success,ctx)).toBe(true);
  }
 });
 it('C33d OLDPWD and directory stack restore logical/physical pairs',()=>{
  for(const safe of [false,true]){
   const ctx=fixture(safe),initial=initialCwds(ctx);
   const moved=transitionCwd(initial,'cd',['-P','e'],ctx).success;
   const returned=transitionCwd(moved,'cd',['-'],ctx).success;
   expect(returned[0]).toMatchObject({logical:ctx.cwd,physical:ctx.cwd});
   const again=transitionCwd(returned,'cd',['-'],ctx).success;
   expect(holds('hosts',transitionCwd(again,'cd',['..'],ctx).success,ctx)).toBe(!safe);
   const pushed=transitionCwd(moved,'pushd',[ctx.cwd],ctx).success;
   const popped=transitionCwd(pushed,'popd',[],ctx).success;
   expect(popped[0]).toMatchObject({logical:safe?`${ctx.cwd}/safe/deep`:'/etc/ssl',physical:safe?`${ctx.cwd}/safe/deep`:'/etc/ssl'});
   expect(holds('hosts',transitionCwd(popped,'cd',['..'],ctx).success,ctx)).toBe(!safe);
  }
 });
 it('unknown cd and alternate-directory semantics do not blanket-hold ordinary suffixes',()=>{
  const ctx=fixture();
  for(const unknown of [transitionCwd(initialCwds(ctx),'cd',['$d'],ctx,[{}]).success,transitionCwd(initialCwds(ctx),'cd',['-@','e'],ctx).success]){
   expect(unknown[0]!.unknownCause).toBeTruthy();
   for(const path of ['hosts','.zshrc','.ssh/config','$prefix/hosts'])expect(unknownCwdSuffixDecisions(effect(path),unknown,ctx).length).toBeGreaterThan(0);
   for(const path of ['notes','file..txt','hosts-copy','.ssh-copy/config','.zshrc-copy'])expect(unknownCwdSuffixDecisions(effect(path),unknown,ctx)).toEqual([]);
   const evidence=unknownCwdSuffixDecisions(effect('hosts'),unknown,ctx)[0]!;
   expect(evidence).toMatchObject({reason:'unknown-cwd-protected-suffix',resolution:{kind:'unknown'},matchedProtectedSuffix:'hosts'});
   expect(evidence.physical).toBeUndefined();
  }
 });
 it('C33g candidate overflow keeps suffix evidence and fixed known prefixes',()=>{
  const ctx=fixture();
  const candidates=boundedCwds(Array.from({length:30},(_,i)=>({logical:`${ctx.cwd}/d${i}`,physical:`${ctx.cwd}/d${i}`,stack:[]})));
  expect(candidates).toHaveLength(16);
  expect(candidates.at(-1)).toMatchObject({unknownCause:'cwd-candidate-overflow',fixedPrefixes:expect.arrayContaining([`${ctx.cwd}/d29`])});
  expect(unknownCwdSuffixDecisions(effect('hosts'),candidates,ctx).length).toBeGreaterThan(0);
  expect(unknownCwdSuffixDecisions(effect('notes'),candidates,ctx)).toEqual([]);
 });
 it('cwd through a collected producer destination retains Unknown before initial absence',()=>{
  const ctx=fixture(),initial=initialCwds(ctx);
  const next=transitionCwd(initial,'cd',['./future'],{...ctx,cwdDependencyRoots:[`${ctx.cwd}/future`]}).success;
  expect(next).toContainEqual(expect.objectContaining({unknownCause:'producer-dependency-cwd'}));
  expect(unknownCwdSuffixDecisions(effect('hosts'),next,ctx).length).toBeGreaterThan(0);
  expect(unknownCwdSuffixDecisions(effect('notes'),next,ctx)).toEqual([]);
 });
 it('directory stacks are bounded while preserving the current paired location',()=>{
  const ctx=fixture(),initial=initialCwds(ctx);
  let state=initial;
  for(let i=0;i<40;i++)state=transitionCwd(state,'pushd',[ctx.cwd],ctx).success;
  expect(state[0]!.stack).toHaveLength(32);expect(state[0]!.stackUnknown).toBe(true);
  expect(state[0]).toMatchObject({logical:ctx.cwd,physical:ctx.cwd});
 });
 it('native unknown cwd uses the identical structured suffix projection',()=>{
  expect(inspectNativeEffects([effect('hosts')],{}).decisions).toContainEqual(expect.objectContaining({reason:'unknown-cwd-protected-suffix'}));
  expect(inspectNativeEffects([effect('notes')],{}).verdict).toBe('run');
 });
 it('shared wildcard leaves use whole components and Windows case policy',()=>{
  const ctx=fixture(),unknown=[{stack:[],unknownCause:'fixture'}];
  expect(unknownCwdSuffixDecisions(effect('.claude/settings.local.json'),unknown,ctx).length).toBeGreaterThan(0);
  expect(unknownCwdSuffixDecisions(effect('provider-keys.fixture'),unknown,ctx).length).toBeGreaterThan(0);
  expect(unknownCwdSuffixDecisions(effect('.claude/settings.local.json-copy'),unknown,ctx)).toEqual([]);
  expect(unknownCwdSuffixDecisions(effect('HOSTS'),unknown,{...ctx,windows:true}).length).toBeGreaterThan(0);
  expect(unknownCwdSuffixDecisions(effect('HoStS-copy'),unknown,ctx)).toEqual([]);
 });
 it('known missing cd has only failure candidates; CDPATH retains unknown success',()=>{
  const ctx=fixture(),initial=initialCwds(ctx);
  const missing=transitionCwd(initial,'cd',['./missing'],ctx);
  expect(missing.success).toEqual([]);expect(missing.all).toEqual(initial);
  expect(transitionCwd(initial,'cd',['safe'],{...ctx,runtimePaths:{CDPATH:'/elsewhere'}}).success.some(candidate=>candidate.unknownCause==='cdpath-dependent')).toBe(true);
 });
});

describe('C2a real C1 collection hook annotations',()=>{
 async function evidence(command:string,context:ReturnType<typeof fixture>){
  const {collectNoLimits}=await import('./no-limits-collect.ts');
  const {ownerCwdHooks}=await import('./no-limits-cwd.ts');
  const envelope=collectNoLimits<readonly CwdCandidate[]>(command,{cwd:context.cwd,hooks:ownerCwdHooks(context)});
  const judgments=envelope.writes.flatMap(write=>write.locations.flatMap(location=>location.candidates.flatMap(candidate=>{
   const candidates=location.ownerCwd??[];
   const roots=candidates.flatMap(cwd=>[cwd.logical??cwd.physical,...(cwd.fixedPrefixes??[])].filter((path):path is string=>path!==undefined));
   return [...roots.flatMap(cwd=>inspectNativeEffects([effect(candidate.path)],{...context,cwd}).decisions),...unknownCwdSuffixDecisions(effect(candidate.path),candidates,context)];
  })));
  return {envelope,judgments};
 }
 it('real once-only hooks preserve physical HOLD, logical && RUN, and expanded cwd values',async()=>{
  const ctx=fixture();
  for(const command of ['cd -P e; cd ..; printf x > hosts','d=./e; cd -Pe -- "$d" && cd .. && printf x > hosts']){
   const result=await evidence(command,ctx);expect(result.judgments.some(decision=>decision.physical==='/etc/hosts')).toBe(true);
  }
  expect((await evidence('cd -L e && cd .. && printf x > hosts',ctx)).judgments).toEqual([]);
 });
 it('retains literal quoted tilde directory operands through the real hook',async()=>{
  const ctx=fixture();mkdirSync(join(ctx.cwd,'~/e'),{recursive:true});
  expect((await evidence("cd -P '~/e' && cd .. && printf x > hosts",ctx)).judgments).toEqual([]);
  expect((await evidence('cd -P ~/e && cd .. && printf x > hosts',ctx)).judgments.some(decision=>decision.physical==='/etc/hosts')).toBe(true);
 });
 it('expands called-function directory operands from the call scope',async()=>{
  for(const safe of [false,true]){
   const ctx=fixture(safe);
   const result=await evidence('f(){ cd -P "$dir"; }; dir=./e; f; printf x > notes',ctx);
   if(safe)expect(result.judgments).toEqual([]);
   else expect(result.judgments.some(decision=>decision.physical==='/etc/ssl/notes')).toBe(true);
  }
 });
 it('restores failure alternatives at a ; boundary following an && list',async()=>{
  const ctx=fixture();
  const result=await evidence(`cd '${ctx.cwd}' && true; printf x > hosts`,{...ctx,cwd:'/etc'});
  expect(result.judgments.some(decision=>decision.physical==='/etc/hosts')).toBe(true);
  expect((await evidence('cd safe && true; printf x > notes',ctx)).judgments).toEqual([]);
 });
 it('subshell and substitution cwd are isolated, called functions can change caller cwd',async()=>{
  const ctx=fixture();
  expect((await evidence('(cd -P e); printf x > notes',ctx)).judgments).toEqual([]);
  expect((await evidence('printf "%s" "$(cd -P e)" > notes',ctx)).judgments).toEqual([]);
  const changed=await evidence('f(){ cd -P e; }; f; cd ..; printf x > hosts',ctx);
  expect(changed.judgments.some(decision=>decision.physical==='/etc/hosts')).toBe(true);
  expect((await evidence('f(){ cd -L e && cd .. && printf x > hosts; }; f',ctx)).judgments).toEqual([]);
 });
 it('unknown cwd preserves suffix evidence while ordinary names RUN through collection',async()=>{
  const ctx=fixture();
  const red=await evidence('cd "$(opaque-dir)"; printf x > hosts',ctx);
  expect(red.judgments.some(decision=>decision.reason==='unknown-cwd-protected-suffix')).toBe(true);
  for(const name of ['notes','file..txt','hosts-copy'])expect((await evidence(`cd "$(opaque-dir)"; printf x > ${name}`,ctx)).judgments).toEqual([]);
 });
});
