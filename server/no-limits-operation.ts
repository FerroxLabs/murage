// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Exact owner-only release projections. No legacy action/target mutation.
import { createHash } from 'node:crypto';
import { resolveCall } from '../shared/app-action-grant.ts';
import { parseApplyPatch, readFileChanges } from './drivers/codex-hook.ts';
import { freeze, hash } from './decision/bounds.ts';
import type { RequestSnapshot, ServiceCall } from './decision/types.ts';
import type { OwnerOperation } from './no-limits-inspection.ts';
import type { Dialect, InspectedOperation, NativeEffect } from './no-limits-fs.ts';
import { quote } from './no-limits-shell.ts';

export interface OperationPlace { readonly cwd?: string; readonly cwdInvalid?: boolean; readonly dialect?: Dialect }
export type ExtractedOperation =
  | Readonly<{ kind: 'operation'; exactOperation: InspectedOperation; operationHash: string }>
  | Readonly<{ kind: 'incomplete'; reason: string }>
  | Readonly<{ kind: 'code'; lang: 'py' | 'js'; text: string; cwd?: string; cwdInvalid: boolean; inputHash: string; exactOperation: OwnerOperation; operationHash: string }>;
const issued = new WeakMap<OwnerOperation, string>();
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const pathFields = ['path','file_path','filePath','filename','notebook_path','TargetFile','AbsolutePath','Path','FilePath','File','DirectoryPath'] as const;

/** Hash all values without constructing a second giant serialized body. Native
 * content, key names, argv and tails all bind even when effects are identical. */
export function exactInputHash(value: unknown): string {
  const digest=createHash('sha256'), ancestors=new Set<object>();
  const visit=(v:unknown):void=>{
    if(v===null){digest.update('null;');return;}
    if(typeof v==='string'){digest.update(`s${Buffer.byteLength(v)}:`);digest.update(v);return;}
    if(typeof v==='undefined'){digest.update('undefined;');return;}
    if(typeof v==='number'||typeof v==='boolean'){digest.update(`${typeof v}:${JSON.stringify(v)};`);return;}
    if(typeof v!=='object'||ancestors.has(v))throw new Error('operation-input-integrity');
    ancestors.add(v);digest.update(Array.isArray(v)?'[':'{');
    // Arrays bind their length and every index, including sparse entries.
    const keys=Array.isArray(v)?Array.from({length:v.length},(_,i)=>String(i)):Object.keys(v).sort();
    for(const key of keys){visit(key);const descriptor=Object.getOwnPropertyDescriptor(v,key);if(descriptor&&!('value'in descriptor))throw new Error('operation-input-integrity');visit(descriptor?.value);}
    digest.update(Array.isArray(v)?']':'}');ancestors.delete(v);
  };
  visit(value);return digest.digest('hex');
}
export function issuedOperationHash(operation: OwnerOperation): string | undefined { return issued.get(operation); }
function bind(operation: InspectedOperation, callIdentity: unknown): ExtractedOperation {
  const exactOperation=freeze(operation), operationHash=hash({operation:exactOperation,inputHash:exactInputHash(callIdentity)});
  issued.set(exactOperation,operationHash);return freeze({kind:'operation',exactOperation,operationHash});
}

/** Role projection only AFTER the shared strict parser accepts the complete
 * patch. This does not introduce another patch validity/interpretation parser. */
