// SPDX-License-Identifier: AGPL-3.0-or-later
/** Synchronous driver preflight. Identity comes from the live decision core;
 * inspection uses the same owner evidence as registered decisions. This does
 * not mint an ApprovalRef: a held request continues through normal ingress. */
import { describeOwnerNoLimits, wipeEvidence } from './decision/action.ts';
export interface ApprovalContext {level:{autoApprove?:boolean;fullAccess?:boolean;noLimits?:boolean};actor:{kind:'owner'|'owner-routine'|'other'}}
let contextOf: (threadId:string,botId?:string)=>ApprovalContext=()=>({level:{},actor:{kind:'other'}});
export function setApprovalContextReader(reader:typeof contextOf):void{contextOf=reader;}
export function approvalContext(threadId:string,botId?:string):ApprovalContext{return contextOf(threadId,botId);}
export function approvalDecision(threadId:string,tool:string,input:unknown,baseAsk=true,denyRule?:string,botId?:string):{verdict:'card'|'run';cls:'cut'|'';approve:string|null}{
 const held={verdict:'card' as const,cls:'cut' as const,approve:null};
 if(!baseAsk&&!denyRule)return {verdict:'run',cls:'',approve:'existing permission'};
 try {
  const {level,actor}=approvalContext(threadId,botId);
  if((actor.kind!=='owner'&&actor.kind!=='owner-routine')||!level.autoApprove||!level.fullAccess||!level.noLimits)return held;
  const action=describeOwnerNoLimits({tool,input},{wipeOnly:true});
  if(wipeEvidence(action).length)return held;
  return {verdict:'run',cls:'',approve:'no-limits'};
 } catch {return held;}
}
