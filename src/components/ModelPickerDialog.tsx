// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The model picker's dialog: the Engine control, the search, the notices, the
// grouped rows and the doors to Settings (1.0.19, SETTINGS-ENGINES-1019 slice P).
// ModelPicker.tsx draws the chip with the first paint and owns every piece of
// state; this module is fetched with import() on the first open
// (first-paint.test.ts), so the dialog's code and its words (the lazy English
// Settings pack, settings-copy.ts) never cost the first paint.
import {ModelRouteRow} from "./ModelRouteRow";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type Ref, type RefObject, type SetStateAction } from "react";
import { picturesElsewhereHint } from "@/lib/picture-hint";
import { computerEngineNote, engineSwitchLines } from "../../shared/engine-switch";
import { Check, ChevronDown, Search, Star, RefreshCw, AlertTriangle, Eye, Wrench } from "lucide-react";
import { useLayerOwner } from "./LayerSlot";
import { popoverMaxHeight, popoverViewportOffset, usePopoverClamp } from "@/lib/popover-clamp";
import { canHandleLayerEscape } from "@/lib/focus-trap";
import { useStore, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { PublicProviderConnection } from "../../shared/provider-connections";
import { modelMetadataReady } from "@/lib/model-metadata";
import { modelPriceLabel, isPriceUnknown, isPricePending, dollarOfTokens, priceBandNote, PRICE_UNKNOWN, contextLabel, LOCAL_MODELS_GROUP, NO_LOCAL_SERVER_ROW, type PickerEngine, type PickerModel } from "@/lib/provider-model-picker";
import { orderedPickerModels, engineMenuFamilies, engineMenuKey, pickerZone, ENGINE_DISABLED_SUFFIX, type EngineMenuFamily, showNoLocalServerRow, localRowLabel, localRowNote, localToolsWarning, CHOOSE_ENGINE_OPTION, pickerCountLine, pickerEmptyState, pickerRowSource } from "@/lib/provider-model-picker-dialog";
import { signInPickerNote } from "@/lib/model-signin-picker";
import { InstanceProviderMark } from "./ProviderIcons";
import { EngineSetup, needsCli } from "./EngineSetup";
import { cn } from "@/lib/cn";
import { effortLabel } from "@/lib/effort-label";
import { t } from "@/lib/i18n";
import "@/lib/settings-copy";
/** The two notices, apart: the catalog's alert and the fleet's secondary line.
 * Neither replaces the list. Exported so a test without a DOM can render it. */
export function ModelPickerNotices({error,fleetError}:{error:string;fleetError:string}){
  return <>{error&&<div role="alert" className="px-3 py-2 text-xs text-danger">{error}</div>}{fleetError&&<div role="status" data-model-picker-fleet-error className="px-3 py-2 text-xs text-warning">{fleetError}</div>}</>;
}
/** The one plain line under the engine list on a Cloud home (empty on the desktop, so nothing draws). */
export function EngineListNote({note,localOnly=[]}:{note:string;localOnly?:readonly string[]}){
  // On a Cloud home, Cline and Copilot are a state line, never a pickable engine: they run only on the person's computer.
  return note||localOnly.length?<>{note&&<div role="note" data-engine-cloud-note className="px-3 pb-2 text-xs text-ink-secondary">{note}</div>}{localOnly.map(engine=><div key={engine} role="note" data-engine-local-only={engine} className="px-3 pb-2 text-xs text-ink-secondary">{t("engines.cloud.localOnly",{engine})}</div>)}</>:null;
}
/** The Engine control's drawn rows. Exported so a test without a DOM can render
 *  them: the two things that were wrong here are what the markup says, not what
 *  the browser does with it.
 *
 *  A native `<select>` cannot draw an icon, so every engine in this list used to
 *  be a bare string while the picker's own trigger button showed the engine's
 *  ProviderMark — the same mark, two feet away. Each row now carries it.
 *  A family header is drawn only for a family that groups more than one
 *  connection (`EngineMenuFamily.header`), so the single-connection case — the
 *  normal one — no longer prints the engine's name as a header and then again
 *  as its only row. */
export function EngineOptionRows<T extends PickerEngine>({id,labelId,families,selectedId,activeIndex,onPick,listRef,maxHeight}:{id:string;labelId:string;families:ReadonlyArray<EngineMenuFamily<T>>;selectedId?:string;activeIndex:number;onPick:(index:number)=>void;listRef?:Ref<HTMLDivElement>;maxHeight?:number}){
  let cursor=0;
  return <div ref={listRef} id={id} role="listbox" aria-labelledby={labelId} data-engine-list style={maxHeight?{maxHeight}:undefined} className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[min(280px,40dvh)] overflow-y-auto rounded-xl border border-hairline/50 bg-card p-1 shadow-2xl">
    {families.map(family=>{
      const start=cursor;cursor+=family.options.length;
      const rows=family.options.map((option,offset)=>{const index=start+offset,current=option.instance.instanceId===selectedId;return <button key={option.instance.instanceId} type="button" data-engine-choice role="option" aria-selected={current} tabIndex={index===activeIndex?0:-1} onClick={()=>onPick(index)} title={option.label} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink outline-none hover:bg-control/60 focus-visible:ring-2 focus-visible:ring-accent">
        <span data-engine-icon className="shrink-0"><InstanceProviderMark instance={option.instance} size={14}/></span>
        <span className="min-w-0 flex-1 truncate">{option.instance.displayName}{option.disabled&&<span className="text-ink-secondary">{ENGINE_DISABLED_SUFFIX}</span>}</span>
        {current&&<Check size={14} className="shrink-0 text-accent"/>}
      </button>;});
      return family.header
        ?<div key={family.key} role="group" aria-labelledby={`${id}-${family.key}`}><div id={`${id}-${family.key}`} data-engine-family-header className="px-2 pb-1 pt-2 text-[11px] font-medium text-ink-secondary">{family.header}</div>{rows}</div>
        :<Fragment key={family.key}>{rows}</Fragment>;
    })}
  </div>;
}
/** The Engine control: the ARIA select-only combobox pattern, in place of the
 *  native `<select>` it replaces. The `<select>` gave keyboard operation and a
 *  name for free, so both are rebuilt here rather than assumed — arrow/Home/End
 *  to move, Enter or Space to choose, Escape to close (`engineMenuKey`), roving
 *  `tabIndex` and real focus on the rows, exactly as the model rows below this
 *  menu do it, and a focus ring in the menu's own style. The accessible name
 *  stays "Engine": `aria-labelledby` points at the visible label alone, and the
 *  chosen engine is the combobox's own text, which is how a `<select>` read too.
 *
 *  Every handled key stops propagating, because the menu around this control
 *  owns ArrowDown/ArrowUp for its model rows and window-level Escape for
 *  itself; an engine list open inside it must answer for its own keys first. */
export function EngineSelect<T extends PickerEngine>({id,labelId,instances,value,onPick,placeholder}:{id:string;labelId:string;instances:readonly T[];value?:string;onPick:(instanceId:string)=>void;placeholder:string}){
  const families=useMemo(()=>engineMenuFamilies(instances),[instances]);
  const options=useMemo(()=>families.flatMap(family=>family.options),[families]);
  const selectedIndex=options.findIndex(option=>option.instance.instanceId===value);
  const selected=selectedIndex>=0?options[selectedIndex]:undefined;
  const[open,setOpen]=useState(false),[active,setActive]=useState(0);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),list=useRef<HTMLDivElement>(null);
  const layerOwner=useLayerOwner();
  const listId=`${id}-list`;
  // The menu this control sits in clips to its rounded corners
  // (`overflow-hidden`), so an absolutely positioned list is cut off rather
  // than overflowing when the menu is short — a nearly empty catalog makes a
  // menu barely taller than its own header. The list is therefore capped to
  // the room left below the trigger inside that menu; it keeps its own
  // `max-h` when there is no menu to measure (a test harness, or a future
  // caller that is not the picker).
  const[roomBelow,setRoomBelow]=useState(0);
  useLayoutEffect(()=>{
    if(!open)return;
    const measure=()=>{
      const panel=root.current?.closest("[data-model-picker-content]"),anchor=trigger.current;
      if(!panel||!anchor)return;
      setRoomBelow(Math.max(120,Math.round(panel.getBoundingClientRect().bottom-anchor.getBoundingClientRect().bottom-12)));
    };
    measure();
    window.addEventListener("resize",measure);
    return()=>window.removeEventListener("resize",measure);
  },[open]);
  useEffect(()=>{if(!open)return;list.current?.querySelectorAll<HTMLButtonElement>('[data-engine-choice]')[active]?.focus();},[open,active]);
  useEffect(()=>{if(!open)return;const outside=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};window.addEventListener('mousedown',outside);return()=>window.removeEventListener('mousedown',outside);},[open]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  const choose=(index:number)=>{const option=options[index];if(!option)return;onPick(option.instance.instanceId);close();};
  const onKeyDown=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
    if(event.key==="Escape"&&!canHandleLayerEscape(layerOwner?.handle,event.nativeEvent))return;
    const action=engineMenuKey(event.key,{open,index:open?active:Math.max(selectedIndex,0),count:options.length});
    if(action.type==="none")return;
    // Tab still leaves: the list closes behind it, the focus move is the browser's.
    if(action.type==="close"&&event.key==="Tab"){setOpen(false);return;}
    event.preventDefault();event.stopPropagation();
    if(action.type==="open"){setActive(action.index);setOpen(true);}
    else if(action.type==="move")setActive(action.index);
    else if(action.type==="select")choose(action.index);
    else close();
  };
  return <div ref={root} data-engine-control className="relative min-w-0 flex-1" onKeyDown={onKeyDown}>
    <button ref={trigger} type="button" id={id} role="combobox" aria-labelledby={labelId} aria-controls={open?listId:undefined} aria-expanded={open} aria-haspopup="listbox" onClick={()=>{setActive(Math.max(selectedIndex,0));setOpen(wasOpen=>!wasOpen);}} className="flex w-full items-center gap-1.5 rounded-md bg-inset px-2 py-1.5 text-left text-sm text-ink outline-none hover:bg-control/60 focus-visible:ring-2 focus-visible:ring-accent">
      {selected&&<span data-engine-icon className="shrink-0"><InstanceProviderMark instance={selected.instance} size={14}/></span>}
      <span className="min-w-0 flex-1 truncate">{selected?selected.label:placeholder}</span>
      <ChevronDown size={14} className="shrink-0 text-ink-secondary"/>
    </button>
    {open&&<EngineOptionRows id={listId} labelId={labelId} families={families} selectedId={value} activeIndex={active} onPick={choose} listRef={list} maxHeight={roomBelow||undefined}/>}
  </div>;
}
/** What one model row's hover says. Three cases, because the row has three.
 *
 *  A Flux route is the one row a single rate cannot describe: `flux-auto`
 *  dispatches across tiers, so the row reads as a span ("$–$$$") and the hover
 *  has to say what is actually true rather than quote a figure that does not
 *  exist. It used to fall into the unpriced branch, which would have put
 *  "Price unavailable" under a row showing a price range — a contradiction.
 *
 *  A priced row keeps every exact number it had: input and output per million,
 *  the source and the date it was read. The row is coarse on purpose; the hover
 *  is what keeps the coarse band honest, so nothing is dropped from it — only
 *  `dollarOfTokens` is added, which is that same rate restated.
 *
 *  A row with no resolvable rate says so, in the one wording the picker uses. */
