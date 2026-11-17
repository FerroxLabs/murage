// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { wiring, source } from './fixture.ts';
import { mcpApprovalMatches, resolveMcpCard } from '../mcp-bot-cards.ts';
import { mcpEntryRev, type AnyStoredMcpServer } from '../mcp-registry.ts';
describe('BASE workflow boundary / H2',()=>{
  it.each(['run','card','question','refuse'])('%s follows the sole registered outcome',async kind=>{
    const calls:string[]=[];const ref={approvalId:'a'}; const handle={};
    const openRequest=vi.fn(()=>handle),decide=vi.fn(()=>({kind,ref,message:'refused'}));
    const { handleDecisionRequest }=wiring(['handleDecisionRequest'],{openRequest,decide,readRequestExecution:()=>({outcome:kind,delivery:'accepted',answer:{behavior:'allow'}}),baseEngineVerdict:vi.fn(),presentApproval:async()=>calls.push('present'),deliverRequest:async()=>calls.push('deliver'),decisionEngineView:()=>({title:'Approval needed',subtitle:'test'}),readApproval:()=>undefined});
    await handleDecisionRequest('t','r');
    expect(openRequest).toHaveBeenCalledWith({kind:'engine',threadId:'t',requestId:'r'});
    expect(calls).toEqual([kind==='card'||kind==='question'?'present':'deliver']);
  });
  it('native noLimits comes only from live S1 policy; BASE flags survive a miss',()=>{
    const baseline={routeAsks:true,stopLine:true,askLevel:'ask'};
    const { decisionPermissionNow }=wiring(['decisionPermissionNow'],{readTurnPolicy:()=>undefined});
    expect(decisionPermissionNow('t','g',baseline)).toEqual(baseline);
    const { decisionPermissionNow: live }=wiring(['decisionPermissionNow'],{readTurnPolicy:()=>({actor:'owner',permission:{...baseline,noLimits:true}})});
    expect(live('t','g',baseline).noLimits).toBe(true);
  });
  it('old redecision/fallback producers are gone, recovery precedes the sweep',()=>{
    expect(source.includes('approvalDecision(')).toBe(false);
    // M2 wires the compatibility consumers to live decision policy at boot.
    // It must be present even though the old inline redecision is gone.
    expect(source.includes('setApprovalContextReader(')).toBe(true);
    expect(source.includes('commandFolderVerdict(')).toBe(false);
    expect(source.includes('held: "Auto mode couldn\'t answer this one."')).toBe(false);
    expect(source.indexOf('await recover()')).toBeLessThan(source.indexOf('const cardSweepHigh ='));
  });
});

it('a final deny/re-presentation or unconfirmed delivery cannot be logged as approved',async()=>{
  for(const receipt of [{outcome:'card',delivery:'accepted',answer:{behavior:'deny'}},{outcome:'run',delivery:'unconfirmed',answer:{behavior:'allow'}},{outcome:'refuse',delivery:'accepted',answer:{behavior:'deny'}}]){
    const write=vi.fn();
    const {handleDecisionRequest}=wiring(['handleDecisionRequest'],{openRequest:()=>({}),decide:()=>({kind:'run'}),baseEngineVerdict:vi.fn(),deliverRequest:async()=>{},readRequestExecution:()=>receipt,store:{appendMessage:write}});
    await handleDecisionRequest('t','r',undefined,{summary:'command'});expect(write).not.toHaveBeenCalled();
  }
});

it('service acceptance uses the durable target and exact queue identity rather than serialized proof ids',()=>{
  const record={botId:'registered-bot',threadId:'registered-thread',queue:{kind:'skill',ref:'r',epoch:'e'}};
  const {indexItemIdentity}=wiring(['indexItemIdentity'],{readApproval:()=>record,connectorThread:()=>({})});
  const item={approvalId:'approval',kind:'skill',ref:'r',epoch:'e',proof:{botId:'substituted-bot',threadId:'substituted-thread'}};
  expect(indexItemIdentity(item)).toEqual({botId:'registered-bot',threadId:'registered-thread'});
  expect(()=>indexItemIdentity({...item,ref:'different-request'})).toThrow();
});

