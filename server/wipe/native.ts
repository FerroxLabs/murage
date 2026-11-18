// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NativeEffect } from '../no-limits-fs.ts';
import { known, type Value, type WipeEffect } from './types.ts';
export function fromNativeEffects(effects:readonly NativeEffect[],device:(value:Value)=>boolean=()=>false):WipeEffect[] {
 return effects.flatMap((effect):WipeEffect[]=>{
  if(effect.operandId==='native:grant-root')return [];
  if(effect.op==='delete'&&effect.operandId?.endsWith(':remove-source'))return [{k:'move-away',source:known(effect.path),follow:effect.followFinal}];
  if(effect.op==='delete')return [{k:'delete',target:known(effect.path),recursive:effect.recursive??'unknown',follow:effect.followFinal}];
  if(effect.op==='rename')return effect.source?[{k:'move-away',source:known(effect.source),follow:effect.sourceFollowFinal??effect.followFinal}]:[];
  return [{k:device(known(effect.path))?'device-write':'write',target:known(effect.path)}];
 });
}
export function fromNativeInput(tool:string,input:unknown,filePaths?:readonly string[],device:(value:Value)=>boolean=()=>false):WipeEffect[] {
 const bare=tool.split('__').at(-1)!.toLowerCase();
 const del=/^(?:delete|remove|wipe|unlink|rm|purge|trash|erase|destroy|empty|clean|clear)(?:_?(?:files?|director(?:y|ies)|folders?|dirs?|tree))?$|^(?:rmtree|rmdir)$/.test(bare);
 const move=/^(?:move|rename)(?:_?(?:files?|director(?:y|ies)|folders?|dirs?|tree))?$/.test(bare);
 const write=/^(?:write|edit|multiedit|multi_edit|notebookedit|notebook_edit|create)(?:_?(?:files?|director(?:y|ies)|folders?|dirs?))?$/.test(bare);
 const destructive=/^(?:delete|remove|wipe|unlink|rm|rmdir|rmtree|purge|trash|erase|destroy|empty|clean|clear)(?:_|$)/.test(bare);
 if(!del&&!destructive&&!move&&!write)return [];
 const effects:WipeEffect[]=[],seen=new Set<object>();
  const fields=['path','file_path','filePath','filename','directory','dir','root','target','source','source_path','old_path','src','from'];
 const add=(path:string,recursive:boolean|'unknown')=>{
  if(move)effects.push({k:'move-away',source:known(path)});
  else if(del||destructive)effects.push({k:'delete',target:known(path),recursive,follow:false});
  else effects.push({k:device(known(path))?'device-write':'write',target:known(path)});
 };
 const visit=(input:unknown)=>{
  const stack:{value?:unknown;path?:string;recursive:boolean|'unknown'}[]=[{value:input,recursive:'unknown'}];
  while(stack.length){
   const next=stack.pop()!;if(next.path!==undefined){add(next.path,next.recursive);continue;}
   const value=next.value;if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);
   const row=value as Record<string,unknown>,recursive=typeof row.recursive==='boolean'?row.recursive:next.recursive;
   if(move){const source=row.source??row.source_path??row.old_path??row.src??row.from??(row.destination||row.dest||row.new_path?row.path:undefined);if(typeof source==='string')add(source,recursive);}
   else for(const field of fields)if(typeof row[field]==='string')add(row[field],recursive);
   for(const field of ['entries','edits','files','paths'])if(Array.isArray(row[field]))for(let i=row[field].length-1;i>=0;i--){const entry=row[field][i];stack.push(typeof entry==='string'?{path:entry,recursive}:{value:entry,recursive});}
  }
 };
 visit(input);
 if(!effects.length&&filePaths?.length)visit({paths:filePaths});
 return effects;
}
