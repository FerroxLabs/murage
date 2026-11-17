// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only: importers are pinned by the decision inventory.
import { installProvenanceReader,installRequestIngress,openRequest } from '../decision/index.ts';
import type { ReplayFixtureRequest,RequestHandle } from '../decision/index.ts';
export function openReplayRequest(fixture:ReplayFixtureRequest):RequestHandle {
 const {event,provenance:p,level,recovery={}}=fixture;
 if(!event.turnId||!event.providerInstanceId||!event.requestId)throw new Error('incomplete-replay-identity');
 const {turnId,providerInstanceId,requestId}=event;
 let liveLost=false;
 installProvenanceReader({ownerThread:recovery.ownerThread,turnGenerationFor:t=>t===p.threadId?p.generation:undefined,provenance:g=>g===p.generation?p:undefined,live:t=>!liveLost&&t===p.threadId?{botId:p.botId,turnId,providerInstanceId,principal:p.principal,owner:p.initiator.k==='owner-typed'||p.initiator.k==='owner-channel-dm'||'form'in p.initiator,level,...('form'in p.initiator?{routine:{sourceRunId:p.initiator.sourceRunId,sourceBotId:p.initiator.sourceBotId,recipientGeneration:p.generation,owner:true}}:{})}:undefined});
 const dispose=installRequestIngress({subscribe(listener){listener(event);return()=>{};}});dispose();
 const handle=openRequest({kind:'engine',threadId:p.threadId,requestId});
 // Preserve the fault's timing: capture/register with live state, then lose
 // only that surface before decision/delivery. The recovery reader survives.
 liveLost=Boolean(recovery.lostLiveRecord);
 return handle;
}
