import { basename } from 'node:path';
import { parkReason, type ParkReason } from './park-fs.ts';
import { parkSignalForDowngrade, type ParkOptions } from './park.ts';
import { setAsideConnectors } from '../../connector-set-aside.ts';
import { SIGNAL_DOWNGRADE_KEPT } from '../../../shared/signal-kept-copy.ts';
export class SignalDowngradeError extends Error{
 readonly code='SIGNAL_PRESERVATION_REQUIRED';
 readonly stage:'read-only'|'metadata'|'moved'; readonly reason:ParkReason;
 constructor(stage:'read-only'|'metadata'|'moved',reason:ParkReason){super(signalDowngradeRefusal(stage,reason));this.stage=stage;this.reason=reason;}
}
export function signalDowngradeRefusal(stage:SignalDowngradeError['stage'],reason:ParkReason){
 const prefix=stage==='moved'?'Murage stopped after moving some Signal files. The files are kept in your data folder.':stage==='metadata'?'Murage saved the recovery details. No Signal files were moved.':'No Signal files were moved.';
 const line=reason==='busy'?'Signal may still be running on this computer. Quit Murage, wait a minute, and open it again. If this stays, restart your computer.':reason==='adoption'?'Murage cannot check whether an earlier Signal process has stopped on this computer. Your Signal files are kept. Keep Signal paused until Murage can check.':reason==='device'?'The Signal files span two disks. Keep this data folder on one disk before trying again.':reason==='durability'?'Murage could not confirm the last step was saved to disk. Run this step again.':reason==='changed'?'The Signal files changed during this step. Open this version of Murage and check Signal in Settings.':reason==='conflict'?'Murage could not account for all the Signal files. Open this version of Murage and check Signal in Settings.':'Murage could not check the Signal files. Open this version of Murage and check Signal in Settings.';
 return `${prefix} ${line}`;
}
export function preserveSignalForDowngrade(root:string,options:ParkOptions={}){
 let stage:SignalDowngradeError['stage']='read-only';
 const checkedOptions:ParkOptions={...options,deadline:options.deadline??Date.now()+25_000,after:(op,path)=>{if(op==='rename'&&['signal','channels-signal'].includes(basename(path)))stage='moved';else if(stage==='read-only'&&['write','mkdir','temp','metadata-rename'].includes(op))stage='metadata';options.after?.(op,path);}};
 try{
  const signal=parkSignalForDowngrade(root,checkedOptions);
  const connector=setAsideConnectors(root,checkedOptions);
  // Always surface the accepted ordinary directory-durability limit honestly.
  const limited=signal.durabilityLimited||connector?.durabilityLimited;
  return{...(signal.parked?{signalKept:SIGNAL_DOWNGRADE_KEPT}:{}),...(limited?{signalDirectoryDurability:'unsupported' as const}:{})};
 }catch(error){throw new SignalDowngradeError(stage,parkReason(error));}
}
