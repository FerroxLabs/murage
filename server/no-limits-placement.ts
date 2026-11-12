// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { producerParent } from './no-limits-producer-anchors.ts';
import { literalText, type Word } from './shell/lex.ts';
import { candidatesOf, newContext, type SimpleCommand, type WalkContext } from './shell/walk.ts';
import { optionKey, ownerArgumentCommand, ownerCommandRoles, positionalSlots, slotWord } from './no-limits-role-adapter.ts';
import { dynamicProducerWord, expandProducerGlob, producerValues, type ProducerValueBudget } from './no-limits-producer-values.ts';
import { decisionsForResolution, noLimitsDisk, protectedIdentityRegistry, resolveNoLimitsPath, spellPath, windowsPath, type CwdCandidate, type FsContext, type NativeEffect, type ProtectedDecision, type Resolution } from './no-limits-fs.ts';

export type PlacementProgram = 'cp' | 'mv' | 'install' | 'ln' | 'rsync';
export interface PlacedDestination {
 readonly sourceOperandId: string; readonly source?: string; readonly directory: string; readonly path: string;
 readonly semantics: 'write-through' | 'replace-entry' | 'directory' | 'contents'; readonly followFinal: boolean;
 readonly observed: Resolution; readonly effect: NativeEffect; readonly decisions: readonly ProtectedDecision[];
}
export interface DestinationPlacement {
 readonly decisions: readonly ProtectedDecision[]; readonly program: PlacementProgram; readonly destinations: readonly PlacedDestination[];
 readonly receiverDirectories: readonly string[]; readonly directoryOperands: readonly string[]; readonly sources: readonly {operandId:string;path:string;unknown:boolean}[];
 readonly destinationWord?: Word; readonly sourceWords: readonly {index:number;word:Word}[];
 readonly unknown: boolean; readonly unknownCauses: readonly string[];
}
const supported = new Set(['cp','mv','install','ln','rsync']);
export const placementProgram = (name:string): name is PlacementProgram => supported.has(name.replace(/^.*[\\/]/,'').toLowerCase().replace(/\.exe$/,''));
const basename = (path:string) => path.replace(/\/+$/,'').split('/').at(-1) ?? '';
const withoutTrailing = (path:string,context:FsContext) => path.replace(context.windows||windowsPath(path)?/[\\/]+$/:/\/+$/,'');
const text = (word:Word|undefined) => word && literalText(word);
/** Consume the shared role table; -t/-T mean GNU placement only, never rsync time.
 * Raw Words are retained at this boundary so expansions keep unknown provenance. */
