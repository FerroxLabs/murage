// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {loadavg} from 'node:os';
import {resolve, join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
const path = 'server/routines.ts', original = readFileSync(path,'utf8');
const dir = resolve(process.env.S4_MUTANT_DIR ?? '../history-mutants');
mkdirSync(dir,{recursive:true});
const lookup = 'const prior = this.indexes.channelTurns.get(JSON.stringify([event.threadId, event.turnId]));';
const mutants = [
  ['H3-stale-mutation', 'this.dirtyRuns.add(tracked); this.runRevision++; this.updateRunIndex(tracked);', 'this.dirtyRuns.add(tracked); this.runRevision++;', 'channel membership follows'],
  ['H4-missed-append', 'this.updateRunIndex(run, this.nextRunOrder++);', 'this.updateRunIndex(run, this.nextRunOrder++); this.bucketDelete(this.indexes.channelTurns, this.indexes.indexedRuns.get(run)?.channelTurnKey, run);', 'channel membership follows'],
  ['H5-missed-retirement', 'this.indexMembership(this.indexes, run, item, false);', '', 'history retirement'],
  ['H6-channel-history-scan', lookup, 'const prior = new Set([...this.runStore].filter(other => other.threadId === event.threadId && other.channelTurnId === event.turnId));', 'historic channel turn rejection'],
  ['H7-live-only-lookup', lookup, 'const prior = new Set([...this.indexes.liveRuns].filter(other => other.threadId === event.threadId && other.channelTurnId === event.turnId));', 'historic channel turn rejection'],
];
const results=[];
try {
  for(const [name,from,to,test] of mutants) {
    while(loadavg()[0]>76) { console.log('Waiting for host load gate'); await setTimeout(10000); }
    if(original.split(from).length!==2)throw Error('nonunique mutant anchor '+name);
    writeFileSync(path,original.replace(from,to));
    writeFileSync(join(dir,name+'.mutation.json'),JSON.stringify({path,from,to},null,2));
    const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/decision-wiring/history-index.test.ts','-t',test],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    const output=(run.stdout??'')+(run.stderr??'');
    writeFileSync(join(dir,name+'.log'),`EXIT ${run.status}\n${output}`);
    const killed=run.status===1&&output.includes('AssertionError:');
    results.push({name,killed,exit:run.status}); console.log(JSON.stringify(results.at(-1)));
    writeFileSync(path,original);
    if(!killed)throw Error('mutant not killed by assertion '+name);
  }
} finally {writeFileSync(path,original);writeFileSync(join(dir,'history-results.json'),JSON.stringify(results,null,2));}
