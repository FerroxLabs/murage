import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { Check, ChevronDown, Search, Star, RefreshCw, AlertTriangle, Eye, Wrench } from "lucide-react";
import { api, useStore, type Bot, type ModelSelection } from "@/state/store";
import type { PublicProviderConnection } from "../../shared/provider-connections";
import { pickerModels, pickerConnectionsToRefresh, orderedPickerModels, pickerKey, modelPriceLabel, isPriceUnknown, dollarOfTokens, priceBandNote, PRICE_UNKNOWN, contextLabel, engineMenuFamilies, engineMenuKey, pickerZone, ENGINE_DISABLED_SUFFIX, type EngineMenuFamily, type PickerEngine, type PickerModel, showNoLocalServerRow, localRowLabel, localRowNote, localToolsWarning, unavailableSelectionLabel, LOCAL_MODELS_GROUP, NO_LOCAL_SERVER_ROW, CHOOSE_ENGINE_OPTION, pickerCountLine, pickerEmptyState, pickerTriggerTitle, pickerRowSource } from "@/lib/provider-model-picker";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, needsCli } from "./EngineSetup";
import { cn } from "@/lib/cn";
import { COMPACT_SQUARE } from "@/lib/compact-chip";
import { useBotSettingsNavigation } from "./bot-settings-drafts";
import { OPEN_LOCAL_MODELS_EVENT, OPEN_MODEL_PICKER_EVENT } from "@/lib/local-models-view";
import { t } from "@/lib/i18n";
const PREFS="murage-model-picker-v1";
/** One open of the menu reads two sources: the provider connections (the
 * catalog the rows are built from) and the engine fleet (the store's
 * refreshInstances, GET /api/instances, which rejects when the probe fails —
 * FOLLOW4). They used to share one Promise.all in one try/catch, so a failed
 * fleet probe threw away a catalog that had already answered and replaced the
 * menu with the probe's raw error, though the connections were there to list.
 * Each source now fails on its own: the catalog draws whenever it answered, a
 * catalog failure is the alert, and a fleet failure is a secondary line under
 * it — the engines shown are the last known ones (FOLLOW6, FOLLOW4 verifier). */
export interface ModelPickerRefreshSources{connections:()=>Promise<{connections?:PublicProviderConnection[]}>;fleet:()=>Promise<void>;force:boolean}
export interface ModelPickerRefreshOutcome{/** Undefined when the catalog did not answer: the drawn list stays. */connections?:PublicProviderConnection[];error:string;fleetError:string}
export async function refreshModelPickerCatalog({connections,fleet,force}:ModelPickerRefreshSources):Promise<ModelPickerRefreshOutcome>{
  const[catalog,probe]=await Promise.allSettled([connections(),fleet()]);
  const fleetError=probe.status==="rejected"?t("modelPicker.fleetRefreshError"):"";
  if(catalog.status==="rejected")return{error:catalog.reason instanceof Error?catalog.reason.message:t("modelPicker.catalogUnavailable"),fleetError};
  const list=catalog.value.connections??[];
  return{connections:list,error:force&&list.some(connection=>connection.enabled&&connection.catalog.error)?t("modelPicker.partialRefresh"):"",fleetError};
}
/** The two notices, apart: the catalog's alert and the fleet's secondary line.
 * Neither replaces the list. Exported so a test without a DOM can render it. */
