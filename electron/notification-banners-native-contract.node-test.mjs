// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../native/notification-authorization/${name}`, import.meta.url), 'utf8');

test('native banner exports extend the existing authorization exports', () => {
  const source = read('banners.mm');
  for (const name of ['registerCategories', 'post', 'remove', 'onResponse']) {
    assert.match(source, new RegExp(`\\{"${name}", nullptr, \\w+,`));
  }
  const authorization = read('authorization.mm');
  assert.match(authorization, /\{"status", nullptr, Status,/);
  assert.match(authorization, /\{"request", nullptr, Request,/);
  assert.match(authorization, /RegisterBanners\(env, exports\)/);
});

test('categories merge and only Allow and Reply require authentication', () => {
  const source = read('banners.mm');
  assert.match(source, /categoryWithIdentifier:@"murage\.approval"/);
  for (const action of ['allow', 'reply']) {
    assert.match(source, new RegExp(`actionWithIdentifier:@"${action}"[^;]+options:UNNotificationActionOptionAuthenticationRequired`));
  }
  for (const action of ['deny', 'mute']) {
    assert.match(source, new RegExp(`actionWithIdentifier:@"${action}"[^;]+options:UNNotificationActionOptionNone`));
  }
  assert.equal((source.match(/options:UNNotificationActionOptionAuthenticationRequired/g) ?? []).length, 2);
  assert.match(source, /getNotificationCategoriesWithCompletionHandler/);
  assert.match(source, /\[categories mutableCopy\]/);
  assert.match(source, /\[merged addObject:approval\]/);
  assert.match(source, /setNotificationCategories:merged/);
});

test('delegate forwards other notifications, guards modern presentation, and maps responses', () => {
  const source = read('banners.mm');
  assert.match(source, /hasPrefix:@"mb:"/);
  for (const selector of ['willPresentNotification:notification', 'didReceiveNotificationResponse:response']) {
    assert.ok(source.includes(`[previous userNotificationCenter:center ${selector}`));
  }
  assert.match(source, /center\.delegate != bannerDelegate/);
  assert.match(source, /bannerDelegate\.previous = center\.delegate/);
  assert.match(source, /@available\(macOS 11\.0, \*\)/);
  for (const value of ['Banner', 'List', 'Sound', 'Alert']) assert.ok(source.includes(`UNNotificationPresentationOption${value}`));
  assert.match(source, /UNNotificationDefaultActionIdentifier/);
  assert.match(source, /UNNotificationDismissActionIdentifier/);
  assert.match(source, /UNTextInputNotificationResponse/);
  assert.match(source, /userText/);
  assert.doesNotMatch(source, /NSTimer|usleep|setInterval|NSLog/);
});

test('post validates bounds, fences bundle identity, and retires through the shared lifetime', () => {
  const source = read('banners.mm');
  assert.match(source, /ReadString\(env, idValue, 1, 64/);
  assert.match(source, /ReadString\(env, titleValue, 1, 200/);
  assert.match(source, /ReadString\(env, bodyValue, 0, 2000/);
  assert.match(source, /napi_boolean/);
  assert.match(source, /com\.murage\.app/);
  assert.match(source, /60LL \* NSEC_PER_SEC/);
  assert.match(source, /napi_unref_threadsafe_function/);
  assert.match(source, /Deliver\(pending, new Answer/);
  assert.match(source, /removeDeliveredNotificationsWithIdentifiers/);
  assert.match(source, /removePendingNotificationRequestsWithIdentifiers/);
  assert.match(source, /napi_delete_reference\(subscription->env, subscription->listener\)/);
  assert.match(source, /napi_tsfn_abort/);
});

test('first actionable posts wait for the category merge and withdrawal cancels queued work', () => {
  const source = read('banners.mm');
  const registration = source.slice(source.indexOf('void RegisterNativeCategories'), source.indexOf('napi_value RegisterCategories'));
  assert.ok(registration.indexOf('setNotificationCategories:merged') < registration.indexOf('categoriesReady = true'));
  assert.ok(registration.indexOf('categoriesReady = true') < registration.indexOf('post.submit()'));
  assert.match(source, /if \(category && !categoriesReady\)/);
  assert.match(source, /categoryPosts\.size\(\) >= 64\) \{ CompletePost\(weak, false\); return; \}/);
  assert.match(source, /if \(!PostLive\(weak\)\) return;/);
  const remove = source.slice(source.indexOf('napi_value Remove'), source.indexOf('napi_value OnResponse'));
  assert.match(remove, /categoryPosts\.erase/);
  assert.match(remove, /post\.identifier isEqualToString:identifier/);
  assert.match(remove, /CompletePost\(post\.pending, false\)/);
});

test('preflight checks all six exports without invoking addon functions and records the list', () => {
  const steps = read('MAC-PREFLIGHT-STEPS.md');
  const code = steps.split("node --input-type=commonjs - <<'NODE'\n")[1].split('\n          NODE')[0];
  assert.match(code, /\['status', 'request', 'registerCategories', 'post', 'remove', 'onResponse'\]/);
  assert.match(code, /typeof binding\[name\], 'function'/);
  assert.match(code, /Object\.getOwnPropertyNames\(binding\)/);
  assert.match(code, /JSON\.stringify\(\{[\s\S]*arch: process\.arch, exports,/);
  assert.doesNotMatch(code, /binding(?:\.\w+|\[[^\]]+\])\s*\(/);
});
