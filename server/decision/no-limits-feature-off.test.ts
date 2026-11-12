import {expect,it,vi} from 'vitest';
import {d,fixture,baseCard} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
import {featureOffLine} from '../feature-off.ts';
for(const level of ['ask','auto','full','unlimited'] as const)
for(const [tool,settings,line] of [
 ['agent_browser_click',{browser:false},'Browser control is off. Turn it on in the bot’s Browser settings.'],
 ['mcp__browser__agent_browser_click',{browser:false},'Browser control is off. Turn it on in the bot’s Browser settings.'],
 ['host_computer',{computer:'off'},'Computer control is off. Turn it on in the bot’s Computer settings.'],
 ['COMPOSIO_MULTI_EXECUTE_TOOL',{composio:false},'Connected apps are disabled (off) for this bot. Turn them on in the bot’s Connected apps settings.'],
 ['mcp__murage_connectors__COMPOSIO_MULTI_EXECUTE_TOOL',{composio:false},'Connected apps are disabled (off) for this bot. Turn them on in the bot’s Connected apps settings.'],
 ['mcp__composio__fixture',{composio:false},'Connected apps are disabled (off) for this bot. Turn them on in the bot’s Connected apps settings.'],
] as const)it(`EARLY-OFF ${level} ${tool} never executes or cards and explains once`,async()=>{
 const f=fixture(level),execute=vi.fn(async()=>true);
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Fixture'}),featureOff:(_thread,_bot,name)=>featureOffLine(name,settings)});
 try{
  const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{...f.serviceCall({value:'fixture'}),tool}});
  expect(d.decide(h,baseCard)).toEqual({kind:'refuse',message:line});
  await d.executeService(h,execute);await d.executeService(h,execute);
  expect(execute).not.toHaveBeenCalled();expect(d.openApprovals('t')).toHaveLength(0);
  const messages=f.db.prepare("SELECT json FROM messages WHERE thread_id='t' AND kind='text'").all();
  expect(messages).toHaveLength(1);expect(JSON.stringify(messages)).toContain(line);
 }finally{f.dispose();}
});

it('EARLY-OFF cached native authority cannot run an off browser and questions remain available',async()=>{
 const f=fixture();d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Fixture'}),featureOff:(_t,_b,tool)=>featureOffLine(tool,{browser:false})});
 try{
  const h=f.open('off',{}, {tool:'agent_browser_click',toolCall:{name:'agent_browser_click',input:{}}});
  expect(d.decide(h,baseCard).kind).toBe('refuse');
  expect(guardEngineRelease({threadId:'t',requestId:'off',turnId:'turn',providerInstanceId:'p'},undefined,{tool:'agent_browser_click',input:{}})).toBe(false);
  await d.deliverRequest(h);
  const messages=f.db.prepare("SELECT text FROM messages WHERE thread_id='t' AND kind='text'").all();expect(messages).toHaveLength(1);expect(String(messages[0]!.text)).toContain('Browser settings');
  const uncaptured={threadId:'t',requestId:'uncaptured',turnId:'turn',providerInstanceId:'p'};
  for(let i=0;i<2;i++)expect(guardEngineRelease(uncaptured,undefined,{tool:'agent_browser_click',input:{}})).toBe(false);
  expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id='t' AND kind='text'").get()!.n).toBe(2);
  expect(d.decide(f.open('question',{}, {requestType:'question',questionTool:true}),baseCard).kind).toBe('question');
 }finally{f.dispose();}
});

it('EARLY-OFF channel messages off at No limits produces one line and no card or action',async()=>{
 const f=fixture(),execute=vi.fn(async()=>true);
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Fixture'}),featureOff:(_t,_b,tool)=>featureOffLine(tool,{noLimits:true,fullAccessChannelMessages:false},true,'owner-channel')});
 try{
  const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall({command:'printf fixture'})});
  expect(d.decide(h,baseCard).kind).toBe('refuse');await d.executeService(h,execute);await d.executeService(h,execute);
  expect(execute).not.toHaveBeenCalled();expect(d.openApprovals('t')).toHaveLength(0);
  const messages=f.db.prepare("SELECT text FROM messages WHERE thread_id='t' AND kind='text'").all();expect(messages).toHaveLength(1);expect(String(messages[0]!.text)).toContain('Permissions settings');
  expect(featureOffLine('Bash',{noLimits:false,fullAccessChannelMessages:false},true,'owner-channel')).toBeUndefined();
 }finally{f.dispose();}
});
