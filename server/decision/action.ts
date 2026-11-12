import { extractInspectedOperation } from '../no-limits-operation.ts';
import { connectorWipes } from '../no-limits-wipe-tools.ts';
import { mcpBulkWipe, mcpWipeHint } from '../no-limits-wipe-mcp.ts';
import { turnWrittenScripts } from '../no-limits-wipe-scripts.ts';
import { sqlWipe } from '../no-limits-wipe-sql.ts';
import { noLimitsWipe } from '../no-limits-wipe.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { posix } from 'node:path';
import { readExecutable, readExecutableOwnerNl } from '../no-limits-code.ts';
import { classifyPath, quote } from '../no-limits-shell.ts';
import { ReaderBudget } from '../no-limits-budget.ts';
import { protectedClass } from '../always-ask.ts';
import { SENSITIVE_PATHS } from '../../shared/sensitive-paths.ts';
const MURAGE_HOOK_PATH = SENSITIVE_PATHS.find(row=>row.id==='murage-engine-hooks')!.re;
import { CONNECTED_APP_TOOLS } from '../../shared/bot-access.ts';
import type { RequestSnapshot,ServiceCall,ActionEvidence,DenyTarget,Evidence } from './types.ts';
import { resolveCall } from '../../shared/app-action-grant.ts';
import { connectedAppRequirements, dispatchedCall } from '../../shared/connected-app-calls.ts';
import { inspectOwnerTargets, type OwnerNlAuthority } from '../no-limits-authority.ts';
import { freeze, hash, CONTENT_FIELDS } from './bounds.ts';
import { isCommandTool, bareToolName } from '../../shared/grant-tool-names.ts';
import { inspectNoLimits, type OwnerProtectedDecision } from '../no-limits-taint.ts';
import type { OwnerNlDecision } from '../no-limits-authority.ts';
import { looksLikePowerShell } from '../shell/pwsh.ts';
import { inspectOwnerOperation } from '../no-limits-inspection.ts';

/** Add the complete resolver/taint decision before bounding any display paths.
 * The compatibility class/span fields never replace its identity or triggers. */
