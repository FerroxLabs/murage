// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The model picker's dialog-side rules (1.0.19, SETTINGS-ENGINES-1019 slice P):
// the order and zone ladder, the Engine control's families and keys, the Local
// rail, and the empty and count lines. Only the dialog draws them, so they load
// with ModelPickerDialog.tsx on the first open; the chip's own rules (rows,
// keys, its label and title) stay in provider-model-picker.ts with the first
// paint (first-paint.test.ts).
import { localEngineSupport } from "../../shared/local-models.ts";
import { LOCAL_MODELS_GROUP, type PickerEngine, type PickerModel } from "./provider-model-picker.ts";
/** Every row the Local rail owns, before any search filter: the rail's
 *  presence is a fact about this computer, not about what was typed. */
export function localPickerRows(rows: readonly PickerModel[]): PickerModel[] {
  return rows.filter((row) => row.group === LOCAL_MODELS_GROUP);
}
/** Whether the Local rail shows its "no local server" row for this engine.
 *  Only a local engine (spec E1/E3: a `tools` driver, whose catalog carries a
 *  `localServer` row once a server is detected) is told there is none.
 *  openai-compat runs tools on local rows too, but it is the engine for an
 *  endpoint the owner named, so its local rows are extras that appear once a
 *  server exists and an "add one" row would be noise in every cloud picker.
 *  Its Engines line already says it works with local models. A driver with
 *  no local support at all (grok API, gemini, cursor) has no rail. */
export function showNoLocalServerRow(engine: Pick<PickerEngine, "driverKind"> | null | undefined, rows: readonly PickerModel[]): boolean {
  if (!engine || localEngineSupport(engine.driverKind) !== "tools") return false;
  return localPickerRows(rows).length === 0;
}

/** "qwen3.8-27b · llama.cpp on a local box" (spec V3), whichever half the
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
/** What the engine control reads when nothing is selected, so it is never a
 *  blank box with no clue what it wants. It was the `<select>`'s first
 *  `<option>`; it is now the combobox's own text. */
export const CHOOSE_ENGINE_OPTION = "Choose an engine";
/** The line under the search box. "0 compatible chat models" is true and
 *  useless on a fresh profile: it counts a list the person was never given a
 *  way to fill. Each state says what to do next instead. */
export function pickerCountLine(engineChosen: boolean, count: number): string {
  if (!engineChosen) return "Pick an engine above to see the models it can run";
  if (count === 0) return "No models to choose here yet";
  return `${count} compatible chat model${count === 1 ? "" : "s"}`;
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
  // openai-compat lists every local model and still sends it tools, so a
  // failed test there says what still works rather than warning the row off.
  if (row.localTools === "failed") return row.anyModel ? "Tools test failed: this model still chats here, and tools may not work" : "Tools test failed: chat only, not usable for bot work";
  if (row.localTools === "partial") return "Tools test passed with gaps. See Settings → Models";
  return "";
}
/** Is this row served by Flux Router — either one of Murage's own `flux-*`
 *  routes on an engine, or any model reached through a Flux connection? Both
 *  spellings matter: `claude-opus-5` bought through Flux is a Flux row even
 *  though its id names Anthropic. */
export function isFluxRouterRow(row: Pick<PickerModel, "selection"|"provider">): boolean {
  return row.provider === "flux" || /^(?:flux::)?flux-/.test(row.selection.model);
}
/** The four Flux Router tiers, cheapest first. Auto routes across the other
 *  three per turn, so it leads; the rest follow in price order so the list
 *  reads as a ladder rather than an alphabet. */
export const FLUX_TIER_ORDER = Object.freeze(["flux-auto", "flux-fast", "flux-standard", "flux-reasoning"] as const);
function fluxTierIndex(row: Pick<PickerModel, "selection">): number {
  return (FLUX_TIER_ORDER as readonly string[]).indexOf(row.selection.model.replace(/^flux::/, ""));
}
export function isFluxTierRow(row: Pick<PickerModel, "selection">): boolean { return fluxTierIndex(row) >= 0; }
/** A Flux row that is not one of the four tiers: the pinned routes, and any
 *  model bought through a Flux connection under its own name. */
export function isFluxPinnedRow(row: Pick<PickerModel, "selection"|"provider">): boolean { return isFluxRouterRow(row) && !isFluxTierRow(row); }
const ENGINE_MODELS_GROUP = "Engine models";
/** Where a row's model comes from, as its second line says it. An engine
 *  reaches Flux Router's routes through its own catalog, so those rows carry
 *  the engine's "Engine models" group; printed under the "Flux Router"
 *  heading that read as if every tier were the engine's own model. A tier
 *  needs no source line (its heading is the source); a pinned route says Flux
 *  Router; everything else keeps its group. */
