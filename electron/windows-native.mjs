// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The engine-exclusion addon (native/engine-exclusion/exclusion.c, version 9) for Electron's own Windows calls that used to start
// PowerShell (murage-releases #1): a folder's drive type and format (backup-folder-check.mjs), a process's exact creation time
// (data-dir-lease.mjs), a file's owner SID and the computer's domains (backup-windows-acl.mjs), the update signature check
// (windows-update-signature.mjs). The packaged app's copy is
// <resources>/engine-exclusion.node; a source checkout uses dist-native/engine-exclusion/win32-<arch>/. A package without it is
// refused when it is assembled (scripts/engine-exclusion-resource.mjs), so a missing addon here means a source checkout without a
// build, and the callers then refuse (they never start PowerShell instead).
import {createRequire} from "node:module";
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const WINDOWS_NATIVE_VERSION=9;
const here=path.dirname(fileURLToPath(import.meta.url));
let loaded;
function candidates(){
 const out=[];
 if(typeof process.resourcesPath==="string"&&process.resourcesPath)out.push(path.join(process.resourcesPath,"engine-exclusion.node"));
 const resources=process.env.MURAGE_RESOURCES_PATH;
 if(resources)out.push(path.join(resources,"engine-exclusion.node"));
 out.push(path.join(here,"..","dist-native","engine-exclusion",`${process.platform}-${process.arch}`,"engine-exclusion.node"));
 return out;
}
/** The addon, or null (not Windows, not there, or another version). Looked for once. */
export function windowsNative(){
 if(loaded!==undefined)return loaded;
 loaded=null;
 if(process.platform!=="win32")return loaded;
 const require=createRequire(import.meta.url);
 for(const file of candidates()){
  if(!existsSync(file))continue;
  try{const addon=require(file);if(typeof addon?.version==="function"&&addon.version()===WINDOWS_NATIVE_VERSION){loaded=addon;break;}}
  catch{/* the next candidate */}
 }
 return loaded;
}
/** Test seam: look again on the next use. */
export function forgetWindowsNative(){loaded=undefined;}