export function effectiveDestinations(input:SimpleCommand, context:FsContext, walk?:WalkContext, cwds?:readonly CwdCandidate[], receiverCardinalityUnknown=false):DestinationPlacement|undefined {
 const command=ownerArgumentCommand(input);
 const program=command.name.replace(/^.*[\\/]/,'').toLowerCase().replace(/\.exe$/,'');if(!placementProgram(program))return undefined;
 const roles=ownerCommandRoles(command),unknownCauses:string[]=[];
 const indexed=positionalSlots(roles.slots).map(slot=>({index:command.argumentOrigins[slot.arg-1]!,argument:slot.arg-1,word:slotWord(command,slot)!}));
 if(command.argumentExpansionUnknown)unknownCauses.push('argument-expansion-overflow');
 const keys=new Set(roles.slots.map(optionKey));
 const has=(...names:string[])=>names.some(name=>keys.has(name));
 const createLink=program==='cp'&&has('-s','-l','--symbolic','--symbolic-link','--link');
 const preserveLinks=program==='cp'&&has('-a','-d','-P','--archive','--no-dereference');
 const recursive=has('-a','-r','-R','--recursive','--archive');
 const noDirectory=program!=='rsync'&&has('-T','--no-target-directory');
 const noDereference=program==='ln'&&has('-n','--no-dereference');
 const directoryOnly=program==='install'&&has('-d','--directory');
 const replace=['mv','ln','install'].includes(program)||program==='cp'&&has('--remove-destination');
 const inplace=program==='rsync'&&has('--inplace');
 let relative=false;
 for(const slot of roles.slots){
  if(program==='rsync'&&['-R','--relative'].includes(optionKey(slot)??''))relative=true;
  if(program==='rsync'&&optionKey(slot)==='--no-relative')relative=false;
 }
 const target=program==='rsync'?undefined:roles.slots.findLast(slot=>['-t','--target-directory'].includes(slot.key??''));
 const directory=target?slotWord(command,target):undefined;
 if(target&&!directory)unknownCauses.push('missing-target-directory');
 if(command.args.some(dynamicProducerWord))unknownCauses.push('unknown-option-or-operand');
 const wordBudgets=new Map<number,ProducerValueBudget>();
 const values=(w:Word,index=-1):{path:string;unknown:boolean}[]=>{
  if(index<0)index=command.args.indexOf(w);
  const origin=command.argumentOrigins[index]??index;
  let budget=index<0?undefined:wordBudgets.get(origin);
  if(index>=0&&!budget){budget={remaining:4096};wordBudgets.set(origin,budget);}
  const literal=text(w);
  const bracketGlob=w.parts.some(part=>part.kind==='lit'&&part.quote==='none'&&/\[[^\]]+\]/.test(part.text));
  if(literal!==undefined&&!bracketGlob)return [{path:literal.startsWith('~')?'\u0000'+literal:literal,unknown:false}];
  if(!dynamicProducerWord(w))return producerValues(w,walk??newContext(context.cwd,context.runtimePaths),context,budget).map(value=>({path:value.value??'\u0001',unknown:!!value.unknownCause}));
  if(index<0)index=command.args.indexOf(w);
  const candidates=walk?candidatesOf(w,walk):index>=0?command.operands[index]:undefined;
  return candidates?.length?candidates.flatMap(c=>c.kind==='glob'?dynamicProducerWord(w)?[{path:c.path,unknown:true}]:expandProducerGlob(c.path,context,w).map(value=>({path:value.value??'\u0001',unknown:!!value.unknownCause})): [{path:c.path,unknown:c.kind!=='literal'||/[\u0001]/.test(c.path)}]):[{path:'\u0001',unknown:true}];
 };
 const sourceWords=[...indexed];
 const destinationWord=directory??(!directoryOnly&&sourceWords.length>1?sourceWords.pop()!.word:program==='ln'&&sourceWords.length===1?{parts:[{kind:'lit',text:'.',quote:'single'}]} as Word:undefined);
 const sources=sourceWords.flatMap(({word,index,argument})=>values(word,argument).map(v=>({operandId:`source:${index}`,path:v.path,unknown:v.unknown})));
 const roots=directoryOnly?indexed.flatMap(({word,argument})=>values(word,argument)):destinationWord?values(destinationWord,target?target.arg-1:command.args.indexOf(destinationWord)):[];
 if(!roots.length&&!directoryOnly)unknownCauses.push('unknown-destination');
 // Selection can collapse a directory transfer to one file. Disk contents do
 // not prove the cardinality of a literal filtered/files-from command.
 const uncertainCardinality=receiverCardinalityUnknown||sources.some(source=>source.unknown)||program==='rsync'&&(
  command.args.some(dynamicProducerWord)||has('--files-from','--include','--exclude','--filter','--include-from','--exclude-from','-f','-F')||sources.some(source=>spellPath(source.path,context).endsWith('/')));
 const receiverDirectories:string[]=[];
 const locations=cwds?.length?cwds:[{logical:context.cwd,stack:[]}];
 const destinations:PlacedDestination[]=[],directoryOperands:string[]=[],directoryDecisions:ProtectedDecision[]=[];
 const registry=protectedIdentityRegistry(context);
 for(const candidate of locations){
  const ctx={...context,cwd:candidate.logical??candidate.physical};
  for(const root of roots){
   directoryOperands.push(root.path);
   if(root.unknown){unknownCauses.push('unknown-destination-value');continue;}
   const observedRoot=resolveNoLimitsPath(root.path,ctx);
   const entry=resolveNoLimitsPath(root.path,{...ctx,followFinal:false});
   const linkedDirectory=observedRoot.kind==='known'&&observedRoot.directory&&entry.kind==='known'&&observedRoot.physical!==entry.physical;
   const existsDirectory=observedRoot.kind==='known'&&observedRoot.directory;
   const explicitDirectory=directory!==undefined||spellPath(root.path,ctx).endsWith('/')||sources.length>1;
   const ambiguousDirectory=observedRoot.kind!=='known';
   const into=!noDirectory&&(uncertainCardinality||ambiguousDirectory||explicitDirectory||existsDirectory&&!(program==='ln'&&noDereference&&linkedDirectory));
   const raw=spellPath(root.path,ctx),parent=producerParent(raw);
   const trimmed=raw.replace(/\/+$/,'')||'/';
   const spelled=trimmed===parent.replace(/\/$/,'')?parent:trimmed;
   const directorySource=program==='rsync'&&sources.some(source=>{const found=resolveNoLimitsPath(source.path,{...ctx,followFinal:has('-L','--copy-links','-k','--copy-dirlinks')});return found.kind==='known'&&found.directory;});
   for(const receiver of uncertainCardinality?[spelled,parent]:[into||directorySource?spelled:parent])receiverDirectories.push(receiver);
   // Only directory placement needs a referent preflight. Named replacements
   // are judged below using their actual final-component effect.
   if(into||directoryOnly)directoryDecisions.push(...decisionsForResolution({operandId:'directory-operand',op:'create-name',path:root.path,followFinal:false},observedRoot,ctx,[]));
   const rootSemantics:PlacedDestination['semantics']=directoryOnly?'directory':program==='rsync'&&!inplace?'replace-entry':replace?'replace-entry':'write-through';
   const add=(path:string,sourceOperandId:string,source?:string,contents=false)=>{
    let semantics:PlacedDestination['semantics']=rootSemantics;
    if(program==='cp'&&(createLink||preserveLinks&&source&&!ctx.remote&&(()=>{
     const at=resolveNoLimitsPath(source,{...ctx,followFinal:false});
     try{return at.kind==='known'&&(ctx.disk??noLimitsDisk).lstat(at.physical).isSymbolicLink();}catch{return false;}
    })()))semantics='replace-entry';
    const followFinal=semantics==='write-through'||semantics==='directory';
    const effect:NativeEffect=Object.freeze({operandId:sourceOperandId+':destination',op:followFinal?'write':'create-name',path,followFinal,...(source?{source}:{})});
    const actual=resolveNoLimitsPath(path,{...ctx,followFinal});
    const observed=resolveNoLimitsPath(path,{...ctx,followFinal:true});
    const evidence=[...decisionsForResolution(effect,actual,ctx,registry)];
    // Mandatory observed-child preflight is separate from inode/write-through
    // evidence for the actual final-component effect.
    if(into||contents)for(const decision of decisionsForResolution({...effect,followFinal:true},observed,ctx,[]))if(decision.reason!=='protected-inode')evidence.push(Object.freeze({...decision,reason:decision.reason==='resolution-exhausted'?'resolution-exhausted':'effective-destination',destinationPlacement:Object.freeze({sourceOperandId,directory:root.path,child:path,semantics}),observedDestinationResolution:observed}));
    const placed:PlacedDestination={sourceOperandId,source,directory:root.path,path,semantics:contents?'contents':semantics,followFinal,observed,effect,decisions:Object.freeze(evidence)};
    destinations.push(Object.freeze(placed));
   };
   if(directoryOnly){add(root.path,'directory');continue;}
   if((ambiguousDirectory||uncertainCardinality)&&!noDirectory)add(root.path,'destination');
   if(!into&&program!=='rsync'){add(root.path,sources[0]?.operandId??'destination',sources[0]?.path);continue;}
   for(const source of sources){
    if(source.unknown){unknownCauses.push('unknown-source-value');if(/[\u0000\u0001*?[]/.test(basename(spellPath(source.path,ctx)))){unknownCauses.push('unknown-source-basename');continue;}}
    let suffix=basename(spellPath(source.path,ctx)),contents=program==='rsync'&&(spellPath(source.path,ctx).endsWith('/')||has('--files-from'));
    if(program==='rsync'&&relative){
     const cleaned=spellPath(source.path,ctx);suffix=cleaned.includes('/./')?cleaned.slice(cleaned.lastIndexOf('/./')+3):cleaned.replace(/^(?:[a-z]:)?\/+|^\.\//i,'');
    }
    if(program==='rsync'&&!contents&&!into){add(root.path,source.operandId,source.path);continue;}
    const placed=contents?root.path:`${withoutTrailing(root.path,ctx)}/${suffix}`;
    add(placed,source.operandId,source.path,contents);
    // Materialize only actually exposed source names, with a fixed tree bound.
    // This is destination placement; no copy/move/replacement is simulated.
    if((contents||recursive||program==='mv')&&!ctx.remote){
     const sourceRoot=resolveNoLimitsPath(source.path,{...ctx,followFinal:false});
     if(sourceRoot.kind==='known'&&sourceRoot.directory){
      let count=0;
      const visit=(physical:string,relative:string,depth:number)=>{
       if(depth>32){unknownCauses.push('source-contents-overflow');return;}
       let names:readonly string[];
       try{names=(ctx.disk??noLimitsDisk).readdir(physical);}catch{unknownCauses.push('unavailable-source-contents');return;}
       for(const name of names){
        if(++count>4096){unknownCauses.push('source-contents-overflow');return;}
        const child=relative?`${relative}/${name}`:name;
        add(`${withoutTrailing(placed,ctx)}/${child}`,source.operandId,`${withoutTrailing(source.path,ctx)}/${child}`,true);
        try{if((ctx.disk??noLimitsDisk).lstat(`${physical}/${name}`).isDirectory())visit(`${physical}/${name}`,child,depth+1);}catch{unknownCauses.push('unavailable-source-contents');}
       }
      };
      visit(sourceRoot.physical,'',0);
     }
    }
   }
  }
 }
 return Object.freeze({decisions:Object.freeze([...directoryDecisions,...destinations.flatMap(item=>item.decisions)]),program,destinations:Object.freeze(destinations),receiverDirectories:Object.freeze([...new Set(receiverDirectories)]),directoryOperands:Object.freeze([...new Set(directoryOperands)]),sources:Object.freeze(sources.map(v=>Object.freeze(v))),destinationWord,sourceWords:Object.freeze(sourceWords.map(({index,word})=>Object.freeze({index,word}))),unknown:unknownCauses.length>0,unknownCauses:Object.freeze([...new Set(unknownCauses)])});
}
