import {test} from 'node:test';
import assert from 'node:assert/strict';
import {englishInventory} from './english-inventory.mjs';
test('English inventory includes replay diagnostics and labels settings prose as fixture-only',()=>{
 const rows=englishInventory();assert.ok(rows.length>100);
 for(const file of ['scripts/nolim-replay/saved-rule.mjs','scripts/nolim-replay/production.mjs','scripts/no-limits-live/feature-off-smoke.mjs'])assert.ok(rows.some(r=>r.file===file&&r.line>0));
 const settings=rows.filter(r=>['scripts/no-limits-live/feature-off-smoke.mjs','scripts/nolim-replay/production.mjs'].includes(r.file)&&/off.*Settings/.test(r.literal));
 assert.ok(settings.length>=3);
 for(const row of settings){assert.equal(row.fixtureOnly,true);assert.equal(row.audience,'fixture-settings-line');assert.equal(row.productUI,false);}
 assert.ok(rows.some(r=>r.literal==='One matching saved permission rule required'));
 assert.ok(rows.some(r=>r.file==='server/routines.ts'&&r.productUI===true&&r.fixtureOnly===false&&r.literal.startsWith('Channel messages are off.')));
});