export function pickerRowTitle(row: Pick<PickerModel, "selection"|"pricing">): string {
  // the band is still on its way (1.0.18): no tooltip rather than a wrong one
  if (isPricePending(row)) return "";
  const label = modelPriceLabel(row);
  if (!row.pricing) return label === PRICE_UNKNOWN ? PRICE_UNKNOWN
    : `${label} · Flux Router picks a model for each turn, so this depends on which one runs.`;
  return [
    `Input $${row.pricing.inputPerMillion ?? 'unknown'}/M`,
    `Output $${row.pricing.outputPerMillion ?? 'unknown'}/M`,
    dollarOfTokens(row.pricing),
    row.pricing.source,
    new Date(row.pricing.updatedAt).toLocaleDateString(),
  ].filter(Boolean).join(" · ");
}
/** The line under a model's name. Exported so a test without a DOM can read it:
 *  it is where the band, the capabilities and the local-server note all land,
 *  and it is the row's tightest surface — five cells at 11px in a 390px menu.
 *
 *  Capabilities are icons rather than words for that reason (measured: two
 *  words wrap at 390px, two icons do not). Only a capability the catalog or
 *  the snapshot states as true is drawn: an absent flag means "not stated",
 *  never "cannot", so there is no negative icon and no empty slot.
 *
 *  The price cell separates its two meanings by weight and slant rather than
 *  by colour — a real band is `font-medium`, an unresolved price is italic —
 *  so "we do not know" can never be read as the cheap end of the scale, and no
 *  new colour token enters the skins. */
