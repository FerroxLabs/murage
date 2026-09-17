// Runs inside Murage's signed main process: never impersonate another bundle.
#include "lifetime.h"
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <UserNotifications/UserNotifications.h>

using namespace murage_notification;
static void Finish(napi_env env, napi_value, void* context, void* data) {
  const auto pending = *static_cast<Holder*>(context);
  auto* answer = static_cast<Answer*>(data);
  if (env && answer) {
    napi_value result, value;
    napi_create_object(env, &result);
    const char* names[] = {"authorization", "alert", "sound"};
    int values[] = {answer->authorization, answer->alert, answer->sound};
    for (int i = 0; i < 3; ++i) {
      napi_create_int32(env, values[i], &value);
      napi_set_named_property(env, result, names[i], value);
    }
    napi_get_boolean(env, answer->failed, &value);
    napi_set_named_property(env, result, "failed", value);
    napi_resolve_deferred(env, pending->deferred, result);
  }
  delete answer;
}
static bool Live(const std::weak_ptr<Pending>& weak) {
  const auto pending = weak.lock();
  if (!pending) return false;
  std::lock_guard<std::mutex> lock(pending->mutex);
  return !pending->retired && !pending->closing;
}
static void Complete(const std::weak_ptr<Pending>& weak, UNNotificationSettings* settings, bool failed) {
  if (const auto pending = weak.lock()) {
    Deliver(pending, new Answer{settings ? static_cast<int>(settings.authorizationStatus) : -1,
                                settings ? static_cast<int>(settings.alertSetting) : -1,
                                settings ? static_cast<int>(settings.soundSetting) : -1, failed});
  }
}
static napi_value Query(napi_env env, napi_callback_info info, bool request) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc) { napi_throw_error(env, "NOTIFICATION_AUTH_ARGUMENTS", "Notification authorization accepts no arguments"); return nullptr; }
  const auto pending = std::make_shared<Pending>();
  auto* holder = new Holder(pending);
  napi_value promise, name;
  napi_create_promise(env, &pending->deferred, &promise);
  napi_create_string_utf8(env, "Murage notification authorization", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1, holder, Finalize, holder, Finish, &pending->callback) != napi_ok) {
    delete holder; napi_throw_error(env, "NOTIFICATION_AUTH_UNAVAILABLE", "Notification authorization unavailable"); return nullptr;
  }
  // An unanswered OS consent sheet must not keep a quitting application alive.
  napi_unref_threadsafe_function(env, pending->callback);
  const std::weak_ptr<Pending> weak = pending;
  // This is the only extra strong owner. It expires even if Apple never calls
  // completion; the dispatch queue does not keep Node's event loop alive.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60LL * NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    Deliver(pending, new Answer{-1, -1, -1, true});
  });
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!Live(weak)) return;
    @autoreleasepool {
      if (![[NSBundle mainBundle].bundleIdentifier isEqualToString:@"com.murage.app"]) { Complete(weak, nil, true); return; }
      UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
        if (!Live(weak)) return;
        if (!request || settings.authorizationStatus != UNAuthorizationStatusNotDetermined) { Complete(weak, settings, false); return; }
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                            completionHandler:^(BOOL granted, NSError* error) {
          (void)granted;
          if (!Live(weak)) return;
          // granted alone can represent a subset. Read the actual alert setting.
          [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* current) { Complete(weak, current, error != nil); }];
        }];
      }];
    }
  });
  return promise;
}
static napi_value Status(napi_env env, napi_callback_info info) { return Query(env, info, false); }
static napi_value Request(napi_env env, napi_callback_info info) { return Query(env, info, true); }
NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"request", nullptr, Request, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}
