// SPDX-License-Identifier: AGPL-3.0-or-later
// These are raw, case-insensitive words. Parsing may add findings, never
// remove these findings, including when the parser fails or reaches a limit.
export const DELETE_PRIMITIVES = [
 'rm ', 'rmdir', 'unlink', 'shred', 'srm', 'Remove-Item', 'ri ', 'del ',
 'erase', 'rd ', '-delete', 'git clean', 'dd ', 'mkfs', 'wipefs',
 'diskpart', 'format ', 'rmtree', 'os.remove', 'os.unlink', 'os.rmdir', 'fs.rm',
 'rmSync', 'rimraf', 'unlinkSync', 'File.Delete', 'Directory.Delete',
 'deleteMany', 'deleteOne', 'dropDatabase', 'dropdb', 'dropuser', 'flushall', 'flushdb',
] as const;
// Non-global patterns keep the scan stateless. ASCII boundaries are tested on
// original characters: Unicode letters (including Kelvin sign) are delimiters.
const DELETE_WORD_PATTERNS=DELETE_PRIMITIVES.map(primitive=>{
 const escaped=primitive.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 // Keep the hub's boundary at both ends of the complete literal spelling,
 // including a trailing space. Ordinary prose must retain its RUN control.
 const end='(?=$|[^A-Za-z0-9_])';
 return new RegExp('(?:^|[^A-Za-z0-9_])'+escaped+end,'i');
});
export function rawDeletePrimitive(text:string):boolean {
 return DELETE_WORD_PATTERNS.some(pattern=>pattern.test(text)); // R2-RAW-WORDS
}
/** A lossy evidence copy, never executable text or proof that a target is safe.
 * Keep the original scan too: removing syntax can join otherwise bounded words. */
