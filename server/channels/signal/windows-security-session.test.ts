// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { WindowsSecuritySession, runWindowsSecuritySession, closeWindowsSecuritySession } from './windows-security-session.ts';
import { SIGNAL_SECURITY_HELPER } from '../../testing/signal-security-helper.ts';
const sessions:WindowsSecuritySession[]=[];
afterEach(()=>{for(const session of sessions.splice(0))session.close();});
function fixture(){const session=new WindowsSecuritySession({command:process.execPath,args:['-e',SIGNAL_SECURITY_HELPER],jsonProtocol:true});sessions.push(session);return session;}
test('one interpreter handles repeated synchronous requests without sharing results',()=>{
 const session=fixture();
 for(let index=0;index<64;index++){
  const input=JSON.stringify({index,path:"私の O'Brien $() `;\n"});
  expect(session.run({input,env:{...process.env,SIGNAL_HELPER_MODE:'echo'},timeout:10_000})).toBe(input);
 }
 expect(session.debug).toEqual({spawns:1,requests:64});
});
test('PowerShell command transfer preserves Unicode, quotes, newlines and metacharacters as ASCII data',()=>{
 const session=new WindowsSecuritySession({command:process.execPath,args:['-e',SIGNAL_SECURITY_HELPER,'--','--powershell-protocol','--echo-data']});sessions.push(session);
 const values=["私の O'Brien $() `;\n",'C:\\鍵\\root',"'; throw 'INJECTED'; '"];
 for(const value of values)expect(session.run({input:'fixed program',env:{...process.env,MURAGE_SIGNAL_ROOTS:value},timeout:10_000})).toBe(value);
 expect(session.debug.spawns).toBe(1);
});
for(const mode of ['exit','malformed','partial'])test(`${mode} security output refuses and the next request starts a new child`,()=>{
 const session=fixture();
 expect(()=>session.run({input:'first',env:{...process.env,SIGNAL_HELPER_MODE:mode},timeout:10_000})).toThrow('Windows security request failed');
 expect(session.run({input:'second',env:{...process.env,SIGNAL_HELPER_MODE:'echo'},timeout:10_000})).toBe('second');
 expect(session.debug.spawns).toBe(2);
});
test('a timeout waits for the exact helper exit before a retry can execute',()=>{
 const session=fixture();
 expect(()=>session.run({input:'first',env:{...process.env,SIGNAL_HELPER_MODE:'hang'},timeout:500})).toThrow('Windows security request failed');
 expect(session.run({input:'second',env:{...process.env,SIGNAL_HELPER_MODE:'echo'},timeout:10_000})).toBe('second');
 expect(session.debug.spawns).toBe(2);
});

for(const termination of ['delayed','failed'] as const)test(`unconfirmed ${termination} termination permanently refuses reuse and late exit cannot complete a later request`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'security-shutdown-')),record=join(root,'children');
 const workerPrelude=`{
  const cp=require('node:child_process'),spawn=cp.spawn;
  cp.spawn=(...args)=>{const owned=spawn(...args),kill=owned.kill.bind(owned);
    owned.kill=()=>{${termination==='delayed'?"setTimeout(()=>kill(),1500);return true;":"return false;"}};
    return owned;
  };
 }\n`;
 const helper=`const fs=require('node:fs');fs.appendFileSync(process.env.SECURITY_CHILD_RECORD,String(process.pid)+'\\n');setTimeout(()=>process.exit(0),2500);setInterval(()=>{},1000);`;
 const session=new WindowsSecuritySession({command:process.execPath,args:['-e',helper],jsonProtocol:true,workerPrelude});sessions.push(session);
 try{
  expect(()=>session.run({input:'A',env:{...process.env,SECURITY_CHILD_RECORD:record},timeout:500})).toThrow('Windows security request failed');
  expect(()=>session.run({input:'B',env:{...process.env,SECURITY_CHILD_RECORD:record},timeout:10_000})).toThrow('Windows security request failed');
  await new Promise(resolve=>setTimeout(resolve,1800));
  expect(()=>session.run({input:'C',env:{...process.env,SECURITY_CHILD_RECORD:record},timeout:10_000})).toThrow('Windows security request failed');
  expect(session.debug.spawns).toBe(1);expect(readFileSync(record,'utf8').trim().split('\\n')).toHaveLength(1);
 }finally{session.close();removeTempDirSync(root);}
});

