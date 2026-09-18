// Adapted from Wayland modelRowHelpers/useModelSelectorViewModel (Ferrox Labs,
// Apache-2.0): scoped identity, honest metadata and bounded grouped discovery.
import type { PublicProviderConnection, ProviderModel } from "../../shared/provider-connections.ts";
import { providerEngineProtocol } from "../../shared/provider-engine.ts";
import { localEngineSupport, localPickerModel } from "../../shared/local-models.ts";
import { resolveModelLabel } from "../../shared/model-label.ts";
import { fillModelMetadata, fluxRoutePriceLabel, modelMetadataUpdatedAt, providerHint } from "./model-metadata.ts";
export interface PickerSelection { instanceId: string; model: string; connectionId?: string }
export interface PickerEngine { instanceId: string; driverKind: string; displayName: string; enabled?: boolean; snapshot: {state: "available"|"unavailable"; authenticated?: boolean}; models: {default:string;options:Array<{id:string;label:string;custom?:boolean;provider?:string;localServer?:string;localTools?:"pass"|"partial"|"failed"}>} }
export interface PickerModel { key: string; selection: PickerSelection; label: string; group: string; provider: string; contextWindow?: number; pricing?: ProviderModel["pricing"]; stale?: boolean;
  /** What this model can do, from the provider's own catalog where it says,
   *  and otherwise from the bundled models.dev snapshot (src/lib/model-metadata.ts).
   *  Absent means "not stated" — never "cannot". */
  capabilities?: { vision?: boolean; tools?: boolean; reasoning?: boolean };
  /** Local models only (spec V3): the server serving this model, already in
   *  the form the picker shows ("llama.cpp on seanbeast"). */
  localServer?: string;
  /** Local models only (spec V3): outcome of the last tool test. `failed` is
   *  marked; absent means this model was never tested. */
  localTools?: "pass" | "partial" | "failed";
  /** Local models only: the engine never sends tools (openai-compat), so the
   *  tools test does not limit this row — it chats whatever the test said. */
  chatOnly?: true }
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
/** Dollars per million OUTPUT tokens, and the band each range earns.
 *
 *  Five tiers, not the three this shipped with (Sean, 2026-09-18). The old
 *  `<5 / <25 / else` collapsed Claude Sonnet, Opus and Fable into one "$$$",
 *  which is the distinction the band exists to draw: the scale has to run from
 *  "cheap" to "frontier-ridiculous", and the frontier has moved.
 *
 *  Output price is the metric because it is the one that tracks the frontier —
 *  input prices sit within a factor of a few of each other across the whole
 *  market, output prices span three orders of magnitude.
 *
 *  Verified against the bundled snapshot (src/lib/price-band.test.ts walks
 *  every priced model): DeepSeek V4 Flash 0.60 → $ · Claude Haiku 4.5 5 → $$ ·
 *  Grok 4.6 6 → $$ · Claude Sonnet 5 10 → $$$ · Claude Sonnet 4.6 15 → $$$ ·
 *  Claude Opus 5 25 → $$$$ · Claude Fable 5.1 50 → $$$$$ · o1-pro 600 → $$$$$. */
export const PRICE_BANDS: ReadonlyArray<{ below: number; band: string }> = Object.freeze([
  { below: 2, band: "$" },
  { below: 10, band: "$$" },
  { below: 20, band: "$$$" },
  { below: 40, band: "$$$$" },
  { below: Infinity, band: "$$$$$" },
]);
/** What a row says when no published rate could be resolved for it. An honest
 *  and expected answer (Sean, 2026-09-18: "if we don't know a price, it's
 *  unknown") — but it must not be mistaken for the cheap end of the scale, so
 *  it is a word rather than a symbol, and `isPriceUnknown` lets the row style
 *  it as the absence it is instead of as a band. */
export const PRICE_UNKNOWN = "Price unavailable";
export function priceBand(price: ProviderModel["pricing"]): string { const n=price?.outputPerMillion; if(typeof n!=="number"||!Number.isFinite(n)||n<0)return PRICE_UNKNOWN; return PRICE_BANDS.find(tier=>n<tier.below)!.band; }
/** Is this row's price cell the unknown state rather than a band or a range?
 *  For the picker to draw it differently — muted, not $-coloured. */
