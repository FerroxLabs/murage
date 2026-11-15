// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#include "lifetime.h"
#include <algorithm>
#include <vector>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <UserNotifications/UserNotifications.h>

using namespace murage_notification;

namespace {
struct Subscription {
  std::mutex mutex;
  napi_env env = nullptr;
  napi_ref listener = nullptr; // Accessed only on the owning JS thread.
  napi_threadsafe_function callback = nullptr;
  bool active = true;
};
using Subscriber = std::shared_ptr<Subscription>;
struct Binding { Subscriber subscriber; };
struct Response {
  NSString* identifier;
  NSString* action;
  NSString* reply;
};
std::mutex subscriberMutex;
std::weak_ptr<Subscription> currentSubscriber;

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}
napi_value Invalid(napi_env env) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, "NOTIFICATION_BANNER_ARGUMENTS", "Invalid notification banner arguments");
  return nullptr;
}
bool ReadString(napi_env env, napi_value value, size_t minimum, size_t maximum, NSString** result) {
  napi_valuetype type;
  size_t length = 0, copied = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok ||
      length < minimum || length > maximum) return false;
  std::vector<char16_t> characters(length + 1);
  if (napi_get_value_string_utf16(env, value, characters.data(), characters.size(), &copied) != napi_ok || copied != length) return false;
  *result = [[NSString alloc] initWithCharacters:reinterpret_cast<const unichar*>(characters.data()) length:length];
  return *result != nil;
}
bool Owned(NSString* identifier) { return [identifier hasPrefix:@"mb:"]; }
bool AppBundle() { return [[NSBundle mainBundle].bundleIdentifier isEqualToString:@"com.murage.app"]; }
napi_value JSString(napi_env env, NSString* string) {
  std::vector<char16_t> characters(string.length + 1);
  [string getCharacters:reinterpret_cast<unichar*>(characters.data()) range:NSMakeRange(0, string.length)];
  napi_value value;
  if (napi_create_string_utf16(env, characters.data(), string.length, &value) != napi_ok) return nullptr;
  return value;
}

// Stop runs on the JS thread. The TSFN has no JS callback of its own, so deleting
// this reference drops the listener immediately, including queued responses.
void Stop(const Subscriber& subscription) {
  if (!subscription) return;
  std::lock_guard<std::mutex> lock(subscription->mutex);
  subscription->active = false;
  if (subscription->listener) {
    napi_delete_reference(subscription->env, subscription->listener);
    subscription->listener = nullptr;
  }
  if (subscription->callback) {
    const auto callback = subscription->callback;
    subscription->callback = nullptr;
    napi_release_threadsafe_function(callback, napi_tsfn_abort);
  }
}
void FinalizeSubscription(napi_env env, void* data, void*) {
  auto* holder = static_cast<Subscriber*>(data);
  {
    std::lock_guard<std::mutex> lock((*holder)->mutex);
    (*holder)->active = false;
    (*holder)->callback = nullptr;
    if (env && (*holder)->listener) napi_delete_reference(env, (*holder)->listener);
    (*holder)->listener = nullptr;
  }
  delete holder;
}
void CallResponse(napi_env env, napi_value, void* context, void* data) {
  std::unique_ptr<Response> response(static_cast<Response*>(data));
  if (!env || !response) return;
  const auto subscription = *static_cast<Subscriber*>(context);
  napi_value listener = nullptr;
  {
    std::lock_guard<std::mutex> lock(subscription->mutex);
    if (!subscription->active || !subscription->listener) return;
    if (napi_get_reference_value(env, subscription->listener, &listener) != napi_ok) return;
  }
  napi_value args[] = {JSString(env, response->identifier), JSString(env, response->action),
                       response->reply ? JSString(env, response->reply) : Undefined(env)};
  if (!args[0] || !args[1] || !args[2]) return;
  napi_value ignored;
  napi_call_function(env, Undefined(env), listener, 3, args, &ignored);
}
void EmitResponse(NSString* identifier, NSString* action, NSString* reply) {
  Subscriber subscription;
  { std::lock_guard<std::mutex> lock(subscriberMutex); subscription = currentSubscriber.lock(); }
  if (!subscription) return;
  std::lock_guard<std::mutex> lock(subscription->mutex);
  if (!subscription->active || !subscription->callback) return;
  auto* response = new Response{[identifier copy], [action copy], [reply copy]};
  const auto result = napi_call_threadsafe_function(subscription->callback, response, napi_tsfn_nonblocking);
  if (result != napi_ok) delete response;
  if (result == napi_closing) {
    subscription->active = false;
    subscription->callback = nullptr; // napi_closing consumes the producer reference.
  }
}
void CleanupBinding(void* data) {
  auto* binding = static_cast<Binding*>(data);
  Stop(binding->subscriber);
  delete binding;
}
void FinalizeUnsubscribe(napi_env, void* data, void*) { delete static_cast<Subscriber*>(data); }
napi_value Unsubscribe(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
  Stop(*static_cast<Subscriber*>(data));
  return Undefined(env);
}
} // namespace

