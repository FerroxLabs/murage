// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Missing controls, early failures and missing kills must all fail the gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] ?? '.reds-block1');
const summary = JSON.parse(readFileSync(`${root}/summary.json`, 'utf8'));
for (const id of ['control-browser-owner-approve', 'control-browser-direct-owner-api', 'control-telegram-permission-wiring', 'control-project-runtime-boundaries', 'control-runtime', 'control-automation-terms']) {
  const row = summary.find(r => r.id === id);
  assert(row?.exit === 0 && row.passed > 0 && row.failed === 0 && row.valid, `missing passing control: ${id}`);
}
const assertions = {
  'owner-desktop-delivery': 'expect(f.answers[0]!.options).toMatchObject({ desktop: true })',
  'direct-readiness-code': 'expect(result,JSON.stringify(result)).toMatchObject',
  'channel-stale-fingerprint': 'expect(await actions.resolve(offered, "allow")).toBe(false)',
  'watchdog-resolved-wait': 'expect(watchdog.setWaitingOnHuman).toHaveBeenLastCalledWith("room", false, "approval")',
  'retired-write-release': 'expect(release).toHaveBeenCalledTimes(1)',
  'release-owner-proof': 'expect(releaseHook).toContain("ownerStartedRuns.delete(generation);")',
  'release-highlevel-proof': 'expect(releaseHook).toContain("highlevelProvenRuns.delete(generation);")',
  'setup-applied-mid-reply': 'expect((await cardFor(bot.threadId, onFull.body.requestId)).answered).toBeUndefined()',
  'setup-skips-clean-apply': 'expect((await cardFor(bot.threadId, onFull.body.requestId)).answered).toBe("allow")',
  'setup-loses-receipt': 'expect(receipts().find((row) => row.requestId === onFull.body.requestId)).toMatchObject',
};
for (const [id, assertion] of Object.entries(assertions)) {
  const row = summary.find(r => r.id === id);
  assert(row?.exit === 1 && row.failed > 0 && row.valid && row.failures.length === row.failed, `missing mutant kill: ${id}`);
  assert(readFileSync(`${root}/${id}.patch`, 'utf8').includes('@@'), `missing mutant patch: ${id}`);
  const log = readFileSync(`${root}/${id}.log`, 'utf8');
  const testSource = readFileSync(`${root}/${id}.test-source.txt`, 'utf8');
  const command = JSON.parse(readFileSync(`${root}/${id}.command.json`, 'utf8'));
  const original = readFileSync(command.original, 'utf8');
  const hash = s => createHash('sha256').update(s).digest('hex');
  assert.equal(hash(original), command.originalSHA256, `original source changed: ${id}`);
  assert.equal(hash(testSource), command.temporaryTestSHA256, `temporary source changed: ${id}`);
  const expects = s => s.split('\n').filter(line => /\bexpect(?:\.|\()/.test(line));
  assert.deepEqual(expects(testSource), expects(original), `assertions changed in temporary test: ${id}`);
  for (const failure of row.failures) {
    const location = new RegExp(`reds-block1-${id}\\.test\\.ts:(\\d+):\\d+`).exec(failure.messages.join('\n'));
    assert(location, `missing assertion stack: ${id}`);
    assert(testSource.split('\n')[Number(location[1]) - 1]?.includes(assertion), `mutant did not reach its intended assertion: ${id}`);
  }
  if (id === 'direct-readiness-code') assert(log.includes('browser-cause:chrome_closed:0|') && log.includes('browser-cause:chrome_status_unknown:0|'));
  assert(!row.failures.some(f => f.messages.some(m => /ReferenceError|SyntaxError|server never came up/.test(m))), `invalid early failure: ${id}`);
}
const handoff = summary.find(r => r.id === 'red-authority-handoff');
assert(handoff?.exit === 1 && handoff.failed === 1, 'unchanged S4 regression was not reproduced');
assert(readFileSync(`${root}/red-authority-handoff.log`, 'utf8').includes('expect(onFull.body.startsWhen).toBe("reply-ends")'), 'S4 failure moved');
console.log('PASS: six passing controls, the unchanged S4 RED, ten focused patches and ten intended-assertion mutant kills.');
