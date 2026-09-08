// Adapted from Wayland modelRowHelpers/useModelSelectorViewModel (Ferrox Labs,
// Apache-2.0): scoped identity, honest metadata and bounded grouped discovery.
import type { PublicProviderConnection, ProviderModel } from "../../shared/provider-connections.ts";
import { providerEngineProtocol } from "../../shared/provider-engine.ts";
export interface PickerSelection { instanceId: string; model: string; connectionId?: string }
export interface PickerEngine { instanceId: string; driverKind: string; displayName: string; enabled?: boolean; snapshot: {state: "available"|"unavailable"; authenticated?: boolean}; models: {default:string;options:Array<{id:string;label:string;custom?:boolean;provider?:string}>} }
export interface PickerModel { key: string; selection: PickerSelection; label: string; group: string; provider: string; contextWindow?: number; pricing?: ProviderModel["pricing"]; stale?: boolean }
export const pickerKey = (s: PickerSelection): string => JSON.stringify([s.instanceId, s.connectionId ?? null, s.model]);
export function priceBand(price: ProviderModel["pricing"]): string { const n=price?.outputPerMillion; return typeof n==="number"&&Number.isFinite(n)&&n>=0?n<5?"$":n<25?"$$":"$$$":"Price unavailable"; }
export function contextLabel(value: unknown): string { return typeof value==="number"&&Number.isFinite(value)&&value>0?`${Math.round(value/1000)}K context`:""; }
export function pickerModels(instance: PickerEngine, connections: readonly PublicProviderConnection[]): PickerModel[] {
  const rows: PickerModel[]=[];
  if(instance.enabled===false)return rows;
  const installed=instance.snapshot.state==="available";
  if(installed){
    for(const option of instance.models.options){
      if(/(?:^|[\/_-])(image|video|audio|embedding|whisper|tts)(?:$|[\/_-])|dall-e|veo-/i.test(option.id))continue;
      if(instance.snapshot.authenticated===false&&!option.custom)continue;
      const selection={instanceId:instance.instanceId,model:option.id};
      const metadata=option as typeof option&{contextWindow?:number};
      rows.push({key:pickerKey(selection),selection,label:option.label,group:option.custom?"Local models":"Engine models",provider:option.provider??instance.displayName,contextWindow:metadata.contextWindow});
    }
  }
  if(installed||["grok","openai-compat"].includes(instance.driverKind))for(const connection of connections){
    if(!connection.enabled||!connection.configured||!providerEngineProtocol(instance.driverKind,connection.preset,connection.protocol))continue;
    for(const model of connection.catalog.models){
      if(!model.enabled||!model.chatEligible||model.capabilities.chat!==true||!model.outputModalities.some(m=>m==="text"||m==="chat"))continue;
      const selection={instanceId:instance.instanceId,connectionId:connection.id,model:model.id};
      rows.push({key:pickerKey(selection),selection,label:model.label,group:connection.label,provider:connection.preset,contextWindow:model.contextWindow,pricing:model.pricing,stale:connection.catalog.stale});
    }
  }
  return rows;
}
export function orderedPickerModels(rows: readonly PickerModel[], query: string, favorites: readonly string[], recent: readonly string[]): PickerModel[] {
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean),seen=new Set<string>();
  return rows.filter(row=>{if(seen.has(row.key))return false;seen.add(row.key);return words.every(word=>`${row.label} ${row.selection.model} ${row.group} ${row.provider}`.toLowerCase().includes(word));}).sort((a,b)=>{
    const rank=(r:PickerModel)=>/^(?:flux::)?flux-auto$/.test(r.selection.model)?0:favorites.includes(r.key)?1:recent.includes(r.key)?2:3;
    return rank(a)-rank(b)||a.group.localeCompare(b.group)||a.label.localeCompare(b.label);
  });
}
export function engineFamilies<T extends PickerEngine>(instances: readonly T[]): Array<{ primary: T; members: T[] }> {
  const groups=new Map<string,T[]>(),seen=new Set<string>();
  for(const instance of instances){if(seen.has(instance.instanceId))continue;seen.add(instance.instanceId);const key=instance.driverKind;const group=groups.get(key)??[];group.push(instance);groups.set(key,group);}
  return [...groups.values()].map(members=>({primary:members.find(i=>i.instanceId===i.driverKind.replace(/Agent$/,""))??members.find(i=>i.enabled!==false&&i.snapshot.state==="available")??members[0]!,members}));
}