it('MCP execution enables the current entry, resolved at the card revision, never a different server',()=>{
  // MAIN RULING 1115-SOURCE-PINS-GROK A5: the revision AND registered execution shape and key names must match.
  const registered={command:'fixture-command',args:['--serve'],env:{},enabled:false,pendingEnv:['FIXTURE_KEY']} as unknown as AnyStoredMcpServer;
  const rev=mcpEntryRev('fixture',registered);
  const enable=vi.fn((_name:string,_server:AnyStoredMcpServer)=>null as string|null);
  const run=(servers:Record<string,unknown>)=>wiring(['executeIndexMcp'],{cfg:{mcpServers:servers},resolveMcpCard,mcpApprovalMatches,enableMcpServer:enable}).executeIndexMcp!({tool:'add_mcp_server',input:{name:'fixture',revision:rev,server:registered}});
  // unchanged entry: the enabled server's command and key names equal the registered entry at the card's revision
  run({fixture:registered});
  expect(enable).toHaveBeenCalledTimes(1);
  const [name,enabledServer]=enable.mock.calls[0]!;
  expect(name).toBe('fixture');
  const enabled=enabledServer as unknown as {command:string;args:string[];pendingEnv?:string[];env:Record<string,string>};
  expect(enabled.command).toBe('fixture-command');
  expect(enabled.args).toEqual(['--serve']);
  expect([...Object.keys(enabled.env),...(enabled.pendingEnv??[])].sort()).toEqual(['FIXTURE_KEY']);
  expect(mcpEntryRev('fixture',enabledServer)).toBe(rev);
  // a changed command or args (what the revision pins): refused at the revision, nothing enabled (no silent swap to a different server)
  enable.mockClear();
  for(const changed of [{...registered,command:'substituted-command'},{...registered,args:['--other']}])
    expect(()=>run({fixture:changed})).toThrow('decision-mcp-revision-changed');
  expect(()=>run({})).toThrow('decision-mcp-revision-changed');
  expect(enable).not.toHaveBeenCalled();
  // the enable refusal itself still throws its reason
  enable.mockReturnValueOnce('Enter FIXTURE_KEY on its card before turning fixture on.');
  expect(()=>run({fixture:registered})).toThrow('Enter FIXTURE_KEY');
});

// MAIN RULING 1115-SOURCE-PINS-GROK A5: a same-revision credential key swap must refuse.
it('MCP execution refuses changed env and header key names even at the same revision',()=>{
  const entries:AnyStoredMcpServer[]=[
    {command:'fixture-command',args:[],env:{FIXTURE_KEY:'fixture-value'},enabled:false},
    {url:'https://fixture.invalid/mcp',transport:'http',auth:'header',headers:{'X-Fixture-Key':'fixture-value'},enabled:false},
  ];
  for(const registered of entries){
    const revision=mcpEntryRev('fixture',registered);
    const changed='command' in registered ? {...registered,env:{OTHER_KEY:'fixture-value'}} : {...registered,headers:{'X-Other-Key':'fixture-value'}};
    expect(mcpEntryRev('fixture',changed as AnyStoredMcpServer)).toBe(revision);
    const enable=vi.fn();
    const {executeIndexMcp}=wiring(['executeIndexMcp'],{cfg:{mcpServers:{fixture:changed}},resolveMcpCard,mcpApprovalMatches,enableMcpServer:enable});
    expect(()=>executeIndexMcp!({tool:'add_mcp_server',input:{name:'fixture',revision,server:registered}})).toThrow('decision-mcp-revision-changed');
    expect(enable).not.toHaveBeenCalled();
  }
});

// MAIN RULING 1115-SOURCE-PINS-GROK A5: same slots may become ready, but no target or slot may be substituted.
it('MCP approval preserves credential readiness transitions and refuses every execution-shape change',()=>{
  const entries:AnyStoredMcpServer[]=[
    {command:'fixture-command',args:['--serve'],env:{},pendingEnv:['FIXTURE_KEY'],enabled:false},
    {url:'https://fixture.invalid/mcp',transport:'http',auth:'header',headers:{},pendingHeaders:['X-Fixture-Key'],enabled:false},
  ];
  for(const registered of entries){
    const revision=mcpEntryRev('fixture',registered);
    const enable=vi.fn();
    const run=(current:AnyStoredMcpServer)=>wiring(['executeIndexMcp'],{cfg:{mcpServers:{fixture:current}},resolveMcpCard,mcpApprovalMatches,enableMcpServer:enable})
      .executeIndexMcp!({tool:'add_mcp_server',input:{name:'fixture',revision,server:registered}});
    const ready:AnyStoredMcpServer='command' in registered
      ? {...registered,pendingEnv:[],env:{FIXTURE_KEY:'fixture-value'}}
      : {...registered,pendingHeaders:[],headers:{'X-Fixture-Key':'fixture-value'}};
    run(ready);
    expect(enable).toHaveBeenCalledExactlyOnceWith('fixture',expect.objectContaining('command' in ready ? {command:ready.command,env:ready.env} : {url:ready.url,headers:ready.headers}));
    enable.mockClear();
    const changes:AnyStoredMcpServer[]='command' in ready
      ? [{...ready,command:'other-command'},{...ready,args:['--other']},{...ready,env:{}},{...ready,env:{...ready.env,EXTRA_KEY:'fixture-value'}}]
      : [{...ready,url:'https://other.invalid/mcp'},{...ready,transport:'sse'},{...ready,auth:'none',headers:{}},{...ready,headers:{}},{...ready,headers:{...ready.headers,'X-Extra-Key':'fixture-value'}}];
    for(const changed of changes) expect(()=>run(changed)).toThrow('decision-mcp-revision-changed');
    expect(enable).not.toHaveBeenCalled();
  }
});