export function isPriceUnknown(row: Pick<PickerModel, "selection"|"pricing">): boolean { return modelPriceLabel(row)===PRICE_UNKNOWN; }
/** Published rates move constantly and a band is a snapshot of one day's
 *  prices, so the picker says so ONCE, under the list — not on every row
 *  (Sean: "not that I need to put a disclaimer on every fucking one"). Dated
 *  from the snapshot itself so it cannot quietly go stale. */
export function priceBandNote(updatedAt: number = modelMetadataUpdatedAt()): string {
  if(!Number.isFinite(updatedAt))return "Bands are approximate, from published rates";
  const when=new Date(updatedAt).toLocaleString(undefined,{month:"long",year:"numeric",timeZone:"UTC"});
  return `Bands are approximate, from published rates, ${when}`;
}
/** "$1 ≈ 20K output tokens" — the band in a unit anybody already owns an
 *  intuition for. Tooltip only: it is an arithmetic restatement of the exact
 *  rate that is already there, not a new claim, and it is rounded hard
 *  (two significant figures) so it never implies precision the published rate
 *  does not have. */
export function dollarOfTokens(price: ProviderModel["pricing"]): string {
  const n=price?.outputPerMillion;
  if(typeof n!=="number"||!Number.isFinite(n)||n<=0)return "";
  // Two significant figures, then the unit. "$1 ≈ 1.7K" and "$1 ≈ 20K" both
  // say as much as a published rate can support; "$1 ≈ 1,666.67" would be
  // arithmetic theatre on a number that changes without notice.
  const tokens=1_000_000/n;
  const magnitude=10**(Math.floor(Math.log10(tokens))-1);
  const rounded=Math.round(tokens/magnitude)*magnitude;
  const scale=rounded>=1_000_000?[1_000_000,"M"] as const:rounded>=1000?[1000,"K"] as const:[1,""] as const;
  const value=rounded/scale[0];
  return `$1 ≈ ${value<10&&!Number.isInteger(value)?value.toFixed(1):String(Math.round(value))}${scale[1]} output tokens`;
}
/** What one row's price cell says — the coarse band and nothing more (Sean,
 *  2026-09-18: no per-million figures and no per-task estimate in the row).
 *  The exact input/output numbers stay in the row's tooltip, which is what
 *  keeps the band honest: anyone can see the real figure behind it.
 *
 *  A Flux route is the one row a single band cannot describe: `flux-auto`
 *  dispatches across tiers, so it reads as their span ("$–$$$"). See
 *  FLUX_TIER_BANDS in ./model-metadata.ts for where those four bands come
 *  from and why they are labelled differently from every other number here.
 *  `flux-pinned-*` is NOT a route: it names one model, resolves through the
 *  snapshot, and gets a real band. */
export function modelPriceLabel(row: Pick<PickerModel, "selection"|"pricing">): string {
  return fluxRoutePriceLabel(row.selection.model) || priceBand(row.pricing);
}
/** Join the server's initial Flux fetch when the picker beats startup discovery.
 * Failed catalogs wait for the existing scheduled deadline or explicit Refresh. */
