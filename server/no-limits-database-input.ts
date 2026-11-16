// SPDX-License-Identifier: AGPL-3.0-or-later
import {constants,openSync,closeSync,fstatSync,readSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute,dirname,basename,relative,sep} from 'node:path';
import {forEachOwnerSegment,type OwnerSegmentContext} from './no-limits-shell.ts';
import {literalDatabaseOutput,simpleCertificationSubset,readOnlyCertificationStage,type DatabaseInputReader} from '../shared/no-limits-raw-wipe.ts';
import {forEachSegment, type SegWord} from './shell/segments.ts';
import {commandRoles} from './shell/roles.ts';
import {lexCode, type CodeToken} from './code-lexer.ts';
import {sqlWipe as readSqlWipe, rawDatabaseWipe} from './no-limits-wipe-sql.ts';
const sqlWipe=(text:string)=>readSqlWipe(text,true);
const MONGO_DELETE=/^(?:deleteMany|deleteOne|remove|findOneAndDelete|bulkWrite)$/i;

const CLIENT=/^(?:psql|sqlite3?|mysql|mariadb|sqlcmd|redis-cli|mongo|mongosh|cqlsh|cockroach|duckdb|clickhouse-client)$/;
const plain=(word:SegWord|undefined):word is SegWord & {text:string}=>word?.origin==='plain'&&word.text!==undefined;
const stdinFile=(name:string)=>name==='-'||/^\/(?:dev\/stdin|dev\/fd\/0|proc\/(?:self|thread-self)\/fd\/0)$/.test(name);
/** Only authenticated current-turn files may supply literal database input.
 * Bound both allocation and reads; unknown files are never opened. */
export function currentDatabaseInputs(cwd:string|undefined,files:ReadonlySet<string>|undefined,command?:string,home=homedir()):DatabaseInputReader {
 const cache=new Map<string,string|undefined>();
 const plans=new Map<string,InputPlan|undefined>();
 return (file,context)=>{
  if(command!==undefined&&!simpleCertificationSubset(command))return undefined;
  let path:string;
  if(context){
   if(command!==undefined&&context.source!==command)return undefined;
   if(!plans.has(context.source))plans.set(context.source,databaseInputPlan(context.source,cwd,home));
   const plan=plans.get(context.source);
   // Derived bodies cannot inherit a trustworthy cwd or write history by
   // starting again at the request cwd. Require their complete command.
   path=plan?.path(file,context.offset)??'';if(!path)return undefined;
  }else{
   if(command!==undefined)return undefined;
   if(!cwd&&!file.startsWith('/'))return undefined;
   try{path=physicalInputPath(isAbsolute(file)?file:`${cwd??'/'}/${file}`);}catch{return undefined;}
  }if(!files?.has(path))return undefined;
  if(cache.has(path))return cache.get(path);
  let fd:number|undefined,value:string|undefined;
  try{
   fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
   const stat=fstatSync(fd);if(!stat.isFile()||stat.size>65536)return undefined;
   const bytes=Buffer.alloc(65537);let used=0;
   for(;;){const count=readSync(fd,bytes,used,bytes.length-used,null);used+=count;if(!count||used===bytes.length)break;}
   if(used<=65536)value=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used));
  }catch{/* Unknown input fails closed at the client. */}
  finally{if(fd!==undefined)closeSync(fd);cache.set(path,value);}
  return value;
 };
}
/** Resolve each component before its following parent component. Concatenation
 * above intentionally preserves .. until symlinks have been traversed. */
function physicalInputPath(path:string):string {
 let current='/';
 for(const part of path.split('/')){
  if(!part||part==='.')continue;
  current=realpathSync.native(current+(current.endsWith('/')?'':'/')+part);
 }
 return current;
}
interface InputPlan {path:(file:string,offset:number)=>string|undefined}
/** Cwd and invalidation are certification evidence only. The raw execution
 * scan is independent. All candidates must identify the same effective path. */
