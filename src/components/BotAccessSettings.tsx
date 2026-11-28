import { useEffect, useRef, useState } from "react";
import { Switch } from "./SettingsPrimitives";
import { api } from "@/state/store";
import { presetTools, withAccountTools, type AccessGrant, type ConnectedAppAccess, type GrantPreset, type PendingPermissionStatus } from "../../shared/bot-access";
import { rememberedViews } from "@/lib/remembered-view";
import { useBotSettingsDraft } from "./bot-settings-drafts";
import { BOX_SAVE_ROW } from "./ui/BoxShell";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
/** D25-V3: the owner's offer to give this bot its creator's connected apps (server/bot-access.ts copyFromView). */
export type CopyFromView = { creatorId:string; creatorName:string; replaces:boolean }
 & ({ available:false; reason:"unavailable"|"nothing" } | { available:true; sourceDigest:string; unrestricted:boolean; allowWrites:boolean; grants:AccessGrant[]; noLimits:boolean; draftOnly:boolean });
export interface AccessView { enabled:boolean; policy:ConnectedAppAccess; catalog:{toolkit:string;tool:string;label:string;writes:boolean}[]; accounts:{toolkit:string;accountId:string;label?:string}[]; pending:PendingPermissionStatus[]; copyFrom?:CopyFromView }
/** The last answer per bot. The card paints from it at once on the next open and refreshes behind it,
 * so a slow connected-apps service never leaves a blank or loading card once one answer exists. */
const views = rememberedViews<AccessView>();
export const accessViews = views;
const APP_NAMES:Record<string,string>={gmail:"Gmail",slack:"Slack",googlecalendar:"Google Calendar"};
/** English for the access.copyFrom.* ids (section 7 of the D25-V3 design); L-COPY moves them into the catalog. */
export const COPY_FROM={
 title:(creator:string)=>`Give this bot ${creator}'s connected apps`,
 note:(creator:string)=>`This copies ${creator}'s apps as they are now. Later changes to ${creator}'s apps do not change this bot's.`,
 replaces:"This replaces this bot's current app settings.",
 button:(again:boolean)=>again?"Give again":"Give these apps",
 given:(creator:string)=>`Given ${creator}'s apps`,
 nothing:(creator:string)=>`${creator} has no connected apps to give.`,
 unavailable:(creator:string)=>`${creator} can't share apps right now (apps off, drafts only, hidden or removed).`,
 offer:(creator:string)=>`Apps are off. You can give it ${creator}'s apps.`,
 allApps:"All connected apps, can send and change data",
 noLimits:" (this bot is on No limits)",
 draftOnly:" (this bot only drafts and does not send)",
};
/** One line per grant, the way the owner will see it after the press. A No limits bot reaches every app whatever is copied, so it shows that. */
export function copyFromLines(copy:Extract<CopyFromView,{available:true}>,view:Pick<AccessView,"accounts"|"catalog">):string[] {
 if(copy.unrestricted||copy.noLimits)return [COPY_FROM.allApps+(copy.noLimits?COPY_FROM.noLimits:"")+(copy.draftOnly?COPY_FROM.draftOnly:"")];
 const tail=(copy.allowWrites?"Can send and change data":"Read only")+(copy.draftOnly?COPY_FROM.draftOnly:"");
 return copy.grants.map(grant=>`${APP_NAMES[grant.toolkit]??grant.toolkit} (${view.accounts.find(item=>item.accountId===grant.accountId)?.label??grant.accountId.slice(-8)}): ${grant.tools.map(name=>view.catalog.find(tool=>tool.tool===name)?.label??name).join(", ")}. ${tail}`);
}
/** The press: exactly {action,revision,sourceDigest}. On ANY failure (409, 500) the page loads the server's view again and shows its message, so a
 * post-commit error never leaves a stale page. */
