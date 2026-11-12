// SPDX-License-Identifier: AGPL-3.0-or-later
// One submitted operation, current disk only. Collection never transfers aliases.
import { candidatesOf, simpleCommand, interpreterKey, ownerInterpreterProgram } from './shell/walk.ts';
import { Unreadable, literalText } from './shell/lex.ts';
import { collectNoLimits } from './no-limits-collect.ts';
import { ownerCwdHooks } from './no-limits-cwd.ts';
import { archiveCommandEffects, collectProducer, type AliasOperation } from './no-limits-producers.ts';
import { collectNativeProducers } from './no-limits-native-producers.ts';
import { producerHazards, producerPrefixMatches, type ProducerHazard } from './no-limits-producer-hazards.ts';
import { effectiveDestinations } from './no-limits-placement.ts';
import { ownerArgumentCommand, ownerCommandRoles, slotWord } from './no-limits-role-adapter.ts';
import { inspectNativeEffects, lexicalPath, unknownCwdSuffixDecisions, type CwdCandidate, type FsContext, type InspectedOperation, type NativeEffect, type ProtectedDecision, type Resolution, windowsPath } from './no-limits-fs.ts';

export type OwnerProtectedDecision = ProtectedDecision & { readonly taintTriggers?: readonly ProducerHazard[] };
export interface OwnerInspection {
 readonly verdict:'run'|'hold'; readonly decisions:readonly OwnerProtectedDecision[];
 readonly operations:readonly EnvelopeProducer[]; readonly hazards:readonly ProducerHazard[];
 readonly effects:readonly {effect:NativeEffect;resolution:Resolution;decisions:readonly ProtectedDecision[]}[];
 readonly diagnostics:readonly unknown[];
 readonly codeBodies?:readonly {id:string;lang:'py'|'js';text:string;cwd?:string;cwdInvalid:boolean;windows?:boolean}[];
}
export interface OwnerFsContext extends FsContext {
 readonly sessionEdits?:ReadonlySet<string>;
 readonly sessionFile?:(path:string)=>{text:string}|'unavailable';
}
type EnvelopeProducer=AliasOperation & {readonly windows?:boolean};
type LocatedEffect={effect:NativeEffect;context:FsContext;cwds?:readonly CwdCandidate[]};

/** All destinations exist in the record set before the first hazard query.
 * Keep the triggers on each selected write: a producer's independent deny is
 * insufficient evidence that its future consumer was held. */
function aggregate(operations:readonly EnvelopeProducer[],writes:readonly LocatedEffect[],direct:readonly ProtectedDecision[],diagnostics:readonly unknown[],context:FsContext):OwnerInspection {
 const effects=writes.flatMap(({effect,context:ctx,cwds})=>{
  const inspection=inspectNativeEffects([effect],ctx);
  return inspection.effects.map(judged=>({...judged,decisions:[...judged.decisions,...(cwds?unknownCwdSuffixDecisions(effect,cwds,ctx):[])]}));
 });
 return aggregateEffects(operations,effects,direct,diagnostics,context);
}
function aggregateEffects(operations:readonly EnvelopeProducer[],effects:OwnerInspection['effects'],direct:readonly ProtectedDecision[],diagnostics:readonly unknown[],context:FsContext):OwnerInspection {
 const roots=operations.flatMap(operation=>operation.destinationRoots);
 const hazards=operations.flatMap(operation=>producerHazards(operation.id,operation.operands,roots,{...context,windows:operation.windows??context.windows}));
 const prefixes=[...new Set(operations.flatMap(operation=>operation.destinationPrefixes))];
 const decisions:OwnerProtectedDecision[]=[...direct,...effects.flatMap(judged=>judged.decisions)];
 const triggers=Object.freeze([...hazards]);
 const taintOperationIds=Object.freeze([...new Set(hazards.map(h=>h.operationId))]);
 const taintCauses=Object.freeze([...new Set(hazards.map(h=>h.cause))]);
 const dependencyOperationIds=Object.freeze([...new Set(hazards.flatMap(h=>h.dependencyOperationIds))]);
 for(const judged of effects){
   if(!hazards.length)continue;
   const {effect,resolution}=judged;
   const lexical=resolution.lexical??lexicalPath(effect.path,context);
   const paths=[lexical,...(resolution.kind==='known'?[resolution.physical]:[])];
   const unknown=/\u0001/.test(effect.path)||resolution.kind!=='known';
   const prefix=prefixes.find(prefix=>paths.some(path=>producerPrefixMatches(path,prefix,context.windows||windowsPath(path))));
   if(!unknown&&prefix===undefined)continue;
   decisions.push(Object.freeze({operandId:effect.operandId??effect.path,op:effect.op,reason:'alias-taint',ruleId:'protected-alias-taint',protectedClass:'protected-path',lexical,
    ...(resolution.kind==='known'?{physical:resolution.physical,identity:resolution.identity}:{}),resolution,
    taintOperationIds,taintCauses,
    dependencyOperationIds,matchedPrefix:prefix,taintTriggers:triggers}));
 }
 // Every alias decision above shares the same immutable trigger envelope.
 // The envelope is identical for all alias keys; omit its repeated encoding.
 const unique=Object.freeze([...new Map(decisions.map(decision=>[JSON.stringify(decision.reason==='alias-taint'?{...decision,taintTriggers:undefined}:decision),decision])).values()]);
 return Object.freeze({verdict:unique.length?'hold':'run',decisions:unique,operations:Object.freeze([...operations]),hazards:Object.freeze(hazards),effects:Object.freeze([...effects]),diagnostics:Object.freeze([...diagnostics])});
}

