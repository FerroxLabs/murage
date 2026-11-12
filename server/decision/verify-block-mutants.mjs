// SPDX-License-Identifier: AGPL-3.0-or-later
// Network-none container only. Each regression is restored in finally.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const dir=process.env.DECISION_EVIDENCE||'.afix-evidence/mutants';mkdirSync(dir,{recursive:true});
const mutations=[
 ['B1','implementation.ts',"else outcome={kind:'run'};","else outcome=baseVerdict(e).approve!==null?{kind:'run'}:approval(e,'base',[]);",'sable-shapes','B1'],
 ['B3','verify-gate.mjs',"const complete=rows.every(r=>r.complete);","const complete=true;",'gate-evidence','B3'],
 ['B2','implementation.ts',"const value=execute(e.executionCall??e.registration.source.call);","throw new Error('NotBuilt');const value=execute(e.executionCall??e.registration.source.call);",'review-blocks','B2'],
 ['B4','implementation.ts',"e.cancelled=true;e.terminal=true;e.outcome=freeze({kind:'refuse',message:REFUSAL});","e.terminal=true;",'review-blocks','B4'],
 ['B4-batch','implementation.ts',"const results=await Promise.allSettled(matching.map(e=>cancelEntry(e,state)));","const results=[];for(const e of matching)await cancelEntry(e,state);",'cancellation-batch','B4 cancelling a generation'],
 ['B4-send','implementation.ts',"const current=!row&&e?.cancelled?{behavior:'deny' as const,message:REFUSAL}:prior;","const current=prior;",'cancellation-batch','B4 cancelling a RUN'],
 ['B4-card','implementation.ts',"if(row&&e?.cancelled)return;","",'cancellation-batch','B4 cancelling a persisted card'],
 ['B5','../no-limits-shell.ts',"return ' '+key+header+'\\n';","return ' '+key;",'review-blocks','B5'],
 ['B6','bounds.ts',"if(projected!==original&&!(projected===null&&original===undefined))throw new Error('service-input-too-large');",";",'review-blocks','B6 ordinary'],
 ['B6-dedup','implementation.ts'," const executionCall=source.kind==='service'?captureDelivery((src as Extract<T.RequestSource,{kind:'service'}>).call,source.call):undefined;\n const scope=scopedKey(threadId,key);const existing=entries.get(scope);if(existing){if(source.kind==='service'&&existing.registration.inputHash!==hash((src as Extract<T.RequestSource,{kind:'service'}>).call))throw new Error('request-input-conflict');return existing.handle;}"," const scope=scopedKey(threadId,key);const existing=entries.get(scope);if(existing){if(source.kind==='service'&&existing.registration.inputHash!==hash((src as Extract<T.RequestSource,{kind:'service'}>).call))throw new Error('request-input-conflict');return existing.handle;}\n const executionCall=source.kind==='service'?captureDelivery((src as Extract<T.RequestSource,{kind:'service'}>).call,source.call):undefined;",'review-blocks','B6 duplicate'],
 ['B7','records.ts'," CREATE INDEX IF NOT EXISTS approval_open_created ON approval_records(created_at) WHERE state='open';\n CREATE INDEX IF NOT EXISTS approval_open_thread ON approval_records(thread_id,created_at) WHERE state='open';","",'review-blocks','B7'],
 ['B8','verify-red.mjs',"if(actual!==expected)throw new Error('starting-tree-mismatch: '+path);",";",'starting-tree','B8'],
 ['CA1-install','implementation.ts',"const source=queues.get(delivery.kind);","throw new Error('NotBuilt');const source=queues.get(delivery.kind);",'main-addendum','CA1 sync queue'],
 ['CA1-present','implementation.ts',"export function presentApprovalSync(ref:T.ApprovalRef,view:T.ApprovalView):void {","export function presentApprovalSync(ref:T.ApprovalRef,view:T.ApprovalView):void {throw new Error('NotBuilt');",'main-addendum','CA1 sync queue'],
 ['CA1-answer','implementation.ts',"result=synchronousAck(()=>cap.delivery.respondNow(item,prior,{answerId}));","result={state:'accepted'};",'main-addendum','CA1 sync queue'],
 ['CA2','implementation.ts',"delivery:row.delivery as T.DeliveryState,","",'main-addendum','CA2'],
 ['CA3','implementation.ts',"return answer==='Allowed'||answer==='allow';","return answer==='allow';",'main-addendum','CA3'],
 ['CA3-index','../index.ts',"return isAllowedAnswer(card.answered) ? \"allowed-once\" : \"rejected\";","return card.answered === \"allow\" ? \"allowed-once\" : \"rejected\";",'main-addendum','CA3'],
 ['CA3-dismissed','../index.ts',"if (card && (isAllowedAnswer(card.answered)","if (card && !card.dismissed && (isAllowedAnswer(card.answered)",'main-addendum','CA3'],
 ['CA4','implementation.ts',"answered:label,dismissed:true","answered:label,answeredAt:Date.now(),dismissed:true",'main-addendum','CA4'],

];
const summary=[];
const selected=process.env.DECISION_BLOCK_MUTANTS?.split(',');
for(const [id,name,old,replacement,suite,pattern] of mutations.filter(m=>!selected||selected.includes(m[0]))){
 const file='server/decision/'+name,source=readFileSync(file,'utf8');if(!source.includes(old))throw new Error(id+' missing anchor');
 const args=['run','server/decision/'+suite+'.test.ts','-t',pattern];
 try{
  writeFileSync(file,source.replace(old,replacement));const r=spawnSync('node_modules/.bin/vitest',args,{encoding:'utf8',timeout:90000});const output=r.stdout+r.stderr;
  writeFileSync(dir+'/'+id+'.log','COMMAND vitest '+args.join(' ')+'\n'+output);
  const killed=r.status!==null&&r.status!==0&&/AssertionError|Error: NotBuilt/.test(output)&&!/Failed to parse|Cannot find module|SyntaxError/.test(output);
  summary.push({id,killed,status:r.status});console.log(id,killed?'KILLED':'SURVIVED');
 }finally{writeFileSync(file,source);}
}
writeFileSync(dir+'/summary.json',JSON.stringify(summary,null,2));process.exitCode=summary.some(x=>!x.killed)?1:0;
