// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra nops review, findings 2, 5 and 7: the volume's file system, a file's owner and the domain an SDDL alias means come from the
// engine-exclusion addon only, never from a program's output or a SID found at the end of a name, and anything the addon cannot
// tell is refused.
import assert from "node:assert/strict";
import test from "node:test";
import {volumeKeepsAcls,volumeKeepsAclsAsync,readOwnerSid,readOwnerSidAsync,readAcl,assertPrivateToOwner,parseSddlAcl,resetCurrentUserSid} from "./backup-windows-acl.mjs";
import {UNKNOWN_ACCOUNT_FIX} from "../shared/windows-sddl.mjs";

const USER="S-1-5-21-1111111111-2222222222-3333333333-1001";
const withSystemRoot=fn=>{const saved=process.env.SystemRoot;process.env.SystemRoot="D:\\WINNT";try{return fn();}finally{if(saved===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=saved;}};
// What fsutil prints for an NTFS volume someone labelled "FAT32": the label line comes first.
const LABELLED="Volume Name : FAT32\r\nVolume Serial Number : 0x1234\r\nFile System Name : NTFS\r\n";

test("#2: the file system is the addon's GetVolumeInformationW answer; a label in a program's output never decides it",()=>{
 const programs=[];const runTool=(file)=>{programs.push(file);return{status:0,stdout:LABELLED};};
 withSystemRoot(()=>{
  assert.equal(volumeKeepsAcls("E:\\copy",{runTool,native:{driveInfo:()=>({type:"Fixed",format:"NTFS"})}}),true,"an NTFS volume labelled FAT32 keeps its ACLs");
  assert.equal(volumeKeepsAcls("E:\\copy",{runTool,native:{driveInfo:()=>({type:"Removable",format:"FAT32"})}}),false);
  assert.equal(volumeKeepsAcls("E:\\copy",{runTool,native:{driveInfo:()=>({type:"Removable",format:"exFAT"})}}),false);
  // a volume the addon cannot read keeps ACLs: the owner-only step then runs and refuses when it cannot be done
  assert.equal(volumeKeepsAcls("E:\\copy",{runTool,native:{driveInfo:()=>null}}),true);
  assert.equal(volumeKeepsAcls("E:\\copy",{runTool,native:{driveInfo:()=>{throw Error("x");}}}),true);
 });
 assert.deepEqual(programs,[],"no program is started to tell the file system");
});

test("#2: without the addon the file system cannot be told, and the save is refused (fail closed)",async()=>{
 const runTool=()=>({status:0,stdout:LABELLED});
 withSystemRoot(()=>assert.throws(()=>volumeKeepsAcls("E:\\copy",{runTool,native:null}),/BACKUP_WINDOWS_ACL_UNAVAILABLE/));
 await assert.rejects(volumeKeepsAclsAsync("E:\\copy",{runTool:async()=>runTool(),native:null}),/BACKUP_WINDOWS_ACL_UNAVAILABLE/);
});

test("#5: the owner is the addon's SID only; a name ending in a SID never makes a stranger's file SYSTEM's",async()=>{
 // dir /q's owner column for a file owned by an account named "x S-1-5-18" on another computer
 const listing=" Directory of F:\\Temp\r\n\r\n10/21/2026  10:00 AM                 5 PC\\x S-1-5-18        plain.txt\r\n";
 const runTool=()=>({status:0,stdout:listing});
 const target="F:\\Temp\\plain.txt";
 withSystemRoot(()=>{
  assert.equal(readOwnerSid(target,{runTool,native:null}),null,"no addon: unknown");
  assert.equal(readOwnerSid(target,{runTool,native:{fileOwnerSid:()=>"S-1-5-21-9-9-9-1002"}}),"S-1-5-21-9-9-9-1002");
  assert.equal(readOwnerSid(target,{runTool,native:{fileOwnerSid:()=>"PC\\x S-1-5-18"}}),null,"only a SID string is a SID");
  assert.equal(readOwnerSid(target,{runTool,native:{fileOwnerSid:()=>{throw Error("x");}}}),null);
 });
 assert.equal(await readOwnerSidAsync(target,{runTool:async()=>runTool(),native:null}),null);
 // and an unknown owner is refused by the privacy check
 resetCurrentUserSid();
 const tool=(file)=>/whoami/.test(file)?{status:0,stdout:`"testpc\\tester","${USER}"`}:{status:0,stdout:listing};
 const readSaved=()=>Buffer.from(`plain.txt\r\nD:P(A;;FA;;;${USER})\r\n`,"utf8");
 try{
  withSystemRoot(()=>assert.throws(()=>assertPrivateToOwner(target,{runTool:tool,readAcl:file=>readAcl(file,{runTool:tool,readSaved,withOwner:true,native:null})}),/ACL_SHARED/));
 }finally{resetCurrentUserSid();}
});

test("#7: domain aliases resolve from the computer's real domains; the forest-root ones from the forest root, never a user or machine SID",()=>{
 const ACCOUNT="S-1-5-21-7777777777-8888888888-9999999999",JOINED="S-1-5-21-1111111111-2222222222-3333333333",ROOT="S-1-5-21-4444444444-5555555555-6666666666";
 const domains={account:ACCOUNT,primary:JOINED,forestRoot:ROOT};
 const sidOf=(alias,options)=>parseSddlAcl(`D:P(A;;FA;;;${alias})`,options).rules[0].sid;
 for(const [alias,rid] of Object.entries({DA:512,DU:513,DG:514,DC:515,DD:516,CA:517,PA:520,CN:522,AP:525,KA:526,RS:553}))assert.equal(sidOf(alias,{domains}),`${JOINED}-${rid}`,alias);
 for(const [alias,rid] of Object.entries({RO:498,SA:518,EA:519,EK:527}))assert.equal(sidOf(alias,{domains}),`${ROOT}-${rid}`,alias);
 for(const [alias,rid] of Object.entries({LA:500,LG:501}))assert.equal(sidOf(alias,{domains}),`${ACCOUNT}-${rid}`,alias);
 // numeric SIDs are taken as written
 assert.equal(sidOf("S-1-5-21-1-2-3-519",{domains:null}),"S-1-5-21-1-2-3-519");
 // a workgroup computer: no joined domain, so no domain alias; the user's or machine's SID is never put in its place
 const refused=(alias,options)=>assert.throws(()=>parseSddlAcl(`D:P(A;;FA;;;${alias})`,options),error=>error.message==="BACKUP_WINDOWS_ACL_FAILED"&&error.fix===UNKNOWN_ACCOUNT_FIX,alias);
 for(const alias of ["DA","DU","EA","SA","RO"])refused(alias,{domains:{account:ACCOUNT,primary:null,forestRoot:null},userSid:USER,machineSid:ACCOUNT});
 // a forest root that could not be told is refused, never the joined domain in its place
 for(const alias of ["EA","SA","RO","EK"])refused(alias,{domains:{account:ACCOUNT,primary:JOINED,forestRoot:null}});
 // no addon: only numeric SIDs and the fixed aliases resolve
 for(const alias of ["DA","LA","EA"])refused(alias,{domains:null,userSid:USER,machineSid:ACCOUNT});
});
