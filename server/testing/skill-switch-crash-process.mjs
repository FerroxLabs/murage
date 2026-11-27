// Isolated process/crash fixture owner: skills lane; durable queue owner: decision lane.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import * as fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=process.env.MURAGE_DATA_DIR;
assert(process.env.MURAGE_SKILL_CRASH_FIXTURE==='1'&&root?.startsWith(join(tmpdir(),'murage-skill-crash-')));
assert(resolve(root)!==resolve(tmpdir()));
const [phase,point,driver,shape,action]=process.argv.slice(2);
const events=join(root,'fixture-events.jsonl'),queueFile=join(root,'fixture-queue.json');
function restoreSkill(){
  fs.rmSync(join(root,'workspaces','b'),{recursive:true,force:true});fs.rmSync(join(root,'skill-state','b'),{recursive:true,force:true});
  fs.cpSync(join(root,'fixture-saved-workspace'),join(root,'workspaces','b'),{recursive:true});fs.cpSync(join(root,'fixture-saved-state'),join(root,'skill-state','b'),{recursive:true});
}
registerHooks({load(url,context,next){
  const result=next(url,context);if(typeof result.source!=='string'&&!Buffer.isBuffer(result.source))return result;
  let source=String(result.source);
  if(url.endsWith('/server/skill-switch-executor.ts'))source=source.replace('    applySkillSwitchTarget(target,',"    if(process.env.MURAGE_CRASH_PHASE==='init'&&process.env.MURAGE_CRASH_POINT==='C01')process.exit(71);\n    applySkillSwitchTarget(target,");
  if(url.endsWith('/server/skills.ts')){
    source="import {appendFileSync as crashWrite} from 'node:fs';\n"+source;
    source=source.replace("export function readSkillSwitchTarget(botId:string,name:string): SkillSwitchTarget | undefined {",`export function readSkillSwitchTarget(botId:string,name:string): SkillSwitchTarget | undefined {crashWrite(${JSON.stringify(events)},JSON.stringify({phase:process.env.MURAGE_CRASH_PHASE,kind:'read'})+'\\n');`);
    source=source.replace("export function applySkillSwitchTarget(target:SkillSwitchTarget,action:'turn_on'|'turn_off'|'delete',options:{acknowledged?:string}={}):void {",`export function applySkillSwitchTarget(target:SkillSwitchTarget,action:'turn_on'|'turn_off'|'delete',options:{acknowledged?:string}={}):void {crashWrite(${JSON.stringify(events)},JSON.stringify({phase:process.env.MURAGE_CRASH_PHASE,kind:'effect',acknowledged:options.acknowledged})+'\\n');`);
  }
  if(url.endsWith('/server/skill-guard/scan.ts')){
    source="import {appendFileSync as crashScanWrite} from 'node:fs';\n"+source;
    const body=source.indexOf('{',source.indexOf('): SkillScan {',source.indexOf('export function scanSkill')));
    assert(body>=0,'scanner fixture anchor');source=source.slice(0,body+1)+`crashScanWrite(${JSON.stringify(events)},JSON.stringify({phase:process.env.MURAGE_CRASH_PHASE,kind:'scan'})+'\\n');`+source.slice(body+1);
  }
  if(url.endsWith('/server/atomic.ts')){
    source=source.replace('  writeFileAtomicInner(path, data, options);',`  const crashEntry=String(path)===${JSON.stringify(queueFile)}?JSON.parse(String(data)).entries.find(e=>e.item.call.tool==='switch_skill'):undefined;
  if(process.env.MURAGE_CRASH_PHASE==='init'&&crashEntry?.state==='accepted'){
    if(process.env.MURAGE_CRASH_POINT==='C02'||process.env.MURAGE_CRASH_POINT.startsWith('C05'))process.exit(72);
    if(process.env.MURAGE_CRASH_POINT.startsWith('C03'))throw new Error('fixture receipt unavailable');
  }
  if(process.env.MURAGE_CRASH_PHASE==='init'&&crashEntry?.state==='unconfirmed'&&process.env.MURAGE_CRASH_POINT==='C03-quarantine')throw new Error('fixture quarantine unavailable');
  writeFileAtomicInner(path, data, options);
  if(process.env.MURAGE_CRASH_PHASE==='init'&&crashEntry?.state==='accepted'&&process.env.MURAGE_CRASH_POINT==='C04')process.exit(74);`);
  }
  return {...result,source};
}});
process.env.MURAGE_CRASH_PHASE=phase;process.env.MURAGE_CRASH_POINT=point;
const [{Store},d,skills,{ProducerApprovalQueue},{planSkillSwitch},{createOwnerSettlementRegistry,automaticSettlement},{createSkillSwitchExecutor}]=await Promise.all([
  import('../store.ts'),import('../decision/index.ts'),import('../skills.ts'),import('../narrow-denials.ts'),import('../skill-switch.ts'),import('../skill-switch-settlement.ts'),import('../skill-switch-executor.ts')]);
const store=new Store();let level='ask';
d.installDecisionHost({store,view:()=>({title:'Fixture',subtitle:''}),skillSettlementPolicy:()=>({kind:'eligible',retire:true})});
d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}}),
  live:()=>({botId:'b',turnId:'turn',providerInstanceId:'fixture',principal:'owner',owner:true,level})});