@interface MurageBannerDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(atomic, strong) id<UNUserNotificationCenterDelegate> previous;
@end

@implementation MurageBannerDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
      willPresentNotification:(UNNotification*)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  if (!Owned(notification.request.identifier)) {
    id<UNUserNotificationCenterDelegate> previous = self.previous;
    if ([previous respondsToSelector:@selector(userNotificationCenter:willPresentNotification:withCompletionHandler:)]) {
      [previous userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completionHandler];
    } else {
      completionHandler(UNNotificationPresentationOptionNone);
    }
    return;
  }
  if (@available(macOS 11.0, *)) {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
  } else {
    completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
  }
}
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
 didReceiveNotificationResponse:(UNNotificationResponse*)response
        withCompletionHandler:(void (^)(void))completionHandler {
  NSString* identifier = response.notification.request.identifier;
  if (!Owned(identifier)) {
    id<UNUserNotificationCenterDelegate> previous = self.previous;
    if ([previous respondsToSelector:@selector(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)]) {
      [previous userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completionHandler];
    } else {
      completionHandler();
    }
    return;
  }
  NSString* action = response.actionIdentifier;
  if (![action isEqualToString:UNNotificationDismissActionIdentifier]) {
    NSString* reply = nil;
    if ([action isEqualToString:UNNotificationDefaultActionIdentifier]) action = @"open";
    else if ([action isEqualToString:@"reply"] && [response isKindOfClass:[UNTextInputNotificationResponse class]]) {
      reply = [(UNTextInputNotificationResponse*)response userText];
    } else if (![action isEqualToString:@"allow"] && ![action isEqualToString:@"deny"] && ![action isEqualToString:@"mute"]) {
      action = @"open";
    }
    EmitResponse(identifier, action, reply);
  }
  completionHandler();
}
@end

