// SPDX-License-Identifier: AGPL-3.0-or-later
import type {ShellState,Word,WordPart,Value,Script} from './types.ts';
import {maySet,pairs,BUDGET} from './may.ts';
import {known,opaque} from './types.ts';
import {unsetPolicy} from './process.ts';
import {globValue} from './glob.ts';
export class ExpansionAbort extends Error {}
export function assignEnv(st:Pick<ShellState,'env'|'vars'>,name:string,value:string|undefined):void {st.env.delete(name);st.env.set(name,value);st.vars?.set(name,maySet(value===undefined||value==='\0opaque'?[]:[value],value==='\0opaque',value));}
export function lookup(st:ShellState,name:string):string|undefined {
 if(st.dialect==='sh')return st.env.get(name);
 if(name.toLowerCase()==='pwd')return st.cwd.k==='known'?st.cwd.s:undefined;
 if(name.toLowerCase()==='true')return 'true';if(name.toLowerCase()==='false')return 'false';
 const key=[...st.env.keys()].reverse().find(key=>key.toLowerCase()===name.toLowerCase());if(key!==undefined)return st.env.get(key);
 // S2 (closer): HOMEDRIVE/HOMEPATH/USERPROFILE name the home even when the host environment omits them.
 const windowsHome=/^([a-z]:)([\\/].*)$/i.exec(st.home??''),lower=name.toLowerCase();
 if(windowsHome&&lower==='homedrive')return windowsHome[1];if(windowsHome&&lower==='homepath')return windowsHome[2];if(windowsHome&&lower==='userprofile')return st.home;
 return undefined;
}
const globRegex=(pattern:string)=>new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*').replaceAll('?','.')+'$');
function trimPattern(value:string,pattern:string,op:string):string {
 const regex=globRegex(pattern),front=op.startsWith('#'),long=op.length===2;
 const lengths=Array.from({length:value.length+1},(_,i)=>i);if(long)lengths.reverse();
 for(const n of lengths)if(regex.test(front?value.slice(0,n):value.slice(value.length-n)))return front?value.slice(n):value.slice(0,value.length-n);
 return value;
}
function parameter(p:Extract<WordPart,{k:'var'}>,st:ShellState):Value[] {
 if(p.delayed&&!st.proc?.delayed)return [known('!'+p.name+'!')];
 const position=st.positional??[];
 if(p.name==='#')return [known(String(Math.max(0,position.length-1)))];
 if(/^\d+$/.test(p.name))return [position[Number(p.name)]??known('')];
 if(p.name==='@'||p.name==='*')return position.slice(1);
 const array=/^(\w+)\[(@|\*|\d+)\]$/.exec(p.name);
 if(array){const items=st.arrays?.get(array[1]!)??[];return array[2]==='@'?items:array[2]==='*'?[known(items.map(v=>v.k==='known'?v.s:'').join((lookup(st,'IFS')??' ')[0]??''))]:[items[Number(array[2])]??known('')];}
 if(p.op==='other')return [opaque('parameter-operator')];
 if(p.name.startsWith('for:'))return [opaque('for-variable')];
 const candidates=st.vars?.get(p.name)??(st.dialect!=='sh'?[...st.vars??[]].find(([name])=>name.toLowerCase()===p.name.toLowerCase())?.[1]:undefined),found=candidates?.values.length?candidates.values:candidates?.opaque?['\0opaque']:[lookup(st,p.name)];
 // A value the parent process did not export may be unset here. Under nounset that reading aborts and has no effects, so it is dropped.
 const policy=unsetPolicy(st),maybe:(string|undefined)[]=candidates?.maybeUnset?[...found.filter(value=>value!==undefined),undefined]:found,values=policy==='abort'&&!p.op&&maybe.length>1?maybe.filter(value=>value!==undefined):maybe;
 return values.map(value=>{
  if(value==='\0opaque')return opaque('variable');const unset=value===undefined||(p.op?.startsWith(':')&&value==='');
  if((p.op===':?'||p.op==='?')&&unset)throw new ExpansionAbort();
  const arg=()=>p.arg?expandWord(p.arg,st):known('');
  if([':-','-',':=','='].includes(p.op??'')&&unset){const fallback=arg();if(p.op===':='||p.op==='=')assignEnv(st,p.name,fallback.k==='known'?fallback.s:'\0opaque');return fallback;}
  if(p.op===':+'||p.op==='+')return unset?known(''):arg();
  if(p.op==='length')return known(String((value??'').length));
  if(['#','##','%','%%'].includes(p.op??'')){const pattern=arg();return pattern.k==='known'?known(trimPattern(value??'',pattern.s,p.op!)):pattern;}
  if(p.op===':'){const spec=p.arg?.raw??'',m=/^\s*(-?\d+)(?::(-?\d+))?$/.exec(spec);if(!m)return opaque('substring');const s=value??'',start=Number(m[1])<0?Math.max(0,s.length+Number(m[1])):Number(m[1]);return known(s.slice(start,m[2]===undefined?undefined:Number(m[2])<0?s.length+Number(m[2]):start+Number(m[2])));}
  if(value===undefined&&policy==='abort'&&!p.op&&/^[A-Za-z_]\w*$/.test(p.name))throw new ExpansionAbort();
  return known(value??'');
 });
}
/** Conservative literal-only producers; this never runs a process or reads a file. */
// Item 4(b): ~user names a user home; a server whose own home sits elsewhere (/root, a service dir) still reads it as one.
const otherHome=(home:string,user:string,platform?:NodeJS.Platform)=>{const base=home.replace(/[\\/][^\\/]+$/,'');return (/^(?:\/home|\/Users|[a-z]:[\\/]Users)$/i.test(base)?base:platform==='darwin'?'/Users':platform==='win32'?base:'/home')+'/'+user;};
export function literalOutput(script:Script,st:ShellState):Value {
 if(script.nodes.length!==1||st.depth>16)return opaque('producer');const node=script.nodes[0];if(node?.k!=='cmd')return opaque('producer');
 const child={...st,depth:st.depth+1},args=node.c.words.map(w=>expandWord(w,child));if(args.some(v=>v.k==='opaque'))return opaque('producer');
 const words=args.map(v=>v.k==='known'?v.s:''),program=words.shift()?.toLowerCase();
 if(program==='pwd')return st.cwd;
 if(program==='cat'){const here=node.c.redirects.find(r=>r.op==='<<<');return node.c.stdinHeredoc!==undefined?known(node.c.stdinHeredoc+'\n'):here?expandWord(here.target,child):opaque('producer');}
 if(program==='ls'&&st.dialect==='sh'&&words.every(w=>/^-[A-Za-z1]+$/.test(w)&&!/[dlR]/.test(w)))return known('.\n');
 if(program==='ls'&&st.dialect==='sh'&&words.some(w=>/^-[A-Za-z]*d[A-Za-z]*$/.test(w)||w==='--directory')){
  // Item 4(h): `ls -d ./*/` and `ls -d */` list the subdirectories only. That empties a home or a disk root, but in a
  // project root it is ordinary cleanup, so the entries carry dirsOnly for the decision table.
  const dirGlob=(j:number)=>/^(?:\.\/)?\*\/$/.test(node.c.words[j+1]?.raw??''),picked=words.map((w,j)=>({w,j})).filter(({w})=>!w.startsWith('-'));
  if(!picked.length)return opaque('producer');
  const listed=known(picked.map(p=>p.w).join('\n')+'\n');
  return picked.some(p=>dirGlob(p.j))?{...listed,entryAlternatives:picked.map(p=>dirGlob(p.j)?{...known('./'),wholeDirGlob:true,dirsOnly:true}:known(p.w))}:listed;}
 if(program==='join-path'&&words.length===2)return known(words[0]!.replace(/[\\/]$/,'')+'/'+words[1]);
 if(['echo','write-output','write'].includes(program??'')){let newline=true,escapes=false;while(words[0]&&/^-[neE]+$/.test(words[0])){const flags=words.shift()!;newline&&!flags.includes('n')||(newline=false);escapes=flags.includes('e');}const output=words.join(' ');return known((escapes?output.replace(/\\([nrt\\])/g,(_,s:string)=>({n:'\n',r:'\r',t:'\t','\\':'\\'}[s]??s)):output)+(newline?'\n':''));}
 if(program==='printf'){
  const format=words.shift()??'';if(/%(?![sb%])|\\(?![nrt0\\])/.test(format))return opaque('printf-format');let i=0,result='';
  do {const before=i;result+=format.replace(/%([sb%])|\\([nrt0\\])/g,(_,code:string,escape:string)=>{if(escape)return {n:'\n',r:'\r',t:'\t','0':'\0','\\':'\\'}[escape]??escape;if(code==='%')return '%';const value=words[i++]??'';return code==='b'?value.replace(/\\([nrt\\])/g,(_,s:string)=>({n:'\n',r:'\r',t:'\t','\\':'\\'}[s]??s)):value;});if(i===before)break;}while(i<words.length);
  return known(result);
 }
 return opaque('producer');
}
function braceWords(w:Word):Word[] {
 const saved:WordPart[]=[],template=w.parts.map(part=>(part.k==='lit'&&!part.quoted||part.k==='glob')?part.s:'\u0001'+(saved.push(part)-1)+'\u0002').join('');
 const queue=[template],results:string[]=[],literals=new Set<string>();let changed=false,overflow=false;
 while(queue.length){const source=queue.pop()!,match=/\{([^{}]+)\}/.exec(source);if(!match){results.push(source);continue;}
  let choices=match[1]!.split(',');if(choices.length===1){const range=/^(-?\d+)\.\.(-?\d+)$/.exec(match[1]!);if(!range){results.push(source);continue;}const a=Number(range[1]),b=Number(range[2]);
   // A long numeric range is represented by its two endpoints.
   choices=Math.abs(b-a)>63?[String(a),String(b)]:Array.from({length:Math.abs(b-a)+1},(_,i)=>String(a+(b<a?-i:i)));}
  else for(const choice of choices)literals.add(choice);
  changed=true;
  // Comma alternatives are a literal list and are all kept. Past the enumeration budget for their products the
  // remaining groups take their first choice, and every alternative is also read on its own (below).
  if(overflow||choices.length+queue.length+results.length>BUDGET){overflow=true;queue.push(source.replace(match[0],choices[0]!));continue;}
  for(const choice of choices.reverse())queue.push(source.replace(match[0],choice));
 }
 if(!changed)return [w];
 if(overflow)for(const choice of literals)if(!/[\u0001{}]/.test(choice))results.push(choice);
 return results.map(source=>{const parts:WordPart[]=[];let at=0;for(const marker of source.matchAll(/\u0001(\d+)\u0002/g)){if(marker.index!>at)parts.push({k:'lit',s:source.slice(at,marker.index),quoted:false});parts.push(saved[Number(marker[1])]!);at=marker.index!+marker[0].length;}if(at<source.length)parts.push({k:'lit',s:source.slice(at),quoted:false});return {raw:w.raw,parts};});
}
/** A field is a resolved argv slot, with glob provenance retained until S7. */
export type Field=Value;
export function expandWords(w:Word,st:ShellState):Field[] {
 if(w.parts.length===1&&w.parts[0]?.k==='value')return [w.parts[0].value];
 const sole=w.parts[0];if(w.parts.length===1&&sole?.k==='var'&&(sole.name==='@'||/\[@\]$/.test(sole.name)))return parameter(sole,st);
 // fish: an unquoted word that holds an unset variable expands to zero words.
 if(unsetPolicy(st)==='drop-word'&&w.parts.some(p=>p.k==='var'&&!p.quoted&&!p.op&&/^[A-Za-z_]\w*$/.test(p.name)&&lookup(st,p.name)===undefined&&!st.vars?.has(p.name)))return [];
 // An unread environment variable occupying an entire argv slot may be an
 // option word. Preserve that uncertainty without changing composed empty
 // expansions such as "$unset/" or explicitly assigned/unset shell locals.
 if(w.parts.length===1&&sole?.k==='var'&&!sole.op&&!/^(?:\d+|[#*@])$/.test(sole.name)&&lookup(st,sole.name)===undefined&&!st.vars?.has(sole.name))return [opaque('unresolved-variable')];
 // S2 (closer): `-$f` / `-r$opts` complete a short-option cluster from an unread variable; same uncertainty.
 if(st.dialect==='sh'&&w.parts.length>=2&&w.parts[0]?.k==='lit'&&/^-[A-Za-z]*$/.test(w.parts[0].s)&&w.parts.slice(1).every(p=>p.k==='var'&&!p.op&&!/^(?:\d+|[#*@])$/.test(p.name)&&lookup(st,p.name)===undefined&&!st.vars?.has(p.name)))return [opaque('unresolved-variable')];
 const braces=braceWords(w);if(braces.length!==1||braces[0]!==w)return braces.flatMap(word=>expandWords(word,st));
 type Slot={s:string;glob:boolean};type Variant={fields:Slot[];boundary:boolean;bad?:Value};let variants:Variant[]=[{fields:[],boundary:false}];const alone:Variant[]=[];
 for(const part of w.parts){
  let values:Value[],split=false,glob=false,multi=false;
  if(part.k==='lit'){values=[known(part.s)];glob=!part.quoted&&/[*?\[]/.test(part.s);}
  else if(part.k==='glob'){values=[known(part.s)];glob=true;}
  else if(part.k==='tilde'){const home=st.dialect==='sh'?(lookup(st,'HOME')??st.home):st.home;values=[home==='\0opaque'?opaque('home'):known(part.user?(part.user==='root'?'/root':otherHome(home,part.user,st.platform)):home)];}
  else if(part.k==='subst'){const output=literalOutput(part.body,st);values=[output.k==='known'?known(output.s.replace(/\n+$/,'')):output];split=st.dialect==='sh'&&!part.quoted;glob=split;}
  else if(part.k==='value')values=[part.value];
  else if(part.k==='array'||part.k==='block')return [opaque(part.k)];
  else {if(part.name==='IFS'&&lookup(st,'IFS')===undefined)values=[known(' \t\n')];else values=parameter(part,st);split=st.dialect==='sh'&&!part.quoted;glob=split;multi=part.name==='@'||/\[@\]$/.test(part.name);if(part.name==='*'&&!split)values=[known(values.map(v=>v.k==='known'?v.s:'').join((lookup(st,'IFS')??' ')[0]??''))];}
  const ifs=lookup(st,'IFS')??' \t\n';
  const append=(v:Variant,value:Value):Variant=>{
   if(value.k==='opaque')return {...v,bad:value};
   const next:Variant={fields:v.fields.map(f=>({...f})),boundary:v.boundary,bad:v.bad};
   if(value.s===''&&!split&&!next.fields.length)next.fields.push({s:'',glob:false});
   for(const ch of value.s){if(split&&ifs.includes(ch)){if(next.fields.length)next.boundary=true;continue;}if(!next.fields.length||next.boundary){next.fields.push({s:'',glob:false});next.boundary=false;}const field=next.fields.at(-1)!;field.s+=ch;field.glob||=glob&&/[*?\[]/.test(ch);}
   return next;
  };
  if(multi){for(const v of variants){let next=v;for(let i=0;i<values.length;i++){if(i)next={...next,boundary:true};next=append(next,values[i]!);}Object.assign(v,next);}}
  else{
   // Past the enumeration budget a protected literal is also read on its own.
   if(variants.length*values.length>BUDGET)for(const value of values)if(value.k==='known'&&st.lexicalProtected?.(value.s))alone.push({fields:[{s:value.s,glob:false}],boundary:false});
   variants=pairs(variants,values).map(([v,value])=>append(v,value));
  }
 }
 variants.push(...alone);
 const fields=variants.map(v=>v.bad?[v.bad]:v.fields.map(({s:field,glob}):Value=>{
  // S2 (closer): in cmd `*.*` selects every entry, exactly like `*`.
  const s=st.dialect==='cmd'&&glob?field.replace(/(^|[\\/])\*\.\*$/,'$1*'):field;
  if(!glob)return known(s);
  if(/^(?:\*|\*\*)$/.test(s))return {...known('.'),wholeDirGlob:true,globText:s};
  // Every subdirectory of the current directory: a wipe of a home or a root, routine in a project.
  if(/^\*\*?\/$/.test(s))return {...known('./'),wholeDirGlob:true,dirsOnly:true,globText:s};
  const whole=/^(.*[\\/])(?:\*\*?|\{\*,\.\*\})[\\/]?$/.exec(s);
  if(whole&&!/[*?\[\]]/.test(whole[1]!))return {...known(whole[1]!),wholeDirGlob:true,globText:s};
  // Every other wildcard is one model for sh, PowerShell and cmd (glob.ts): a base plus the segments the classifier walks.
  // sh text that carries Windows separators is read with both separators.
  return globValue(s,st.dialect==='sh'&&s.includes('\\')?'pwsh':st.dialect);
 }));
 if(fields.length===1)return fields[0]!;
 // Same-shaped alternatives carry candidates; differing shapes are retained for S3 variants.
 const max=Math.max(0,...fields.map(f=>f.length));return Array.from({length:max},(_,i)=>{const values=fields.flatMap(f=>f[i]?.k==='known'?[f[i].s]:[]);const first=fields.find(f=>f[i])?.[i]??opaque('variant');return first.k==='known'?{...first,candidates:[...new Set(values)]}:first;});
}
/** Assignment/option consumers request one field without unquoted field splitting. */
export function expandWord(w:Word,st:ShellState):Value {
 const words=expandWords({...w,parts:w.parts.map(p=>p.k==='var'?{...p,quoted:true}:p)},st);if(words.length===1)return words[0]!;if(words.some(v=>v.k==='opaque'))return opaque('fields');return known(words.map(v=>v.k==='known'?v.s:'').join(' '));
}
// Preserve CR and caret bytes for dialect-local parsing and exact POSIX heredoc delimiters.
// FF/VT must separate words instead of joining them.
export const cleanText=(text:string):string=>text.replace(/\\\r\n?/g,'\\\n').replace(/[\v\f]/g,' ').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g,'');
/** The only shell operand-to-absolute conversion. Native effects retain host-relative resolution. */
export function toAbsolute(value:Value,inv:{cwd:Value;home?:string;drive?:string;platform?:NodeJS.Platform;dialect?:string;links?:Map<string,string>}):string[] {
 if(value.k==='opaque'||!value.s)return [];
 const windows=inv.platform==='win32'||/^(?:[a-z]:|\\\\|\/\/)/i.test(value.s)||inv.cwd.k==='known'&&/^[a-z]:/i.test(inv.cwd.s);
 const bases=inv.cwd.k==='known'?inv.cwd.candidates??[inv.cwd.s]:[''];
 const paths:string[]=[];
 for(const [base,candidate] of pairs(bases,value.candidates??[value.s])){let path=candidate;
  if(windows){
   path=path.replace(/^\\\\[?.]\\UNC\\/i,'\\\\').replace(/^\\\\[?.]\\(?=[a-z]:)/i,'');
   path=path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/|$)/i,(_,d:string)=>d.toUpperCase()+':/');
   const drive=inv.drive??/^([a-z]:)/i.exec(base)?.[1];
   if(/^[a-z]:[^\\/]/i.test(path)){if(!drive||path.slice(0,2).toLowerCase()!==drive.toLowerCase())continue;path=base.replace(/[\\/]$/,'')+'/'+path.slice(2);}
   // The engine's own POSIX home is absolute as named; it never moves onto the working directory's drive.
   else if(/^[\\/](?![\\/])/.test(path)){const home=inv.home?.startsWith('/')?inv.home.replace(/\/$/,''):undefined;if(drive&&!(home&&home.length>1&&(path===home||path.startsWith(home+'/'))))path=drive+path;}
   else if(!/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path)){if(!base)continue;path=base.replace(/[\\/]$/,'')+'/'+path;}
  }
  // Item 4(b): PowerShell or cmd text naming a root-relative Windows path, seen from a host with no drives, is read on the system drive.
  else if((inv.dialect==='pwsh'||inv.dialect==='cmd')&&/^\\(?![\\/])[^/]*$/.test(path))path='C:'+path;
  else if(!path.startsWith('/')){if(!base)continue;path=base.replace(/\/$/,'')+'/'+path;}
  // Overlay lookup uses lexical separators; a final link is followed only by traversal semantics.
  const flat=(s:string)=>s.replaceAll('\\','/').replace(/\/$/,'');
  const link=[...(inv.links??[])].sort((a,b)=>b[0].length-a[0].length).find(([name])=>flat(path).startsWith(flat(name)+'/')||flat(path)===flat(name)&&(value.wholeDirGlob||/[\\/]$|[\\/]\.$/.test(path)));
  if(link)path=link[1]+flat(path).slice(flat(link[0]).length);
  paths.push(path);
 }
 return [...new Set(paths)];
}
export function operand(value:Value,cwd:Value,inv:Omit<Parameters<typeof toAbsolute>[1],'cwd'>={}):Value {
 if(value.k==='opaque'||!value.s)return value;
 const paths=toAbsolute(value,{...inv,cwd});if(!paths.length)return opaque('cwd');
 let glob=value.glob;if(glob){const bases=toAbsolute(known('base' in glob?glob.base:glob.dir),{...inv,cwd});glob='base' in glob?{...glob,base:bases[0]??glob.base,dir:bases[0]??glob.dir}:{...glob,dir:bases[0]??glob.dir};}
 return {...value,s:paths[0]!,candidates:paths.length>1?paths:undefined,glob,drive:inv.drive};
}
