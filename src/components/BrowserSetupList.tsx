import { BrowserDisclosure } from './BrowserDisclosure';
import type { BrowserCopy } from '../../shared/browser-copy';
import { t } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { api, useStore, type Bot } from '@/state/store';
import { fromAnswer } from '@/state/answer-tag';
type Listed = Pick<Bot,'id'|'name'>;
export function BrowserSetupListView({bots,open,onDismiss,onOpen,onSetup,onMove}:{bots:Listed[];open:boolean;onDismiss:()=>void;onOpen:()=>void;onSetup:(id:string)=>void;onMove:()=>void}){
 if(!bots.length)return null;
 if(!open)return <button className="text-sm" onClick={onOpen}>{t('browser.setupList',{count:bots.length})}</button>;
 return <section aria-label={t("browser.BrowserSetupList.1")} className="rounded-lg border border-hairline p-3 text-sm"><p>{t('browser.setupCount',{count:bots.length})}</p>{bots.map(bot=><p key={bot.id}>{bot.name} <button onClick={()=>onSetup(bot.id)}>{t("browser.BrowserSetupList.2")}</button></p>)}<button onClick={onMove}>{t("browser.BrowserSetupList.3")}</button> <button onClick={onDismiss}>{t("browser.BrowserSetupList.4")}</button></section>;
}
type Review={bot:Listed;baseRevision:number;disclosure:{lines:string[];copy?:BrowserCopy[];disclosureKey:string}};
export function BrowserSetupList({botId}:{botId:string}){
 const {dispatch}=useStore(),[bots,setBots]=useState<Listed[]>([]),[open,setOpen]=useState(false),[reviews,setReviews]=useState<Review[]>([]),[error,setError]=useState('');
 const key='murage-browser-setup-dismissed';
 const load=async()=>{const result=await api('/api/browser-choice/setup-list');setBots(result.bots);return result.bots as Listed[];};
 useEffect(()=>{let live=true;setError('');void api('/api/browser-choice/setup-list').then(result=>{if(live){setBots(result.bots);setOpen(result.bots.length>1&&localStorage.getItem(key)!==result.bots.map((b:Listed)=>b.id).sort().join(','));}}).catch(cause=>{if(live)setError(cause instanceof Error?cause.message:String(cause));});return()=>{live=false;};},[botId]);
 const review=async()=>{setError('');try{const list=await load();setReviews(await Promise.all(list.map(async bot=>({bot,...await api(`/api/bots/${encodeURIComponent(bot.id)}/browser-choice/preview?mode=builtin`)}))));}catch(e){setError(String(e));}};
 const confirm=async()=>{setError('');for(const r of reviews){try{const result=await api(`/api/bots/${encodeURIComponent(r.bot.id)}`,{method:'PATCH',body:JSON.stringify({browserChoice:{mode:'builtin',baseRevision:r.baseRevision,disclosureKey:r.disclosure.disclosureKey}})});if(result.bot)dispatch({type:'botPatched',...fromAnswer(result.bot),bot:result.bot});}catch(e){setError(`${r.bot.name}: ${String(e)}`);break;}}setReviews([]);await load();};
 if(!bots.some(b=>b.id===botId))return error?<p role="alert">{error}</p>:null;
 return <><BrowserSetupListView bots={bots} open={open} onOpen={()=>setOpen(true)} onDismiss={()=>{localStorage.setItem(key,bots.map(b=>b.id).sort().join(','));setOpen(false);}} onSetup={id=>{dispatch({type:'select',id});}} onMove={()=>void review()}/>{reviews.length>0&&<section aria-label={t("browser.BrowserSetupList.5")} className="rounded-lg border border-hairline p-3">{reviews.map(r=><div key={r.bot.id}><BrowserDisclosure {...r.disclosure}/></div>)}<button onClick={()=>void confirm()}>{t("browser.BrowserSetupList.6")}</button> <button onClick={()=>setReviews([])}>{t("browser.BrowserSetupList.7")}</button></section>}{error&&<p role="alert">{error}</p>}</>;
}