namespace {
// Main-queue ownership. The center's delegate property is weak.
MurageBannerDelegate* bannerDelegate;
bool categoriesRequested = false;
bool categoriesReady = false;
bool PostLive(const std::weak_ptr<Pending>& weak);
void CompletePost(const std::weak_ptr<Pending>& weak, bool success);
struct QueuedPost {
  std::weak_ptr<Pending> pending;
  NSString* identifier;
  void (^submit)(void);
};
std::vector<QueuedPost> categoryPosts;
void PruneCategoryPosts() {
  categoryPosts.erase(std::remove_if(categoryPosts.begin(), categoryPosts.end(),
    [](const QueuedPost& post) { return !PostLive(post.pending); }), categoryPosts.end());
}
void InstallDelegate(UNUserNotificationCenter* center) {
  if (!bannerDelegate) bannerDelegate = [MurageBannerDelegate new];
  if (center.delegate != bannerDelegate) {
    bannerDelegate.previous = center.delegate;
    center.delegate = bannerDelegate;
  }
}
void RegisterNativeCategories(UNUserNotificationCenter* center) {
  if (categoriesRequested) return;
  categoriesRequested = true;
  [center getNotificationCategoriesWithCompletionHandler:^(NSSet<UNNotificationCategory*>* categories) {
    dispatch_async(dispatch_get_main_queue(), ^{
      UNNotificationAction* allow = [UNNotificationAction actionWithIdentifier:@"allow" title:@"Allow" options:UNNotificationActionOptionAuthenticationRequired];
      UNNotificationAction* deny = [UNNotificationAction actionWithIdentifier:@"deny" title:@"Deny" options:UNNotificationActionOptionNone];
      UNTextInputNotificationAction* reply = [UNTextInputNotificationAction actionWithIdentifier:@"reply" title:@"Reply" options:UNNotificationActionOptionAuthenticationRequired textInputButtonTitle:@"Send" textInputPlaceholder:@"Tell the bot what to do instead"];
      UNNotificationAction* mute = [UNNotificationAction actionWithIdentifier:@"mute" title:@"Mute bot" options:UNNotificationActionOptionNone];
      UNNotificationCategory* approval = [UNNotificationCategory categoryWithIdentifier:@"murage.approval" actions:@[allow, deny, reply, mute] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone];
      NSMutableSet<UNNotificationCategory*>* merged = [categories mutableCopy];
      if (!merged) merged = [NSMutableSet new];
      for (UNNotificationCategory* category in categories) {
        if ([category.identifier isEqualToString:@"murage.approval"]) [merged removeObject:category];
      }
      [merged addObject:approval];
      [center setNotificationCategories:merged];
      categoriesReady = true;
      auto waiting = std::move(categoryPosts);
      categoryPosts.clear();
      for (const auto& post : waiting) {
        if (PostLive(post.pending)) post.submit();
      }
    });
  }];
}
napi_value RegisterCategories(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc) return Invalid(env);
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      if (!AppBundle()) return;
      UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
      InstallDelegate(center);
      RegisterNativeCategories(center);
    }
  });
  return Undefined(env);
}
bool PostLive(const std::weak_ptr<Pending>& weak) {
  const auto pending = weak.lock();
  if (!pending) return false;
  std::lock_guard<std::mutex> lock(pending->mutex);
  return !pending->retired && !pending->closing;
}
void CompletePost(const std::weak_ptr<Pending>& weak, bool success) {
  if (const auto pending = weak.lock()) Deliver(pending, new Answer{0, 0, 0, !success});
}
void FinishPost(napi_env env, napi_value, void* context, void* data) {
  std::unique_ptr<Answer> answer(static_cast<Answer*>(data));
  if (!env || !answer) return;
  const auto pending = *static_cast<Holder*>(context);
  napi_value value;
  napi_get_boolean(env, !answer->failed, &value);
  napi_resolve_deferred(env, pending->deferred, value);
}
napi_value Post(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) return Invalid(env);
  napi_value idValue, titleValue, bodyValue, categoryValue, silentValue;
  if (napi_get_named_property(env, argv[0], "id", &idValue) != napi_ok ||
      napi_get_named_property(env, argv[0], "title", &titleValue) != napi_ok ||
      napi_get_named_property(env, argv[0], "body", &bodyValue) != napi_ok ||
      napi_get_named_property(env, argv[0], "category", &categoryValue) != napi_ok ||
      napi_get_named_property(env, argv[0], "silent", &silentValue) != napi_ok) return Invalid(env);
  NSString *identifier = nil, *title = nil, *body = nil, *category = nil;
  bool silent = false;
  if (!ReadString(env, idValue, 1, 64, &identifier) || !Owned(identifier) ||
      !ReadString(env, titleValue, 1, 200, &title) || !ReadString(env, bodyValue, 0, 2000, &body) ||
      napi_typeof(env, silentValue, &type) != napi_ok || type != napi_boolean ||
      napi_get_value_bool(env, silentValue, &silent) != napi_ok ||
      napi_typeof(env, categoryValue, &type) != napi_ok) return Invalid(env);
  if (type != napi_null && (!ReadString(env, categoryValue, 1, 64, &category) ||
                            ![category isEqualToString:@"murage.approval"])) return Invalid(env);
  const auto pending = std::make_shared<Pending>();
  auto* holder = new Holder(pending);
  napi_value promise, name;
  if (napi_create_promise(env, &pending->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "Murage notification post", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1, holder, Finalize, holder, FinishPost, &pending->callback) != napi_ok) {
    delete holder;
    napi_throw_error(env, "NOTIFICATION_BANNER_UNAVAILABLE", "Notification banner unavailable");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, pending->callback);
  const std::weak_ptr<Pending> weak = pending;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60LL * NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    Deliver(pending, new Answer{0, 0, 0, true});
    dispatch_async(dispatch_get_main_queue(), ^{ PruneCategoryPosts(); });
  });
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!PostLive(weak)) return;
    @autoreleasepool {
      if (!AppBundle()) { CompletePost(weak, false); return; }
      UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
      InstallDelegate(center);
      void (^submit)(void) = ^{
        if (!PostLive(weak)) return;
        InstallDelegate(center);
        UNMutableNotificationContent* content = [UNMutableNotificationContent new];
        content.title = title;
        content.body = body;
        if (category) content.categoryIdentifier = category;
        content.sound = silent ? nil : [UNNotificationSound defaultSound];
        UNNotificationRequest* request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
        [center addNotificationRequest:request withCompletionHandler:^(NSError* error) { CompletePost(weak, error == nil); }];
      };
      if (category && !categoriesReady) {
        RegisterNativeCategories(center);
        PruneCategoryPosts();
        if (categoryPosts.size() >= 64) { CompletePost(weak, false); return; }
        categoryPosts.push_back(QueuedPost{weak, identifier, [submit copy]});
      } else {
        submit();
      }
    }
  });
  return promise;
}
napi_value Remove(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; NSString* identifier = nil;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !ReadString(env, argv[0], 1, 64, &identifier) || !Owned(identifier)) return Invalid(env);
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      if (!AppBundle()) return;
      // A withdrawal also cancels a post waiting for the first category merge.
      categoryPosts.erase(std::remove_if(categoryPosts.begin(), categoryPosts.end(),
        [&](const QueuedPost& post) {
          if (![post.identifier isEqualToString:identifier]) return false;
          CompletePost(post.pending, false);
          return true;
        }), categoryPosts.end());
      UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
      [center removeDeliveredNotificationsWithIdentifiers:@[identifier]];
      [center removePendingNotificationRequestsWithIdentifiers:@[identifier]];
    }
  });
  return Undefined(env);
}
napi_value OnResponse(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; void* data = nullptr; napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, &data) != napi_ok || argc != 1 ||
      napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function) return Invalid(env);
  auto* binding = static_cast<Binding*>(data);
  std::lock_guard<std::mutex> lock(subscriberMutex);
  const auto old = currentSubscriber.lock();
  // The adapter lives in Electron main; never manipulate another environment's reference.
  if (old && old->env != env) {
    napi_throw_error(env, "NOTIFICATION_BANNER_ENVIRONMENT", "Notification responses already have an owner");
    return nullptr;
  }
  const auto subscription = std::make_shared<Subscription>();
  subscription->env = env;
  napi_value name, unsubscribe;
  if (napi_create_reference(env, argv[0], 1, &subscription->listener) != napi_ok) return nullptr;
  auto* holder = new Subscriber(subscription);
  if (napi_create_string_utf8(env, "Murage notification responses", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_threadsafe_function(env, nullptr, nullptr, name, 64, 1, holder, FinalizeSubscription, holder, CallResponse, &subscription->callback) != napi_ok) {
    Stop(subscription); delete holder;
    napi_throw_error(env, "NOTIFICATION_BANNER_UNAVAILABLE", "Notification responses unavailable");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, subscription->callback);
  auto* unsubscribeHolder = new Subscriber(subscription);
  if (napi_create_function(env, "unsubscribe", NAPI_AUTO_LENGTH, Unsubscribe, unsubscribeHolder, &unsubscribe) != napi_ok ||
      napi_add_finalizer(env, unsubscribe, unsubscribeHolder, FinalizeUnsubscribe, nullptr, nullptr) != napi_ok) {
    Stop(subscription); delete unsubscribeHolder;
    return nullptr;
  }
  Stop(old);
  binding->subscriber = subscription;
  currentSubscriber = subscription;
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      if (AppBundle()) InstallDelegate([UNUserNotificationCenter currentNotificationCenter]);
    }
  });
  return unsubscribe;
}
} // namespace

void RegisterBanners(napi_env env, napi_value exports) {
  auto* binding = new Binding();
  if (napi_add_env_cleanup_hook(env, CleanupBinding, binding) != napi_ok) {
    delete binding;
    napi_throw_error(env, "NOTIFICATION_BANNER_UNAVAILABLE", "Notification responses unavailable");
    return;
  }
  napi_property_descriptor properties[] = {
    {"registerCategories", nullptr, RegisterCategories, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"post", nullptr, Post, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"onResponse", nullptr, OnResponse, nullptr, nullptr, nullptr, napi_default, binding},
  };
  napi_define_properties(env, exports, 4, properties);
}
