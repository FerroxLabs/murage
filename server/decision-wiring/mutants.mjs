// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only inside the assigned network-none test container. Each mutation is
// applied to the real S4 source, tested, logged, and restored before the next.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const file=resolve('server/index.ts');
const original=readFileSync(file,'utf8');
const directory=resolve('s4-mutant-logs');mkdirSync(directory,{recursive:true});
const mutations=[
 {id:'M37',file:'actor-wiring',from:"if (facts.queuedDrain) return facts.queuedOwnerProof ? { k: 'owner-typed' } : { k: 'other-human' };",to:"if (facts.queuedDrain) return facts.continuation ?? { k: 'other-human' };"},
 {id:'M37-dispatch',file:'server-fixture',test:'R4 queued owner',from:"if (facts.queuedDrain) return facts.queuedOwnerProof ? { k: 'owner-typed' } : { k: 'other-human' };",to:"if (facts.queuedDrain) return facts.continuation ?? { k: 'other-human' };"},
 {id:'M29-S4',file:'actor-wiring',from:"if (provenance.roomOwnerOnly && profile && botPermissionMode(profile) === 'unlimited') return 'unlimited';",to:"if (false && provenance.roomOwnerOnly && profile && botPermissionMode(profile) === 'unlimited') return 'unlimited';"},
 {id:'M59',file:'actor-wiring',from:"if (initiator.form === 'run') {",to:"if (true) {"},
 {id:'M58-adapter',file:'deny-e2e',from:'!denial.ops.includes(target.op)',to:"!['write'].includes(target.op)"},
 {id:'M69',file:'actor-wiring',from:null,to:"\ninternalTurnOwners.set('mutant-third-site', {} as never);\n"},
 {id:'A3-continuation-actor',file:'actor-wiring',from:"const initiator = source.actor === 'other' && (raw.k === 'owner-typed' || raw.k === 'owner-channel-dm' || 'sourceRunId' in raw) ? { k: 'other-human' as const } : raw;",to:'const initiator = raw;'},
 {id:'queue-durable-target',file:'base-workflow-parity',from:'return { threadId: record.threadId, botId: record.botId };',to:'return item.proof as { threadId: string; botId: string };'},
 {id:'MCP-registered-call',file:'base-workflow-parity',from:'enableMcpServer(input.name, input.server)',to:'enableMcpServer(input.name, resolved.server)'},
 {id:'C5-instruction-routing',file:'question-e2e',from:'const result = await send();\n  if (reply.pending.length)',to:"const result = { ok: true, threadId, questionAnswered: true } as T;\n  if (reply.pending.length)"},
 {id:'M52-forwarder',file:'server-fixture',test:'BASE card allow',from:'    case "message.patch": {\n      broadcast',to:'    case "message.patch": {\n      const approvalId = (change.message.card as Partial<PermissionCard> | undefined)?.approvalId;\n      if (approvalId && readApproval(approvalId)?.state !== "open") return;\n      broadcast'},
];
const results=[];
try {
 for(const mutant of mutations){
  if(mutant.from!==null&&!original.includes(mutant.from))throw Error('Mutation anchor missing: '+mutant.id);
  writeFileSync(file,mutant.from===null?original+mutant.to:original.replace(mutant.from,mutant.to));
  const args=['node_modules/vitest/vitest.mjs','run',`server/decision-wiring/${mutant.file}.test.ts`,'--maxWorkers=1',...(mutant.test?['-t',mutant.test]:[])];
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,env:{...process.env,NO_COLOR:'1',S4_FIXTURE_EVIDENCE:resolve(directory,mutant.id+'-fixture.json')}});
  const command=[process.execPath,...args].join(' ');
  writeFileSync(resolve(directory,mutant.id+'.log'),`COMMAND ${command}\nMUTATION ${JSON.stringify({from:mutant.from,to:mutant.to})}\nEXIT ${result.status}\n${result.stdout??''}${result.stderr??''}${result.error??''}`);
  // A timeout/loader failure is not a killed mutant: require a failing assertion.
  const killed=result.status===1&&/AssertionError|expected .* to (be|equal)|Missing production wiring|Error: no matching frame within 10000ms/.test((result.stdout??'')+(result.stderr??''));
  results.push({id:mutant.id,killed,exit:result.status,command,log:mutant.id+'.log'});
  writeFileSync(file,original);
  process.stdout.write(`${mutant.id}: ${killed?'KILLED':'SURVIVED/INFRA'}\n`);
 }
} finally { writeFileSync(file,original); }
writeFileSync(resolve(directory,'results.json'),JSON.stringify(results,null,2));
if(results.some(result=>!result.killed))process.exitCode=1;
