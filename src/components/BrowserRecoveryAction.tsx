import { useState } from 'react';
import { api, useStore } from '@/state/store';
import { t } from '@/lib/i18n';
import { browserOwnerFields } from '@/lib/browser-owner-request';
import { writeComputerPanelView } from '@/lib/computer-panel-view';
import { browserFailure } from '../../shared/browser-choice-eligibility';
export function BrowserRecoveryAction({botId,code}:{botId:string;code:string}){
 const {dispatch}=useStore();const [pending,setPending]=useState(false),[error,setError]=useState('');
 const failure=browserFailure(code),base=`/api/bots/${encodeURIComponent(botId)}/browser`;
 const run=async()=>{
  setPending(true);setError('');
  try{
   if(code==='browser_sandbox_enable')await api('/api/browser/linux-sandbox/enable',{method:'POST',body:'{}'});
   else if(code==='builtin_restart'||code==='builtin_check_failed'||code==='builtin_page_locked'){
    let status=await api(base);
    const act=async(action:string)=>api(base,{method:'POST',body:JSON.stringify({action,...browserOwnerFields(status),generation:status.generation,control:status.control})});
    if(code==='builtin_page_locked'&&!status.held)status=await act('take');
    await act(code==='builtin_page_locked'?'reopen':'restart');
   }else if(code==='chrome_closed'||code==='host_offline'||code==='allow_not_given')await api(`/api/bots/${encodeURIComponent(botId)}/browser-choice/open-chrome`,{method:'POST',body:'{}'});
   else if(code==='debugging_off')await navigator.clipboard.writeText('chrome://inspect/#remote-debugging');
   else{writeComputerPanelView(botId,'browser');dispatch({type:'select',id:botId});dispatch({type:'toggleComputer',open:true});}
  }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setPending(false);}
 };
 if(!botId)return <span>{t(failure.actionKey)}</span>;
 if(code==='builtin_missing')return <a href="https://github.com/FerroxLabs/murage-releases/releases/latest" target="_blank" rel="noopener noreferrer">{t(failure.actionKey)}</a>;
 return <><button disabled={pending} onClick={()=>void run()}>{t(failure.actionKey)}</button>{error&&<p role="alert">{error}</p>}</>;
}