/** Exposed code bodies share their original request's envelope. Keep each
 * body's cwd-resolved effects; concatenate no source and invent no shell. */
export function combineNoLimitsInspections(inspections:readonly OwnerInspection[],context:FsContext={},namespaces?:readonly string[]):OwnerInspection {
 const operations=inspections.flatMap((inspection,index)=>inspection.operations.map(operation=>{
  const key=(id:string)=>`body:${namespaces?.[index]??index}:${id}`;
  return {...operation,id:key(operation.id),operands:operation.operands.map(operand=>({...operand,id:key(operand.id)})),
   destinationRoots:operation.destinationRoots.map(root=>({...root,operationId:key(root.operationId)}))};
 }));
 const effects=inspections.flatMap((inspection,index)=>inspection.effects.map(judged=>({...judged,effect:{...judged.effect,operandId:`body:${namespaces?.[index]??index}:${judged.effect.operandId??judged.effect.path}`}})));
 return aggregateEffects(operations,effects,inspections.flatMap(inspection=>inspection.decisions.filter(decision=>decision.reason!=='alias-taint')),inspections.flatMap(inspection=>inspection.diagnostics),context);
}

export function inspectNoLimits(operation:InspectedOperation,context:OwnerFsContext={}):OwnerInspection {
 const ctx={...context,cwd:operation.cwd??context.cwd,cwdInvalid:operation.cwdInvalid||context.cwdInvalid,windows:context.windows??(operation.kind==='exec'?operation.dialect!=='sh':windowsPath(operation.cwd??context.cwd??''))};
 if(operation.kind==='native'){
  const operations=collectNativeProducers('native',operation.effects,ctx);
  const extra=operations.flatMap(producer=>producer.effects.slice(1));
  return aggregate(operations,[...operation.effects,...extra].map(effect=>({effect,context:ctx})),operations.flatMap(producer=>producer.directDecisions),[],ctx);
 }
 const dialect=operation.dialect==='sh'?'posix':operation.dialect;
 const text=operation.text;
 const sessionFiles=new Map<string,{text:string}|'unavailable'>();
 const sessionFile:OwnerFsContext['sessionFile']=ctx.sessionFile?(path:string)=>{if(!sessionFiles.has(path))sessionFiles.set(path,ctx.sessionFile!(path));return sessionFiles.get(path)!;}:undefined;
 function gather(dependencies:readonly AliasOperation[]=[]){
  return collectNoLimits(text,{cwd:ctx.cwd,runtimePaths:ctx.runtimePaths,dialect,sessionEdits:ctx.sessionEdits,sessionFile,
   hooks:ownerCwdHooks({...ctx,cwdDependencyPatterns:dependencies.flatMap(producer=>producer.destinationRoots)})});
 }
 function inspect(envelope:ReturnType<typeof gather>){
  const operations:EnvelopeProducer[]=[],writes:LocatedEffect[]=[],direct:ProtectedDecision[]=[],codeBodies:NonNullable<OwnerInspection['codeBodies']>[number][]=[];
  for(const record of envelope.commands)for(const location of record.locations){
   const cwds=location.ownerCwd;
   for(const [index,cwd]of (cwds?.length?cwds:[{logical:location.context.cwd,stack:[]}]).entries()){
    const local={...ctx,cwd:cwd.logical??cwd.physical,cwdInvalid:!cwd.logical&&!cwd.physical,windows:record.dialect!=='posix'||ctx.windows};
    const walk={...location.context,cwd:local.cwd};
    const command=ownerArgumentCommand(simpleCommand(record.command.name,record.command.args,walk,record.command));
    const id=`${record.syntaxId}@${location.scopeId}:${index}`;
    const key=interpreterKey(command.name==='py'?'python':command.name);
    if(key==='python'||key==='node'){
     try{
      const program=ownerInterpreterProgram(command.name,command.args,walk);
      let body:string|undefined;
      if(program?.kind==='code'){
       const values=program.words.map(literalText);if(values.every((value):value is string=>value!==undefined))body=values.join('\n');
      }else if(program?.kind==='stdin'&&command.stdin?.kind==='literal')body=command.stdin.text;
      else if(program?.kind==='file'&&ctx.sessionEdits?.has(program.path)){
       const file=sessionFile?.(program.path);if(file&&file!=='unavailable')body=file.text;
      }
      if(body!==undefined)codeBodies.push({id:record.syntaxId,windows:local.windows,lang:key==='python'?'py':'js',text:body,cwd:local.cwd,cwdInvalid:local.cwdInvalid});
     }catch(error){
      if(!(error instanceof Unreadable))throw error;
      // An opaque interpreter retains sibling effects and its existing refusal.
     }
    }

    const baseProducer=collectProducer(record.syntaxId,command,local,walk,record.dialect);
    const producer=baseProducer&&Object.freeze({...baseProducer,windows:local.windows});
    if(producer){operations.push(producer);direct.push(...producer.directDecisions);writes.push(...producer.effects.map(effect=>({effect,context:local,cwds})));}
    const placement=producer?.placement??effectiveDestinations(command,local,walk);
    if(placement&&!producer){direct.push(...placement.decisions);writes.push(...placement.destinations.map(item=>({effect:{...item.effect,operandId:`${id}:${item.effect.operandId}`},context:local,cwds})));}
    const archive=archiveCommandEffects(id,command,local,walk);
    if(archive&&!producer)writes.push(...archive.effects.map(effect=>({effect,context:local,cwds})));
    if(producer||placement||archive)continue;
    const roles=ownerCommandRoles(command,record.dialect==='pwsh'?'pwsh':'posix');
    for(const slot of roles.slots)if(slot.role==='write'){
     const word=slotWord(command,slot);if(!word)continue;
     const deleting=/^(?:rm|rmdir|unlink|del|erase|remove-item|ri)$/.test(roles.program);
     for(const candidate of candidatesOf(word,walk))writes.push({effect:{operandId:`${id}:write:${slot.arg}`,op:deleting?'delete':'write',path:candidate.path,followFinal:!deleting},context:local,cwds});
    }
   }
  }
  for(const record of envelope.writes)for(const location of record.locations){
   const cwds=location.ownerCwd;
   for(const [index,cwd]of (cwds?.length?cwds:[{logical:location.context.cwd,stack:[]}]).entries())for(const candidate of location.candidates){
    writes.push({effect:{operandId:`${record.syntaxId}@${location.scopeId}:${index}`,op:'write',path:candidate.path,followFinal:true},context:{...ctx,cwd:cwd.logical??cwd.physical,cwdInvalid:!cwd.logical&&!cwd.physical,windows:record.dialect!=='posix'||ctx.windows},cwds});
   }
  }
  return {operations,writes,direct,codeBodies};
 }
 // First discover producer destinations. Recollect cwd annotations with those
 // roots so an initially absent alias cannot prove a later cd safe.
 const first=inspect(gather()),envelope=gather(first.operations),all=inspect(envelope);
 return Object.freeze({...aggregate(all.operations,all.writes,all.direct,envelope.diagnostics,ctx),codeBodies:Object.freeze(all.codeBodies)});
}
