// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in the network-none test container. Every mutation is restored even
// when the test fails. Logs are evidence, never product policy inputs.
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const quoteArg=a=>/^[a-zA-Z0-9_/.=-]+$/.test(a)?a:JSON.stringify(a);
const dir=process.env.DECISION_EVIDENCE||'/work/server/decision/evidence';mkdirSync(dir,{recursive:true});
const mutations=[
 ['A5-hook-identity','server/decision/action.ts','MURAGE_HOOK_PATH.test(t.path)', '/(?:murage.*(?:hook|relay)|(?:hook|relay).*murage)/i.test(t.path)','faults','A5 hook exemption'],
 ['R18-process-cap','server/decision/implementation.ts','active.length>=512','active.length>=999','budget','R18 600'],
 ['R18-question-cap','server/decision/implementation.ts','question&&count>=8','question&&count>=9','settle-states','R18 ninth'],
 ['R18-depth','server/no-limits-code.ts','export const MAX_DEPTH = 4','export const MAX_DEPTH = 5','budget','R18 64 and 65'],
 ['A12-unicode','server/decision/bounds.ts',"end--;h.update", ";h.update",'budget','content streaming'],
 ['A2-conflict-fault','server/decision/implementation.ts',"catch{if(!e.fault)e.fault='reader';}","catch(error){throw error;}",'ingress','A2 BASE conflict'],
 ['M57-hook','server/installation-restore-preparation.ts','        cancelOpenRecords(db, "Cancelled (restore)");','        ;','schema-lifecycle','real archive restore'],
 ['X14-restore-action','server/installation-restore-preparation.ts','orphaned: true, detail: "This was waiting','browserSetup: {...message.card.browserSetup, continueRequested: false}, orphaned: true, detail: "This was waiting','schema-lifecycle','real archive restore'],
 ['X15-fault-priority','server/decision/implementation.ts',"catch{if(!fault)fault='reader';}","catch{fault='reader';}",'faults','simultaneous'],
 ['X16-base-question','server/decision/implementation.ts',":b.approve!==null?{kind:'run'}:approval(e,'base',[]);",":isQuestion(r)?approval(e,'question',[]):b.approve!==null?{kind:'run'}:approval(e,'base',[]);",'engine-action','BASE native questions'],
 ['X12-builder','server/decision/implementation.ts','action={...action,...extra};','action={...action};','engine-action','BASE engine builder receives'],
 ['X13-backup','server/installation-database-snapshot.ts','  assertBackupEmailActions(db);','  ;','schema-lifecycle','bound email bodies'],
 ['M64-heads','server/decision/bounds.ts','bytes-=Buffer.byteLength(head);',';','budget','content heads share'],
 ['M55-queue','server/decision/implementation.ts',"records.writeQueueDelivery(db,item.approvalId,{...receipt,delivery:'pending'});",";",'records-crash','orphaned queue re-decided RUN'],
 ['M49-scope','server/decision/implementation.ts',"const scopedKey=(threadId:string,key:string)=>canonical([threadId,key]);","const scopedKey=(threadId:string,key:string)=>key;",'ingress','scoped to their verified'],
 ['X1','server/decision/implementation.ts'," const h=requiredHost();", " if(row.why==='wipe'&&!describeAction({tool:'Bash',input:{command:view.subtitle}}).deletes.length)return;const h=requiredHost();",'exec-mode','R1 Python evidence'],
 ['X2','server/decision/action.ts'," return freeze({tool,codeIdentity:", " if(Object.keys(obj).some(f=>CONTENT_FIELDS.has(f))&&JSON.stringify(obj).includes('rm -rf'))deletes.push({path:'root',op:'delete'});\n return freeze({tool,codeIdentity:",'base-parity','R3'],
 ['X3','server/decision/implementation.ts',"a.actor=p.roomOwnerOnly?'owner-routine':'other'", "a.actor='other'",'routine-policy','A7a'],
 ['X4','server/decision/implementation.ts',"else if(r.deny.length)outcome=approval(e,'deny',r.deny)", "else if(false)outcome=approval(e,'deny',r.deny)",'faults','M38'],
 ['X5','server/store.ts',"const involvesNoLimits = from !== to && (from === 'no-limits' || to === 'no-limits');", "const involvesNoLimits = true;",'../permission-level-parity','X5'],
 ['X7','server/decision/implementation.ts',"else if(isQuestion(r))outcome=approval(e,'question',[])", "else if(isQuestion(r))outcome=approval(e,'base',[])",'settle-states','X7'],
 ['X8','server/decision/implementation.ts',"else if(isQuestion(r))", "else if(e.fault==='reader')outcome=approval(e,'base',[]);\n  else if(isQuestion(r))",'faults','M23 reader'],
 ['X9','server/decision/implementation.ts',"else if(isQuestion(r))", "else if(baseVerdict(e).approve===null)outcome=approval(e,'base',[]);\n  else if(isQuestion(r))",'base-parity','R10'],
 ['X10','server/decision/implementation.ts',"outcome=(e.fault==='reader'||e.fault==='deny')?approval(e,'base',[]):", "outcome=",'faults','A5 X10'],
 ['X11','server/decision/implementation.ts',"const e=entry(handle);e.base=base;", "const e=entry(handle);requiredHost().store.messagesFor(e.threadId);e.base=base;",'ingress','R12'],

 ['M29','shared/owner-routine-level.ts',"botLevel === 'unlimited' ? 'unlimited' : baseLevel","baseLevel",'routine-policy','M29'],
 ['M30','server/store.ts',"task === sole ? {...task,...soleNext} : task","task",'../permission-level-parity','M30'],
 ['M68','server/decision/inventory.ts',"credentialCard=true","credentialCard=false",'inventory','M68'],

 ['M21','server/decision/implementation.ts',"if(canonical(rev)!==canonical(e.registration.denyRev))",'if(false)','faults','M21'],
 ['M23','server/decision/implementation.ts',"else if(isQuestion(r))", "else if(e.fault==='reader')outcome=approval(e,'base',[]);\n  else if(isQuestion(r))",'faults','M23 reader'],
 ['M24','server/decision/implementation.ts',"else outcome=baseVerdict(e).approve!==null?{kind:'run'}:{kind:'refuse',message:REFUSAL}","else outcome=approval(e,'base',[])",'faults','M24'],
 ['M25','server/no-limits-shell.ts',"const before=collected.length;","const before=collected.length;const restoredRaw=targetFree(source);if(restoredRaw)collected.push(restoredRaw);",'exec-mode','R14'],
 ['M26','server/no-limits-code.ts',"const [l,raw,d]=work[i];","const [l,raw,d]=work[i];if(l==='py'||l==='js'){const legacy=readCode(l==='py'?'python':'node',raw);for(const r of legacy.reads)if(r.state==='effect')classes.push(r.cls);}",'exec-mode','R14'],
 ['M28','server/decision/action.ts',"t.kind==='path'&&t.op!=='read'","t.kind==='path'",'faults','M28'],
 ['M33','server/decision/implementation.ts'," const count=records.openRecords(database(),row.thread_id).filter(r=>r.why==='question').length;"," for(const previous of records.openRecords(database(),row.thread_id).filter(r=>r.why==='question'))records.updateRecord(database(),previous.id,{state:'expired'});\n const count=records.openRecords(database(),row.thread_id).filter(r=>r.why==='question').length;",'settle-states','M33'],
 ['M36','server/no-limits-code.ts',"try {budget.tick(text.length);const nested:Payload[]=[];","try {budget=new ReaderBudget();budget.tick(text.length);const nested:Payload[]=[];",'budget','M36'],
 ['M38','server/decision/implementation.ts',"deny=protectedEvidence(action);","deny=[];",'faults','M38'],
 ['M40','server/decision/records.ts',"THEN CASE WHEN json_valid(${x}.json) THEN json_extract", "THEN CASE WHEN 1 THEN json_extract",'seam','M40'],
 ['M47','server/decision/implementation.ts',"snapshot=captured?.snapshot;", "snapshot=captured?.snapshot;if(snapshot&&(source).event)snapshot={...snapshot,input:(source).event.toolCall.input};",'ingress','M47'],
 ['M48','server/decision/implementation.ts',"if(old){if(old.snapshot.inputHash!==snapshot.inputHash)","if(old){old.snapshot=snapshot;old.latest=snapshot;if(old.snapshot.inputHash!==snapshot.inputHash)",'ingress','M48'],
 ['M49','server/decision/implementation.ts',"({threadId,botId,generation}=c);","({threadId,botId,generation}=c);threadId=source.threadId??threadId;botId=source.botId??botId;",'ingress','M49'],
 ['M50','server/installation-app-schema-downgrade.ts',"    ...APPROVAL_OBJECTS.indexes,","",'schema-lifecycle','M50'],
 ['M51','server/decision/implementation.ts',"else if(owner(e)){","else if(r.level==='unlimited'){",'faults','M51'],
 ['M53','server/decision/implementation.ts',"try {transaction(db=>{\n  if(!records.readRecord", "try {((fn)=>fn(database()))(db=>{\n  if(!records.readRecord",'records-crash','M53 record and row'],
 ['M54','server/decision/records.ts',"ON approval_records(source_kind,thread_id,request_key);","ON approval_records(source_kind,thread_id,request_key) WHERE state='open';",'records-dedup','M54 terminal SQL'],
 ['M55','server/decision/implementation.ts',"answer_id:answerId,delivery:'pending'","answer_id:null,delivery:'pending'",'records-crash','M55'],
 ['M56','server/decision/records.ts',"!isTerminal(message)?{orphaned:true,answered:'Expired (upgrade)'}:{}","false?{orphaned:true,answered:'Expired (upgrade)'}:{}",'legacy-import','M56'],
 ['M57','server/decision/records.ts',"db.prepare(\"UPDATE approval_records SET state='cancelled',settled_at=? WHERE state='open'\").run(Date.now());","",'schema-lifecycle','M57'],
 ['M60','server/no-limits-shell.ts',"const text=shellExecutables(decodeAnsiC(source),depth,nested),cmds=simpleCommands(text);","const text=shellExecutables(decodeAnsiC(source),depth,nested),cmds=simpleCommands(text);for(const m of source.matchAll(/\\$\\((.*?)\\)/g))nested.push(['sh',m[1],depth+1,'raw']);",'exec-mode','R14'],
 ['M61','server/no-limits-shell.ts',"const before=collected.length;","const before=collected.length;if(plainWipe(source))collected.push('disk');",'exec-mode','R14'],
 ['M64','server/decision/bounds.ts'," let bytes=1_000_000,keys=10_000;"," value=structuredClone(value);let bytes=1_000_000,keys=10_000;",'budget','M64 projection'],
];
let missed=0;const summary=[];
for(const [id,file,old,replacement,suite,pattern]of mutations){
 if(process.env.DECISION_MUTANTS&&!process.env.DECISION_MUTANTS.split(',').includes(id))continue;
 const original=readFileSync(file,'utf8');if(!original.includes(old)){summary.push({id,killed:false,error:'mutation anchor missing'});missed++;continue;}
 const command=['run',suite==='../permission-level-parity'?'server/permission-level-parity.test.ts':`server/decision/${suite}.test.ts`,'-t',pattern];
 try{writeFileSync(file,original.replace(old,replacement));const r=spawnSync('node_modules/.bin/vitest',command,{encoding:'utf8',timeout:90000});writeFileSync(`${dir}/${id}.log`,`COMMAND node_modules/.bin/vitest ${command.map(quoteArg).join(' ')}\n${r.stdout??''}${r.stderr??''}${r.error?'RUNNER ERROR '+r.error.message:''}`);const killed=r.status!==0&&/failed/.test((r.stdout??'')+(r.stderr??''))&&!/Failed to parse|Cannot find module|SyntaxError/.test((r.stdout??'')+(r.stderr??''));summary.push({id,killed,status:r.status});if(!killed)missed++;console.log(id,killed?'KILLED':'SURVIVED');}
 finally{writeFileSync(file,original);}
}
// M9 inserts a real producer into a fresh production file. The inventory
// must reject the site, even though no existing producer count changed.
if(!process.env.DECISION_MUTANTS||process.env.DECISION_MUTANTS.split(',').includes('M9')){
 const path='server/decision/mutant-producer.ts';
 if(existsSync(path))throw new Error('mutant fixture path already exists');
 try{
  writeFileSync(path,"export const injected = {kind:'options',card:{requestId:'mutant',options:['Allow','Deny']}};\n");
  const command=['run','server/decision/inventory.test.ts','-t','R2 M9'];
  const r=spawnSync('node_modules/.bin/vitest',command,{encoding:'utf8',timeout:90000});
  writeFileSync(`${dir}/M9.log`,`COMMAND node_modules/.bin/vitest ${command.map(quoteArg).join(' ')}\n${r.stdout??''}${r.stderr??''}`);
  const killed=r.status!==null&&r.status!==0&&/failed/.test((r.stdout??'')+(r.stderr??''));
  summary.push({id:'M9',killed,status:r.status});if(!killed)missed++;console.log('M9',killed?'KILLED':'SURVIVED');
 }finally{unlinkSync(path);}
}
writeFileSync(`${dir}/mutants.json`,JSON.stringify(summary,null,2)+'\n');process.exitCode=missed?1:0;
