#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in a throwaway Wave A checkout. Every product edit is restored.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const root=process.cwd();
if(!process.env.FIELD_REPLAY_SCRATCH||!root.startsWith('/work')&&!root.includes('/bld-s2m-r4/'))throw new Error('Mutants require an explicitly designated bld-s2m-r4 scratch checkout');
const output=resolve(process.env.FIELD_REPLAY_EVIDENCE??'server/memory/evidence/field-replay');mkdirSync(output,{recursive:true});
const sha=process.env.FIELD_REPLAY_SHA??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const report=join(output,'mutants.jsonl');
const baselinePath=resolve(process.env.FIELD_REPLAY_BASE_EVIDENCE??join(output,'field-replay.jsonl'));
const baseline=existsSync(baselinePath)?readFileSync(baselinePath,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)).filter(r=>!r.mutant):[];
if(!baseline.length||baseline.some(r=>r.sha!==sha||r.tree!=='TW'))throw new Error('Run the unmutated Wave A replay first and name its field-replay.jsonl with FIELD_REPLAY_BASE_EVIDENCE');
const read=file=>readFileSync(file,'utf8');
function once(text,before,after){if(!text.includes(before))throw new Error(`mutation target absent: ${before.slice(0,120)}`);return text.replace(before,after);}
const index='server/index.ts',producer='server/routine-requests.ts';
const cases=[
 ['MR1','R[1-4]:',files=>{
  let s=read(producer);s=`import {turnOutsideRead as fieldOutsideRead} from './email/external-marks.ts';\n`+s;
  const anchor=s.includes('const {title,subtitle,detail:_detail')?'    const {title,subtitle,detail:_detail':'    if (approvalDecision(threadId, copy.tool';
  const position=s.indexOf(anchor);if(position<0)throw new Error('routine producer anchor absent');
  s=s.slice(0,position)+`    if(fieldOutsideRead(threadId)){const message=this.store.appendMessage(threadId,murageLine(messageInput));return {requestId,messageId:message.id,title:copy.title,summary:copy.summary,detail:copy.detail,nextRunAt:copy.nextRunAt,timeZone};}\n`+s.slice(position);files.set(producer,s);
 }],
 ['MR2','R[1-4]:',files=>{
  let s=`import {turnOutsideRead as fieldOutsideRead} from './email/external-marks.ts';\n`+read(index);
  if(s.includes('owner: isWorkspaceOwner(principal) && provenance.roomOwnerOnly'))s=once(s,'owner: isWorkspaceOwner(principal) && provenance.roomOwnerOnly','owner: !fieldOutsideRead(threadId) && isWorkspaceOwner(principal) && provenance.roomOwnerOnly');
  else s=once(s,'actor: {kind: origin === "routine"','actor: {kind: fieldOutsideRead(threadId) ? "other" : origin === "routine"');
  files.set(index,s);
 }],
 ['MR3','R1:|R7 / MS:',files=>files.set(index,once(read(index),'if (proposed.applied) {','if (proposed.applied && false) {'))],
 ['MR4','R5:',files=>files.set('server/routine-permissions.ts',once(read('server/routine-permissions.ts'),'return bot.noLimits === true ? "unlimited" : "full";','return bot.noLimits === true ? "full" : "full";'))],
 ['MR5','R6:',files=>{
  let s=read(index);s=once(s,'authenticatedMemoryAgentRoute(internalCapabilities,internalClaim,path','memoryAgentRoute(path');
  if(!/import\s*\{[^}]*\bmemoryAgentRoute\b[^}]*\}\s*from\s*["']\.\/memory\/routes/.test(s))s=`import {memoryAgentRoute} from './memory/routes.ts';\n`+s;
  files.set(index,s);
 }],
 ['MR6','R5:',files=>{
  let s=read(index);
  if(s.includes('routine: routineInitiator,'))s=once(s,'routine: routineInitiator,','routine: undefined,');
  else s=once(s,'...(routineRunId ? { routineRunId,','...(false ? { routineRunId,');
  files.set(index,s);
 }],
 ['MR7','R8:',files=>{
  let s=read(index);const start=s.indexOf('function resolveDecisionDenials(');
  if(start<0)throw new Error('S4 deny source not installed on this tree');
  const end=s.indexOf('\nfunction decisionDenyState',start);if(end<0)throw new Error('deny source end absent');
  const chunk=s.slice(start,end);s=s.slice(0,start)+once(chunk,'return evidence;','return [];')+s.slice(end);files.set(index,s);
 }],
 ['MR8','R10:',files=>files.set(index,once(read(index),'if (folderMark) markTurnOutside(threadId, folderMark','if (folderMark && folderMark !== "cloned folder") markTurnOutside(threadId, folderMark'))],
];
// MS is exercised against a real card inside R7 in the same suite.
let failures=0;
for(const [id,filter,patch]of cases){
 const originals=new Map(),changes=new Map();let row;
 try{
  patch(changes);for(const [file,text]of changes){originals.set(file,read(file));writeFileSync(file,text);}
  const dir=join(output,id);mkdirSync(dir,{recursive:true});
  const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/memory/field-replay.e2e.test.ts','-t',filter],{encoding:'utf8',timeout:360_000,env:{...process.env,FIELD_REPLAY_MUTANT:id,FIELD_REPLAY_EVIDENCE:dir,FIELD_REPLAY_SHA:sha}});
  writeFileSync(join(dir,'vitest.log'),String(run.stdout??'')+String(run.stderr??''));
  const path=join(dir,'field-replay.jsonl');const results=existsSync(path)?read(path).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  const reds=results.filter(r=>r.outcome==='RED'&&baseline.some(b=>b.id===r.id&&b.outcome==='GREEN'));
  const controlBlocked=baseline.some(b=>b.outcome==='BLOCKED-BY-S1'&&new RegExp(filter).test(b.id+':'));
  // Only the explicit surface/effect/precondition assertion is a kill. An
  // import error, crash, timeout, HTTP 500, or NotBuilt can never kill a mutant.
  const harnessError=Boolean(run.error||run.signal)||!results.length||results.some(r=>r.outcome==='ERROR');
  const killed=reds.length>0&&!harnessError;
  row={tree:process.env.FIELD_REPLAY_TREE??'TW',sha,id,outcome:harnessError?'ERROR':killed?'KILLED':controlBlocked||results.some(r=>r.outcome==='BLOCKED-BY-S1')?'BLOCKED-BY-S1':'SURVIVED',baseline:baseline.map(b=>({id:b.id,outcome:b.outcome})),reds:reds.map(r=>({id:r.id,assertion:r.assertion,facts:r.facts})),exit:run.status};
  if(!killed)failures++;
 }catch(error){row={tree:process.env.FIELD_REPLAY_TREE??'TW',sha,id,outcome:'ERROR',reason:String(error)};failures++;}
 finally{for(const [file,text]of originals)writeFileSync(file,text);}
 console.log(`${id}: ${row.outcome}`);writeFileSync(report,JSON.stringify(row)+'\n',{flag:'a'});
}
const ms=baseline.find(r=>r.id==='R7-MS');
const msRow={tree:process.env.FIELD_REPLAY_TREE??'TW',sha,id:'MS',outcome:ms?.outcome==='GREEN'&&ms.killed===true?'KILLED':ms?.outcome==='BLOCKED-BY-S1'?'BLOCKED-BY-S1':'SURVIVED',evidence:baselinePath};
writeFileSync(report,JSON.stringify(msRow)+'\n',{flag:'a'});console.log(`MS: ${msRow.outcome}`);if(msRow.outcome!=='KILLED')failures++;
process.exitCode=failures?1:0;