export function PickerRowMeta({row,engineImages}:{row:PickerModel;engineImages?:boolean}){
  const pending=isPricePending(row);
  const unknown=!pending&&isPriceUnknown(row);
  // the eye only shows when the engine also passes pictures, so nothing contradicts
  const sees=Boolean(row.capabilities?.vision)&&engineImages!==false;
  return <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-secondary">
    {!row.localServer&&pickerRowSource(row)&&<span>{pickerRowSource(row)}</span>}
    {row.localServer&&localRowNote(row)&&<span>{localRowNote(row)}</span>}
    {contextLabel(row.contextWindow)&&<span>{contextLabel(row.contextWindow)}</span>}
    {!row.localServer&&(pending
      ?<span data-price-cell data-price-pending="" aria-hidden="true" className="inline-block h-2.5 w-6 animate-pulse rounded bg-hairline/40"/>
      :<span data-price-cell data-price-unknown={unknown?"":undefined} className={unknown?"italic":"font-medium"}>{modelPriceLabel(row)}</span>)}
    {(sees||row.capabilities?.tools)&&<span className="flex items-center gap-1">
      {sees&&<span data-capability="vision" role="img" aria-label="Reads images" title="Reads images" className="flex"><Eye size={12}/></span>}
      {row.capabilities?.tools&&<span data-capability="tools" role="img" aria-label="Uses tools" title="Uses tools" className="flex"><Wrench size={12}/></span>}
    </span>}
    {row.recommended&&<span>{t("modelPicker.recommended")}</span>}
    {row.stale&&<span className="text-warning">Cached catalog</span>}
  </div>;
}
/** The one dated line about the bands, said once for the whole menu. Exported
 *  so a test can render it: the placement (outside the scrolling list) is
 *  pinned separately, because a note that scrolls away is not a note. The date
 *  comes from the bundled snapshot, so it cannot quietly go stale. */
