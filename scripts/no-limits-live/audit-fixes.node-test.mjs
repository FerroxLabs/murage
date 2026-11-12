import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('blocking quality command executes both gate Node globs and inventories every self-test',()=>{
 const pkg=JSON.parse(readFileSync('package.json'));
 for(const dir of ['no-limits-live','nolim-replay'])assert.ok(pkg.scripts['test:electron'].includes(`scripts/${dir}/*.node-test.mjs`));
 const inventory=readFileSync('ci/gate-tests.txt','utf8');
 for(const line of readFileSync('scripts/no-limits-live/ci-tiers.tsv','utf8').trim().split('\n'))assert.ok(inventory.includes(line),line);
 assert.match(readFileSync('.github/workflows/ci.yml','utf8'),/run: node scripts\/no-limits-live\/egress\/self-test.mjs/);
});
