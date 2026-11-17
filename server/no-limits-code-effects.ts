// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed effects from the existing inert code readers. No code is evaluated.
import type { PyReader } from './no-limits-python.ts';
import type { JsReader } from './no-limits-javascript.ts';
import { constants } from 'node:fs';
import type { NativeEffect } from './no-limits-fs.ts';
type PyNode=PyReader['tree'][number];
const unknown='\u0001';
function children(node:PyNode):PyNode[]{
 switch(node.kind){
 case 'attr':case 'formatted':case 'keyword':return [node.value];
 case 'subscript':return [node.value,node.index];
 case 'call':return [node.func,...node.args,...node.keywords.values()];
 case 'bin':return [node.left,node.right];
 case 'list':case 'unknown':case 'joined':return node.children;
 default:return [];
 }
}
export interface NativeCodeEffects {readonly effects:readonly NativeEffect[];readonly complete:boolean;readonly cwdInvalid:boolean;readonly cwdValues:readonly string[]}
const writerName=/^(?:write\w*|append\w*|truncate\w*|tofile|FileIO|unlink\w*|remove\w*|rmtree|rmSync|mkdir\w*|rename\w*|chmod\w*|chown\w*|syscall)$/;
export function pythonCodeEffects(reader:PyReader):NativeCodeEffects{
 const effects:NativeEffect[]=[],queue=[...reader.tree],seen=new Set<PyNode>();let complete=true,cwdInvalid=false;const cwdValues:string[]=[];
 const dynamic=(node:PyNode):boolean=>{
  if(node.kind==='name')return true;
  if(node.kind==='call'){const callee=reader.dotted(node.func);return !['pathlib.Path','pathlib.PurePath','pathlib.PosixPath','os.path.join','posixpath.join','os.path.expanduser','os.path.abspath','os.path.normpath','os.path.realpath','str','os.fspath'].includes(callee??'')||node.args.some(dynamic);}
  return children(node).some(dynamic);
 };
 const numeric=(node:PyNode|undefined,depth=0):boolean=>!!node&&(node.kind==='constant'&&!!node.numericOutside||node.kind==='name'&&depth===0&&reader.assignCount.get(node.name)===1&&numeric(reader.assign.get(node.name),1));
 const value=(node:PyNode|undefined,producer=false):string=>{
  if(!node||numeric(node)||producer&&dynamic(node))return unknown;
  if(node.kind==='constant'&&typeof node.value==='string')return node.value;
  const resolved=reader.arg(node);return /^\$MURAGE_U\d+$/.test(resolved)?unknown:resolved;
 };
 const pathReceiver=(node:PyNode,depth=0):boolean=>{
  if(node.kind==='call')return ['pathlib.Path','pathlib.PurePath','pathlib.PosixPath'].includes(reader.dotted(node.func)??'');
  if(node.kind==='name'&&depth===0&&reader.assignCount.get(node.name)===1){const binding=reader.assign.get(node.name);return !!binding&&pathReceiver(binding,1);}
  return false;
 };
 const add=(effect:NativeEffect)=>effects.push({...effect,operandId:`python-api:${effects.length}`});
 for(let index=0;index<queue.length;index++){
  const node=queue[index]!;if(seen.has(node))continue;seen.add(node);queue.push(...children(node));
  if(node.kind!=='call')continue;
  const name=reader.dotted(node.func),args=node.args;let known=false;
  const arg=(index:number,key:string)=>args[index]??node.keywords.get(key);
  if(name==='os.chdir'||name==='os.fchdir'){cwdInvalid=true;if(name==='os.chdir')cwdValues.push(value(args[0]??node.keywords.get('path')));else cwdValues.push(unknown);}
  if(['open','io.open','io.FileIO'].includes(name??'')&&numeric(args[0]??node.keywords.get('file')))continue;
  if(name==='os.open'){
   if(numeric(arg(1,'flags'))){complete=false;continue;}known=true;
   const flag=arg(1,'flags');const readOnly=flag&&(reader.dotted(flag)==='os.O_RDONLY'||flag.kind==='constant'&&String(flag.value)==='0');
   if(!readOnly)add({op:'write',path:value(arg(0,'path')),followFinal:true});
  }else if(name==='open'||name==='io.open'||name==='io.FileIO'){known=true;
   const mode=value(args[1]??node.keywords.get('mode'));
   if((args[1]||node.keywords.has('mode'))&&(mode===unknown||/[wax+]/.test(mode)))add({op:'write',path:value(args[0]??node.keywords.get('file')),followFinal:true});
  }else if(name&&['os.chmod','os.chown','os.lchmod','os.lchown'].includes(name)){known=true;add({op:'write',path:value(arg(0,'path')),followFinal:!name.startsWith('os.l')});}
  else if(name&&['os.mkdir','os.makedirs'].includes(name)){known=true;add({op:'create-name',path:value(arg(0,name==='os.makedirs'?'name':'path')),followFinal:false});}
  else if(name&&['os.rename','os.replace'].includes(name)){known=true;add({op:'rename',source:value(arg(0,'src'),true),path:value(arg(1,'dst'),true),followFinal:false});}
  else if(name==='os.symlink'){known=true;add({op:'link',targetValue:value(arg(0,'src'),true),path:value(arg(1,'dst'),true),linkKind:'symbolic',followFinal:false});}
  else if(name==='os.link'){known=true;add({op:'link',source:value(arg(0,'src'),true),path:value(arg(1,'dst'),true),linkKind:'hard',followFinal:false,sourceFollowFinal:true});}
  else if(node.func.kind==='attr'&&node.func.name==='tofile'){known=true;add({op:'write',path:value(arg(0,'file')),followFinal:true});}
  else if(node.func.kind==='attr'&&(name?.startsWith('pathlib.Path().')||pathReceiver(node.func.value))){
   const method=node.func.name;
   if(['write_text','write_bytes','touch','chmod'].includes(method)){known=true;add({op:'write',path:value(node.func.value),followFinal:true});}
   else if(['unlink','rmdir'].includes(method)){known=true;add({op:'delete',path:value(node.func.value),followFinal:false});}
   else if(method==='mkdir'){known=true;add({op:'create-name',path:value(node.func.value),followFinal:false});}
   else if(['rename','replace'].includes(method)){known=true;add({op:'rename',source:value(node.func.value,true),path:value(arg(0,'target'),true),followFinal:false});}
   else if(['symlink_to','hardlink_to'].includes(method)){known=true;add({op:'link',path:value(node.func.value,true),...(method==='symlink_to'?{targetValue:value(arg(0,'target'),true),linkKind:'symbolic' as const}:{source:value(arg(0,'target'),true),linkKind:'hard' as const,sourceFollowFinal:true}),followFinal:false});}
  }
  const method=name?.split('.').at(-1)??(node.func.kind==='attr'?node.func.name:node.func.kind==='name'?node.func.name:'');
  if(!known&&writerName.test(method)){
   const semantic=['os.truncate','os.remove','os.unlink','os.rmdir','os.removedirs','shutil.rmtree'].includes(name??'');
   const opened=node.func.kind==='attr'&&node.func.value.kind==='call'&&['open','io.open','io.FileIO'].includes(reader.dotted(node.func.value.func)??'');
   if(!semantic&&!opened)complete=false;
  }

 }
 return {effects,complete,cwdInvalid,cwdValues};
}
export function javascriptCodeEffects(reader:JsReader):NativeCodeEffects{
 const effects:NativeEffect[]=[],covered=new Set<number>();let complete=true,cwdInvalid=false;const cwdValues:string[]=[];
 const value=(arg:readonly [number,number]|undefined,producer=false):string=>{
  if(!arg)return unknown;
  if(producer&&reader.t.slice(arg[0],arg[1]).some(token=>token[0]!=='str'&&token[1]!=='+'))return unknown;
  if(arg[1]===arg[0]+1&&reader.t[arg[0]]?.[0]==='str')return reader.t[arg[0]]![1];
  const resolved=reader.arg([arg[0],arg[1]]);return /^\$MURAGE_U\d+$/.test(resolved)?unknown:resolved;
 };
 const number=(arg:readonly [number,number]|undefined,depth=0):number|undefined=>{
  if(!arg||arg[1]!==arg[0]+1)return;
  const token=reader.t[arg[0]]!;
  if(token[0]==='num')return Number(token[1]);
  if(depth===0&&token[0]==='id'&&reader.count.get(token[1])===1)return number(reader.assign.get(token[1]),1);
 };
 const pathValue=(arg:readonly [number,number]|undefined)=>{const fd=number(arg);return fd!==undefined&&Number.isInteger(fd)&&fd>=0?`/dev/fd/${fd}`:value(arg);};
 const add=(effect:NativeEffect)=>effects.push({...effect,operandId:`javascript-api:${effects.length}`});
 for(let index=0;index<reader.t.length;index++){
  if(reader.t[index-1]?.[1]==='.')continue;
  const [callee,at]=reader.callee(index);if(callee==='process.chdir'){cwdInvalid=true;cwdValues.push(value(reader.args(at)[0]));}if(!callee?.startsWith('fs.'))continue;
  const name=callee.slice(3),args=reader.args(at);let known=false;
  if(/^(?:writeFile|appendFile|createWriteStream)(?:Sync)?$/.test(name)||/^(?:chmod|chown|lchmod|lchown)(?:Sync)?$/.test(name)){known=true;add({op:'write',path:pathValue(args[0]),followFinal:!name.startsWith('l')});}
  else if(/^(?:open|openSync)$/.test(name)){
   known=true;const mode=value(args[1]),flags=args[1]===undefined?0:number(args[1]);const writes=flags===undefined?mode===unknown||/[wax+]/.test(mode):(flags&(constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC|constants.O_APPEND))!==0;
   if(writes)add({op:'write',path:pathValue(args[0]),followFinal:true});
  }else if(/^mkdir(?:Sync)?$/.test(name)){known=true;add({op:'create-name',path:pathValue(args[0]),followFinal:false});}
  else if(/^rename(?:Sync)?$/.test(name)){known=true;add({op:'rename',source:value(args[0],true),path:value(args[1],true),followFinal:false});}
  else if(/^symlink(?:Sync)?$/.test(name)){known=true;add({op:'link',targetValue:value(args[0],true),path:value(args[1],true),linkKind:value(args[2])==='junction'?'junction':'symbolic',followFinal:false});}
  else if(/^link(?:Sync)?$/.test(name)){known=true;add({op:'link',source:value(args[0],true),path:value(args[1],true),linkKind:'hard',followFinal:false,sourceFollowFinal:true});}
  else if(/^(?:rm|rmdir|unlink|truncate|remove|emptyDir)(?:Sync)?$/.test(name))known=true;
  if(known)covered.add(at);
 }
 for(let index=0;index<reader.t.length;index++)if(reader.t[index]?.[0]==='id'&&writerName.test(reader.t[index]![1])&&reader.t[index+1]?.[1]==='('&&!covered.has(index+1))complete=false;
 return {effects,complete,cwdInvalid,cwdValues};
}
