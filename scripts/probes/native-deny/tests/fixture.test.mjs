// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, renameSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, withFixture, writeFixture, fixtureEnv, cleanupFixture } from '../fixture.mjs';

test('fresh homes/workdirs are unique and removed on success and exception', async () => {
  const seen = new Set();
  for (const fail of [false, true]) {
    let root;
    const action = withFixture(async fixture => {
      root = fixture.root;
      assert.ok(!seen.has(root)); seen.add(root);
      assert.ok(existsSync(fixture.home)); assert.ok(existsSync(fixture.work));
      writeFixture(fixture, 'work/repo/protected/Home', 'harmless stand-in');
      if (fail) throw new Error('fixture failure');
    });
    if (fail) await assert.rejects(action, /fixture failure/); else await action;
    assert.equal(existsSync(root), false);
  }
});
test('cleanup removes links without following them to another fixture', () => {
  const outside = createFixture(), inside = createFixture();
  try {
    const target = writeFixture(outside, 'keep', 'keep');
    symlinkSync(outside.root, join(inside.root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    cleanupFixture(inside);
    assert.equal(readFileSync(target, 'utf8'), 'keep');
  } finally { cleanupFixture(outside); }
});
test('path traversal and symlink writes cannot escape fixture ownership', () => {
  const a = createFixture(), b = createFixture();
  try {
    for (const path of ['../escape', '/absolute', '..\\escape', '']) assert.throws(() => writeFixture(a, path, 'bad'));
    symlinkSync(b.root, join(a.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeFixture(a, 'linked/escape', 'bad'), /SYMLINK/);
    symlinkSync(join(b.root, 'missing'), join(a.root, 'dangling'));
    assert.throws(() => writeFixture(a, 'dangling', 'bad'), /SYMLINK/);
    assert.equal(existsSync(join(b.root, 'missing')), false);
    assert.equal(existsSync(join(b.root, 'escape')), false);
    assert.throws(() => cleanupFixture({ root: b.root }), /NOT-OWNED/);
  } finally { cleanupFixture(a); cleanupFixture(b); }
});
test('changed marker or replaced root refuses cleanup rather than deleting unowned data', () => {
  const a = createFixture(), b = createFixture();
  const marker = readFileSync(join(a.root, '.fixture-owner'));
  const saved = a.root + '-saved';
  try {
    writeFileSync(join(a.root, '.fixture-owner'), 'wrong');
    assert.throws(() => cleanupFixture(a), /CLEANUP-REFUSED/);
    writeFileSync(join(a.root, '.fixture-owner'), marker);
    renameSync(a.root, saved);
    symlinkSync(b.root, a.root, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanupFixture(a), /CLEANUP-REFUSED/);
    assert.ok(existsSync(b.home));
    rmSync(a.root); renameSync(saved, a.root);
  } finally {
    if (existsSync(saved)) { rmSync(a.root, { force: true }); renameSync(saved, a.root); }
    cleanupFixture(a); cleanupFixture(b);
  }
});
test('environment drops credentials, preload hooks and all user configuration pointers', () => {
  const fixture = createFixture();
  try {
    const env = fixtureEnv(fixture, { PATH: '/usr/bin', HOME: '/real-user', OPENAI_API_KEY: 'do-not-forward', NODE_OPTIONS: '--require bad', GIT_CONFIG_GLOBAL: '/real-config', XDG_DATA_HOME: '/real-data', SSH_AUTH_SOCK: '/real-agent' });
    assert.equal(env.PATH, '/usr/bin'); assert.equal(env.HOME, fixture.home);
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined);
    for (const [key, value] of Object.entries(env)) if (/HOME|DATA|TMP|TEMP|GIT_CONFIG_(GLOBAL|SYSTEM)/.test(key) && !['GIT_CONFIG_NOSYSTEM'].includes(key)) assert.ok(value.startsWith(fixture.root), key);
    assert.ok(existsSync(env.GIT_CONFIG_GLOBAL)); assert.ok(existsSync(env.GIT_CONFIG_SYSTEM));
  } finally { cleanupFixture(fixture); }
});
test('withFixture leaves the caller temp parent and its other files intact', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'probe-parent-test-'));
  try {
    const sentinel = join(parent, 'keep'); writeFileSync(sentinel, 'keep');
    await withFixture(async fixture => assert.ok(fixture.root.startsWith(parent)), parent);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally { if (parent) { rmSync(join(parent, 'keep'), { force: true }); rmdirSync(parent); } }
});
