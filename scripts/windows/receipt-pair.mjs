import {validateGroupEvidence} from './group-proof.mjs';
import {validateCleanup} from './cleanup-proof.mjs';
import {validateObservation} from './observation.mjs';
import { validateIdentity } from './package-identity.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
export const desktopGroups = ['bot-turns', 'tools', 'sentinel', 'mcp', 'browser', 'updates-isolated'];
export function validateReceipt(r) {
  validateIdentity(r);
  validateCleanup(r);
  assert(['desktop','handoff'].includes(r.kind), 'receipt kind');
  assert.match(r.commit, /^[a-f0-9]{40}$/i); assert.match(r.sha256, /^[a-f0-9]{64}$/i);
  assert.match(r.updateSha256, /^[a-f0-9]{64}$/i);
  assert.equal(r.candidateVersion, '1.0.19'); assert.match(r.updateVersion, /^\d+\.\d+\.\d+$/);
  assert.match(r.updateVersion,/^1\.0\.[1-9]\d*$/);assert(Number(r.updateVersion.split('.')[2])>19&&Number(r.updateVersion.split('.')[2])<=65535,'higher fixture patch version');
  assert.equal(r.isolated, r.kind === 'desktop'); assert.equal(r.fakeProvidersOnly, true);
  assert.equal(typeof r.machine,'string');assert(r.machine.length);if(r.kind==='handoff')assert.equal(r.machine,'gate-win-nogit');
  assert.equal(typeof r.user, 'string'); assert(r.user.length); if(r.kind==='handoff') assert.equal(r.user,'murage-gate');
  assert.match(r.fixture, /^[A-Za-z]:\\/); assert.match(r.executable, /^[A-Za-z]:\\.*\.exe$/i);
  const expected = r.kind === 'desktop' ? desktopGroups : ['updates-handoff'];
  assert.deepEqual(r.groups.map(g=>g.name).sort(), [...expected].sort(), 'all mandatory groups exactly once');
  for (const g of r.groups) {
    assert(Number.isSafeInteger(g.passed) && g.passed > 0); assert.equal(g.failed,0); assert.equal(g.skipped,0);
    assert(Array.isArray(g.artifacts) && g.artifacts.length); assert.equal(new Set(g.artifacts).size,g.artifacts.length);
    for(const p of g.artifacts) assert(typeof p==='string' && p.length && !/[:\x00-\x1f]/.test(p) && !/^[\\/]/.test(p) && !p.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'), 'safe evidence path');
  }
  assert(Number.isSafeInteger(r.observer.samples) && r.observer.samples>=4);
  assert(Number.isFinite(r.observer.maxGapMs) && r.observer.maxGapMs>=0 && r.observer.maxGapMs<=1000);
  assert.deepEqual(r.observer.visible,[]); assert.deepEqual(r.observer.enumerationErrors,[]);
  validateObservation(r.observer,r.groups);
  return r;
}
export function pairReceipts(receipts) {
  assert.equal(receipts.length,2,'BOTH receipts required');
  const sorted=receipts.map(validateReceipt).sort((a,b)=>a.kind.localeCompare(b.kind));
  assert.deepEqual(sorted.map(r=>r.kind),['desktop','handoff']);
  for(const key of ['commit','packageSha256','sha256','candidateVersion','updateVersion','updateSha256']) assert.equal(sorted[0][key].toLowerCase(),sorted[1][key].toLowerCase(),`same ${key} required`);
  assert.deepEqual(sorted[0].appManifest,sorted[1].appManifest,'same full staged app manifest required');
  return {packageSha256:sorted[0].packageSha256,appManifest:sorted[0].appManifest,commit:sorted[0].commit,sha256:sorted[0].sha256,updateVersion:sorted[0].updateVersion};
}
export function readReceipt(file) {
  const r=validateReceipt(JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
  // A copied receipt travels with its evidence directory; never dereference a remote fixture path.
  for(const g of r.groups) for(const p of g.artifacts) {
    const artifact=resolve(dirname(file),p), rel=relative(dirname(file),artifact);
    assert(!isAbsolute(rel)&&!rel.startsWith('..')); assert(existsSync(artifact)&&statSync(artifact).isFile()&&statSync(artifact).size>0,`missing evidence ${artifact}`);
    const real=relative(realpathSync(dirname(file)),realpathSync(artifact));assert(!isAbsolute(real)&&!real.startsWith('..'),'evidence symlink escaped fixture');
  }
  const json=p=>JSON.parse(readFileSync(resolve(dirname(file),p),'utf8').replace(/^\uFEFF/,''));
  for(const g of r.groups) {
    const before=`evidence/${g.name}-before-snapshot.json`,after=`evidence/${g.name}-after-snapshot.json`,result=`evidence/${g.name}.json`;
    for(const p of [before,after,result])assert(g.artifacts.includes(p),'required snapshot evidence');
    validateGroupEvidence(r.kind,json(before),json(after),json(result),r.cleanup.prefix);
  }
  return r;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [desktop,handoff,output]=process.argv.slice(2); assert(desktop&&handoff&&output,'usage: receipt-pair.mjs desktop.json handoff.json NEW-pair.json');
  const result=pairReceipts([readReceipt(desktop),readReceipt(handoff)]);
  writeFileSync(output,JSON.stringify({status:'PASS',...result,receipts:[desktop,handoff]},null,2),{flag:'wx'});
  console.log(`PASS winhide commit=${result.commit} sha256=${result.sha256} BOTH receipts`);
}
