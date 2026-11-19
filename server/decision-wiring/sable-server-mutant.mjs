// SPDX-License-Identifier: AGPL-3.0-or-later
import {verifyDecisionMutant} from '../../scripts/test-truth/decision-mutant.test-helper.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {loadavg} from 'node:os';
import {setTimeout} from 'node:timers/promises';
// Mutate the production ingress in the fixture loader; port-a owns index.ts.
const path='server/decision-wiring/sable-server.test.ts', original=readFileSync(path,'utf8');
const dir=resolve(process.env.S4_MUTANT_DIR ?? '../sable-mutants'); mkdirSync(dir,{recursive:true});
const from='void handleDecisionRequest(event.threadId, event.requestId,', to='void (async (..._args: unknown[]) => {})(event.threadId, event.requestId,';
const anchor='const result = next(url, context);';
const mutation=`${anchor} if(url.endsWith('/server/index.ts')) { const source=String(result.source), from=${JSON.stringify(from)}; if(!source.includes(from))throw Error('missing production request.opened anchor'); return {...result,source:source.replace(from,${JSON.stringify(to)})}; }`;
if(original.split(anchor).length!==2)throw Error('missing fixture loader anchor');
while(loadavg()[0]>76) { console.log('Waiting for host load gate'); await setTimeout(10000); }
try {
  writeFileSync(join(dir,'Sable-drop-producer.mutation.json'),JSON.stringify({path:'server/index.ts',from,to},null,2));
  const source=original.slice(original.indexOf('    await expect.poll(async () => {\n      const value'),original.indexOf('    const events = trace().slice(before)')).trim();
  const result=await verifyDecisionMutant({id:'Sable-drop-producer',dir,args:['node_modules/vitest/vitest.mjs','run',path,'-t','owner, 51'],file:path,assertions:[source],
    mutate:()=>writeFileSync(path,original.replace(anchor,mutation)),restore:()=>writeFileSync(path,original),
    env:{S4_SABLE_EVIDENCE:join(dir,'Sable-drop-producer.json')},redEnv:{S4_SABLE_TIMEOUT_MS:'5000'},timeout:180000,maxBuffer:4*1024*1024});
  const {killed}=result;
  writeFileSync(join(dir,'sable-results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({name:'Sable-drop-producer',killed,exit:result.exit}));
  if(!killed)throw Error('Sable mutant did not fail the delivery witness assertion');
} finally {writeFileSync(path,original);}
