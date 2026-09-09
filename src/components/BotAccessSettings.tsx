import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import type { AccessGrant, ConnectedAppAccess, PendingPermissionStatus } from "../../shared/bot-access";
import { useBotSettingsDraft } from "./bot-settings-drafts";
interface AccessView { enabled:boolean; policy:ConnectedAppAccess; catalog:{toolkit:string;tool:string;label:string;writes:boolean}[]; accounts:{toolkit:string;accountId:string;label?:string}[]; pending:PendingPermissionStatus[] }
/** Owner-only controls. Managers can request a bundle but cannot approve it. */
export function BotAccessSettings({botId}:{botId:string}) {
 const [view,setView]=useState<AccessView|null>(null),[open,setOpen]=useState(false),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [mode,setMode]=useState<"unrestricted"|"restricted">("restricted"),[writes,setWrites]=useState(false),[grants,setGrants]=useState<AccessGrant[]>([]);
 const [accountId,setAccountId]=useState("");const gate=useRef(false);const url=`/api/bots/${encodeURIComponent(botId)}/access`;
 const apply=(next:AccessView)=>{setView(next);setMode(next.policy.mode);setWrites(next.policy.allowWrites);setGrants(next.policy.grants);};
 useEffect(()=>{let active=true;api(url).then((next:AccessView)=>{if(active)apply(next);}).catch(()=>{if(active)setError("Could not load app access. Try again.");});return()=>{active=false;};},[url]);
 const refresh=async()=>{setError(null);try{apply(await api(url));}catch{setError("Could not load app access. Try again.");}};
 const save=async(body:object)=>{if(gate.current||!view)return;gate.current=true;setBusy(true);setError(null);try{apply(await api(url,{method:"PUT",body:JSON.stringify({...body,revision:view.policy.revision})}));}catch(e){setError(e instanceof Error?e.message:"Could not save access. Refresh and try again.");}finally{gate.current=false;setBusy(false);}};
 const account=view?.accounts.find(item=>item.accountId===accountId);
 useBotSettingsDraft("App access", view !== null && (mode !== view.policy.mode || writes !== view.policy.allowWrites || JSON.stringify(grants) !== JSON.stringify(view.policy.grants)), busy);
 const toggle=(tool:string)=>{if(!account)return;setGrants(current=>{const row=current.find(item=>item.accountId===account.accountId&&item.toolkit===account.toolkit);const tools=row?.tools.includes(tool)?row.tools.filter(item=>item!==tool):[...(row?.tools??[]),tool];return [...current.filter(item=>item!==row),...(tools.length?[{toolkit:account.toolkit,accountId:account.accountId,tools}]:[])];});};
 return <div className="rounded-xl bg-card p-4">
  <button type="button" onClick={()=>setOpen(value=>!value)} aria-expanded={open} className="w-full text-left text-[14px] font-medium text-ink">App access and approvals</button>
  <p className="mt-1 text-[12px] text-ink-secondary">{view?view.pending.length?`${view.pending.length} waiting for your review`:"No pending approvals":"Loading permission status…"}</p>
  {error&&<div role="alert" className="mt-2 text-[12px] text-danger">{error} <button type="button" onClick={()=>void refresh()} className="underline">Refresh</button></div>}
  {open&&view&&<div className="mt-3 space-y-3 text-[12px] text-ink-secondary">
   {view.pending.map((item,index)=><p key={index}>{item.kind} request · {Math.floor(item.ageSeconds/60)} minutes · {item.blockedReason}</p>)}
   <p>These limits cover Murage’s connected apps. They do not restrict separate app logins, terminal tools or local files.</p>
   <label className="flex items-start gap-2"><input type="checkbox" checked={mode==="restricted"} disabled={busy} onChange={event=>{setMode(event.target.checked?"restricted":"unrestricted");if(event.target.checked)setWrites(false);}}/>Only allow the accounts and actions I choose</label>
   {mode==="restricted"&&<>
    <label className="flex items-start gap-2"><input type="checkbox" checked={writes} disabled={busy} onChange={event=>setWrites(event.target.checked)}/>Allow selected actions to send or change data</label>
    <label className="block">Connected account<select aria-label="Connected account for access limits" value={accountId} disabled={busy} onChange={event=>setAccountId(event.target.value)} className="mt-1 w-full rounded-lg bg-inset px-2 py-2 text-ink"><option value="">Choose an account…</option>{view.accounts.map(item=><option key={item.accountId} value={item.accountId}>{item.label??`${item.toolkit} · ${item.accountId.slice(-8)}`}</option>)}</select></label>
    {account&&view.catalog.filter(tool=>tool.toolkit===account.toolkit).map(tool=><label key={tool.tool} className="flex items-start gap-2"><input type="checkbox" checked={grants.some(grant=>grant.accountId===accountId&&grant.tools.includes(tool.tool))} disabled={busy} onChange={()=>toggle(tool.tool)}/>{tool.label}{tool.writes?" (changes data)":""}</label>)}
    <p>{grants.reduce((count,grant)=>count+grant.tools.length,0)} actions selected. Unlisted actions and dynamic tools are blocked.</p>
   </>}
   <button type="button" disabled={busy} onClick={()=>void save({action:"configure",mode,allowWrites:writes,grants:mode==="restricted"?grants:[]})} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">{busy?"Saving…":"Save app access"}</button>
   {view.policy.requests.map(request=><div key={request.id} className="rounded-lg border border-hairline/40 p-3">
    <p className="font-medium text-ink">A manager requested app access</p>
    {request.grants.map((grant,index)=><p key={index} className="mt-1 break-words">{view.accounts.find(item=>item.accountId===grant.accountId)?.label??grant.toolkit}: {grant.tools.map(name=>view.catalog.find(tool=>tool.tool===name)?.label??name).join(", ")}</p>)}
    <p className="mt-1">{request.allowWrites?"Includes permission to send or change data.":"Sending and changing data stay blocked."} Approval replaces this bot’s current limits and enables connected apps.</p>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void save({action:"approve",requestId:request.id})} className="rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">Approve and enable</button><button type="button" disabled={busy} onClick={()=>void save({action:"deny",requestId:request.id})} className="rounded-lg border border-hairline/40 px-3 py-2 text-ink disabled:opacity-50">Decline</button></div>
   </div>)}
  </div>}
 </div>;
}
