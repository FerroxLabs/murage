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
const run=(file,args,options={})=>spawnSync(file,args,{encoding:"utf8",windowsHide:true,timeout:20000,maxBuffer:1024*1024,...options});
const powershell=()=>`${system32()}\\WindowsPowerShell\\v1.0\\powershell.exe`;

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
 * token, which is what whoami /user prints (and, if whoami is unusable,
 * WindowsIdentity.GetCurrent().User reads the same token). */
export function currentUserSid({runTool=run}={}){
 if(cachedSid)return cachedSid;
 // CSV, no header: "<domain>\<name>","<sid>". The name may hold commas or
 // non-ASCII text in the console code page; the SID is always the last field.
 const result=runTool(`${system32()}\\whoami.exe`,["/user","/fo","csv","/nh"]);
 const line=String(result?.stdout??"").split(/\r?\n/).map(text=>text.trim()).filter(Boolean).at(-1)??"";
 let sid=/,"(S-1-[0-9-]+)"$/.exec(line)?.[1];
 if(result?.status!==0||!isUserSid(sid)){
  const fallback=runTool(powershell(),["-NoProfile","-NonInteractive","-Command","[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"]);
  sid=String(fallback?.stdout??"").trim();
  if(fallback?.status!==0||!isUserSid(sid))throw Error("BACKUP_WINDOWS_ACL_UNAVAILABLE");
 }
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

// The ACL as SIDs, never names or SDDL aliases: SDDL writes some accounts as
// two-letter aliases ("LA" for the built-in Administrator), which a SID
// compare would misread. One line each: O:<owner sid>, P:<1 when inheritance
// is removed>, then <0 allow|1 deny>;<sid>;<hex access mask>;<1 inherited>.
const ACL_SCRIPT=["$p=$env:MURAGE_ACL_TARGET","$a=Get-Acl -LiteralPath $p","$s=[Security.Principal.SecurityIdentifier]",
 "'O:'+$a.GetOwner($s).Value","'P:'+[int]$a.AreAccessRulesProtected",
 "foreach($r in $a.GetAccessRules($true,$true,$s)){'{0};{1};{2};{3}' -f [int]$r.AccessControlType,$r.IdentityReference.Value,[Convert]::ToString([int]$r.FileSystemRights,16),[int]$r.IsInherited}"].join(";");
/** Parses the lines ACL_SCRIPT prints. Anything unexpected fails closed. */
export function parseAclListing(text){
 const lines=String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const owner=/^O:(S-1-[0-9-]+)$/.exec(lines[0]??"")?.[1],protectedFlag=/^P:([01])$/.exec(lines[1]??"")?.[1];
 if(!owner||protectedFlag===undefined)throw Error("BACKUP_WINDOWS_ACL_FAILED");
 const rules=lines.slice(2).map(line=>{
  const match=/^([01]);(S-1-[0-9-]+);([0-9a-fA-F]{1,8});([01])$/.exec(line);if(!match)throw Error("BACKUP_WINDOWS_ACL_FAILED");
  return{allow:match[1]==="0",sid:match[2],mask:parseInt(match[3],16)>>>0,inherited:match[4]==="1"};
 });
 return{owner,protected:protectedFlag==="1",rules};
}
export function readAcl(target,{runTool=run}={}){
 if(typeof target!=="string"||/[\x00-\x1f]/.test(target))throw Error("BACKUP_WINDOWS_ACL_PATH_INVALID");
 const result=runTool(powershell(),["-NoProfile","-NonInteractive","-Command",ACL_SCRIPT],{env:{SystemRoot:process.env.SystemRoot,MURAGE_ACL_TARGET:target}});
 if(result?.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");
 return parseAclListing(result.stdout);
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
const ROOT_LIKE=new Set(["S-1-5-18","S-1-5-32-544"]);
const OWNER_ALIASES=new Set(["S-1-3-0","S-1-3-4"]); // CREATOR OWNER, OWNER RIGHTS
// Rights that reveal nothing and change nothing: synchronize, read the
// security descriptor, read attributes and extended attributes.
const HARMLESS=0x00100000|0x00020000|0x00000080|0x00000008;
export function aclIsPrivateToOwner(acl,sid){
 if(!acl||!(acl.owner===sid||ROOT_LIKE.has(acl.owner)))return false;
 return acl.rules.every(rule=>!rule.allow||rule.sid===sid||ROOT_LIKE.has(rule.sid)||OWNER_ALIASES.has(rule.sid)||(rule.mask&~HARMLESS)===0);
}
/** Restricts `target` to the owner and verifies the result. Windows only. */
export function restrictToOwner(target,{directory=false,runTool=run,readSddl,readAcl:readListing}={}){
 if(process.platform!=="win32"&&!readSddl&&!readListing)return;
 const sid=currentUserSid({runTool}),icacls=`${system32()}\\icacls.exe`;
 const set=runTool(icacls,ownerOnlyIcaclsArguments(target,sid,{directory}));if(set?.status!==0)throw Error("BACKUP_WINDOWS_ACL_FAILED");
 const owned=readSddl?sddlIsOwnerOnly(readSddl(target),sid):aclIsOwnerOnly((readListing??(file=>readAcl(file,{runTool})))(target),sid);
 if(!owned)throw Error("BACKUP_WINDOWS_ACL_FAILED");
}
/** Refuses a file other accounts can read or change. Windows only. */
export function assertPrivateToOwner(target,{runTool=run,readAcl:readListing}={}){
 if(process.platform!=="win32"&&!readListing)return;
 const sid=currentUserSid({runTool});
 if(!aclIsPrivateToOwner((readListing??(file=>readAcl(file,{runTool})))(target),sid))throw Error("BACKUP_WINDOWS_ACL_SHARED");
}
/** False only for a drive whose file system has no ACLs at all (FAT, FAT32,
 * exFAT: the usual USB stick), where owner-only can't be expressed. Anything
 * else, including a failure to tell, is treated as keeping ACLs. */
export function volumeKeepsAcls(target,{runTool=run}={}){
 if(typeof target!=="string"||!/^[A-Za-z]:\\/.test(target)||/[\x00-\x1f]/.test(target))return true;
 const script="([IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:MURAGE_ACL_TARGET))).DriveFormat";
 try{
  const result=runTool(powershell(),["-NoProfile","-NonInteractive","-Command",script],{env:{SystemRoot:process.env.SystemRoot,MURAGE_ACL_TARGET:target}});
  return !(result?.status===0&&/^(?:FAT|FAT12|FAT16|FAT32|exFAT)$/i.test(String(result.stdout).trim()));
 }catch{return true;}
}