function patchEffects(value: unknown): NativeEffect[] | undefined {
  if(!parseApplyPatch(value)||typeof value!=='string')return;
  const effects:NativeEffect[]=[];
  let updating: {path:string;index:number} | undefined;
  for(const line of value.split('\n').map(line=>line.endsWith('\r')?line.slice(0,-1):line)){
    const header=/^\*\*\* (Add File|Update File|Delete File): (.*)$/.exec(line);
    if(header){
      const path=header[2]!, index=effects.length;
      const op=header[1]==='Delete File'?'delete':header[1]==='Add File'?'write':'edit';
      effects.push({operandId:`patch:${index}:${op}`,op,path,followFinal:op!=='delete'});
      updating=header[1]==='Update File'?{path,index}:undefined;
      continue;
    }
    const move=/^\*\*\* Move to: (.*)$/.exec(line);
    if(move&&updating){
      effects[updating.index]={operandId:`patch:${updating.index}:remove-source`,op:'delete',path:updating.path,followFinal:false};
      effects.push({operandId:`patch:${effects.length}:rename`,op:'rename',source:updating.path,path:move[1]!,followFinal:false,sourceFollowFinal:true});
      effects.push({operandId:`patch:${effects.length}:write-destination`,op:'edit',path:move[1]!,followFinal:true});
      updating=undefined;
    }
  }
  return effects;
}
function fileChangeEffects(value: unknown): NativeEffect[] | undefined {
  if(!readFileChanges(value))return;
  const rows=Array.isArray(value)?value.map(row=>[object(row)?.path,object(row)?.kind] as const):Object.entries(object(value)!);
  const effects:NativeEffect[]=[];
  for(const [path,kind] of rows){
    const details=object(kind), type=typeof kind==='string'?kind:details?.type;
    const source=String(path), moved=string(details?.move_path??details?.movePath);
    if(moved){
      effects.push({operandId:`changes:${effects.length}:remove-source`,op:'delete',path:source,followFinal:false});
      effects.push({operandId:`changes:${effects.length}:rename`,op:'rename',path:moved,source,followFinal:false,sourceFollowFinal:true});
      effects.push({operandId:`changes:${effects.length}:write-destination`,op:'edit',path:moved,followFinal:true});
    }else effects.push({operandId:`changes:${effects.length}:${type}`,op:type==='delete'?'delete':type==='add'?'write':'edit',path:source,followFinal:type!=='delete'});
  }
  return effects;
}
const executables=/^(?:bash|shell|terminal|run_command|execute_command|start_process|run|powershell|pwsh|cmd|exec_command|execute)$/i;
const nativeNames=/^(?:write|write_file|write_files|write_to_file|create_file|replace_file_content|multi_replace_file_content|edit|edit_file|edit_files|multi_?edit|notebookedit|str_replace(?:_editor)?|delete|delete_file|delete_files|remove_file|move|move_file|rename|rename_file|copy|copy_file|symlink|hardlink|link)$/i;

/** Call this only after authenticated posture selection. Raw model text cannot
 * select an owner branch. No path/content list is capped or taken from prose. */
