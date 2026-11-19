import assert from 'node:assert/strict';
export function validateObservation(o,groups) {
 assert(Number.isSafeInteger(o.samples)&&o.samples>=4);
 for(const key of ['maxGapMs','finalGapMs'])assert(Number.isFinite(o[key])&&o[key]>=0&&o[key]<=1000,`observer ${key}`);
 assert.deepEqual(o.visible,[]);assert.deepEqual(o.enumerationErrors,[]);
 assert(Number.isFinite(o.startedAt)&&Number.isFinite(o.stoppedAt)&&o.stoppedAt>o.startedAt);
 assert.equal(o.controls.length,groups.length*2,'two positive controls per group');
 for(const g of groups){
  assert(Number.isFinite(g.startedAt)&&Number.isFinite(g.endedAt)&&g.endedAt>=g.startedAt,'group time range');
  assert(o.startedAt<=g.startedAt&&o.stoppedAt>=g.endedAt,'sampler covers entire group');
  const start=o.controls.filter(c=>c.group===g.name&&c.edge==='start'),end=o.controls.filter(c=>c.group===g.name&&c.edge==='end');
  assert.equal(start.length,1);assert.equal(end.length,1);
  for(const c of [...start,...end])assert(c.detected===true&&c.at>=o.startedAt&&c.at<=o.stoppedAt,'detected owned visible console');
  assert(start[0].at<=g.startedAt&&end[0].at>=g.endedAt,'controls bracket group');
 }
}
