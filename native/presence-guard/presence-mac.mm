// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#include "lifetime.h"
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

using namespace murage_presence;
struct ShareWindowRule { const char* owner; int layer; bool coversDisplay; };
#include "share-windows.generated.h"

static bool Bounds(NSDictionary* window, CGRect* bounds) {
  id value = window[(__bridge NSString*)kCGWindowBounds];
  return [value isKindOfClass:[NSDictionary class]] &&
         CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value, bounds) &&
         bounds->size.width > 0 && bounds->size.height > 0;
}

static bool CoversDisplay(CGRect bounds, const CGRect* displays, uint32_t count) {
  for (uint32_t i = 0; i < count; ++i) if (CGRectEqualToRect(bounds, displays[i])) return true;
  return false;
}

static void ReadSignals(bool* fullscreen, bool* sharing) {
  // Fixed buffers bound work and avoid allocation or retries during display reconfiguration.
  constexpr uint32_t limit = 32;
  CGDirectDisplayID ids[limit];
  CGRect displays[limit];
  uint32_t count = 0;
  if (CGGetActiveDisplayList(limit, ids, &count) != kCGErrorSuccess) count = 0;
  for (uint32_t i = 0; i < count; ++i) displays[i] = CGDisplayBounds(ids[i]);
  uint32_t onlineCount = 0;
  if (CGGetOnlineDisplayList(limit, ids, &onlineCount) == kCGErrorSuccess) {
    for (uint32_t i = 0; i < onlineCount; ++i) if (CGDisplayIsInMirrorSet(ids[i])) *sharing = true;
  }

  NSArray* windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  if (!windows) return;
  NSRunningApplication* frontmost = [NSWorkspace sharedWorkspace].frontmostApplication;
  const pid_t frontPid = frontmost ? frontmost.processIdentifier : 0;
  bool frontCovers[limit] = {}, menuPresentOrUnknown[limit] = {};
  for (id entry in windows) {
    if (![entry isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary* window = entry;
    id ownerValue = window[(__bridge NSString*)kCGWindowOwnerName];
    NSString* owner = [ownerValue isKindOfClass:[NSString class]] ? ownerValue : nil;
    id layer = window[(__bridge NSString*)kCGWindowLayer];
    id pid = window[(__bridge NSString*)kCGWindowOwnerPID];
    CGRect bounds = CGRectZero;
    const bool hasBounds = Bounds(window, &bounds);
    if (frontPid > 0 && [pid isKindOfClass:[NSNumber class]] && [pid intValue] == frontPid &&
        [layer isKindOfClass:[NSNumber class]] && [layer intValue] == 0 && hasBounds) {
      for (uint32_t i = 0; i < count; ++i) if (CGRectEqualToRect(bounds, displays[i])) frontCovers[i] = true;
    }

    if ([owner isEqualToString:@"Window Server"]) {
      for (uint32_t i = 0; i < count; ++i) {
        if (!hasBounds) { menuPresentOrUnknown[i] = true; continue; }
        if (bounds.origin.y != displays[i].origin.y ||
            CGRectGetMaxX(bounds) <= CGRectGetMinX(displays[i]) ||
            CGRectGetMinX(bounds) >= CGRectGetMaxX(displays[i])) continue;
        // The sole window-title access: only Window Server at this display's top edge.
        // Missing/redacted names cannot establish the absence of the menu bar.
        id name = window[(__bridge NSString*)kCGWindowName];
        if (![name isKindOfClass:[NSString class]] || [name length] == 0 || [name isEqualToString:@"Menubar"]) {
          menuPresentOrUnknown[i] = true;
        }
      }
    }

    if (!owner || ![layer isKindOfClass:[NSNumber class]]) continue;
    for (const auto& rule : kShareWindowRules) {
      if ([layer intValue] != rule.layer) continue;
      NSString* needle = [NSString stringWithUTF8String:rule.owner];
      if ([owner rangeOfString:needle options:NSCaseInsensitiveSearch].location == NSNotFound) continue;
      if (!rule.coversDisplay || (hasBounds && CoversDisplay(bounds, displays, count))) *sharing = true;
    }
  }
  for (uint32_t i = 0; i < count; ++i) if (frontCovers[i] && !menuPresentOrUnknown[i]) *fullscreen = true;
}

static napi_value Read(napi_env env, napi_callback_info) {
  bool fullscreen = false, sharing = false;
  @autoreleasepool {
    @try { ReadSignals(&fullscreen, &sharing); }
    @catch (NSException* exception) { (void)exception; fullscreen = false; sharing = false; }
  }
  // D3: INFocusStatusCenter requires Apple's Communication Notifications entitlement.
  // This build does not have it and never requests it or prompts for screen recording.
  return Snapshot(env, fullscreen, sharing, false);
}

struct MacSubscription final : Subscription {
  NSNotificationCenter* center = nil;
  id activation = nil;
  id space = nil;

  bool Start(const Holder& self) {
    const std::weak_ptr<Subscription> weak = self;
    @autoreleasepool {
      @try {
        center = [NSWorkspace sharedWorkspace].notificationCenter;
        activation = [center addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:nil
          usingBlock:^(NSNotification* notification) { (void)notification; if (const auto subscription = weak.lock()) subscription->Emit(); }];
        space = [center addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification object:nil queue:nil
          usingBlock:^(NSNotification* notification) { (void)notification; if (const auto subscription = weak.lock()) subscription->Emit(); }];
        return activation != nil && space != nil;
      } @catch (NSException* exception) { (void)exception; return false; }
    }
  }

  void Stop() override {
    active.store(false);
    @autoreleasepool {
      @try { if (activation) [center removeObserver:activation]; } @catch (NSException* exception) { (void)exception; }
      @try { if (space) [center removeObserver:space]; } @catch (NSException* exception) { (void)exception; }
      activation = nil;
      space = nil;
      center = nil;
    }
    CloseCallback();
  }
};

static napi_value OnChange(napi_env env, napi_callback_info info) {
  State* state = nullptr;
  napi_value callback;
  if (!Arguments(env, info, &state, &callback)) return nullptr;
  try {
    const auto subscription = std::make_shared<MacSubscription>();
    state->current = subscription;
    if (!subscription->Connect(env, callback, subscription) || !subscription->Start(subscription)) {
      subscription->Stop();
      state->current.reset();
      napi_throw_error(env, "PRESENCE_OBSERVER_UNAVAILABLE", "PRESENCE_OBSERVER_UNAVAILABLE");
      return nullptr;
    }
    return UnsubscribeFunction(env, subscription);
  } catch (...) {
    if (state->current) { state->current->Stop(); state->current.reset(); }
    napi_throw_error(env, "PRESENCE_OBSERVER_UNAVAILABLE", "PRESENCE_OBSERVER_UNAVAILABLE");
    return nullptr;
  }
}

NAPI_MODULE_INIT() {
  // Exports: read(), onChange(callback) -> unsubscribe(). No application object is needed.
  napi_property_descriptor properties[] = {
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"onChange", nullptr, OnChange, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  return Install(env, exports, properties);
}
