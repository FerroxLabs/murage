// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// readiness(): one read of the OS state behind the banner buttons, for electron/mac-banners.mjs.
// Owners: this file, the Mac bridge in banners.mm and the Linux stub in testing/ = the Mac native banner lane;
// the consumer (macActionReadiness in electron/mac-banners.mjs) = the same lane.
//
// This header has no Apple code: the N-API side and the category rule are the same bytes on a Mac (banners.mm supplies the
// bridge that asks UNUserNotificationCenter) and in the Linux unit tests (testing/readiness-stub.cc supplies a scripted bridge).
//
// Result: {authorization, alert, previews, category, failed}.
//   authorization, alert   as status() reports them (2 = authorized, enabled)
//   previews               UNShowPreviewsSetting: 0 always, 1 when unlocked, 2 never
//   category               the "murage.approval" category is registered with Allow and Reply marked authentication-required,
//                          Reply a text input, and Deny present
//   failed                 the read did not complete. A failed result never carries a usable value: -1, -1, -1, false.
#pragma once
#include "lifetime.h"
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace murage_notification {
struct ActionFact { std::string identifier; bool authenticationRequired; bool textInput; };
struct CategoryFact { std::string identifier; std::vector<ActionFact> actions; };
struct ReadinessFacts { int authorization = -1; int alert = -1; int previews = -1; bool category = false; bool failed = true; };

inline bool ApprovalCategoryComplete(const CategoryFact& category) {
  int allow = 0, deny = 0, reply = 0;
  for (const auto& action : category.actions) {
    if (action.identifier == "allow") { if (!action.authenticationRequired || action.textInput) return false; ++allow; }
    else if (action.identifier == "deny") { if (action.textInput) return false; ++deny; }
    else if (action.identifier == "reply") { if (!action.authenticationRequired || !action.textInput) return false; ++reply; }
  }
  return allow == 1 && deny == 1 && reply == 1;
}
// Every category the OS holds under the approval identifier must be complete, and there must be one.
inline bool ApprovalCategoryRegistered(const std::vector<CategoryFact>& categories) {
  bool found = false;
  for (const auto& category : categories) {
    if (category.identifier != "murage.approval") continue;
    if (!ApprovalCategoryComplete(category)) return false;
    found = true;
  }
  return found;
}
inline Answer* ReadinessAnswer(const ReadinessFacts& facts) {
  auto* answer = new Answer{-1, -1, -1, true};
  if (facts.failed || facts.authorization < 0 || facts.alert < 0 || facts.previews < 0) return answer;
  answer->authorization = facts.authorization;
  answer->alert = facts.alert;
  answer->previews = facts.previews;
  answer->category = facts.category;
  answer->failed = false;
  return answer;
}

using ReadinessDone = std::function<void(const ReadinessFacts&)>;
struct ReadinessBridge {
  // Asks the OS. `done` may be called from any thread, late, more than once or never: only the first call before retirement counts.
  void (*read)(ReadinessDone done);
  // Calls `retire` once after the bound, so a read the OS never answers still settles (as failed).
  void (*expire)(std::function<void()> retire);
};

inline void FinishReadiness(napi_env env, napi_value, void* context, void* data) {
  std::unique_ptr<Answer> answer(static_cast<Answer*>(data));
  if (!env || !answer) return;
  const auto pending = *static_cast<Holder*>(context);
  napi_value result, value;
  if (napi_create_object(env, &result) != napi_ok) return;
  const char* names[] = {"authorization", "alert", "previews"};
  const int values[] = {answer->authorization, answer->alert, answer->previews};
  for (int i = 0; i < 3; ++i) {
    napi_create_int32(env, values[i], &value);
    napi_set_named_property(env, result, names[i], value);
  }
  napi_get_boolean(env, answer->category, &value);
  napi_set_named_property(env, result, "category", value);
  napi_get_boolean(env, answer->failed, &value);
  napi_set_named_property(env, result, "failed", value);
  napi_resolve_deferred(env, pending->deferred, result);
}
inline napi_value Readiness(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; void* data = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, &data) != napi_ok || argc || !data) {
    napi_throw_error(env, "NOTIFICATION_READINESS_ARGUMENTS", "Notification readiness accepts no arguments");
    return nullptr;
  }
  const auto* bridge = static_cast<const ReadinessBridge*>(data);
  const auto pending = std::make_shared<Pending>();
  auto* holder = new Holder(pending);
  napi_value promise, name;
  if (napi_create_promise(env, &pending->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "Murage notification readiness", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1, holder, Finalize, holder, FinishReadiness, &pending->callback) != napi_ok) {
    delete holder;
    napi_throw_error(env, "NOTIFICATION_READINESS_UNAVAILABLE", "Notification readiness unavailable");
    return nullptr;
  }
  // A read the OS has not answered must not keep a quitting application alive.
  napi_unref_threadsafe_function(env, pending->callback);
  const std::weak_ptr<Pending> weak = pending;
  // The only extra strong owner: it expires even if the OS never answers.
  bridge->expire([pending] { Deliver(pending, ReadinessAnswer(ReadinessFacts{})); });
  bridge->read([weak](const ReadinessFacts& facts) {
    if (const auto live = weak.lock()) Deliver(live, ReadinessAnswer(facts));
  });
  return promise;
}
inline bool RegisterReadiness(napi_env env, napi_value exports, const ReadinessBridge* bridge) {
  napi_property_descriptor property = {"readiness", nullptr, Readiness, nullptr, nullptr, nullptr, napi_default,
                                       const_cast<ReadinessBridge*>(bridge)};
  return napi_define_properties(env, exports, 1, &property) == napi_ok;
}
} // namespace murage_notification
