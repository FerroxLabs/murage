// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {ownerOnlyIcaclsArguments,restrictToOwner,sddlIsOwnerOnly} from "./backup-windows-acl.mjs";
import {windowsNative} from "./windows-native.mjs";

// The real-Windows owner-only tests need the engine-exclusion addon. Without it Murage resolves no domain-relative SDDL alias (LA, the
// built-in Administrator a hosted runner signs in as) and reads no file owner, and refuses: that is the documented behaviour of a
// source checkout without a build (windows-native.mjs); the packaged app always carries the addon (after-pack refuses one without it).
// The quality-gates job builds no addon, so there they are skipped by name; the Native addon MSVC job builds it and sets
// MURAGE_REQUIRE_WINDOWS_NATIVE=1, which turns a missing addon into a failure, never a skip.
const NEEDS_ADDON="needs the engine-exclusion addon (run by the Native addon MSVC job; always in the packaged app)";
const realWindows=reason=>process.platform!=="win32"?reason:process.env.MURAGE_REQUIRE_WINDOWS_NATIVE==="1"||windowsNative()?false:NEEDS_ADDON;
const requireAddon=()=>{if(process.env.MURAGE_REQUIRE_WINDOWS_NATIVE==="1")assert.ok(typeof windowsNative()?.domainSids==="function","the engine-exclusion addon did not load");};

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
 // whoami missing or failing: a refusal, and no second program (there is no PowerShell fallback any more).
 const calls=[];
 assert.throws(()=>withSystemRoot(()=>currentUserSid({runTool:(file)=>{calls.push(file);return{status:1,stdout:""};}})),/UNAVAILABLE/);
 assert.deepEqual(calls,["D:\\WINNT\\System32\\whoami.exe"]);
 resetCurrentUserSid();
 assert.throws(()=>withSystemRoot(()=>currentUserSid({runTool:()=>({status:0,stdout:"S-1-5-18\r\n"})})),/UNAVAILABLE/);
 resetCurrentUserSid();
});
import {readFileSync} from "node:fs";
const fixture=name=>readFileSync(new URL(`../server/testdata/win-nops/${name}`,import.meta.url));
const utf16=text=>Buffer.from(text,"utf16le");
const USER="S-1-5-21-1111111111-2222222222-3333333333-1001";
test("real icacls /save output (UTF-16, name line then SDDL) is parsed into SIDs, rights and flags",async()=>{
 const {parseSddlAcl,sddlFromSavedAcl}=await import("./backup-windows-acl.mjs");
 const sddl=name=>sddlFromSavedAcl(utf16(fixture(name).toString("utf8")));
 const restricted=parseSddlAcl(sddl("icacls-restricted-file.txt"));
 assert.deepEqual(restricted,{owner:null,protected:true,rules:[{allow:true,sid:USER,mask:0x1f01ff,inherited:false,inheritOnly:false}]});
 assert.deepEqual(parseSddlAcl(sddl("icacls-restricted-dir.txt")).rules,[{allow:true,sid:USER,mask:0x1f01ff,inherited:false,inheritOnly:false}]);
 const shared=parseSddlAcl(sddl("icacls-default.txt"));
 assert.equal(shared.protected,false);
 assert.deepEqual(shared.rules.map(rule=>[rule.sid,rule.mask,rule.inherited]),[
  ["S-1-5-21-4444444444-5555555555-6666666666-1013",0x1301bf,true],["S-1-5-32-544",0x1f01ff,true],["S-1-5-18",0x1f01ff,true],["S-1-5-11",0x1301bf,true],["S-1-5-32-545",0x1200a9,true]]);
 // with and without a byte order mark
 assert.equal(sddlFromSavedAcl(Buffer.concat([Buffer.from([0xff,0xfe]),utf16("n\r\nD:P(A;;FA;;;SY)\r\n")])),"D:P(A;;FA;;;SY)");
});
test("SDDL parsing is strict and fails closed (W-A1, W-A5)",async()=>{
 const {parseSddlAcl}=await import("./backup-windows-acl.mjs");
 assert.equal(parseSddlAcl("D:P(D;;FR;;;WD)(A;OICIIO;GA;;;CO)").rules[0].allow,false);
 assert.equal(parseSddlAcl("D:P(A;;GRGW;;;WD)").rules[0].mask,0xc0000000);
 // a real C:\ProgramData entry (Windows 11): the object-specific bits by their directory-service names
 assert.equal(parseSddlAcl("D:PAI(A;OICI;FA;;;WD)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;GA;;;CO)(A;OICI;FA;;;BU)(A;CI;DCLCRPCR;;;BU)").rules[5].mask,0x116);
 assert.equal(parseSddlAcl("D:P(A;;FA;;;LA)",{domains:{account:"S-1-5-21-1111111111-2222222222-3333333333",primary:null,forestRoot:null}}).rules[0].sid,"S-1-5-21-1111111111-2222222222-3333333333-500");
 for(const bad of ["","D:","D:NO_ACCESS_CONTROL","O:BAD:P(A;;FA;;;SY)","D:P(A;;FA;;;ZZ)","D:P(A;;XXFA;;;SY)","D:P(OA;;FA;;;SY)","D:P(A;;FA;00000000-0000-0000-0000-000000000000;;SY)","D:P(A;BAD;FA;;;SY)","D:P(A;;0xZZ;;;SY)","D:P(XA;;FX;;;S-1-1-0;(@User.x==1))"])assert.throws(()=>parseSddlAcl(bad,{domains:null}),/ACL_FAILED/,bad);
});
test("SYSTEM, Administrators and TrustedInstaller count as root by SID, whatever their names",async()=>{
 const {aclIsPrivateToOwner}=await import("./backup-windows-acl.mjs");
 const TI="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
 for(const owner of ["S-1-5-18","S-1-5-32-544",TI,USER])assert.equal(aclIsPrivateToOwner({owner,protected:true,rules:[{allow:true,sid:USER,mask:0x1f01ff,inherited:false}]},USER),true,owner);
 assert.equal(aclIsPrivateToOwner({owner:"S-1-5-21-9-9-9-1002",protected:true,rules:[{allow:true,sid:USER,mask:0x1f01ff,inherited:false}]},USER),false);
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
test("the ACL read runs icacls /save from System32 into a private temp folder and starts no PowerShell",async()=>{
 const {readAcl}=await import("./backup-windows-acl.mjs");
 const calls=[];const runTool=(file,args)=>{calls.push({file,args});return{status:0,stdout:/whoami/.test(file)?`"desk\\sam","${USER}"`:"Successfully processed 0 files; Failed processing 0 files"};};
 const readSaved=()=>fixture("icacls-restricted-file.txt").toString("utf8")&&utf16(fixture("icacls-restricted-file.txt").toString("utf8"));
 withSystemRoot(()=>assert.deepEqual(readAcl("C:\\Users\\Sam\\x.txt",{runTool,readSaved}),{owner:null,protected:true,rules:[{allow:true,sid:USER,mask:0x1f01ff,inherited:false,inheritOnly:false}]}));
 const save=calls.find(call=>/icacls/.test(call.file));
 assert.equal(save.file,"D:\\WINNT\\System32\\icacls.exe");
 assert.deepEqual([save.args[0],save.args[1],save.args[3]],["C:\\Users\\Sam\\x.txt","/save","/q"]);
 assert.match(save.args[2],/murage-acl-[^\\\/]+[\\\/]acl\.txt$/);
 assert.ok(!calls.some(call=>/powershell|pwsh/i.test(call.file)));
 // icacls failing, or writing something unexpected, is a refusal
 withSystemRoot(()=>{
  assert.throws(()=>readAcl("C:\\x",{runTool:(file)=>/icacls/.test(file)?{status:5,stdout:""}:{status:0,stdout:`"a","${USER}"`},readSaved}),/ACL_FAILED/);
  assert.throws(()=>readAcl("C:\\x",{runTool,readSaved:()=>utf16("only one line\r\n")}),/ACL_FAILED/);
 });
});
test("assertPrivateToOwner reads the owner too (the addon's SID), and an unknown owner is refused",async()=>{
 const awaitedAcl=await import("./backup-windows-acl.mjs");const {assertPrivateToOwner,resetCurrentUserSid,readAcl}=awaitedAcl;
 const run=(file)=>/whoami/.test(file)?{status:0,stdout:`"testpc\\tester","${USER}"`}:{status:0,stdout:""};
 const readSaved=()=>utf16("plain.txt\r\nD:P(A;;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)\r\n");
 const target="F:\\Temp\\Codex\\test\\acl\\plain.txt";
 const check=native=>assertPrivateToOwner(target,{runTool:run,readAcl:file=>readAcl(file,{runTool:run,readSaved,withOwner:true,native})});
 resetCurrentUserSid();
 withSystemRoot(()=>{
  for(const owner of [USER,"S-1-5-32-544"])assert.doesNotThrow(()=>check({fileOwnerSid:()=>owner}));
  assert.throws(()=>check({fileOwnerSid:()=>"S-1-5-21-9-9-9-1002"}),/ACL_SHARED/);
  assert.throws(()=>check(null),/ACL_SHARED/);
 });
 resetCurrentUserSid();
});
test("entries written on the file itself (an administrator's default ACL) are removed by SID, then verified again",async()=>{
 const {restrictToOwner,restrictToOwnerAsync,removeIcaclsArguments,resetCurrentUserSid}=await import("./backup-windows-acl.mjs");
 // What a GitHub Windows runner (an elevated administrator) showed after
 // /inheritance:r /grant:r: SYSTEM and Administrators kept, not inherited.
 const shared={owner:"S-1-5-32-544",protected:true,rules:["S-1-5-18","S-1-5-32-544",sid].map(entry=>({allow:true,sid:entry,mask:0x1f01ff,inherited:false}))};
 const only={owner:"S-1-5-32-544",protected:true,rules:[{allow:true,sid,mask:0x1f01ff,inherited:false}]};
 for(const restrict of [restrictToOwner,restrictToOwnerAsync]){
  resetCurrentUserSid();const calls=[];let reads=0;
  const runTool=(file,args)=>{calls.push(args);return /whoami/.test(file)?{status:0,stdout:`"HOST\\runner","${sid}"`}:{status:0,stdout:""};};
  const saved=process.env.SystemRoot;process.env.SystemRoot="D:\\WINNT";
  try{
  await restrict("C:\\Users\\runner\\x",{directory:true,runTool,readAcl:()=>reads++===0?shared:only});
  assert.deepEqual(calls.slice(2),[["C:\\Users\\runner\\x","/remove","*S-1-5-18","/q"],["C:\\Users\\runner\\x","/remove","*S-1-5-32-544","/q"]]);assert.equal(reads,2);
  resetCurrentUserSid();
  await assert.rejects(async()=>(restrict("C:\\Users\\runner\\y",{runTool:(file,args)=>/whoami/.test(file)?{status:0,stdout:`"HOST\\runner","${sid}"`}:{status:args[1]==="/remove"?5:0,stdout:""},readAcl:()=>shared})),/ACL_FAILED/);
  }finally{resetCurrentUserSid();if(saved===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=saved;}
 }
 assert.throws(()=>removeIcaclsArguments("C:\\x","S-1-5-18;x"),/ACL_FAILED/);assert.throws(()=>removeIcaclsArguments("\\\\server\\x","S-1-5-18"),/PATH_INVALID/);
});
test("real Windows: this account's SID comes from the token and a new file is made owner-only (W-A1)",{skip:realWindows("real icacls and ACL read only")},async t=>{
 requireAddon();
 const {currentUserSid,readAcl,restrictToOwner,aclIsOwnerOnly,resetCurrentUserSid}=await import("./backup-windows-acl.mjs");
 const {mkdtempSync,writeFileSync}=await import("node:fs");const {tmpdir}=await import("node:os");const path=(await import("node:path")).default;
 const {safeWipeSync}=await import("../server/testing/safe-wipe.mjs");
 resetCurrentUserSid();const sid=currentUserSid();
 const root=mkdtempSync(path.join(tmpdir(),"murage-acl-"));t.after(()=>safeWipeSync(root));
 // A person waits on this (choosing a password file, starting off-site): it must finish well inside the
 // tools' 60 s timeout. A loaded CI runner starts PowerShell slowly (14.5 s seen), so the bound is 30 s.
 const file=path.join(root,"x.txt");writeFileSync(file,"x");const started=Date.now();restrictToOwner(file);
 assert.equal(aclIsOwnerOnly(readAcl(file),sid),true);
 assert.ok(Date.now()-started<30000,`owner-only took ${Date.now()-started} ms`);
});
test("a FAT32 or exFAT drive is known to hold no ACLs; anything unclear counts as NTFS (K-10 copies)",async()=>{
 const {volumeKeepsAcls}=await import("./backup-windows-acl.mjs");
 const drive=format=>({driveInfo:()=>format===null?null:{type:"Fixed",format}});
 for(const [format,keeps] of [["FAT32",false],["exFAT",false],["FAT",false],["NTFS",true],["ReFS",true],[null,true]])assert.equal(volumeKeepsAcls("E:\\copy",{native:drive(format)}),keeps,String(format));
 assert.equal(volumeKeepsAcls("\\\\server\\share",{native:drive("FAT32")}),true);
});
test("the asynchronous forms (for Electron's main process) follow the same rules",async()=>{
 const {currentUserSidAsync,restrictToOwnerAsync,assertPrivateToOwnerAsync,volumeKeepsAclsAsync,resetCurrentUserSid}=await import("./backup-windows-acl.mjs");
 const saved=process.env.SystemRoot;process.env.SystemRoot="D:\\WINNT";
 try{
  resetCurrentUserSid();
  const calls=[];const runTool=async(file,args)=>{calls.push(file);await new Promise(r=>setImmediate(r));return /whoami/.test(file)?{status:0,stdout:`"AzureAD\\SamLee","${SIDS.entra}"\r\n`}:{status:0,stdout:""};};
  assert.equal(await currentUserSidAsync({runTool}),SIDS.entra);
  await restrictToOwnerAsync("C:\\Users\\SamLee\\x",{directory:true,runTool,readAcl:async()=>({owner:SIDS.entra,protected:true,rules:[{allow:true,sid:SIDS.entra,mask:0x1f01ff,inherited:false}]})});
  assert.deepEqual(calls,["D:\\WINNT\\System32\\whoami.exe","D:\\WINNT\\System32\\icacls.exe"]);
  await assert.rejects(restrictToOwnerAsync("C:\\Users\\SamLee\\y",{runTool:async file=>/icacls/.test(file)?{status:5}:{status:0,stdout:""},readAcl:async()=>null}),/ACL_FAILED/);
  await assert.rejects(assertPrivateToOwnerAsync("C:\\Users\\Public\\p.txt",{runTool,readAcl:async()=>({owner:SIDS.entra,protected:false,rules:[{allow:true,sid:SIDS.entra,mask:0x1f01ff,inherited:true},{allow:true,sid:"S-1-5-32-545",mask:0x1200a9,inherited:true}]})}),/BACKUP_WINDOWS_ACL_SHARED/);
  await assertPrivateToOwnerAsync("C:\\Users\\SamLee\\Documents\\p.txt",{runTool,readAcl:async()=>({owner:SIDS.entra,protected:false,rules:[{allow:true,sid:"S-1-5-18",mask:0x1f01ff,inherited:true},{allow:true,sid:SIDS.entra,mask:0x1f01ff,inherited:true}]})});
  assert.equal(await volumeKeepsAclsAsync("E:\\x",{native:{driveInfo:()=>({type:"Removable",format:"exFAT"})}}),false);
  assert.equal(await volumeKeepsAclsAsync("C:\\x",{native:{driveInfo:()=>({type:"Fixed",format:"NTFS"})}}),true);
  // A whoami that fails is a refusal: there is no PowerShell fallback.
  resetCurrentUserSid();
  await assert.rejects(currentUserSidAsync({runTool:async file=>/whoami/.test(file)?{status:1,stdout:""}:{status:0,stdout:`${SIDS.local}\r\n`}}),/UNAVAILABLE/);
 }finally{resetCurrentUserSid();if(saved===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=saved;}
});
