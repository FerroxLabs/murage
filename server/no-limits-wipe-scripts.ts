// SPDX-License-Identifier: AGPL-3.0-or-later
import { isAbsolute } from 'node:path';
import { wipeBreaker, type WipeContext } from './wipe-breaker.ts';
import { wipeContextFor, degradedWipeContext } from './wipe/context.ts';
import { outsideTurnKey, runningOutsideInstance, currentTurnEdits, recordCurrentTurnEdits, turnBegunAt, sessionEdits } from './email/external-marks.ts';

const emptyFiles:ReadonlySet<string>=new Set();
/** Record allowed write attempts in the live turn journal. */
export function noteTurnScriptWrites(thread:string,provider:string,turn:string,paths:readonly string[]):void {
 recordCurrentTurnEdits(thread,provider,turn,paths.filter(path=>isAbsolute(path)));
}
/** Return current-turn journal entries without probing history. These entries
 * do not affect the narrow breaker, which never opens executable files. */
export function authenticatedTurnWrittenScripts(threadId:string,providerInstanceId:string,turnId:string):ReadonlySet<string>|undefined {
 const begun=turnBegunAt(threadId);
 if(outsideTurnKey(threadId)!==turnId||runningOutsideInstance(threadId)!==providerInstanceId||begun===undefined)return undefined;
 const files=currentTurnEdits(threadId,providerInstanceId,turnId);
 return files;
}
/** OVERREACH #6: the scripts the running session wrote, for the wipe check on a command that runs one. Nothing when no session is running. */
export function sessionScriptContext(threadId:string):Pick<WipeContext,'sessionEdits'> {
 try{const instance=runningOutsideInstance(threadId);return instance?{sessionEdits:sessionEdits(threadId,instance)}:{};}catch{return {};}
}
export function turnWrittenScripts(threadId:string,providerInstanceId:string,turnId:string):ReadonlySet<string> {
 return authenticatedTurnWrittenScripts(threadId,providerInstanceId,turnId)??emptyFiles;
}
/** Compatibility probe: recovery uses the same narrow breaker, with no
 * executable allowlist, eval resolution, or included-file reads. */
export function recoveryExecutesScript(text:string,context:WipeContext=wipeContextFor('','',degradedWipeContext())):boolean { return wipeBreaker(text,context)!==null; }

interface RecoveryRequest {threadId:string;providerInstanceId:string;turnId:string;requestId:string}
const recoveryRequests=new Set<string>();
const recoveryKey=(request:RecoveryRequest)=>JSON.stringify([request.threadId,request.providerInstanceId,request.turnId,request.requestId]);
/** Host-only registration: no provider input or serialized flag can set this. */
export function registerRecoveryScriptRequest(request:RecoveryRequest):()=>void {
 const key=recoveryKey(request);recoveryRequests.add(key);return ()=>{recoveryRequests.delete(key);};
}
export function isRecoveryScriptRequest(request:RecoveryRequest):boolean{return recoveryRequests.has(recoveryKey(request));}

/** Retired file-reader surface retained for integrations compiled during this train.
 * The narrow breaker inspects only the submitted command, never included files. */
export function* writtenScriptTexts(_commands:Iterable<{words:string[];program:string;args:string[];cwd?:string;stdin?:string}>,_options:{cwd?:string;project?:string;files?:ReadonlySet<string>}):Generator<{text:string;lang:'sh'|'py'|'js'|'pwsh';cwd?:string;wipe:boolean}> {}
