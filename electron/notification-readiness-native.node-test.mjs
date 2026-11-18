// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// readiness() (native/notification-authorization/readiness.h): the real N-API code, compiled here against a scripted OS bridge
// (testing/readiness-stub.cc), then read through the same gate the Mac adapter uses. The Mac bridge itself (banners.mm) cannot
// compile off a Mac: its source is pinned below and it is proven on a real Mac by the lane's MACRUN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { createMacBanners, macActionReadiness } from './mac-banners.mjs';

const native = name => fileURLToPath(new URL(`../native/notification-authorization/${name}`, import.meta.url));
const read = name => readFileSync(native(name), 'utf8');
const FULL = 'murage.approval=allow:a,deny:,reply:at,mute:';
const OPEN = { authorization: 2, alert: 2, previews: 0, category: true, failed: false };
const CLOSED = { authorization: -1, alert: -1, previews: -1, category: false, failed: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The stub builds wherever the app's own native code can build. Windows has no readiness() and no C++ driver on PATH.
const compiles = process.platform === 'linux' || process.platform === 'darwin';
let stub = null, scratch = null;
function addon() {
  if (stub) return stub;
  scratch = mkdtempSync(path.join(tmpdir(), 'murage-readiness-stub-'));
  const output = path.join(scratch, 'readiness-stub.node');
  const headers = path.resolve(path.dirname(realpathSync(process.execPath)), '../include/node');
  const link = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC', '-pthread'];
  execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-Wall', '-Werror', '-DNAPI_VERSION=9', ...link, '-I', headers, native('testing/readiness-stub.cc'), '-o', output], { stdio: 'pipe' });
  stub = createRequire(import.meta.url)(output);
  return stub;
}
test.after(() => { if (scratch) safeWipeSync(scratch); });
/** One scripted read. The timer keeps the loop alive: the addon's own handle is unreferenced by design. */
async function readiness({ mode = 'answer', authorization = 2, alert = 2, previews = 0, categories = FULL, expireMs = 40, waitMs = 2000 } = {}) {
  const bridge = addon();
  bridge.script(mode, authorization, alert, previews, categories, expireMs);
  let timer;
  try {
    return await Promise.race([bridge.readiness(), new Promise(resolve => { timer = setTimeout(() => resolve('NO ANSWER'), waitMs); })]);
  } finally { clearTimeout(timer); }
}

test('an authorised Mac with previews on and the full category reads as ready', { skip: !compiles }, async () => {
  const value = await readiness();
  assert.deepEqual(value, OPEN);
  assert.deepEqual(Object.keys(value).sort(), ['alert', 'authorization', 'category', 'failed', 'previews']);
  assert.deepEqual(macActionReadiness(value), { ok: true });
});

test('authorization and the alert setting pass through as the OS reported them', { skip: !compiles }, async () => {
  for (const authorization of [0, 1, 3]) {
    const value = await readiness({ authorization });
    assert.deepEqual(value, { ...OPEN, authorization });
    assert.deepEqual(macActionReadiness(value), { ok: false, reason: 'unauthorised' });
  }
  for (const alert of [0, 1]) {
    const value = await readiness({ alert });
    assert.deepEqual(value, { ...OPEN, alert });
    assert.deepEqual(macActionReadiness(value), { ok: false, reason: 'unauthorised' });
  }
});

test('the preview setting passes through: when unlocked stays ready, never does not', { skip: !compiles }, async () => {
  const unlocked = await readiness({ previews: 1 });
  assert.deepEqual(unlocked, { ...OPEN, previews: 1 });
  assert.deepEqual(macActionReadiness(unlocked), { ok: true });
  const never = await readiness({ previews: 2 });
  assert.deepEqual(never, { ...OPEN, previews: 2 });
  assert.deepEqual(macActionReadiness(never), { ok: false, reason: 'previews' });
});

test('the category counts only when Allow and Reply need authentication, Reply takes text and Deny is there', { skip: !compiles }, async () => {
  const missing = {
    'no categories at all': '',
    'another category only': 'other.category=allow:a,deny:,reply:at',
    'a different identifier': 'murage.approval2=allow:a,deny:,reply:at',
    'Allow missing': 'murage.approval=deny:,reply:at',
    'Deny missing': 'murage.approval=allow:a,reply:at',
    'Reply missing': 'murage.approval=allow:a,deny:',
    'Allow without authentication': 'murage.approval=allow:,deny:,reply:at',
    'Reply without authentication': 'murage.approval=allow:a,deny:,reply:t',
    'Reply that is not a text input': 'murage.approval=allow:a,deny:,reply:a',
    'Allow as a text input': 'murage.approval=allow:at,deny:,reply:at',
    'Deny as a text input': 'murage.approval=allow:a,deny:t,reply:at',
    'Allow twice': 'murage.approval=allow:a,allow:a,deny:,reply:at',
    'a second, incomplete copy': `${FULL};murage.approval=allow:a,deny:`,
  };
  for (const [name, categories] of Object.entries(missing)) {
    const value = await readiness({ categories });
    assert.deepEqual(value, { ...OPEN, category: false }, name);
    assert.deepEqual(macActionReadiness(value), { ok: false, reason: 'category' }, name);
  }
  for (const categories of [FULL, 'murage.approval=reply:at,deny:,allow:a', `other.category=x:;${FULL}`, 'murage.approval=allow:a,deny:a,reply:at']) {
    assert.deepEqual(await readiness({ categories }), OPEN, categories);
  }
});

test('a failed read carries no usable value', { skip: !compiles }, async () => {
  const failed = await readiness({ mode: 'failed' });
  assert.deepEqual(failed, CLOSED);
  assert.deepEqual(macActionReadiness(failed), { ok: false, reason: 'unavailable' });
  for (const unknown of [{ authorization: -1 }, { alert: -1 }, { previews: -1 }]) {
    assert.deepEqual(await readiness(unknown), CLOSED, JSON.stringify(unknown));
  }
});

test('a read the OS never answers settles as failed at the bound, not before', { skip: !compiles }, async () => {
  const started = Date.now();
  const value = await readiness({ mode: 'never', expireMs: 120 });
  assert.deepEqual(value, CLOSED);
  assert.ok(Date.now() - started >= 100, 'settled before the bound');
});

test('only the first answer counts, from any thread, and a late one changes nothing', { skip: !compiles }, async () => {
  assert.deepEqual(await readiness({ mode: 'twice', authorization: 1 }), { ...OPEN, authorization: 1 });
  assert.deepEqual(await readiness({ mode: 'thread', previews: 2 }), { ...OPEN, previews: 2 });
  assert.deepEqual(await readiness({ mode: 'thread' }), OPEN);
  const late = await readiness({ mode: 'late', expireMs: 30 });
  assert.deepEqual(late, CLOSED);
  await sleep(150); // the late answer has arrived by now and was dropped
  const before = addon().reads();
  assert.deepEqual(await readiness(), OPEN);
  assert.equal(addon().reads(), before + 1);
});

test('each call is one fresh read and takes no arguments', { skip: !compiles }, async () => {
  const before = addon().reads();
  assert.deepEqual(await readiness({ authorization: 1 }), { ...OPEN, authorization: 1 });
  assert.deepEqual(await readiness(), OPEN);
  assert.equal(addon().reads(), before + 2);
  assert.throws(() => addon().readiness({}), { code: 'NOTIFICATION_READINESS_ARGUMENTS' });
  assert.throws(() => addon().readiness(1, 2), { code: 'NOTIFICATION_READINESS_ARGUMENTS' });
  assert.equal(addon().reads(), before + 2);
  await sleep(80);
});

test('the Mac adapter shows buttons through the native read only when it is ready', { skip: !compiles }, async () => {
  const entry = { frame: { botId: 'bot-1', threadId: 'thread-1', messageId: 'message-1' }, home: 'home-1' };
  const record = { display: { botName: 'Fixture bot', title: 'Run a command', willRun: 'ls' }, outsideOk: { 'banner-mac': true }, digest: 'digest-1', approvalId: 'approval-1', requestRef: 'request-1', actionHash: 'hash-1' };
  async function show(script) {
    const posts = [], minted = [];
    const bridge = addon();
    bridge.script(script.mode ?? 'answer', script.authorization ?? 2, script.alert ?? 2, script.previews ?? 0, script.categories ?? FULL, 40);
    const banners = createMacBanners({
      platform: 'darwin', readinessTimeoutMs: 1000,
      loadAddon: () => ({ readiness: () => bridge.readiness(), registerCategories() {}, post: async spec => { posts.push(spec); return true; }, remove() {}, onResponse: () => () => {} }),
      mint: spec => { minted.push(spec); return 'token-1'; }, act: async () => ({ ok: true }), open() {},
    });
    const ids = await banners.show({ entry, record, actionsOn: true, plain: { title: 'Fixture', body: 'Fixture' } });
    banners.dispose();
    assert.equal(ids?.length, 1);
    return { category: posts[0].category, body: posts[0].body, minted: minted.length };
  }
  assert.deepEqual(await show({}), { category: 'murage.approval', body: 'ls', minted: 1 });
  assert.deepEqual(await show({ previews: 1 }), { category: 'murage.approval', body: 'ls', minted: 1 });
  const openOnly = { category: null, body: 'Fixture bot', minted: 0 };
  assert.deepEqual(await show({ authorization: 1 }), openOnly);
  assert.deepEqual(await show({ alert: 1 }), openOnly);
  assert.deepEqual(await show({ previews: 2 }), openOnly);
  assert.deepEqual(await show({ categories: 'murage.approval=allow:,deny:,reply:at' }), openOnly);
  assert.deepEqual(await show({ mode: 'failed' }), openOnly);
  assert.deepEqual(await show({ mode: 'never' }), openOnly);
  await sleep(80);
});

test('the Mac bridge asks the notification centre for settings, previews and the registered categories', () => {
  const source = read('banners.mm');
  assert.match(source, /#include "readiness\.h"/);
  const bridge = source.slice(source.indexOf('void ReadReadinessNow'), source.indexOf('napi_value RegisterCategories'));
  assert.ok(bridge.length > 0);
  assert.match(bridge, /getNotificationSettingsWithCompletionHandler/);
  assert.match(bridge, /static_cast<int>\(settings\.authorizationStatus\)/);
  assert.match(bridge, /static_cast<int>\(settings\.alertSetting\)/);
  assert.match(bridge, /static_cast<int>\(settings\.showPreviewsSetting\)/);
  assert.ok(bridge.indexOf('getNotificationSettingsWithCompletionHandler') < bridge.indexOf('getNotificationCategoriesWithCompletionHandler'));
  assert.match(bridge, /action\.options & UNNotificationActionOptionAuthenticationRequired\) != 0/);
  assert.match(bridge, /isKindOfClass:\[UNTextInputNotificationAction class\]/);
  assert.match(bridge, /ReadinessFacts\{authorization, alert, previews, ApprovalCategoryRegistered\(facts\), false\}/);
  assert.match(bridge, /if \(!settings\) \{ done\(ReadinessFacts\{\}\); return; \}/);
  assert.match(bridge, /if \(!categories\) \{ done\(ReadinessFacts\{\}\); return; \}/);
  // Only Murage's own bundle is read, and the first read waits for the category merge instead of racing it.
  assert.match(bridge, /if \(!AppBundle\(\)\) \{ done\(ReadinessFacts\{\}\); return; \}/);
  assert.match(bridge, /if \(categoriesReady\) \{ ReadReadinessNow\(center, done\); return; \}/);
  assert.match(bridge, /if \(categoryReads\.size\(\) >= 64\) \{ done\(ReadinessFacts\{\}\); return; \}/);
  assert.match(bridge, /10LL \* NSEC_PER_SEC/);
  assert.match(bridge, /const ReadinessBridge readinessBridge = \{ReadReadiness, ExpireReadiness\};/);
  const registration = source.slice(source.indexOf('void RegisterNativeCategories'), source.indexOf('void ReadReadinessNow'));
  assert.ok(registration.indexOf('categoriesReady = true') > 0);
  assert.ok(registration.indexOf('categoriesReady = true') < registration.indexOf('for (const auto& read : reads) read();'));
  assert.match(source, /RegisterReadiness\(env, exports, &readinessBridge\)/);
  // The read changes nothing: it never asks for permission, posts or replaces a category.
  assert.doesNotMatch(bridge, /requestAuthorization|addNotificationRequest|setNotificationCategories|NSTimer|usleep|NSLog/);
});

test('the shared code holds no Apple or Mac-only call, so the stub runs the same bytes', () => {
  const header = read('readiness.h');
  const code = header.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
  assert.match(code, /inline napi_value Readiness\(/);
  assert.doesNotMatch(code, /#import|dispatch_|\bUN[A-Z][a-z]\w+|\bNS[A-Z][a-z]\w+|@autoreleasepool|@available/);
  assert.match(header, /napi_unref_threadsafe_function\(env, pending->callback\)/);
  assert.match(header, /\{"readiness", nullptr, Readiness,/);
  const stubSource = read('testing/readiness-stub.cc');
  assert.match(stubSource, /#include "\.\.\/readiness\.h"/);
  assert.match(stubSource, /RegisterReadiness\(env, exports, &stubBridge\)/);
});