export function pickerConnectionsToRefresh(connections: readonly PublicProviderConnection[], force: boolean): PublicProviderConnection[] {
  return connections.filter(connection => connection.enabled && connection.configured &&
    (force || (connection.preset === "flux" && !connection.catalog.fetchedAt && connection.catalog.models.length === 0 && !connection.catalog.error)));
}
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
      const row:PickerModel={key:pickerKey(selection),selection,label:resolveModelLabel(option.id,{catalogLabel:option.label}),group:option.localServer?LOCAL_MODELS_GROUP:option.custom?CUSTOM_MODELS_GROUP:"Engine models",provider:option.provider??option.localServer??instance.displayName,contextWindow:metadata.contextWindow,...(option.localServer?{localServer:option.localServer}:{}),...(option.localTools?{localTools:option.localTools}:{}),...(option.localServer&&localEngineSupport(instance.driverKind)==="chat-only"?{chatOnly:true as const}:{})};
      // A local model runs on this computer and costs nothing per token, so a
      // cloud price would be a lie about the user's own hardware — local rows
      // are left exactly as their server described them.
      rows.push(option.localServer?row:fillModelMetadata(row,option.id,providerHint(undefined,option.provider)));
    }
  }
  if(installed||["grok","openai-compat"].includes(instance.driverKind))for(const connection of connections){
    if(!connection.enabled||!connection.configured||!providerEngineProtocol(instance.driverKind,connection.preset,connection.protocol))continue;
    for(const model of connection.catalog.models){
      if(!model.enabled||!model.chatEligible||model.capabilities.chat!==true||!model.outputModalities.some(m=>m==="text"||m==="chat"))continue;
      const selection={instanceId:instance.instanceId,connectionId:connection.id,model:model.id};
      const row:PickerModel={key:pickerKey(selection),selection,label:resolveModelLabel(model.id,{catalogLabel:model.label}),group:connection.label,provider:connection.preset,contextWindow:model.contextWindow,...(model.pricing?{pricing:model.pricing}:{}),stale:connection.catalog.stale,
        ...(model.capabilities.vision===undefined&&model.capabilities.tools===undefined&&model.capabilities.reasoning===undefined?{}:{capabilities:{...(model.capabilities.vision===undefined?{}:{vision:model.capabilities.vision}),...(model.capabilities.tools===undefined?{}:{tools:model.capabilities.tools}),...(model.capabilities.reasoning===undefined?{}:{reasoning:model.capabilities.reasoning})}})};
      rows.push(fillModelMetadata(row,model.id,providerHint(connection.preset,undefined)));
    }
  }
  return rows;
}
/** Every row the Local rail owns, before any search filter: the rail's
 *  presence is a fact about this computer, not about what was typed. */
export function localPickerRows(rows: readonly PickerModel[]): PickerModel[] {
  return rows.filter((row) => row.group === LOCAL_MODELS_GROUP);
}
/** Whether the Local rail shows its "no local server" row for this engine.
 *  Only an engine the Local models section actually feeds (spec E1/E3: a
 *  `tools` driver, whose catalog carries a `localServer` row once a server is
 *  detected) can be told there is none. A chat-only driver is not primarily a
 *  local engine: grok never receives local rows and openai-compat only lists
 *  them as chat-only extras once a server exists — its Engines line already
 *  says "chat only (no tools)" — so the row would be a false nudge there; a
 *  driver with no local support at all (gemini, cursor) has no rail. */
export function showNoLocalServerRow(engine: Pick<PickerEngine, "driverKind"> | null | undefined, rows: readonly PickerModel[]): boolean {
  if (!engine || localEngineSupport(engine.driverKind) !== "tools") return false;
  return localPickerRows(rows).length === 0;
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
  // A fresh profile has no selection at all (server/index.ts defaultSelection
  // returns {instanceId:"",model:""} rather than pinning a bot to an engine
  // that cannot answer). The raw "" used to reach the chip and the tooltip,
  // which rendered as "Unavailable engine · " — a dangling separator that told
  // a brand-new user nothing except that something was broken.
  if (!model.trim()) return NO_MODEL_CHOSEN;
  const local = localPickerModel(model);
  return local ? `${local.model} · local server unavailable` : model;
}
/** What the chip says before anything is set up. */
export const NO_MODEL_CHOSEN = "No model chosen";
/** The first row of the engine `<select>` when nothing is selected, so the
 *  control is never a blank box with no clue what it wants. */
export const CHOOSE_ENGINE_OPTION = "Choose an engine";
/** The chip's tooltip / aria-label. Every part is optional and the separator
 *  is joined, never concatenated, so a missing part can never leave a
 *  dangling " · ". */
export function pickerTriggerTitle(
  engineName: string | undefined,
  selectedLabel: string,
  connectionLabel?: string,
): string {
  if (!engineName && selectedLabel === NO_MODEL_CHOSEN) return "No model chosen yet — open this to pick one";
  return [engineName ?? "Unavailable engine", selectedLabel, connectionLabel].filter(Boolean).join(" · ");
}
/** The line under the search box. "0 compatible chat models" is true and
 *  useless on a fresh profile: it counts a list the person was never given a
 *  way to fill. Each state says what to do next instead. */