export async function pressCopyFromCreator(deps:{request:(init?:{method:string;body:string})=>Promise<AccessView>;view:AccessView;apply:(next:AccessView)=>void}):Promise<{error?:string}> {
 const copy=deps.view.copyFrom;if(!copy||!copy.available)return {};
 try{deps.apply(await deps.request({method:"PUT",body:JSON.stringify({action:"copy-from-creator",revision:deps.view.policy.revision,sourceDigest:copy.sourceDigest})}));return {};}
 catch(e){
  const error=e instanceof Error?e.message:"Could not give these apps. Refresh and try again.";
  try{deps.apply(await deps.request());}catch{/* the message below still says why */}
  return {error};
 }
}
/** The owner's block above the grant list. */
export function CopyFromBlock({copy,view,busy,given,onPress}:{copy:CopyFromView;view:AccessView;busy:boolean;given:boolean;onPress:()=>void}) {
 if(!copy.available)return <div className="rounded-lg border border-hairline/40 p-3"><p>{copy.reason==="nothing"?COPY_FROM.nothing(copy.creatorName):COPY_FROM.unavailable(copy.creatorName)}</p></div>;
 return <div className="rounded-lg border border-hairline/40 p-3">
  <p className="font-medium text-ink">{COPY_FROM.title(copy.creatorName)}</p>
  {copyFromLines(copy,view).map((line,index)=><p key={index} className="mt-1 break-words">{line}</p>)}
  <p className="mt-1">{COPY_FROM.note(copy.creatorName)}</p>
  {copy.replaces&&<p className="mt-1">{COPY_FROM.replaces}</p>}
  {given&&<p role="status" className="mt-1 text-ink">{COPY_FROM.given(copy.creatorName)}</p>}
  <div className="mt-2"><button type="button" disabled={busy} onClick={onPress} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">{COPY_FROM.button(copy.replaces)}</button></div>
 </div>;
}
const PRESET_LABEL:Record<GrantPreset,LocaleKey>={read:"botAccess.preset.read",all:"botAccess.preset.all"};
/** B43: the two buttons only set one account's checkboxes (onApply gets the explicit slugs).
 * They never touch the bot-wide changes switch; the owner still presses Save. */
