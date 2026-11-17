#!/bin/bash
set -euo pipefail
node scripts/ci-test-tiers.mjs check > lane-evidence/ci-reds-r2/test-tiers.log 2>&1
node --input-type=module <<'JS' > lane-evidence/ci-reds-r2/signal-pins.log
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const list = JSON.parse(readFileSync('server/no-powershell-spawn.allowlist.json','utf8'));
for (const file of ['server/channels/signal/storage.ts','server/channels/signal/service.ts']) {
  const source = readFileSync(file,'utf8');
  const entry = list.reviewed_security[file];
  assert.equal(createHash('sha256').update(source).digest('hex'),entry.source_sha256);
  for (const [hash,call] of Object.entries(entry.launches)) {
    assert(source.includes(call));
    assert.equal(createHash('sha256').update(call.trim()).digest('hex').slice(0,16),hash);
  }
  console.log(file + ': full source and exact invocation pins match');
}
JS
