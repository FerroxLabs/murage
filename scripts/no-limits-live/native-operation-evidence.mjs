import {readFixtureLog} from './ndjson-reader.mjs';
// Native tool events are observed before the public SSE projection drops args.
// They describe only the isolated synthetic turns, never private replay rows.
import {lstatSync} from 'node:fs';
import {join,resolve,normalize} from 'node:path';
import {createHash} from 'node:crypto';
import {classifyRequest,hashInput} from './oracle-class.mjs';
export const bareTool=name=>String(name??'').replace(/^mcp__/,'').split('__').at(-1);
export const groupTool=name=>{const tool=bareTool(name).toLowerCase();return ['bash','shell','run_command','run_shell_command'].includes(tool)?'shell':['write','write_file','write_to_file','edit'].includes(tool)?'file':tool;};
export const nativeTool=e=>e.toolIdentity?.name??(e.toolKind==='execute'?'shell':e.toolKind==='edit'?'Write':e.tool??(e.toolKind&&e.toolKind!=='other'?e.toolKind:e.title));
const identity=e=>JSON.stringify([e.threadId,e.turnId,e.itemId,e.type,e.eventId]);
const publicIndexes=new WeakMap();
function publicForThreads(events,threadIds){
 let index=publicIndexes.get(events);
 if(!index||events.length<index.offset||index.offset&&events[index.offset-1]!==index.last){index={offset:0,threads:new Map()};publicIndexes.set(events,index);}
 while(index.offset<events.length){
  const event=events[index.offset++],thread=event.threadId;
  const rows=index.threads.get(thread)??[];rows.push(event);index.threads.set(thread,rows);index.last=event;
 }
 return threadIds.flatMap(id=>index.threads.get(id)??[]);
}
export function readNativeEvents(dataDir,threadIds,publicEvents=[]){
 const path=join(dataDir,'nolim-native-events.ndjson');if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('Native operation surface unavailable');
 const selected=new Set(threadIds),raw=readFixtureLog(path,[...selected]);
 // Public tool IDs and inputs are privacy projections, not execution joins.
 // Retain public turn/request surfaces, but account tools only on execution.
 const merged=new Map(publicForThreads(publicEvents,[...selected]).filter(e=>e.itemType!=='tool').map(e=>[identity(e),e]));
 // The observer also keeps each request's native identity (live-observer.mjs):
 // the public stream no longer carries requestId, so answer behavior joins here.
 const request=e=>['request.opened','request.resolved'].includes(e.type)&&typeof e.eventId==='string'&&typeof e.threadId==='string'&&typeof e.requestId==='string'&&e.requestId.length>0&&(e.turnId===undefined||typeof e.turnId==='string');
 const tool=e=>['item.started','item.completed'].includes(e.type)&&e.itemType==='tool'&&typeof e.eventId==='string'&&typeof e.threadId==='string'&&typeof e.turnId==='string'&&typeof e.itemId==='string';
 for(const e of raw){if(!tool(e)&&!request(e))throw Error('Native operation surface malformed');if(selected.has(e.threadId))merged.set(identity(e),e);}
 return [...merged.values()];
}
// Completion events may omit args. Bind them to exactly one start using the
// full native identity; if a completion carries args, those must agree too.
const operationKey=e=>JSON.stringify([e.threadId,e.turnId,e.itemId,e.provider,e.providerInstanceId,e.generation]);
function operationIndex(events){
 const starts=[],byId=new Map();
 for(const event of events){
  if(event.itemType!=='tool'||event.origin==='murage'||!['item.started','item.completed'].includes(event.type))continue;
  const key=operationKey(event),pair=byId.get(key)??{starts:[],ends:[]};
  if(event.type==='item.started'){pair.starts.push(event);starts.push(event);}else pair.ends.push(event);
  byId.set(key,pair);
 }
 const completed=new Map();
 for(const [key,pair]of byId){
  if(pair.starts.length!==1||pair.ends.length!==1)continue;
  const [start]=pair.starts,[end]=pair.ends;
  if(end.ok!==true||Object.hasOwn(end,'input')&&hashInput(end.input)!==hashInput(start.input))continue;
  completed.set(key,{...start,...end,input:start.input,tool:nativeTool(start),toolKind:start.toolKind});
 }
 return {starts,completed};
}
export function completedOperations(events){return [...operationIndex(events).completed.values()];}
const command=value=>typeof value==='string'?value.replaceAll('\r\n','\n').trim():value;
export function matchesOperation(expected,event,cwd){
 if(groupTool(expected.tool)!==groupTool(nativeTool(event)))return false;
 const actual=event.input,wanted=expected.input;
 if(!actual||!wanted||typeof actual!=='object'||typeof wanted!=='object')return hashInput(actual)===hashInput(wanted);
 if(groupTool(expected.tool)==='shell'){
  if(!Object.hasOwn(wanted,'command'))return !Object.hasOwn(actual,'command')&&Object.keys(actual).every(k=>['cwd','cwdExplicit'].includes(k));
  return Object.hasOwn(actual,'command')&&command(actual.command)===command(wanted.command)&&(!actual.cwd||!cwd||resolve(actual.cwd)===resolve(cwd));
 }
 if(groupTool(expected.tool)==='file'){
  const path=x=>x.file_path??x.path;
  // A custom MCP tool named write may accept text rather than a file path.
  // Its exact input remains binding; do not reinterpret it as native Write.
  if(path(wanted)===undefined)return hashInput(actual)===hashInput(wanted);
  if(typeof path(actual)!=='string'||typeof path(wanted)!=='string')return false;
  const canonical=p=>cwd?resolve(cwd,p):normalize(p);
  return canonical(path(actual))===canonical(path(wanted))&&actual.content===wanted.content&&(!actual.cwd||!cwd||resolve(actual.cwd)===resolve(cwd));
 }
 return hashInput(actual)===hashInput(wanted);
}
export function operationCompleted(expected,events,cwd){
 return completedOperations(events).some(e=>matchesOperation(expected,e,cwd));
}
export function availabilityEvidence(witness,events,cwd){
 if(witness?.tool!=='shell'||witness.shape!=='missing-input')return false;
 const shells=events.filter(e=>e.type==='item.started'&&e.itemType==='tool'&&groupTool(nativeTool(e))==='shell');
 return shells.length===1&&operationCompleted({tool:'shell',input:{}},events,cwd);
}
export function nativeOperationEvidence(scenario,snapshot,events){
 const errors=[],{starts,completed}=operationIndex(events);
 let count=0;const seen=new Set();
 for(const start of starts){
  if(scenario.nativeEngine&&(start.provider!==scenario.nativeEngine.driver||start.providerInstanceId!==scenario.nativeEngine.id)){errors.push('Native engine identity mismatch');continue;}
  const key=operationKey(start);if(seen.has(key)){errors.push('Duplicate native operation start');continue;}seen.add(key);
  const names=[nativeTool(start),bareTool(nativeTool(start))];
  const group=groupTool(nativeTool(start));
  if(group==='shell')names.push('Bash','shell','run_command');
  if(group==='file')names.push('Write','write_file','write_to_file','edit');
  const classes=[...new Set(names)].map(tool=>classifyRequest(scenario,{engine:start.provider,tool,inputHash:hashInput(start.input)})).filter(Boolean);
  if(!classes.length)errors.push('Native operation lacks a declared input');
  // A denied must-card operation is not execution and contributes no count.
  else if(classes.every(cls=>['deny','wipe','base'].includes(cls)))continue;
  else if(!completed.has(key))errors.push('Native operation lacks a matching successful result');
  else count++;
 }
 return {count,errors};
}

export function serviceIntentHash(value){const canonical=v=>v===undefined?'null':v===null||typeof v!=='object'?JSON.stringify(v)??'null':Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return createHash('sha256').update(canonical(value)).digest('hex');}
