// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,test } from 'vitest';
import { currentUserSid,windowsAclRestrict } from '../../win-acl.ts';
import type { Stats } from 'node:fs';
const sid='S-1-5-21-1-2-3-1001';
const env={SystemRoot:'C:\\Windows'};
test('SID is read once across repeated ACL restrictions by the same process runner',()=>{
 const calls:string[]=[];
 const run=(exe:string)=>{calls.push(exe);return exe.endsWith('whoami.exe')?`"host\\owner","${sid}"`:'';};
 const stat=()=>({isSymbolicLink:()=>false,isDirectory:()=>true,isFile:()=>false}) as Stats;
 for(let index=0;index<64;index++)expect(windowsAclRestrict('C:\\fixture',run,env,stat)).toBe(true);
 expect(calls.filter(exe=>exe.endsWith('whoami.exe'))).toHaveLength(1);
 expect(calls.filter(exe=>exe.endsWith('icacls.exe'))).toHaveLength(64);
});
test('successful process identity is shared by native runner adapters; failed reads are retried',()=>{
 const scope={};let attempts=0,other=0;
 const run=()=>{attempts++;return attempts===1?'malformed':`"host\\owner","${sid}"`;};
 expect(currentUserSid(run,env,scope)).toBeNull();expect(currentUserSid(run,env,scope)).toBe(sid);
 expect(currentUserSid(()=>{other++;throw new Error('must use cached process identity');},env,scope)).toBe(sid);
 expect(attempts).toBe(2);expect(other).toBe(0);
});
