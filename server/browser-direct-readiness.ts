import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userChromeListening } from './user-chrome.ts';
const exec = promisify(execFile);
export type ChromeRunning = boolean | 'unknown';
export function directReadiness(observation: { running: ChromeRunning; listening: boolean; connection: string }) {
  if (observation.connection === 'allowed' && observation.listening) return 'ready';
  if (observation.running === false) return 'chrome_closed';
  if (!observation.listening) return observation.running === true ? 'debugging_off' : 'chrome_status_unknown';
  return 'allow_not_given';
}
/** Read process names only. A failed process query is unknown, never closed. */
export async function chromeRunning(platform: NodeJS.Platform = process.platform, command = async (file:string,args:string[]) => (await exec(file,[...args],withHideInherit({timeout:2000,maxBuffer:1024*1024,windowsHide:true}))).stdout): Promise<ChromeRunning> {
  try {
    if(platform === 'win32') return /"chrome\.exe"/i.test(await command('tasklist.exe',['/FI','IMAGENAME eq chrome.exe','/FO','CSV','/NH']));
    if(platform === 'darwin') return (await command('/bin/ps',['-axo','comm='])).split('\n').some(line=>line.trim().endsWith('/Google Chrome.app/Contents/MacOS/Google Chrome'));
    if(platform === 'linux') return (await command('/bin/ps',['-eo','comm='])).split('\n').some(line=>/^(chrome|google-chrome|google-chrome-stable)$/.test(line.trim()));
  } catch { /* Unreadable process evidence remains unknown. */ }
  return 'unknown';
}
export async function observeDirectReadiness(connection: string) {
  const [running,listening] = await Promise.all([chromeRunning(),userChromeListening()]);
  return directReadiness({running,listening:listening==='listening',connection});
}

/** A restarted Chrome has a new endpoint and needs a fresh Allow. */
export function directConnectionState(proxy:{chromeEndpoint:string;state:string}|undefined,endpoint:string|null){return proxy&&proxy.chromeEndpoint===endpoint?proxy.state:'absent';}
