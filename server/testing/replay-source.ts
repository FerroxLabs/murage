// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only: importers are pinned by the decision inventory.
import { installProvenanceReader,installRequestIngress,openRequest } from '../decision/index.ts';
import type { ReplayFixtureRequest,RequestHandle } from '../decision/index.ts';
export function openReplayRequest(fixture:ReplayFixtureRequest):RequestHandle {
 const {event,provenance:p,level}=fixture;
 if(!event.turnId||!event.providerInstanceId||!event.requestId)throw new Error('incomplete-replay-identity');
 const {turnId,providerInstanceId,requestId}=event;
 installProvenanceReader({turnGenerationFor:t=>t===p.threadId?p.generation:undefined,provenance:g=>g===p.generation?p:undefined,live:t=>t===p.threadId?{botId:p.botId,turnId,providerInstanceId,principal:p.principal,owner:p.initiator.k==='owner-typed'||p.initiator.k==='owner-channel-dm'||'form'in p.initiator,level,...('form'in p.initiator?{routine:{sourceRunId:p.initiator.sourceRunId,sourceBotId:p.initiator.sourceBotId,recipientGeneration:p.generation,owner:true}}:{})}:undefined});
 const dispose=installRequestIngress({subscribe(listener){listener(event);return()=>{};}});dispose();
 return openRequest({kind:'engine',threadId:p.threadId,requestId});
}
