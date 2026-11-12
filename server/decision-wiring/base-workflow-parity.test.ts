// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { wiring, source } from './fixture.ts';
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

it('MCP execution uses the registered server description after validating the current revision',()=>{
  const registered={command:'fixture-command'},other={command:'substituted-command'},enable=vi.fn(()=>null);
  const {executeIndexMcp}=wiring(['executeIndexMcp'],{cfg:{mcpServers:{}},resolveMcpCard:()=>({ok:true,server:other}),enableMcpServer:enable});
  executeIndexMcp({tool:'add_mcp_server',input:{name:'fixture',revision:'revision',server:registered}});
  expect(enable).toHaveBeenCalledWith('fixture',registered);
});
