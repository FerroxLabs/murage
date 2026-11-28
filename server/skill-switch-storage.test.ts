// Skills owns the executor; decision owns refusal before an unsupported durable store.
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA_DIR} from './config.ts';
import {fixture,d} from './decision/fixture.ts';
import * as skills from './skills.ts';
import * as atomic from './atomic.ts';
import {planSkillSwitch} from './skill-switch.ts';
import {createOwnerSettlementRegistry,automaticSettlement} from './skill-switch-settlement.ts';
import {createSkillSwitchExecutor} from './skill-switch-executor.ts';
import {ProducerApprovalQueue} from './narrow-denials.ts';
afterEach(()=>vi.restoreAllMocks());
it.each(['turn_on','turn_off','delete'].flatMap(action=>['async','sync','immediate-async','immediate-sync'].map(mode=>({action,mode}))))('unsupported storage refuses $mode $action before target I/O or effect',async({action,mode})=>{
  const host=fixture('ask');skills.installSkill('b','learn:conversation',[{path:'SKILL.md',content:'---\nname: sample-skill\ndescription: Sample instructions\n---\nRead supplied notes.\n'}]);
  const path=join(DATA_DIR,'skill-state','b','skills.json'),saved=JSON.parse(readFileSync(path,'utf8'));saved['sample-skill'].enabled=action!=='turn_on';writeFileSync(path,JSON.stringify(saved));
  const target=skills.readSkillSwitchTarget('b','sample-skill')!,plan=planSkillSwitch(target.listing,target.text,action as any,'sample-skill',undefined,target);if(!plan.ok)throw new Error(plan.error);
  const input={schema:1,name:plan.name,action,enabledBefore:plan.enabledBefore,skillSha256:plan.skillSha256,source:plan.source,shared:plan.shared,scanContentHash:plan.scanContentHash,previewSha256:plan.previewSha256,verdictHash:plan.verdictHash};
  const file=join(DATA_DIR,'fixture-unsupported-queue.json');let q=new ProducerApprovalQueue('skill',file);
  if(mode.startsWith('immediate'))host.setLevel('unlimited');
  const request=q.open({authority:{claim:host.claim,proof:'trusted'},ref:'fixture-operation',epoch:'fixture-epoch',tool:'switch_skill',input,
    action:{requestId:'fixture-operation',options:[plan.allowLabel,'Deny'],skillRequest:{id:'fixture-operation',action,name:plan.name}},view:{title:'Fixture',subtitle:''},base:{approve:null,source:'no-grant'}});
  if(!mode.startsWith('immediate')){if(request.outcome.kind!=='card')throw new Error('fixture requires a card');writeFileSync(file,JSON.stringify({version:1,entries:[{version:2,state:'waiting',base:request.base,item:{...request.item,approvalId:request.outcome.ref.approvalId}}]}));q=new ProducerApprovalQueue('skill',file);}
  host.setLevel('unlimited');
  const registry=createOwnerSettlementRegistry(),execute=createSkillSwitchExecutor(registry,{automatic:()=>d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits===true,owner:()=>false});
  q.bindAcceptance('switch_skill',(item,answer,delivery)=>{if(answer.behavior==='allow')execute('b',item.call.input as any,delivery);},(item,answer,delivery)=>{if(answer.behavior==='allow')execute('b',item.call.input as any,delivery);});
  const read=vi.spyOn(skills,'readSkillSwitchTarget'),effect=vi.spyOn(skills,'applySkillSwitchTarget');vi.spyOn(atomic,'syncParentDirectoryStatus').mockReturnValue('unsupported');
  try{
    if(mode==='immediate-sync')expect(()=>q.executeNow(request,(call,delivery)=>execute('b',call.input as any,delivery))).toThrow(/storage/);
    else if(mode==='immediate-async')await expect(q.execute(request,async(call,delivery)=>execute('b',call.input as any,delivery))).rejects.toThrow(/storage/);
    else {const item=q.pendingPage().items[0]!,answer={behavior:'allow' as const},options={answerId:'fixture-answer'};expect(mode==='sync'?q.respondNow(item,answer,options,automaticSettlement()):await q.respond(item,answer,options,automaticSettlement())).toMatchObject({state:'not-run',code:'storage'});}
    expect(read).not.toHaveBeenCalled();expect(effect).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(path,'utf8'))).toEqual(saved);
  }finally{host.dispose();}
});
it('a skill deleted and installed again with changed content can be deleted again',()=>{
  const host=fixture('ask');
  const install=(body:string)=>skills.installSkill('b','learn:conversation',[{path:'SKILL.md',content:`---\nname: sample-skill\ndescription: Sample instructions\n---\n${body}\n`}]);
  const remove=()=>{const target=skills.readSkillSwitchTarget('b','sample-skill')!;skills.prepareSkillSwitch(target,'delete');skills.applySkillSwitchTarget(target,'delete');};
  try{
    install('Read supplied notes.');remove();
    install('Read different supplied notes.');
    expect(()=>remove()).not.toThrow();
    expect(skills.readSkillSwitchTarget('b','sample-skill')).toBeUndefined();
  }finally{host.dispose();}
});