export function ModelPickerNotices({error,fleetError}:{error:string;fleetError:string}){
  return <>{error&&<div role="alert" className="px-3 py-2 text-xs text-danger">{error}</div>}{fleetError&&<div role="status" data-model-picker-fleet-error className="px-3 py-2 text-xs text-warning">{fleetError}</div>}</>;
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
        <span data-engine-icon className="shrink-0"><ProviderMark driverKind={option.instance.driverKind} size={14}/></span>
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
  useEffect(()=>{if(!open)return;const outside=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};window.addEventListener('mousedown',outside);return()=>window.removeEventListener('mousedown',outside);},[open]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  const choose=(index:number)=>{const option=options[index];if(!option)return;onPick(option.instance.instanceId);close();};
  const onKeyDown=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
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
      {selected&&<span data-engine-icon className="shrink-0"><ProviderMark driverKind={selected.instance.driverKind} size={14}/></span>}
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
  const label = modelPriceLabel(row);
  if (!row.pricing) return label === PRICE_UNKNOWN ? PRICE_UNKNOWN
    : `${label} · Flux Router picks a model for each turn, so what a turn costs depends on which one runs.`;
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
export function PickerRowMeta({row}:{row:PickerModel}){
  const unknown=isPriceUnknown(row);
  return <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-secondary">
    {!row.localServer&&pickerRowSource(row)&&<span>{pickerRowSource(row)}</span>}
    {row.localServer&&localRowNote(row)&&<span>{localRowNote(row)}</span>}
    {contextLabel(row.contextWindow)&&<span>{contextLabel(row.contextWindow)}</span>}
    {!row.localServer&&<span data-price-cell data-price-unknown={unknown?"":undefined} className={unknown?"italic":"font-medium"}>{modelPriceLabel(row)}</span>}
    {(row.capabilities?.vision||row.capabilities?.tools)&&<span className="flex items-center gap-1">
      {row.capabilities?.vision&&<span data-capability="vision" role="img" aria-label="Reads images" title="Reads images" className="flex"><Eye size={12}/></span>}
      {row.capabilities?.tools&&<span data-capability="tools" role="img" aria-label="Uses tools" title="Uses tools" className="flex"><Wrench size={12}/></span>}
    </span>}
    {row.stale&&<span className="text-warning">Cached catalog</span>}
  </div>;
}
/** The one dated line about the bands, said once for the whole menu. Exported
 *  so a test can render it: the placement (outside the scrolling list) is
 *  pinned separately, because a note that scrolls away is not a note. The date
 *  comes from the bundled snapshot, so it cannot quietly go stale. */
export function PickerPriceNote({shown}:{shown:boolean}){
  if(!shown)return null;
  return <div data-price-band-note className="border-t border-hairline/40 px-4 pb-1 pt-2 text-[11px] text-ink-secondary">{priceBandNote()}</div>;
}
export function isThreadModelMutationLocked(threadId:string|undefined,busy:boolean|undefined){return Boolean(threadId&&busy);}
/** The menu's height: on a phone, everything below where it opens but a
 *  12px margin (a fixed 70% left ~3 rows and blank space under them); on a
 *  wider window the compact 560px cap. Never shorter than a usable list. */
export function modelPickerMaxHeight(menuTop:number,viewportHeight:number,viewportWidth:number){
  const room=Math.floor(viewportHeight-menuTop-12);
  return Math.max(240,viewportWidth>=768?Math.min(560,room):room);
}
/** Same horizontal clamp as TaskPicker, using the rendered menu width. */
export function modelPickerViewportOffset(anchorRight:number,menuWidth:number,viewportWidth:number){
  const left=anchorRight-menuWidth;
  return Math.max(12,Math.min(left,viewportWidth-menuWidth-12))-left;
}
export function ModelPickerBusyNotice({locked}:{locked:boolean}){
  if(!locked)return null;
  return <div role="status" data-thread-model-busy className="border-b border-hairline/40 px-3 py-2 text-xs text-ink-secondary">This response is in progress. You can inspect models, but wait for it to finish or stop this turn before changing the model or effort.</div>;
}
function preferences():{favorites:string[];recent:string[]}{try{const value=JSON.parse(localStorage.getItem(PREFS)??"{}");return{favorites:Array.isArray(value.favorites)?value.favorites.filter((s:unknown)=>typeof s==="string").slice(0,100):[],recent:Array.isArray(value.recent)?value.recent.filter((s:unknown)=>typeof s==="string").slice(0,12):[]};}catch{return{favorites:[],recent:[]};}}
export function ModelPicker({bot,threadId,className,contained=false,label}:{bot:Bot;threadId?:string;className?:string;contained?:boolean;label?:ReactNode}){
  const navigate=useBotSettingsNavigation();
  const{state,dispatch,refreshInstances}=useStore();const[open,setOpen]=useState(false),[engineId,setEngineId]=useState(bot.modelSelection.instanceId),[query,setQuery]=useState(""),[limit,setLimit]=useState(30),[connections,setConnections]=useState<PublicProviderConnection[]>([]),[error,setError]=useState(""),[fleetError,setFleetError]=useState(""),[refreshing,setRefreshing]=useState(false),[prefs,setPrefs]=useState(preferences);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),refreshingRef=useRef(false);
  const menu=useRef<HTMLDivElement>(null);
  const[menuOffset,setMenuOffset]=useState(0);
  const[menuMaxHeight,setMenuMaxHeight]=useState<number|undefined>(undefined);
  useLayoutEffect(()=>{
    if(!open||contained)return;
    const reposition=()=>{
      if(root.current&&menu.current){
        setMenuOffset(modelPickerViewportOffset(root.current.getBoundingClientRect().right,menu.current.getBoundingClientRect().width,window.innerWidth));
        setMenuMaxHeight(modelPickerMaxHeight(menu.current.getBoundingClientRect().top,window.visualViewport?.height??window.innerHeight,window.innerWidth));
      }
    };
    reposition();
    const observer=new ResizeObserver(reposition);
    if(root.current)observer.observe(root.current);
    if(menu.current)observer.observe(menu.current);
    const header=root.current?.closest("[data-chat-header]");
    if(header)observer.observe(header);
    window.addEventListener("resize",reposition);
    return()=>{observer.disconnect();window.removeEventListener("resize",reposition);};
  },[open,contained]);
  const active=state.instances.find(i=>i.instanceId===bot.modelSelection.instanceId),engine=state.instances.find(i=>i.instanceId===engineId)??active;
  const refresh=async(force=false)=>{if(refreshingRef.current)return;refreshingRef.current=true;setRefreshing(true);try{
    const readConnections=async()=>{const snapshot=await api('/api/provider-connections');
      const enabled=pickerConnectionsToRefresh(snapshot.connections??[],force);if(!enabled.length)return snapshot;
      for(let offset=0;offset<enabled.length;offset+=4)await Promise.all(enabled.slice(offset,offset+4).map((connection:PublicProviderConnection)=>api(`/api/provider-connections/${encodeURIComponent(connection.id)}/refresh`,{method:'POST'})));
      return api('/api/provider-connections');};
    const outcome=await refreshModelPickerCatalog({connections:readConnections,fleet:refreshInstances,force});
    if(outcome.connections)setConnections(outcome.connections);
    setError(outcome.error);setFleetError(outcome.fleetError);
  }catch(cause){setError(cause instanceof Error?cause.message:t("modelPicker.catalogUnavailable"));}finally{refreshingRef.current=false;setRefreshing(false);}};
  useEffect(()=>{if(open)void refresh();},[open]);
  useEffect(()=>{const changed=()=>void refresh();window.addEventListener("murage:provider-connections-changed",changed);return()=>window.removeEventListener("murage:provider-connections-changed",changed);},[refreshInstances]);
  useEffect(()=>{if(!open)return;const outside=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();if(query)setQuery("");else{setOpen(false);trigger.current?.focus();}}};window.addEventListener('mousedown',outside);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('mousedown',outside);window.removeEventListener('keydown',escape);};},[open,query]);
  const rows=useMemo(()=>engine?pickerModels(engine,connections):[],[engine,connections]);const currentKey=pickerKey(bot.modelSelection);const ordered=useMemo(()=>orderedPickerModels(rows,query,prefs.favorites,prefs.recent,currentKey),[rows,query,prefs,currentKey]);
  // Spec V3: the Local rail is always answered for. No local server on this
  // computer is a state with a next step, not an absence the user has to notice.
  // The "add one" row is a next step only for an engine the Local models section feeds (spec V3, "no dead ends"): never for the chat-only drivers (openai-compat, grok — they are not local engines; openai-compat lists local rows only as chat-only extras), never for gemini/cursor/…, and never while the engine is still loading.