export function structuredOwnerDecision(decision:OwnerProtectedDecision):OwnerNlDecision & {readonly protectedDecision:OwnerProtectedDecision} {
 const source:OwnerNlDecision['source']=decision.reason==='alias-taint'?'taint':decision.reason==='protected-inode'?'inode':decision.reason==='effective-destination'?'effective-destination':decision.reason==='unknown-cwd-protected-suffix'?'unknown-cwd-protected-suffix':decision.physical&&decision.physical!==decision.lexical?'alias':'direct';
 return {kind:'deny',class:decision.protectedClass,ruleId:decision.ruleId,span:decision.lexical,source,resolution:decision.resolution.kind==='known'?'protected':'unknown',path:decision.lexical,...(decision.identity?{identity:decision.identity}:{}),protectedDecision:decision};
}
export function describe(input:RequestSnapshot|ServiceCall):ActionEvidence {
 const tool=input.tool,engine='event'in input?input.event:undefined;
 const resolved=engine?resolveCall({...engine,engine:engine.toolEngine}):undefined;
 const effective=resolved?.kind==='engine'?resolved.name:resolved?.kind==='mcp'?`mcp__${resolved.server}__${resolved.tool}`:tool;
 const payload=resolved?.kind==='engine'||resolved?.kind==='mcp'?resolved.input:input.input;
 const obj=payload&&typeof payload==='object'?payload as Record<string,any>:{};
 const executables:ActionEvidence['executables'][number][]=[],deletes:ActionEvidence['deletes'][number][]=[],targets:DenyTarget[]=[],content:{field:string}[]=[];
 const name=effective.toLowerCase(),budget=new ReaderBudget();
 const executable=/^(bash|shell|terminal|run_command|execute_command|start_process|run|powershell|pwsh|exec_command)$/i.test(effective)||engine?.toolKind==='execute'||/^mcp__(?:desktop[-_]commander|murage[-_]host[-_]computer|shell)__?(?:start_process|execute_command|run|bash|shell|terminal)$/.test(effective);
 const code=/^(execute_code|python|python3|node|javascript)$/i.test(effective);
 const rawCommand=typeof payload==='string'?payload:obj.command??obj.cmd??obj.script??obj.argv;
 const command=Array.isArray(rawCommand)&&rawCommand.every(v=>typeof v==='string')?rawCommand.map(quote).join(' '):rawCommand;
 const codeText=typeof payload==='string'?payload:obj.code??obj.script;
 const lang=code?(/node|javascript/.test(name)?'js':'py'):/powershell|pwsh/.test(name)?'pwsh':'sh';
 const text=code?codeText:executable?command:undefined;
 if(typeof text==='string'){
  executables.push({lang,text:text.slice(0,65536),from:code?'code':'command',...(typeof obj.cwd==='string'?{cwd:obj.cwd}:{})});
  const read=readExecutable(lang,text,budget);
  for(const cls of new Set(read.classes))if(['root','home','system','disk','fork'].includes(cls))deletes.push({path:cls,op:cls==='disk'?'overwrite-device':'delete'});
  for(const t of read.targets)targets.push({kind:'path',path:canonicalPath(t.path,obj.cwd),op:t.op});
 }
 // A routine's instruction field is the future action being scheduled. Its
 // named wipe effect remains evidence; descriptions and memory bodies are data.
 if(/^(?:schedule_routine|manage_routine)$/.test(effective)){
  const instructions=obj.routine?.instructions??obj.changes?.instructions;
  if(typeof instructions==='string'){
   const read=readExecutable('sh',instructions,budget);
   for(const cls of new Set(read.classes))if(['root','home','system','disk','fork'].includes(cls))deletes.push({path:cls,op:cls==='disk'?'overwrite-device':'delete'});
  }
 }
 const fileName=engine?.toolKind??effective;
 const fileOp=/^(write|edit|write_file|edit_file|delete|delete_file|read|read_file)$/i.test(fileName);
 if(fileOp){const op=/delete/i.test(fileName)?'delete':/read/i.test(fileName)?'read':'write';for(const path of [obj.file_path,obj.path,obj.filename,...(engine?.filePaths??[])])if(typeof path==='string'){
  targets.push({kind:'path',path:canonicalPath(path,obj.cwd),op});if(op==='delete'&&classifyPath(path))deletes.push({path,op:'delete'});
 }}
 if(/host.computer/i.test(tool)||engine?.approvalScope==='local-computer')targets.push({kind:'host-computer',scope:'local-computer'});
 if(/browser|navigate/i.test(tool)&&typeof (obj.url??obj.origin)==='string')try{targets.push({kind:'browser-site',origin:new URL(obj.url??obj.origin).origin.toLowerCase(),op:/navigate/.test(name)?'navigate':/read|snapshot/.test(name)?'read':'act'});}catch{}
 const dispatched=dispatchedCall(effective,payload);
 const appRows=dispatched.target==='COMPOSIO_MULTI_EXECUTE_TOOL'?connectedAppRequirements(payload,effective):[];
 const directSlug=obj.tool_slug??obj.toolSlug??obj.slug??obj.tool??effective;
 if(!appRows.length&&(CONNECTED_APP_TOOLS.some(x=>x.tool===effective)||/connected.?app|bot.?access/i.test(effective)))appRows.push({tool:directSlug,account:obj.accountId??obj.account});
 for(const row of appRows.slice(0,256)){
  const catalog=CONNECTED_APP_TOOLS.find(x=>x.tool===row.tool),toolkit=catalog?.toolkit??obj.toolkit??obj.app;
  if(typeof row.tool==='string'&&typeof toolkit==='string')targets.push({kind:'connected-app',toolkit,tool:row.tool,...(typeof row.account==='string'?{accountId:row.account}:{}),op:catalog?.writes?'write':'read'});
 }
 for(const field of Object.keys(obj))if(CONTENT_FIELDS.has(field))content.push({field});
 return freeze({tool,codeIdentity:hash({tool,executables}),executables,deletes,targets:targets.slice(0,256),content});
}
export function describeOwnerNoLimits(input:RequestSnapshot|ServiceCall, context:{cwd?:string;project?:string;home?:string;sessionEdits?:ReadonlySet<string>} = {}):ActionEvidence & {readonly ownerAuthority:OwnerNlAuthority} {
 const tool=input.tool,engine='event'in input?input.event:undefined;
 const resolved=engine?resolveCall({...engine,engine:engine.toolEngine}):undefined;
 const effective=resolved?.kind==='engine'?resolved.name:resolved?.kind==='mcp'?`mcp__${resolved.server}__${resolved.tool}`:tool;
 const payload=resolved?.kind==='engine'||resolved?.kind==='mcp'?resolved.input:input.input;
 const obj=payload&&typeof payload==='object'?payload as Record<string,any>:{};
 const executables:ActionEvidence['executables'][number][]=[],deletes:ActionEvidence['deletes'][number][]=[],targets:DenyTarget[]=[],content:{field:string}[]=[];
 const name=effective.toLowerCase();
 const cwd=typeof obj.cwd==='string'?obj.cwd:context.cwd;
 const decisions:OwnerNlAuthority['decisions'][number][]= [];let exhausted=false;
 const code=/^(execute_code|python|python3|node|javascript)$/i.test(effective);
 const executable=isCommandTool(effective)||engine?.toolKind==='execute'||/^(?:use_tool|exec|execute_command|start_process|run)$/.test(bareToolName(effective));
 const rawCommand=typeof payload==='string'?payload:obj.command??obj.cmd??obj.script??obj.argv;
 const command=Array.isArray(rawCommand)&&rawCommand.every(v=>typeof v==='string')?rawCommand.map(quote).join(' '):rawCommand;
 const codeText=typeof payload==='string'?payload:obj.code??obj.script;
 const lang=code?(/node|javascript/.test(name)?'js':'py'):/powershell|pwsh/.test(name)?'pwsh':'sh';
 const text=code?codeText:executable?command:undefined;
 const sessionEdits='event'in input?turnWrittenScripts(input.threadId,input.providerInstanceId,input.turnId):context.sessionEdits;
 if(typeof text==='string'){
  executables.push({lang,text:text.slice(0,65536),from:code?'code':'command',...(typeof obj.cwd==='string'?{cwd:obj.cwd}:{})});
  const wipe=noLimitsWipe(text,{...context,cwd,lang,shell:lang==='pwsh'?'pwsh':undefined,unread:engine?.toolInputTruncated===true,unseen:{sessionEdits}});
  if(wipe)deletes.push({path:({'delete-root':'root','delete-home':'home','delete-system-folder':'system','disk-erase':'disk','fork-bomb':'fork'} as Record<string,string>)[wipe.rule]??'word',op:'delete'});
  let read: ReturnType<typeof readExecutableOwnerNl>;
  try {read=readExecutableOwnerNl(lang,text,undefined,0,cwd);}catch {read={classes:[],targets:[],authority:{version:1,decisions:[],exhausted:true}};}

  decisions.push(...read.authority.decisions);exhausted ||= read.authority.exhausted;
  if(lang==='sh'||lang==='pwsh'){
   const dialect=lang==='pwsh'?'pwsh':looksLikePowerShell(text)==='cmd'||/^\s*(?:mklink|fsutil)\b/i.test(text)?'cmd':'sh';
   const inspection=inspectOwnerOperation({kind:'exec',text,dialect,cwd:obj.cwd,cwdInvalid:obj.cwdInvalid===true});
   decisions.push(...inspection.decisions.map(structuredOwnerDecision));
  }else{
   const inspection=inspectOwnerOperation({kind:'code',lang,text,cwd:obj.cwd,cwdInvalid:obj.cwdInvalid===true});
   decisions.push(...inspection.decisions.map(structuredOwnerDecision));
  }
  // Compatibility reader classes do not invent catastrophe evidence.
  for(const t of read.targets)targets.push({kind:'path',path:canonicalPath(t.path,cwd),op:t.op});
 }
 // A routine's instruction field is the future action being scheduled. Its
 // named wipe effect remains evidence; descriptions and memory bodies are data.
 if(/^(?:schedule_routine|manage_routine)$/.test(effective)){
  const instructions=obj.routine?.instructions??obj.changes?.instructions;
  if(typeof instructions==='string'){
   const wipe=noLimitsWipe(instructions);
   if(wipe)deletes.push({path:({'delete-root':'root','delete-home':'home','delete-system-folder':'system','disk-erase':'disk','fork-bomb':'fork'} as Record<string,string>)[wipe.rule]??'word',op:'delete'});
   let read: ReturnType<typeof readExecutableOwnerNl>;
   try {read=readExecutableOwnerNl('sh',instructions);}catch {read={classes:[],targets:[],authority:{version:1,decisions:[],exhausted:true}};}

   decisions.push(...read.authority.decisions);exhausted ||= read.authority.exhausted;
   // The shared noLimitsWipe result above is authoritative; compatibility classes alone do not add a wipe.
  }
 }
 if(typeof text!=='string' && engine?.summary && executable){
  const wipe=noLimitsWipe(engine.summary,{unread:true});
  if(wipe)deletes.push({path:({'delete-root':'root','delete-home':'home','delete-system-folder':'system','disk-erase':'disk','fork-bomb':'fork'} as Record<string,string>)[wipe.rule]??'word',op:'delete'});
 }
 const fileName=engine?.toolKind??effective;
 const fileOp=/^(write|edit|write_file|edit_file|delete|delete_file|read|read_file)$/i.test(fileName);
 if(fileOp){const op=/delete/i.test(fileName)?'delete':/read/i.test(fileName)?'read':'write';for(const path of [obj.file_path,obj.path,obj.filename,...(engine?.filePaths??[])])if(typeof path==='string'){
  const read=inspectOwnerTargets([{path,op}],cwd);
  decisions.push(...read.decisions);exhausted ||= read.exhausted;
  if(op!=='read')decisions.push(...inspectNoLimits({kind:'native',cwd,cwdInvalid:obj.cwdInvalid===true,effects:[{path,op,followFinal:op!=='delete'}]}).decisions.map(structuredOwnerDecision));
  targets.push({kind:'path',path:canonicalPath(path,cwd),op});if(op==='delete'&&(classifyPath(path)||noLimitsWipe('rm -rf -- '+quote(path),{...context,cwd})))deletes.push({path,op:'delete'});
 }}
 // The exact parser covers native aliases, nested entries and array operands.
 const exact=extractInspectedOperation(input,{cwd});
 if(exact.kind!=='incomplete'&&exact.exactOperation.kind==='native')for(const effect of exact.exactOperation.effects){
  if(effect.op==='delete'&&noLimitsWipe('rm -rf -- '+quote(effect.path),{...context,cwd}))
   if(!deletes.some(row=>row.path===effect.path&&row.op==='delete'))deletes.push({path:effect.path,op:'delete'});
 }
 if(/host.computer/i.test(tool)||engine?.approvalScope==='local-computer')targets.push({kind:'host-computer',scope:'local-computer'});
 if(/browser|navigate/i.test(tool)&&typeof (obj.url??obj.origin)==='string')try{targets.push({kind:'browser-site',origin:new URL(obj.url??obj.origin).origin.toLowerCase(),op:/navigate/.test(name)?'navigate':/read|snapshot/.test(name)?'read':'act'});}catch{}
 if(resolved?.kind==='mcp'&&!resolved.own){
  const hint='event'in input?mcpWipeHint(input.threadId,resolved.server,resolved.tool):undefined;
  if(mcpBulkWipe(resolved.tool,obj,hint))deletes.push({path:`mcp:${resolved.server}/${resolved.tool}`,op:'delete'});
  if(/(?:^|_)(?:delete|destroy|drop|purge|remove|unlink|rmdir)(?:_|$)/i.test(resolved.tool))for(const path of [obj.path,obj.file_path,obj.directory,obj.root,obj.target])if(typeof path==='string'&&noLimitsWipe('rm -rf -- '+quote(path),{...context,cwd}))deletes.push({path,op:'delete'});
 }
 if(resolved?.kind==='mcp'||!engine&&/^mcp__/.test(effective))for(const field of ['query','sql','statement','statements','migration']){
  const values=Array.isArray(obj[field])?obj[field]:[obj[field]];
  if(values.some((value:unknown)=>typeof value==='string'&&sqlWipe(value)))deletes.push({path:'sql',op:'delete'});
 }
 deletes.push(...connectorWipes(effective,payload));
 const dispatched=dispatchedCall(effective,payload);
 const appRows=dispatched.target==='COMPOSIO_MULTI_EXECUTE_TOOL'?connectedAppRequirements(payload,effective):[];
 const directSlug=obj.tool_slug??obj.toolSlug??obj.slug??obj.tool??effective;
 if(!appRows.length&&(CONNECTED_APP_TOOLS.some(x=>x.tool===effective)||/connected.?app|bot.?access/i.test(effective)))appRows.push({tool:directSlug,account:obj.accountId??obj.account});
 for(const row of appRows.slice(0,256)){
  const catalog=CONNECTED_APP_TOOLS.find(x=>x.tool===row.tool),toolkit=catalog?.toolkit??obj.toolkit??obj.app;
  if(typeof row.tool==='string'&&typeof toolkit==='string')targets.push({kind:'connected-app',toolkit,tool:row.tool,...(typeof row.account==='string'?{accountId:row.account}:{}),op:catalog?.writes?'write':'read'});
 }
 for(const field of Object.keys(obj))if(CONTENT_FIELDS.has(field))content.push({field});
 return freeze({tool,codeIdentity:hash({tool,executables}),executables,deletes,targets:targets.slice(0,256),ownerTargets:targets,content,ownerAuthority:{version:1,decisions,exhausted}});
}
export function canonicalPath(path:string,cwd?:string):string {if(path.startsWith('~')||path.includes('$'))return path;return posix.normalize(path.startsWith('/')?path:posix.resolve(cwd??'/',path));}
export function protectedEvidence(action:ActionEvidence):Evidence[]{
 const evidence:Evidence[]=[];
 for(const t of action.targets)if(t.kind==='path'&&t.op!=='read'){
  // Hook/relay files are restored silently (B6), never protected-deny cards.
  if(MURAGE_HOOK_PATH.test(t.path))continue;
  if(t.op==='delete'&&classifyPath(t.path))continue;
  const cls=protectedClass(t.path);if(cls)evidence.push({kind:'deny',class:cls,ruleId:'protected-target',span:t.path.slice(0,200)});
 }
 return evidence;
}
export function wipeEvidence(action:ActionEvidence):Evidence[]{return action.deletes.map(t=>({kind:'wipe',class:t.path,ruleId:'wipe-list',span:t.path.slice(0,200)}));}