export function pickerRowSource(row: Pick<PickerModel, "selection"|"provider"|"group">): string {
  if (row.selection.connectionId || !isFluxRouterRow(row)) return row.group;
  return isFluxTierRow(row) ? "" : "Flux Router";
}
function isNativeEngineRow(row: PickerModel): boolean { return !row.selection.connectionId && row.group === ENGINE_MODELS_GROUP && !isFluxRouterRow(row); }
/** The picker's order. Flux Router leads every model list:
 *
 *   0  Flux Router tiers         Auto, Fast, Standard, Reasoning — in that
 *                                order, not alphabetically
 *   1  the user's favourites     a deliberate choice stays near the top; a
 *                                starred tier stays with the tiers
 *   2  the engine's own models   what this engine runs natively
 *   3  local and custom models   still the engine's own, grouped by kind
 *   4  Flux pinned models        specific models routed through Flux
 *   5  every other provider      grouped by connection
 *
 *  Within a rank: tier order for the tiers, otherwise group then label.
 *
 *  A tier the engine already offers natively is also listed by a Flux Router
 *  connection; that second copy is hidden, and the context size it carried
 *  moves onto the row that stays. The copy the user actually has selected is
 *  never hidden, so their checkmark cannot vanish.
 *
 *  Only when there is a single Flux connection. The native row bills the one
 *  Flux key Murage hands the engine, so with one connection both rows are the
 *  same model on the same account. A second Flux connection may hold a
 *  different account, and its tiers are then a real choice, not a copy. */
export function orderedPickerModels(rows: readonly PickerModel[], query: string, favorites: readonly string[], _recent: readonly string[], selectedKey?: string): PickerModel[] {
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean),seen=new Set<string>();
  const nativeTiers=new Map<number,PickerModel>();
  const fluxConnections=new Set(rows.filter(row=>row.provider==="flux"&&row.selection.connectionId).map(row=>row.selection.connectionId));
  if(fluxConnections.size<=1)for(const row of rows){const tier=fluxTierIndex(row);if(tier>=0&&!row.selection.connectionId&&!nativeTiers.has(tier))nativeTiers.set(tier,row);}
  const contextFor=new Map<string,number>();
  const kept=rows.filter(row=>{
    const tier=fluxTierIndex(row),native=tier>=0&&row.selection.connectionId?nativeTiers.get(tier):undefined;
    if(!native||row.key===selectedKey)return true;
    if(native.contextWindow===undefined&&row.contextWindow!==undefined&&!contextFor.has(native.key))contextFor.set(native.key,row.contextWindow);
    return false;
  }).map(row=>contextFor.has(row.key)?{...row,contextWindow:contextFor.get(row.key)}:row);
  const rank=(r:PickerModel)=>isFluxTierRow(r)?0:favorites.includes(r.key)?1:isNativeEngineRow(r)?2:!r.selection.connectionId&&!isFluxRouterRow(r)?3:isFluxPinnedRow(r)?4:5;
  return kept.filter(row=>{if(seen.has(row.key))return false;seen.add(row.key);return words.every(word=>`${row.label} ${row.selection.model} ${row.group} ${row.provider}`.toLowerCase().includes(word));}).sort((a,b)=>
    rank(a)-rank(b)||(rank(a)===0?fluxTierIndex(a)-fluxTierIndex(b)||(a.selection.connectionId?1:0)-(b.selection.connectionId?1:0):0)||a.group.localeCompare(b.group)||a.label.localeCompare(b.label));
}
export function engineFamilies<T extends PickerEngine>(instances: readonly T[]): Array<{ primary: T; members: T[] }> {
  const groups=new Map<string,T[]>(),seen=new Set<string>();
  for(const instance of instances){if(seen.has(instance.instanceId))continue;seen.add(instance.instanceId);const key=instance.driverKind;const group=groups.get(key)??[];group.push(instance);groups.set(key,group);}
  return [...groups.values()].map(members=>({primary:members.find(i=>i.instanceId===i.driverKind.replace(/Agent$/,""))??members.find(i=>i.enabled!==false&&i.snapshot.state==="available")??members[0]!,members}));
}
/** The heading one model row is drawn under, as an ordered ladder rather than
 *  a ternary chain — because it has to stay in step with the rank ladder in
 *  `orderedPickerModels`, and a chain buried in JSX is the shape that let them
 *  drift. A row matched by no zone falls back to its own group name.
 *
 *  The two ladders are a pair: `orderedPickerModels` decides the ORDER, this
 *  decides the HEADING over each run. If a rank exists with no zone of its
 *  own, its rows fall through to `row.group`, another rank's rows further down
 *  carry that same group, and the list prints one heading twice with a
 *  different heading between them — a name drawn twice, which is the whole
 *  reason this lane exists. `pickerHeadings` below is the guard.
 *
 *  Lives here, at the end of the file rather than beside `orderedPickerModels`,
 *  so this lane's additions stay clear of the concurrent metadata lane's hunks. */
