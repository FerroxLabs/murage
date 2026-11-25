// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ApprovalAnswer, ServiceCall } from './types.ts';
export interface NativeReleaseIdentity { readonly threadId:string;readonly requestId:string;readonly turnId:string;readonly providerInstanceId:string }
type NativeReleaseReader=(identity:NativeReleaseIdentity,updatedInput?:ApprovalAnswer['updatedInput'],replay?:ServiceCall)=>boolean;
let reader:NativeReleaseReader|undefined;
let permissionReplyHold:((identity:NativeReleaseIdentity,line:string)=>boolean|'deny')|undefined;
let heldReader:((identity:NativeReleaseIdentity)=>boolean)|undefined;
/** Installed by the authoritative S1 host, never by a tool or provider payload. */
export function installNativeReleaseReader(next:NativeReleaseReader,held?:(identity:NativeReleaseIdentity)=>boolean,replyHold?:(identity:NativeReleaseIdentity,line:string)=>boolean|'deny'):void {reader=next;heldReader=held;permissionReplyHold=replyHold;}
export function nativeReleaseHeld(identity:NativeReleaseIdentity):boolean {try{return heldReader?.(identity)===true;}catch{return false;}}
export function guardEngineRelease(identity:NativeReleaseIdentity,updatedInput?:unknown,replay?:ServiceCall):boolean {
 try{return reader?.(identity,updatedInput as ApprovalAnswer['updatedInput'],replay)===true;}catch{return false;}
}

/** A provider transport hold is visible and keeps the native ask pending. */
export function holdEnginePermissionReply(identity:NativeReleaseIdentity,line:string):boolean {
 try{return permissionReplyHold?.(identity,line)===true;}catch{return false;}
}
/** cause22 caps r3: what a changed allow too large for the engine's reply cap becomes. `card` = held with a deny-only card
 * (a turn below No limits), `deny` = the owner's turn: the driver denies that ONE ask with a fixed note and the turn goes on,
 * `none` = no live ask to act on. A size cap never ends the owner's turn. */
export function settleOversizePermissionReply(identity:NativeReleaseIdentity,line:string):'card'|'deny'|'none' {
 try{const how=permissionReplyHold?.(identity,line);return how===true?'card':how==='deny'?'deny':'none';}catch{return 'none';}
}
