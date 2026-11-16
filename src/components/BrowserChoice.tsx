import { BOX_FRAME, BoxHead, BoxBody, BoxFoot } from "./ui/BoxShell";
import { BrowserDisclosure } from './BrowserDisclosure';
import type { BrowserCopy } from '../../shared/browser-copy';
import { t } from '@/lib/i18n';
import { BrowserPreflight } from './BrowserPreflight';
import { BrowserSetupList } from './BrowserSetupList';
import { useState, type ReactNode } from 'react';
import { api, useStore, type Bot } from '@/state/store';
import { fromAnswer } from '@/state/answer-tag';
type Selection={mode:'builtin'|'chrome-extension'|'chrome-direct'|'your-chrome';profile?:string;browser?:'chrome'|'edge'|'brave';route?:'chrome-extension'|'chrome-direct'};
type Preview={destination:Selection&{profileLabel:string};baseRevision:number;disclosure:{lines:string[];copy?:BrowserCopy[];disclosureKey:string};proposedRoute:string};
export function BrowserChoiceView({name,mode,choose,children}:{name:string;mode:string;choose:(choice:Selection)=>void;children?:ReactNode}) {
 return <div className="flex min-h-0 flex-col gap-3"><div aria-label={t("browser.BrowserChoice.1")} className="flex flex-wrap gap-2"><button aria-pressed={mode==='builtin'} onClick={()=>choose({mode:'builtin'})} className="rounded-lg bg-control px-3 py-2 text-sm">{t('browser.ownBrowser',{name})}</button><button aria-pressed={mode!=='builtin'} onClick={()=>choose({mode:'your-chrome'})} className="rounded-lg bg-control px-3 py-2 text-sm">{t("browser.BrowserChoice.2")}</button></div>{children}</div>;
}
export function BrowserChoice({bot,children,compact=false}:{bot:Bot;children?:(choose:(selection:Selection)=>void)=>ReactNode;compact?:boolean}) {
 const {state,dispatch}=useStore();const [preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
 const base=`/api/bots/${encodeURIComponent(bot.id)}`;
 const choose=async(selection:Selection)=>{setError('');setPending(true);try{const q=new URLSearchParams({mode:selection.mode,...(selection.profile?{profile:selection.profile}:{}),...(selection.route?{route:selection.route}:{}),...(selection.browser?{browser:selection.browser}:{})});setPreview(await api(`${base}/browser-choice/preview?${q}`));}catch(e){setError(e instanceof Error?e.message:t('browser.choiceCheck'));}finally{setPending(false);}};
 const update=async(body:unknown)=>{const result=await api(base,{method:'PATCH',body:JSON.stringify(body)});if(result.bot)dispatch({type:'botPatched',...fromAnswer(result.bot),bot:result.bot});};
 const confirm=async()=>{if(!preview)return;setPending(true);setError('');try{await update({browserChoice:{mode:preview.destination.mode,profile:preview.destination.profile,browser:preview.destination.browser,baseRevision:preview.baseRevision,disclosureKey:preview.disclosure.disclosureKey}});setPreview(null);}catch(e){setError(e instanceof Error?e.message:t('browser.choiceChange'));}finally{setPending(false);}};
 const cancel=async()=>{setError('');try{const result=await api(`${base}/browser-choice/cancel`,{method:'POST',body:JSON.stringify({baseRevision:bot.selectionRevision??0})});if(result.bot)dispatch({type:'botPatched',...fromAnswer(result.bot),bot:result.bot});}catch(e){setError(String(e));}};
 const mode=bot.browserMode??(bot.useMyChrome?bot.browserTransport==='extension'?'chrome-extension':'chrome-direct':'builtin');
 const content = <>
  {!compact&&<BrowserSetupList botId={bot.id}/>}
  {!compact&&mode==='chrome-direct'&&<BrowserPreflight botId={bot.id} route={mode} browser={mode==='chrome-direct'?'chrome':bot.browserExtensionBrowser??'chrome'}/>}
  <p className="text-xs text-ink-secondary">{mode==='builtin'?t('browser.profileSummary',{profile:bot.browserProfile==='guest'?t('browser.guest'):state.config?.browserProfiles?.find(p=>p.id===bot.browserProfile)?.name??t('browser.ownProfile',{name:bot.name})}):t('browser.chromeSummary')}</p>
  {preview&&<div role="dialog" aria-label={t("browser.BrowserChoice.3")} className={`${BOX_FRAME} max-h-[70dvh] rounded-lg bg-card p-3 text-sm`}><BoxHead>{t("browser.BrowserChoice.3")}</BoxHead><BoxBody><BrowserDisclosure {...preview.disclosure}/></BoxBody><BoxFoot className="mt-2"><button disabled={pending} onClick={()=>void confirm()} className="rounded bg-accent px-3 py-2 text-accent-ink">{t("browser.BrowserChoice.4")}</button><button onClick={()=>setPreview(null)}>{t("browser.BrowserChoice.5")}</button></BoxFoot></div>}
  {bot.pendingBrowserChoice&&<p role="status" className="text-sm">{t('browser.queued',{name:bot.name})} <button onClick={()=>void cancel()}>{t("browser.BrowserChoice.6")}</button> <button onClick={()=>void api(`${base}/browser-choice/switch-now`,{method:'POST',body:JSON.stringify({baseRevision:bot.selectionRevision??0})}).then(result=>{if(result.stopping)setError(t('browser.stopping',{name:bot.name}));}).catch(e=>setError(String(e)))}>{t("browser.BrowserChoice.7")}</button></p>}
  {bot.previousBrowserChoice&&<p className="text-sm"><button aria-label={t('browser.switchback',{previous:bot.previousBrowserChoice.mode==='builtin'?t('browser.ownBrowser',{name:bot.name}):t('browser.yourChrome')})} onClick={()=>void choose(bot.previousBrowserChoice!)}>{t('browser.switchback',{previous:bot.previousBrowserChoice.mode==='builtin'?t('browser.ownBrowser',{name:bot.name}):t('browser.yourChrome')})}</button></p>}
  {bot.browserRelease&&<p role="status" className="text-sm">{(bot.browserRelease.attempts??0)>=3?t('browser.releaseFailed',{name:bot.name}):t('browser.releaseWaiting')} <button onClick={()=>void api(`${base}/browser-choice/retry`,{method:'POST',body:'{}'}).catch(e=>setError(String(e)))}>{t("browser.BrowserChoice.9")}</button></p>}
  {!compact&&<details><summary className="text-sm">{t("browser.BrowserChoice.10")}</summary><label className="text-sm">{t("browser.BrowserChoice.11")}<select value={bot.browserProfile??''} disabled={pending||mode!=='builtin'} onChange={e=>void choose({mode:'builtin',profile:e.target.value||undefined})}><option value="">{t('browser.ownProfile',{name:bot.name})}</option>{state.config?.browserProfiles?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}<option value="guest">{t("browser.BrowserChoice.12")}</option></select></label><label className="block text-sm">{t("browser.BrowserChoice.13")}<select value={mode==='chrome-direct'?'chrome-direct':'chrome-extension'} disabled={pending} onChange={e=>void choose({mode:'your-chrome',route:e.target.value as 'chrome-direct'|'chrome-extension'})}><option value="chrome-extension">{t("browser.BrowserChoice.14")}</option><option value="chrome-direct">{t("browser.BrowserChoice.15")}</option></select></label></details>}
  {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
  {children?.(selection=>void choose(selection))}
 </>;
 return compact?<div><button onClick={()=>void choose({mode:'builtin'})}>{t('browser.switchOwn',{name:bot.name})}</button>{content}</div>:<BrowserChoiceView name={bot.name} mode={mode} choose={selection=>void choose(selection)}>{content}</BrowserChoiceView>;
}
