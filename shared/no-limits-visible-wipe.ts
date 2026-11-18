// SPDX-License-Identifier: AGPL-3.0-or-later
// In-process fallback. Owner adapter: c3-nl-b; owner checker: wipe-fable.
// The Pi extension's separately owned inline floor must not inline this Node
// adapter. No renderer imports this module; use the same synchronous v3 facade
// as the decision/release paths rather than maintaining another shell parser.
import {wipeBreaker,nativeWipeBreaker,type WipeContext} from '../server/wipe-breaker.ts';
export type VisibleWipeContext=WipeContext;
export type VisibleWipeRule='delete-root'|'delete-home'|'delete-system-folder'|'disk-erase'|'fork-bomb'|'wipe-check-fault';
type LegacyDialect='posix'|'powershell'|'cmd';
const contextOf=(home:string|VisibleWipeContext,dialect?:LegacyDialect,cwd?:string,context?:VisibleWipeContext):VisibleWipeContext=>typeof home==='string'
 ? {home,cwd,...(/^(?:[a-z]:|\\\\)/i.test(home)?{platform:'win32' as const}:{}),...(dialect?{dialect:dialect==='powershell'?'pwsh':dialect==='posix'?'sh':'cmd'}:{}),...context}
 : home;
const ruleOf=(hit:ReturnType<typeof wipeBreaker>):VisibleWipeRule|null=>{
 if(!hit)return null;
 switch(hit.rule){
  case 'delete-root':case 'delete-home':case 'delete-system-folder':case 'disk-erase':case 'fork-bomb':case 'wipe-check-fault':return hit.rule;
  default:return 'wipe-check-fault';
 }
};
/** Pass the execution host's full context, including its engine env (or
 * undefined when unavailable). Never substitute this process's environment.
 * Positional arguments remain compatible with older in-process consumers. */
export function visibleWipe(text:string,home:string|VisibleWipeContext,_depth=0,dialect?:LegacyDialect,cwd?:string,context?:VisibleWipeContext):VisibleWipeRule|null {
 try{return ruleOf(wipeBreaker(text,contextOf(home,dialect,cwd,context)));}
 catch{return 'wipe-check-fault';}
}
/** Native deletion stays a native effect; a quoted shell string can change
 * Windows backslashes, wildcard provenance and literal tilde semantics. */
export function visibleDeleteTarget(path:string,home:string|VisibleWipeContext,cwd?:string,context?:VisibleWipeContext):VisibleWipeRule|null {
 try{return ruleOf(nativeWipeBreaker('delete_file',{path},contextOf(home,undefined,cwd,context)));}
 catch{return 'wipe-check-fault';}
}
