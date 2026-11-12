// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean, 2026-11-12 02:05Z: No limits keeps ONLY the wipe/catastrophe list.
import { finalEval, writtenScriptTexts } from './no-limits-wipe-scripts.ts';
import { extraGitWipe, gitPushArguments } from './no-limits-wipe-git.ts';
import { sqlWipe } from './no-limits-wipe-sql.ts';
import { forEachSegment } from './shell/segments.ts';
import { resolve, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import {homedir} from 'node:os';
import { alwaysAskCommand, ALWAYS_ASK_NO_LIMITS, type AlwaysAskHit, type UnseenOptions } from './always-ask.ts';
import { commandRoles } from './shell/roles.ts';
import { ownerMarks, withoutDoubts } from './shell/marks.ts';
import { readExecutableOwnerNl, readExecutable as readNativeFallback } from './no-limits-code.ts';
import { forEachOwnerSegment, shellExecutables, quote as shellQuote, simpleCommandsOwnerNl as simpleCommands } from './no-limits-shell.ts';

const baseName=(word:string)=>word.split(/[\\/]/).at(-1)!.replace(/\.(?:exe|cmd)$/i,'').toLowerCase();
/** Command strings remain code even when legacy getopt stopped at an option.
 * Consume options before the script; later positional arguments stay data. */
function shellBodies(program:string,args:string[],positions?:number[]):string[] {
 if(['busybox','toybox'].includes(program)){program=baseName(args[0]??'');args=args.slice(1);}
 if(!/^(?:sh|ash|bash|zsh|dash|ksh|mksh|fish|csh|tcsh|pwsh|powershell)$/.test(program))return [];
 const bodies:string[]=[];let command=false;
 for(let at=0;at<args.length;at++){
  const word=args[at]!;
  if(/^--(?:command|init-command)=/.test(word)){positions?.push(at);bodies.push(word.slice(word.indexOf('=')+1));if(program!=='fish')break;continue;}
  if(/^(?:--command|--init-command|-Command|-command)$/.test(word)){command=true;continue;}
  if(word==='--'){if(command&&args[at+1]!==undefined){positions?.push(at+1);bodies.push(args[at+1]!);}break;}
  if(/^[-+]/.test(word)){
   if(/^[-+][^-]*c/.test(word)||program==='fish'&&word==='-C')command=true;
   if(!['pwsh','powershell'].includes(program)&&/^[-+][^-]*[oOR]/.test(word)||['--rcfile','--init-file','--features','--debug','-T'].includes(word))at++;
   continue;
  }
  if(!command)break;
  positions?.push(at);bodies.push(word);command=false;
  if(!['fish','csh','tcsh'].includes(program))break;
 }
 return bodies;
}
/** getopt must stop after the script: a later -c is positional Bash data. */
function shellArgumentRead(source:string,depth=0):string {
 if(depth>=8)return source;
 const edits:Array<{start:number;end:number;replacement?:string}>=[];
 try{forEachSegment(source,row=>{
  if(row.depth!==0)return;
  const words=row.words.map(word=>word.text??word.raw),roles=commandRoles(words);
  if(!/^(?:sh|ash|bash|zsh|dash|ksh|mksh)$/.test(roles.program))return;
  const at=roles.slots.find(slot=>(slot.role==='name'||slot.role==='command')&&baseName(slot.value??'')===roles.program)?.arg??0;
  const positions:number[]=[];shellBodies(roles.program,words.slice(at+1),positions);
  if(positions[0]===undefined)return;
  const body=row.words[at+positions[0]+1];
  if(body?.text!==undefined){const normalized=shellArgumentRead(body.text,depth+1);if(normalized!==body.text)edits.push({start:body.start,end:body.end,replacement:shellQuote(normalized)});}
  for(let arg=at+positions[0]+2;arg<words.length;arg++)if(/^[-+][^-]*c|^--command(?:=|$)/.test(words[arg]!))edits.push(row.words[arg]!);
 });}catch{ /* preserve unread input for the other readers */ }
 for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+(edit.replacement??'__positional_argument__')+source.slice(edit.end);
 return source;
}
function pipedBodies(source:string):string[] {
 const bodies:string[]=[];let output:string|undefined;
 try{forEachSegment(source,row=>{
  const words=row.words.map(word=>word.text??word.raw),roles=commandRoles(words);
  const at=roles.slots.find(slot=>(slot.role==='name'||slot.role==='command')&&baseName(slot.value??'')===roles.program)?.arg??0;
  const args=words.slice(at+1);
  if(output!==undefined&&/^(?:sh|bash|dash|zsh|ksh|pwsh|powershell)$/.test(roles.program)&&args.some((arg,i)=>/^-(?:c|command)$/i.test(arg)&&args[i+1]==='-'||arg==='-s'))bodies.push(output);
  output=undefined;
  if(row.sep==='|'){
   if(roles.program==='echo')output=args.filter((arg,i)=>i!==0||!/^-[neE]+$/.test(arg)).join(' ');
   else if(roles.program==='printf'&&/^%s(?:\\n)?$/.test(args[0]??''))output=args.slice(1).join(args[0]?.endsWith('n')?'\n':'');
  }
 });}catch{ /* a failed pipe read is not a wipe */ }
 return bodies;
}
/** Follow only executable slots (including shell -c/substitutions), never
 * quoted echo/printf arguments. Wrapper grammars select the real program. */
function* commandsOf(text:string):Generator<{words:string[];program:string;args:string[]}> {
 const pending=[text,...pipedBodies(text)],seen=new Set<string>();
 for(let at=0;at<pending.length&&at<256;at++){
  const source=pending[at]!;if(seen.has(source))continue;seen.add(source);
  const nested:Parameters<typeof shellExecutables>[2]=[];
  const executable=shellExecutables(source,0,nested);
  for(const words of simpleCommands(executable)){
   const roles=commandRoles(words),program=roles.program;
   const index=roles.slots.find(slot=>(slot.role==='name'||slot.role==='command')&&slot.value!==undefined&&baseName(slot.value)===program)?.arg??0;
   const args=words.slice(index+1);yield {words,program,args};
   pending.push(...shellBodies(program,args));
   for(const child of roles.nested??[])if(child.text!==undefined&&(child.via!=='shell-c'||!/^(?:sh|ash|bash|zsh|dash|ksh|mksh|fish|csh|tcsh|pwsh|powershell)$/.test(program)))pending.push(child.text);
  }
  for(const [lang,body]of nested)if(lang==='sh')pending.push(body);
 }
}
/** Use the owner reader's resolved variables and per-command cwd when a
 * recorded file is executed, including `cd scripts && bash cleanup.sh`. */
function* scriptCommandsOf(text:string,cwd?:string):Generator<{words:string[];program:string;args:string[];cwd?:string}>{
 const commands:Array<{words:string[];program:string;args:string[];cwd?:string}>=[];
 forEachOwnerSegment(text,cwd,row=>{
  const {roles}=row,words=row.values.map(word=>word??'');
  const index=roles.slots.find(slot=>(slot.role==='name'||slot.role==='command')&&slot.value!==undefined&&baseName(slot.value)===roles.program)?.arg??0;
  for(const base of row.selected)commands.push({words,program:roles.program,args:words.slice(index+1),cwd:base});
 });
 yield* commands;
}
const DEVICE_MUTATORS=/^(?:rm|rmdir|unlink|shred|srm|remove-item|ri|del|rd|erase|deltree|rimraf|dd|mkfs(?:\.[\w-]+)?|mke2fs|newfs|wipefs|diskutil|diskpart|format(?:-volume)?|clear-disk|initialize-disk|remove-partition|fdisk|sfdisk|parted|gpart|mknod)$/i;
/** These are data-loss operations, not permission/refusal or protected-path rules. */
const SQL_CLIENT = /^(?:psql|sqlite3?|mysql|mariadb|sqlcmd)$/;
function dataLoss(text:string, lang?:string,cwd?:string):boolean {
 let expire=false,prune=false;
 try {
  for(const {program,args} of commandsOf(text)) {
   if(program==='dropdb' && args.some(arg=>!arg.startsWith('-')) && !args.some(arg=>/^(?:--help|--version|-\?)$/.test(arg)))return true;
   if(program==='redis-cli'){
    const optionsWithValue=new Set(['-h','-p','-a','-u','-n','-s','--user','--pass','--tls-ciphers','--cacert','--cert','--key','--sni','--pattern','--quoted-pattern','--count','--rdb','--eval']);
    let command:string|undefined;
    for(let at=0;at<args.length;at++){const arg=args[at]!;if(optionsWithValue.has(arg)){at++;continue;}if(arg.startsWith('-'))continue;command=arg;break;}
    if(/^(?:FLUSHALL|FLUSHDB)$/i.test(command??''))return true;
   }
   if(/^(?:mongo|mongosh)$/.test(program)&&args.some((arg,i)=>/^(?:--eval|--execute)$/.test(args[i-1]??'')&&/\bdb(?:\.[\w]+)?\.(?:dropDatabase|drop)\s*\(/.test(arg.replace(/(['"])(?:\\.|(?!\1)[^\\])*?\1/g,' '))))return true;
   if(program==='supabase'&&args[0]==='db'&&args[1]==='reset')return true;
   if(program==='prisma'&&(args[0]==='migrate'&&args[1]==='reset'||args[0]==='db'&&args[1]==='push'&&args.includes('--force-reset')))return true;
   if(/^(?:rails|rake)$/.test(program)&&args.some(arg=>/^db:(?:drop|reset)$/.test(arg)))return true;
   if(program!=='git'&&!SQL_CLIENT.test(program))continue;
   if(program==='git') {
    if(extraGitWipe(args,cwd))return true;
    let sub=0;
    for(;sub<args.length;sub++){
     const word=args[sub]!;
     if(word==='--'){sub++;break;}
     if(!word.startsWith('-'))break;
     if(['-C','-c','--config-env','--git-dir','--work-tree','--namespace','--super-prefix','--attr-source'].includes(word))sub++;
    }
    const op=args[sub],rest=args.slice(sub+1);
    if(!op||!/^(?:reset|push|filter-branch|filter-repo|reflog|gc)$/.test(op))continue;
    let lease=false,forced=false,repository=false,dryRun=false;
    const positionals:string[]=[];
    for(let index=0;index<rest.length;index++){
     const word=rest[index]!;
     if(word==='--repo'){repository=true;index++;continue;}
     if(word.startsWith('--repo=')){repository=true;continue;}
     if(['-o','--push-option','--receive-pack','--exec'].includes(word)){index++;continue;}
     if(word==='--dry-run'||word==='-n'){dryRun=true;continue;}
     if(/^--force-with-lease(?:=|$)/.test(word))lease=true;
     if(['--force','-f','--delete','-d'].includes(word))forced=true;
     if(!word.startsWith('-'))positionals.push(word);
    }
    // The first positional is the repository, even when a remote is named
    // main/master. Only a destructive default-branch refspec is a wipe.
    const push=op==='push'?gitPushArguments(rest):undefined;
    if(push){
     lease=push.flags.some(word=>/^--force-with-lease(?:=|$)/.test(word));
     forced=push.flags.some(word=>['--force','-f','--delete','-d'].includes(word));
     dryRun=push.flags.some(word=>word==='--dry-run'||word==='-n');
    }
    const refs=push?(push.repository?push.positionals:push.positionals.slice(1)):repository?positionals:positionals.slice(1);
    if(op==='push'&&dryRun)continue;
    const main=refs.some(word=>/^(?:refs\/heads\/)?(?:main|master)$/.test(word.replace(/^\+/, '').split(':').at(-1)??'') && (forced||word.startsWith('+')||word.startsWith(':')));
    if(op==='push'&&!lease&&(main||push?.flags.includes('--mirror')||forced&&push?.flags.includes('--all')) || op==='filter-branch'||op==='filter-repo')return true;
    if(op==='reflog'&&rest.includes('expire'))expire=true;
    if(op==='gc'&&rest.some(word=>/^--prune(?:=|$)/.test(word)))prune=true;
   } else if(args.some(sqlWipe))return true;
  }
 }catch { /* visible fallback below still protects unreadable wipes */ }
 if(expire&&prune)return true;
 let stdinWipe=false;
 forEachSegment(text,segment=>{
  const words=segment.words.map(word=>word.text),roles=commandRoles(words);
  if(!SQL_CLIENT.test(roles.program))return;
  // An explicit query option consumes its argument instead of standard input.
  if(words.some(word=>/^(?:-c|-e|-Q|--command|--execute)(?:=|$)/.test(word??'')))return;
  let stdin:typeof segment.redirects[number]|undefined;
  for(const redirect of segment.redirects)if((redirect.fd??(redirect.op.startsWith('<')?0:1))===0&&['<','<>','<<','<<-','<<<','<&'].includes(redirect.op))stdin=redirect;
  const body=stdin?.heredoc?.body??(stdin?.op==='<<<'?stdin.target?.text:undefined);
  if(body!==undefined&&sqlWipe(body))stdinWipe=true;
 },{command:words=>commandRoles(words)});
 if(stdinWipe)return true;
 return (lang==='py'||lang==='js') && /\b(?:execute|executescript|query)\s*\(\s*["'`]\s*(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i.test(text);
}
const RULES = {root:'delete-root',home:'delete-home',system:'delete-system-folder',disk:'disk-erase',fork:'fork-bomb'} as const;
/** Literal FileUtils operands are executable Ruby effects. Strings printed by
 * Ruby, comments and heredoc bodies remain data, including wipe-looking text. */
function rubyLiteralWipe(args:string[],options:{cwd?:string;home?:string;unseen?:UnseenOptions}):AlwaysAskHit|null {
 const bodies:string[]=[];
 for(let at=0;at<args.length;at++){
  const arg=args[at]!;
  if(arg==='-e'){if(args[at+1]!==undefined)bodies.push(args[++at]!);continue;}
  if(arg.startsWith('-e')&&arg.length>2){bodies.push(arg.slice(2));continue;}
  if(arg==='-r'||arg==='-I'){at++;continue;}
  if(!arg.startsWith('-')||arg==='--')break;
 }
 const source=bodies.join('\n'),tokens:string[]=[];
 const lex=/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*|<<[-~]?|[A-Za-z_]\w*|[^\s]/g;
 for(let match:RegExpExecArray|null;(match=lex.exec(source));){
  const token=match[0];if(token.startsWith('#'))continue;
  if(token==='"'||token==="'")break; // Unclosed string contents are data.
  if(token==='='&&(match.index===0||source[match.index-1]==='\n')&&/^begin(?:\s|$)/.test(source.slice(lex.lastIndex))){
   const end=/(?:^|\n)=end\b[^\n]*(?:\n|$)/g;end.lastIndex=lex.lastIndex;const closed=end.exec(source);
   if(!closed)break;lex.lastIndex=end.lastIndex;continue;
  }
  if(token==='%'){
   const quote=/^[qQrwWxsiI]?([({\[<|\/!])/.exec(source.slice(lex.lastIndex));
   if(quote){const open=quote[1]!,close=({'(':')','{':'}','[':']','<':'>'} as Record<string,string>)[open]??open;let at=lex.lastIndex+quote[0].length,depth=1;
    for(;at<source.length&&depth;at++){if(source[at]==='\\'){at++;continue;}if(open!==close&&source[at]===open)depth++;if(source[at]===close)depth--;}
    lex.lastIndex=at;continue;
   }
  }
  if(token.startsWith('<<')){
   const label=lex.exec(source)?.[0]?.replace(/^['"]|['"]$/g,'');
   if(!label||!/^\w+$/.test(label))break;
   const body=source.indexOf('\n',lex.lastIndex);if(body<0)break;
   const indent=token==='<<'?'':'[\\t ]*';
   const end=new RegExp(`(?:^|\\n)${indent}${label}\\r?(?:\\n|$)`,'g');end.lastIndex=body;
   const closed=end.exec(source);if(!closed)break;
   lex.lastIndex=closed.index+closed[0].length;continue;
  }
  tokens.push(token);
 }
 for(let at=0;at<tokens.length;at++){
  if(tokens[at]!=='FileUtils'||tokens[at+1]!=='.'||!/^(?:rm_rf|rmtree|remove_entry|remove_entry_secure)$/.test(tokens[at+2]??''))continue;
  const raw=tokens[at+(tokens[at+3]==='('?4:3)];if(!raw||!/^['"]/.test(raw))continue;
  let path:string;try{path=raw.startsWith('"')?JSON.parse(raw):raw.slice(1,-1).replace(/\\(['\\])/g,'$1');}catch{continue;}
  if(path.includes('#{'))continue;
  const hit=ownerMarks(()=>withoutDoubts(()=>alwaysAskCommand('rm -rf -- '+shellQuote(path),options.cwd,'command',undefined,undefined,options.home,options.unseen)));
  if(hit&&ALWAYS_ASK_NO_LIMITS[hit.rule]==='wipe')return hit;
 }
 return null;
}
export function noLimitsWipe(text: string, options: {cwd?:string;workFolder?:string;project?:string;home?:string;shell?:'pwsh';lang?:'sh'|'py'|'js'|'pwsh';unread?:boolean;unseen?:UnseenOptions;scriptDepth?:number} = {}): AlwaysAskHit | null {
 let unread = options.unread === true;
 // A non-wipe finding must never hide a later catastrophe. The whole read
 // preserves bindings; independent statements also find visible later wipes.
 for(const part of options.lang==='py'||options.lang==='js'?[]:[text]) {
  try {
   const hit=withoutDoubts(()=>alwaysAskCommand(part,options.cwd,'command',options.shell,undefined,options.home,options.unseen));
   if(hit && ALWAYS_ASK_NO_LIMITS[hit.rule]==='wipe'){
    if(hit.rule==='fork-bomb')return hit;
    if(hit.rule!=='disk-erase'&&[...commandsOf(part)].some(command=>DEVICE_MUTATORS.test(command.program)||['find','rsync'].includes(command.program)))return hit;
    // The legacy guard also matches device names in data arguments. Confirm
    // an actual mutator before retaining that finding at No limits.
    for(const command of commandsOf(part))if(DEVICE_MUTATORS.test(command.program)){
     const visible=command.words.map(word=>shellQuote(word)).join(' ');
     const actual=withoutDoubts(()=>alwaysAskCommand(visible,options.cwd,'command',options.shell,undefined,options.home,options.unseen));
     if(actual?.rule==='disk-erase')return actual;
    }
   }
   // Recovered executable slots below validate named catastrophes.
   if(hit?.rule==='unreadable')unread=true;
  } catch { unread=true; }
 }
 // This reader reports effects independently of key/protected-path findings.
 try {
  let read;
  try{read=readExecutableOwnerNl(options.lang??(options.shell?'pwsh':'sh'),options.lang==='py'||options.lang==='js'?text:shellArgumentRead(text),undefined,0,options.cwd);}
  catch(error){if(options.lang==='py'||options.lang==='js')read=readNativeFallback(options.lang,text,undefined,0);else throw error;}
  for(const cls of read.classes)if(cls in RULES)return {rule:RULES[cls as keyof typeof RULES],what:'This would destroy data or stop this computer.'};
  for(const target of read.targets)if(target.op==='delete') {
   // Retain owner-only named system roots such as /libexec. Only an actual
   // delete target reaches this synthetic command; prose never does.
   const legacy=ownerMarks(()=>withoutDoubts(()=>alwaysAskCommand('rm -rf -- '+shellQuote(target.path),options.cwd,'command',options.shell,undefined,options.home,options.unseen)));
   if(legacy&&ALWAYS_ASK_NO_LIMITS[legacy.rule]==='wipe')return legacy;
   let path=resolve(options.cwd??'/',target.path);
   try{
    // A trailing glob traverses the directory link; an unadorned link is unlinked.
    const traversed=/\/(?:\*{1,2}|\.)\/?$/.test(target.path);
    const physical=traversed?realpathSync(path.replace(/\/(?:\*{1,2}|\.)\/?$/,'' )||'/'):resolve(realpathSync(dirname(path)),basename(path));
    const linked=ownerMarks(()=>withoutDoubts(()=>alwaysAskCommand('rm -rf -- '+shellQuote(physical),options.cwd,'command',options.shell,undefined,options.home,options.unseen)));
    if(linked&&ALWAYS_ASK_NO_LIMITS[linked.rule]==='wipe')return linked;
    path=physical;
   }catch{/* A missing or unresolved path alone is not a catastrophe. */}
   if(path===resolve(options.home??homedir()))return {rule:'delete-home',what:'This would delete the home folder.'};
   if((options.project && path===resolve(options.project)) || ((options.workFolder??options.cwd) && path===resolve((options.workFolder??options.cwd)!)) || /(?:^|[\\/])backups?$/i.test(path) || [options.workFolder??options.cwd,options.project].some(root=>root && path===resolve(root,'.git')))
    return {rule:'delete-system-folder',what:'This would delete a project, its history, or backups.'};
  }
 } catch { unread=true; }
 // Inspect only scripts recorded as written by this provider turn, never an
 // arbitrary existing file or a missing/unreadable one. Bound recursive reads.
 if((options.scriptDepth??0)<4){
  try{for(const script of writtenScriptTexts(scriptCommandsOf(text,options.cwd),{...options,files:options.unseen?.sessionEdits})){
   const wipe=noLimitsWipe(script.text,{...options,cwd:script.cwd,workFolder:options.workFolder??options.cwd,lang:script.lang,shell:script.lang==='pwsh'?'pwsh':undefined,scriptDepth:(options.scriptDepth??0)+1});
   if(wipe)return wipe;
  }}catch{/* Still check all visible command text below. */}
  if(!options.lang||options.lang==='sh'){
   let evaluated:ReturnType<typeof finalEval>;try{evaluated=finalEval(text,options.cwd);}catch{/* malformed non-eval text is not a wipe */}
   if(evaluated?.text&&evaluated.text!==text){const wipe=noLimitsWipe(evaluated.text,{...options,scriptDepth:(options.scriptDepth??0)+1});if(wipe)return wipe;}
  }
 }
 for(const command of options.lang==='py'||options.lang==='js'?[]:commandsOf(text)){
  const visible=command.words.map(word=>shellQuote(word)).join(' ');
  try{
   const hit=ownerMarks(()=>withoutDoubts(()=>alwaysAskCommand(visible,options.cwd,'command',options.shell,undefined,options.home,options.unseen)));
   const executable=DEVICE_MUTATORS.test(command.program)||/^(?:python[0-9.]*|node|ruby|perl|php|lua|:)$/.test(command.program);
   if(executable&&hit&&ALWAYS_ASK_NO_LIMITS[hit.rule]==='wipe')return hit;
   if(executable&&hit?.namedCatastrophe)return hit;
   if(command.program==='ruby'){const literal=rubyLiteralWipe(command.args,options);if(literal)return literal;}
  }catch{ /* unread input alone does not card */ }
 }
 if(dataLoss(text,options.lang,options.cwd))return {rule:'disk-erase',what:'This would destroy database data, Git history, or stop this computer.'};
 // Even a cut or failed read checks every visible byte. Failure itself is
 // never a reason to card at No limits.
 // The segment reader recovers visible executable statements even after a cut.
 // Never infer a wipe from bare verbs or from a non-command summary.
 if(unread&&options.lang!=='py'&&options.lang!=='js')for(const words of simpleCommands(text)){
  if(words.length===0)continue;
  const program=commandRoles(words).program;if(/^(?:sh|ash|bash|zsh|dash|ksh|mksh|fish|csh|tcsh|pwsh|powershell|echo|printf)$/.test(program))continue;
  const visible=words.map(word=>shellQuote(word)).join(' ');
  try{const hit=withoutDoubts(()=>alwaysAskCommand(visible,options.cwd,'command',options.shell,undefined,options.home,options.unseen));
   if(hit && ALWAYS_ASK_NO_LIMITS[hit.rule]==='wipe'){
    // The legacy device guard also matches device names inside echo/printf.
    // A cut disk command needs an executable mutator, not a literal mention.
    if(hit.rule!=='disk-erase'||DEVICE_MUTATORS.test(commandRoles(words).program))return hit;
   }
  }catch{ /* an unread statement alone is not a wipe */ }
 }
 return null;
}
