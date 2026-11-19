// SPDX-License-Identifier: AGPL-3.0-or-later
// Descriptor producer owners: Electron host, Cloud pre-start helper, installer.
// Descriptor absence consumer owner: P2 (this server-side boundary).
import {lstatSync,realpathSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {sentinelInstallationIdOf} from "../shared/sentinel-installation.mjs";
import {defaultOutputRoot,DESCRIPTOR_FILE} from "./sentinel/paths.ts";

let present=false;
export const sentinelPresenceObserved=()=>present;
/** An explicit launcher/IPC event also proves a Sentinel writer exists. */
export function noteSentinelPresent():void{present=true;}
const missing=(error:unknown)=>!!error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT";
/** Environment values locate artifacts only; no environment value qualifies
 * coverage. Resolve the canonical installation and output exactly as owner reads
 * do, without importing application config or creating any directories. */
export function sentinelDescriptorState():"PRESENT"|"ABSENT_PROVEN" {
 if(present)return "PRESENT";
 try{
  const env=process.env;
  // os.homedir() can fall back to the account database without HOME. That is
  // not evidence of where this launcher's installation/state was configured.
  const home=process.platform==="win32"?env.USERPROFILE:env.HOME;
  if(!env.MURAGE_SENTINEL_STATE_DIR&&!env.XDG_STATE_HOME&&!env.LOCALAPPDATA&&!home)return "PRESENT";
  const dataDir=env.MURAGE_DATA_DIR??(home?join(homedir(),".murage"):undefined);
  if(!dataDir)return "PRESENT";
  const canonical=realpathSync.native(dataDir);
  if(!lstatSync(canonical).isDirectory())return "PRESENT";
  const installationId=sentinelInstallationIdOf(canonical);
  const outputRoot=defaultOutputRoot(installationId,{env});
  if(!outputRoot)return "PRESENT";
  try{
   // Any descriptor (including a link/non-file) establishes presence forever.
   lstatSync(join(outputRoot,DESCRIPTOR_FILE));present=true;return "PRESENT";
  }catch(error){if(!missing(error))return "PRESENT";}
  try{
   const root=lstatSync(outputRoot);
   return root.isDirectory()&&!root.isSymbolicLink()?"ABSENT_PROVEN":"PRESENT";
  }catch(error){return missing(error)?"ABSENT_PROVEN":"PRESENT";}
 }catch{return "PRESENT";}
}
