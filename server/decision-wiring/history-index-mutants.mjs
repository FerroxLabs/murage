// SPDX-License-Identifier: AGPL-3.0-or-later
import {verifyDecisionMutant} from '../../scripts/test-truth/decision-mutant.test-helper.mjs';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
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
    writeFileSync(join(dir,name+'.mutation.json'),JSON.stringify({path,from,to},null,2));
    const intended={
      'H3-stale-mutation':["expect(members().has(key('shared-thread','appended'))).toBe(false)"],
      'H4-missed-append':["expect(canonical('live').channelTurnId).toBeUndefined()"],
      'H5-missed-retirement':["expect(turns.has(JSON.stringify(['shared-thread','past-turn-1']))).toBe(false)"],
      'H6-channel-history-scan':['expect(measured.storeTraversals).toBe(0)'],
      'H7-live-only-lookup':['expect(measured.runArrayVisits).toBe(0)']
    };
    const result=await verifyDecisionMutant({id:name,dir,args:['node_modules/vitest/vitest.mjs','run','server/decision-wiring/history-index.test.ts','-t',test],file:'server/decision-wiring/history-index.test.ts',assertions:intended[name],
      mutate:()=>writeFileSync(path,original.replace(from,to)),restore:()=>writeFileSync(path,original),maxBuffer:4*1024*1024});
    const {killed}=result;
    results.push(result); console.log(JSON.stringify({name,killed,exit:result.exit}));
    if(!killed)throw Error('mutant not killed by assertion '+name);
  }
} finally {writeFileSync(path,original);writeFileSync(join(dir,'history-results.json'),JSON.stringify(results,null,2));}
