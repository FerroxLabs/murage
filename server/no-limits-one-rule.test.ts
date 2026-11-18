import {fixture,d,baseCard,baseRun} from './decision/fixture.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, finalizeNoLimits, type AutoContext } from './auto-approve.ts';
import { finalDecision, cutRead } from '../shared/no-limits-decision.ts';
import { Store } from './store.ts';
import { permissionLevel } from './thread-permissions-refresh.ts';

const level = {autoApprove:true,fullAccess:true,noLimits:true};
const engines = ['claude','codex','fuigo','flux','gemini'] as const;
const commands = ["ssh host 'cmd'", 'cd some/dir && ls', 'git commit -am x && git push origin HEAD && rm -f /tmp/x.tmp'];
const owner: AutoContext = {fullAccessOrigin:'owner',ownerStarted:true,workFolder:'/tmp',commandCwd:'/tmp'};
describe('ONE RULE field report items 1–3', () => {
 for (const engine of engines) for (const origin of ['owner','routine'] as const) {
  for (const command of commands) it(`${engine} ${origin}: ${command}`, () => {
   const context: AutoContext = {...owner, fullAccessOrigin:origin, ...(origin==='routine'?{ownerStarted:false,routineLevel:true,automated:true}:{}), outsideRead:['web page'], commandText:command, call:{engine:engine === "claude" || engine === "codex" ? engine : "acp",toolCall:{name:'Bash',input:{command}}}};
   // MAIN RULING NARROW-WIPE 2026-11-14: ordinary single-file cleanup runs alongside Git/SSH commands.
   const result=autoVerdict(level,'Bash',command,context);expect(result.approve).not.toBeNull();
  });
  it(`${engine} ${origin}: unreadable runs, detected wipe still cards`, () => {
   const context: AutoContext = {...owner,fullAccessOrigin:origin,...(origin==='routine'?{routineLevel:true,automated:true,ownerStarted:false}:{}),inputTruncated:true,call:{engine:engine === "claude" || engine === "codex" ? engine : "acp"}};
   expect(autoVerdict(level,'Bash','unreadable',context).approve).not.toBeNull();
   expect(autoVerdict(level,'Bash','rm -rf ~',{...context,commandText:'rm -rf ~'})).toMatchObject({approve:null,rule:'delete-home'});
  });
 }
 it('only wipe evidence holds; stored denies, generic mandatory and classification run', () => {
  for (const source of ['unread-call','sensitive-guard','outside-turn','stop-line','unattended-block','local-computer-block','always-ask'] as const) {
   expect(finalizeNoLimits(level,'Bash','printf ok',owner,{approve:null,source,classification:'deny'},[cutRead('parser')]).approve,source).not.toBeNull();
  }
  // Legacy parser metadata cannot forge registered execution authority.
  expect(finalDecision(level,{kind:'owner'},{tool:'Bash',base:{verdict:'run',cls:'',approve:'claimed'}}).verdict).toBe('card');
  const f=fixture();
  try {
   expect(d.decide(f.open('non-wipe',{command:'printf ok'}),baseCard).kind).toBe('run');
   expect(d.decide(f.open('cut',{}, {toolInputTruncated:true}),baseCard).kind).toBe('run');
   f.deny([{kind:'deny',class:'stored',ruleId:'owner-rule-7',span:'fixture'}]);
   expect(d.decide(f.open('switch',{command:'printf fixture'}),baseRun).kind).toBe('run');
   expect(d.decide(f.open('stored-owner-deny',{command:'printf ok'}),baseRun).kind).toBe('run');
   expect(d.openApprovals('t')).toHaveLength(0);
   expect(d.decide(f.open('wipe',{command:'rm -rf ~'},{toolInputTruncated:true}),baseRun).kind).toBe('card');
   expect(d.decide(f.open('actual-wipe',{command:'rm -rf ~'}),baseRun).kind).toBe('card');
  }finally{f.dispose();}
 });
 it('birth uses the owner default in both bot and first conversation on every engine', () => {
  const store = new Store(undefined, undefined, false, () => level);
  for (const engine of engines) {
   const bot=store.createBot({name:`field-${engine}`,modelSelection:{instanceId:engine,model:'fixture'}},{seedMessages:false});
   expect(permissionLevel(bot)).toBe('no-limits');
   expect(permissionLevel(store.taskByThread(bot.id,bot.threadId)!)).toBe('no-limits');
  }
 });
 it('the next call reads a changed bot level in all existing owner conversations', () => {
  const store=new Store(); const bot=store.createBot({}, {seedMessages:false});
  const threads=[bot.threadId,store.createTask(bot.id,'second',false)!.threadId];
  store.setPermissionLevel(bot.id,{flags:level});
  for(const thread of threads) expect(permissionLevel(store.projectBotForTask(bot.id,thread)!)).toBe('no-limits');
 });
});
