// SPDX-License-Identifier: AGPL-3.0-or-later
// Each mutant restores a reviewed defect; only a failed assertion counts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path='server/index.ts', original=readFileSync(path,'utf8');
const dir='evidence/afix-bld-nolim-s4/mutants';mkdirSync(dir,{recursive:true});
const mutations=[
 ['review5-first-event','before the first activity',
  "if (bot) decisionBotLevels.get(bot.id)?.turns.set(provenance.generation, botPermissionMode(store.projectBotForTask(bot.id, provenance.threadId) ?? bot));",
  "void bot;"],
 ['review2-send', 'registered question continuation admission',
  "if ((card as Partial<PermissionCard>).approvalId) transaction(admit);", "if ((card as Partial<PermissionCard>).approvalId) { /* lost admission */ }"],
 ['review3-capture','queued routine ancestry',
  "const sourceInitiator = (parent as DecisionRoutinePeerSource | undefined)?.decisionRoutineSource;",
  "const sourceInitiator = decisionProvenance.get(turnGenerationFor(sourceThreadId))?.initiator;"],
 ['review3-forward','shared turn forwards',
  "...(peer ? { routineAuthority: peer.routineAuthority ?? queuedCeiling, ...(peer.decisionRoutineSource ? { decisionRoutineSource: peer.decisionRoutineSource } : {}) } : {}),",
  "...(peer ? { routineAuthority: peer.routineAuthority ?? queuedCeiling } : {}),"],
 ['review3-durable','shared routine reads durable',
  "const capturedRoutine = captured?.actor === 'owner-routine' && 'sourceRunId' in captured.initiator ? captured.initiator : undefined;",
  "const capturedRoutine = undefined;"],
 ['review3-release','shared source is saved before generation release',
  "await Promise.allSettled([...decisionSharedSaves.values()].filter(save => save.generation === generation).map(save => save.done));",
  "await Promise.resolve();"],
 ['review4-skill','Skill Allow fails',
  "(answer.behavior === 'allow' || result.error !== 'no such staged skill')", "result.error !== 'no such staged skill'"],
 ['review5-history','ordinary activity never walks',
  "return { level: botPermissionMode(bot), turns };", "JSON.stringify((bot.tasks ?? []).map(task => [task.threadId, botPermissionMode(task)])); return { level: botPermissionMode(bot), turns };"],
 ['review5-churn','generation churn never trigger',
  "if (before.level !== after.level) return true;", "if (before.level !== after.level || before.turns.size !== after.turns.size) return true;"],
];
const results=[];
try {
 for(const [id,test,from,to] of mutations){
  if(!original.includes(from))throw Error('Missing mutation anchor '+id);
  writeFileSync(path,original.replace(from,to));
  const args=['node_modules/vitest/vitest.mjs','run','server/decision-wiring/review-regressions.test.ts','--maxWorkers=1','-t',test];
  const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  const output=(run.stdout??'')+(run.stderr??'');
  const killed=run.status===1&&/AssertionError:/.test(output);
  const command=[process.execPath,...args].join(' ');
  writeFileSync(`${dir}/${id}.log`,`${command}\n${JSON.stringify({from,to})}\nEXIT ${run.status}\n${output}`);
  results.push({id,killed,exit:run.status,command,log:`${id}.log`});
  writeFileSync(path,original);process.stdout.write(`${id}: ${killed?'KILLED':'SURVIVED/INFRA'}\n`);
 }
}finally{writeFileSync(path,original);}
writeFileSync(`${dir}/results.json`,JSON.stringify(results,null,2));
if(results.some(r=>!r.killed))process.exitCode=1;
