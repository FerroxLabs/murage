// SPDX-License-Identifier: AGPL-3.0-or-later
// S5 authority controls: all commands are inert reader inputs, never executed.
import {mkdtempSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {autoVerdict, realKeyPaths} from '../auto-approve.ts';
import {commandFolderRefusal} from '../command-folder.ts';
import {noLimitsProtectedWrite} from '../no-limits-protected.ts';
import {featureOffLine} from '../feature-off.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {fixture, d, baseCard, baseRun, card} from './fixture.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
const shapes=['archive destination','archive member','unknown cwd suffix','link write-through','uncertain link placement','archive projection exhaustion','native write'] as const;
type Shape=typeof shapes[number];
function sample(shape:Shape) {
 let command:string|undefined,cwd:string|undefined='/w';
 switch(shape){
  case 'archive destination': command='tar -xf /tmp/a.tar -C /etc';break;
  case 'archive member': command='tar -xPf /tmp/a.tar ../etc/hosts';break;
  case 'unknown cwd suffix': command='cd /nope; tar -xf a.tar -C etc';cwd=undefined;break;
  case 'link write-through': {
   cwd=mkdtempSync(join(tmpdir(),'s5-authority-link-'));roots.push(cwd);symlinkSync('/etc',join(cwd,'h'));
   command='ln -sf /tmp/blob ./h';break;
  }
  case 'uncertain link placement': {
   cwd=mkdtempSync(join(tmpdir(),'s5-authority-uncertain-'));roots.push(cwd);symlinkSync('/etc',join(cwd,'h'));
   command='d=.; ln -sf /tmp/blob "$d"/h*';break;
  }
  case 'archive projection exhaustion': command=`tar -tf /tmp/a.tar ${'-C {a,b} '.repeat(14)}`;break;
  case 'native write': break;
 }
 const tool=command===undefined?'write_file':'Bash';
 const input=command===undefined?{path:'/etc/profile',content:'fake-only'}:{command,...(cwd?{cwd}:{})};
 const summary=command??'/etc/profile';
 const base=vi.fn((r:d.Registration)=>(command!==undefined&&cwd===undefined?commandFolderRefusal(input,cwd):null)??autoVerdict({autoApprove:r.level!=='ask',fullAccess:r.level==='full'||r.level==='unlimited',noLimits:r.level==='unlimited'},tool,summary,{
  fullAccessOrigin:r.actor==='owner'?'owner':r.actor==='owner-routine'?'routine':'other',
  routineLevel:r.actor==='owner-routine',commandText:command,commandCwd:cwd,workFolder:cwd,
  stopLine:null,outsideRead:null,call:{engine:'claude',toolCall:{name:tool,input}},
  ...(()=>{const {paths,cannot}=realKeyPaths(input,undefined,cwd);return {realPaths:paths,...(cannot?{realPathCannot:cannot}:{})};})(),
 }));
 return {base,command,cwd,open:(f:ReturnType<typeof fixture>,id='protected')=>f.open(id,input,{tool,toolCall:{name:tool,input}})};
}
const untrusted=['guest','other-human','shared room','missing provenance','stale generation','other thread','other bot','unknown initiator','unbound routine'] as const;
type Scenario=typeof untrusted[number]|'owner'|'routine ask'|'routine full';
function setup(scenario:Scenario) {
 const f=fixture('unlimited');
 const bot=f.store.createBot({name:'S5 authority fixture'},{seedMessages:false});
 f.store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true});
 const routine=scenario.startsWith('routine ')||scenario==='unbound routine';
 const initiator:d.Initiator=routine?{k:'routine-run',form:'run',sourceRunId:'run',sourceBotId:bot.id,recipientGeneration:'g',trigger:'schedule'}:
  scenario==='guest'||scenario==='other-human'?{k:scenario}:{k:'owner-typed'};
 const provenance:d.TurnProvenance={generation:scenario==='stale generation'?'old':'g',threadId:scenario==='other thread'?'elsewhere':'t',botId:scenario==='other bot'?'elsewhere':bot.id,principal:'owner',roomOwnerOnly:scenario!=='shared room',at:1,initiator};
 if(scenario==='unknown initiator')Object.assign(provenance,{initiator:{k:'unknown'}});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>scenario==='missing provenance'?undefined:provenance,
  live:()=>({botId:bot.id,turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,
   level:scenario==='routine ask'?'ask':scenario==='routine full'?'full':'unlimited',
   ...(routine?{routine:{owner:true,sourceRunId:scenario==='unbound routine'?'wrong':'run',sourceBotId:bot.id,recipientGeneration:'g'}}:{}),
  })});
 return f;
}
for(const scenario of untrusted)it.each(shapes)(`S5 ${scenario} keeps Ask for %s`,async shape=>{
 const f=setup(scenario),row=sample(shape);
 try{
  expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({level:'ask'});
  const ref=card(d.decide(row.open(f),row.base));await d.presentApproval(ref,{title:'Protected write',subtitle:shape});
  expect(d.readApproval(ref.approvalId)).toMatchObject({level:'ask',state:'open'});
  const directDeny=shape==='native write'&&!['guest','other-human','shared room'].includes(scenario);
  if(directDeny){expect(row.base).not.toHaveBeenCalled();expect(d.readApproval(ref.approvalId)).toMatchObject({why:'deny',actor:'unproven'});}
  else{expect(row.base).toHaveBeenCalledTimes(2);expect(row.base.mock.calls[0]![0]).toMatchObject({level:'ask'});expect(row.base.mock.results[0]!.value.approve).toBeNull();}
  expect(f.respond).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
for(const level of ['ask','full'] as const)it.each(shapes)(`S5 explicit routine ${level} survives a No limits bot for %s`,shape=>{
 const f=setup(`routine ${level}`),row=sample(shape);
 try{
  expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({actor:'owner-routine',level});
  expect(d.decide(row.open(f),row.base).kind).toBe('card');
  expect(row.base).toHaveBeenCalledOnce();expect(row.base.mock.calls[0]![0]).toMatchObject({actor:'owner-routine',level});
  expect(row.base.mock.results[0]!.value.approve).toBeNull();expect(f.respond).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
it.each(shapes)('S5 authenticated owner runs %s without a card',async shape=>{
 const f=setup('owner'),row=sample(shape);
 try{
  const handle=row.open(f);expect(d.decide(handle,row.base)).toEqual({kind:'run'});
  await d.deliverRequest(handle);expect(f.respond).toHaveBeenCalledOnce();
  expect(f.respond.mock.calls[0]![1].behavior).toBe('allow');expect(d.openApprovals('t')).toEqual([]);
  expect(row.base).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
it.each(shapes.slice(0,4))('S5 Full access still cards a real %s',shape=>{
 const f=fixture('full'),row=sample(shape);
 try{
  expect(d.decide(row.open(f),row.base).kind).toBe('card');expect(row.base).toHaveBeenCalledOnce();
  // MAIN RULING INT-CONFLICT-DEFAULT 661854e833 / ee7826ac02: an unknown directory alone supplies no named protected suffix; the normal BASE card above stays.
  const protectedHit=noLimitsProtectedWrite(row.command!,{commandCwd:row.cwd});
  if(shape==='unknown cwd suffix')expect(protectedHit).toBeNull();
  else expect(protectedHit).toMatchObject({rule:'protected-path'});
  expect(row.base.mock.results[0]!.value.approve).toBeNull();
 }finally{f.dispose();}
});
it.each([
 ['Bash','rm -rf ~'],['PowerShell','Remove-Item -Recurse C:\\'],['Bash','rm -rf /'],
])('S5 owner wipe still cards: %s %s',async(tool,command)=>{
 const f=setup('owner'),input={command};
 try{
  const ref=card(d.decide(f.open('wipe',input,{tool,toolCall:{name:tool,input}}),baseRun));
  await d.presentApproval(ref,{title:'Wipe control',subtitle:command});
  expect(d.readApproval(ref.approvalId)).toMatchObject({why:'wipe',state:'open'});expect(f.respond).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
it('S5 feature off refuses once with one line and zero approvals',async()=>{
 const f=setup('owner'),line='Browser control is off. Turn it on in the bot’s Browser settings.';
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Fixture'}),featureOff:(_t,_b,tool)=>featureOffLine(tool,{browser:false})});
 try{
  const input={selector:'#fixture'},handle=f.open('off',input,{tool:'agent_browser_click',toolCall:{name:'agent_browser_click',input}});
  expect(d.decide(handle,baseCard)).toEqual({kind:'refuse',message:line});
  await d.deliverRequest(handle);await d.deliverRequest(handle);
  expect(d.openApprovals('t')).toEqual([]);expect(f.respond).toHaveBeenCalledOnce();
  expect(f.respond.mock.calls[0]![1]).toMatchObject({behavior:'deny',message:line});
  expect(f.db.prepare("SELECT text FROM messages WHERE thread_id='t' AND kind='text'").all()).toEqual([{text:line}]);
 }finally{f.dispose();}
});

for(const shape of ['uncertain link placement','archive projection exhaustion'] as const)it(`S5 authenticated Full access owner holds ${shape}`,()=>{
 const f=fixture('full'),row=sample(shape);
 try{
  expect(d.decide(row.open(f),row.base).kind).toBe('card');
  expect(row.base).toHaveBeenCalledOnce();
  expect(row.base.mock.results[0]!.value.approve).toBeNull();
  expect(f.respond).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
