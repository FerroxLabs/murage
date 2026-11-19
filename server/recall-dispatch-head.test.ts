// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (server-only preparation facts); consumer owner: recall-smoke (engine request seam).
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { assertRecallDispatch } from './memory/recall-readiness.ts';

// Execute the shipped guard, stripping and confirmed-write wrapper at its engine seam.
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const signature='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
const from=source.indexOf(signature)+signature.length;
const head=source.slice(from,source.indexOf('  homeExecutionGate?.requireOpen();',from));
const dispatch=new Function('built','assertRecallDispatch','console','provider',ts.transpileModule(head+';return provider(built);',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText);
for(const shape of ['ordinary','prewarm','resumed','project-card'] as const)it(`S1-T11/GUARD-6: ${shape} sends its prepared fields and counts only a confirmed ordinary turn`,()=>{
 const logs:string[]=[],requests:any[]=[];
 const input={threadId:'fixture-thread',system:'Fixture persona',integrations:{},transcript:[],prewarm:shape==='prewarm',recall:'off',
  recallPrepared:{system:'Fixture persona',integrations:[],historyPrepared:shape==='resumed',resumed:shape==='resumed'},
  ...(shape==='project-card'?{background:true}:{}),onEngineWrite:()=>{}};
 const send=(value:any)=>{requests.push(value);value.onEngineWrite();value.onEngineWrite();return 'fixture-provider-turn';};
 expect(dispatch(input,assertRecallDispatch,{info:(line:string)=>logs.push(line)},send)).toBe('fixture-provider-turn');
 expect(requests).toHaveLength(1);expect(requests[0].system).toBe('Fixture persona');expect(requests[0].integrations).toEqual({});expect(requests[0].transcript).toEqual([]);
 expect(requests[0]).not.toHaveProperty('recall');expect(requests[0]).not.toHaveProperty('recallPrepared');
 expect(logs).toHaveLength(shape==='prewarm'?0:1);
});
it('GUARD-6: a late refusal has no confirmed dispatch line and no provider write',()=>{
 const logs:string[]=[],requests:any[]=[];
 const input={threadId:'fixture-thread',system:'Fixture persona',integrations:{agents:{}},recall:'full',recallPrepared:{system:'Fixture persona',integrations:['agents'],historyPrepared:false,resumed:false},beforeSubmit:()=>{throw Error('fixture late refusal');}};
 expect(()=>dispatch(input,assertRecallDispatch,{info:(line:string)=>logs.push(line)},(value:any)=>{value.beforeSubmit();requests.push(value);value.onEngineWrite();})).toThrow('fixture late refusal');
 expect(requests).toEqual([]);expect(logs).toEqual([]);
});
