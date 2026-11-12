// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {fixture,d} from './decision/fixture.ts';
import {askOwnerToShare,SHARE_DRAFTS} from './room-shares.ts';
import {setExecutionStore} from './execution-audience.ts';
import {setMemoryCaptureRoster} from './memory/capture-scope.ts';
import {reconcileMemoryRoster} from './memory/policy.ts';
import {setMemoryMode} from './memory/repository.ts';
import {bindServiceTurn} from './service-no-limits.ts';
afterEach(()=>{setExecutionStore(undefined as never);setMemoryCaptureRoster(null);vi.restoreAllMocks();});
it('D5 pending share cap never refuses the next No limits request',()=>{
 const f=fixture('ask'),bot={id:'b',name:'Fixture',threadId:'direct',section:'Ops',tasks:[]},group={id:'room',name:'Fixture room',threadId:'t',section:'Ops',memberIds:['b'],tasks:[]};
 const roster={bots:[bot],groups:[group]} as any;
 setExecutionStore({...roster,bot:()=>bot,group:()=>group} as any);setMemoryCaptureRoster(()=>roster);setMemoryMode('active');reconcileMemoryRoster(roster);
 const authority={claim:f.claim,proof:'trusted',identity:{threadId:'t',generation:'g'}};
 for(let i=0;i<SHARE_DRAFTS;i++)expect(askOwnerToShare(f.db,roster,{authority,botId:'b',threadId:'t',query:'fixture',from:'both'}).ok).toBe(true);
 f.setLevel('unlimited');bindServiceTurn('g','t','b',()=>true,()=>({ownerAudience:true,origin:'owner',noLimits:true}));
 const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const next=askOwnerToShare(f.db,roster,{authority,botId:'b',threadId:'t',query:'fixture',from:'both'});
 expect(next).toMatchObject({ok:true,autoRun:true});expect(d.openApprovals('t')).toHaveLength(SHARE_DRAFTS);
 expect(log.mock.calls.flat().join('\n')).toMatch(/no-limits.*share.*(?:queue|capacity|cap)/i);f.dispose();
});
