// SPDX-License-Identifier: AGPL-3.0-or-later
/** MCP schemas are hints about effects, never permission grants. Keep only
 * destructive/bulk booleans and exact tool names, not arbitrary descriptions. */
export interface McpWipeHint {tool:string;destructive:boolean;bulk:boolean}
const tokens=(value:string)=>value.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();
export const destructiveName=(name:string)=>! /^(?:list|get|read|search|fetch|describe|preview|count|check|validate)(?:[\W_]|$)/.test(tokens(name))&&/(?:^|[\W_])(?:delete|destroy|drop|purge|truncate|remove|empty)(?:$|[\W_])/.test(tokens(name));
export const bulkName=(name:string)=>/(?:^|[\W_])(?:bulk|batch|all|entire|everything|wipe)(?:$|[\W_])|empty[\W_]+trash/.test(tokens(name));
const containerName=(name:string)=>/(?:delete|destroy|drop|purge)[\W_]+(?:workspace|project|database|table|schema|repo|repository|account|bucket|mailbox|drive|store|shop)s?$/.test(tokens(name));
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
  if(destructive)hints.push({tool:tool.name,destructive:true,bulk:bulkName(tool.name)||bulkName(title)||containerName(tool.name)||containerName(title)});
 }
 return hints;
}
const catalogs=new Map<string,Map<string,Map<string,McpWipeHint>>>();
export function retireMcpWipeThread(thread:string):void {catalogs.delete(thread);}
export function retireMcpWipeServer(server:string):void {
 for(const [thread,servers]of catalogs){servers.delete(server);if(!servers.size)catalogs.delete(thread);}
}
export function recordMcpWipeHints(thread:string,server:string,tools:readonly McpWipeHint[],replace:boolean):boolean {
 if(tools.length>8192||tools.some(tool=>typeof tool.tool!=='string'||tool.tool.length>200||typeof tool.destructive!=='boolean'||typeof tool.bulk!=='boolean'))return false;
 const servers=catalogs.get(thread)??new Map<string,Map<string,McpWipeHint>>();
 const catalog=replace?new Map<string,McpWipeHint>():new Map(servers.get(server));
 for(const hint of tools)catalog.set(hint.tool,Object.freeze({...hint}));
 if(catalog.size>8192)return false;
 // Empty replacement is explicit disposal; unrelated live catalogs never evict.
 if(catalog.size)servers.set(server,catalog);else servers.delete(server);
 if(servers.size)catalogs.set(thread,servers);else catalogs.delete(thread);
 return true;
}
export function mcpWipeHint(thread:string,server:string,tool:string):McpWipeHint|undefined{return catalogs.get(thread)?.get(server)?.get(tool);}

export function bulkMcpInput(input:Record<string,unknown>):boolean {
 return input.all===true||input.delete_all===true||typeof input.scope==='string'&&/^(?:all|entire|bulk|everything)$/i.test(input.scope)
  ||['ids','paths','files','items','records','targets'].some(field=>Array.isArray(input[field])&&(input[field] as unknown[]).length>20);
}
export function mcpBulkWipe(tool:string,input:Record<string,unknown>,hint?:McpWipeHint):boolean {
 const destructive=destructiveName(tool)||hint?.destructive===true;
 if(!destructive)return false;
 const container=containerName(tool);
 return container||bulkName(tool)||hint?.bulk===true||bulkMcpInput(input);
}