export function PickerPriceNote({shown}:{shown:boolean}){
  // undated until the snapshot lands would be a different note; it waits instead
  if(!shown||!modelMetadataReady())return null;
  return <div data-price-band-note className="border-t border-hairline/40 px-4 pb-1 pt-2 text-[11px] text-ink-secondary">{priceBandNote()}</div>;
}
/** The clamp numbers moved to lib/popover-clamp.ts so the load-failure frame shares them; these names stay for callers and tests. */
export const modelPickerMaxHeight=popoverMaxHeight;
export const modelPickerViewportOffset=popoverViewportOffset;
/** What switching to the engine shown would cost or add (triage row 22). */
export function EngineSwitchNotice({lines}:{lines:string[]}){
  if(!lines.length)return null;
  return <ul data-engine-switch-notice className="space-y-0.5 border-b border-hairline/40 px-3 py-2 text-xs text-ink-secondary">{lines.map(line=><li key={line}>{line}</li>)}</ul>;
}
/** FLUX-FIRST-PICKER-OWN-ACCOUNT: the menu's last row. Flux and Fuigo lead the list; somebody with their own AI account finds where
 *  to add it here, in Settings, Engines. */
export function OwnAccountRow({onOpen}:{onOpen:()=>void}){
  return <button type="button" data-own-account-row onClick={onOpen} className="border-t border-hairline/40 px-4 py-3 text-left text-sm text-ink-secondary hover:bg-control/60">{t("modelPicker.ownAccount")}</button>;
}