export function pickerCountLine(engineChosen: boolean, count: number): string {
  if (!engineChosen) return "Pick an engine above to see the models it can run";
  if (count === 0) return "No models to choose here yet";
  return `${count} compatible chat model${count === 1 ? "" : "s"} · prices per million tokens`;
}
/** The body of the list when it has nothing in it. `null` means the caller's
 *  own branches (engine setup card, "no matching…") own this state. */
export function pickerEmptyState(
  engineChosen: boolean,
  hasQuery: boolean,
): { title: string; body: string; action: string; localAction: string } | null {
  if (engineChosen || hasQuery) return null;
  return {
    title: "No engine set up yet",
    body: "An engine is the program that answers your messages. Set one up and its models appear here.",
    action: "Set up an engine",
    // The Local rail's own row needs an engine to be truthful about detection
    // (showNoLocalServerRow), so on a fresh profile it goes quiet — which used
    // to hide the fastest route to a working app from the only person who
    // needed it. This offer claims nothing about what is running; it just
    // opens the same screen that row opens.
    localAction: "Use a model on this computer",
  };
}
/** The picker's warning marker, in plain words. Empty when there is nothing to
 *  warn about — an untested model is not accused of anything. */
export function localToolsWarning(row: PickerModel): string {
  if (row.chatOnly) return "Chat only — this engine sends no tools, so it can chat with any model";
  if (row.localTools === "failed") return "Tools test failed — chat only, not usable for agent work";
  if (row.localTools === "partial") return "Tools test passed with gaps — see Settings → Models";
  return "";
}
/** Is this row served by Flux Router — either one of Murage's own `flux-*`
 *  routes on an engine, or any model reached through a Flux connection? Both
 *  spellings matter: `claude-opus-5` bought through Flux is a Flux row even
 *  though its id names Anthropic. */
export function isFluxRouterRow(row: Pick<PickerModel, "selection"|"provider">): boolean {
  return row.provider === "flux" || /^(?:flux::)?flux-/.test(row.selection.model);
}
/** The picker's order (Sean, 2026-09-18 — Flux Router leads every model list).
 *
 *   0  Flux Auto                the recommended default; already rank 0 before
 *                               this change, and still the single first row
 *   1  the user's favourites    an explicit choice outranks a promotion: a
 *                               starred model is never demoted by this rule
 *   2  every other Flux Router  the tiers, the pinned routes, and anything
 *      row                      bought through a Flux connection
 *   3  recently used            below Flux on purpose. A recent is an
 *                               incidental signal (it is what you happened to
 *                               run last), where a star is a deliberate one;
 *                               this is the one place where the promotion
 *                               costs a non-Flux row a position, and it is
 *                               stated rather than hidden
 *   4  everything else
 *
 *  Within a rank the previous tie-breaks stand: group name, then label. */
export function orderedPickerModels(rows: readonly PickerModel[], query: string, favorites: readonly string[], recent: readonly string[]): PickerModel[] {
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean),seen=new Set<string>();
  return rows.filter(row=>{if(seen.has(row.key))return false;seen.add(row.key);return words.every(word=>`${row.label} ${row.selection.model} ${row.group} ${row.provider}`.toLowerCase().includes(word));}).sort((a,b)=>{
    const rank=(r:PickerModel)=>/^(?:flux::)?flux-auto$/.test(r.selection.model)?0:favorites.includes(r.key)?1:isFluxRouterRow(r)?2:recent.includes(r.key)?3:4;
    return rank(a)-rank(b)||a.group.localeCompare(b.group)||a.label.localeCompare(b.label);
  });
}
export function engineFamilies<T extends PickerEngine>(instances: readonly T[]): Array<{ primary: T; members: T[] }> {
  const groups=new Map<string,T[]>(),seen=new Set<string>();
  for(const instance of instances){if(seen.has(instance.instanceId))continue;seen.add(instance.instanceId);const key=instance.driverKind;const group=groups.get(key)??[];group.push(instance);groups.set(key,group);}
  return [...groups.values()].map(members=>({primary:members.find(i=>i.instanceId===i.driverKind.replace(/Agent$/,""))??members.find(i=>i.enabled!==false&&i.snapshot.state==="available")??members[0]!,members}));
}