export interface PickerZone { name: string; match: (row: PickerModel, favorites: readonly string[], recent: readonly string[]) => boolean }
export const PICKER_ZONES: readonly PickerZone[] = Object.freeze([
  // Mirrors the rank ladder in orderedPickerModels, rank for rank. Ranks 2, 3
  // and 5 are headed by their own group name (the engine's models, local or
  // custom models, each connection), so they need no zone here.
  { name: "Flux Router", match: row => isFluxTierRow(row) },
  { name: "Favorites", match: (row, favorites) => favorites.includes(row.key) },
  { name: "Flux pinned models", match: row => isFluxPinnedRow(row) },
]);
export function pickerZone(row: PickerModel, favorites: readonly string[], recent: readonly string[]): string {
  return PICKER_ZONES.find(zone => zone.match(row, favorites, recent))?.name ?? row.group;
}
/** The headings a drawn list prints, in order — the picker's own fold over the
 *  ordered rows, extracted so a test can read it without a DOM. A heading is
 *  drawn when the zone changes, so a repeated entry in this list means one
 *  heading was printed twice with something else in between. */
export function pickerHeadings(ordered: readonly PickerModel[], favorites: readonly string[], recent: readonly string[]): string[] {
  const headings: string[] = [];
  let previous = "";
  for (const row of ordered) { const zone = pickerZone(row, favorites, recent); if (zone !== previous) headings.push(zone); previous = zone; }
  return headings;
}
/** The suffix an engine the user switched off still carries, so "why can I not
 *  pick this" is answered in the list rather than in Settings. */
export const ENGINE_DISABLED_SUFFIX = " · Disabled";
/** One engine as the Engine control draws it: its own icon comes from
 *  `driverKind`, its name from `displayName`, and the disabled suffix is part
 *  of the label so the row's text reads the same as the old `<option>` did. */
export interface EngineChoice<T extends PickerEngine> { instance: T; label: string; disabled: boolean }
/** A family of engines sharing one driver. `header` is the empty string for a
 *  family of one.
 *
 *  Why: the Engine control used to wrap every family in an `<optgroup
 *  label={primary.displayName}>` whose single `<option>` carried that same
 *  displayName, so the normal case — one connection per driver — printed every
 *  engine's name twice ("Claude / Claude / Codex / Codex", Sean's screenshot,
 *  2026-09-18). A header only carries information when it groups more than one
 *  row, so only then is one emitted. */
export interface EngineMenuFamily<T extends PickerEngine> { key: string; header: string; options: Array<EngineChoice<T>> }
/** The one rule, for every surface that draws engine families: a family header
 *  is the family's name only when it groups more than one connection, and the
 *  empty string otherwise. `engineFamilies` picks `primary` out of `members`,
 *  so for a family of one the header and its only row are the same string and
 *  drawing both just prints the engine's name twice. */
export function engineFamilyHeader<T extends PickerEngine>(primary: T, members: readonly T[]): string {
  return members.length>1?primary.displayName:"";
}
export function engineMenuFamilies<T extends PickerEngine>(instances: readonly T[]): Array<EngineMenuFamily<T>> {
  return engineFamilies(instances).map(({primary,members})=>({
    key: primary.driverKind,
    header: engineFamilyHeader(primary,members),
    options: members.map(instance=>({instance,label:`${instance.displayName}${instance.enabled===false?ENGINE_DISABLED_SUFFIX:""}`,disabled:instance.enabled===false})),
  }));
}
/** Every selectable row of the Engine control, in the order it is drawn.
 *  Headers are not selectable, so arrow keys never land on one. */
export function engineMenuOptions<T extends PickerEngine>(instances: readonly T[]): Array<EngineChoice<T>> {
  return engineMenuFamilies(instances).flatMap(family=>family.options);
}
/** What one key press does to the Engine control, decided without a DOM so it
 *  can be tested and so the component stays a thin renderer. Wrapping matches
 *  the model rows below, whose own ArrowDown/ArrowUp handler wraps. */
export type EngineMenuKeyAction =
  | { type: "open"; index: number }
  | { type: "move"; index: number }
  | { type: "select"; index: number }
  | { type: "close" }
  | { type: "none" };
export function engineMenuKey(key: string, state: { open: boolean; index: number; count: number }): EngineMenuKeyAction {
  const{open,count}=state,index=Math.min(Math.max(state.index,0),Math.max(count-1,0));
  if(open&&(key==="Escape"||key==="Tab"))return{type:"close"};
  if(!count)return{type:"none"};
  if(!open){
    if(key==="ArrowDown"||key==="Enter"||key===" "||key==="Home")return{type:"open",index:key==="Home"?0:index};
    if(key==="ArrowUp"||key==="End")return{type:"open",index:key==="End"?count-1:index};
    return{type:"none"};
  }
  if(key==="ArrowDown")return{type:"move",index:(index+1)%count};
  if(key==="ArrowUp")return{type:"move",index:(index-1+count)%count};
  if(key==="Home")return{type:"move",index:0};
  if(key==="End")return{type:"move",index:count-1};
  if(key==="Enter"||key===" ")return{type:"select",index};
  return{type:"none"};
}
