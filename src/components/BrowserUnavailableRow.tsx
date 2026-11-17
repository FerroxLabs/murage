import { BrowserRecoveryAction } from './BrowserRecoveryAction';
import { writeComputerPanelView } from '@/lib/computer-panel-view';
import { readBrowserFailure } from '../../shared/browser-choice-eligibility';
import { api, useStore } from '@/state/store';
import {useState} from 'react';
import { BrowserChoice } from './BrowserChoice';
import { GlobeLock } from "lucide-react";
import { t } from "@/lib/i18n";
import { browserUnavailableKind } from "../../shared/browser-unavailable";

const SUMMARY_KEY = {
  "user-chrome": "browserUnavailable.userChrome",
  "user-chrome-allow": "browserUnavailable.userChromeAllow",
  held: "browserUnavailable.held",
  checking: "browserUnavailable.checking",
  checked: "browserUnavailable.checked",
  unfinished: "browserUnavailable.unfinished",
  "check-failed": "browserUnavailable.checkFailed",
  paused: "browserUnavailable.paused",
  "timed-out": "browserUnavailable.timedOut",
  failed: "browserUnavailable.failed",
} as const;
const NO_DETAILS = new Set<string>(["user-chrome", "user-chrome-allow", "held", "checking", "checked", "unfinished", "check-failed", "paused"]);

/** A turn that ran without the built-in browser, said in plain words, with
 * the engine's own reason one click away. Neutral, like FolderTrustRow: not a
 * tool run (so it stays visible with Settings → Tool calls off) and not an
 * error — the turn itself went ahead.
 *
 * Wrapping is ordinary word wrapping; `overflow-wrap: anywhere` breaks only a
 * token too long for the line (a URL, an error code). The tool chips' shared
 * `break-all` split plain words mid-word on a 390px phone. */
export function BrowserUnavailableRow({ reason, botName, botId }: { reason: string; botName?: string; botId?:string }) {
  const kind = browserUnavailableKind(reason), failure=readBrowserFailure(reason);
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="browser-unavailable-row"
        className="flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary"
      >
        <span className="mt-[3px] shrink-0" aria-hidden="true"><GlobeLock size={12} className="opacity-70" /></span>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <span>{failure?.code==='browser_release_failed'?t('browser.releaseFailed',{name:botName||t('browserUnavailable.thisBot')}):failure?t(failure.messageKey):t(SUMMARY_KEY[kind], { bot: botName || t("browserUnavailable.thisBot") })}</span>
          {failure&&(failure.code==='browser_extension_setup_required'&&botId?<BrowserFinishSetup botId={botId}/>:failure.code==='browser_release_failed'&&botId?<BrowserReleaseRetry botId={botId}/>:<BrowserRecoveryAction botId={botId??''} code={failure.code}/>)}
          {failure?.offer&&botId&&<BrowserFailureChoice botId={botId}/>}
          {!NO_DETAILS.has(kind) && (
            <details className="mt-0.5 text-[12px]">
              <summary className="cursor-pointer select-none">{t("browserUnavailable.details")}</summary>
              <span className="font-mono">{failure?.details??reason}</span>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function BrowserFailureChoice({botId}:{botId:string}){const {state}=useStore();const bot=state.bots.find(b=>b.id===botId);return bot?<BrowserChoice bot={bot} compact/>:null;}

function BrowserFinishSetup({botId}:{botId:string}){
 const {dispatch}=useStore();
 return <button onClick={()=>{writeComputerPanelView(botId,'browser');dispatch({type:'select',id:botId});dispatch({type:'toggleComputer',open:true});}}>{t('browser.finishSetup')}</button>;
}

function BrowserReleaseRetry({botId}:{botId:string}){
 const [pending,setPending]=useState(false),[error,setError]=useState('');
 return <><button disabled={pending} onClick={()=>{setPending(true);setError('');void api(`/api/bots/${encodeURIComponent(botId)}/browser-choice/retry`,{method:'POST',body:'{}'}).then(result=>{if(result.bot?.browserRelease)setError(result.bot.browserRelease.reason??t('browser.releaseWaiting'));}).catch(e=>setError(String(e))).finally(()=>setPending(false));}}>{t('browser.retry')}</button>{error&&<p role="alert">{error}</p>}</>;
}
