// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner-only access on Windows for off-site backup secrets and work folders.
// POSIX builds use mode 0600/0700 and a uid check; Windows has neither, so
// the files' ACL is replaced with one explicit full-control grant for the
// signed-in user's SID, with inheritance removed. OpenSSH for Windows accepts
// a private key only when no other principal can read it, and this is the
// ACL it expects. Tools run by absolute System32 path, never PATH.
import {spawnSync,execFile} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join as joinPath} from "node:path";
import {aclFail as sharedAclFail,parseSddlAcl as parseSharedSddlAcl,savedAclEntries} from "../shared/windows-sddl.mjs";
import {windowsNative} from "./windows-native.mjs";

const system32=()=>{const root=process.env.SystemRoot;if(typeof root!=="string"||!/^[A-Za-z]:\\[^"\x00-\x1f]*$/.test(root))throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");return `${root.replace(/\\+$/,"")}\\System32`;};
// No PowerShell anywhere in this file (murage-releases #1: an antivirus notice and a visible PowerShell start per call):
// only plain System32 programs (whoami, icacls), each run by absolute path, and the engine-exclusion addon for what no
// program's output can be trusted to say (a file's owner, the volume's file system, the computer's domains). A slow or
// busy machine can still take a while to start one, so wait up to a minute.
const run=(file,args,options={})=>spawnSync(file,args,{encoding:"utf8",windowsHide:true,timeout:60000,maxBuffer:1024*1024,...options});
// The same tools, without blocking: the password store runs in Electron's
// main process, where spawnSync froze the window for each PowerShell start
// (about 3.5 s) and, called right after the native file dialog and message
// box, never returned at all on Windows Server 2025 (the dialog's shell work
// waits for the main thread that spawnSync holds). Resolves, never rejects.
const runAsync=(file,args,options={})=>new Promise(resolve=>{
 try{execFile(file,args,{encoding:"utf8",windowsHide:true,timeout:60000,maxBuffer:1024*1024,...options},(error,stdout)=>resolve({status:error?(Number.isInteger(error.code)?error.code:1):0,stdout:String(stdout??"")}));}
 catch{resolve({status:1,stdout:""});}
});

// The account SIDs a signed-in person can have (W-A1). Both shapes are an
// authority prefix and exactly four 32-bit sub-authorities:
//  - S-1-5-21-<a>-<b>-<c>-<rid>: a local account, a domain (Active Directory)
//    account, and a local account linked to a Microsoft account (the link adds
//    the S-1-11-96-… group to the token; the user SID stays S-1-5-21);
//  - S-1-12-1-<a>-<b>-<c>-<d>: an Entra ID (Azure AD) account, typical of
//    company laptops. Accepting only S-1-5-21 failed every off-site step there.
// Well-known and group SIDs (SYSTEM, Everyone, Users, …) are never an owner.
const USER_SID=/^S-1-(?:5-21|12-1)((?:-(?:0|[1-9]\d{0,9})){4})$/;
export function isUserSid(sid){
 const match=typeof sid==="string"?USER_SID.exec(sid):null;
 return Boolean(match)&&match[1].slice(1).split("-").every(part=>Number(part)<=0xffffffff);
}
let cachedSid=null;
/** The SID of the user this process runs as: the TokenUser of the process
 * token, which is what whoami /user prints. */
export function currentUserSid({runTool=run}={}){
 if(cachedSid)return cachedSid;
 // CSV, no header: "<domain>\<name>","<sid>". The name may hold commas or
 // non-ASCII text in the console code page; the SID is always the last field.
 const result=runTool(`${system32()}\\whoami.exe`,["/user","/fo","csv","/nh"]);
 const line=String(result?.stdout??"").split(/\r?\n/).map(text=>text.trim()).filter(Boolean).at(-1)??"";
 let sid=/,"(S-1-[0-9-]+)"$/.exec(line)?.[1];
 // whoami is the token's own answer; there is no second source that does not start a script host, so a failure is a refusal.
 if(result?.status!==0||!isUserSid(sid))throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");
 return cachedSid=sid;
}
/** Test seam: forget the cached SID. */
export function resetCurrentUserSid(){cachedSid=null;}
/** icacls arguments that leave exactly one ACE: the owner, full control.
 * The SID goes in its *S-1-… form, never a name, so icacls needs no lookup.
 * Folders pass it on to everything created inside them. */
export function ownerOnlyIcaclsArguments(target,sid,{directory}){
 if(typeof target!=="string"||!/^[A-Za-z]:\\/.test(target)||/["\x00-\x1f]/.test(target))throw Error("BACKUP_WINDOWS_ACL_PATH_INVALID");
 if(!isUserSid(sid))throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");
 return [target,"/inheritance:r","/grant:r",`*${sid}:${directory?"(OI)(CI)F":"F"}`,"/q"];
}
/** Only ACEs for the owner remain; icacls /save lists them in SDDL. */
export function sddlIsOwnerOnly(sddl,sid){
 // "D:" flags then ACEs; a SACL section, if any, starts with "S:(".
 const dacl=/D:(.*?)(?:S:\(|$)/.exec(String(sddl).trim())?.[1];if(!dacl||!/^P/.test(dacl))return false;
 const aces=[...dacl.matchAll(/\(([^)]*)\)/g)].map(match=>match[1]);
 return aces.length>0&&aces.every(ace=>{const parts=ace.split(";");return parts[0]==="A"&&parts.at(-1)===sid;});
}

// The ACL is read with icacls /save, which writes the DACL as SDDL (locale-independent, unlike icacls' own listing), parsed by
// shared/windows-sddl.mjs into SIDs, so every comparison below is by SID, never by name. The result is one object:
//   owner     the owner's SID, or null when it was not asked for or could not be told (see readOwnerSid);
//   protected inheritance removed (the DACL's P flag);
//   rules     [{allow, sid, mask, inherited, inheritOnly}] in the file's order.
// Anything the parser does not recognise fails closed. A numeric SID is taken as written; a domain-relative alias resolves only
// against the domain Windows means, read by the addon (domainSids: this computer's account domain, the joined domain, its forest
// root), never against the signed-in user's or this computer's SID in its place; one that cannot be resolved is refused with a
// plain sentence in the error's `fix` (shared/windows-sddl.mjs UNKNOWN_ACCOUNT_FIX).
const aclFail=()=>sharedAclFail();
/** The addon's domainSids(), or null (no addon, or the policy could not be read): then only numeric SIDs and fixed aliases resolve. */
export function domainSidsOf(native=windowsNative()){
 try{const domains=typeof native?.domainSids==="function"?native.domainSids():null;return domains&&typeof domains==="object"?domains:null;}catch{return null;}
}
/** Parses the DACL line icacls /save writes ("D:PAI(A;OICIID;FA;;;BA)…"). `domains` resolves the domain-relative aliases. */
export function parseSddlAcl(sddl,{domains=domainSidsOf()}={}){
 return parseSharedSddlAcl(sddl,{domains});
}
/** The icacls arguments that write the target's DACL to `file` (UTF-16, one line for the name and one for the SDDL). */
export function aclSaveArguments(target,file){
 if(typeof target!=="string"||!/^[A-Za-z]:\\/.test(target)||/["\x00-\x1f]/.test(target))throw Error("BACKUP_WINDOWS_ACL_PATH_INVALID");
 return [target,"/save",file,"/q"];
}
/** What icacls /save wrote for one file: its SDDL line. */
export function sddlFromSavedAcl(bytes){
 const entries=savedAclEntries(bytes);
 if(entries.length!==1)throw aclFail();
 return entries[0].sddl;
}
const readSavedFile=file=>readFileSync(file);
/** Runs icacls /save into a private temp folder, hands back the SDDL and removes the folder. */
function withSavedAcl(target,runTool,readSaved,domains){
 const folder=mkdtempSync(joinPath(tmpdir(),"murage-acl-"));
 try{
  const file=joinPath(folder,"acl.txt");
  const result=runTool(`${system32()}\\icacls.exe`,aclSaveArguments(target,file));
  if(result?.status!==0)throw aclFail();
  return parseSddlAcl(sddlFromSavedAcl(readSaved(file)),{domains});
 }finally{try{rmSync(folder,{recursive:true,force:true});}catch{/* a leftover private temp folder holds only an ACL line */}}
}
async function withSavedAclAsync(target,runTool,readSaved,domains){
 const folder=mkdtempSync(joinPath(tmpdir(),"murage-acl-"));
 try{
  const file=joinPath(folder,"acl.txt");
  const result=await runTool(`${system32()}\\icacls.exe`,aclSaveArguments(target,file));
  if(result?.status!==0)throw aclFail();
  return parseSddlAcl(sddlFromSavedAcl(readSaved(file)),{domains});
 }finally{try{rmSync(folder,{recursive:true,force:true});}catch{/* a leftover private temp folder holds only an ACL line */}}
}

// The owner is not in what icacls /save writes. It is read as a SID by the engine-exclusion addon's fileOwnerSid (GetSecurityInfo on
// the file itself, a link not followed), and only there: no owner is ever read from a program's output or taken from the end of an
// account name. Without the addon the owner is unknown (null), and an unknown owner is refused by aclIsPrivateToOwner.
const SID_TEXT=/^S-1-\d+(?:-\d+)+$/;
/** The owner's SID of a file, or null (see above). Windows only. */
export function readOwnerSid(target,{native=windowsNative()}={}){
 if(typeof native?.fileOwnerSid!=="function")return null;
 try{const sid=native.fileOwnerSid(target);return typeof sid==="string"&&SID_TEXT.test(sid)?sid:null;}catch{return null;}
}
export async function readOwnerSidAsync(target,options={}){return readOwnerSid(target,options);}
/** The ACL of `target` as SIDs. `withOwner` also reads the owner (one more plain program), which only
 * assertPrivateToOwner needs. `readSaved` is the test seam for the file icacls writes. */
export function readAcl(target,{runTool=run,readSaved=readSavedFile,withOwner=false,native=windowsNative()}={}){
 if(typeof target!=="string"||/[\x00-\x1f]/.test(target))throw Error("BACKUP_WINDOWS_ACL_PATH_INVALID");
 const acl=withSavedAcl(target,runTool,readSaved,domainSidsOf(native));
 return withOwner?{...acl,owner:readOwnerSid(target,{native})}:acl;
}
/** What restrictToOwner leaves: inheritance removed and every entry an
 * allow for the owner. SYSTEM and Administrators are not listed either. */
export function aclIsOwnerOnly(acl,sid){
 return Boolean(acl?.protected)&&acl.rules.length>0&&acl.rules.every(rule=>rule.allow&&rule.sid===sid);
}
// The Windows form of "no group or other bits" for a file the person chose
// (W-A5). The machine's own administrators, SYSTEM and "the file's owner"
// count like root on Mac and Linux, which can always read a file too; any
// other account or group (Users, Everyone, Authenticated Users, another
// person) that may read, write or re-permission the file makes it shared.
// SYSTEM, Administrators and TrustedInstaller (the account Windows' own files belong to), by SID.
const ROOT_LIKE=new Set(["S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);
const OWNER_ALIASES=new Set(["S-1-3-0","S-1-3-4"]); // CREATOR OWNER, OWNER RIGHTS
// Rights that reveal nothing and change nothing: synchronize, read the
// security descriptor, read attributes and extended attributes.
const HARMLESS=0x00100000|0x00020000|0x00000080|0x00000008;
export function aclIsPrivateToOwner(acl,sid){
 if(!acl||!(acl.owner===sid||ROOT_LIKE.has(acl.owner)))return false;
 return acl.rules.every(rule=>!rule.allow||rule.sid===sid||ROOT_LIKE.has(rule.sid)||OWNER_ALIASES.has(rule.sid)||(rule.mask&~HARMLESS)===0);
}
// /inheritance:r drops inherited entries and /grant:r replaces only the
// owner's own, so an entry written explicitly on the file or folder itself
// survives both. Windows writes explicit entries whenever the parent passes
// nothing down: a new file then gets the creating token's default ACL (for
// an administrator: SYSTEM, Administrators and the user), which left the
// result shared and every owner-only step failed. Those are removed by SID.
const explicitOthers=(acl,sid)=>[...new Set(acl.rules.filter(rule=>!rule.inherited&&rule.sid!==sid).map(rule=>rule.sid))];
/** icacls arguments that remove every entry (allow and deny) for `other`. */
export function removeIcaclsArguments(target,other){
 if(typeof target!=="string"||!/^[A-Za-z]:\\/.test(target)||/["\x00-\x1f]/.test(target))throw Error("BACKUP_WINDOWS_ACL_PATH_INVALID");
 if(typeof other!=="string"||!/^S-1-\d+(?:-\d+)+$/.test(other))throw Error("BACKUP_WINDOWS_ACL_FAILED");
 return [target,"/remove",`*${other}`,"/q"];
}
/** Restricts `target` to the owner and verifies the result. Windows only. */
export function restrictToOwner(target,{directory=false,runTool=run,readSddl,readAcl:readListing}={}){
 if(process.platform!=="win32"&&!readSddl&&!readListing)return;
 const sid=currentUserSid({runTool}),icacls=`${system32()}\\icacls.exe`;
 const set=runTool(icacls,ownerOnlyIcaclsArguments(target,sid,{directory}));if(set?.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");
 if(readSddl){if(!sddlIsOwnerOnly(readSddl(target),sid))throw Error("BACKUP_WINDOWS_ACL_FAILED");return;}
 const read=readListing??(file=>readAcl(file,{runTool}));
 let acl=read(target);const others=explicitOthers(acl,sid);
 if(others.length){for(const other of others)if(runTool(icacls,removeIcaclsArguments(target,other))?.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");acl=read(target);}
 if(!aclIsOwnerOnly(acl,sid))throw Error("BACKUP_WINDOWS_ACL_FAILED");
}
/** Refuses a file other accounts can read or change. Windows only. */
export function assertPrivateToOwner(target,{runTool=run,readAcl:readListing}={}){
 if(process.platform!=="win32"&&!readListing)return;
 const sid=currentUserSid({runTool});
 if(!aclIsPrivateToOwner((readListing??(file=>readAcl(file,{runTool,withOwner:true})))(target),sid))throw Error("BACKUP_WINDOWS_ACL_SHARED");
}
// A volume that has no ACLs (FAT, FAT32, exFAT: the usual USB stick). Its file system is the addon's driveInfo (GetVolumeInformationW
// on the volume that holds the path), never a word found in a program's output. Without the addon the answer cannot be had, and the
// save is refused (BACKUP_WINDOWS_ACL_UNAVAILABLE); a volume the addon cannot read is treated as keeping ACLs, so the owner-only
// step runs and refuses when it cannot be done.
const NO_ACL_FILE_SYSTEM=/^(?:FAT|FAT12|FAT16|FAT32|exFAT)$/i;
/** False only for a drive whose file system has no ACLs at all, where owner-only can't be expressed. Throws without the addon. */
export function volumeKeepsAcls(target,{native=windowsNative()}={}){
 if(typeof native?.driveInfo!=="function")throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");
 if(typeof target!=="string"||!/^[A-Za-z]:\\/.test(target)||/[\x00-\x1f]/.test(target))return true;
 let info=null;try{info=native.driveInfo(target);}catch{/* unclear: keeps ACLs */}
 return !(typeof info?.format==="string"&&NO_ACL_FILE_SYSTEM.test(info.format.trim()));
}

// Asynchronous forms for Electron's main process (see runAsync). Same rules,
// same results; runTool may be synchronous or return a promise.
export async function currentUserSidAsync({runTool=runAsync}={}){
 if(cachedSid)return cachedSid;
 const result=await runTool(`${system32()}\\whoami.exe`,["/user","/fo","csv","/nh"]);
 const line=String(result?.stdout??"").split(/\r?\n/).map(text=>text.trim()).filter(Boolean).at(-1)??"";
 let sid=/,"(S-1-[0-9-]+)"$/.exec(line)?.[1];
 if(result?.status!==0||!isUserSid(sid))throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");
 return cachedSid=sid;
}
export async function readAclAsync(target,{runTool=runAsync,readSaved=readSavedFile,withOwner=false,native=windowsNative()}={}){
 if(typeof target!=="string"||/[\x00-\x1f]/.test(target))throw Error("BACKUP_WINDOWS_ACL_PATH_INVALID");
 const acl=await withSavedAclAsync(target,runTool,readSaved,domainSidsOf(native));
 return withOwner?{...acl,owner:readOwnerSid(target,{native})}:acl;
}
export async function restrictToOwnerAsync(target,{directory=false,runTool=runAsync,readAcl:readListing}={}){
 if(process.platform!=="win32"&&!readListing)return;
 const sid=await currentUserSidAsync({runTool});
 const icacls=`${system32()}\\icacls.exe`;
 const set=await runTool(icacls,ownerOnlyIcaclsArguments(target,sid,{directory}));if(set?.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");
 const read=readListing??(file=>readAclAsync(file,{runTool}));
 let acl=await read(target);const others=explicitOthers(acl,sid);
 if(others.length){for(const other of others)if((await runTool(icacls,removeIcaclsArguments(target,other)))?.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");acl=await read(target);}
 if(!aclIsOwnerOnly(acl,sid))throw Error("BACKUP_WINDOWS_ACL_FAILED");
}
export async function assertPrivateToOwnerAsync(target,{runTool=runAsync,readAcl:readListing}={}){
 if(process.platform!=="win32"&&!readListing)return;
 const sid=await currentUserSidAsync({runTool});
 if(!aclIsPrivateToOwner(await (readListing??(file=>readAclAsync(file,{runTool,withOwner:true})))(target),sid))throw Error("BACKUP_WINDOWS_ACL_SHARED");
}
export async function volumeKeepsAclsAsync(target,options={}){return volumeKeepsAcls(target,options);}