export function extractInspectedOperation(source: RequestSnapshot | ServiceCall, place: OperationPlace = {}): ExtractedOperation {
  try{
    const event='event'in source?source.event:undefined;
    const resolved=event?resolveCall({...event,engine:event.toolEngine}):undefined;
    let tool=resolved?.kind==='engine'?resolved.name:resolved?.kind==='mcp'?resolved.tool:source.tool;
    const input=resolved?.kind==='engine'||resolved?.kind==='mcp'?resolved.input:source.input;
    const body=object(input)??{};
    const cwdInvalid=place.cwdInvalid===true||body.cwdInvalid===true||body.cwdExplicit===true&&(typeof body.cwd!=='string'||body.cwd.length===0);
    const cwd=cwdInvalid?undefined:place.cwd??string(body.workdir)??string(body.cwd)??event?.executionCwd??event?.execEnv?.cwd;
    const dialect=place.dialect??event?.commandShell??(/^(?:pwsh|powershell)$/i.test(tool)?'pwsh':/^cmd$/i.test(tool)?'cmd':'sh');
    const identity={tool:source.tool,input,place:{cwd,cwdInvalid,dialect},...(event?{toolKind:event.toolKind,toolIdentity:event.toolIdentity}: {})};
    if(event?.toolInputTruncated)return {kind:'incomplete',reason:'truncated-operation-input'};
    if(event?.toolKind&&/^(?:write|edit|delete|move|copy)$/.test(event.toolKind))tool=event.toolKind;
    if(executables.test(tool)||event?.toolKind==='execute'){
      const raw=typeof input==='string'?input:body.command??body.cmd??body.script??body.argv;
      const text=typeof raw==='string'?raw:Array.isArray(raw)&&raw.every(x=>typeof x==='string')?raw.map(quote).join(' '):undefined;
      if(text===undefined)return {kind:'incomplete',reason:'missing-executable'};
      return bind({kind:'exec',text,dialect,...(cwd!==undefined?{cwd}:{}),cwdInvalid},identity);
    }
    if(/^(?:execute_code|python|python3|node|javascript)$/i.test(tool)){
      const text=typeof input==='string'?input:body.code??body.script;
      if(typeof text!=='string')return {kind:'incomplete',reason:'missing-code'};
      const operation=freeze({kind:'code' as const,lang:/node|javascript/i.test(tool)?'js' as const:'py' as const,text,...(cwd!==undefined?{cwd}:{}),cwdInvalid});
      const operationHash=hash({operation,inputHash:exactInputHash(identity)});issued.set(operation,operationHash);
      return freeze({...operation,inputHash:exactInputHash(identity),exactOperation:operation,operationHash});
    }
    const patch=typeof input==='string'?input:body.input??body.patch??body.command;
    let effects: NativeEffect[] | undefined;
    if(/^apply_?patch$/i.test(tool)||event?.toolKind==='edit'&&typeof body.patch==='string'){
      effects=patchEffects(patch);if(!effects)return {kind:'incomplete',reason:'unreadable-patch'};
    }else if(body.fileChanges!==undefined){
      effects=fileChangeEffects(body.fileChanges);if(!effects)return {kind:'incomplete',reason:'unreadable-file-changes'};
      const root=string(body.grantRoot);
      if(root)effects.push({operandId:'native:grant-root',op:'write',path:root,followFinal:true});
    }else{
      if(event?.toolKind&&/^(?:write|edit|delete|move|copy)$/.test(event.toolKind))tool=event.toolKind;
      effects=[];
      if(nativeNames.test(tool)&&!(/^str_replace(?:_editor)?$/i.test(tool)&&body.command==='view')){
        const op:NativeEffect['op']=/delete|remove/i.test(tool)?'delete':/move|rename/i.test(tool)?'rename':/copy/i.test(tool)?'copy':/link/i.test(tool)?'link':/edit|replace/i.test(tool)?'edit':'write';
        const add=(path:string,role:string,more:Partial<NativeEffect>={})=>effects!.push({operandId:`native:${effects!.length}:${role}`,op,path,followFinal:!['delete','rename','link'].includes(op),...more});
        const collect=(row:Record<string,unknown>,role:string):boolean=>{
          let found=false;
          if(['rename','copy','link'].includes(op)){
            const destination=string(row.destination??row.dest??row.new_path??row.link_path??row.path);
            const sourcePath=string(row.source??row.src??row.old_path??row.target);
            if(destination&&sourcePath){
              if(op==='rename')add(sourcePath,`${role}:remove-source`,{op:'delete',followFinal:false});
              add(destination,role,{source:sourcePath,...(op==='link'?{linkKind:/symlink/i.test(tool)?'symbolic' as const:'hard' as const,targetValue:sourcePath,sourceFollowFinal:true}:{}),...(row.recursive===true?{recursive:true}:{})});
              return true;
            }
          }
          for(const field of pathFields){const path=string(row[field]);if(path){add(path,`${role}:${field}`);found=true;}}
          for(const field of ['paths','files'] as const){
            const paths=row[field];
            if(paths!==undefined&&!Array.isArray(paths))throw new Error('unreadable-native-entry');
            if(Array.isArray(paths))for(let i=0;i<paths.length;i++){
              const path=string(paths[i]);if(path){
                // Codex's normalized edit paths include the names it removes.
                // Those are unlinks, not writes through the old final link.
                if(!(field==='paths'&&op==='edit'&&Array.isArray(row.removed)&&row.removed.includes(path)))add(path,`${role}:${field}:${i}`);
                found=true;
              }
              else {const entry=object(paths[i]);if(!entry||!collect(entry,`${role}:${field}:${i}`))throw new Error('unreadable-native-entry');found=true;}
            }
          }
          for(const field of ['edits','entries','changes'] as const){
            const entries=row[field];
            if(entries===undefined)continue;
            if(!Array.isArray(entries))throw new Error('unreadable-native-entry');
            for(let i=0;i<entries.length;i++){
              const entry=object(entries[i]);
              if(!entry)throw new Error('unreadable-native-entry');
              // Visit containers before allowing a pathless replacement to
              // inherit its parent's path. Nested malformed entries still fail.
              const collected=collect(entry,`${role}:${field}:${i}`);
              if(!collected&&!pathFields.some(field=>string(row[field])))throw new Error('unreadable-native-entry');
              found=true;
            }
          }
          const removed=row.removed;
          if(Array.isArray(removed))for(let i=0;i<removed.length;i++){const path=string(removed[i]);if(!path)throw new Error('unreadable-removal');add(path,`${role}:removed:${i}`,{op:'delete',followFinal:false});found=true;}
          return found;
        };
        const complete=collect(body,'input');
        // locations are additional native destinations, never a replacement
        // for a complete original patch or a capped summary's first paths.
        // Codex's normalized edit pairs original paths with placed display
        // paths in the same order. These are projections, including the old
        // referent of an unlink; they are not additional write destinations.
        const projectedPaths=event?.toolEngine==='codex'&&tool==='edit'&&Array.isArray(body.paths)?body.paths:undefined;
        const locations=event?.filePaths??[];
        const extractedPaths=new Set(effects.map(effect=>effect.path));
        for(let i=0;i<locations.length;i++){
          const path=locations[i];
          if(projectedPaths&&i<projectedPaths.length)continue;
          if(path&&!extractedPaths.has(path)){add(path,'native-location');extractedPaths.add(path);}
        }
        if(!complete)return {kind:'incomplete',reason:'missing-native-path'};
      }
    }
    return bind({kind:'native',effects,...(cwd!==undefined?{cwd}:{}),cwdInvalid},identity);
  }catch{return {kind:'incomplete',reason:'operation-input-integrity'};}
}
