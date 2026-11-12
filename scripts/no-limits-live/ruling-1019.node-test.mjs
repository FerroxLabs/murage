// SPDX-License-Identifier: AGPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scenarios,assertReleaseReady} from './scenarios.mjs';
import {trulyRows} from './truly-rows.mjs';
for(const id of ['deny-host-declined','deny-browser-never','deny-app-denied','deny-app-revoked','deny-script','cron-write-cards','webhook-routine','webhook-read','webhook-write','webhook-in-owner-room']){
 test(`C3 11-12 release expectation: ${id} runs`,()=>assert.equal(scenarios.find(row=>row.id===id)?.expected,'RUN'));
}
test('C3 implemented field rows no longer block on the former S1 dependency',()=>assert.doesNotThrow(()=>assertReleaseReady()));
test('R1 an explicitly set guest bot uses No limits; an inherited guest bot stays Ask',()=>{
 assert.equal(trulyRows.find(row=>row.id==='truly-R3-guest-explicit-no-limits')?.expected,'RUN');
 assert.equal(trulyRows.find(row=>row.id==='truly-R3-guest-inherited')?.expected,'CARD');
});
test('08:05 channel off reports off-with-line and zero cards',()=>{const row=trulyRows.find(row=>row.id==='truly-R3-channel-off');assert.equal(row?.expected,'OFF_WITH_LINE');assert.equal(row?.expectedCards,0);});
test('C3 Full access and lower parity expectations stay frozen',()=>assert.deepEqual(scenarios.filter(row=>row.id.startsWith('parity-')).map(({id,expected})=>({id,expected})),[
 {id:'parity-ask',expected:'CARD'},{id:'parity-auto',expected:'RUN'},{id:'parity-full',expected:'RUN'},
]));
test('C3 visible catastrophes still require cards',()=>{
 for(const id of ['wipe-home','wipe-home-assignment','python-alias-wipe'])assert.equal(scenarios.find(row=>row.id===id)?.expected,'CARD');
});

test('H6 every formerly red mandatory file belongs to the absolute G-NL fake gate',async()=>{
 const {readFileSync}=await import('node:fs');
 const gate=readFileSync(new URL('../release-gate/gate-1019.mjs',import.meta.url),'utf8');
 const start=gate.indexOf('const replayTests = ['),end=gate.indexOf('];',start),files=gate.slice(start,end);
 for(const file of ['server/nolimits-means-it.test.ts','server/powershell-fail-closed-104.test.ts','server/nolimits-means-it-1020.test.ts','server/no-limits-r13-gate.test.ts'])assert.ok(files.includes(file),file);
});
