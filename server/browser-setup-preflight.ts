import { withHideInherit } from "../shared/win-hide-child-process.mjs";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserSetupPreflight } from '../shared/browser-setup-preflight.ts';
const exec = promisify(execFile);
type Browser = BrowserSetupPreflight['browser'];
type Command = (file:string,args:string[])=>Promise<string>;
const command:Command = async(file,args)=>(await exec(file,[...args],withHideInherit({timeout:2000,maxBuffer:16384,windowsHide:true}))).stdout;
/** Read the selected installed browser's version without opening a page or
 * changing a selection. Unknown is never treated as a successful check. */
export async function browserSetupPreflight(options:{browser:Browser;route:'chrome-extension'|'chrome-direct';platform?:NodeJS.Platform;cloudHome?:boolean;command?:Command}):Promise<BrowserSetupPreflight>{
  const {browser,route}=options, minimum=route==='chrome-extension'?151:144;
  const unknown:BrowserSetupPreflight={browser,minimum,status:'unknown'};
  if(options.cloudHome)return unknown;
  const platform=options.platform??process.platform,run=options.command??command;
  const candidates:[string,string[]][]=[];
  if(platform==='darwin'){
    const name={chrome:'Google Chrome',edge:'Microsoft Edge',brave:'Brave Browser'}[browser];
    candidates.push(['/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',`/Applications/${name}.app/Contents/Info.plist`]]);
  }else if(platform==='win32'){
    const product={chrome:'Google\\Chrome',edge:'Microsoft\\Edge',brave:'BraveSoftware\\Brave-Browser'}[browser];
    for(const hive of ['HKCU','HKLM'])candidates.push(['reg.exe',['query',`${hive}\\Software\\${product}\\BLBeacon`,'/v','version']]);
  }else if(platform==='linux'){
    const names={chrome:['google-chrome-stable','google-chrome'],edge:['microsoft-edge-stable','microsoft-edge'],brave:['brave-browser']}[browser];
    for(const name of names)candidates.push([`/usr/bin/${name}`,['--version']]);
  }
  for(const [file,args] of candidates){
    try{
      const text=await run(file,args),version=/\b(\d{2,3}\.\d+\.\d+\.\d+)\b/.exec(text)?.[1];
      if(!version)continue;
      const major=Number(version.split('.')[0]);
      return {browser,minimum,version,major,status:major>=minimum?'supported':'update_required'};
    }catch{/* Try the next known installation, then show an honest unknown. */}
  }
  return unknown;
}
