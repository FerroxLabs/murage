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
