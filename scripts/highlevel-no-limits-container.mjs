// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// One isolated container can retain dependencies between RED/GREEN/mutant/gate
// commands. The request/status files are confined to this lane's evidence.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const dir='evidence/gnl-hl/control';mkdirSync(dir,{recursive:true});
const files=['server/index.ts','server/highlevel/host.ts','server/highlevel/actions.ts'];
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
function run(label,command,args){
 writeFileSync(`${dir}/status.json`,JSON.stringify({phase:label,state:'running',hashes:hashes()}));
 const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:40*1024*1024,timeout:60*60*1000});
 writeFileSync(`${dir}/${label}.log`,(result.stdout??'')+(result.stderr??''));
 const status={phase:label,state:'finished',status:result.status,signal:result.signal,error:result.error?.message,hashes:hashes()};
 writeFileSync(`${dir}/status.json`,JSON.stringify(status));console.log(JSON.stringify(status));return result.status;
}
const vitest=['node_modules/vitest/vitest.mjs','run'];
run('base-red',process.execPath,[...vitest,'server/highlevel/owner-turn-api.test.ts','server/highlevel/no-limits-authority-api.test.ts','-t','GNL-HL']);
let nonce='';
for(;;){
 let request;
 try{request=JSON.parse(readFileSync(`${dir}/request.json`,'utf8'));}catch{}
 if(!request||request.nonce===nonce){await new Promise(resolve=>setTimeout(resolve,250));continue;}
 nonce=request.nonce;
 if(request.command==='stop')break;
 if(request.command==='focused')run(request.label??'focused',process.execPath,[...vitest,...(request.files??['server/highlevel/owner-turn-api.test.ts','server/highlevel/no-limits-authority-api.test.ts']),...(request.filter?['-t',request.filter]:[])]);
 else if(request.command==='mutants')run('mutants',process.execPath,['scripts/verify-highlevel-no-limits-mutants.mjs']);
 else if(request.command==='gate'){
  const typed=run('typecheck','pnpm',['typecheck']);
  if(typed===0)run('gate',process.execPath,[...vitest,'server/highlevel/','no-limits','nolimits','approval']);
 }
 else throw Error('Unknown fixture command');
}
