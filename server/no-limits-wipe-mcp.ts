// SPDX-License-Identifier: AGPL-3.0-or-later
/** MCP schemas are hints about effects, never permission grants. Keep only
 * destructive/bulk booleans and exact tool names, not arbitrary descriptions. */
export interface McpWipeHint {tool:string;destructive:boolean;bulk:boolean}
const tokens=(value:string)=>value.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();
export const destructiveName=(name:string)=>! /^(?:list|get|read|search|fetch|describe|preview|count|check|validate)(?:[\W_]|$)/.test(tokens(name))&&/(?:^|[\W_])(?:delete|destroy|drop|purge|truncate|remove|empty)(?:$|[\W_])/.test(tokens(name));
export const bulkName=(name:string)=>/(?:^|[\W_])(?:bulk|batch|all|entire|everything|wipe)(?:$|[\W_])|empty[\W_]+trash/.test(tokens(name));
export function mcpSchemaWipeHints(tools:unknown[]):McpWipeHint[]{
 const hints:McpWipeHint[]=[];
 for(const value of tools){
  if(!value||typeof value!=='object')continue;
  const tool=value as Record<string,any>,annotations=tool.annotations;
  if(typeof tool.name!=='string'||tool.name.length>200)continue;
  const title=typeof annotations?.title==='string'?annotations.title:'';
  // destructiveHint also covers ordinary updates: only explicit deletion
  // wording is evidence for the narrow No limits wipe list.
  const destructive=destructiveName(tool.name)||destructiveName(title);
  if(destructive)hints.push({tool:tool.name,destructive:true,bulk:bulkName(tool.name)||bulkName(title)});
 }
 return hints;
}
const catalogs=new Map<string,Map<string,McpWipeHint>>();
const key=(thread:string,server:string)=>JSON.stringify([thread,server]);
export function recordMcpWipeHints(thread:string,server:string,tools:readonly McpWipeHint[],replace:boolean):boolean {
 if(tools.length>8192||tools.some(tool=>typeof tool.tool!=='string'||tool.tool.length>200||typeof tool.destructive!=='boolean'||typeof tool.bulk!=='boolean'))return false;
 const id=key(thread,server),catalog=replace?new Map<string,McpWipeHint>():new Map(catalogs.get(id));
 for(const hint of tools)catalog.set(hint.tool,Object.freeze({...hint}));
 if(catalog.size>8192)return false;
 catalogs.delete(id);catalogs.set(id,catalog);
 if(catalogs.size>4096)catalogs.delete(catalogs.keys().next().value!);
 return true;
}
export function mcpWipeHint(thread:string,server:string,tool:string):McpWipeHint|undefined{return catalogs.get(key(thread,server))?.get(tool);}

export function bulkMcpInput(input:Record<string,unknown>):boolean {
 return input.all===true||input.delete_all===true||typeof input.scope==='string'&&/^(?:all|entire|bulk|everything)$/i.test(input.scope)
  ||['ids','paths','files','items','records','targets'].some(field=>Array.isArray(input[field])&&(input[field] as unknown[]).length>20);
}
export function mcpBulkWipe(tool:string,input:Record<string,unknown>,hint?:McpWipeHint):boolean {
 const destructive=destructiveName(tool)||hint?.destructive===true;
 if(!destructive)return false;
 const container=/(?:delete|destroy|drop|purge)[\W_]+(?:workspace|project|database|table|schema|repo|repository|account|bucket|mailbox|drive|store|shop)s?$/.test(tokens(tool));
 return container||bulkName(tool)||hint?.bulk===true||bulkMcpInput(input);
}
