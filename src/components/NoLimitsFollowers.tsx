import { useEffect, useRef, useState } from 'react';
import { api, useStore } from '@/state/store';
import { t } from '@/lib/i18n';
import { useFocusTrap } from '@/lib/focus-trap';
import { LayerSurface } from './LayerSurface';
import { BOX_FRAME, BoxHead, BoxBody, BoxFoot } from './ui/BoxShell';
interface Followers {enabled:boolean;bots:number;routines:number;lower:Array<{id:string;name:string;kind:'bot'|'routine'|'chat';level:string}>}
const UPGRADE_KEY='murage.noLimitsUpgrade.1019';
function upgradeSeen(){try{return localStorage.getItem(UPGRADE_KEY)==='1';}catch{return false;}}
/** The upgrade notice explains the current rule once; Settings keeps the live list. */
export function NoLimitsFollowers({upgrade=false}:{upgrade?:boolean}={}) {
 const {state}=useStore();
 const permissionStamp=state.bots.map(bot=>`${bot.id}:${bot.autoApprove}:${bot.fullAccess}:${bot.noLimits}:${bot.permissionExplicit}:${bot.permissionRev}`).join('|');
 const [status,setStatus]=useState<Followers|null>(null),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 const [seen,setSeen]=useState(upgradeSeen);
 const dialog=useRef<HTMLDivElement>(null);
 const open=upgrade&&!seen&&status?.enabled===true;
 const dismiss=()=>{try{localStorage.setItem(UPGRADE_KEY,'1');}catch{/* this launch still remembers */}setSeen(true);};
 const layer=useFocusTrap(dialog,open,{name:'no-limits-upgrade',kind:'dialog',initialFocus:'[data-layer-cancel]',onEscape:dismiss});
 useEffect(()=>{let active=true;void api('/api/permissions/no-limits').then(value=>{if(active)setStatus(value);}).catch(cause=>{if(active)setError(String(cause));});return()=>{active=false;};},[permissionStamp,state.config?.newBots]);
 const useAll=async()=>{setSaving(true);setError('');try{setStatus(await api('/api/permissions/no-limits',{method:'POST',body:'{}'}));if(upgrade)dismiss();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}};
 if(upgrade&&!open)return null;
 if(!status?.enabled)return error?<p role="alert" className="text-danger">{error}</p>:null;
 const list=<>{status.lower.length>0&&<><p className="mt-2 text-[12px] text-ink-secondary">{t('noLimits.followers.lower')}</p><ul className="mt-1 text-[13px] text-ink">{status.lower.map(row=><li key={`${row.kind}:${row.id}`}>{row.name} ({t(`noLimits.followers.${row.kind}`)}): {t(row.level==='full'?'slik.levelFull':row.level==='auto'?'slik.levelAuto':'slik.levelAsk')}</li>)}</ul></>}</>;
 const action=<button type="button" disabled={saving} onClick={()=>void useAll()} className="rounded-md bg-control px-3 py-2 text-[13px] text-ink disabled:opacity-50">{t('noLimits.followers.useAll')}</button>;
 if(upgrade)return <LayerSurface handle={layer}><div className="overlay-inset fixed inset-0 flex items-center justify-center bg-black/50 p-6"><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="no-limits-upgrade-title" className={`${BOX_FRAME} max-h-[calc(var(--vvh,100dvh)-3rem)] w-full max-w-[520px] rounded-2xl border border-hairline/50 bg-panel shadow-2xl`}>
  <BoxHead className="px-5 py-4"><h2 id="no-limits-upgrade-title" className="text-[17px] font-medium">{t('noLimits.followers.upgradeTitle')}</h2></BoxHead>
  <BoxBody className="space-y-3 px-5 py-4 text-[14px]"><p>{t('noLimits.v1.warning')}</p><p>{t('noLimits.followers.upgradeBody')}</p>{list}{error&&<p role="alert" className="text-danger">{error}</p>}</BoxBody>
  <BoxFoot className="flex justify-end gap-2 px-5 py-4"><button type="button" data-layer-cancel disabled={saving} onClick={dismiss} className="rounded-md bg-control px-3 py-2 text-[13px]">{t('noLimits.followers.keep')}</button>{action}</BoxFoot>
 </div></div></LayerSurface>;
 return <section className="rounded-xl bg-card p-4" aria-label={t('noLimits.followers.title')}>
  <p className="text-[14px] text-ink">{t('noLimits.followers.counts',{bots:status.bots,routines:status.routines})}</p>{list}
  <div className="mt-3">{action}</div>{error&&<p role="alert" className="mt-2 text-danger">{error}</p>}
 </section>;
}
