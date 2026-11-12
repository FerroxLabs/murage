// Run only in the isolated, network-none test container. Every edit is restored.
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const routing='server/decision-producers/routing.test.ts';
const queue='server/decision-producers/queue.test.ts';
const presentation='server/decision-producers/presentation.test.ts';
const email='server/decision-producers/email-lifecycle.test.ts';
const raw="{role:'bot',kind:'options',card:{requestId:'mutant-direct',title:'Mutant',subtitle:'fixture',options:['Allow','Deny']}} as any";
const mutants=[
 ['P11-image-direct','server/image-operations.ts','    const requestId = `image-${randomUUID()}`;',`    this.store.appendMessage(actor.threadId,${raw});\n    const requestId = \`image-\${randomUUID()}\`;`,routing,'^image:'],
 ['P12-image-fallback','server/image-operations.ts','catch { /* a policy failure is an observation */ }',`catch { this.store.appendMessage(actor.threadId,${raw}); }`,routing,'^image-failure:'],
 ['P13-publish-direct','server/publish/publish-ops.ts',"    const requestId=`publish-${randomUUID()}`; let messageId='';",`    this.options.store.appendMessage(actor.threadId,${raw});\n    const requestId=\`publish-\${randomUUID()}\`; let messageId='';`,routing,'^publish:'],
 ['P14-routine-direct','server/routine-requests.ts','    const approval=this.approvals.open({authority:args.authority',`    this.store.appendMessage(threadId,${raw});\n    const approval=this.approvals.open({authority:args.authority`,routing,'^routine:'],
 ['P15-webhook-direct','server/routine-requests.ts','    const approval=this.approvals.open({authority:args.authority',`    this.store.appendMessage(threadId,${raw});\n    const approval=this.approvals.open({authority:args.authority`,routing,'^webhook:',2],
 ['P16-skill-extra-approval','server/narrow-denials.ts',"  const result=queue.executeNow(request,execute);","  const result=queue.executeNow(request,execute);\n  if(result.kind==='executed')return {kind:'card',card:input.action};",routing,'^skill:'],
 ['P17-mcp-extra-enable','server/mcp-bot-cards.ts',"  if(result.kind==='executed'||result.kind==='refuse')return result;","  if(result.kind==='refuse')return result;\n  if(result.kind==='executed')return {kind:'card',card:mcpEnableCard(name,server,rev,bot)};",routing,'^mcp:'],
 ['P18-host-direct','server/host-computer-consent.ts','  const requestId=newId();',`  bus.store.appendMessage(threadId,${raw});\n  const requestId=newId();`,routing,'^host-computer:'],
 ['P19-P20-browser-direct','server/browser-extension-approvals.ts',"    const requestId='browser-'+randomUUID();",`    this.bus.store.appendMessage(input.threadId,${raw});\n    const requestId='browser-'+randomUUID();`,routing,'^browser-action:'],
 ['P21-browser-setup-direct','server/browser-extension-setup.ts',"    const queue=serviceQueue('browser'),title=",`    this.options.store.appendMessage(threadId,${raw});\n    const queue=serviceQueue('browser'),title=`,routing,'^browser-setup:'],
 ['P22-P23-email-local-hold','server/email/send-service.ts',"    const planned={...row,state:'awaiting_owner'", "    if(decision.needsOwner)return this.move(row,{state:'awaiting_owner',why:decision.why})??this.fresh(row.sendId);\n    const planned={...row,state:'awaiting_owner'",email,'P22/P23'],
 ['P24-email-upstream-hold','server/email/send-service.ts','if (held.receipt && !held.receipt.used)','if (false && held.receipt && !held.receipt.used)',email,'P24 exact'],
 ['P25-email-retry-card','server/email/cards.ts','    void this.options.send.syncApproval(row).catch', '    this.host.appendCard(row.threadId,row.botId,this.view(row));\n    void this.options.send.syncApproval(row).catch',email,'P25 an owner'],
 ['P26-email-trust-card','server/email/cards.ts',"      if(request.outcome.kind==='run')continue;", "      if(request.outcome.kind==='run'){this.host.appendCard(offer.threadId,botId,card);continue;}",email,'P26'],
 ['P27-event-limit-direct','server/peer-approval.ts','  const requestId=newId();',`  bus.store.appendMessage(sourceThreadId,${raw});\n  const requestId=newId();`,routing,'^event-limit:'],
 ['P28-access-queue','server/bot-access.ts',' const approvals=botAccessApprovalQueue(store);'," store.patchBot(target!.id,{connectedAppAccess:{...policy,requests:[...liveRequests,pending]}});\n return {requestId:pending.id,expiresAt:pending.expiresAt,status:'Waiting for owner review',revision:policy.revision};\n const approvals=botAccessApprovalQueue(store);",routing,'^bot-access:'],
 ['P29-phone-sheet','server/phones/jobs.ts',"const execution=this.approvals.executeNow(request,()=>{job.permissionRun=true;});", "const execution=this.approvals.executeNow(request,()=>{job.permissionRun=false;});",routing,'^phone:'],
 ['P30-share-redecision','server/room-shares.ts',"  const result=queue.executeNow(request,call=>{", "  if(approvalDecision(share.originThreadId,'ask_owner_to_share',{},true,undefined,share.botId).verdict!=='run')return {ok:false,status:403,error:'Share needs approval.'};\n  const result=queue.executeNow(request,call=>{",routing,'^room-share:',1,'import { ProducerApprovalQueue', 'import { approvalDecision } from "./approval-decision.ts";\nimport { ProducerApprovalQueue'],
 ['P31-folder-trust-disguised','src/components/OptionCard.tsx',"  if(card.answered!=null","  if(card.folderTrust)return true;\n  if(card.answered!=null",'server/decision-producers/renderer.test.ts','P31'],
 ['P32-permission-fallthrough','src/components/OptionCard.tsx',"  return typeof card.approvalId","  return true||typeof card.approvalId",'server/decision-producers/renderer.test.ts','A1 terminal|P31'],
 ['Sable-outside-veto','server/outside-own.ts','if (serviceOwnerNoLimits(call.authority)) return null;','if (false && serviceOwnerNoLimits(call.authority)) return null;',routing,'Sable S2'],
 ['A2-A4a-queue-first','server/narrow-denials.ts',"if(!prior)this.replace({item,base:request.base,state:'waiting'});", "if(false && !prior)this.replace({item,base:request.base,state:'waiting'});",queue,'A1/A2/A4a'],
 ['A2-access-lost-ack','server/bot-access.ts','if(applied)return;','if(false && applied)return;',routing,'lost queue acknowledgement'],
 ['M20-queue-exact-call','server/narrow-denials.ts','if (!entry || !same(entry.item,item))','if (!entry)',queue,'recovery renewal'],
 ['R17-forged-notification','server/approval-notification-state.ts'," if(!record||record.ref.approvalId!==payload.approvalId||record.state!=='open'", " if(false && (!record||record.ref.approvalId!==payload.approvalId||record.state!=='open'",presentation,'copied matching row',0, "record.actionHash!==payload.actionHash)return null;", "record.actionHash!==payload.actionHash))return null;"],
 ['M27-drop-app-denial','server/bot-access.ts','next.denials=[...(policy.denials??[]),...deniedGrants(request!.grants,"request-denied",now,next.revision,request!.allowWrites)];','next.denials=policy.denials;', 'server/decision-producers/denials.test.ts','M27'],
 ['M58-wrong-app-ops','server/bot-access.ts','ops:[known.writes?"write" as const:"read" as const]','ops:allowWrites?["read" as const,"write" as const]:["write" as const]','server/decision-producers/denials.test.ts','M27|M58'],
 ['M39-unclassified-producer','server/mcp-bot-cards.ts','    mcpEnable: {\n      name, rev','    unknownPermission: {\n      name, rev','server/decision-producers/card-class.test.ts','F4'],
 ['M29-keep-routine-ceiling','src/lib/permission-mode.ts','return ownerRoutineLevel(current, levelRank(ceiling) < levelRank(current) ? ceiling : current, routine.draftOnly === true || profile.draftOnly === true);','return levelRank(ceiling) < levelRank(current) ? ceiling : current;','src/lib/permission-mode.test.ts',"shows the level|chip says No limits"],
 ['B1-browser-policy','server/browser-extension-service.ts',"entry.taskL1.add(origin);policy.setSiteAccess(entry.context,origin,'allow');return;","entry.taskL1.add(origin);return;",'server/decision-producers/browser-execution.test.ts','B1'],
 ['B2-renderer-routes','src/components/ChatView.tsx','              if (!permissionCardRenderable(m)) return null;','', 'server/decision-producers/renderer.test.ts','B2'],
 ['B2-live-approval-hidden','src/components/OptionCard.tsx','  return typeof card.approvalId','  return false&&typeof card.approvalId','server/decision-producers/renderer.test.ts','B2 a valid permission|B2 rejects only'],
 ['B3-setup-continuation','server/browser-extension-setup.ts',"    for(const item of serviceQueue('browser').continuations('request_browser_connection')){", "    for(const item of serviceQueue('browser').pendingApprovals().filter(item=>item.call.tool==='request_browser_connection')){",routing,'B3'],
 ['B4-access-crash-gap','server/bot-access.ts',"if(!policy.requests.some(request=>request.id===item.ref)&&policy.revision===call.revision&&call.proposal?.id===item.ref)","if(false && !policy.requests.some(request=>request.id===item.ref)&&policy.revision===call.revision&&call.proposal?.id===item.ref)",routing,'B4'],
 ['B5-email-report','server/email/cards.ts',"this.host.activity(row.threadId,'Email approval could not be shown. Try again.',false);",'',email,'B5 sync'],
 ['B5-email-trust','server/email/cards.ts','queue.presentNow(request,request.outcome.ref);','void queue.present(request,request.outcome.ref).catch(()=>undefined);',email,'B5 trust'],
 ['B6-routine-undo','server/routine-requests.ts',"{ card: { ...card, answeredAt: receipt.appliedAt } }", "{ card: { ...card } }",routing,'B6 M22'],
 ['M22-routine-stamp-label','server/routine-requests.ts',"typeof card.answered !== 'string'", "card.answered !== 'allow'",'server/decision-producers/routine-receipt-scale.test.ts','M22 stamp guard'],
 ['M-A1i-routine-client-label','src/components/ApprovalCard.tsx','request && isAllowedAnswer(card.answered)','request && card.answered === "allow"','server/decision-producers/renderer.test.ts','T3 M-A1i'],
 ['M-S5-receipt-rotation','server/routine-requests.ts',"if (visits >= Math.min(64, budget)) break;", "if (visits >= Math.min(64, budget) || preview.source === 'undoQ') break;",'server/decision-producers/routine-receipt-scale.test.ts','T2c fixed'],
 ['M-S6b-receipt-bulk','server/routine-requests.ts','this.routines.reconcileRoutineRequestReceipts(survivors);',"for (const receipt of this.routines.routineRequestReceiptSnapshot()) { if (ids.has(receipt.requestId)) this.routines.forgetRoutineRequestReceipt(receipt); }",'server/decision-producers/routine-receipt-scale.test.ts','T2d crash'],
 ['B7-image-unused-allow','server/image-operations.ts',"if(!resumed)throw new Error('approval-queue-delivery-unavailable');",'',routing,'B7'],
 ['B7-image-late-once','server/image-operations.ts','        this.lateAllows.add(lateKey);','',routing,'B7'],
 ['B8-Sable-outside-routines','server/outside-own.ts','if (serviceOwnerNoLimits(call.authority)) return null;','if (false && serviceOwnerNoLimits(call.authority)) return null;',routing,'B8'],

];
let failed=false;
for(const [id,file,from,to,test,pattern,nth=1,from2,to2] of mutants.filter(item=>!process.env.MUTANTS||new RegExp(process.env.MUTANTS).test(item[0]))){
 const original=readFileSync(file,'utf8');let changed=original;
 try{
  let at=-1;
  for(let n=0;n<(nth||1);n++)at=changed.indexOf(from,at+1);
  if(at<0)throw new Error(`mutation needle missing: ${id}`);
  changed=changed.slice(0,at)+to+changed.slice(at+from.length);
  if(from2){if(!changed.includes(from2))throw new Error('second needle missing');changed=changed.replace(from2,to2);}
  writeFileSync(file,changed);
  const args=['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','-t',pattern];
  process.stdout.write(`\nMUTANT ${id}\nCOMMAND node ${args.join(' ')}\n`);
  const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  process.stdout.write(run.stdout??'');process.stdout.write(run.stderr??'');
  const assertionRequired=/^(B6-|M22-|M-A1i-|M-S5-|M-S6b-)/.test(id);
  const killed=run.status===1&&(assertionRequired?/AssertionError/:/FAIL|failed/).test((run.stdout??'')+(run.stderr??''))&&!/No test files found|Failed to load|Transform failed/.test((run.stdout??'')+(run.stderr??''));
  process.stdout.write(`RESULT ${id} ${killed?'KILLED':'SURVIVED_OR_INVALID'} exit=${run.status}\n`);
  if(!killed)failed=true;
 }finally{writeFileSync(file,original);}
}
if(!process.env.MUTANTS||new RegExp(process.env.MUTANTS).test('B10-unassigned-test')){
 const file='src/lib/permission-card.test.ts';
 try{
  writeFileSync(file,"// Restored unassigned renderer test.\n");
  const args=['node_modules/vitest/vitest.mjs','run','server/decision-producers/renderer.test.ts','--maxWorkers=1','-t','B10'];
  process.stdout.write(`\nMUTANT B10-unassigned-test\nCOMMAND node ${args.join(' ')}\n`);
  const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  process.stdout.write(run.stdout??'');process.stdout.write(run.stderr??'');
  const assertionRequired=/^(B6-|M22-|M-A1i-|M-S5-|M-S6b-)/.test(id);
  const killed=run.status===1&&(assertionRequired?/AssertionError/:/FAIL|failed/).test(run.stdout+run.stderr);
  process.stdout.write(`RESULT B10-unassigned-test ${killed?'KILLED':'SURVIVED_OR_INVALID'} exit=${run.status}\n`);
  if(!killed)failed=true;
 }finally{unlinkSync(file);}
}
if(failed)process.exitCode=1;
