// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ApprovalAnswer, ServiceCall } from './types.ts';
export interface NativeReleaseIdentity { readonly threadId:string;readonly requestId:string;readonly turnId:string;readonly providerInstanceId:string }
type NativeReleaseReader=(identity:NativeReleaseIdentity,updatedInput?:ApprovalAnswer['updatedInput'],replay?:ServiceCall)=>boolean;
let reader:NativeReleaseReader|undefined;
let heldReader:((identity:NativeReleaseIdentity)=>boolean)|undefined;
/** Installed by the authoritative S1 host, never by a tool or provider payload. */
export function installNativeReleaseReader(next:NativeReleaseReader,held?:(identity:NativeReleaseIdentity)=>boolean):void {reader=next;heldReader=held;}
export function nativeReleaseHeld(identity:NativeReleaseIdentity):boolean {try{return heldReader?.(identity)===true;}catch{return false;}}
export function guardEngineRelease(identity:NativeReleaseIdentity,updatedInput?:unknown,replay?:ServiceCall):boolean {
 try{return reader?.(identity,updatedInput as ApprovalAnswer['updatedInput'],replay)===true;}catch{return false;}
}
