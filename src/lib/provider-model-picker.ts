// Adapted from Wayland modelRowHelpers/useModelSelectorViewModel (Ferrox Labs,
// Apache-2.0): scoped identity, honest metadata and bounded grouped discovery.
import type { PublicProviderConnection, ProviderModel } from "../../shared/provider-connections.ts";
import { providerEngineProtocol } from "../../shared/provider-engine.ts";
import { localPickerModel } from "../../shared/local-models.ts";
export interface PickerSelection { instanceId: string; model: string; connectionId?: string }
export interface PickerEngine { instanceId: string; driverKind: string; displayName: string; enabled?: boolean; snapshot: {state: "available"|"unavailable"; authenticated?: boolean}; models: {default:string;options:Array<{id:string;label:string;custom?:boolean;provider?:string;localServer?:string;localTools?:"pass"|"partial"|"failed"}>} }
export interface PickerModel { key: string; selection: PickerSelection; label: string; group: string; provider: string; contextWindow?: number; pricing?: ProviderModel["pricing"]; stale?: boolean;
  /** Local models only (spec V3): the server serving this model, already in
   *  the form the picker shows ("llama.cpp on seanbeast"). */
  localServer?: string;
  /** Local models only (spec V3): outcome of the last tool test. `failed` is
   *  marked; absent means this model was never tested. */
  localTools?: "pass" | "partial" | "failed" }
/** The one name this feature has, everywhere (spec UX rule). Only a row that
 *  names its server belongs here: a custom row an engine carries for a cloud
 *  provider (Pi's groq rows, openai-compat's OpenRouter defaults) is not a
 *  local model, and listing it under this name would both mislabel it and
 *  hide the rail's "no local server" state behind it. */
export const LOCAL_MODELS_GROUP = "Local models";
/** Custom rows that are not local: an engine's own extra entries. */
export const CUSTOM_MODELS_GROUP = "Custom models";
/** The Local rail's single row when this computer has no local server at all
 *  — a state the user can act on instead of an absence they must notice. */
export const NO_LOCAL_SERVER_ROW = "No local server detected — add one in Settings → Models";
export const pickerKey = (s: PickerSelection): string => JSON.stringify([s.instanceId, s.connectionId ?? null, s.model]);
export function priceBand(price: ProviderModel["pricing"]): string { const n=price?.outputPerMillion; return typeof n==="number"&&Number.isFinite(n)&&n>=0?n<5?"$":n<25?"$$":"$$$":"Price unavailable"; }
/** "64K context" for a 65536-token window and "200K context" for 200000: a
 *  power-of-two window is what a local server reports (`-c 65536`), and it
 *  must read the same here as on the Local models card that showed it. */
/** A local server reports a power-of-two window (65536 -> "64K"); cloud catalogs report decimal ones (128000 -> "128K"). Only a power of two is a binary K. */
export function contextK(value: number): string { const unit=value>=1024&&(value&(value-1))===0?1024:1000;return `${Math.round(value/unit)}K`; }
export function contextLabel(value: unknown): string { if(typeof value!=="number"||!Number.isFinite(value)||value<=0)return "";return `${contextK(value)} context`; }
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
      rows.push({key:pickerKey(selection),selection,label:option.label,group:option.localServer?LOCAL_MODELS_GROUP:option.custom?CUSTOM_MODELS_GROUP:"Engine models",provider:option.provider??option.localServer??instance.displayName,contextWindow:metadata.contextWindow,...(option.localServer?{localServer:option.localServer}:{}),...(option.localTools?{localTools:option.localTools}:{})});
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
/** Every row the Local rail owns, before any search filter: the rail's
 *  presence is a fact about this computer, not about what was typed. */
export function localPickerRows(rows: readonly PickerModel[]): PickerModel[] {
  return rows.filter((row) => row.group === LOCAL_MODELS_GROUP);
}
/** "qwen3.8-27b · llama.cpp on seanbeast" (spec V3), whichever half the
 *  engine's own catalog supplied. */
export function localRowLabel(row: PickerModel): string {
  if (!row.localServer) return row.label;
  return row.label.includes(row.localServer) ? row.label : `${row.label} · ${row.localServer}`;
}
/** The second line of a local row. The first line already names the server,
 *  so this one says what the tool test found — the thing that decides whether
 *  the pick will work for an agent. A failed test is left to the warning. */
export function localRowNote(row: PickerModel): string {
  if (!row.localServer) return "";
  if (row.localTools === "pass") return "Tools work";
  if (row.localTools === "partial") return "Tools work, with gaps";
  if (row.localTools === "failed") return "";
  return "Not tested yet";
}
/** What the bot's model chip says when the chosen model is in no catalog any
 *  more. A local pick keeps its `host::model` id after its server is removed
 *  or stops answering; the raw id is not a name anyone chose, so the chip
 *  says the model and the fact instead, until another model is picked. */
export function unavailableSelectionLabel(model: string): string {
  const local = localPickerModel(model);
  return local ? `${local.model} · local server unavailable` : model;
}
/** The picker's warning marker, in plain words. Empty when there is nothing to
 *  warn about — an untested model is not accused of anything. */
export function localToolsWarning(row: PickerModel): string {
  if (row.localTools === "failed") return "Tools test failed — chat only, not usable for agent work";
  if (row.localTools === "partial") return "Tools test passed with gaps — see Settings → Models";
  return "";
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
