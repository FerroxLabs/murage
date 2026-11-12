// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { producerGlobMatches, type ProducerTraversalPattern } from './no-limits-glob.ts';
import { classifyNoLimitsPath, decisionsForResolution, lexicalPath, noLimitsDisk, pathKey, protectedIdentityRegistry, resolveNoLimitsPath, windowsPath, type FsContext, type ProtectedDecision, type Resolution, type TaintCause } from './no-limits-fs.ts';

export interface ProducerOperand {
 readonly id:string; readonly role:'source'|'target'|'destination'|'backup'|'archive-input'|'member';
 readonly value?:string; readonly rawValue?:string; readonly cwd?:string; readonly unknownCause?:string;
 readonly traversalPatterns?:readonly ProducerTraversalPattern[];
 readonly tree?:boolean; readonly followFinal?:boolean;
}
export interface DependencyRoot { readonly operationId:string; readonly path?:string; readonly cwd?:string; readonly unknownCause?:string; readonly backupOf?:string; readonly preservesCwdRoot?:boolean }
export interface ProducerHazard {
 readonly operationId:string; readonly operandId:string; readonly role:ProducerOperand['role'];
 readonly cause:TaintCause; readonly detail:string; readonly resolution:Resolution;
 readonly decisions:readonly ProtectedDecision[]; readonly dependencyOperationIds:readonly string[];
}
const dotdot=(path:string,context:FsContext)=>(context.windows||windowsPath(path)?path.replaceAll('\\','/'):path).split('/').includes('..');
export const producerPrefixMatches=(path:string,root:string,windows?:boolean)=>{if(root==='*')return true;const p=pathKey(path,windows),r=pathKey(root,windows).replace(/\/$/,'');return p===r||p.startsWith(r+'/');};
const within=producerPrefixMatches;
/** Shared with cwd annotations: numbered backups are possible destination
 * names, never a broad parent dependency. */
export function producerDependencyRootMatches(path:string,root:Pick<DependencyRoot,'path'|'cwd'|'backupOf'|'preservesCwdRoot'>,context:FsContext={}):boolean{
 if(!root.path)return true;
 const target=lexicalPath(root.path,{...context,cwd:root.cwd??context.cwd});
 if(root.preservesCwdRoot&&pathKey(path,context.windows)===pathKey(target,context.windows))return false;
 if(within(path,target,context.windows))return true;
 if(!root.backupOf)return false;
 const value=pathKey(path,context.windows),base=pathKey(target,context.windows);
 if(!value.startsWith(base))return false;
 const suffix=value.slice(base.length);
 return suffix==='~'||suffix.startsWith('~/')||/^\.~\d+~(?:\/|$)/.test(suffix);
}

/** Compare the raw glob traversal with all actual destination roots. Initial
 * matches cannot discharge a producer that can introduce another match. */
