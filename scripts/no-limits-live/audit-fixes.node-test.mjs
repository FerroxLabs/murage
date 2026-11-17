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
test('blocking host egress step provisions its exact pinned image before qualification',()=>{
 const workflow=readFileSync('.github/workflows/ci.yml','utf8');
 const pinned='node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4';
 const pull=workflow.indexOf(`docker pull ${pinned}`),run=workflow.indexOf('run: node scripts/no-limits-live/egress/self-test.mjs');
 assert.ok(pull>=0&&pull<run,'pinned Docker image must be provisioned before the blocking self-test');
 assert.ok(readFileSync('scripts/no-limits-live/egress/provision.sh','utf8').includes(pinned));
 assert.match(readFileSync('scripts/no-limits-live/egress/provision.sh','utf8'),/Docker is required for the No limits egress self-test/);
});
