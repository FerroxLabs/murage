import test from 'node:test';
import {cleanup} from './cleanup-fixture.mjs';
import assert from 'node:assert/strict';
import {validateReceipt, pairReceipts, desktopGroups} from './receipt-pair.mjs';
const commit = 'a'.repeat(40), sha256 = 'b'.repeat(64);
export function receipt(kind) {
  return { cleanup:cleanup(kind), kind, machine:kind==='handoff'?'gate-win-nogit':'gate-win-desktop',commit, sha256, packageSha256: 'e'.repeat(64), appManifest: [{path:'Murage.exe',sha256},{path:'resources/app.asar',sha256:'f'.repeat(64)},{path:'resources/build-provenance.json',sha256:'a'.repeat(64)}], fixture: 'C:\\murage-ci\\runs\\winhide-test', executable: 'C:\\murage-ci\\app\\Murage.exe',
    isolated: kind === 'desktop', fakeProvidersOnly: true, user: kind === 'handoff' ? 'murage-gate' : 'desktop',
    candidateVersion: '1.0.19', updateVersion: '1.0.190', updateSha256: 'c'.repeat(64),
    observer: { startedAt:100,stoppedAt:900,finalGapMs:250,controls:(kind === 'desktop' ? desktopGroups : ['updates-handoff']).flatMap(group=>[{group,edge:'start',at:200,detected:true},{group,edge:'end',at:800,detected:true}]),samples: 8, maxGapMs: 251, visible: [], enumerationErrors: [] },
    groups: (kind === 'desktop' ? desktopGroups : ['updates-handoff']).map(name => ({name,startedAt:300,endedAt:700, passed: 3, failed: 0, skipped: 0, artifacts: [`evidence/${name}.json`]})) };
}
test('both receipts of the same candidate pass', () => assert.equal(pairReceipts([receipt('desktop'), receipt('handoff')]).commit, commit));
for (const kind of ['desktop', 'handoff']) test(`one ${kind} receipt cannot pass the gate`, () => assert.throws(() => pairReceipts([receipt(kind)])));
test('duplicate desktop is not a pair', () => assert.throws(() => pairReceipts([receipt('desktop'), receipt('desktop')])));
for (const field of ['commit', 'sha256', 'updateSha256', 'updateVersion']) test(`pair rejects mismatched ${field}`, () => {
 const other = receipt('handoff'); other[field] = field.includes('Version') ? '1.0.191' : 'd'.repeat(field === 'commit' ? 40 : 64);
 assert.throws(() => pairReceipts([receipt('desktop'), other]));
});
for (const mutate of [r=>r.groups.pop(), r=>r.groups[0].skipped++, r=>r.groups[0].failed++, r=>r.groups[0].passed=0,
 r=>r.groups[0].artifacts=['../escape'], r=>r.observer.visible.push('console'), r=>r.observer.samples=0,
 r=>r.observer.maxGapMs=1001, r=>r.observer.enumerationErrors.push(5), r=>r.isolated=false,
 r=>r.fakeProvidersOnly=false, r=>r.updateVersion='1.0.19-gate.1']) {
 test(`rejects invalid receipt: ${mutate}`, () => { const r=receipt('desktop'); mutate(r); assert.throws(()=>validateReceipt(r)); });
}

test('handoff receipt must come from gate-win-nogit',()=>{const r=receipt('handoff');r.machine='gate-win-desktop';assert.throws(()=>validateReceipt(r));});

for (const field of ['packageSha256','appManifest']) test(`same exe cannot hide a different ${field}`, () => {
 const other=receipt('handoff');
 if(field==='appManifest') other.appManifest[1].sha256='0'.repeat(64); else other[field]='0'.repeat(64);
 assert.throws(()=>pairReceipts([receipt('desktop'),other]));
});
for(const field of ['packageSha256','appManifest']) test(`legacy receipt without ${field} fails closed`,()=>{
 const r=receipt('desktop');delete r[field];assert.throws(()=>validateReceipt(r));
});