function databaseInputPlan(source:string,cwd?:string,home=homedir()):InputPlan|undefined {
 if(!simpleCertificationSubset(source)||/\bCDPATH\s*=/.test(source))return undefined;
 const rows:OwnerSegmentContext[]=[];
 try{forEachOwnerSegment(source,cwd,row=>{if(rows.length>=512)throw Error('database certification budget');rows.push(row);},'posix',realpathSync.native,0,{home});}catch{return undefined;}
 // Nested source offsets belong to a different program. Without a common
 // ordering proof, no file input in that command can be certified.
 if(rows.some(row=>row.segment.via))return undefined;
 const starts=(row:OwnerSegmentContext)=>Math.min(...[
  ...row.segment.words.map(word=>word.start),...row.segment.assignments.map(word=>word.start),
  ...row.segment.redirects.flatMap(redirect=>redirect.target?[redirect.target.start]:[]),
 ]);
 const locate=(row:OwnerSegmentContext,file:string,writing=false):string|undefined=>{
  if(row.roles.cwd&&!['cd','pushd'].includes(row.roles.program))return undefined;
  if(row.candidates.some(candidate=>candidate.unknownCause))return undefined;
  const operands=[...row.segment.words,...row.segment.redirects.flatMap(r=>r.target?[r.target]:[])].filter(word=>word.text===file||word.raw===file);
  const tilde=new Set(operands.map(word=>word.raw.startsWith('~')));
  if(tilde.size>1)return undefined; // Quoted and expanded spellings are distinct paths.
  if(tilde.has(true))file=file.replace(/^~(?=\/|$)/,home);
  const paths=new Set(row.cwds.map(base=>{
   if(!base&&!isAbsolute(file))return undefined;
   const path=isAbsolute(file)?file:`${base??'/'}/${file}`;
   try{return physicalInputPath(path);}catch{
    if(writing)try{return join(physicalInputPath(dirname(path)),basename(path));}catch{/* unresolved write */}
    return undefined;
   }
  }));
  return paths.size===1&&!paths.has(undefined)?[...paths][0]:undefined;
 };
 const affected=(written:string,target:string)=>{
  const tail=relative(written,target);return tail===''||tail!=='..'&&!tail.startsWith('..'+sep)&&!tail.startsWith(sep);
 };
 return {path(file,offset){
  const row=rows.find(row=>{
   const points=[...row.segment.words,...row.segment.assignments,...row.segment.redirects.flatMap(redirect=>redirect.target?[redirect.target]:[])];
   return points.some(word=>word.start<=offset&&offset<word.end);
  });
  if(!row)return undefined;
  const target=locate(row,file);if(!target)return undefined; // D2-EFFECTIVE-CWD
  const aliases=(path:string)=>{try{return [path,realpathSync.native(path)];}catch{return [path];}};
  const targetAliases=aliases(target);
  const sameFile=(path:string)=>{try{const a=statSync(path),b=statSync(target);return a.dev===b.dev&&a.ino===b.ino;}catch{return false;}};
  for(const earlier of rows){

   const {segment,roles}=earlier;
   if(!segment.words.length&&!segment.assignments.length&&!segment.redirects.length)continue;
   const writes:Array<string|undefined>=segment.redirects.filter(redirect=>redirect.write).map(redirect=>plain(redirect.target)?redirect.target.text:undefined);
   const writeCapable=roles.slots.some(slot=>slot.role==='write')||/^(?:tee|cp|mv|ln|rm|rmdir|unlink|shred|install|touch|truncate)$/.test(roles.program);
   if(writeCapable){
    // Every named path of a write-capable command invalidates certification,
    // including copy/move sources and attached destination options.
    writes.push(...roles.slots.filter(slot=>!['name','command','flag'].includes(slot.role)).map(slot=>slot.value));
    if(segment.words.some(word=>!plain(word)))return undefined;
   }
   // Arbitrary programs, interpreters, database clients, and stream editors
   // may write files without a shell output redirect. Only a known read-only
   // operation or explicit path-write inventory can preserve a certificate.
   // D3: a fixed inventory applies to the entire pipeline/list, including
   // later commands. A client is permitted only for the input being checked.
   const downstream=rows[rows.indexOf(row)+1];
   const consumer=earlier===downstream&&row.roles.program==='cat'&&['|','|&'].includes(row.segment.sep)&&CLIENT.test(roles.program)&&!segment.redirects.some(redirect=>redirect.write);
   if(earlier!==row&&!consumer&&!readOnlyCertificationStage(roles.program,segment.words.map(word=>word.text??word.raw)))return undefined; // D3-READONLY-LIST
   if(starts(earlier)>starts(row))continue;
   for(const written of writes){
    if(written===undefined)return undefined;
    const path=locate(earlier,written,true);if(!path||aliases(path).some(alias=>targetAliases.some(target=>affected(alias,target)))||sameFile(path))return undefined; // D2-PRIOR-WRITE
   }
  }
  return target;
 }};
}
/** Unknown is a possible wipe. There is deliberately no escape/RESP decoder. */
const possibleWipe=(value:string|undefined,read:(text:string)=>boolean)=>value===undefined||read(value);

