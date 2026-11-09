// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = name => readFileSync(new URL("../native/presence-guard/" + name, import.meta.url), "utf8");
const mac = source("presence-mac.mm"), win = source("presence-win.cc"), lifetime = source("lifetime.h");

test("both native modules expose synchronous read and onChange, with environment cleanup and bounded unreferenced delivery", () => {
  for (const text of [mac, win]) {
    assert.match(text, /NAPI_MODULE_INIT\(\)/);
    assert.match(text, /\{"read", nullptr, Read,/);
    assert.match(text, /\{"onChange", nullptr, OnChange,/);
    assert.match(text, /return Snapshot\(env, fullscreen, sharing, (?:focus|false)\)/);
  }
  assert.match(lifetime, /napi_create_threadsafe_function\(env, function, nullptr, name, 1, 1,/);
  assert.match(lifetime, /napi_unref_threadsafe_function\(env, callback\)/);
  assert.match(lifetime, /if \(!env \|\| !function \|\| !subscription->active.load\(\)\) return/);
  assert.match(lifetime, /napi_add_env_cleanup_hook\(env, Cleanup, state\)/);
  assert.match(lifetime, /if \(state->current\) state->current->Stop\(\)/);
  assert.match(lifetime, /\(\*state\)->current->Stop\(\); \(\*state\)->current.reset\(\)/);
  assert.match(lifetime, /if \(status == napi_closing\)\s*\{[^}]*callback = nullptr/s);
  assert.match(lifetime, /napi_release_threadsafe_function\(previous, napi_tsfn_abort\)/);
});

test("Mac uses workspace events without application state or timers and reads only the Window Server title", () => {
  assert.doesNotMatch(mac + lifetime, /\b(?:NSApp|NSApplication|dispatch_after|NSTimer|usleep|sleep|setInterval|setTimeout)\b/);
  for (const event of ["NSWorkspaceDidActivateApplicationNotification", "NSWorkspaceActiveSpaceDidChangeNotification"]) {
    assert.match(mac, new RegExp("addObserverForName:" + event));
  }
  assert.match(mac, /removeObserver:activation/);
  assert.match(mac, /removeObserver:space/);
  assert.equal((mac.match(/\bkCGWindowName\b/g) || []).length, 1);
  const ownerGate = mac.indexOf('if ([owner isEqualToString:@"Window Server"])');
  const titleRead = mac.indexOf("kCGWindowName");
  assert.ok(ownerGate >= 0 && titleRead > ownerGate);
  assert.match(mac.slice(ownerGate, titleRead), /bounds.origin.y != displays\[i\].origin.y/);
  assert.match(mac.slice(titleRead), /!\[name isKindOfClass:\[NSString class\]\] \|\| \[name length\] == 0 \|\| \[name isEqualToString:@"Menubar"\]/);
  assert.match(mac, /frontCovers\[i\] && !menuPresentOrUnknown\[i\]/);
  assert.match(mac, /kCGWindowListOptionOnScreenOnly \| kCGWindowListExcludeDesktopElements/);
  assert.match(mac, /CGGetActiveDisplayList/);
  assert.match(mac, /CGGetOnlineDisplayList/);
  assert.match(mac, /CGDisplayIsInMirrorSet/);
  assert.match(mac, /owner rangeOfString:needle options:NSCaseInsensitiveSearch/);
  assert.match(mac, /!rule.coversDisplay \|\| \(hasBounds && CoversDisplay/);
  assert.match(mac, /return Snapshot\(env, fullscreen, sharing, false\)/);
});

test("Windows maps notification state and clone topology and owns one foreground hook thread per subscription", () => {
  assert.match(win, /SUCCEEDED\(SHQueryUserNotificationState\(&state\)\)/);
  assert.match(win, /fullscreen = state == QUNS_BUSY \|\| state == QUNS_RUNNING_D3D_FULL_SCREEN \|\| state == QUNS_PRESENTATION_MODE/);
  assert.match(win, /sharing = state == QUNS_PRESENTATION_MODE/);
  assert.match(win, /focus = state == QUNS_QUIET_TIME/);
  assert.match(win, /GetDisplayConfigBufferSizes\(QDC_DATABASE_CURRENT/);
  assert.match(win, /QueryDisplayConfig\(QDC_DATABASE_CURRENT[^;]*== ERROR_SUCCESS &&\s*topology == DISPLAYCONFIG_TOPOLOGY_CLONE/s);
  assert.match(win, /SetWinEventHook\(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND/);
  assert.match(win, /WINEVENT_OUTOFCONTEXT \| WINEVENT_SKIPOWNPROCESS/);
  assert.match(win, /UnhookWinEvent\(hook\)/);
  assert.match(win, /PostThreadMessageW\(threadId, WM_QUIT, 0, 0\)/);
  assert.match(win, /worker.join\(\)/);
  assert.match(win, /CloseHandle\(stopEvent\)/);
  assert.doesNotMatch(win, /\b(?:SetTimer|CreateTimerQueueTimer|Sleep)\s*\(/);
  const includes = win.match(/^#include[^\n]*/gm).join("\n").toLowerCase();
  assert.equal(includes.includes("winternl.h") && includes.includes("ntsecapi.h"), false);
});
