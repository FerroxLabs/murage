// SPDX-License-Identifier: AGPL-3.0-or-later
import { withHideInherit } from '../../shared/win-hide-child-process.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {loadavg} from 'node:os';
import {setTimeout} from 'node:timers/promises';
// Mutate the production ingress in the fixture loader; port-a owns index.ts.
const path='server/decision-wiring/sable-server.test.ts', original=readFileSync(path,'utf8');
const dir=resolve(process.env.S4_MUTANT_DIR ?? '../sable-mutants'); mkdirSync(dir,{recursive:true});
const from='void handleDecisionRequest(event.threadId, event.requestId,', to='void (async (..._args: unknown[]) => {})(event.threadId, event.requestId,';
const anchor='const result = next(url, context);';
const mutation=`${anchor}\n  if(url.endsWith('/server/index.ts')) {\n    const source=String(result.source), from=${JSON.stringify(from)};\n    if(!source.includes(from))throw Error('missing production request.opened anchor');\n    return {...result,source:source.replace(from,${JSON.stringify(to)})};\n  }`;
if(original.split(anchor).length!==2)throw Error('missing fixture loader anchor');
while(loadavg()[0]>76) { console.log('Waiting for host load gate'); await setTimeout(10000); }
try {
  writeFileSync(path,original.replace(anchor,mutation));
  writeFileSync(join(dir,'Sable-drop-producer.mutation.json'),JSON.stringify({path:'server/index.ts',from,to},null,2));
  const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',path,'-t','owner, 51'],withHideInherit({
    env:{...process.env,S4_SABLE_TIMEOUT_MS:'5000',S4_SABLE_EVIDENCE:join(dir,'Sable-drop-producer.json')},encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024}));
  const output=(run.stdout??'')+(run.stderr??'');
  writeFileSync(join(dir,'Sable-drop-producer.log'),`EXIT ${run.status}\n${output}`);
  const killed=run.status===1&&output.includes('AssertionError:')&&output.includes('Matcher did not succeed in time');
  writeFileSync(join(dir,'sable-results.json'),JSON.stringify({name:'Sable-drop-producer',killed,exit:run.status}));
  console.log(JSON.stringify({name:'Sable-drop-producer',killed,exit:run.status}));
  if(!killed)throw Error('Sable mutant did not fail the delivery witness assertion');
} finally {writeFileSync(path,original);}