export function ModelPickerBusyNotice({locked}:{locked:boolean}){
  if(!locked)return null;
  return <div role="status" data-thread-model-busy className="border-b border-hairline/40 px-3 py-2 text-xs text-ink-secondary">This response is in progress. You can inspect models, but wait for it to finish or stop this turn before changing the model or effort.</div>;
}
type Prefs={favorites:string[];recent:string[]};
/** Everything the dialog draws from: the chip (ModelPicker.tsx) owns the state, so a
 *  slow chunk or a reopen never loses a query, an engine choice or a fetched catalog. */
export interface ModelPickerDialogProps{bot:Bot;threadId?:string;contained:boolean;root:RefObject<HTMLDivElement|null>;engine?:InstanceInfo;active?:InstanceInfo;rows:PickerModel[];
  query:string;setQuery:Dispatch<SetStateAction<string>>;limit:number;setLimit:Dispatch<SetStateAction<number>>;setEngineId:Dispatch<SetStateAction<string>>;
  connections:PublicProviderConnection[];error:string;fleetError:string;refreshing:boolean;refresh:(force?:boolean)=>Promise<void>;prefs:Prefs;save:(next:Prefs)=>void;
  pick:(selection:ModelSelection)=>void;manage:()=>void;manageLocal:()=>void;openOwnAccount:()=>void;selected?:PickerModel;selectedKey:string;selectedLabel:string;threadModelMutationLocked:boolean}
