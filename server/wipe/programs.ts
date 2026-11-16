// SPDX-License-Identifier: AGPL-3.0-or-later
import { known, opaque, type Invocation, type Value, type WipeEffect, type EffectRecord, type InvocationSnapshot } from './types.ts';
import {asValue,fromValue} from './may.ts';
import {effectRecord,invocationSnapshot} from './effect-records.ts';
import {findRecords} from './find.ts';
import {interpreterEffects} from './interp.ts';
import {peel} from './invocation.ts';
import { operand } from './expand.ts';
import {hostFor,readHost} from './hosts.ts';
import {cmdletFor,pwshEffects} from './pwsh-model.ts';
export interface Grammar {shortFlags:string;shortWithValue:string;longFlags:string[];longWithValue:string[]; optionalValue?:string}
const grammar=(shortFlags='',shortWithValue='',longFlags:string[]=[],longWithValue:string[]=[]):Grammar=>({shortFlags,shortWithValue,longFlags,longWithValue});
// Effect programs and xargs keep this reader; hosts and wrappers are rows in hosts.ts.
export const grammars:Record<string,Grammar>={
 rm:grammar('rfRidvIP','', ['recursive','force','interactive','dir','verbose','one-file-system','no-preserve-root','preserve-root','help','version']),
 unlink:grammar('','',['help','version']),
 mv:grammar('fintTvubZ','tS',['force','interactive','no-clobber','no-target-directory','verbose','strip-trailing-slashes','backup','update','help','version'],['target-directory','suffix','context']),
 rsync:grammar('avrzhlptgoDqcnuiRHEAXWSKCxbkOyJ146','eBTfM',['delete','del','delete-before','delete-during','delete-delay','delete-after','delete-excluded','delete-missing-args','remove-source-files','quiet','archive','verbose','recursive','dry-run','force','ignore-errors','numeric-ids','stats','progress','checksum','compress','help','version','relative','dirs','perms','times','owner','group','devices','specials','links','hard-links','acls','xattrs','sparse','whole-file','size-only','existing','ignore-existing','inplace','append','append-verify','prune-empty-dirs','itemize-changes'],
  ['rsh','filter','exclude','include','exclude-from','include-from','files-from','password-file','chmod','chown','timeout','port','suffix','log-file','log-file-format','backup-dir','partial-dir','temp-dir','link-dest','copy-dest','compare-dest','bwlimit','max-size','min-size','max-delete','out-format','rsync-path','info','debug','usermap','groupmap','modify-window','compress-choice','checksum-choice','sockopts','outbuf','iconv','address','contimeout','protocol','block-size']),
 shred:grammar('fuvxz','ns',['force','remove','verbose','exact','zero'],['iterations','size','random-source']),
 xargs:{...grammar('0prtx','nPIasLdEil',['null','no-run-if-empty','verbose','interactive','exit'],['max-args','max-procs','replace','arg-file','max-chars','max-lines','delimiter','eof']),optionalValue:'il'},
};
export interface Options {positionals:Value[];flags:Set<string>;values:Map<string,Value[]>;uncertain:boolean;consumed:Value[];restAt:number}
/** The same argv grammar reads programs and wrappers, including value options in bundles. */
export function readOptions(argv:Value[],g:Grammar,stop=false):Options {
 const out:Options={positionals:[],flags:new Set(),values:new Map(),uncertain:false,consumed:[],restAt:argv.length};let ended=false;
 const value=(name:string,v:Value)=>{out.values.set(name,[...(out.values.get(name)??[]),v]);out.consumed.push(v);};
 for(let i=0;i<argv.length;i++){
  const v=argv[i]!,s=v.k==='known'?v.s:'';
  if(!ended&&s==='--'){ended=true;continue;}
  if(!ended&&s.startsWith('--')){
   const at=s.indexOf('='),name=s.slice(2,at<0?undefined:at),names=[...g.longFlags,...g.longWithValue];
   const resolved=names.includes(name)?name:names.filter(n=>n.startsWith(name)).length===1?names.find(n=>n.startsWith(name)):undefined;
   if(!resolved){out.uncertain=true;continue;}out.flags.add(resolved);
   if(g.longWithValue.includes(resolved))value(resolved,at<0?argv[++i]??known(''):known(s.slice(at+1)));
   else if(at>=0)out.uncertain=true;
   continue;
  }
  if(!ended&&s.startsWith('-')&&s!=='-'){
   for(let j=1;j<s.length;j++){
    const ch=s[j]!;out.flags.add(ch);
    if(g.shortWithValue.includes(ch)){
     const inline=s.slice(j+1);value(ch,inline?known(inline):g.optionalValue?.includes(ch)?known(''):argv[++i]??known(''));break;
    }
    if(!g.shortFlags.includes(ch))out.uncertain=true;
   }
   continue;
  }
  if(stop){out.restAt=i;break;}
  out.positionals.push(v);
 }
 return out;
}
const str=(v:Value|undefined)=>v?.k==='known'?v.s:undefined;
const unknownOptionWord=(argv:Value[])=>{for(const value of argv){if(value.k==='known'&&value.s==='--')return false;if(value.k==='opaque'&&['variable','unresolved-variable'].includes(value.why))return true;}return false;};
const local=(v:Value)=>v.k==='opaque'||!(/^(?:rsync:\/\/)|^[^/\\]+:/.test(v.s)&&!/^\w:[\\/]/.test(v.s));
function cmdOptions(inv:Invocation):Options {
 const out:Options={positionals:[],flags:new Set(),values:new Map(),uncertain:false,consumed:[],restAt:inv.argv.length};
 for(const v of inv.argv){const s=str(v)??'';if(/^\/(?:[sqfpayl]|mir|purge|move|mov)(?:\/(?:[sqfpayl]|mir|purge|move|mov))*$/i.test(s))for(const flag of s.slice(1).split('/'))out.flags.add(flag.toLowerCase());else out.positionals.push(v);}
 return out;
}
function programRecords(inv:Invocation):EffectRecord[] {
 let origin:InvocationSnapshot|undefined;const record=(effect:WipeEffect)=>effectRecord(effect,origin??=invocationSnapshot(inv));
 const p=/^(?:Format-Volume|Clear-Disk|Remove-Partition)$/i.test(inv.program)?inv.program.toLowerCase():inv.program,a=inv.argv,words=a.map(v=>str(v)??''),target=(v:Value)=>operand(v,inv.cwd,inv),effects:EffectRecord[]=[],emit=(...items:WipeEffect[])=>effects.push(...items.map(record));
 if(['remove-item','move-item','rename-item','format-volume','clear-disk','remove-partition'].includes(p)&&words.some(w=>/^-(?:whatif|whati|what|wha|wh|wi)(?::(?:\$?true))?$/i.test(w)))return effects;
 if(['format-volume','clear-disk','remove-partition'].includes(p)&&words.includes('-?'))return effects;
 for(const r of inv.redirects)if(['>','>>','&>','&>>','>|','<>','>&'].includes(r.op))emit({k:'device-write',target:target(r.target)});
 if((/^mkfs(?:\.|$)/.test(p)||['mke2fs','wipefs','diskpart','diskutil','format','format-volume','clear-disk','remove-partition'].includes(p))&&['--help','--version','-?'].includes(words[0]??''))return effects;
 if(/^(?:mkfs(?:\.|$)|newfs(?:_\w+)?$)/.test(p)&&!['--help','--version','-?'].includes(words[0]??'')||['mke2fs','wipefs','diskpart','format-volume','clear-disk','remove-partition'].includes(p))return [...effects,record({k:'disk-tool',tool:p})];
 if(p==='diskutil'&&(/^(?:erase.*|partitionDisk|zeroDisk|randomDisk|secureErase|reformat)$/i.test(words.find(w=>!w.startsWith('-'))??'')||words[0]?.toLowerCase()==='apfs'&&words[1]?.toLowerCase()==='deletecontainer'))return [...effects,record({k:'disk-tool',tool:p})];
 if(p==='format'&&words.some(w=>/^[a-z]:[\\/]?$/i.test(w)))return [...effects,record({k:'disk-tool',tool:p})];
 if(p==='sed')for(const file of sedWrites(words))emit({k:'device-write',target:target(known(file))});
 if(p==='dd'){for(const v of a)if(v.k==='known'&&v.s.startsWith('of='))emit({k:'device-write',target:target(known(v.s.slice(3)))});return effects;}
 if(p==='tee'||p==='cp'){const paths=a.filter(v=>v.k!=='known'||!v.s.startsWith('-'));for(const v of p==='cp'?paths.slice(-1):paths)emit({k:'device-write',target:target(v)});return effects;}
 if(p==='sort'){for(let i=0;i<a.length;i++){const s=words[i]!;if(s==='-o'||s==='--output'){if(a[i+1])emit({k:'device-write',target:target(a[++i]!)});}else if(/^-o./.test(s))emit({k:'device-write',target:target(known(s.slice(2)))});else if(s.startsWith('--output='))emit({k:'device-write',target:target(known(s.slice(9)))});}return effects;}
 if(p==='shred'){const opts=readOptions(a,grammars.shred!);for(const v of opts.positionals)emit({k:'device-write',target:target(v)});return effects;}
 const interp=hostFor(p);
 if(interp?.kind==='interp'){
  // Which argv word is source comes from the host grammar (hosts.ts), in any legal bundle.
  const read=readHost(a,interp);if(read.noexec)return effects;
  const sources:string[]=[],operands=read.positionals;let coded=read.sources.some(source=>source.code);
  for(const source of read.sources)if(source.code&&source.text.k==='known')sources.push(source.text.s);
  if(interp.subcommands&&!coded&&interp.subcommands[str(operands[0])??'']==='code'){coded=true;const code=operands.slice(1).find(v=>v.k!=='known'||!v.s.startsWith('-'));if(code?.k==='known')sources.push(code.s);}
  // Fail direction: every word after an option the grammar does not know is read once as source.
  for(const word of read.uncertain)if(word.k==='known'&&!word.s.startsWith('-'))sources.push(word.s);
  if(!coded&&!read.fileMode&&(!operands.length||str(operands[0])==='-')&&p!=='deno'&&inv.stdin?.k==='known')sources.push(inv.stdin.s);
  for(const source of sources){const scan=interpreterEffects(source,inv.env?.get('HOME')??inv.env?.get('USERPROFILE')??inv.home??'',p);emit(...scan.effects.map(effect=>effect.k==='delete'?{...effect,target:target(effect.target)}:effect.k==='move-away'?{...effect,source:target(effect.source),...(effect.destination===undefined?{}:{destination:target(effect.destination)})}:effect));const state={env:new Map(inv.env),home:inv.home??'',cwd:inv.cwd,dialect:'sh' as const,depth:0,platform:inv.platform,drive:inv.drive,links:inv.links};for(const body of scan.shells)effects.push(...peel([known('sh'),known('-c'),known(body)],state).flatMap(effectRecordsOf));for(const argv of scan.argv)effects.push(...peel(argv,state).flatMap(effectRecordsOf));}
  return effects;
 }
 if(p==='git'){
  let cwd=inv.cwd,workTree=inv.env?.get('GIT_WORK_TREE'),at=0;
  for(;at<words.length;at++){const word=words[at]!;if(word==='-C'){cwd=asValue(fromValue(operand(a[++at]??opaque('git-cwd'),cwd,inv)));continue;}if(word.startsWith('-C')&&word.length>2){cwd=asValue(fromValue(operand(known(word.slice(2)),cwd,inv)));continue;}if(word==='--work-tree'){workTree=words[++at];continue;}if(word.startsWith('--work-tree=')){workTree=word.slice(12);continue;}if(['-c','--git-dir'].includes(word)){at++;continue;}if(word.startsWith('--git-dir='))continue;if(!word.startsWith('-'))break;}
  if(words[at]==='clean'){const opts=readOptions(a.slice(at+1),grammar('dfxXniq', 'e',['force','dry-run','interactive','quiet','help','version'],['exclude']));const dry=['n','dry-run','i','interactive','help','version'].some(f=>opts.flags.has(f));const paths=opts.positionals;if(!dry&&(opts.flags.has('f')||opts.flags.has('force'))&&opts.flags.has('d')&&paths.every(v=>v.k==='known'&&['.','*','**','./'].includes(v.s))){const dest=workTree?operand(known(workTree),cwd,inv):cwd;emit({k:'git-clean',target:dest,follow:true});}}
  return effects;
 }
 if(p==='find'&&['--help','--version','-help','-version'].includes(words[0]??''))return effects;
 if(p==='find')return [...effects,...findRecords(inv)];
 // PowerShell consumers and producers: one effect model (pwsh-model.ts). MAIN RULING WIPE-V3-PREMISE is applied there.
 if(inv.dialect==='pwsh'&&cmdletFor(p))return [...effects,...pwshEffects(inv).map(record)];
 if(['rd','del','erase','move','ren','rename','robocopy'].includes(p)||p==='rmdir'&&inv.dialect!=='sh'){
  const opts=cmdOptions(inv);
  if(['rd','rmdir','del','erase'].includes(p)&&opts.flags.has('s'))for(const v of opts.positionals)emit({k:'delete',target:target(v),recursive:true});
  if((p==='ren'||p==='rename')&&opts.positionals[0])emit({k:'move-away',source:target(opts.positionals[0])});
  if(p==='move')for(const v of opts.positionals.slice(0,-1))emit({k:'move-away',source:target(v)});
  if(p==='robocopy'){
   if(opts.flags.has('l'))return effects;
   if((opts.flags.has('mir')||opts.flags.has('purge'))&&opts.positionals[1])emit({k:'sync-wipe',dest:target(opts.positionals[1])});
   if(opts.flags.has('move')&&opts.positionals[0])emit({k:'move-away',source:target(opts.positionals[0])});
  }
  return effects;
 }
 if(!['rm','srm','grm','unlink','mv','rsync','truncate'].includes(p))return effects;
 if(p==='truncate')return [...effects,...a.filter(v=>!!v.entryOf).map(v=>record({k:'delete',target:v,recursive:false}))];
 const opts=readOptions(a,grammars[p==='srm'||p==='grm'?'rm':p]!),has=(...names:string[])=>names.some(n=>opts.flags.has(n));
 if(has('help','version'))return effects;
 if(p==='rm'||p==='srm'||p==='grm'||p==='unlink')for(const v of opts.positionals)emit({k:'delete',target:target(v),recursive:has('r','R','recursive')});
 if(p==='mv'){
  const targetDir=has('t','target-directory'),noTargetDir=has('T','no-target-directory');
  const sources=targetDir?opts.positionals:noTargetDir?opts.positionals.slice(0,1):opts.positionals.slice(0,-1);
  for(const v of sources)emit({k:'move-away',source:target(v)});
 }
 if(p==='rsync'&&has('n','dry-run'))return effects;
 if(p==='rsync'){
  const dest=opts.positionals.at(-1),sources=opts.positionals.slice(0,-1);
  if(dest&&[...opts.flags].some(n=>n==='del'||n.startsWith('delete'))&&local(dest))emit({k:'sync-wipe',dest:target(dest)});
  if(has('remove-source-files'))for(const v of sources)if(local(v))emit({k:'move-away',source:target(v)});
 }
 const unknownOptions=['rm','srm','grm'].includes(p)&&unknownOptionWord(a);
 const risky=p==='mv'||(['rm','srm','grm'].includes(p)&&(unknownOptions||words.some(w=>/^-[^-]*[rR]/.test(w)||w==='--recursive')))||p==='rsync'&&words.some(w=>/^--(?:del|remove-source)/.test(w));
 const uncertain=opts.uncertain||unknownOptions;
 const nonDestructive=new Set(opts.consumed);
 if(p==='mv'&&!has('t','target-directory')&&opts.positionals.length>=2&&opts.positionals.at(-1))nonDestructive.add(opts.positionals.at(-1)!);
 if(p==='rsync'&&!has('remove-source-files'))for(const source of opts.positionals.slice(0,-1))nonDestructive.add(source);
 if(uncertain&&risky)emit({k:'uncertain-operands',program:p,words:opts.positionals.filter(v=>!nonDestructive.has(v)).map(target)});
 return effects;
}

