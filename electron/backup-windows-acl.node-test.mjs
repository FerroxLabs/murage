// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {ownerOnlyIcaclsArguments,restrictToOwner,sddlIsOwnerOnly} from "./backup-windows-acl.mjs";

const sid="S-1-5-21-1111111111-2222222222-3333333333-1001";
test("icacls leaves one explicit ACE for the owner, inherited by everything in a folder",()=>{
 assert.deepEqual(ownerOnlyIcaclsArguments("C:\\Users\\Sam Lee\\.murage-backup-control\\x\\remote",sid,{directory:true}),["C:\\Users\\Sam Lee\\.murage-backup-control\\x\\remote","/inheritance:r","/grant:r",`*${sid}:(OI)(CI)F`,"/q"]);
 assert.deepEqual(ownerOnlyIcaclsArguments("C:\\Users\\Sam\\Documents\\murage-offsite-password.txt",sid,{directory:false}).slice(3),[`*${sid}:F`,"/q"]);
 for(const bad of ["relative\\x","\\\\server\\share\\x","C:\\a\"b","C:\\a\nb"])assert.throws(()=>ownerOnlyIcaclsArguments(bad,sid,{directory:false}),/PATH_INVALID/);
 for(const badSid of ["S-1-5-18","S-1-1-0","*S-1-5-21-1-2-3-4","S-1-5-21-1-2-3-4;x"])assert.throws(()=>ownerOnlyIcaclsArguments("C:\\x",badSid,{directory:false}),/UNAVAILABLE/);
});
test("only a protected DACL whose every ACE allows the owner counts as owner-only",()=>{
 assert.equal(sddlIsOwnerOnly(`D:P(A;OICI;FA;;;${sid})`,sid),true);
 assert.equal(sddlIsOwnerOnly(`D:PAI(A;;FA;;;${sid})`,sid),true);
 assert.equal(sddlIsOwnerOnly(`D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`,sid),false,"SYSTEM also granted");
 assert.equal(sddlIsOwnerOnly(`D:AI(A;ID;FA;;;${sid})`,sid),false,"inheritance not removed");
 assert.equal(sddlIsOwnerOnly(`D:P(D;;FA;;;WD)(A;;FA;;;${sid})`,sid),false,"deny entries are not expected");
 assert.equal(sddlIsOwnerOnly("D:P",sid),false);
 assert.equal(sddlIsOwnerOnly(`D:P(A;;FA;;;S-1-5-21-9-9-9-500)`,sid),false,"another user");
});
test("restrictToOwner runs icacls from System32 and refuses a result that is not owner-only",()=>{
 const saved=process.env.SystemRoot;process.env.SystemRoot="C:\\Windows";
 try{
  const calls=[];const runTool=(file,args)=>{calls.push([file,args]);return file.endsWith("whoami.exe")?{status:0,stdout:`"desk\\\\sam","${sid}"\r\n`}:{status:0,stdout:""};};
  restrictToOwner("C:\\Users\\Sam\\x",{directory:true,runTool,readSddl:()=>`D:P(A;OICI;FA;;;${sid})`});
  assert.equal(calls.at(-1)[0],"C:\\Windows\\System32\\icacls.exe");assert.equal(calls.at(-1)[1][3],`*${sid}:(OI)(CI)F`);
  assert.throws(()=>restrictToOwner("C:\\Users\\Sam\\y",{runTool,readSddl:()=>`D:AI(A;ID;FA;;;${sid})(A;ID;FA;;;BU)`}),/ACL_FAILED/);
  assert.throws(()=>restrictToOwner("C:\\Users\\Sam\\z",{runTool:(file)=>file.endsWith("icacls.exe")?{status:5}:{status:0,stdout:`"a","${sid}"`},readSddl:()=>""}),/ACL_FAILED/);
 }finally{if(saved===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=saved;}
});

// W-A1 (0.1.60 audit): only S-1-5-21-… was accepted, so every off-site step
// failed for Entra ID (Azure AD) accounts. Real-format SIDs of each kind.
const SIDS={
 local:"S-1-5-21-3623811015-3361044348-30300820-1013",
 domain:"S-1-5-21-1004336348-1177238915-682003330-512041",
 microsoftAccountLinked:"S-1-5-21-2896476437-1624578325-2931386102-1001",
 entra:"S-1-12-1-2743382473-1146318542-2395616179-3871231519",
};
const withSystemRoot=fn=>{const saved=process.env.SystemRoot;process.env.SystemRoot="D:\\WINNT";try{return fn();}finally{if(saved===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=saved;}};
test("every account SID shape is accepted: local, domain, Microsoft-account-linked and Entra ID (W-A1)",async()=>{
 const {isUserSid,currentUserSid,resetCurrentUserSid}=await import("./backup-windows-acl.mjs");
 for(const [kind,value] of Object.entries(SIDS)){
  assert.equal(isUserSid(value),true,kind);
  assert.deepEqual(ownerOnlyIcaclsArguments("C:\\Users\\Sam Lee\\Documents\\p.txt",value,{directory:false}).slice(3,4),[`*${value}:F`],kind);
  // whoami /user /fo csv /nh, as printed for each kind (the name is never used).
  const names={local:"mb-fix4w-app\\sam lee",domain:"CONTOSO\\sam.lee",microsoftAccountLinked:"desktop-7h2k\\samle",entra:"AzureAD\\SamLee"};
  resetCurrentUserSid();
  const calls=[];const sid=withSystemRoot(()=>currentUserSid({runTool:(file,args)=>{calls.push(file);return{status:0,stdout:`"${names[kind]}","${value}"\r\n`};}}));
  assert.equal(sid,value,kind);assert.deepEqual(calls,["D:\\WINNT\\System32\\whoami.exe"]);
 }
 resetCurrentUserSid();
});
test("group and well-known SIDs are never an owner; malformed SIDs are refused (W-A1)",async()=>{
 const {isUserSid}=await import("./backup-windows-acl.mjs");
 for(const bad of ["S-1-5-18","S-1-1-0","S-1-5-32-545","S-1-5-11","S-1-11-96-3623454863-58364-18864-2661722203-1597581903-1225","S-1-15-2-1","S-1-5-21-1-2-3","S-1-5-21-1-2-3-4-5","S-1-12-1-1-2-3","S-1-5-21-1-2-3-4294967296","S-1-5-21-01-2-3-4","*S-1-12-1-1-2-3-4","S-1-12-1-1-2-3-4 ",""])assert.equal(isUserSid(bad),false,bad);
 for(const bad of ["S-1-5-18","S-1-5-32-545","S-1-12-1-1-2-3"])assert.throws(()=>ownerOnlyIcaclsArguments("C:\\x",bad,{directory:false}),/UNAVAILABLE/);
});
test("whoami output with a comma or quote-like text in the name, or an unusable whoami, still finds the token's SID (W-A1)",async()=>{
 const {currentUserSid,resetCurrentUserSid}=await import("./backup-windows-acl.mjs");
 resetCurrentUserSid();
 assert.equal(withSystemRoot(()=>currentUserSid({runTool:()=>({status:0,stdout:`\r\n"AzureAD\\Lee, Sam","${SIDS.entra}"\r\n`})})),SIDS.entra);
 resetCurrentUserSid();
 // whoami missing or printing something else: the same token, read by .NET.
 const calls=[];
 assert.equal(withSystemRoot(()=>currentUserSid({runTool:(file,args)=>{calls.push([file,args.at(-1)]);return /whoami/.test(file)?{status:1,stdout:""}:{status:0,stdout:`${SIDS.domain}\r\n`};}})),SIDS.domain);
 assert.equal(calls[1][0],"D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");assert.match(calls[1][1],/WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
 resetCurrentUserSid();
 assert.throws(()=>withSystemRoot(()=>currentUserSid({runTool:()=>({status:0,stdout:"S-1-5-18\r\n"})})),/UNAVAILABLE/);
 resetCurrentUserSid();
});
test("the ACL is read as SIDs and parsed strictly (W-A1, W-A5)",async()=>{
 const {parseAclListing}=await import("./backup-windows-acl.mjs");
 const acl=parseAclListing(`O:${SIDS.entra}\r\nP:1\r\n0;${SIDS.entra};1f01ff;0\r\n`);
 assert.deepEqual(acl,{owner:SIDS.entra,protected:true,rules:[{allow:true,sid:SIDS.entra,mask:0x1f01ff,inherited:false}]});
 assert.equal(parseAclListing(`O:${SIDS.local}\nP:0\n0;S-1-5-32-545;80000000;1`).rules[0].mask,0x80000000);
 for(const bad of ["","O:LA\nP:1",`O:${SIDS.local}\nP:1\n0;BU;1;0`,`O:${SIDS.local}\nP:1\n2;${SIDS.local};1;0`,`O:${SIDS.local}\nP:yes`])assert.throws(()=>parseAclListing(bad),/ACL_FAILED/);
});
test("owner-only (what Murage creates) and private to the owner (what a person may choose) (W-A5)",async()=>{
 const {aclIsOwnerOnly,aclIsPrivateToOwner}=await import("./backup-windows-acl.mjs");
 const me=SIDS.entra,other=SIDS.local,rule=(sid,mask=0x1f01ff,allow=true,inherited=false)=>({allow,sid,mask,inherited});
 const created={owner:me,protected:true,rules:[rule(me)]};
 assert.equal(aclIsOwnerOnly(created,me),true);assert.equal(aclIsPrivateToOwner(created,me),true);
 // A file in Documents: inherited SYSTEM, Administrators and the owner.
 const documents={owner:me,protected:false,rules:[rule("S-1-5-18",0x1f01ff,true,true),rule("S-1-5-32-544",0x1f01ff,true,true),rule(me,0x1f01ff,true,true)]};
 assert.equal(aclIsOwnerOnly(documents,me),false);assert.equal(aclIsPrivateToOwner(documents,me),true);
 // C:\Users\Public: Users and Interactive may read; Everyone read; another person.
 for(const sid of ["S-1-5-32-545","S-1-5-4","S-1-1-0","S-1-5-11",other])assert.equal(aclIsPrivateToOwner({...documents,rules:[...documents.rules,rule(sid,0x1200a9,true,true)]},me),false,sid);
 // Write or re-permission rights count too; generic read counts.
 for(const mask of [0x2,0x40000,0x80000,0x80000000,0x10000000])assert.equal(aclIsPrivateToOwner({...documents,rules:[...documents.rules,rule("S-1-5-32-545",mask)]},me),false,mask.toString(16));
 // Only reading attributes or the ACL itself reveals nothing; a deny entry only takes away.
 assert.equal(aclIsPrivateToOwner({...documents,rules:[...documents.rules,rule("S-1-1-0",0x100080),rule("S-1-1-0",0x1f01ff,false)]},me),true);
 // Owned by someone else, who may re-permission it at will.
 assert.equal(aclIsPrivateToOwner({...created,owner:other},me),false);
 assert.equal(aclIsPrivateToOwner({...created,owner:"S-1-5-32-544"},me),true);
});
test("restrictToOwner verifies with the SID listing, not SDDL aliases (W-A1)",async()=>{
 const {restrictToOwner,resetCurrentUserSid}=await import("./backup-windows-acl.mjs");
 resetCurrentUserSid();
 const runTool=(file,args)=>/whoami/.test(file)?{status:0,stdout:`"AzureAD\\SamLee","${SIDS.entra}"`}:{status:0,stdout:""};
 withSystemRoot(()=>restrictToOwner("C:\\Users\\SamLee\\Documents\\x.txt",{runTool,readAcl:()=>({owner:SIDS.entra,protected:true,rules:[{allow:true,sid:SIDS.entra,mask:0x1f01ff,inherited:false}]})}));
 assert.throws(()=>withSystemRoot(()=>restrictToOwner("C:\\Users\\SamLee\\Documents\\y.txt",{runTool,readAcl:()=>({owner:SIDS.entra,protected:false,rules:[{allow:true,sid:SIDS.entra,mask:0x1f01ff,inherited:true}]})})),/ACL_FAILED/);
 resetCurrentUserSid();
});
test("real Windows: this account's SID comes from the token and a new file is made owner-only (W-A1)",{skip:process.platform!=="win32"&&"real icacls and Get-Acl only"},async t=>{
 const {currentUserSid,readAcl,restrictToOwner,aclIsOwnerOnly,resetCurrentUserSid}=await import("./backup-windows-acl.mjs");
 const {mkdtempSync,writeFileSync}=await import("node:fs");const {tmpdir}=await import("node:os");const path=(await import("node:path")).default;
 const {safeWipeSync}=await import("../server/testing/safe-wipe.mjs");
 resetCurrentUserSid();const sid=currentUserSid();
 const root=mkdtempSync(path.join(tmpdir(),"murage-acl-"));t.after(()=>safeWipeSync(root));
 const file=path.join(root,"x.txt");writeFileSync(file,"x");restrictToOwner(file);
 assert.equal(aclIsOwnerOnly(readAcl(file),sid),true);
});
test("a FAT32 or exFAT drive is known to hold no ACLs; anything unclear counts as NTFS (K-10 copies)",async()=>{
 const {volumeKeepsAcls}=await import("./backup-windows-acl.mjs");
 const answer=stdout=>()=>({status:0,stdout});
 withSystemRoot(()=>{
  assert.equal(volumeKeepsAcls("E:\\copy",{runTool:answer("FAT32\r\n")}),false);
  assert.equal(volumeKeepsAcls("E:\\copy",{runTool:answer("exFAT\r\n")}),false);
  assert.equal(volumeKeepsAcls("C:\\Users\\x",{runTool:answer("NTFS\r\n")}),true);
  assert.equal(volumeKeepsAcls("C:\\Users\\x",{runTool:()=>({status:1,stdout:""})}),true);
  assert.equal(volumeKeepsAcls("\\\\server\\share",{runTool:answer("FAT32")}),true);
 });
});