d.installDenySources({revision:()=>['1'],resolve:()=>[]});
const claim=d.installClaimVerifier(proof=>proof==='trusted'?{threadId:'t',botId:'b',generation:'g'}:undefined)('trusted');assert(claim);
const registry=createOwnerSettlementRegistry(),execute=createSkillSwitchExecutor(registry,{automatic:()=>d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits===true,owner:()=>false});
if(phase==='replay'&&point.startsWith('C05-legacy-')){const saved=JSON.parse(fs.readFileSync(queueFile,'utf8'));for(const entry of saved.entries){delete entry.version;entry.state=point.endsWith('pending')?'pending':'failed';}fs.writeFileSync(queueFile,JSON.stringify(saved));}
let q=new ProducerApprovalQueue('skill',queueFile);
const accept=(item,answer,delivery)=>{if(answer.behavior==='allow')execute('b',item.call.input,delivery);};q.bindAcceptance('switch_skill',accept,accept);
if(phase==='init'){
  const installed=skills.installSkill('b','learn:conversation',[{path:'SKILL.md',content:'---\nname: sample-skill\ndescription: Sample instructions\n---\nRead supplied notes.\n'}]);assert(!('error' in installed));
  if(action!=='turn_on')assert(!('error' in skills.setSkillEnabled('b','sample-skill',true)));
  fs.cpSync(join(root,'workspaces','b'),join(root,'fixture-saved-workspace'),{recursive:true});
  fs.cpSync(join(root,'skill-state','b'),join(root,'fixture-saved-state'),{recursive:true});
  const target=skills.readSkillSwitchTarget('b','sample-skill'),plan=planSkillSwitch(target.listing,target.text,action,'sample-skill',undefined,target);assert(plan.ok);
  const input={schema:1,botId:'b',threadId:'t',name:plan.name,action,skillSha256:plan.skillSha256,enabledBefore:plan.enabledBefore,source:plan.source,shared:plan.shared,
    scanContentHash:plan.scanContentHash,previewSha256:plan.previewSha256,verdictHash:plan.verdictHash};
  if(shape==='immediate')level='unlimited';
  const request=q.open({authority:{claim,proof:'trusted'},ref:'fixture-switch',epoch:'fixture-epoch',tool:'switch_skill',input,
    action:{requestId:'fixture-switch',tool:'switch_skill',options:[plan.allowLabel,'Deny'],skillRequest:{id:'fixture-switch',action,name:plan.name}},view:{title:'Fixture',subtitle:''},base:{approve:null,source:'no-grant'}});
  let result;
  if(shape==='immediate'){
    assert.equal(request.outcome.kind,'run');
    const operation=(call,delivery)=>execute('b',call.input,delivery);
    try{result=driver==='sync'?q.executeNow(request,operation):await q.execute(request,async(...args)=>operation(...args));}catch(error){assert(point.startsWith('C03'));result={error:error.message};}
  }else{
    assert.equal(request.outcome.kind,'card');const item=shape==='row-backed'?await q.present(request,request.outcome.ref):q.stage(request,request.outcome.ref);level='unlimited';
    result=driver==='sync'?q.respondNow(item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('level-upgrade')):await q.respond(item,{behavior:'allow'},{answerId:'fixture-answer'},automaticSettlement('level-upgrade'));
  }
  assert(point.startsWith('C03'));const item=q.approval(shape==='immediate'?'fixture-switch':q.pendingPage().items[0].approvalId);
  assert(item);restoreSkill();process.env.MURAGE_CRASH_PHASE='live-retry';
  assert.equal((await q.respond(item,{behavior:'allow'},{answerId:'fixture-live-retry'},automaticSettlement('replay'))).state,'unconfirmed');
  console.log('CRASH_FIXTURE '+JSON.stringify({phase,result}));
}else{
  restoreSkill();
  level='unlimited';
  if(point.startsWith('C05')){
    const saved=JSON.parse(fs.readFileSync(queueFile,'utf8'));
    for(let i=0;i<1024;i++){const id=`history-${i}`;saved.entries.push({state:'accepted',base:{approve:null,source:'no-grant'},item:{kind:'skill',ref:id,epoch:id,approvalId:id,proof:'trusted',view:{title:'History',subtitle:''},call:{tool:'stage_skill',input:{},approval:{queueRef:id,epoch:id,action:{requestId:id}}}}});}
    fs.writeFileSync(queueFile,JSON.stringify(saved));q=new ProducerApprovalQueue('skill',queueFile);q.bindAcceptance('switch_skill',accept,accept);
    const item=q.pendingPage().items.find(item=>item.call.tool==='switch_skill');assert(item);
    await assert.rejects(q.renew(item,{approvalId:'replacement',epoch:'replacement'}));await q.cancel(item,'superseded');q.updateProgress(item.ref,{projected:true});
  }
  const item=q.pendingPage().items.find(item=>item.call.tool==='switch_skill');assert(item);
  const source={kind:'skill',base:q.base,pendingApprovals:()=>q.pendingApprovals(),pendingPage:(...args)=>q.pendingPage(...args),approval:id=>q.approval(id),receipt:item=>q.receipt(item),
    reopen:item=>({kind:'service',service:'skill',claim,call:item.call}),respond:(...args)=>q.respond(...args),cancel:(...args)=>q.cancel(...args),renew:(...args)=>q.renew(...args)};
  const dispose=d.installQueueSources([source]);await d.recover();
  const result=driver==='sync'?q.respondNow(item,{behavior:'allow'},{answerId:'fixture-replay'},automaticSettlement('replay')):await q.respond(item,{behavior:'allow'},{answerId:'fixture-replay'},automaticSettlement('replay'));
  const manifest=JSON.parse(fs.readFileSync(join(root,'skill-state','b','skills.json'),'utf8'));
  const observations=fs.readFileSync(events,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  console.log('CRASH_FIXTURE '+JSON.stringify({phase,result,enabled:manifest['sample-skill'].enabled,observations}));dispose();
}
process.exit(0);
