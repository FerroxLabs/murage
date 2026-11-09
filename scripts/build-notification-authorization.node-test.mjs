// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildNotificationAuthorization } from './build-notification-authorization.mjs';

test('both architectures compile both native sources and attest all native inputs in order', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'murage-banner-build-'));
  try {
    const headers = path.join(root, 'headers');
    mkdirSync(headers);
    for (const name of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']) {
      writeFileSync(path.join(headers, name), '// injected header fixture\n');
    }
    writeFileSync(path.join(headers, 'node_version.h'), process.versions.node.split('.').map((v, i) =>
      `#define NODE_${['MAJOR', 'MINOR', 'PATCH'][i]}_VERSION ${v}`).join('\n'));
    const calls = [];
    const receipts = buildNotificationAuthorization({
      platform: 'darwin', headerDirectory: headers, outputRoot: path.join(root, 'out'),
      exec(command, args) {
        calls.push({ command, args });
        if (command === '/usr/bin/xcrun') writeFileSync(args[args.indexOf('-o') + 1], 'fixture binary');
      },
    });
    const sources = ['authorization.mm', 'banners.mm'].map(name =>
      fileURLToPath(new URL(`../native/notification-authorization/${name}`, import.meta.url)));
    const compile = calls.filter(call => call.command === '/usr/bin/xcrun');
    assert.equal(compile.length, 2);
    assert.deepEqual(compile.map(call => call.args[call.args.indexOf('-arch') + 1]), ['arm64', 'x86_64']);
    for (const { args } of compile) {
      assert.deepEqual(args.filter(arg => arg.endsWith('.mm')), sources);
      assert.ok(args.includes('-mmacosx-version-min=12.0'));
      assert.ok(args.includes('-DNAPI_VERSION=9'));
    }
    assert.deepEqual(calls.map(call => call.command), ['/usr/bin/xcrun', '/usr/bin/lipo', '/usr/bin/xcrun', '/usr/bin/lipo']);
    const digest = createHash('sha256');
    for (const source of sources) digest.update(readFileSync(source));
    digest.update(readFileSync(new URL('../native/notification-authorization/lifetime.h', import.meta.url)));
    const expected = digest.digest('hex');
    assert.equal(receipts.length, 2);
    for (const [i, receipt] of receipts.entries()) {
      assert.equal(receipt.sourceSha256, expected);
      const arch = ['arm64', 'x64'][i];
      assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'out', arch, 'build.json'))), receipt);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