export function ModelPickerDialog({bot,threadId,contained,root,engine,active,rows,query,setQuery,limit,setLimit,setEngineId,connections,error,fleetError,refreshing,refresh,prefs,save,pick,manage,manageLocal,openOwnAccount,selected,selectedKey,selectedLabel,threadModelMutationLocked}:ModelPickerDialogProps){
  const{state,dispatch}=useStore();
  // Mounted only while open, so the clamp runs on every open as it did inline.
  const{ref:menu,style:menuStyle}=usePopoverClamp(root,contained);
  const ordered=useMemo(()=>orderedPickerModels(rows,query,prefs.favorites,prefs.recent,selectedKey),[rows,query,prefs,selectedKey]);
  // Spec V3: the Local rail is always answered for. No local server on this
  // computer is a state with a next step, not an absence the user has to notice.
  // The "add one" row is a next step only for a local engine (spec V3, "no dead ends"): never for openai-compat (an endpoint the owner named; its local rows, tools included, are extras once a server exists), never for the grok API, gemini, cursor and the like, and never while the engine is still loading.
  const noLocalServer=useMemo(()=>showNoLocalServerRow(engine,rows),[engine,rows]);
  const signInNote=useMemo(()=>signInPickerNote(engine?.driverKind,connections,bot.modelSelection.connectionId),[engine,connections,bot.modelSelection.connectionId]);
  // Spec V3 again, for the state that had no next step at all: nothing set up.
  const emptyState=useMemo(()=>pickerEmptyState(Boolean(engine),Boolean(query)),[engine,query]);
  // 1.0.4 SL-K K1: a chat with no model of its own uses its bot's
  const followsBot=Boolean(threadId)&&state.bots.find(candidate=>candidate.id===bot.id)?.tasks?.find(task=>task.threadId===threadId)?.followsBotModel===true;
  let previousGroup="";
  return <div ref={menu} style={menuStyle} role="dialog" aria-label="Choose model" data-box-exempt="popover, its rows are the actions" data-model-picker-content className={cn('z-30 flex max-h-[min(560px,70dvh)] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl',contained?'relative mt-3 w-full':'absolute right-0 top-full mt-2 w-[min(390px,calc(100vw-24px))]')} onKeyDown={event=>{if(event.target instanceof HTMLSelectElement||(event.target instanceof Element&&event.target.closest('[data-engine-control]'))||!['ArrowDown','ArrowUp'].includes(event.key))return;const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-model-choice]')];if(!buttons.length)return;event.preventDefault();const index=buttons.indexOf(document.activeElement as HTMLButtonElement),next=event.key==='ArrowDown'?(index+1)%buttons.length:(index-1+buttons.length)%buttons.length;buttons[next]?.focus();}}>
      <div className="space-y-2 border-b border-hairline/40 p-3"><div className="flex items-center gap-2"><span id={`engine-label-${bot.id}`} className="text-xs text-ink-secondary">Engine</span><EngineSelect id={`engine-${bot.id}`} labelId={`engine-label-${bot.id}`} instances={state.instances} value={engine?.instanceId} placeholder={CHOOSE_ENGINE_OPTION} onPick={instanceId=>{setEngineId(instanceId);setLimit(30);}}/><button type="button" aria-label="Refresh models" aria-disabled={refreshing||undefined} onClick={()=>void refresh(true)} className="rounded p-1.5 text-ink-secondary"><RefreshCw size={14} className={refreshing?'animate-spin':''}/></button></div><div className="flex items-center gap-2 rounded-lg bg-inset px-2.5 py-2"><Search size={14} className="text-ink-secondary"/><input autoFocus value={query} onChange={e=>{setQuery(e.target.value);setLimit(30);}} placeholder="Search models or providers" aria-label="Search models" className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"/></div><div className="text-xs text-ink-secondary">{pickerCountLine(Boolean(engine),ordered.length)}</div></div>
      <EngineListNote note={state.engineNote} localOnly={state.localOnlyEngines}/>
      <ModelPickerBusyNotice locked={threadModelMutationLocked}/>
      {followsBot&&<div data-follows-bot-model className="border-b border-hairline/40 px-3 py-2 text-xs text-ink-secondary">{t("slik.followsBot",{bot:bot.name})}</div>}
      <EngineSwitchNotice lines={engine&&engine.instanceId!==bot.modelSelection.instanceId?[...engineSwitchLines(active?.capabilities,engine.capabilities,engine.displayName),...(picturesElsewhereHint(engine,state.instances,connections,bot.modelSelection.model)?[picturesElsewhereHint(engine,state.instances,connections,bot.modelSelection.model)!]:[]),...(computerEngineNote(bot.computer,engine.capabilities,engine.displayName,engine.driverKind)?[computerEngineNote(bot.computer,engine.capabilities,engine.displayName,engine.driverKind)!]:[])]:[]}/>
      {!!active?.models.options.find(m => m.id === bot.modelSelection.model)?.variants?.length && <label className="flex min-w-0 max-w-full items-center gap-3 px-3 py-2 text-xs text-ink-secondary">{t("acp.thinking")}<select className="min-w-0 max-w-full flex-1 rounded-md bg-inset px-2 py-1.5 text-sm text-ink" aria-label={t("acp.thinking")} disabled={threadModelMutationLocked} value={bot.modelSelection.variant ?? ""} onChange={event => { if (!threadModelMutationLocked) dispatch({ type: "setModel", botId: bot.id, threadId, selection: { ...bot.modelSelection, variant: event.target.value || undefined } }); }}><option value="">{t("acp.defaultThinking")}</option>{active.models.options.find(m => m.id === bot.modelSelection.model)?.variants?.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>}
      {threadId&&!!active?.capabilities?.effortLevels?.length&&<label className="flex items-center gap-3 px-3 py-2 text-xs text-ink-secondary">Thread effort<select aria-label="Thread effort" disabled={threadModelMutationLocked} value={bot.modelSelection.effort??""} onChange={event=>{if(threadModelMutationLocked)return;dispatch({type:"setModel",botId:bot.id,threadId,selection:{...bot.modelSelection,effort:(event.target.value||undefined) as ModelSelection["effort"]}});}} className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1.5 text-sm text-ink"><option value="">Engine default</option>{active.capabilities.effortLevels.map(level=><option key={level} value={level}>{effortLabel(level)}</option>)}</select></label>}
      <ModelPickerNotices error={error} fleetError={fleetError}/>
      <ModelRouteRow engine={engine} manage={manage} className="border-b border-hairline/40 px-3 py-2"/>
      {signInNote&&<div data-signin-engine-note className="px-3 py-2 text-xs text-ink-secondary">{signInNote}</div>}
      {engine?.instanceId===bot.modelSelection.instanceId&&!selected&&<div className="px-3 py-2 text-xs text-warning">Current choice: {selectedLabel}. It is unavailable in this catalog; your selection is preserved.</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {ordered.slice(0,limit).map(row=>{const zone=pickerZone(row,prefs.favorites,prefs.recent);const heading=zone!==previousGroup;previousGroup=zone;const favorite=prefs.favorites.includes(row.key);const rowLabel=localRowLabel(row);const warning=localToolsWarning(row);return <div key={row.key}>{heading&&<div className="px-2 pb-1 pt-2 text-[11px] font-medium text-ink-secondary">{zone}</div>}<div className="flex items-center gap-1 rounded-lg hover:bg-control/60"><button type="button" data-model-choice disabled={threadModelMutationLocked} aria-pressed={row.key===selectedKey} onClick={()=>pick(row.selection)} className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent" title={pickerRowTitle(row)}><div className="flex items-center justify-between gap-2"><span className="truncate text-[13px] text-ink">{rowLabel}</span>{row.key===selectedKey&&<Check size={14} className="shrink-0 text-accent"/>}</div><PickerRowMeta row={row} engineImages={engine?.capabilities?.images}/>{warning&&<div className="mt-1 flex items-start gap-1 text-[11px] text-warning"><AlertTriangle size={12} className="mt-[1px] shrink-0"/><span>{warning}</span></div>}</button><button type="button" aria-label={`${favorite?'Unfavorite':'Favorite'} ${rowLabel} via ${pickerRowSource(row)||zone}`} aria-pressed={favorite} onClick={()=>save({...prefs,favorites:favorite?prefs.favorites.filter(k=>k!==row.key):[...prefs.favorites,row.key].slice(-100)})} className="mr-1 rounded p-2 text-ink-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent"><Star size={13} className={favorite?'fill-accent text-accent':''}/></button></div></div>;})}
      {!ordered.length&&<div className="p-3 text-sm text-ink-secondary">{engine&&needsCli(engine)&&!['grok','openai-compat'].includes(engine.driverKind)?<EngineSetup instance={engine}/>:emptyState?<div data-picker-empty className="flex flex-col gap-2 rounded-xl border border-dashed border-accent/45 bg-accent/[0.06] p-3 text-left"><div className="text-[13px] font-medium text-ink">{emptyState.title}</div><div className="text-xs text-ink-secondary">{emptyState.body}</div><div className="flex flex-wrap gap-2 pt-1"><button type="button" data-model-choice onClick={manage} className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-accent">{emptyState.action}</button><button type="button" data-model-choice onClick={manageLocal} className="rounded-lg border border-hairline/50 px-2.5 py-1.5 text-xs text-ink outline-none hover:bg-control/60 focus-visible:ring-2 focus-visible:ring-accent">{emptyState.localAction}</button></div></div>:query?'No matching compatible chat models.':'Connect a compatible provider in Models settings.'}</div>}
      {ordered.length>limit&&<button type="button" onClick={()=>setLimit(v=>v+50)} className="w-full rounded-lg p-2 text-xs text-accent">More models · {ordered.length-limit} remaining</button>}
      {/* Last, after every model: a hint with a next step, not a heading
          above the choices the person actually has. */}
      {noLocalServer&&(!query||!ordered.length)&&<div data-local-rail-empty><div className="px-2 pb-1 pt-2 text-[11px] font-medium text-ink-secondary">{LOCAL_MODELS_GROUP}</div><button type="button" data-model-choice onClick={manageLocal} className="w-full rounded-lg px-2 py-2 text-left text-[13px] text-ink outline-none hover:bg-control/60 focus-visible:ring-2 focus-visible:ring-accent">{NO_LOCAL_SERVER_ROW}</button></div>}</div>
      {/* Outside the scrolling list on purpose: a note that scrolls away is not
          a note. One line for the whole menu, dated from the bundled snapshot
          rather than hardcoded, and never repeated per row. */}
      <PickerPriceNote shown={!!ordered.length}/>
      <button type="button" onClick={manage} className="border-t border-hairline/40 px-4 py-3 text-left text-sm text-ink hover:bg-control/60">Manage models and providers</button>
      <OwnAccountRow onOpen={openOwnAccount}/>
    </div>;
}
