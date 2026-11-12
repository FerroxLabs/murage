// Judge-only counterfactuals over stored masked display inputs. No tool execution.
// Installed unchanged into each pinned product tree by prepare-display-pins.py.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { routineTurnApproval, applyRoutinePermissionMode } from '../../server/routine-permissions.ts';
import type { AutoContext } from '../../server/auto-approve.ts';
import * as approval from '../../server/auto-approve.ts';
// Production diagnostics can include display text. Suppress them before judging.
console.log=console.info=console.warn=console.error=()=>{};
try {
 const input=readFileSync(0,'utf8');
 const rows=JSON.parse(input);
 const results=rows.map((r:any,ordinal:number)=>{
  const cc=r.cardClass;
  const cohort=cc.origin==='routine'||cc.automated===1?'routine':cc.origin==='owner'&&cc.unattended===0&&cc.automated===0?'owner':'non-owner';
  if(r.boundedToolInput===null || r.toolInputTruncated===1)return {ordinal,cohort,status:r.boundedToolInput===null?'missing-input':'truncated-input'};
  let args;try {args=JSON.parse(r.boundedToolInput)}catch{return {ordinal,cohort,status:'unparseable-input'}}
  // Driver, runtime marks and environment were not persisted. Make these
  // counterfactual assumptions explicit in the enclosing report, never source facts.
  const command=typeof args.command==='string'?args.command:undefined;
  const context:AutoContext={
   fullAccessOrigin:cc.origin??'other',ownerStarted:cohort==='owner',
   unattended:cc.unattended!==0,automated:cc.automated!==0,
   outsideRead:null,workFolder:'/fixture/work',commandCwd:'/fixture/work',
   commandText:command,inputCut:false,inputTruncated:false,
   call:{engine:'claude',toolCall:{name:r.tool,input:args}},
   promptFacts:{cwd:'/fixture/work',home:'/fixture/home'},
   unseen:{platform:'posix',fs:{realpath(){throw Error('UNAVAILABLE')},stat(){throw Error('UNAVAILABLE')},head(){throw Error('UNAVAILABLE')}},sessionFile:()=> 'unavailable'},
  };
  const result=routineTurnApproval({bot:{...applyRoutinePermissionMode({id:'display-fixture',alwaysAllow:[]},'unlimited'),permissionExplicit:cohort!=='non-owner'},
   ...(cohort==='routine'?{run:{permissionMode:'unlimited' as const}}:{}),tool:r.tool,
   summary:command??r.boundedToolInput,context});
  const v=result.verdict;
  // Reason prose stays private. A hash compares every verdict field for parity.
  const parityDigest=createHash('sha256').update(JSON.stringify({mode:result.mode,...Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex');
  const reason=/^[a-z][a-z0-9-]{0,79}$/.test(v.source)?v.source:'unclassified';
  // Only fixed policy identifiers leave the judge. A generic always-ask source
  // does not prove a deny/wipe exception: unreadable holds must remain visible.
  const namedWipe=new Set(['delete-root','delete-home','delete-system-folder','disk-erase','fork-bomb']);
  const rule=v.source==='always-ask' && (namedWipe.has(v.rule??'') || v.rule==='unreadable') ? v.rule! : 'other';
  const facts=(approval as unknown as {noLimitsFacts?:(v:unknown)=>{n2:boolean}|undefined}).noLimitsFacts?.(v);
  const exceptionEvidence=(v.source==='always-ask' && namedWipe.has(rule)) || facts?.n2===true ? 'wipe-list'
    : v.classification==='deny' ? 'stored-permission-rule' : 'not-established';
  return {ordinal,cohort,status:'judged',cards:v.approve===null&&v.source!=='narrow'?1:0,refusals:v.source==='narrow'?1:0,reason,rule,exceptionEvidence,parityDigest};
 });
 writeFileSync(process.argv[2]!,JSON.stringify(results)+'\n',{mode:0o600,flag:'wx'});
} catch { process.exitCode=3; }
