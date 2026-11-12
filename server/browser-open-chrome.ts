import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { browserCopy } from '../shared/browser-copy.ts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/** Owner-only fixed launch. No page, command, profile or flag comes from a request. */
export async function openOwnerChrome(platform: NodeJS.Platform = process.platform): Promise<void> {
  let command: string; let args: string[]=[];
  if(platform==='darwin'){command='/usr/bin/open';args=['-a','Google Chrome'];}
  else if(platform==='win32'){
    const candidates=[process.env.LOCALAPPDATA,process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)']].filter((root):root is string=>!!root).map(root=>join(root,'Google','Chrome','Application','chrome.exe'));
    const found=candidates.find(existsSync);if(!found)throw new Error(browserCopy("browser.server.browser-open-chrome.2"));command=found;
  }else{
    const found=['/usr/bin/google-chrome-stable','/usr/bin/google-chrome'].find(existsSync);if(!found)throw new Error(browserCopy("browser.server.browser-open-chrome.3"));command=found;
  }
  await new Promise<void>((resolve,reject)=>{const child=spawn(command,[...args],withHideInherit({detached:true,stdio:'ignore',windowsHide:false}));child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
}