export function GrantPresetButtons({toolkit,catalog,busy,onApply}:{toolkit:string;catalog:AccessView["catalog"];busy:boolean;onApply:(tools:string[])=>void}) {
 const app=APP_NAMES[toolkit]??toolkit;
 return <div>
  <div className="flex flex-wrap gap-2">{(["read","all"] as const).map(preset=>{const tools=presetTools(toolkit,preset,catalog);const none=tools.length===0;
   return <span key={preset} title={none?t("botAccess.preset.none",{app}):undefined}><button type="button" disabled={busy||none} onClick={()=>onApply(tools)} className="min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">{t(PRESET_LABEL[preset])}</button></span>;})}</div>
  <p className="mt-1">{t("botAccess.preset.writesNote")}</p>
 </div>;
}
/** Owner-only controls. Managers can request a bundle but cannot approve it. */
export function BotAccessSettings({botId}:{botId:string}) {
 const [view,setView]=useState<AccessView|null>(()=>views.get(botId)),[open,setOpen]=useState(false),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [mode,setMode]=useState<"unrestricted"|"restricted">("restricted"),[writes,setWrites]=useState(false),[grants,setGrants]=useState<AccessGrant[]>([]);
 const [accountId,setAccountId]=useState(""),[given,setGiven]=useState(false);const gate=useRef(false);const url=`/api/bots/${encodeURIComponent(botId)}/access`;
 const apply=(next:AccessView)=>{views.set(botId,next);setView(next);setMode(next.policy.mode);setWrites(next.policy.allowWrites);setGrants(next.policy.grants);};
 useEffect(()=>{let active=true;setView(views.get(botId));void views.open(botId,()=>api(url),next=>{if(active){setView(next);setMode(next.policy.mode);setWrites(next.policy.allowWrites);setGrants(next.policy.grants);}},()=>setError("Could not load app access. Try again."),()=>active);return()=>{active=false;};},[url]);
 const refresh=async()=>{setError(null);try{apply(await api(url));}catch{setError("Could not load app access. Try again.");}};
 const save=async(body:object)=>{if(gate.current||!view)return;gate.current=true;setBusy(true);setError(null);try{apply(await api(url,{method:"PUT",body:JSON.stringify({...body,revision:view.policy.revision})}));}catch(e){setError(e instanceof Error?e.message:"Could not save access. Refresh and try again.");}finally{gate.current=false;setBusy(false);}};
 const copyFrom=async()=>{if(gate.current||!view)return;gate.current=true;setBusy(true);setError(null);setGiven(false);try{const result=await pressCopyFromCreator({request:init=>api(url,init),view,apply});if(result.error)setError(result.error);else setGiven(true);}finally{gate.current=false;setBusy(false);}};
 const account=view?.accounts.find(item=>item.accountId===accountId);
 useBotSettingsDraft("App access", view !== null && (mode !== view.policy.mode || writes !== view.policy.allowWrites || JSON.stringify(grants) !== JSON.stringify(view.policy.grants)), busy);
 const toggle=(tool:string)=>{if(!account)return;setGrants(current=>{const row=current.find(item=>item.accountId===account.accountId&&item.toolkit===account.toolkit);const tools=row?.tools.includes(tool)?row.tools.filter(item=>item!==tool):[...(row?.tools??[]),tool];return [...current.filter(item=>item!==row),...(tools.length?[{toolkit:account.toolkit,accountId:account.accountId,tools}]:[])];});};
 const failure=<div role="alert" className="mt-2 text-[12px] text-danger">{error} <button type="button" onClick={()=>void refresh()} className="underline">Refresh</button></div>;
 return <div className="rounded-xl bg-card p-4">
  <button type="button" onClick={()=>setOpen(value=>!value)} aria-expanded={open} className="w-full text-left text-[14px] font-medium text-ink">App access and approvals</button>
  <p className="mt-1 text-[12px] text-ink-secondary">{view?view.pending.length?`${view.pending.length} waiting for your review`:view.copyFrom?.available&&!view.enabled?COPY_FROM.offer(view.copyFrom.creatorName):"No pending approvals":"Loading permission status…"}</p>
  {error&&!(open&&view)&&failure}
  {open&&view&&<div className="mt-3 space-y-3 text-[12px] text-ink-secondary">
   {view.pending.map((item,index)=><p key={index}>{item.kind} request · {Math.floor(item.ageSeconds/60)} minutes · {item.blockedReason}</p>)}
   {view.copyFrom&&<CopyFromBlock copy={view.copyFrom} view={view} busy={busy} given={given} onPress={()=>void copyFrom()}/>}
   <p>These limits cover Murage’s connected apps. They do not restrict separate app logins, terminal tools or local files.</p>
   <div className="flex min-h-11 items-center justify-between gap-3"><span id="bot-access-restricted">Only allow the accounts and actions I choose</span><Switch aria-labelledby="bot-access-restricted" checked={mode==="restricted"} disabled={busy} onClick={()=>{const restricted=mode!=="restricted";setMode(restricted?"restricted":"unrestricted");if(restricted)setWrites(false);}}/></div>
   {mode==="restricted"&&<>
    <div className="flex min-h-11 items-center justify-between gap-3"><span id="bot-access-writes">Allow selected actions to send or change data</span><Switch aria-labelledby="bot-access-writes" checked={writes} disabled={busy} onClick={()=>setWrites(!writes)}/></div>
    <label className="block">Connected account<select aria-label="Connected account for access limits" value={accountId} disabled={busy} onChange={event=>setAccountId(event.target.value)} className="mt-1 w-full rounded-lg bg-inset px-2 py-2 text-ink"><option value="">Choose an account…</option>{view.accounts.map(item=><option key={item.accountId} value={item.accountId}>{item.label??`${item.toolkit} · ${item.accountId.slice(-8)}`}</option>)}</select></label>
    {account&&view.catalog.filter(tool=>tool.toolkit===account.toolkit).map(tool=><label key={tool.tool} className="flex items-start gap-2"><input type="checkbox" checked={grants.some(grant=>grant.accountId===accountId&&grant.tools.includes(tool.tool))} disabled={busy} onChange={()=>toggle(tool.tool)}/>{tool.label}{tool.writes?" (changes data)":""}</label>)}
    {account&&<GrantPresetButtons toolkit={account.toolkit} catalog={view.catalog} busy={busy} onApply={tools=>setGrants(current=>withAccountTools(current,account,tools))}/>}
    <p>{grants.reduce((count,grant)=>count+grant.tools.length,0)} actions selected. Unlisted actions and dynamic tools are blocked.</p>
   </>}
   <div className={`${BOX_SAVE_ROW} bg-card`}>
    {error&&failure}
    <button type="button" disabled={busy} onClick={()=>void save({action:"configure",mode,allowWrites:writes,grants:mode==="restricted"?grants:[]})} className="mt-2 rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">{busy?"Saving…":"Save app access"}</button>
   </div>
   {view.policy.requests.map(request=><div key={request.id} className="rounded-lg border border-hairline/40 p-3">
    <p className="font-medium text-ink">A manager requested app access</p>
    {request.grants.map((grant,index)=><p key={index} className="mt-1 break-words">{view.accounts.find(item=>item.accountId===grant.accountId)?.label??grant.toolkit}: {grant.tools.map(name=>view.catalog.find(tool=>tool.tool===name)?.label??name).join(", ")}</p>)}
    <p className="mt-1">{request.allowWrites?"Includes permission to send or change data.":"Sending and changing data stay blocked."} Approval replaces this bot’s current limits and enables connected apps.</p>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void save({action:"approve",requestId:request.id})} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">Approve and enable</button><button type="button" disabled={busy} onClick={()=>void save({action:"deny",requestId:request.id})} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">Decline</button></div>
   </div>)}
  </div>}
 </div>;
}
