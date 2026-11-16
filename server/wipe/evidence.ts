// SPDX-License-Identifier: AGPL-3.0-or-later
import {known,opaque,type Invocation,type ShellState} from './types.ts';
/** Independent recovery reader. Iterative and total; quoted data never becomes a command. */
export function evidenceScan(source:string,state:ShellState):Invocation[] {
 const out:Invocation[]=[],work=[source];
 const unresolved='\0unresolved\0',env=new Map([...state.env].map(([name,value])=>[state.dialect==='sh'?name:name.toLowerCase(),value]));
 const wrappers=new Set('sudo doas run0 pkexec env nice ionice chrt taskset nohup setsid stdbuf timeout time command builtin exec flock caffeinate chronic unbuffer watch su runuser systemd-run busybox toybox winpty fakeroot eatmydata'.split(' '));
 const shells=new Set('sh bash rbash zsh dash ksh ksh93 mksh lksh oksh pdksh ash hush yash posh osh fish nu elvish xonsh csh tcsh pwsh powershell powershell_ise cmd eval'.split(' '));
 while(work.length){
  const input=work.pop()!;let words:string[]=[],globs:boolean[]=[],outputs:{op:string;at:number}[]=[],word='',quote='',started=false,wordGlob=false;
  const put=()=>{if(started){words.push(word);globs.push(wordGlob);word='';started=false;wordGlob=false;}};
  const emit=()=>{
   put();if(!words.length)return;words=words.map(word=>word===unresolved?word:word.replaceAll(unresolved,''));
   const excluded=new Set(outputs.map(output=>output.at)),keep=words.map((word,at)=>({word,glob:globs[at]})).filter((_,at)=>!excluded.has(at));
   const writes=outputs.filter(output=>!['<','<&'].includes(output.op)).map(output=>({op:output.op as Invocation['redirects'][number]['op'],target:words[output.at]===unresolved?opaque('unresolved-variable'):known(words[output.at]??'')}));
   words=keep.map(value=>value.word);globs=keep.map(value=>!!value.glob);
   if(writes.length)out.push({program:'',argv:[],rawArgv:[],redirects:writes,cwd:state.cwd,dialect:state.dialect,platform:state.platform,drive:state.drive});
   let index=0;
   while(index<words.length&&/^\w+=/.test(words[index]!))index++;
   if(state.dialect==='pwsh'){
    const assignment=/^(?:\[[^\]]+\])?\$(?:\{[^}]+\}|[\w:]+)(?:\.[\w]+|\[[^\]]+\])?(?:\?\?=|[+*\/%-]?=)(.*)$/.exec(words[index]??'');
    if(assignment){if(assignment[1])words[index]=assignment[1];else index++;}
    else if(/^\$/.test(words[index]??'')&&/^(?:\?\?=|[+*\/%-]?=)$/.test(words[index+1]??''))index+=2;
   }
   let program=(words[index++]??'').split(/[\\/]/).at(-1)!.replace(/\.(?:exe|cmd|bat|com)$/i,'').toLowerCase();
   while(wrappers.has(program)&&index<words.length){
    const wrapper=program;
    while((words[index]??'').startsWith('-')){
     const option=words[index++]!;
     if(['--help','--version'].includes(option)||wrapper==='command'&&/^-[p]*[vV]/.test(option)||wrapper==='sudo'&&/^-[Vvl]$|^--(?:list|validate)$/.test(option)){words=[];globs=[];outputs=[];return;}
     if(/^(?:-[ughnCDSfoa]|--(?:user|group|host|chdir|split-string|format|output))$/.test(option))index++;
    }
    if(['timeout','flock','chrt','taskset'].includes(wrapper))index++;
    program=(words[index++]??'').split(/[\\/]/).at(-1)!.toLowerCase();
   }
   const args=words.slice(index);
   if(shells.has(program)){
    if(program==='eval')work.push(args.join(' '));
    else {const at=args.findIndex(w=>/^(?:-[a-z]*c|-(?:command|c)|\/\/?[ck])$/i.test(w));if(at>=0&&!(!['pwsh','powershell','cmd'].includes(program)&&args.slice(0,at+1).some(word=>/^-[a-z]*n[a-z]*$/.test(word))))work.push(args.slice(at+1).join(' '));}
   }else out.push({program,argv:args.map((s,j)=>{if(s===unresolved)return opaque('unresolved-variable');if(!globs[index+j])return known(s);if(s==='*'||s==='**')return {...known('.'),wholeDirGlob:true};const glob=/^(.*[\\/])\*\*?$/.exec(s);if(glob)return {...known(glob[1]!),wholeDirGlob:true};const at=Math.max(s.lastIndexOf('/'),s.lastIndexOf('\\'));return {...known(s),glob:{dir:at<0?'.':s.slice(0,at)||'/',pattern:s.slice(at+1)}};}),rawArgv:[],redirects:[],cwd:state.cwd,dialect:state.dialect,home:state.home,env:new Map(state.env),platform:state.platform,drive:state.drive,links:state.links});
   words=[];globs=[];outputs=[];
  };
  for(let i=0;i<input.length;i++){
   const ch=input[i]!;
   if(ch==='\\'&&quote!=="'"){started=true;if(state.dialect!=='sh'||/^[a-z]:/i.test(word)||quote==='\"'&&!/[$`\"\\]/.test(input[i+1]??'')){word+=ch;continue;}if(i+1<input.length)word+=input[++i];continue;}
   if(ch==='$'&&input[i+1]==='('&&quote!=="'"){
    const at=i+2;let balance=1,q='';i++;
    while(++i<input.length){const c=input[i]!;if(c==='\\'){i++;continue;}if(q){if(c===q)q='';continue;}if(c==='"'||c==="'"){q=c;continue;}if(c==='(')balance++;if(c===')'&&--balance===0)break;}
    work.push(input.slice(at,i));started=true;word+='opaque';continue;
   }
   if(ch==='`'&&quote!=="'"){const at=i+1;while(++i<input.length&&input[i]!=='`')if(input[i]==='\\')i++;work.push(input.slice(at,i));word+='opaque';started=true;continue;}
   if(ch==='$'&&quote!=="'"){
    const assignment=state.dialect==='pwsh'&&!quote?/^\$(?:\{[^}]+\}|[\w:]+)(?:\.\w+|\[[^\]]+\])?\s*(?:\?\?=|[+*\/%-]?=)/.exec(input.slice(i)):null;
    if(assignment){word+=assignment[0].replace(/\s/g,'');i+=assignment[0].length-1;started=true;continue;}
    const match=(state.dialect==='pwsh'?/^(?:\{([\w:]+)\}|([\w:]+))/:/^(?:\{(\w+)\}|(\w+))/).exec(input.slice(i+1));
    if(match){const name=(match[1]??match[2]!).replace(/^(?:env|global|script|local|private):/i,''),value=env.get(state.dialect==='sh'?name:name.toLowerCase());word+=value??(state.vars?.has(name)?'':unresolved);wordGlob ||=!quote&&/[*?\[]/.test(value??'');i+=match[0].length;started=true;continue;}
   }
   if(ch==='~'&&!quote&&!started){word+=state.home;started=true;continue;}
   if(quote){if(ch===quote)quote='';else word+=ch;started=true;continue;}
   if(ch==='"'||ch==="'"){quote=ch;started=true;continue;}
   if(ch==='#'&&!started){while(i<input.length&&input[i]!=='\n')i++;emit();continue;}
   if(ch==='<'&&input[i+1]==='<'){
    // Here documents are data. Their executable consumers are handled by precise parsing.
    i+=2;if(input[i]==='-')i++;let delimiter='';while(i<input.length&&/[ \t]/.test(input[i]!))i++;
    while(i<input.length&&!/\s/.test(input[i]!))delimiter+=input[i++];delimiter=delimiter.replace(/['"]/g,'');
    const line=input.indexOf('\n',i);if(line<0){i=input.length;continue;}
    const close=input.indexOf('\n'+delimiter,line);i=close<0?input.length:close+delimiter.length;continue;
   }
   const redirect=/^(?:\d+)?(&>>|&>|>>|>&|>|<>|<&|<)/.exec(input.slice(i));if(redirect){put();outputs.push({op:redirect[1]!,at:words.length});i+=redirect[0].length-1;continue;}
   if(ch==='{'&&input[i+1]==='}'){word+='{}';started=true;i++;continue;}
   if(ch==='('||ch===')'||ch==='{'||ch==='}'){emit();continue;}
   if(/[;&|\n]/.test(ch)){emit();continue;}
   if(/\s/.test(ch)){put();continue;}
   wordGlob ||= /[*?\[]/.test(ch);started=true;word+=ch;
  }
  emit();
 }
 return out;
}
/** Used only if even the independent scanner faults. No exception text is exposed. */
export const coarseEvidence=(source:string)=>coarseDiskEvidence(source)||/\b(?:rm|srm|rd|rmdir|ri|del|erase|remove-item|mv|move-item|move|ren|rsync|find|mkfs\w*|diskpart|format|dd|wipefs|diskutil|format-volume|clear-disk)\b/i.test(source)&&/(?:[\/\\](?:home|Users|usr|etc|var|dev|mnt|Volumes)|(?:^|\s)[\/\\](?:\s|$)|~|[a-z]:[\/\\]|\$\{?HOME\b|\$env:(?:USERPROFILE|HOMEDRIVE|SystemDrive|SystemRoot)\b|%(?:USERPROFILE|HOMEDRIVE|SystemDrive|SystemRoot)%|(?:^|[\s"'=])\/(?:bin|sbin|boot|lib(?:32|x32|64|exec)?|opt|System|Library|Applications|media|root)(?=[\/\s"']|$))/i.test(source);
// Quoted text and comments are data: command boundaries and switches count only outside them.
const bareCommands=(source:string):{bare:string;raw:string}[]=>{
 const out:{bare:string;raw:string}[]=[];let current='',quote='',start=0;
 const cut=(i:number)=>{out.push({bare:current,raw:source.slice(start,i)});current='';start=i+1;};
 for(let i=0;i<source.length;i++){const ch=source[i]!;
  if(quote){if(ch==='`'&&quote==='"')i++;else if(ch===quote)quote='';continue;}
  if(ch==='"'||ch==="'"){quote=ch;current+='\u0001';continue;}
  if(ch==='`'){i++;current+='\u0001';continue;}
  if(ch==='<'&&source[i+1]==='#'){const end=source.indexOf('#>',i+2);i=end<0?source.length:end+1;continue;}
  if(ch==='#'&&(!current||/\s$/.test(current))){while(i<source.length&&source[i]!=='\n')i++;cut(i);continue;}
  if(';\n|&'.includes(ch)){cut(i);continue;}
  current+=ch;
 }
 cut(source.length);return out;
};
// Storage cmdlets and disk tools name a disk by number/letter rather than by a filesystem path.
// Keep this last-resort evidence at command boundaries; printed examples are data. A child host's command text is commands.
const coarseDiskEvidence=(source:string,depth=0):boolean=>bareCommands(source).some(({bare:command,raw})=>{
 if(/^\s*(?:remove-partition|format-volume|clear-disk)\b/i.test(command)&&!/(?:^|\s)-(?:whatif|whati|what|wha|wh|wi)(?::\$?true)?(?=\s|$)|(?:^|\s)-\?(?=\s|$)/i.test(command))return true;
 if(/^\s*(?:diskpart(?:\.exe)?(?=\s|$)|format(?:\.com)?\s+[a-z]:)/i.test(command)&&!/(?:^|\s)\/\?(?=\s|$)/.test(command))return true;
 const child=depth<3&&/^\s*(?:pwsh|powershell|cmd)(?:\.exe)?\s/i.test(command)?/["']([\s\S]*)["']/.exec(raw):null;
 return !!child&&coarseDiskEvidence(child[1]!.replace(/\\"/g,'"'),depth+1);
});
