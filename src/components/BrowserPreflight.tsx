import { t } from '@/lib/i18n';
// SPDX-License-Identifier: AGPL-3.0-or-later
import {useEffect,useState} from 'react';
import {api} from '@/state/store';
import type {BrowserSetupPreflight} from '../../shared/browser-setup-preflight';
type Props={botId:string;route:'chrome-extension'|'chrome-direct';browser:'chrome'|'edge'|'brave'};
const names={chrome:'Chrome',edge:'Edge',brave:'Brave'};
export function BrowserPreflight({botId,route,browser}:Props){
 const [check,setCheck]=useState<BrowserSetupPreflight|null>(null),[copied,setCopied]=useState(false);
 useEffect(()=>{let alive=true;setCheck(null);void api(`/api/bots/${encodeURIComponent(botId)}/browser-choice/preflight?route=${route}&browser=${browser}`).then(result=>{if(alive)setCheck(result);}).catch(()=>{if(alive)setCheck({browser,minimum:route==='chrome-direct'?144:151,status:'unknown'});});return()=>{alive=false;};},[botId,route,browser]);
 return <div className="text-sm" role="status"><p>{!check?t('browser.checkingVersion',{browser:names[browser]}):check.status==='supported'?t('browser.versionReady',{browser:names[browser],major:check.major??0}):check.status==='update_required'?t('browser.versionUpdate',{browser:names[browser],minimum:check.minimum,major:check.major??0}):t('browser.versionUnknown',{browser:names[browser],minimum:route==='chrome-direct'?144:151})}</p>{route==='chrome-direct'&&<><p>{t("browser.BrowserPreflight.1")}</p><button onClick={()=>void navigator.clipboard.writeText('chrome://inspect/#remote-debugging').then(()=>setCopied(true)).catch(()=>setCopied(false))}>{copied?t('browser.copied'):t('browser.copyLink')}</button></>}</div>;
}
