// The model picker's chip, drawn with the first paint. The dialog it opens
// (ModelPickerDialog.tsx: the Engine control, search, groups and rows) is
// fetched on the first open (1.0.19 slice P, first-paint.test.ts); this chip
// keeps every piece of the picker's state, so the dialog is a renderer of it.
import { useLayerOwner } from "./LayerSlot";
import { usePopoverClamp } from "@/lib/popover-clamp";
import { canHandleLayerEscape } from "@/lib/focus-trap";
import { withTypedOpenCodeModels } from "@/lib/typed-opencode-models";
import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { api, useStore, type Bot, type ModelSelection } from "@/state/store";
import type { PublicProviderConnection } from "../../shared/provider-connections";
import { modelMetadataReady, preloadModelMetadata, subscribeModelMetadata } from "@/lib/model-metadata";
import { pickerModels, pickerConnectionsToRefresh, pickerKey, unavailableSelectionLabel, pickerTriggerTitle } from "@/lib/provider-model-picker";
import { InstanceProviderMark } from "./ProviderIcons";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
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
export function isThreadModelMutationLocked(threadId:string|undefined,busy:boolean|undefined){return Boolean(threadId&&busy);}
function preferences():{favorites:string[];recent:string[]}{try{const value=JSON.parse(localStorage.getItem(PREFS)??"{}");return{favorites:Array.isArray(value.favorites)?value.favorites.filter((s:unknown)=>typeof s==="string").slice(0,100):[],recent:Array.isArray(value.recent)?value.recent.filter((s:unknown)=>typeof s==="string").slice(0,12):[]};}catch{return{favorites:[],recent:[]};}}
/** What a dialog chunk that failed to load leaves on screen: a frame shaped and placed like the dialog (the same eager clamp),
 *  with Retry focused, closable by its Close, Escape or an outside click (SETTINGS-P-LAZY-FAILURE-1019 section 2). */