const noLocalServer=useMemo(()=>showNoLocalServerRow(engine,rows),[engine,rows]);
  // Spec V3 again, for the state that had no next step at all: nothing set up.
  const emptyState=useMemo(()=>pickerEmptyState(Boolean(engine),Boolean(query)),[engine,query]);
  const selectedKey=pickerKey(bot.modelSelection);const selected=rows.find(row=>row.key===selectedKey);const selectedConnection=connections.find(c=>c.id===bot.modelSelection.connectionId);const selectedLabel=selected?.label??active?.models.options.find(o=>o.id===bot.modelSelection.model)?.label??unavailableSelectionLabel(bot.modelSelection.model);
  const threadModelMutationLocked=isThreadModelMutationLocked(threadId,bot.busy);
  const save=(next:typeof prefs)=>{setPrefs(next);try{localStorage.setItem(PREFS,JSON.stringify(next));}catch{}};
  const pick=(selection:ModelSelection)=>{if(threadModelMutationLocked)return;save({...prefs,recent:[pickerKey(selection),...prefs.recent.filter(k=>k!==pickerKey(selection))].slice(0,12)});dispatch({type:'setModel',botId:bot.id,threadId,selection:{...selection,...(selection.instanceId===bot.modelSelection.instanceId&&bot.modelSelection.effort?{effort:bot.modelSelection.effort}:{})}});setOpen(false);trigger.current?.focus();};
  const manage=()=>navigate(()=>{setOpen(false);dispatch({type:'toggleAppSettings',open:true,section:'models'});});
  // The Local rail's empty row lands on the Local models section itself, with
  // "Add a server" focused — not on the Models pane for the user to hunt through.
  const manageLocal=()=>{manage();setTimeout(()=>window.dispatchEvent(new Event(OPEN_LOCAL_MODELS_EVENT)),0);};
  // Settings → Models → Local models sends a tested model back here: the next
  // step after "Tools work" is choosing it, which only this menu can do.
  // Inspection remains available during a turn. The mutation callbacks below
  // still fence model and effort changes, including a turn that starts while
  // this menu is already open.
  useEffect(()=>{const show=(event:Event)=>{const model=(event as CustomEvent<{model?:string}>).detail?.model;setEngineId(bot.modelSelection.instanceId);setQuery(typeof model==="string"?model:"");setLimit(30);setOpen(true);};window.addEventListener(OPEN_MODEL_PICKER_EVENT,show);return()=>window.removeEventListener(OPEN_MODEL_PICKER_EVENT,show);},[bot.modelSelection.instanceId]);
  let previousGroup="";
  return <div ref={root} className={cn(contained?'w-full':'relative',className)}>
    <div className={cn(contained&&'flex items-center justify-between gap-4')}>{contained&&label}<button ref={trigger} type="button" aria-label={threadId?`Thread model: ${selectedLabel}${bot.modelSelection.effort?` · ${bot.modelSelection.effort} effort`:""}`:undefined} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{setEngineId(bot.modelSelection.instanceId);setQuery("");setLimit(30);setOpen(v=>!v);}} title={pickerTriggerTitle(active?.displayName,selectedLabel,selectedConnection?.label)} className={cn('flex max-w-full items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover',!contained&&active&&COMPACT_SQUARE)}>{active&&<ProviderMark driverKind={active.driverKind} size={14}/>}<span className={cn('max-w-[160px] truncate',!contained&&active&&'chip-trim:hidden')}>{selectedLabel}</span><ChevronDown size={14}/></button></div>
    {open&&<div ref={menu} style={contained?undefined:{transform:`translateX(${menuOffset}px)`,...(menuMaxHeight?{maxHeight:menuMaxHeight}:{})}} role="dialog" aria-label="Choose model" data-model-picker-content className={cn('z-30 flex max-h-[min(560px,70dvh)] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl',contained?'relative mt-3 w-full':'absolute right-0 top-full mt-2 w-[min(390px,calc(100vw-24px))]')} onKeyDown={event=>{if(event.target instanceof HTMLSelectElement||(event.target instanceof Element&&event.target.closest('[data-engine-control]'))||!['ArrowDown','ArrowUp'].includes(event.key))return;const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-model-choice]')];if(!buttons.length)return;event.preventDefault();const index=buttons.indexOf(document.activeElement as HTMLButtonElement),next=event.key==='ArrowDown'?(index+1)%buttons.length:(index-1+buttons.length)%buttons.length;buttons[next]?.focus();}}>
      <div className="space-y-2 border-b border-hairline/40 p-3"><div className="flex items-center gap-2"><span id={`engine-label-${bot.id}`} className="text-xs text-ink-secondary">Engine</span><EngineSelect id={`engine-${bot.id}`} labelId={`engine-label-${bot.id}`} instances={state.instances} value={engine?.instanceId} placeholder={CHOOSE_ENGINE_OPTION} onPick={instanceId=>{setEngineId(instanceId);setLimit(30);}}/><button type="button" aria-label="Refresh models" disabled={refreshing} onClick={()=>void refresh(true)} className="rounded p-1.5 text-ink-secondary"><RefreshCw size={14} className={refreshing?'animate-spin':''}/></button></div><div className="flex items-center gap-2 rounded-lg bg-inset px-2.5 py-2"><Search size={14} className="text-ink-secondary"/><input autoFocus value={query} onChange={e=>{setQuery(e.target.value);setLimit(30);}} placeholder="Search models or providers" aria-label="Search models" className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"/></div><div className="text-xs text-ink-secondary">{pickerCountLine(Boolean(engine),ordered.length)}</div></div>
      <ModelPickerBusyNotice locked={threadModelMutationLocked}/>
      {threadId&&!!active?.capabilities?.effortLevels?.length&&<label className="flex items-center gap-3 px-3 py-2 text-xs text-ink-secondary">Thread effort<select aria-label="Thread effort" disabled={threadModelMutationLocked} value={bot.modelSelection.effort??""} onChange={event=>{if(threadModelMutationLocked)return;dispatch({type:"setModel",botId:bot.id,threadId,selection:{...bot.modelSelection,effort:(event.target.value||undefined) as ModelSelection["effort"]}});}} className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1.5 text-sm text-ink"><option value="">Engine default</option>{active.capabilities.effortLevels.map(level=><option key={level} value={level}>{level}</option>)}</select></label>}
      <ModelPickerNotices error={error} fleetError={fleetError}/>
      {engine?.instanceId===bot.modelSelection.instanceId&&!selected&&<div className="px-3 py-2 text-xs text-warning">Current choice: {selectedLabel}. It is unavailable in this catalog; your selection is preserved.</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {ordered.slice(0,limit).map(row=>{const zone=pickerZone(row,prefs.favorites,prefs.recent);const heading=zone!==previousGroup;previousGroup=zone;const favorite=prefs.favorites.includes(row.key);const rowLabel=localRowLabel(row);const warning=localToolsWarning(row);return <div key={row.key}>{heading&&<div className="px-2 pb-1 pt-2 text-[11px] font-medium text-ink-secondary">{zone}</div>}<div className="flex items-center gap-1 rounded-lg hover:bg-control/60"><button type="button" data-model-choice disabled={threadModelMutationLocked} aria-pressed={row.key===selectedKey} onClick={()=>pick(row.selection)} className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent" title={pickerRowTitle(row)}><div className="flex items-center justify-between gap-2"><span className="truncate text-[13px] text-ink">{rowLabel}</span>{row.key===selectedKey&&<Check size={14} className="shrink-0 text-accent"/>}</div><PickerRowMeta row={row}/>{warning&&<div className="mt-1 flex items-start gap-1 text-[11px] text-warning"><AlertTriangle size={12} className="mt-[1px] shrink-0"/><span>{warning}</span></div>}</button><button type="button" aria-label={`${favorite?'Unfavorite':'Favorite'} ${rowLabel} via ${pickerRowSource(row)||zone}`} aria-pressed={favorite} onClick={()=>save({...prefs,favorites:favorite?prefs.favorites.filter(k=>k!==row.key):[...prefs.favorites,row.key].slice(-100)})} className="mr-1 rounded p-2 text-ink-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent"><Star size={13} className={favorite?'fill-accent text-accent':''}/></button></div></div>;})}
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
    </div>}
  </div>;
}
