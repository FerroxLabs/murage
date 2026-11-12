// SPDX-License-Identifier: AGPL-3.0-or-later
/** Transitional BASE adapter for consumers not yet integrated with S2/S4.
 * Cannot issue ApprovalRef or authorize a permission presentation. Remove after
 * those imports migrate; server/memory/authority.ts still imports this file. */
export interface ApprovalContext {level:{autoApprove?:boolean;fullAccess?:boolean;noLimits?:boolean};actor:{kind:'owner'|'owner-routine'|'other'}}
let contextOf: (threadId:string,botId?:string)=>ApprovalContext=()=>({level:{},actor:{kind:'other'}});
export function setApprovalContextReader(reader:typeof contextOf):void{contextOf=reader;}
export function approvalContext(threadId:string,botId?:string):ApprovalContext{return contextOf(threadId,botId);}
export function approvalDecision(_threadId:string,_tool:string,_input:unknown,baseAsk=true,_denyRule?:string,_botId?:string):{verdict:'card'|'run';cls:'cut'|'';approve:string|null}{return baseAsk?{verdict:'card',cls:'cut',approve:null}:{verdict:'run',cls:'',approve:'existing permission'};}