export function ModelPickerLoadErrorFrame({root,contained,children}:{root:RefObject<HTMLElement|null>;contained:boolean;children:ReactNode}){
  const clamp=usePopoverClamp(root,contained);
  useEffect(()=>{clamp.ref.current?.querySelector<HTMLButtonElement>("button")?.focus({preventScroll:true});},[clamp.ref]);
  return <div ref={clamp.ref} style={clamp.style} role="dialog" aria-label="Choose model" data-box-exempt="popover, its rows are the actions" data-model-picker-load-error className={cn('z-30 flex flex-col items-start gap-2 overflow-hidden rounded-2xl border border-hairline/50 bg-card p-3 shadow-2xl',contained?'relative mt-3 w-full':'absolute right-0 top-full mt-2 w-[min(390px,calc(100vw-24px))]')}>{children}</div>;
}
export function ModelPicker({bot,threadId,className,contained=false,label,hideTrigger=false,returnFocusRef}:{bot:Bot;threadId?:string;className?:string;contained?:boolean;label?:ReactNode;
  /** The phone header opens the picker from its ... menu (OPEN_MODEL_PICKER_EVENT): the chip itself is not drawn, and the menu is anchored where `className` puts this root. */
  hideTrigger?:boolean;
  /** Where focus goes when the menu closes, instead of the chip (the ... button that opened it). */
  returnFocusRef?:RefObject<HTMLElement|null>}){
  const layerOwner=useLayerOwner();
  const navigate=useBotSettingsNavigation();
  const{state,dispatch,refreshInstances}=useStore();const[open,setOpen]=useState(false),[engineId,setEngineId]=useState(bot.modelSelection.instanceId),[query,setQuery]=useState(""),[limit,setLimit]=useState(30),[connections,setConnections]=useState<PublicProviderConnection[]>([]),[error,setError]=useState(""),[fleetError,setFleetError]=useState(""),[refreshing,setRefreshing]=useState(false),[prefs,setPrefs]=useState(preferences);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),refreshingRef=useRef(false);
  // Read when focus goes back, not when the Escape listener was bound: the
  // picker can stay open while the header switches between its phone and wide
  // layouts, and focus belongs to whichever opener the page draws by then.
  const returnFocus=useRef(returnFocusRef);returnFocus.current=returnFocusRef;
  const focusTrigger=()=>{(returnFocus.current?.current??trigger.current)?.focus();};
  const instances=useMemo(()=>state.instances.map(i=>withTypedOpenCodeModels(i,bot.modelSelection,query)),[state.instances,bot.modelSelection,query]);
  const active=instances.find(i=>i.instanceId===bot.modelSelection.instanceId),engine=instances.find(i=>i.instanceId===engineId)??active;
  const refresh=async(force=false)=>{if(refreshingRef.current)return;refreshingRef.current=true;setRefreshing(true);try{
    const readConnections=async()=>{const snapshot=await api('/api/provider-connections');
      const enabled=pickerConnectionsToRefresh(snapshot.connections??[],force);if(!enabled.length)return snapshot;
      for(let offset=0;offset<enabled.length;offset+=4)await Promise.all(enabled.slice(offset,offset+4).map((connection:PublicProviderConnection)=>api(`/api/provider-connections/${encodeURIComponent(connection.id)}/refresh`,{method:'POST'})));
      return api('/api/provider-connections');};
    const outcome=await refreshModelPickerCatalog({connections:readConnections,fleet:refreshInstances,force});
    if(outcome.connections)setConnections(outcome.connections);
    setError(outcome.error);setFleetError(outcome.fleetError);
  }catch(cause){setError(cause instanceof Error?cause.message:t("modelPicker.catalogUnavailable"));}finally{refreshingRef.current=false;setRefreshing(false);}};
  // Opening always asks for the price snapshot: a Flux-only list never looks one up, and its dated note waits for it.
  useEffect(()=>{if(open){void refresh();void preloadModelMetadata();}},[open]);
  useEffect(()=>{const changed=()=>void refresh();window.addEventListener("murage:provider-connections-changed",changed);return()=>window.removeEventListener("murage:provider-connections-changed",changed);},[refreshInstances]);
  useEffect(()=>{if(!open)return;const outside=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};window.addEventListener('mousedown',outside);return()=>window.removeEventListener('mousedown',outside);},[open]);
  const onLayerEscape=(e:ReactKeyboardEvent<HTMLDivElement>)=>{
    if(!open||!canHandleLayerEscape(layerOwner?.handle,e.nativeEvent))return;
    e.preventDefault();e.stopPropagation();
    // The load-failure frame has no search box: Escape closes it at once.
    if(query&&!root.current?.querySelector("[data-model-picker-load-error]"))setQuery("");else{setOpen(false);focusTrigger();}
  };
  // The bundled price snapshot arrives after the first paint (1.0.18); the rows are rebuilt once when it does.
  const metadataReady=useSyncExternalStore(subscribeModelMetadata,modelMetadataReady,modelMetadataReady);
  const rows=useMemo(()=>engine?pickerModels(engine,connections):[],[engine,connections,metadataReady]);
  const selectedKey=pickerKey(bot.modelSelection);const selected=rows.find(row=>row.key===selectedKey);const selectedConnection=connections.find(c=>c.id===bot.modelSelection.connectionId);const selectedLabel=selected?.label??active?.models.options.find(o=>o.id===bot.modelSelection.model)?.label??unavailableSelectionLabel(bot.modelSelection.model);
  const threadModelMutationLocked=isThreadModelMutationLocked(threadId,bot.busy);
  const save=(next:typeof prefs)=>{setPrefs(next);try{localStorage.setItem(PREFS,JSON.stringify(next));}catch{}};
  const pick=(selection:ModelSelection)=>{if(threadModelMutationLocked)return;save({...prefs,recent:[pickerKey(selection),...prefs.recent.filter(k=>k!==pickerKey(selection))].slice(0,12)});dispatch({type:'setModel',botId:bot.id,threadId,selection:{...selection,...(selection.instanceId===bot.modelSelection.instanceId&&bot.modelSelection.effort?{effort:bot.modelSelection.effort}:{})}});setOpen(false);focusTrigger();};
  const manage=()=>navigate(()=>{setOpen(false);dispatch({type:'toggleAppSettings',open:true,section:'models'});});
  // The Local rail's empty row lands on the Local models section itself, with
  // "Add a server" focused — not on the Models pane for the user to hunt through.
  const openOwnAccount=()=>navigate(()=>{setOpen(false);dispatch({type:'toggleAppSettings',open:true,section:'models',anchor:'engines-heading'});});
  const manageLocal=()=>{manage();setTimeout(()=>window.dispatchEvent(new Event(OPEN_LOCAL_MODELS_EVENT)),0);};
  // Settings → Models → Local models sends a tested model back here: the next
  // step after "Tools work" is choosing it, which only this menu can do.
  // Inspection remains available during a turn. The mutation callbacks below
  // still fence model and effort changes, including a turn that starts while
  // this menu is already open.
  useEffect(()=>{const show=(event:Event)=>{const model=(event as CustomEvent<{model?:string}>).detail?.model;setEngineId(bot.modelSelection.instanceId);setQuery(typeof model==="string"?model:"");setLimit(30);setOpen(true);};window.addEventListener(OPEN_MODEL_PICKER_EVENT,show);return()=>window.removeEventListener(OPEN_MODEL_PICKER_EVENT,show);},[bot.modelSelection.instanceId]);
  return <div ref={root} onKeyDown={onLayerEscape} className={cn(contained?'w-full':'relative',className)}>
    <div className={cn(contained&&'flex items-center justify-between gap-4')}>{contained&&label}<button ref={trigger} type="button" aria-label={threadId?`Thread model: ${selectedLabel}${bot.modelSelection.effort?` · ${bot.modelSelection.effort} effort`:""}`:undefined} aria-haspopup="dialog" aria-expanded={open} tabIndex={hideTrigger?-1:undefined} aria-hidden={hideTrigger||undefined} onClick={()=>{setEngineId(bot.modelSelection.instanceId);setQuery("");setLimit(30);setOpen(v=>!v);}} title={pickerTriggerTitle(active?.displayName,selectedLabel,selectedConnection?.label)} className={cn('flex max-w-full items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover',!contained&&active&&COMPACT_SQUARE,hideTrigger&&'sr-only')}>{active&&<InstanceProviderMark instance={active} size={14}/>}<span className={cn('max-w-[160px] truncate',!contained&&active&&'chip-trim:hidden')}>{selectedLabel}</span><ChevronDown size={14}/></button></div>
    {/* A failed chunk shows its retry where the menu would be, in the menu's own frame, never as a loose line under the chip. */}
    {open&&<LazyBoundary inline onRetry={ModelPickerDialogChunk.retry} onDismiss={()=>{setOpen(false);focusTrigger();}} frame={alert=><ModelPickerLoadErrorFrame root={root} contained={contained}>{alert}</ModelPickerLoadErrorFrame>}><Suspense fallback={null}><ModelPickerDialogChunk.Component bot={bot} threadId={threadId} contained={contained} root={root} engine={engine} active={active} rows={rows}
      query={query} setQuery={setQuery} limit={limit} setLimit={setLimit} setEngineId={setEngineId} connections={connections} error={error} fleetError={fleetError} refreshing={refreshing} refresh={refresh}
      prefs={prefs} save={save} pick={pick} manage={manage} manageLocal={manageLocal} openOwnAccount={openOwnAccount} selected={selected} selectedKey={selectedKey} selectedLabel={selectedLabel} threadModelMutationLocked={threadModelMutationLocked}/></Suspense></LazyBoundary>}
  </div>;
}
/** The one door into the dialog chunk: a dynamic import on the first open, never a static one (first-paint.test.ts). */
export const loadModelPickerDialog=()=>import("./ModelPickerDialog");
const ModelPickerDialogChunk=retryableLazy(()=>loadModelPickerDialog().then(module=>({default:module.ModelPickerDialog})));
