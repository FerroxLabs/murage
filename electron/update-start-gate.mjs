import { INSTALL_WAIT_MS } from "./mac-install-guard.mjs";
export const refusal = code => Object.assign(new Error(code), {code});
/** One clock for elapsed time and scheduled ticks. No observations while an exit owns the process. */
export function runStartGate({authority, settle, startReturn, pause, now=Date.now, schedule=setTimeout, clear=clearTimeout}) {
  const started=now(); let timer=null, finished=false;
  const stop=()=>{finished=true;if(timer!==null)clear(timer);timer=null;};
  authority.cancelGate=stop;
  const tick=()=>{
    timer=null;
    if(finished||authority.userQuitRequested||authority.leaving){stop();return;}
    if(authority.attempt){stop();return authority.attempt.promise;}
    let verdict;
    try{verdict=settle();}catch(error){verdict=/BUSY/.test(error?.code??error?.message)?{kind:"busy"}:{kind:"review"};}
    if(verdict.kind==="installing"||verdict.kind==="busy"){
      if(now()-started<INSTALL_WAIT_MS){timer=schedule(tick,1000);return;}
      stop();pause(verdict.kind==="installing"?"BACKUP_UPGRADE_STAGED":"BACKUP_BUSY");return;
    }
    stop();
    if(verdict.kind==="cancel"||verdict.kind==="none"||verdict.kind==="landed")return startReturn(verdict);
    pause("BACKUP_UPGRADE_REVIEW_REQUIRED",verdict.reason);
  };
  tick();return stop;
}