/** Read only literal JSON-like values. Token text and offsets refer to the raw
 * program; decoded token values never decide whether input can run. */
function literalObject(tokens:CodeToken[],start:number):number|undefined {
 let at=start,values=0;
 const value=():boolean=>{
  const token=tokens[at];if(!token)return false;
  if(++values>64)return false;
  if(token.text==='{'){return object();}
  if(token.text==='['){at++;if(tokens[at]?.text===']'){at++;return true;}do{if(!value())return false;if(tokens[at]?.text===']'){at++;return true;}}while(tokens[at++]?.text===',');return false;}
  if(token.kind==='string'&&!token.template&&!token.text.includes('\\')&&!token.text.startsWith('`')||token.kind==='number'||/^(?:true|false|null)$/.test(token.text)){at++;return true;}
  if(token.text==='-'&&tokens[at+1]?.kind==='number'){at+=2;return true;}
  return false;
 };
 const object=():boolean=>{
  if(tokens[at++]?.text!=='{')return false;
  if(tokens[at]?.text==='}'){at++;return true;}
  do{
   const key=tokens[at++];
   if(key&&/^(?:__proto__|'__proto__'|"__proto__")$/.test(key.text))return false;
   if(!key||!(key.kind==='name'||key.kind==='string'&&!key.template&&!key.text.includes('\\')&&!key.text.startsWith('`'))||tokens[at++]?.text!==':'||!value())return false;
   if(tokens[at]?.text==='}'){at++;return true;}
  }while(tokens[at++]?.text===',');
  return false;
 };
 return tokens[start]?.text==='{'&&tokens[start+1]?.text!=='}'&&object()?at:undefined;
}

export function mongoWipe(text:string):boolean {
 if(rawDatabaseWipe(text)||text.includes('?.')||text.includes('\\'))return true;
 if(nativeDatabaseWipe(text,'js'))return true;
 const {tokens:all,unreadable}=lexCode('node',text);
 if(unreadable)return true;
 const tokens=all.filter(t=>t.kind!=='newline');
 for(let i=0;i<tokens.length;i++){
  const t=tokens[i]!;
  if(t.kind==='name'&&MONGO_DELETE.test(t.text)&&tokens[i+1]?.text==='('){
   const end=literalObject(tokens,i+2);
   if(end===undefined||![',',')'].includes(tokens[end]?.text??''))return true;
  }
  if(t.kind==='name'&&/^(?:load|eval|Function|runCommand|adminCommand|aggregate|mapReduce)$/i.test(t.text)&&tokens[i+1]?.text==='(')return true;
  if(t.kind==='name'&&tokens[i+1]?.text==='('&&tokens[i-1]?.text==='.'&&!MONGO_DELETE.test(t.text)){
   let from=i-2;while(from>=2&&tokens[from-1]?.text==='.')from-=2;
   if(/^(?:db|database|client)$/i.test(tokens[from]?.text??'')){
    const arg=tokens[i+2];
    if(arg?.kind!=='string'||arg.template||![',',')'].includes(tokens[i+3]?.text??''))return true;
   }
  }
  if(t.template)return true;
  // Computed invocation cannot establish which database method will execute.
  if(t.text===']'&&tokens[i+1]?.text==='(')return true;
  if(t.kind==='name'&&/^(?:db|database|client)$/i.test(t.text)&&tokens[i+1]?.text==='[')return true;
 }
 return false;
}