function patternDependency(pattern:ProducerTraversalPattern,root:DependencyRoot,tree:boolean,context:FsContext):boolean{
 if(!root.path)return true;
 const target=lexicalPath(root.path,{...context,cwd:root.cwd??context.cwd});
 if(within(pattern.prefix,target,context.windows))return true;
 if(!within(target,pattern.prefix,context.windows))return false;
 const tail=target.slice(pattern.prefix.replace(/\/$/,'').length).replace(/^\//,'').split('/');
 const components=pattern.components;
 for(let i=0;i<Math.min(tail.length,components.length);i++){
  const component=components[i]!,name=tail[i]!;
  const visible=(value:string)=>!value.startsWith('.')||component.tokens[0]?.kind==='literal'&&component.tokens[0].value==='.';
  if(visible(name)&&producerGlobMatches(component,name,context.windows))continue;
  if(!visible(name))return false;
  if(root.backupOf&&i===tail.length-1){
   if(producerGlobMatches(component,name+'~',context.windows))continue;
   // Numbered names are unbounded. Literal prefix/suffix can prove unrelated
   // families; otherwise retain Unknown without inventing a specific entry.
   const key=(value:string)=>context.windows?value.toLowerCase():value;
   if((key(name+'.~').startsWith(key(component.literalPrefix))||key(component.literalPrefix).startsWith(key(name+'.~')))&&
    (!component.literalSuffix||component.literalSuffix.endsWith('~')))continue;
  }
  return false;
 }
 return tail.length<=components.length||tree;
}

/** Hazard queries are pure observations of current disk. The caller gathers
 * ALL actual destination roots first. Parent hold prefixes never come here. */
export function producerHazards(operationId:string,operands:readonly ProducerOperand[],roots:readonly DependencyRoot[],context:FsContext={}):readonly ProducerHazard[]{
 const hazards:ProducerHazard[]=[];
 const named=operands.flatMap(operand=>{
  if(operand.value===undefined)return [];
  const ctx={...context,cwd:operand.cwd??context.cwd};
  const resolved=resolveNoLimitsPath(operand.value,ctx);
  return [lexicalPath(operand.value,ctx),...(resolved.kind==='known'?[resolved.physical]:[])].filter(path=>classifyNoLimitsPath(path,ctx)!==null);
 });
 const registry=protectedIdentityRegistry(context,named);
 const push=(operand:ProducerOperand,cause:TaintCause,detail:string,resolution:Resolution,decisions:readonly ProtectedDecision[]=[],dependencies:readonly string[]=[])=>{
  hazards.push(Object.freeze({operationId,operandId:operand.id,role:operand.role,cause,detail,resolution,decisions:Object.freeze([...decisions]),dependencyOperationIds:Object.freeze([...new Set(dependencies)])}));
 };
 function query(operand:ProducerOperand,raw:string,ctx:FsContext,tree=false):Resolution{
  const resolution=resolveNoLimitsPath(raw,{...ctx,followFinal:true});
  if(dotdot(raw,ctx)||operand.rawValue!==undefined&&dotdot(operand.rawValue,ctx)||(resolution.linkValues??[]).some(value=>dotdot(value,ctx)))push(operand,'dotdot-value','complete-parent-component',Object.freeze({kind:'unknown',cause:'dotdot-value',lexical:lexicalPath(raw,ctx)}));
  const footprints=[lexicalPath(raw,ctx),...(resolution.footprint??[]),...(resolution.kind==='known'?[resolution.physical]:[])];
  const dependencies=roots.filter(root=>root.operationId!==operationId&&(!root.path||footprints.some(path=>{
   const target=lexicalPath(root.path!,{...context,cwd:root.cwd??context.cwd});
   return producerDependencyRootMatches(path,root,context)||tree&&[lexicalPath(raw,ctx),...(resolution.kind==='known'?[resolution.physical]:[])].some(base=>within(target,base,context.windows));
  }))).map(root=>root.operationId);
  if(dependencies.length)push(operand,'producer-dependency','traverses-other-producer-destination',Object.freeze({kind:'unknown',cause:'producer-dependency',lexical:lexicalPath(raw,ctx)}),[],dependencies);
  const decisions=decisionsForResolution({operandId:operand.id,op:'write',path:raw,followFinal:true},resolution,ctx,registry).map(decision=>Object.freeze({...decision,op:'alias-hazard'}));
  if(decisions.length)push(operand,'protected','protected-operand-or-identity',resolution,decisions);
  else if(resolution.kind!=='known')push(operand,resolution.kind==='unknown'&&resolution.cause==='unknown-expansion'?'unknown-expansion':'other-unknown',resolution.kind==='unknown'?resolution.cause:'resolution-exhausted',resolution);
  return resolution;
 }
 for(const operand of operands){
  const ctx={...context,cwd:operand.cwd??context.cwd};
  if(operand.unknownCause||operand.value===undefined)push(operand,'unknown-expansion',operand.unknownCause??'unavailable-operand',Object.freeze({kind:'unknown',cause:operand.unknownCause??'unavailable-operand'}));
  if(operand.value===undefined)continue;
  const patternDependencies=roots.filter(root=>root.operationId!==operationId&&operand.traversalPatterns?.some(pattern=>patternDependency(pattern,root,!!operand.tree,ctx))).map(root=>root.operationId);
  if(patternDependencies.length)push(operand,'producer-dependency','raw-glob-traverses-other-producer-destination',Object.freeze({kind:'unknown',cause:'producer-dependency',lexical:lexicalPath(operand.rawValue??operand.value,ctx)}),[],patternDependencies);
  const resolution=query(operand,operand.value,ctx,operand.tree);
  if(!operand.tree||context.remote||resolution.kind!=='known'||!resolution.directory)continue;
  const disk=context.disk??noLimitsDisk;
  let count=0,overflow=false;
  const visit=(path:string,depth:number)=>{
   if(depth>32){overflow=true;return;}
   let names:readonly string[];
   try{names=disk.readdir(path);}catch{push(operand,'other-unknown','unreadable-subtree',Object.freeze({kind:'unknown',cause:'unreadable-subtree',fixedPrefix:path}));return;}
   for(const name of names){
    if(++count>4096){overflow=true;return;}
    const child=`${path.replace(/\/$/,'')}/${name}`;
    // Query each entry's alias/value/identity without recursively following a
    // directory link. A failure keeps earlier findings and visits siblings.
    query({...operand,id:`${operand.id}:tree:${child}`},child,ctx);
    try{if(disk.lstat(child).isDirectory())visit(child,depth+1);}
    catch{push(operand,'other-unknown','unreadable-subtree-entry',Object.freeze({kind:'unknown',cause:'unreadable-subtree-entry',fixedPrefix:child}));}
    if(overflow)return;
   }
  };
  visit(resolution.physical,0);
  if(overflow)push(operand,'other-unknown','subtree-overflow',Object.freeze({kind:'unknown',cause:'subtree-overflow',fixedPrefix:resolution.physical}));
 }
 return Object.freeze(hazards);
}
