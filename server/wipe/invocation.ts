// SPDX-License-Identifier: AGPL-3.0-or-later
import { known, opaque, type Script, type ShellState, type Invocation, type Value, type Node, type Word, type MaySet, type ProcOpts } from './types.ts';
import {findEffects} from './find.ts';
import {maySet,literalSet,pairs,fromValue,asValue,BUDGET} from './may.ts';
import { expandWord, expandWords,mergeFields,literalOutput, ExpansionAbort, operand, assignEnv, lookup } from './expand.ts';
import { parseSh } from './sh.ts';
import { parsePwsh } from './pwsh.ts';
import { parseCmd } from './cmd.ts';
import { evidenceScan,coarseEvidence } from './evidence.ts';
import { grammars, readOptions } from './programs.ts';
import {produced} from './pwsh-model.ts';
import {hostFor,inspectHost,type HostCtx} from './hosts.ts';
import {fork} from './process.ts';
/** The distinct lists the positional parameters may hold. Past the enumeration budget the lists are also read slot by slot, with uncertainty retained. */
const distinctLists=(lists:Value[][]):Value[][]=>{const distinct=[...new Map(lists.map(list=>[JSON.stringify(list),list])).values()];return distinct.length>BUDGET?[...distinct.slice(0,BUDGET),mergeFields(distinct).map(v=>v.k==='known'?{...v,mayOpaque:true}:v)]:distinct;};
export const parse=(text:string,dialect:ShellState['dialect'])=>dialect==='pwsh'?parsePwsh(text):dialect==='cmd'?parseCmd(text):parseSh(text);
const text=(v:Value|undefined)=>v?.k==='known'?v.s:undefined;
export const programName=(s:string,dialect:ShellState['dialect']='sh',platform=process.platform)=>{const name=s.split(/[\\/]/).at(-1)!.replace(/\.(exe|cmd|bat|com)$/i,'');return dialect==='sh'&&platform!=='win32'?name:name.toLowerCase();};
const aliases:Record<string,string>={rm:'remove-item',ri:'remove-item',del:'remove-item',erase:'remove-item',rd:'remove-item',rmdir:'remove-item',mv:'move-item',mi:'move-item',move:'move-item',gci:'get-childitem',ls:'get-childitem',dir:'get-childitem',gi:'get-item',ren:'rename-item',rni:'rename-item'};
/** A branching union is capped (protected values always stay); a literal list, or a union that already holds one, is not. */
const union=(old:MaySet,next:MaySet,weak:boolean,original:string|undefined,protect:ShellState['lexicalProtected'],literal:boolean):MaySet=>{const values=weak?[...old.values,...next.values]:next.values,fault=weak?old.opaque||next.opaque:next.opaque;return literal||next.values.length>4||weak&&old.values.length>4?literalSet(values,fault,original):maySet(values,fault,original,protect);};
/** Names an sh process hands to its children. */
const exportName=(st:ShellState,name:string,on=true)=>{if(on)st.exported?.add(name);else st.exported?.delete(name);};
const setVar=(st:ShellState,name:string,value:Value,weak=false,literal=false)=>{const old=st.vars?.get(name)??maySet(lookup(st,name)===undefined?[]:[lookup(st,name)!]),next=fromValue(value),merged=union(old,next,weak,old.original??next.original,st.lexicalProtected,literal);if(weak&&old.maybeUnset)merged.maybeUnset=true;if(st.proc?.allexport)exportName(st,name);assignEnv(st,name,merged.values[0]??'\0opaque');(st.vars??=new Map()).set(name,merged);};
const setCwd=(st:ShellState,next:Value,weak=false)=>{const old=fromValue(st.cwd),value=fromValue(next);st.oldpwd=st.cwd;st.cwd=asValue(union(old,value,weak,st.startCwd??old.original,st.lexicalProtected,false));const path=next.k==='known'?next.s:'';st.drive=/^([a-z]:)/i.exec(path)?.[1]??st.drive;if(st.dialect==='sh')setVar(st,'PWD',st.cwd);};
/** What ForEach-Object binds: the one producer model (pwsh-model.ts). A listed directory delivers its children. */
function pipelineItem(from:Invocation|undefined):Value|undefined {
 const values=produced(from);const strings=values.flatMap(v=>v.k==='known'?[v.wholeDirGlob?v.s.replace(/[\\/]$/,'')+(v.recursiveGlob||v.entryOf?.wholeTree?'\\**':'\\*')+(v.dirsOnly?'\\':''):v.s]:[]);
 return strings.length?asValue(literalSet(strings,!!values.length&&strings.length!==values.length)):undefined;
}
export function walk(script:Script,st:ShellState):Invocation[] {
 st.meter??={calls:0};st.proc??={};
 const out:Invocation[]=[];
 // Text parsed under a state that already redefines true, false or `:` (an inherited or earlier function) keeps no Boolean certainty.
 // Text that runs in the calling shell itself (trap) keeps none either: an earlier alias, eval or sourced file may have redefined one.
 const body=(source:string,child:ShellState,sameShell=false)=>{const unsure=child.dialect==='sh'&&(sameShell||['true','false',':'].some(name=>child.functions?.has(name)));out.push(...(child.depth>=16?evidenceScan(source,child):walk(unsure?parseSh(source,0,true):parse(source,child.dialect),{...child,depth:child.depth+1})));};
 const subst=(w:Word)=>{for(const part of w.parts){if(part.k==='array'){for(const word of part.words)subst(word);}else if(part.k==='subst'){out.push(...walk(part.body,{...fork(st,'subshell'),depth:st.depth+1}));}else if(part.k==='var'&&part.arg&&[':-','-',':='].includes(part.op??'')){const value=lookup(st,part.name);if(value===undefined||part.op?.startsWith(':')&&value==='')subst(part.arg);}else if(part.k==='var'&&part.arg&&['#','##','%','%%',':','other'].includes(part.op??''))subst(part.arg);else if(part.k==='var'&&part.arg&&(part.op===':+'||part.op==='+')){const value=lookup(st,part.name);if(!(value===undefined||part.op===':+'&&value===''))subst(part.arg);}}};
 const node=(n:Node):Invocation|undefined=>{
  if(n.join==='&'){out.push(...walk({nodes:[{...n,join:';'}],incompleteTail:false},fork(st,'subshell')));return;}
  if(n.k==='block')return;
  // A definition that may be skipped (its own and/or list, an enclosing conditional group or eval) keeps the earlier body callable.
  if(n.k==='func'){
   const name=st.dialect==='sh'?n.name:n.name.toLowerCase();st.inheritedFns?.delete(name);const functions=st.functions??=new Map(),old=functions.get(name)??[],variants=n.cond||st.weak?[...old,n.body]:[n.body];
   const retained=maySet(variants.map((_,i)=>String(i)),false,'0',id=>coarseEvidence(variants[Number(id)]?.source??''));
   functions.set(name,['0',...retained.values.filter(id=>id!=='0')].map(id=>variants[Number(id)]!));
   const weak=st.weak,defining=st.defining;st.weak=true;st.defining=true;try{walk(n.body,st);}finally{st.weak=weak;st.defining=defining;}return;
  }
  if(n.k==='residual'){out.push(...evidenceScan(n.text,{...fork(st,'subshell'),dialect:n.dialect}));return;}
  if(n.k==='subshell'){out.push(...walk(n.body,fork(st,'subshell')));return;}
  if(n.k==='group'){const child=n.subshell?fork(st,'subshell'):st,weak=child.weak;child.weak ||=n.cond;try{out.push(...walk(n.body,child));}finally{child.weak=weak;}return;}
  if(n.k==='list'){for(const item of n.items)node(item);return;}
  if(n.k==='pipe'){
   let previous:Invocation|undefined,stdin:Value=st.stdin??opaque('pipeline');
   for(const stage of n.stages){const child=fork(st,'subshell');child.stdin=stdin;child.pipeFrom=previous;child.piped=true;
    const producedBy=st.dialect==='pwsh'&&stage.k==='cmd'&&stage.c.words.length===1&&!stage.c.assigns.length&&stage!==n.stages.at(-1)&&stage.c.words[0]!.parts.length===1&&stage.c.words[0]!.parts[0]!.k==='var'?st.produced?.get(stage.c.words[0]!.parts[0]!.name.toLowerCase()):undefined;
    if(producedBy){previous=producedBy;stdin=opaque('pipeline');continue;}
    // S5 (closer): a bare value expression feeding a pipeline supplies its values to the next stage.
    if(st.dialect==='pwsh'&&stage.k==='cmd'&&stage.c.words.length===1&&!stage.c.assigns.length&&stage!==n.stages.at(-1)&&/^(?:[$'"]|@\()/.test(stage.c.words[0]!.raw)){subst(stage.c.words[0]!);const values=expandWords(stage.c.words[0]!,child).flatMap<Value>(v=>v.k==='known'?v.s.split('\u0000,').map(s=>({...v,s})):[v]);previous={program:'\0values',argv:values,rawArgv:[],redirects:[],cwd:st.cwd,dialect:st.dialect};stdin=values.length===1?values[0]!:opaque('pipeline');continue;}
    const tree={nodes:[stage],incompleteTail:false};const rows=walk(tree,child);out.push(...rows);const next=rows.at(-1);if(next&&previous)next.pipedFrom=previous;if(next?.program==='find')findEffects(next,true);previous=next;stdin=next?.stdout&&next.stdout.length>1?{...opaque('pipeline-entries'),entryAlternatives:next.stdout}:next?.stdout?.[0]??literalOutput(tree,child);}
   return previous;
  }
  const c=n.c;
  if(st.dialect==='pwsh'){
   // S5 (closer): the .NET recursive directory delete is the same effect as Remove-Item -Recurse.
   const dotnet=/^\[(?:System\.)?IO\.Directory\]::Delete\(([\s\S]+?),\s*\$true\s*\)$/i.exec(c.words.map(w=>w.raw).join(' '));
   if(dotnet){const operandWord=parsePwsh('x '+dotnet[1]!).nodes[0];if(operandWord?.k==='cmd'&&operandWord.c.words[1])out.push(...peel([known('remove-item'),known('-Recurse'),known('-LiteralPath'),expandWord(operandWord.c.words[1],st)],st));return;}
   const first=c.words[0]?.raw??'',method=/^\$(?:\{([^}]+)\}|([\w:]+))\.Invoke\(\)$/i.exec(first),executors=['&','.','invoke-command','icm','start-job','sajb','foreach-object','%','foreach'];
   if(method||executors.includes(first.toLowerCase())){
    const blocks=c.words.flatMap(word=>word.parts.flatMap(part=>part.k==='block'?[part.body]:part.k==='var'?st.blocks?.get(part.name.toLowerCase())??[]:[]));
    if(method)blocks.push(...st.blocks?.get((method[1]??method[2]!).toLowerCase())??[]);
    // S5 (closer): ForEach-Object binds $_ / $PSItem (or the foreach variable) to what the pipeline delivers.
    const runner=first==='.'?st:fork(st,'subshell'),loopName=c.words.find(w=>w.raw.startsWith('\0var:'))?.raw.slice(5);
    if(['foreach-object','%','foreach'].includes(first.toLowerCase())){const item=pipelineItem(st.pipeFrom);for(const name of loopName?[loopName]:['_','psitem'])setVar(runner,name,item??opaque('pipeline-item'));}
    if(first!=='.')runner.pipeFrom=undefined;
    for(const block of blocks)out.push(...walk(block,runner));
    if(blocks.length){const inv:Invocation={program:first.toLowerCase(),argv:[],rawArgv:[],redirects:[],cwd:st.cwd,dialect:st.dialect};out.push(inv);return inv;}
    // `& name args` and `. name args` run the named command.
    if((first==='&'||first==='.')&&c.words.length>1)return node({...n,c:{...c,words:c.words.slice(1)}});
   }
  }

  if(st.dialect==='cmd'){
   const lower=(j:number)=>c.words[j]?.raw.toLowerCase()??'',rerun=(words:Word[])=>{const head=words[0],lead=head?.parts[0];if(head&&lead?.k==='lit'&&lead.s.startsWith('@'))words=[{raw:head.raw.slice(1),parts:[{...lead,s:lead.s.slice(1)},...head.parts.slice(1)]},...words.slice(1)];if(!words.length)return;const weak=st.weak;st.weak=true;try{node({k:'cmd',c:{assigns:[],words,redirects:c.redirects},span:n.span,cond:true});}finally{st.weak=weak;}};
   if(lower(0).replace(/^@/,'')==='if'){
    let at=1;if(lower(at)==='/i')at++;if(lower(at)==='not')at++;
    if(['exist','defined','errorlevel','cmdextversion'].includes(lower(at)))at+=2;else if(lower(at).includes('=='))at+=lower(at).endsWith('==')?2:1;else if(lower(at+1).startsWith('=='))at+=lower(at+1)==='=='?3:2;else if(/^(?:equ|neq|lss|leq|gtr|geq)$/.test(lower(at+1)))at+=3;else at=c.words.length;
    const rest=c.words.slice(at),split=rest.findIndex(w=>w.raw.toLowerCase()==='else');
    for(const words of split<0?[rest]:[rest.slice(0,split),rest.slice(split+1)])rerun(words);return;
   }
   if(lower(0)==='else'){rerun(c.words.slice(1));return;}
   if(lower(0)==='call'&&c.words.length>1&&!lower(1).startsWith(':')){rerun(c.words.slice(1));return;}
   if(lower(0)==='start'&&c.words.length>1){let at=1;if(c.words[at]?.raw.startsWith('"'))at++;while(lower(at).startsWith('/'))at+=lower(at)==='/d'?2:1;rerun(c.words.slice(at));return;}
   if(lower(0).replace(/^@/,'')==='for'){
    const raws=c.words.map(w=>w.raw.toLowerCase()),at=raws.indexOf('in'),run=raws.indexOf('do',at+1),loop=c.words[at-1]?.parts.find(p=>p.k==='var'&&p.name.startsWith('for:'));
    if(at>1&&run>at&&loop?.k==='var'){
     const computed=raws.slice(1,at-1).some(o=>/^\/[lf]$/.test(o)),items=computed?[]:c.words.slice(at+1,run);
     for(const item of items.length?items:[undefined])rerun(c.words.slice(run+1).map(w=>({raw:w.raw,parts:w.parts.flatMap(p=>item&&p.k==='var'&&p.name===loop.name?item.parts:[p])})));
     return;
    }
   }
  }

  for(const r of c.redirects)if(r.heredoc!==undefined&&r.expanding){const tree=parseSh('echo \"'+r.heredoc.replaceAll('\"','\\\"')+'\"');out.push(...walk(tree,fork(st,'subshell')));}
  for(const w of [...c.words,...c.assigns.map(a=>a.value),...c.redirects.map(r=>r.target)])subst(w);
  let argv:Value[],redirects:Invocation['redirects'];const child=fork(st,'subshell');
  try{
   // Caller expansion precedes all child environment edits.
   argv=c.words.flatMap((w,i)=>expandWords(st.dialect==='pwsh'&&(/^-(?:literalpath|literalp|literal|lit|li|l)$/i.test(c.words[i-1]?.raw??'')||/^-(?:literalpath|literalp|literal|lit|li|l):/i.test(w.raw))?{...w,parts:w.parts.map(p=>p.k==='glob'?{k:'lit' as const,s:p.s,quoted:true}:p)}:w,st));
   // Globs expand in the caller before env/sudo changes the child's cwd.
   argv=argv.map(v=>st.dialect==='sh'&&v.k==='known'&&v.wholeDirGlob&&!/^(?:[a-z]:[\\/]|[\\/])/i.test(v.s)?{...v,callerGlobRelative:true}:v);redirects=c.redirects.map(r=>({op:r.op,target:expandWord(r.target,st)}));
   for(const a of c.assigns){
    const block=a.value.parts.find(p=>p.k==='block');if(block?.k==='block'){const blocks=child.blocks??=new Map(),name=a.name.toLowerCase();blocks.set(name,n.cond||st.weak?[...(blocks.get(name)??[]),block.body]:[block.body]);}else child.blocks?.delete(a.name.toLowerCase());
    const array=a.value.parts.find(p=>p.k==='array');
    if(array?.k==='array'){
     const values=array.words.flatMap(w=>expandWords(w,st));
     if(array.loop){const strings=values.flatMap(v=>v.k==='known'?v.candidates??[v.s]:[]);setVar(child,a.name,asValue(literalSet(strings,values.some(v=>v.k==='opaque'),undefined)),true,true);}
     else {(child.arrays??=new Map()).set(a.name,values);setVar(child,a.name,values[0]??known(''));}
    }else setVar(child,a.name,expandWord(a.value,st),!!n.cond||!!st.weak);
    if(argv.length)exportName(child,a.name);
   }
  }catch(error){if(error instanceof ExpansionAbort)throw error;throw error;}
  if(!argv.length){for(const a of c.assigns)st.produced?.delete(a.name.toLowerCase());st.env=child.env;st.vars=child.vars;st.arrays=child.arrays;st.blocks=child.blocks;if(st.proc?.allexport)for(const a of c.assigns)exportName(st,a.name);if(redirects.length&&!st.defining)out.push({program:'',argv:[],rawArgv:[],redirects,cwd:st.cwd,dialect:st.dialect});return;}
  // A directory change through a variable that may hold several values keeps every value (handled by the cd reader below).
  if(argv.some(v=>v.k==='known'&&v.candidates&&v.candidates.length>1)&&!(text(argv[0])==='set'&&text(argv[1])==='--')&&!st.defining&&!['cd','pushd','chdir','set-location','sl','push-location'].includes(programName(text(argv[0])??'',child.dialect,child.platform))){
   let variants:Value[][]=[[]];for(const value of argv){const values=value.k==='known'&&value.candidates?value.candidates.map(s=>({...value,s,candidates:undefined})):[value];variants=pairs(variants,values).map(([prefix,v])=>[...prefix,v]);}
   for(const variant of variants)out.push(...peel(variant,child));return;
  }
  let raw=c.words.slice(1),program=programName(text(argv.shift())??'',child.dialect,child.platform);
  const functionBodies=st.functions?.get(program);
  // A function that is already being read adds nothing new (the name then falls through as a program, as it did at the old depth cap).
  const stack=st.fnStack??[];
  if(functionBodies&&!stack.includes(program)){
   const target=c.assigns.length?child:st,meter=st.meter??={calls:0};
   // Past the call budget the bodies are read for wipe evidence; a call is never dropped.
   if(++meter.calls>BUDGET){for(const definition of functionBodies)out.push(...evidenceScan(definition.source??'',fork(st,'subshell')));return;}
   for(const definition of functionBodies){const positional=target.positional,positionals=target.positionals,depth=target.functionDepth,weak=target.weak,saved=target.fnStack;target.positional=[known(program),...argv];target.positionals=undefined;target.functionDepth=(depth??0)+1;target.fnStack=[...stack,program];target.weak ||=!!n.cond||functionBodies.length>1;try{out.push(...walk(definition,target));}finally{target.positional=positional;target.positionals=positionals;target.functionDepth=depth;target.weak=weak;target.fnStack=saved;}}
   if(!st.inheritedFns?.has(program))return;
  }
  if(program==='exit'||program==='return'){if(n.cond&&st.successCwd){st.cwd=asValue(fromValue(st.successCwd));st.successCwd=undefined;return;}if(!n.cond)throw new ExpansionAbort();return;}
  if(program==='setlocal'){const proc=st.proc??={};(st.locals??=new Array()).push({env:new Map(st.env),vars:new Map(st.vars),delayed:proc.delayed});if(argv.some(v=>/^enabledelayedexpansion$/i.test(text(v)??'')))proc.delayed=true;if(argv.some(v=>/^disabledelayedexpansion$/i.test(text(v)??'')))proc.delayed=false;return;}
  if(program==='endlocal'){const local=st.locals?.pop();if(local){st.env=local.env;st.vars=local.vars;(st.proc??={}).delayed=local.delayed;}return;}
  if(program==='read'){
   // Only a modeled, unconditional read may replace earlier values; unsupported input keeps them.
   const redirect=c.redirects.filter(r=>(r.fd===undefined||r.fd===0)&&['<','<<','<<-','<<<','<&'].includes(r.op)).at(-1);
   let own:Value|undefined;
   if(redirect?.heredoc!==undefined){
    if(!redirect.expanding)own=known(redirect.heredoc);
    else if(!/[`\\]/.test(redirect.heredoc)){const doc=parseSh('x "'+redirect.heredoc.replaceAll('\"','\\\"')+'"').nodes[0];own=doc?.k==='cmd'&&doc.c.words[1]?expandWord(doc.c.words[1],st):opaque('read-heredoc');}
    else own=opaque('read-heredoc');
   }else if(redirect)own=redirect.op==='<<<'?expandWord(redirect.target,st):opaque('read-redirect');
   const input=own??st.stdin,options=argv.map(text),names=options.filter((s):s is string=>!!s&&/^[A-Za-z_]\w*$/.test(s)),reply=!names.length;
   if(reply)names.push('REPLY');
   const ifsMay=child.vars?.get('IFS'),ifsValues=reply?['']:[...new Set([...(ifsMay?.values.length?ifsMay.values:[lookup(child,'IFS')??' \t\n']),...(ifsMay?.maybeUnset?[' \t\n']:[])])],supported=options.every(s=>s==='-r'||s==='--'||!!s&&/^[A-Za-z_]\w*$/.test(s))&&ifsValues.every(ifs=>/^[ \t\n]*$/.test(ifs))&&!ifsMay?.opaque,raw=options.includes('-r');
   const inputs=input?.k==='known'?(input.candidates??[input.s]):[],escaped=!raw&&inputs.some(s=>s.includes('\\'));
   const weak=own?.k!=='known'||own.mayOpaque===true||!!n.cond||!!st.weak||!supported||escaped;
   const lines=inputs.flatMap(s=>{const decoded=raw?s:s.replace(/\\\n/g,'').replace(/\\(.)/g,'$1');return own?[decoded.split('\n')[0]!]:decoded.trimEnd().split('\n');});
   for(let i=0;i<names.length;i++){
    const values=lines.flatMap(line=>ifsValues.map(ifs=>{
     if(!ifs)return i===0?line:'';
     const separators=supported?ifs:' \t\n',trimmed=line.replace(new RegExp('^['+separators+']+|['+separators+']+$','g'),'');
     const fields=[...trimmed.matchAll(new RegExp('[^'+separators+']+','g'))];
     return i===names.length-1?trimmed.slice(fields[i]?.index??trimmed.length):fields[i]?.[0]??'';
    }));
    setVar(st,names[i]!,values.length?asValue(literalSet(values,input?.k==='opaque'||input?.k==='known'&&input.mayOpaque===true)):opaque('read'),weak,true);
   }
   if(input?.k==='known'&&!own)st.stdin=known(input.s.split('\n').slice(1).join('\n'));return;
  }
  if(['export','declare','typeset','local','set'].includes(program)){
   const proc=st.proc??={};
   if(program==='set'){
    // `set` changes this process's options, read left to right; a later word wins.
    const flags=argv.map(text);
    for(let j=0;j<flags.length;j++){const s=flags[j];if(s===undefined)continue;if(s==='--')break;
     const on=s[0]==='-';if(!/^[-+][a-zA-Z]+$/.test(s))continue;
     if(s.includes('u'))proc.nounset=on;if(s.includes('a'))proc.allexport=on;
     if(s.endsWith('o')){const name=flags[j+1];if(name==='nounset')proc.nounset=on;if(name==='allexport')proc.allexport=on;}
    }
   }
   if(program==='set'&&argv.some(v=>text(v)==='-e'))proc.errexit=true;if(program==='set'&&argv.some(v=>text(v)==='+e'))proc.errexit=false;if(program==='set'&&text(argv[0])==='--'){
    const self=st.positional?.[0]??known('sh'),next=[self,...argv.slice(1)];
    // MAIN RULING 2026-11-17T12:20Z: `set -- "$@"` copies each list the parameters may hold, with its own length.
    const copies=st.positionals&&c.words.some(w=>w.parts.some(p=>p.k==='var'&&/^(?:\d+|[@*#])$/.test(p.name)))?st.positionals.map(positional=>[positional[0]??self,...c.words.flatMap(w=>expandWords(w,{...st,positional,positionals:undefined})).slice(2)]):[next];
    const lists=distinctLists(n.cond||st.weak?[...(st.positionals??[st.positional??[]]),...copies]:copies);
    st.positionals=lists.length>1?lists:undefined;st.positional=lists.length===1?lists[0]!:next;
   }
   for(const value of argv){const s=text(value)??'',m=/^(\w+)=(.*)$/s.exec(s);if(m)setVar(st,m[1]!,known(m[2]!),!!n.cond||!!st.weak);}
   // export / declare -x / typeset -x mark names for child processes; export -f marks functions; -n takes the mark away.
   {const options=argv.map(text).filter((s):s is string=>!!s&&/^[-+][a-zA-Z]+$/.test(s)),names=argv.map(text).filter((s):s is string=>!!s&&!/^[-+]/.test(s)).map(s=>s.split('=')[0]!);
    const marks=program==='export'||program!=='set'&&options.some(o=>o[0]==='-'&&o.includes('x')),fn=options.some(o=>o[0]==='-'&&o.includes('f')),off=options.some(o=>o.includes('n')&&program==='export'||o[0]==='+'&&o.includes('x'));
    if(marks||off)for(const name of names){if(fn&&program==='export'){if(off)st.exportedFns?.delete(name);else (st.exportedFns??=new Set()).add(name);}else exportName(st,name,!off);}}
   if(text(argv[0])==='-n')for(const v of argv.slice(1))assignEnv(st,text(v)??'',undefined);
   return;
  }
  if(program==='unset'){for(const value of argv){const name=text(value)??'';if(n.cond||st.weak){const old=st.vars?.get(name)??maySet(lookup(st,name)===undefined?[]:[lookup(st,name)!]);(st.vars??=new Map()).set(name,{...old,maybeUnset:true});}else assignEnv(st,name,undefined);}return;}
  if(st.dialect==='cmd'&&/^[a-z]:$/i.test(program)){st.drive=program.toUpperCase();setCwd(st,known(st.drive+'/'),!!st.weak);return;}
  if(['cd','pushd','set-location','sl','chdir','push-location','popd','pop-location'].includes(program)){
   const args=argv.filter(v=>!(v.k==='known'&&(/^(?:--|-L|-P|-e|-@|\/d|-Path|-LiteralPath)$/i.test(v.s))));
   const stack=st.dirStack??=new Array<Value>();let next:Value;
   if(program==='popd'||program==='pop-location')next=stack.shift()??opaque('directory-stack');
   else if((program==='pushd'||program==='push-location')&&!args.length){next=stack.shift()??opaque('directory-stack');stack.unshift(st.cwd);}
   else {next=!args.length?known(lookup(st,'HOME')??st.home):text(args[0])==='-'?st.oldpwd??opaque('previous-cwd'):/^[+-]\d+$/.test(text(args[0])??'')?opaque('directory-stack'):operand(args[0]!,st.cwd,st);if(program==='pushd'||program==='push-location')stack.unshift(st.cwd);}
   st.successCwd=n.join==='||'?next:undefined;setCwd(st,next,!!st.weak||!!n.cond||st.dialect==='sh'&&!st.proc?.errexit&&n.join!=='&&');return;
  }
  if(st.dialect==='pwsh'&&['rd','rmdir'].includes(program)&&argv.some(v=>/^\/s/i.test(text(v)??'')))child.dialect='cmd';
  // Hosts and wrappers are read through one grammar (hosts.ts). A source or command string starts a new process.
  // Invoke-Expression runs in the caller's own scope; every other source is a new process (process.ts).
  const start=(from:ShellState,host:Parameters<typeof inspectHost>[0],opts:ProcOpts={}):ShellState=>{const next=host.family==='iex'?fork(from,'subshell'):fork(from,'new',host,opts);if(host.kind==='cmdlet')next.pipeFrom=undefined;return next;};
  const chdir=(state:ShellState,path:Value)=>{state.cwd=asValue(fromValue(operand(path,state.cwd,state)));state.drive=/^([a-z]:)/i.exec(state.cwd.k==='known'?state.cwd.s:'')?.[1]??state.drive;};
  const hostCtx=(name:string,words:Word[]):HostCtx=>({program:name,raw:words,st,child,
   run:(source,host,from,opts,positional,cwd)=>{const next=start(from,host,opts);if(positional){next.positional=positional;next.positionals=undefined;}if(cwd)chdir(next,cwd);body(source,next);},
   runBlock:(block,host,from,cwd)=>{const next=start(from,host);if(cwd)chdir(next,cwd);out.push(...walk(block,next));},
   peel:(words,from)=>{out.push(...peel(words,from));},
   stdin:()=>{const here=c.redirects.find(r=>r.op==='<<<');return c.stdinHeredoc??c.redirects.find(r=>r.heredoc!==undefined)?.heredoc??(here?text(expandWord(here.target,st)):undefined)??text(child.stdin);},
   chdir,
   split:source=>{const row=parseSh(source).nodes[0],words=row?.k==='cmd'?row.c.words:[];return {argv:words.map(w=>expandWord(w,st)),raw:words};},
   blocks:name=>child.blocks?.get(name),
   setEnv:(state,name,value)=>assignEnv(state,name,value),
  });
  for(;;){
   if(program==='xargs'){
    const options=readOptions(argv,grammars.xargs!,true),vals=(...names:string[])=>names.flatMap(n=>options.values.get(n)??[]);
    const here=c.redirects.find(r=>r.op==='<<<');const input=child.stdin??(c.stdinHeredoc!==undefined?known(c.stdinHeredoc):here?expandWord(here.target,st):opaque('xargs-stdin'));
    let command=argv.slice(options.restAt);if(!command.length)command=[known('echo')];
    const replacement=text(vals('I','replace','i')[0])??(options.flags.has('i')?'{}':undefined);
    const delimiter=text(vals('d','delimiter')[0])?.replace(/^\\(?:([nt0])|(.))/,(_,c:string|undefined,o:string)=>c==='n'?'\n':c==='t'?'\t':c==='0'?'\0':o);
    const values=input.entryAlternatives??(input.k==='known'?input.s.split(options.flags.has('0')||options.flags.has('null')?'\0':delimiter?delimiter:replacement||options.flags.has('L')||options.flags.has('max-lines')?'\n':/\s+/).filter(Boolean).map(known):[input]);
    if(replacement){for(const value of values)out.push(...peel(command.map(v=>v.k==='known'&&v.s.includes(replacement)?value.k==='known'?known(v.s.replaceAll(replacement,value.s)):value:v),child));}
    else out.push(...peel([...command,...values],child));return;
   }
   const host=hostFor(program,child.dialect);
   if(!host||host.kind!=='wrapper'&&host.kind!=='strings')break;
   const next=inspectHost(host,argv,hostCtx(program,raw));
   if(!next)return;
   if(next.self)break;
   argv=next.argv;raw=next.raw;program=programName(text(argv.shift())??'',child.dialect,child.platform);raw=raw.slice(1);
   if(!program)break;
  }
  // Relative glob results are names expanded in the caller, then resolved by
  // the child. A changed cwd cannot promote that list to a whole-child wipe.
  if(child.cwd.k!=='known'||st.cwd.k!=='known'||child.cwd.s.replace(/[\\/]$/,'')!==st.cwd.s.replace(/[\\/]$/,''))argv=argv.map(v=>v.k==='known'&&v.callerGlobRelative?opaque('caller-glob-child-cwd'):v);
  const shellHost=hostFor(program,child.dialect);
  if(shellHost?.kind==='shell'||program==='eval')if(redirects.length&&!st.defining)out.push({program:'',argv:[],rawArgv:[],redirects,cwd:child.cwd,dialect:child.dialect});
  if(shellHost?.kind==='shell'){inspectHost(shellHost,argv,hostCtx(program,raw));return;}
  if(program==='trap'&&child.dialect==='sh'){const args=text(argv[0])==='--'?argv.slice(1):argv,source=text(args[0]);if(args.length>=2&&source&&source!=='-'&&!/^-[lp]$/.test(source))body(source,fork(child,'subshell'),true);return;}
  if(shellHost?.kind==='cmdlet'){inspectHost(shellHost,argv,hostCtx(program,raw));return;}
  if(program==='forfiles'){
   const value=(name:string)=>{const at=argv.findIndex(v=>v.k==='known'&&v.s.toLowerCase()===name);return at<0?undefined:text(argv[at+1]);},command=value('/c'),root=value('/p')??'.',mask=value('/m');
   if(command!==undefined&&!argv.some(v=>v.k==='known'&&v.s.toLowerCase()==='/d')&&(mask===undefined||/^\*(?:\.\*)?$/.test(mask)))body(command.replace(/@(?:path|file)/gi,'"'+root+'"'),{...fork(child,'subshell'),dialect:'cmd'});return;
  }
  // eval text runs in the calling shell and shares its state: it keeps no Boolean certainty of its own (an earlier function, alias,
  // eval or sourced file may have redefined true, false or `:`), and an eval that may be skipped only adds alternatives.
  if(program==='eval'){const values=argv.map(text),target=c.assigns.length?child:st,depth=target.depth,weak=target.weak;if(values.every(v=>v!==undefined)){const source=values.join(' ');target.depth++;target.weak ||=!!n.cond;try{out.push(...walk(target.dialect==='sh'?parseSh(source,0,true):parse(source,target.dialect),target));}finally{target.depth=depth;target.weak=weak;}}return;}
  if(child.dialect==='pwsh')program=aliases[program]??program;
  if(!st.defining&&program==='ln'&&argv.some(v=>v.k==='known'&&/^-[^-]*s/.test(v.s))){const paths=argv.filter(v=>v.k!=='known'||!v.s.startsWith('-')),target=paths.at(-2),link=paths.at(-1);if(target&&link){const source=operand(target,st.cwd,st),name=operand(link,st.cwd,st);if(source.k==='known'&&name.k==='known')(st.links??=new Map()).set(name.s,source.s);}}
  if(!st.defining&&program==='mklink'){
   const paths=argv.filter(v=>v.k!=='known'||!/^\/[djh]$/i.test(v.s)),link=paths[0],target=paths[1];
   if(link&&target){const name=operand(link,st.cwd,st),source=operand(target,st.cwd,st);if(name.k==='known'&&source.k==='known')(st.links??=new Map()).set(name.s,source.s);}
  }
  if(!st.defining&&program==='new-item'){
   const option=(name:string)=>{const at=argv.findIndex(v=>v.k==='known'&&new RegExp('^-(?:'+name+')$','i').test(v.s));return at<0?undefined:argv[at+1];};
   const kind=text(option('itemtype')),link=option('path'),target=option('target|value');
   if(/^(?:symboliclink|junction)$/i.test(kind??'')&&link&&target){const name=operand(link,st.cwd,st),source=operand(target,st.cwd,st);if(name.k==='known'&&source.k==='known')(st.links??=new Map()).set(name.s,source.s);}
  }
  const inv:Invocation={program,argv,rawArgv:raw,redirects,cwd:child.cwd,dialect:child.dialect,drive:child.drive,links:new Map(st.links),platform:st.platform,home:child.home,env:new Map(child.env),stdin:child.stdin??(c.stdinHeredoc!==undefined?known(c.stdinHeredoc):c.redirects.find(r=>r.heredoc!==undefined)?known(c.redirects.find(r=>r.heredoc!==undefined)!.heredoc!):c.redirects.find(r=>r.op==='<<<')?expandWord(c.redirects.find(r=>r.op==='<<<')!.target,st):undefined)};
  let output=literalOutput({nodes:[n],incompleteTail:false},st);
  if(program==='base64'&&argv.some(v=>v.k==='known'&&['-d','--decode'].includes(v.s))&&st.stdin?.k==='known')try{output=known(Buffer.from(st.stdin.s.trim(),'base64').toString('utf8'));}catch{}
  if(output.k==='known')inv.stdout=[output];if(st.dialect==='pwsh')for(const assignment of c.assigns){setVar(st,assignment.name,output,!!st.weak||!!n.cond);if(!st.piped&&!st.defining&&['get-childitem','get-item'].includes(program))(st.produced??=new Map()).set(assignment.name.toLowerCase(),inv);else st.produced?.delete(assignment.name.toLowerCase());}
  if(!st.defining)out.push(inv);return inv;
 };
 for(const n of script.nodes)try{node(n);}catch(error){
  if(error instanceof ExpansionAbort)break;
  const source=n.span&&script.source?script.source.slice(...n.span):n.k==='cmd'?n.c.words.map(w=>w.raw).join(' '):n.k==='residual'?n.text:'';
  out.push(...evidenceScan(source,fork(st,'subshell')));
 }
 return out;
}

export function peel(argv:Value[],state:ShellState):Invocation[] {
 // Too deep to keep unwrapping: the words are read for wipe evidence instead of being dropped.
 // (The evidence reader does not unwrap xargs, so its leading words are passed over here.)
 if(state.depth>16){const words=argv.map(value=>value.k==='known'?value.s:'');while(words.length&&(words[0]==='xargs'||words[0]!.startsWith('-')))words.shift();return evidenceScan(words.join(' '),state);}
 const words:Word[]=argv.map(value=>({raw:value.k==='known'?value.s:'opaque',parts:[{k:'value',value}]}));
 return walk({nodes:[{k:'cmd',c:{assigns:[],words,redirects:[]},span:[0,0]}],incompleteTail:false},{...fork(state,'subshell'),depth:state.depth+1});
}