/** Effects retain grammar-assigned roles for diagnostics and the backstop. */
/** Item 4(g): files a sed script writes (`w file`, `s///w file`); the name runs to the end of its line. */
function sedWrites(args:readonly string[]):string[] {
 const scripts:string[]=[],positionals:string[]=[];let explicit=false;
 for(let i=0;i<args.length;i++){
  const s=args[i]!;
  if(s==='--'){positionals.push(...args.slice(i+1));break;}
  if(/^-[A-Za-z]*e$/.test(s)||s==='--expression'){explicit=true;scripts.push(args[++i]??'');}
  else if(s.startsWith('--expression=')){explicit=true;scripts.push(s.slice(13));}
  else if(/^-[A-Za-z]*f$/.test(s)||s==='--file'){explicit=true;i++;}
  else if(s.startsWith('--file=')){explicit=true;}
  else if(/^-[A-Za-z]*l$/.test(s)||s==='--line-length')i++;
  else if(!s.startsWith('-')||s==='-')positionals.push(s);
 }
 if(!explicit){const first=positionals.find(Boolean);if(first!==undefined)scripts.push(first);}
 const out:string[]=[];
 for(const script of scripts){
  let i=0,guard=0;const n=script.length;
  const delimited=(count:number)=>{const d=script[i++];if(d===undefined||d==='\n'||d==='\\')return false;for(let k=0;k<count;k++){while(i<n&&script[i]!==d){if(script[i]==='\\')i++;i++;}if(i>=n)return false;i++;}return true;};
  const rest=()=>{const stop=script.indexOf('\n',i),s=script.slice(i,stop<0?n:stop);i=stop<0?n:stop+1;return s.trim();};
  scan:while(i<n&&guard++<4096){
   for(;;){
    const ch=script[i]??'';
    if(/[\s;0-9$,~+!]/.test(ch)&&ch){i++;continue;}
    if(ch==='/'){if(!delimited(1))break scan;while(/[IM]/.test(script[i]??''))i++;continue;}
    if(ch==='\\'&&i+1<n){i++;if(!delimited(1))break scan;continue;}
    break;
   }
   const c=script[i++];if(c===undefined)break;
   if(c==='s'){if(!delimited(2))break;while(i<n&&/[gpiIemM0-9]/.test(script[i]!))i++;if(script[i]==='w'){i++;out.push(rest());}}
   else if(c==='y'){if(!delimited(2))break;}
   else if(c==='w'||c==='W')out.push(rest());
   else if('aicrR#'.includes(c))rest();
   else if('btT:'.includes(c)){while(i<n&&!/[;\n]/.test(script[i]!))i++;}
  }
 }
 return out.filter(Boolean);
}
export function effectRecordsOf(inv:Invocation):EffectRecord[] & {roles:ReadonlyMap<Value,string>} {
 const records=programRecords(inv).map(record=>{
 const original=record.effect;const normalize=():WipeEffect=>{
  let effect=original;const entry=effect.k==='delete'||effect.k==='device-write'?effect.target.entryOf:undefined;if(entry&&(effect.k==='delete'&&(entry.wholeTree||effect.recursive&&entry.rootSelf)||effect.k==='device-write'&&inv.program==='shred'&&entry.wholeTree))effect={k:'delete',target:known(entry.start),recursive:true,follow:false};
  if(effect.k==='delete'){const v=effect.target;return {...effect,follow:effect.follow??(inv.program==='remove-item'||v.k==='known'&&(!!v.wholeDirGlob||/[\\/]$|[\\/]\.$/.test(v.s))||inv.program==='find'&&inv.argv.some(v=>v.k==='known'&&/^-[HL]$/.test(v.s)))};}
  if(effect.k==='move-away')return {...effect,follow:false};
  if(effect.k==='sync-wipe')return {...effect,follow:true};
  if(effect.k==='uncertain-operands')return {...effect,follow:inv.program==='rsync'||inv.program==='remove-item'||inv.program==='del'||inv.program==='erase'};
  return effect;
 };return effectRecord(normalize(),record.origin);
 });
 const roles=new Map<Value,string>();
 const g=grammars[inv.program];if(g){const opts=readOptions(inv.argv,g);for(const v of opts.consumed)roles.set(v,'option-value');if(inv.program==='mv'&&!opts.flags.has('t')&&!opts.flags.has('target-directory')&&opts.positionals.at(-1))roles.set(opts.positionals.at(-1)!,'destination');if(inv.program==='rsync'&&!opts.flags.has('remove-source-files'))for(const v of opts.positionals.slice(0,-1))roles.set(v,'source-read');}
 return Object.assign(records,{roles});
}


/** Compatibility projection retains ordering, roles and verdict semantics. */
export function effectsOf(inv:Invocation):WipeEffect[] & {roles:ReadonlyMap<Value,string>} {
 const records=effectRecordsOf(inv);return Object.assign(records.map(record=>record.effect),{roles:records.roles});
}