const DB_HANDLE=/^(?:db|database|conn|connection|cursor|knex|sequelize|sqlite|client)$/i;
// Method discovery is independent of invocation punctuation or receiver. A
// reference/alias is unresolved unless this program proves a literal argument.
const DATABASE_METHOD=/^(?:query|execute|executemany|executescript|exec|run|raw|unsafe|sql|deleteMany|deleteOne|remove|drop|dropCollection|dropDatabase|bulkWrite|findOneAndDelete|eval)$/i;
const DATABASE_MENTION=/\b(?:query|execute|executemany|executescript|exec|run|raw|unsafe|sql|deleteMany|deleteOne|remove|drop|dropCollection|dropDatabase|bulkWrite|findOneAndDelete|eval)\b/i;
/** Only an original, unescaped literal string resolves a database argument.
 * Each program body is raw-scanned once, before extracting any arguments. */
export function nativeDatabaseWipe(text:string,lang:'py'|'js'):boolean {
 const pending=[text];
 for(let at=0;at<pending.length;at++){
  const body=pending[at]!;
  const {tokens:all}=lexCode(lang==='py'?'python':'node',body);
  const tokens=all.filter(t=>t.kind!=='newline');
  // SQL words in ordinary literal data cannot establish database execution.
  const mentioned=tokens.some((token,i)=>token.kind==='name'&&(DB_HANDLE.test(token.text)||DATABASE_MENTION.test(token.text))||token.kind==='string'&&tokens[i-1]?.text==='['&&DATABASE_MENTION.test(token.text));
  if(mentioned)for(let i=1;i<tokens.length;i++){
   if(tokens[i]?.text!=='('||!(/^[\w$]+$/.test(tokens[i-1]?.text??'')||[']',')'].includes(tokens[i-1]?.text??'')))continue;
   let at=i+1;
   while(tokens[at]&&tokens[at]?.text!==')'){
    const arg=tokens[at]!;
    if(arg.kind==='string'&&!arg.template&&!arg.text.includes('\\')||arg.kind==='number'||/^(?:true|false|null|None|True|False)$/.test(arg.text))at++;
    else if(arg.text==='{'){const end=literalObject(tokens,at);if(end===undefined)return true;at=end;}
    else return true;
    if(tokens[at]?.text===',')at++;
    else if(tokens[at]?.text!==')')return true;
   }
  }
  let found=false,handleChain=false;
  for(let i=0;i<tokens.length;i++){
   const token=tokens[i]!;
   if(token.kind==='name'&&tokens[i-1]?.text!=='.')handleChain=DB_HANDLE.test(token.text);
   if(mentioned&&(token.text==='?.'||token.text==='\\'))return true;
   if(mentioned&&found&&token.text===']'&&tokens[i+1]?.text==='(')return true;
   if(token.kind==='name'&&DB_HANDLE.test(token.text)&&tokens[i+1]?.text==='[')return true;
   if(found&&token.kind==='name'&&token.text==='Function'&&tokens[i+1]?.text==='(')return true;
   const handle=tokens[i-1]?.text==='.'&&handleChain;
   const method=token.kind==='name'&&DATABASE_METHOD.test(token.text)&&(handle||/^(?:query|execute|executemany|executescript|raw|unsafe|sql|deleteMany|deleteOne|dropCollection|dropDatabase|bulkWrite|findOneAndDelete)$/i.test(token.text));
   if(!method&&!(token.kind==='name'&&handle&&tokens[i+1]?.text==='('))continue;
   found=true;
   // Grouped calls are recognized; a property reference or alias has no
   // provable literal argument and therefore cards without following aliases.
   let call=i+1;while(tokens[call]?.text===')')call++;
   if(tokens[call]?.text!=='(')return true;
   const argument=tokens[call+1],end=tokens[call+2];
   const literal=argument?.kind==='string'&&!argument.template&&!argument.text.includes('\\')&&[',',')'].includes(end?.text??'')
    ? /^(?:[rRuU])?("""|'''|["'`])([\s\S]*)\1$/.exec(argument.text)?.[2]:undefined;
   if(possibleWipe(literal,sqlWipe))return true;
  }
  for(const token of tokens)if(token.template)pending.push(...token.template.expressions);
 }
 return false;
}

/** Parse client action slots, not arbitrary argv data. Any unsupported action
 * or input source stays unknown and cards rather than guessing its output. */
function clientWipe(program:string,args:string[],input:string|undefined,readInput?:DatabaseInputReader,hasInput=false):boolean {
 // MAIN RULING H1: options never exempt a supplied database stdin stream.
 if(hasInput&&possibleWipe(input,rawDatabaseWipe))return true;
 if(args.length===1&&['--help','--version','-?'].includes(args[0]!))return false;
 const read=program==='redis-cli'?(s:string)=>rawDatabaseWipe(s)||s.split(/\r?\n/).some(line=>!/^\s*(?:(?:PING|GET|MGET|SET|MSET|INCR|DECR|EXISTS|TTL|PTTL|INFO|DBSIZE|SCAN|KEYS)\b|$)/i.test(line)):/^(?:mongo|mongosh)$/.test(program)?mongoWipe:sqlWipe;
 let explicit=false,stdin=false;
 const positional:string[]=[];
 const file=(name:string)=>{explicit=true;if(stdinFile(name))stdin=true;else return possibleWipe(readInput?.(name),read);return false;};
 const query=(text:string)=>{
  // Includes and client substitutions are additional executable input. They
  // are intentionally not decoded, even when the marker looks like stdin.
  if(text.includes('\\')||/(?:^|[;\n])\s*(?:source\b|\.read\b)|\$\(|`|:[A-Za-z_]\w*/i.test(text))return true;
  return read(text);
 };
 if(program==='redis-cli'){
  if(args.some(arg=>/^--(?:pipe|eval|cluster)(?:=|$)/.test(arg)))return true;
  for(let i=0;i<args.length;i++){
   const arg=args[i]!;
   if(['-h','-p','-a','-u','-n','-s','--user','--pass','--cacert','--cert','--key','--sni','-r','-i','-d','-D'].includes(arg)){i++;continue;}
   if(arg.startsWith('-')){if(!['-x','-2','-3','--tls','--raw','--no-raw','--csv','--json'].includes(arg))return true;continue;}
   return rawDatabaseWipe(args.slice(i).join(' '))||args.includes('-x')&&possibleWipe(input,rawDatabaseWipe)||/^(?:EVAL|EVALSHA|FCALL|FCALL_RO|SCRIPT|FUNCTION|MIGRATE|RESTORE)$/i.test(arg);
  }
  return possibleWipe(input,read);
 }
 for(let i=0;i<args.length;i++){
  const arg=args[i]!;
  if(arg==='--shell'){stdin=true;continue;}
  if(program==='psql'&&arg.startsWith('-')&&!arg.startsWith('--')){
   for(let c=1;c<arg.length;c++){
    const option=arg[c]!;
    if('cdfFhLopPRTUv'.includes(option)){
     const operand=arg.slice(c+1)||args[++i];if(operand===undefined)return true;
     if(option==='c'){explicit=true;if(query(operand))return true;}
     else if(option==='f'){if(file(operand))return true;}
     c=arg.length;
    }else if(!'aAbEeHlnqstVwxX0123456789'.includes(option))return true;
   }
   continue;
  }
  if(/^(?:mysql|mariadb)$/.test(program)&&['-f','--force'].includes(arg))continue;
  const match=/^(--command|--execute|--eval|--file|--init-command|--init-command-add|--init-file|--init|--cmd|--input-file|--query)(?:=(.*))?$|^(-[ecfQiIq])(.*)$/.exec(arg);
  if(match){
   const name=match[1]??match[3]!,operand=match[2]??(match[4]||args[++i]);if(operand===undefined)return true;
   if(/^(?:--file|--init-file|--init|--input-file|-f|-i|-I)$/.test(name)){
    // Only psql -f/--file has authenticated script-file semantics.
    if(program!=='psql'||name!=='--file')return true;
    if(file(operand))return true;
   }
   else {if(!['--init-command','--init-command-add','--cmd','-q'].includes(name))explicit=true;if(query(operand))return true;}
   continue;
  }
  if(['-h','--host','-p','--port','-P','-u','--user','--username','--password','-D','--database','--dbname','--authenticationDatabase','--authenticationMechanism','--tlsCAFile','--tlsCertificateKeyFile','--apiVersion','-S','-U','-d'].includes(arg)){if(args[++i]===undefined)return true;continue;}
  if(arg.startsWith('-')){
   if(!['-batch','--batch','-b','-q','--quiet','--no-rc','--norc','--nodb','--no-header','--tuples-only','--no-align','--csv','--tls','--ssl'].includes(arg))return true;
   continue;
  }
  positional.push(arg);
 }
 if(/^sqlite/.test(program)){
  for(const command of positional.slice(1)){explicit=true;if(query(command))return true;}
 }else if(/^(?:mongo|mongosh)$/.test(program)&&positional.some(arg=>/\.(?:js|mjs)$/.test(arg)))return true;
 return (hasInput||stdin||!explicit)&&possibleWipe(input,read);
}

export function shellDatabaseWipe(source:string,readInput?:DatabaseInputReader):boolean {
 const subset=simpleCertificationSubset(source);
 let wipe=false,sawClient=false;
 const outputs=new Map<number|string|undefined,string|undefined>();
 const piped=new Set<number|undefined>();
 try{
  const result=forEachSegment(source,row=>{
   const words=row.words.map(word=>word.text??word.raw),roles=commandRoles(words);
   const index=roles.slots.find(slot=>(slot.role==='name'||slot.role==='command')&&slot.value?.split(/[\\/]/).at(-1)===roles.program)?.arg??0;
   const args=words.slice(index+1),argWords=row.words.slice(index+1);
   const offset=row.words[0]?.start??row.redirects[0]?.target?.start??0;
   const readStage=readInput?(file:string)=>readInput(file,{source,offset}):undefined;
   const pipe=Symbol('pipe');
   const streams=new Map<number|string,string|symbol|undefined>([[0,outputs.get(row.scope)],[1,pipe]]);
   for(const redirect of row.redirects){
    const fd=redirect.fd??(redirect.op.startsWith('<')?0:1);
    if(['<&','>&'].includes(redirect.op))streams.set(fd,streams.get(Number(redirect.target?.text)));
    else if(['<','<>','<<','<<-','<<<'].includes(redirect.op)){
     const here=redirect.heredoc;
     const literal=here&&here.quoted;
     streams.set(fd,literal?here.body:redirect.op==='<<<'&&plain(redirect.target)?redirect.target.text:['<','<>'].includes(redirect.op)&&plain(redirect.target)?readStage?.(redirect.target.text):undefined);
    }else if(redirect.write)streams.set(fd,undefined);
   }
   const input=streams.get(0);
   if(CLIENT.test(roles.program)){
    sawClient=true;
    if(!subset){wipe=true;return;}
    if(argWords.some(word=>!plain(word))||clientWipe(roles.program,args,typeof input==='string'?input:undefined,readStage,piped.has(row.scope)||row.redirects.some(r=>(r.fd??0)===0&&r.op.includes('<'))))wipe=true;
   }
   let output:string|undefined;
   if((row.sep==='|'||row.sep==='|&')&&streams.get(1)===pipe&&argWords.every(plain)&&!argWords.some(word=>word.raw.includes('\\'))){
    output=literalDatabaseOutput(roles.program,args);
    if(roles.program==='cat'&&args.length===1)output=readStage?.(args[0]!);
    // Other program output remains unknown for a database.
   }
   outputs.set(row.scope,output);
   if(row.sep==='|'||row.sep==='|&')piped.add(row.scope);else piped.delete(row.scope);
  },{command:words=>commandRoles(words)});
  if(result.truncated&&sawClient)return true;
 }catch{if(sawClient||/\b(?:psql|mysql|mariadb|sqlite3|redis-cli|mongo|mongosh|cqlsh)\b/.test(source))return true;}
 return wipe;
}
