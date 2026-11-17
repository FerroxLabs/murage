// SPDX-License-Identifier: AGPL-3.0-or-later
// Coverage inventory for the reviewed test deletions. Behaviour is exercised by
// the retained provider transports and isolated-server continuation tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const base = process.argv[2];
const read = file => base ? execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8');
const providers = read('server/drivers/no-limits-provider-release-1019.test.ts');
const owner = read('server/highlevel/owner-turn-api.test.ts');
const full = "for(const engine of engines)it(`C7 ${engine} Full access preserves its native release path`,()=>run(engine,true,true,'full'),30000);";
assert(providers.includes(full), 'All five existing Full access changed-target release tests must remain.');
assert(providers.includes('refreshed native card can release the same waiting ask after exact wipe review'), 'Retain the additional No limits wipe-release cases too.');
const card = owner.slice(owner.indexOf('const browserCard ='), owner.indexOf('const send ='));
assert(/release\(\);\s*await idle\(bot.id\)/.test(card), 'Browser idle continuations must complete the source turn before answering.');
const ask = owner.slice(owner.indexOf('it("an ask-card answer gets no HighLevel"'), owner.indexOf('it("a direct-thread card continuation'));
assert(ask.indexOf('release();') >= 0 && ask.indexOf('await idle(bot.id)') < ask.indexOf('const answered ='), 'The original ask-card case must answer after source-turn completion.');
assert(owner.includes('a busy ask-card answer gets no HighLevel') && owner.includes('a busy held card continuation gets no HighLevel once tools return'), 'Keep the added busy callback coverage.');
console.log('HighLevel coverage inventory: five Full access cases, idle and busy continuation scenarios retained.');
