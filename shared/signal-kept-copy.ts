import type { SignalPreservation } from '../server/channels/signal/types.ts';
export function signalKeptCopy(p:SignalPreservation):string{
 if(p.progress==='busy')return 'Signal may still be running on this computer. Quit Murage, wait a minute, and open it again. If this stays, restart your computer.';
 if(p.progress==='adoption')return 'Murage cannot check whether an earlier Signal process has stopped on this computer. Your Signal files are kept. Keep Signal paused until Murage can check.';
 if(p.progress==='pending')return 'Murage kept your Signal files and is finishing disconnecting the earlier link here. Open Murage again to finish before linking Signal again.';
 if(p.progress==='durability')return 'Murage cannot confirm this choice is saved on this disk. Your Signal files are kept. Open Murage again before linking Signal.';
 if(p.progress==='ready')return 'Murage kept the earlier Signal files. You can link Signal again. Also remove the older Murage entry under Linked devices in Signal on your phone.';
 return p.dualCopy?'Murage paused Signal to preserve your connection. It found Signal files in two places and kept both. Nothing was removed.':'Murage paused Signal to preserve your connection. It could not account for all the Signal files in your data folder. The files it found are still there.';
}
export const SIGNAL_DOWNGRADE_KEPT='Your Signal connection is kept inside your Murage data folder while you use the older version. When you update Murage, it checks these files before using Signal again. If you remove Murage from Linked devices on your phone, Murage asks you to link again.';