test('a confirmed idle helper exit permits a fresh helper without reusing its result',async()=>{
 const helper=`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);console.log(r.token+JSON.stringify({ok:true,output:r.input}));setTimeout(()=>process.exit(0),20);});`;
 const session=new WindowsSecuritySession({command:process.execPath,args:['-e',helper],jsonProtocol:true});sessions.push(session);
 expect(session.run({input:'first',env:process.env,timeout:10_000})).toBe('first');
 await new Promise(resolve=>setTimeout(resolve,500));
 expect(session.run({input:'second',env:process.env,timeout:10_000})).toBe('second');
 expect(session.debug.spawns).toBe(2);
});

test('request B starts after timed-out A retires: late A exit cannot complete B and a new interpreter is required',()=>{
 const root=mkdtempSync(join(tmpdir(),'security-native-retirement-')),record=join(root,'children');
 const args=['-e',String.raw`
  const fs=require('node:fs'),readline=require('node:readline');let token,input;
  setInterval(()=>{},1000);
  readline.createInterface({input:process.stdin}).on('line',line=>{
   const data=/^[$]env:MURAGE_SIGNAL_POINT = [(]'((?:[^']|'')*)' [|] ConvertFrom-Json[)]$/.exec(line);
   if(data)input=JSON.parse(data[1].replaceAll("''","'"));
   const marker=/^'(MURAGE_SECURITY_[a-f0-9]+:)' [+] /.exec(line);if(marker)token=marker[1];
   if(token&&line==='}'){
    fs.appendFileSync(process.env.SECURITY_CHILD_RECORD,JSON.stringify({event:'request',input,pid:process.pid})+'\n');
    if(input==='warm')console.log(token+JSON.stringify({ok:true,output:'ready'}));
    if(input==='B')setTimeout(()=>console.log(token+JSON.stringify({ok:true,output:'B owns this result'})),2000);
   }
  });
 `];
 const builtin=createRequire(import.meta.url)('node:worker_threads') as typeof import('node:worker_threads'),Worker=builtin.Worker;
 const prelude=String.raw`{
  const cp=require('node:child_process'),fs=require('node:fs'),spawn=cp.spawn;
  cp.spawn=(...args)=>{const owned=spawn(...args),kill=owned.kill.bind(owned),record=args[2].env.SECURITY_CHILD_RECORD;
   owned.once('exit',()=>fs.appendFileSync(record,JSON.stringify({event:'exit',pid:owned.pid})+'\n'));
   owned.kill=()=>{setTimeout(()=>kill(),1500);return true;};return owned;
  };
 }`;
 builtin.Worker=class extends Worker {constructor(code:ConstructorParameters<typeof Worker>[0],options:ConstructorParameters<typeof Worker>[1]){super(prelude+String(code),options);}};
 syncBuiltinESMExports();
 try{
  const run=(input:string)=>runWindowsSecuritySession(process.execPath,args,{input:'fixed ACL program',env:{...process.env,SECURITY_CHILD_RECORD:record,MURAGE_SIGNAL_POINT:input},timeout:input==='A'?500:10_000});
  expect(run('warm')).toBe('ready');
  expect(()=>run('A')).toThrow('Windows security request failed');
  let result:string|undefined;
  expect(()=>{result=run('B');}).not.toThrow();expect(result).toBe('B owns this result');
  const events=readFileSync(record,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const a=events.find(row=>row.input==='A'),b=events.find(row=>row.input==='B');
  expect(a).toBeDefined();expect(b).toBeDefined();expect(b.pid).not.toBe(a.pid);
  expect(events.findIndex(row=>row.event==='exit'&&row.pid===a.pid)).toBeLessThan(events.indexOf(b));
 }finally{
  expect(closeWindowsSecuritySession()).toBe(true);
  builtin.Worker=Worker;syncBuiltinESMExports();removeTempDirSync(root);
 }
});


test('a late deadline callback belongs to A and cannot stop B in the reused interpreter',()=>{
 const workerPrelude=`{
  const schedule=setTimeout;let requests=0;
  global.setTimeout=(callback,delay,...args)=>{
   if(String(callback).includes("fail(operation")&&++requests===2)schedule(()=>callback(...args),1500);
   return schedule(callback,delay,...args);
  };
 }`;
 const helper=`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);setTimeout(()=>console.log(r.token+JSON.stringify({ok:true,output:r.input})),r.input==='B'?2200:0);});`;
 const session=new WindowsSecuritySession({command:process.execPath,args:['-e',helper],jsonProtocol:true,workerPrelude});sessions.push(session);
 expect(session.run({input:'warm',env:process.env,timeout:10_000})).toBe('warm');
 expect(session.run({input:'A',env:process.env,timeout:1000})).toBe('A');
 let result:string|undefined;
 expect(()=>{result=session.run({input:'B',env:process.env,timeout:10_000});}).not.toThrow();
 expect(result).toBe('B');expect(session.debug.spawns).toBe(1);
});