export function normalizedWipeText(text:string):string {
 const emptyExpansion=/\$\{IFS\}|\$IFS\b|\$\{[A-Za-z_][A-Za-z0-9_]*:?\+\}/g;
 return text.replace(/\\/g,'').replace(emptyExpansion,'').replace(/\$["']/g,'').replace(/["']/g,'')
  .replace(emptyExpansion,'')
  .replace(/\s+/g,' ');
}
// N2 is a bounded forward scan over N1's evidence copy. No regex, shell
// evaluation, wrapper guessing, or producer recognition participates here.
const PIPE_FILTERS=new Set('echo printf grep egrep fgrep rg head tail wc sort uniq cut tr less more cat jq column tee nl fold paste rev'.split(' '));
const PIPE_EXECUTORS=new Set('sh bash zsh dash ksh mksh fish csh tcsh ash busybox python python2 python3 node deno bun perl ruby lua php pwsh powershell cmd eval source exec xargs env nice nohup time timeout stdbuf setsid sudo doas su awk gawk mawk sed'.split(' '));
function stageSeparator(ch:string):boolean {
 return ch.trim()===''||'|;&(){}<>`'.includes(ch);
}
function stageBasename(token:string):string {
 const start=Math.max(token.lastIndexOf('/'),token.lastIndexOf('\\'))+1;
 return token.slice(start).toLowerCase();
}
function stageExecutor(name:string):boolean {
 // Preserve the existing Windows executable spelling controls too.
 return PIPE_EXECUTORS.has(name)||name.endsWith('.exe')&&PIPE_EXECUTORS.has(name.slice(0,-4));
}
function unsafeStage(text:string,start:number,end:number):boolean {
 let first:string|undefined,executor=false,syntax=false;
 for(let i=start;i<end;){
  const ch=text[i]!;
  // Eligibility belongs to the entire stage. A later statement/filter can
  // never hide an executor before or after it, including inside a group.
  if('|;&(){}`\n'.includes(ch))syntax=true;
  if(stageSeparator(ch)){i++;continue;}
  const tokenStart=i++;
  while(i<end&&!stageSeparator(text[i]!))i++;
  const name=stageBasename(text.slice(tokenStart,i));
  first ??= name;
  executor ||= stageExecutor(name);
 }
 return (syntax||!PIPE_FILTERS.has(first??''))&&executor;
}
function unsafeInput(text:string):boolean {
 let receiver:string|undefined,receiverExecutor=false,hasInput=false,depth=0,hereString=false;
 const bodies:number[]=[];
 for(let i=0;i<text.length;){
  const ch=text[i]!;
  if((ch==='<'||ch==='>')&&text[i+1]==='('){
   if(receiverExecutor&&!PIPE_FILTERS.has(receiver??''))return true;
   hasInput=true;bodies.push(depth);depth++;i+=2;continue;
  }
  if(ch==='<'&&text[i+1]==='<'&&text[i+2]==='<'){
   if(receiverExecutor&&!PIPE_FILTERS.has(receiver??''))return true;
   hasInput=true;hereString=true;i+=3;continue;
  }
  if(ch==='(')depth++;
  if(ch===')'){
   depth=Math.max(0,depth-1);
   if(bodies.at(-1)===depth)bodies.pop();
  }
  if(stageSeparator(ch)||ch==='|'){
   const fdRedirect=ch==='&'&&(text[i-1]==='>'||text[i-1]==='<'||text[i+1]==='>');
   if(!bodies.length&&';&|{}'.includes(ch)&&!fdRedirect){
    receiver=undefined;receiverExecutor=false;hasInput=false;hereString=false;
   }
   i++;continue;
  }
  const tokenStart=i++;
  while(i<text.length&&!stageSeparator(text[i]!)&&text[i]!=='|')i++;
  const name=stageBasename(text.slice(tokenStart,i));
  if(bodies.length||hereString){if(stageExecutor(name))return true;}
  else {
   receiver ??= name;
   receiverExecutor ||= stageExecutor(name);
   if(hasInput&&receiverExecutor&&!PIPE_FILTERS.has(receiver))return true;
  }
 }
 return false;
}
export function rawPipedProgram(normalized:string):boolean {
 if(unsafeInput(normalized))return true;
 let start=0,piped=false;
 for(let i=0;i<normalized.length;i++){
  if(normalized[i]!=='|')continue;
  if(normalized[i+1]==='|'){i++;continue;}
  if(piped&&unsafeStage(normalized,start,i))return true;
  if(normalized[i+1]==='&')i++;
  start=i+1;piped=true;
 }
 return piped&&unsafeStage(normalized,start,normalized.length);
}
/** A raw shell reader: quotes/escapes stay attached to words. This is an
 * evidence scan, never an evaluator or a source of executable shell text. */
export type DatabaseInputContext={source:string;offset:number};
export type DatabaseInputReader=(file:string,context?:DatabaseInputContext)=>string|undefined;
type ParseDoubt={value:boolean};
const commentBoundary=(text:string,at:number)=>at===0||/[\s;&|()]/.test(text[at-1]!);
type RawToken = {start?:number;raw:string; kind:'word'|'operator'|'group'|'call'; children:RawToken[][]};
const OUTPUT_READERS=PIPE_FILTERS;
const OBFUSCATED_COMMAND=/[\\"'${}`%]/;
function shellExecution(text:string,readInput?:DatabaseInputReader,mode:'scan'|'certify'|'validate'='certify',doubt:ParseDoubt={value:false}):boolean {
 let offset=0,exhausted=false;
 function read(stop='',depth=0):RawToken[]{
  if(depth>64){exhausted=true;offset=text.length;return [];}
  const tokens:RawToken[]=[];
  while(offset<text.length){
   const ch=text[offset]!;
   if(stop&&ch===stop){offset++;return tokens;}
   if(/[ \t\r]/.test(ch)){offset++;continue;}
   if((ch==='{'||ch==='}')&&(offset===0||/[\s;)]/.test(text[offset-1]!))&&(offset+1===text.length||/[\s;]/.test(text[offset+1]!))){
    offset++;tokens.push(ch==='{'?{raw:'',kind:'group',children:[read('}',depth+1)]}:{raw:ch,kind:'operator',children:[]});continue;
   }
   if(mode!=='scan'&&ch==='#'&&commentBoundary(text,offset)){while(offset<text.length&&text[offset]!=='\n')offset++;continue;}
   if(ch==='('){
    // Adjacent call syntax in Python/JS bodies is data, not a shell group.
    // Shell reserved words can introduce a group without an intervening space.
    const previous=tokens.at(-1),call=previous?.kind==='word'&&offset>0&&!/[\s|;&()]/.test(text[offset-1]!)&&!['if','while','until','for','case','!'].includes(previous.raw);
    offset++;tokens.push({raw:'',kind:call?'call':'group',children:[read(')',depth+1)]});continue;
   }
   if(/[|;&<>\n)]/.test(ch)){
    if(ch===')')doubt.value=true;
    offset++;let raw=ch;
    if(ch!=='\n'&&ch!==')'&&text[offset]===ch||(ch==='|'||ch==='<'||ch==='>')&&text[offset]==='&')raw+=text[offset++];
    if(raw==='<<'&&text[offset]==='<')raw+=text[offset++];
    tokens.push({raw,kind:'operator',children:[]});continue;
   }
   const start=offset,children:RawToken[][]=[];let quote='';
   if(mode==='scan'){
    // No comment, quote, or substitution matcher can consume the tail of
    // execution evidence. Syntax-aware reads only participate in certification.
    while(offset<text.length&&!/[ \t\r|;&<>\n()]/.test(text[offset]!))offset++;
    tokens.push({start,raw:text.slice(start,offset),kind:'word',children});continue;
   }
   while(offset<text.length){
    const c=text[offset]!;
    if(!quote&&(/[ \t\r|;&<>\n()]/.test(c)||stop&&c===stop))break;
    if(c==='\\'&&quote!=="'"){if(offset+1===text.length)doubt.value=true;offset+=Math.min(2,text.length-offset);continue;}
    if(c===quote){quote='';offset++;continue;}
    if(!quote&&(c==='"'||c==="'")){quote=c;offset++;continue;}
    if(quote!=="'"&&c==='$'&&text[offset+1]==='('){offset+=2;children.push(read(')',depth+1));continue;}
    if(quote!=="'"&&c==='`'){offset++;children.push(read('`',depth+1));continue;}
    offset++;
   }
   if(quote||/^(?:case|esac)$/.test(text.slice(start,offset)))doubt.value=true;
   tokens.push({start,raw:text.slice(start,offset),kind:'word',children});
  }
  if(stop)doubt.value=true;
  return tokens;
 }
 function program(words:RawToken[]):{index:number;commands:number[]} {
  let i=0;const commands:number[]=[];
  while(i<words.length){
   const word=words[i]!.raw;
   if(/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)){i++;continue;}
   if(['!','if','then','elif','else','while','until','do','time','{','}'].includes(word)){i++;continue;}
   commands.push(i);
   const name=word.split('/').pop()!.toLowerCase();
   if(!['env','command','builtin','xargs'].includes(name))return {index:i,commands};
   i++;
   while(i<words.length){
    const option=words[i]!.raw;
    if(option==='--'){i++;break;}
    if(/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)&&name==='env'){i++;continue;}
    if(!option.startsWith('-'))break;
    if(name==='env'&&/^(?:-S.|--split-string=)/.test(option))break;
    i++;
    if(name==='env'&&['-u','--unset','-C','--chdir','-a','--argv0'].includes(option)||
       name==='xargs'&&['-a','-d','-E','-I','-L','-n','-P','-s','--arg-file','--delimiter','--eof','--replace','--max-lines','--max-args','--max-procs','--max-chars'].includes(option))i++;
    // Split-string options introduce a command operand: keep its raw spelling.
    if(name==='env'&&(option==='-S'||option==='--split-string'))break;
   }
  }
  return {index:i,commands};
 }
 function inspect(tokens:RawToken[],incoming=false,inputLiteral?:string):{hit:boolean;producer:boolean}{
  let hit=false,producer=false,piped=incoming,previousLiteral:string|undefined=inputLiteral,words:RawToken[]=[],groups:RawToken[][]=[],databaseInputs:Array<string|undefined>=[];
  const finish=()=>{
   const {index,commands}=program(words),command=words[index]?.raw??words[commands[0]??0]?.raw??'',name=command.split('/').pop()!.toLowerCase();
   // env -S groups a literal command line; its grouping quotes are not
   // part of the executable's name. Inspect the split string as code.
   let splitIndex=-1;
   if(commands.some(i=>stageBasename(words[i]!.raw)==='env'))for(let at=0;at<words.length;at++){
    const option=words[at]!.raw;
    if(option==='-S'||option==='--split-string'){
     splitIndex=at+1;const body=literalShellWord(words[splitIndex]?.raw??'');
     if(mode==='scan'||body===undefined||rawDynamicExecution(body,readInput))hit=true;break;
    }
    if(/^(?:-S.|--split-string=)/.test(option)){
     const body=option.startsWith('-S')?option.slice(2):option.slice(option.indexOf('=')+1);
     if(mode==='scan'||rawDynamicExecution(body,readInput))hit=true;break;
    }
   }
   // O1-COMMAND: never normalize a command word before checking its spelling.
   if(commands.some(i=>i!==splitIndex&&OBFUSCATED_COMMAND.test(words[i]!.raw)&&!(/^[A-Za-z]:\\[^$`"']+$/.test(words[i]!.raw)||/^['"]-[A-Za-z]+['"]$/.test(words[i]!.raw))))hit=true;
   let nestedProducer=false,groupProducer=false;
   for(const word of words)for(const child of word.children){const result=inspect(child,piped,previousLiteral);hit ||= result.hit;nestedProducer ||= result.producer;}
   for(const group of groups){const result=inspect(group,piped||databaseInputs.length>0,databaseInputs.length?databaseInputs.at(-1):previousLiteral);hit ||= result.hit;groupProducer ||= result.producer;}
   const reader=OUTPUT_READERS.has(name);
   const executor=!reader&&(stageExecutor(name)||commands.some(i=>stageExecutor(stageBasename(words[i]!.raw))));
   // MAIN T5 / K1-K2: output consumers never execute their input.
   if((piped||nestedProducer)&&executor)hit=true;
   if(/^(?:eval|iex|invoke-expression)$/.test(name)){
    const argument=words.slice(index+1).map(word=>word.raw).join(' ');
    const init=/^"?\$\((?:ssh-agent(?:\s+[^;&|`$()]*)?|brew\s+shellenv|(?:pyenv|rbenv|nodenv)\s+init|direnv\s+export|starship\s+init|zoxide\s+init|fnm\s+env|(?:mise|rtx)\s+activate|conda\s+shell\.bash\s+hook|opam\s+env|keychain)(?:\s+[^;&|`$()]*)?\)"?$/i.test(argument);
    if(!init){
     const literal=literalShellWord(argument);
     if(mode==='scan'||literal===undefined||rawDynamicExecution(literal,readInput))hit=true;
    }
   }
   if(/^(?:sh|bash|dash|ash|zsh|ksh|mksh|fish|csh|tcsh|pwsh|powershell|cmd)$/.test(name)){
    for(let at=index+1;at<words.length-1;at++)if(/^(?:-[^-]*c|--command|-command|\/c)$/i.test(words[at]!.raw)){
     const body=literalShellWord(words[at+1]!.raw);
     if(mode==='scan'||body===undefined||rawDynamicExecution(body,readInput)||rawDeletePrimitive(body))hit=true;
     break;
    }
   }
   if(/^(?:python[0-9.]*|node|nodejs|bun|deno)$/.test(name))for(let at=index+1;at<words.length-1;at++){
    if(!['-c','-e','--eval','-p','--print'].includes(words[at]!.raw))continue;
    const body=literalShellWord(words[at+1]!.raw);
    if(mode==='scan'||body===undefined||rawWipeEvidence(body,name.startsWith('python')?'py':'js'))hit=true;
    break;
   }
   if(/^(?:pwsh|powershell)(?:\.exe)?$/.test(name)&&words.slice(index+1).some(word=>/^-(?:e|en|enc|enco|encod|encode|encoded|encodedcommand)$/i.test(word.raw)))hit=true;
   if(/^\[scriptblock\].+/i.test(name))hit=true;
   if(/^(?:source|\.)$/.test(name))hit=true;
   if(executor&&words.slice(index+1).some(word=>/[$`]/.test(word.raw)&&!word.raw.startsWith("'"))&&!/^(?:eval|iex|invoke-expression)$/.test(name))hit=true;
   if(DATABASE_EXECUTORS.has(name)&&databaseInputs.some(input=>input===undefined||databaseWords(input)))hit=true;
   if(DATABASE_EXECUTORS.has(name)&&databaseArgumentWipe(name,words.slice(index+1).map(word=>word.raw),previousLiteral,piped,readInput?file=>readInput!(file,{source:text,offset:words[index]?.start??0}):undefined))hit=true;
   const output=name==='printf'||name==='echo'||groupProducer;
   producer ||= output||nestedProducer;
   piped ||= output;
   const values=words.slice(index+1).map(word=>literalShellWord(word.raw));
   previousLiteral=literalDatabaseOutput(name,values);
   if(name==='cat'&&values.length===1&&literalDatabaseFile(words[index+1]?.raw??'')!==undefined)previousLiteral=readInput?.(literalDatabaseFile(words[index+1]!.raw)!,{source:text,offset:words[index]?.start??0});
   words=[];groups=[];databaseInputs=[];
  };
  let redirect=false,lastPipe=false,redirectOp='';
  for(let i=0;i<tokens.length;i++){
   const token=tokens[i]!;
   if(token.kind==='call'){
    if(/^(?:eval|iex|invoke-expression|exec|compile)$/i.test(words.at(-1)?.raw??'')){
     const body=token.children[0];const literal=body?.length===1&&body[0]?.kind==='word'?literalShellWord(body[0].raw):undefined;
     if(mode==='scan'||literal===undefined||rawDynamicExecution(literal,readInput))hit=true;
    }
    continue;
   }
   if(token.kind==='group'){if(redirect){if(redirectOp.includes('<'))databaseInputs.push(undefined);redirect=false;}groups.push(...token.children);continue;}
   if(token.kind==='word'){
    if(redirect){
     const selected=program(words),receiver=words[selected.index]?.raw.split('/').pop()?.toLowerCase()??'';
     for(const child of token.children){const result=inspect(child);hit ||= result.hit||stageExecutor(receiver)&&result.producer;}
     if(redirectOp==='<<<'&&stageExecutor(receiver)&&!OUTPUT_READERS.has(receiver)){
      const literal=literalShellWord(token.raw);
      if(mode==='scan'||literal===undefined||rawDynamicExecution(literal,readInput)||rawDeletePrimitive(literal))hit=true;
     }
     if(redirectOp.includes('<')){
      const file=redirectOp==='<<<'?literalShellWord(token.raw):literalDatabaseFile(token.raw);
      const literal=redirectOp==='<<<'?file:file===undefined?undefined:readInput?.(file,{source:text,offset:token.start??0});
      databaseInputs.push(literal); // H1-DATABASE-REDIRECT
     }
     redirect=false;
    }
    else words.push(token);
    lastPipe=false;continue;
   }
   if(token.raw.includes('<')||token.raw.includes('>')){
    if(words.length&&/^\d+$/.test(words.at(-1)!.raw))words.pop();
    redirect=true;redirectOp=token.raw;continue;
   }
   if(token.raw==='\n'&&lastPipe)continue;
   finish();lastPipe=token.raw==='|'||token.raw==='|&';
   if(!lastPipe){piped=incoming;previousLiteral=inputLiteral;}else piped=true;
  }
  finish();return {hit,producer};
 }
 /** No unknown command anywhere may preserve a database-file certificate.
  * Use the same raw token inventory as this reader, before inspecting inputs. */
 function fileInputList(tokens:RawToken[]):boolean {
  let clients=0;
  const list=(tokens:RawToken[]):boolean=>{
   let words:RawToken[]=[],redirect=false,ok=true;
   const finish=()=>{
    if(!words.length)return;
    const name=stageBasename(words[0]!.raw);
    const values=words.map((word,i)=>i===0?word.raw:name==='['&&word.raw===']'?']':literalDatabaseFile(word.raw));
    if(values.some(value=>value===undefined))ok=false;
    else if(DATABASE_EXECUTORS.has(name)){if(++clients>1)ok=false;}
    else if(!readOnlyCertificationStage(name,values as string[]))ok=false;
    words=[];
   };
   for(const token of tokens){
    if(token.kind==='call')return false;
    if(token.kind==='group'){finish();if(!list(token.children.flat()))return false;continue;}
    if(token.kind==='word'){if(redirect)redirect=false;else words.push(token);continue;}
    if(/[<>]/.test(token.raw)){redirect=true;continue;}
    finish();
   }
   finish();return ok;
  };
  return list(tokens);
 }
 // Exhaustion cannot certify the discarded executable syntax.
 const tokens=read();
 if(readInput&&(!simpleCertificationSubset(text)||!fileInputList(tokens)))readInput=undefined;

 return exhausted||mode!=='validate'&&inspect(tokens).hit; // H4-DEPTH-CUTOFF
}
/** No output decoding. Unsupported formats/flags are unknown input. */
export function literalDatabaseOutput(name:string,values:Array<string|undefined>):string|undefined {
 if(!values.every((value):value is string=>value!==undefined)||values.some(value=>value!.includes('\\')))return undefined;
 const args=values as string[];
 if(name==='echo'){
  if(args.some(arg=>arg.startsWith('-')))return undefined; // D3-ECHO-FLAGS
  let at=0;while(/^-[n]+$/.test(args[at]??''))at++;
  return args.slice(at).join(' ')+(at?'':'\n');
 }
 if(name!=='printf'||!args.length)return undefined;
 const format=args[0]!;
 if(/%(?!s)/.test(format)||args.slice(1).some(arg=>arg.includes('%')))return undefined;
 const slots=(format.match(/%s/g)??[]).length;
 if(!slots)return args.length===1?format:undefined;
 let output='',at=0;
 do{
  output+=format.replace(/%s/g,()=>args[++at]??'');
  if(output.length>65536)return undefined;
 }while(at<args.length-1);
 return output;
}
const DATABASE_EXECUTORS=new Set('psql mysql mariadb sqlite sqlite3 mongo mongosh redis-cli sqlcmd cockroach duckdb clickhouse-client cqlsh'.split(' '));
const databaseWords=(text:string)=>/drop|truncate|delete|flushall|flushdb/i.test(text);
function databaseArgumentWipe(program:string,args:string[],stdin?:string,input=false,readInput?:DatabaseInputReader):boolean {
 // MAIN RULING H1: every supplied stdin stream is inspected under D2/D3.
 // Client options, including script files and explicit queries, cannot exempt it.
 if(input&&(stdin===undefined||databaseWords(stdin)))return true;
 const positional:string[]=[];
 // Client help can bypass argument inspection only after stdin was checked.
 const queryOnly=/^(?:psql|mysql|mariadb|sqlite3?|duckdb)$/.test(program);
 if(queryOnly&&args.some(arg=>/^(?:--help|--version|-\?)$/.test(arg)))return false;
 const queryWipe=(raw:string|undefined)=>{const value=raw===undefined?undefined:literalShellWord(raw);return value===undefined||databaseWords(value)||/(?:^|[;\n])\s*(?:source\b|\\[ig]\b|\.read\b)/i.test(value);};
 for(let at=0;at<args.length;at++){
  const arg=args[at]!;
  const query=/^(?:-c|-e|-Q|--command|--execute|--eval|--query)(?:=(.*))?$/.exec(arg);
  if(query){if(queryWipe(query[1]??args[++at]))return true;continue;}
  const attached=/^-[ceQ](.+)$/.exec(arg);if(attached){if(queryWipe(attached[1]!))return true;continue;}
  if(program==='psql'&&(/^(?:-f|--file)(?:=|$)/.test(arg)||arg.startsWith('-f')&&arg.length>2)){const rawFile=arg.startsWith('-f')&&arg.length>2?arg.slice(2):arg.includes('=')?arg.slice(arg.indexOf('=')+1):args[++at];const file=rawFile===undefined?undefined:literalDatabaseFile(rawFile);const body=file==='-'?stdin:file===undefined?undefined:readInput?.(file);if(body===undefined||databaseWords(body))return true;continue;}
  if(/^(?:mysql|mariadb)$/.test(program)&&['-f','--force'].includes(arg))continue;
  if(['-h','-p','-U','-u','-d','-D','--host','--port','--username','--user','--dbname','--database'].includes(arg)){at++;continue;}
  if(arg.startsWith('-')){
   // An unimplemented client option cannot prove stdin is unused.
   if(input&&queryOnly&&!['-X','-q','-t','-A','-v','--no-psqlrc','--quiet','--tuples-only','--no-align','--csv','--batch','-batch'].includes(arg))return true;
  }else positional.push(arg);
 }
 if(/^(?:sqlite3?|duckdb)$/.test(program)&&positional.length>1){if(positional.slice(1).some(queryWipe))return true;}
 return false; // Supplied stdin was inspected before every option.
}
function literalDatabaseFile(raw:string):string|undefined {
 // Preserve the spelling for the authenticated reader, which expands only
 // word-leading unquoted tilde using the owner's home.
 if(/^~(?:\/[^\s$`\\"'*?\[\]{}~]*|$)$/.test(raw))return raw;
 return literalShellWord(raw);
}
function literalShellWord(raw:string):string|undefined {
 if(/^'[^']*'$/.test(raw))return raw.slice(1,-1);
 if(/^"[^"$`\\]*"$/.test(raw))return raw.slice(1,-1);
 return !/[\s$`\\"'*?\[\]{}~]/.test(raw)?raw:undefined;
}
/** Known operand semantics only; never infer read-only behavior from roles. */
export function readOnlyCertificationStage(program:string,words:string[]):boolean {
 if(words[0]?.split('/').at(-1)!==program)return false;
 const args=words.slice(1);
 switch(program){
  case 'echo':return args.every(arg=>!arg.startsWith('-'));
  case 'printf':return args[0]==='%s';
  case 'sort':return !args.some(arg=>/^(?:--(?:output|compress-program|random-source))(?:=|$)/.test(arg)||/^-[^-]*o/.test(arg));
  case 'grep':return !args.some(arg=>arg.startsWith('-')&&(/^(?:--(?:output|recursive|dereference-recursive|only-matching))(?:=|$)/.test(arg)||/^-[^-]*[orR]/.test(arg)));
  case 'cat':case 'head':case 'tail':case 'wc':case 'cut':case 'tr':case 'true':case 'test':case '[':return true;
  case 'cd':case 'pushd':return args.length===1&&!args[0]!.startsWith('-');
  case 'popd':return args.length===0;
  default:return false;
 }
}
/** MAIN DESIGN D3: certification is a privilege of this small syntax subset.
 * This forward check never changes the bytes seen by fullExecutionScan. */
export function simpleCertificationSubset(text:string,bindings=true):boolean {
 if(text.length>65536||/\\\r?\n/.test(text))return false; // D3-NO-CONTINUATION
 let quote='',dollars=false,docs=0,depth=0,bracket=false;
 let commandStart=true;
 // T3's exact init forms are the only command substitutions we certify.
 // Match only at an executable statement boundary, never inside quoted data.
 const init=/^eval[ \t]+"?\$\((?:ssh-agent(?:\s+[^;&|`$()]*)?|brew\s+shellenv|(?:pyenv|rbenv|nodenv)\s+init|direnv\s+export|starship\s+init|zoxide\s+init|fnm\s+env|(?:mise|rtx)\s+activate|conda\s+shell\.bash\s+hook|opam\s+env|keychain)(?:\s+[^;&|`$()]*)?\)"?(?=$|[ \t]*(?:[;\n]|&&|\|\|))/i;
 for(let at=0;at<text.length;at++){
  const c=text[at]!;
  if(c==='\\'&&quote!=="'")return false; // D3-NO-BACKSLASH
  if(c===quote){quote='';continue;}
  if(!quote&&(c==="'"||c==='"')){quote=c;continue;}
  if(quote==="'")continue;
  if(!quote&&(at===0||/[;&|()\n]/.test(text[at-1]!))){
   let start=at;while(/[ \t]/.test(text[start]??'')&&start<text.length)start++;
   const match=init.exec(text.slice(start));
   if(match){
    // An exception cannot smuggle escapes or other expansion forms.
    if(/[\\*?\[\]{}~#\r\n]/.test(match[0]))return false;
    at=start+match[0].length-1;continue;
   }
  }
  if(c==='`')return false;
  if(c==='$')dollars=true;
  if(!quote){
   if(c==='['&&commandStart&&/\s/.test(text[at+1]??'')){bracket=true;commandStart=false;continue;}
   if(c===']'&&bracket&&/\s/.test(text[at-1]??'')&&/^(?:\s|[;|&]|$)/.test(text.slice(at+1))){bracket=false;continue;}
   if(c==='~'&&!( (at===0||/[\s;&|()<>]/.test(text[at-1]!))&&/^(?:\/|[\s;&|()<>]|$)/.test(text.slice(at+1)) ))return false; // A1: only an unquoted word-leading ~ or ~/.
   if(/[*?\[\]{}]/.test(c))return false; // D3-NO-GLOB
   if(c==='(')depth++;
   if(c===')')depth--;
   if(/[;|&\n(]/.test(c))commandStart=true;
   else if(!/\s/.test(c))commandStart=false;
  }
  if(!quote&&c==='#'&&(at===0||/[\s;&|()]/.test(text[at-1]!))){
   if(depth!==0||at>0&&!/\s/.test(text[at-1]!))return false;
   while(at<text.length&&text[at]!=='\n')at++;
   commandStart=true;continue;
  }
  if(!quote&&text.startsWith('<<<',at)){at+=2;continue;}
  if(!quote&&c==='<'&&text[at+1]==='<'){
   if(++docs>1)return false;
   const doc=/^<<[ \t]*(['"])([^'"\r\n]+)\1(?=$|[\s;&|<>])/.exec(text.slice(at));
   if(!doc)return false;
   const headerEnd=text.indexOf('\n',at+doc[0].length);if(headerEnd<0)return false;
   // A second redirect on the header requires a multi-heredoc parser.
   if(text.slice(at+doc[0].length,headerEnd).includes('<<'))return false;
   // Check the rest of the header with this same gate, then skip literal data.
   if(!simpleCertificationSubset(text.slice(at+doc[0].length,headerEnd),false))return false;
   const label=doc[2]!;let line=headerEnd+1,end=-1;
   while(line<=text.length){
    const next=text.indexOf('\n',line),stop=next<0?text.length:next;
    if(text.slice(line,stop)===label){end=stop;break;}
    line=stop+1;
   }
   if(end<0)return false;
   // Literal heredoc data has no shell quoting: escapes cannot be certified.
   if(text.slice(headerEnd+1,end).includes('\\'))return false;
   at=end;continue;
  }
 }
 if(quote||bracket||depth!==0)return false;
 if(dollars){
  if(!bindings)return false;
  const bound=boundCmdInvocations(boundInvocations(text));
  return bound!==text&&simpleCertificationSubset(bound,false); // D3-T4-LOCAL
 }
 return true;
}
/** Binding evidence comes only from executable bytes; offsets remain stable. */
function executableBindingText(text:string):{source:string;mask:string} {
 // Binding extraction does not implement nested substitution scopes. Keep
 // every byte and decline all binding certificates for that syntax.
 if(/\$\(|`/.test(text))return {source:text,mask:' '.repeat(text.length)};
 let source='',mask='',quote='';
 const cmdComments=new Set([...text.matchAll(/^[ \t]*(?:rem\b|::)/gim)].map(match=>match.index));
 for(let i=0;i<text.length;i++){
  const c=text[i]!;
  if(!quote&&(c==='#'&&commentBoundary(text,i)||text.startsWith('<#',i)||cmdComments.has(i))){
   const block=text.startsWith('<#',i);let end=block?text.indexOf('#>',i+2):text.indexOf('\n',i);
   end=end<0?text.length:block?end+2:end;
   const raw=text.slice(i,end),blank=raw.replace(/[^\n]/g,' ');
   // Only a POSIX token-boundary # can remove source for a RUN proof.
   // Other dialect comment forms merely prevent fabricated T4 bindings.
   source+=c==='#'?blank:raw;mask+=blank;i=end-1;continue;
  }
  source+=c;
  if((c==='\\'||c==='`')&&quote!=="'"){
   mask+=' ';if(i+1<text.length){source+=text[++i];mask+=' ';}continue;
  }
  if(quote){mask+=' ';if(c===quote)quote='';continue;}
  if(c==='"'||c==="'"){quote=c;mask+=' ';continue;}
  mask+=c;
 }
 return {source,mask};
}
/** MAIN T4: local literal assignments authenticate variable invocation only
 * within this command text. No environment or previous-turn bindings count. */
function boundInvocations(text:string):string {
 const bound=new Map<string,string>();
 const executable=executableBindingText(text);
 return executable.source.replace(/(^|[;\n])\s*\$([A-Za-z_]\w*)\s*=\s*([^;\n]+)|(?:&\s*|\b(?:iex|invoke-expression)\s+)\$([A-Za-z_]\w*)\b/gi,(raw,prefix,key,value,invoked,offset:number)=>{
  const start=offset+(prefix?.length??0)+(raw.slice(prefix?.length??0).match(/^\s*/)?.[0].length??0);
  if(executable.mask[start]!==raw[start-offset])return raw; // H2-EXECUTABLE-BINDING
  if(key){
   const literal=literalShellWord(value.trim())??(/^[A-Za-z][A-Za-z0-9_-]*(?:[ \t]+[^$`;&|]+)?$/.test(value.trim())?value.trim():undefined);
   if(literal!==undefined&&!rawDeletePrimitive(literal)&&!rawDynamicExecution(literal)){bound.set(key.toLowerCase(),literal);return (prefix??'')+' true';}
   bound.delete(key.toLowerCase());return raw;
  }
  return bound.get(invoked.toLowerCase())??raw;
 });
}
/** MAIN T4: cmd SET bindings belong to this text, never the process env. */
function boundCmdInvocations(text:string):string {
 const bound=new Map<string,string>();
 const executable=executableBindingText(text);
 return executable.source.replace(/(^|[;&\n])\s*set\s+(?:"([A-Za-z_]\w*)=([^"\r\n]*)"|([A-Za-z_]\w*)=([^;&\r\n]*))|%([A-Za-z_]\w*)%/gi,(raw,prefix,quotedKey,quotedValue,key,value,invoked,offset:number)=>{
  const start=offset+(prefix?.length??0)+(raw.slice(prefix?.length??0).match(/^\s*/)?.[0].length??0);
  if(executable.mask[start]!==raw[start-offset])return raw;
  const name=quotedKey??key;
  if(name){
   const command=(quotedValue??value).trim();
   if(command&&!/[%$`]/.test(command)&&!rawWipeEvidence(command)){bound.set(name.toLowerCase(),command);return (prefix??'')+' true';}
   bound.delete(name.toLowerCase());return raw;
  }
  return bound.get(invoked.toLowerCase())??raw;
 });
}
/** Find a substitution terminator only after parsing its own comments and
 * quotes. Nested substitutions have independent quote state. Unsupported shell
 * case syntax has ambiguous closing parentheses and receives no certificate. */
function substitutionEnd(source:string,start:number,close=')',depth=0):number|undefined {
 if(depth>64)return undefined;
 let quote='';
 for(let at=start;at<source.length;at++){
  const c=source[at]!;
  if(c==='\\'&&quote!=="'"){if(++at>=source.length)return undefined;continue;}
  if(quote==="'"){if(c===quote)quote='';continue;}
  if(c==='"'){quote=quote?'':'"';continue;}
  if(!quote&&c==="'"){quote=c;continue;}
  if(!quote&&c==='#'&&(at===start||commentBoundary(source,at))){while(at<source.length&&source[at]!=='\n')at++;continue;}
  if(c==='$'&&source[at+1]==='('){const end=substitutionEnd(source,at+2,')',depth+1);if(end===undefined)return undefined;at=end;continue;}
  if(c==='`'&&close!=='`'){const end=substitutionEnd(source,at+1,'`',depth+1);if(end===undefined)return undefined;at=end;continue;}
  if(quote)continue;
  if(c===close)return at;
  if(c==='('){const end=substitutionEnd(source,at+1,')',depth+1);if(end===undefined)return undefined;at=end;continue;}
  if((at===start||commentBoundary(source,at))&&/^(?:case|esac)(?=$|[\s;()])/.test(source.slice(at)))return undefined;
 }
 return undefined;
}
/** Heredoc expansion executes substitutions even inside quote characters in
 * its body. Only a backslash suppresses the outer substitution opener. */
function expandingHeredocWipe(source:string):boolean {
 for(let at=0;at<source.length;at++){
  if(source[at]==='\\'){at++;continue;}
  const backtick=source[at]==='`',dollar=source[at]==='$'&&source[at+1]==='(';
  if(!backtick&&!dollar)continue;
  const start=at+(backtick?1:2),end=substitutionEnd(source,start,backtick?'`':')');
  if(end===undefined||rawWipeEvidence(source.slice(start,end)))return true;
  at=end;
 }
 return false;
}
/** MAIN T1-T2: delimiters are syntax; only executable literal bodies receive
 * the dynamic-execution scan. The caller still scans all raw delete bytes. */
function heredocExecution(text:string,doubt:ParseDoubt):{text:string;hit:boolean} {
 let hit=false,quote='';
 const lines=text.split('\n');
 for(let at=0;at<lines.length;at++){
  const header=lines[at]!;
  const candidates=new Map([...header.matchAll(/(?<!<)<<(-?)(?!<)\s*('([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/g)].map(doc=>[doc.index,doc]));
  const docs:Array<RegExpMatchArray&{receiverStart?:number}>=[];let boundary=0;
  for(let offset=0;offset<header.length;offset++){
   const char=header[offset]!;
   if(char==='\\'&&quote!=="'"){offset++;continue;}
   if(char===quote){quote='';continue;}
   if(!quote&&(char==='"'||char==="'")){quote=char;continue;}
   if(quote)continue;
   if(char==='#'&&commentBoundary(header,offset))break;
   if(';|&('.includes(char))boundary=offset+1;
   const doc=candidates.get(offset);
   if(doc){
    const after=header[offset+doc[0].length];
    if(after&&!/[\s;&|()<>]/.test(after)){doubt.value=true;continue;}
    docs.push(Object.assign(doc,{receiverStart:boundary}));
   }
  }
  if(docs.length>1)doubt.value=true;
  for(const doc of docs){
   const label=doc[3]??doc[4]??doc[5]!,body:string[]=[];let end=at+1;
   while(end<lines.length&&(doc[1]?lines[end]!.replace(/^\t+/,''):lines[end])!==label)body.push(lines[end++]!);
   if(end>=lines.length)doubt.value=true;
   const receiver=header.slice(doc.receiverStart??0,doc.index).trim().split(/[ \t]+/).map(stageBasename);
   const first=receiver.find(name=>!name.includes('=')&&!['!','if','then','do','{'].includes(name))??'';
   const executable=stageExecutor(first)&&!OUTPUT_READERS.has(first);
   const database=DATABASE_EXECUTORS.has(first);
   const source=body.join('\n');
   const marker='\0heredoc-input\0';
   const supplied=doc[3]||doc[4]?source:undefined;
   const inputHeader=header.slice(0,doc.index)+' < '+marker+' '+header.slice(doc.index!+doc[0].length);
   if(shellExecution(boundCmdInvocations(boundInvocations(inputHeader)),file=>file===marker?supplied:undefined,'certify',doubt))hit=true;
   if(!doc[3]&&!doc[4]&&expandingHeredocWipe(source))hit=true; // H3-HEREDOC-EXPANSION
   if(database&&(databaseWords(source)||!doc[3]&&!doc[4]||end>=lines.length))hit=true;
   if(executable&&(!doc[3]&&!doc[4]&&/[$`]/.test(source)||end>=lines.length||rawDynamicExecution(source)||rawDeletePrimitive(source)))hit=true;
   for(let line=at+1;line<=end&&line<lines.length;line++)lines[line]='';
  }
  if(docs.length){let cleaned=header;for(const doc of docs.toReversed())cleaned=cleaned.slice(0,doc.index)+cleaned.slice(doc.index!+doc[0].length);lines[at]=cleaned;}
 }
 return {text:lines.join('\n'),hit};
}
let executionDepth=0,executionWork=0;
export function rawDynamicExecution(text:string,readInput?:DatabaseInputReader):boolean {
 if(executionDepth===0)executionWork=0;
 executionWork+=text.length;
 if(text.length>65536||executionDepth>=64||executionWork>1048576)return true; // H4-SIZE-CUTOFF
 executionDepth++;
 try{return dynamicExecution(text,readInput);}catch{return true;}finally{executionDepth--;}
}
/** The execution evidence pass always receives every original byte. Parsed
 * regions and the normalized copy are additional evidence, never replacements.
 * RUN certifications below are a separate decision and cannot run on doubt. */
export function fullExecutionScan(text:string,readInput?:DatabaseInputReader):boolean {
 const normalized=normalizedWipeText(text.replace(/\n/g,';'));
 const raw=shellExecution(text,readInput,'scan');
 const added=shellExecution(normalized,readInput,'scan');
 const opaque=/(?:^|[\s;&|()])(?:eval|iex|invoke-expression)\s+[^;\n|]*[$`%]|(?:^|[\s;&|()])source\s+/i.test(text);
 return rawPipedProgram(text)||rawPipedProgram(normalized)||raw||added||opaque;
}
function dynamicExecution(text:string,readInput?:DatabaseInputReader):boolean {
 const finding=fullExecutionScan(text,readInput); // D1-FULL-RAW
 const subset=simpleCertificationSubset(text); // D3-WHOLE-COMMAND
 const doubt:ParseDoubt={value:false};
 const here=heredocExecution(text,doubt);
 shellExecution(here.text,readInput,'validate',doubt);
 const source=subset?boundCmdInvocations(boundInvocations(here.text)):here.text;
 const stages=source.replace(/<<<\s*(?:'[^']*'|"[^"$`]*"|[^\s;&|]+)/g,'');
 const parsed=shellExecution(source,readInput,'certify',doubt);
 // The stage rule still applies to every executable region. Literal heredoc
 // and here-string data can be certified only after a complete parse.
 const certifiedHit=here.hit||rawPipedProgram(normalizedWipeText(stages.replace(/\n/g,';')))||parsed;
 // Outside D3 the raw finding is irrevocable. Parsing may still add a
 // finding (for example a leading redirected literal SQL wipe).
 return !subset||doubt.value?finding||certifiedHit:certifiedHit;
}
/** The only syntax eligible for certification is the complete raw command.
 * The caller still checks home, protected paths and filesystem resolution. */
export function certifiableDelete(text:string):{path:string;windows:boolean}|undefined {
 if(rawDynamicExecution(text))return undefined;
 const rm=/^\s*rm\s+-(r|R|f|rf|fr|Rf|fR)\s+([A-Za-z0-9._/-]+)\s*$/.exec(text);
 const ps=/^\s*Remove-Item\s+(-Recurse\s+-Force|-Force\s+-Recurse|-Recurse)\s+([A-Za-z0-9._:\\/-]+)\s*$/.exec(text);
 const path=(rm??ps)?.[2];
 if(!path||path.includes('..')||path.startsWith('-'))return undefined;
 if(ps&&path.includes(':')&&!/^[A-Za-z]:[\\/][^:]*$/.test(path))return undefined;
 return {path,windows:!!ps};
}
/** Native source is not a shell command: quoted values and call parentheses
 * cannot become disguised shell command names. Raw delete bytes still win. */
function nativeDynamicExecution(text:string):boolean {
 const literals:string[]=[];
 const code=text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,raw=>{
  if(raw.startsWith('#')||raw.startsWith('//')||raw.startsWith('/*'))return ' ';
  const index=literals.push(raw.slice(raw.startsWith('"""')||raw.startsWith("'''")?3:1,raw.startsWith('"""')||raw.startsWith("'''")?-3:-1))-1;
  return '__literal'+index+'__';
 });
 for(const match of code.matchAll(/\b(?:(?:db|database|conn|connection|cursor|knex|sequelize|sqlite|client)\s*\.\s*(?:query|execute|executescript|executemany|exec|run|raw|unsafe|sql|remove|drop)|[A-Za-z_$][\w$]*\s*\.\s*(?:query|execute|executescript|executemany|raw|unsafe|sql))\s*\(\s*([^)]*)/gi)){
  const literal=/^__literal(\d+)__\s*(?:,|$)/.exec(match[1]!);
  if(!literal||databaseWords(literals[Number(literal[1])]??''))return true;
 }
 for(const match of code.matchAll(/\b(?:eval|exec|compile|os\.system|execSync|spawnSync|popen)\s*\(\s*([^)]*)/g)){
  const literal=/^__literal(\d+)__\s*(?:,|$)/.exec(match[1]!);
  if(!literal)return true;
  if(rawDynamicExecution(literals[Number(literal[1])]??''))return true;
 }
 return false;
}
export function rawWipeEvidence(text:string,lang?:'py'|'js',readInput?:DatabaseInputReader):boolean {
 return rawDeletePrimitive(text)||rawDeletePrimitive(normalizedWipeText(text))||(lang?nativeDynamicExecution(text):rawDynamicExecution(text,readInput)); // N1-NORMALIZED
}
