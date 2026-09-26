// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner-only access on Windows for off-site backup secrets and work folders.
// POSIX builds use mode 0600/0700 and a uid check; Windows has neither, so
// the files' ACL is replaced with one explicit full-control grant for the
// signed-in user's SID, with inheritance removed. OpenSSH for Windows accepts
// a private key only when no other principal can read it, and this is the
// ACL it expects. Tools run by absolute System32 path, never PATH.
import {spawnSync} from "node:child_process";

const system32=()=>{const root=process.env.SystemRoot;if(typeof root!=="string"||!/^[A-Za-z]:\\[^"\x00-\x1f]*$/.test(root))throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");return `${root.replace(/\\+$/,"")}\\System32`;};
const run=(file,args)=>spawnSync(file,args,{encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:1024*1024});
let cachedSid=null;
/** The signed-in user's SID, from whoami /user. */
export function currentUserSid({runTool=run}={}){
 if(cachedSid)return cachedSid;
 const result=runTool(`${system32()}\\whoami.exe`,["/user","/fo","csv","/nh"]);
 const sid=/"(S-1-5-21-\d+-\d+-\d+-\d+)"\s*$/m.exec(String(result.stdout??""))?.[1];
 if(result.status!==0||!sid)throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");
 return cachedSid=sid;
}
/** icacls arguments that leave exactly one ACE: the owner, full control.
 * Folders pass it on to everything created inside them. */
export function ownerOnlyIcaclsArguments(target,sid,{directory}){
 if(typeof target!=="string"||!/^[A-Za-z]:\\/.test(target)||/["\x00-\x1f]/.test(target))throw Error("BACKUP_WINDOWS_ACL_PATH_INVALID");
 if(!/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid))throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");
 return [target,"/inheritance:r","/grant:r",`*${sid}:${directory?"(OI)(CI)F":"F"}`,"/q"];
}
/** Only ACEs for the owner remain; icacls /save lists them in SDDL. */
export function sddlIsOwnerOnly(sddl,sid){
 // "D:" flags then ACEs; a SACL section, if any, starts with "S:(".
 const dacl=/D:(.*?)(?:S:\(|$)/.exec(String(sddl).trim())?.[1];if(!dacl||!/^P/.test(dacl))return false;
 const aces=[...dacl.matchAll(/\(([^)]*)\)/g)].map(match=>match[1]);
 return aces.length>0&&aces.every(ace=>{const parts=ace.split(";");return parts[0]==="A"&&parts.at(-1)===sid;});
}
/** Restricts `target` to the owner and verifies the result. Windows only. */
export function restrictToOwner(target,{directory=false,runTool=run,readSddl}={}){
 if(process.platform!=="win32"&&!readSddl)return;
 const sid=currentUserSid({runTool}),icacls=`${system32()}\\icacls.exe`;
 const set=runTool(icacls,ownerOnlyIcaclsArguments(target,sid,{directory}));if(set.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");
 const sddl=readSddl?readSddl(target):powershellSddl(target,runTool);
 if(!sddlIsOwnerOnly(sddl,sid))throw Error("BACKUP_WINDOWS_ACL_FAILED");
}
function powershellSddl(target,runTool){
 const powershell=`${system32()}\\WindowsPowerShell\\v1.0\\powershell.exe`;
 const script="$p=$env:MURAGE_ACL_TARGET;(Get-Acl -LiteralPath $p).GetSecurityDescriptorSddlForm('Access')";
 const result=spawnSync(powershell,["-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",windowsHide:true,timeout:20000,env:{SystemRoot:process.env.SystemRoot,MURAGE_ACL_TARGET:target}});
 if(result.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");
 return String(result.stdout).trim();
}
