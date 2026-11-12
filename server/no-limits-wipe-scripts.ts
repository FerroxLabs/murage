// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { outsideTurnKey, runningOutsideInstance, sessionEdits, turnBegunAt } from './email/external-marks.ts';
import { forEachSegment } from './shell/segments.ts';
import { commandRoles } from './shell/roles.ts';
import { lexWordText } from './shell/lex.ts';
import { candidatesOf, newContext } from './shell/walk.ts';

const turnWrites=new Map<string,{provider:string;turn:string;files:Set<string>}>();
/** The permission decision also sees shell redirections, which the native
 * file-tool journal does not. Record allowed write attempts; the later read
 * still requires a real file modified during this exact live turn. */
export function noteTurnScriptWrites(thread:string,provider:string,turn:string,paths:readonly string[]):void {
 let scope=turnWrites.get(thread);
 if(!scope||scope.provider!==provider||scope.turn!==turn){scope={provider,turn,files:new Set()};turnWrites.delete(thread);turnWrites.set(thread,scope);}
 for(const path of paths)if(isAbsolute(path))scope.files.add(path);
 if(turnWrites.size>4096)turnWrites.delete(turnWrites.keys().next().value!);
}

/** The existing engine-write journal is populated by noteToolStartOutside in
 * production. A prior-turn entry alone never grants permission to inspect a
 * file: it must also have changed during this exact live provider turn. */
export function turnWrittenScripts(threadId:string,providerInstanceId:string,turnId:string):ReadonlySet<string> {
 const files=new Set<string>(),begun=turnBegunAt(threadId);
 if(outsideTurnKey(threadId)!==turnId||runningOutsideInstance(threadId)!==providerInstanceId||begun===undefined)return files;
 const own=turnWrites.get(threadId),extra=own?.provider===providerInstanceId&&own.turn===turnId?own.files:[];
 for(const file of new Set([...sessionEdits(threadId,providerInstanceId),...extra]))try{if(statSync(file).mtimeMs>=begun)files.add(file);}catch{/* absent files are not wipes */}
 return files;
}
const inside=(path:string,root:string)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')&&!isAbsolute(rel);};
interface Command {program:string;args:string[];words:string[];cwd?:string}
export function* writtenScriptTexts(commands:Iterable<Command>,options:{cwd?:string;project?:string;files?:ReadonlySet<string>}):Generator<{text:string;lang:'sh'|'py'|'js'|'pwsh';cwd?:string}> {
 if(!options.files?.size)return;
 for(const command of commands){
  const {program,args,words}=command,cwd='cwd'in command?command.cwd:options.cwd;
  let file:string|undefined,lang:'sh'|'py'|'js'|'pwsh'='sh';
  if(/^(?:bash|sh|zsh|dash|python[23]?|node|pwsh|powershell|ruby|perl)$/.test(program)){
   lang=/^python/.test(program)?'py':program==='node'?'js':/^(pwsh|powershell)$/.test(program)?'pwsh':'sh';
   for(let at=0;at<args.length;at++){
    const arg=args[at]!;
    if(/^-file$/i.test(arg)){file=args[at+1];break;}
    if(arg==='-'||program==='node'&&arg==='--check'||/^(?:bash|sh|zsh|dash)$/.test(program)&&arg==='-s'||/^(?:-[^-]*[ce]|--(?:eval|command|print)|-m|-Command|-EncodedCommand)$/i.test(arg)){file=undefined;break;}
    if(['-o','-O','-r','--require','--import','--loader','--init-file','--rcfile','-ExecutionPolicy','-WorkingDirectory'].includes(arg)){at++;continue;}
    if(arg==='--'){file=args[at+1];break;}
    if(arg.startsWith('-'))continue;
    file=arg;break;
   }
  }else file=words.find(word=>/[\\/]/.test(word)&&word.split(/[\\/]/).at(-1)!.replace(/\.(?:exe|cmd)$/i,'').toLowerCase()===program);
  if(!file||!cwd&&!isAbsolute(file))continue;
  const absolute=resolve(cwd??'/',file);
  if(!options.files.has(absolute))continue;
  let fd:number|undefined;
  try{
   const real=realpathSync(absolute);
   if(![options.cwd,options.project].some(root=>root&&inside(real,realpathSync(root))))continue;
   fd=openSync(absolute,constants.O_RDONLY|constants.O_NONBLOCK);
   const stat=fstatSync(fd);
   if(!stat.isFile()||stat.size>262144)continue;
   const bytes=Buffer.alloc(262145);let used=0;
   while(used<bytes.length){const count=readSync(fd,bytes,used,bytes.length-used,used);if(!count)break;used+=count;}
   if(used>262144)continue;
   if(!/^(?:bash|sh|zsh|dash|python[23]?|node|pwsh|powershell|ruby|perl)$/.test(program))lang=/\.py$/i.test(file)?'py':/\.[cm]?js$/i.test(file)?'js':/\.ps1$/i.test(file)?'pwsh':'sh';
   yield {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)),lang,cwd};
  }catch{/* missing, unreadable, non-text and out-of-workspace files are not wipes */}
  finally{if(fd!==undefined)closeSync(fd);}
 }
}

/** Frozen r3 rows permit an opaque eval followed by another visible command.
 * For a final eval, resolve local literal bindings first; only an unresolved
 * executable value itself is held. A resolved value gets the ordinary wipe scan. */
export function finalEval(text:string,cwd?:string):{unresolved:boolean;text?:string}|undefined {
 const context=newContext(cwd);let result:{unresolved:boolean;text?:string}|undefined;
 forEachSegment(text,segment=>{
  const roles=commandRoles(segment.words.map(word=>word.text));
  const bindings=[...segment.assignments,...(/^(?:export|readonly|local|declare|typeset)$/.test(roles.program)?segment.words.slice(1):[])];
  for(const assignment of bindings){const match=/^([A-Za-z_]\w*)=(.*)$/s.exec(assignment.raw);if(match&&!context.readonly.has(match[1]!)){context.bound.set(match[1]!,[lexWordText(match[2]!)]);if(roles.program==='readonly')context.readonly.add(match[1]!);}}
  if(!segment.words.length)return;
  if(roles.program!=='eval'){result=undefined;return;}
  const index=segment.words.findIndex(word=>word.text==='eval'),parts:string[]=[];
  result={unresolved:false};
  for(const word of segment.words.slice(index+1)){
   try{
    const values=candidatesOf(lexWordText(word.raw),context);
    if(values.length!==1||values[0]!.kind!=='literal'){result={unresolved:true};return;}
    parts.push(values[0]!.text);
   }catch{result={unresolved:true};return;}
  }
  result={unresolved:false,text:parts.join(' ')};
 },{command:words=>commandRoles(words)});
 return result;
}
