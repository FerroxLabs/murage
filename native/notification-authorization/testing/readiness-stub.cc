// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-only addon: the real readiness() N-API code from ../readiness.h behind a scripted OS bridge, so it runs on Linux.
// Never built into the app (scripts/build-notification-authorization.mjs compiles only the two .mm files).
//   script(mode, authorization, alert, previews, categories, expireMs)
//     mode        "answer" on the calling thread | "thread" from another thread | "never" | "twice" (a second, fully open answer
//                 follows the scripted one) | "late" (answers only after the bound) | "failed" (the scripted values with failed set)
//     categories  "id=action:flags,action:flags;id=..." with flags a = authentication required, t = text input
//   reads()       how many times the bridge was asked
#include "../readiness.h"
#include <atomic>
#include <chrono>
#include <thread>

using namespace murage_notification;

namespace {
std::mutex scriptMutex;
std::string mode = "never";
ReadinessFacts scripted;
int expireMs = 50;
std::atomic<int> readCount{0};

std::vector<CategoryFact> ParseCategories(const std::string& text) {
  std::vector<CategoryFact> categories;
  size_t start = 0;
  while (start < text.size()) {
    size_t end = text.find(';', start);
    if (end == std::string::npos) end = text.size();
    const std::string entry = text.substr(start, end - start);
    start = end + 1;
    const size_t equals = entry.find('=');
    if (equals == std::string::npos) continue;
    CategoryFact category{entry.substr(0, equals), {}};
    const std::string actions = entry.substr(equals + 1);
    size_t at = 0;
    while (at < actions.size()) {
      size_t stop = actions.find(',', at);
      if (stop == std::string::npos) stop = actions.size();
      const std::string action = actions.substr(at, stop - at);
      at = stop + 1;
      const size_t colon = action.find(':');
      if (colon == std::string::npos) continue;
      const std::string flags = action.substr(colon + 1);
      category.actions.push_back(ActionFact{action.substr(0, colon), flags.find('a') != std::string::npos, flags.find('t') != std::string::npos});
    }
    categories.push_back(std::move(category));
  }
  return categories;
}
ReadinessFacts Open() { return ReadinessFacts{2, 2, 0, true, false}; }

void StubRead(ReadinessDone done) {
  ++readCount;
  std::string how; ReadinessFacts facts; int bound;
  { std::lock_guard<std::mutex> lock(scriptMutex); how = mode; facts = scripted; bound = expireMs; }
  if (how == "answer") { done(facts); return; }
  if (how == "failed") { facts.failed = true; done(facts); return; }
  if (how == "twice") { done(facts); done(Open()); return; }
  if (how == "thread") { std::thread([done, facts] { std::this_thread::sleep_for(std::chrono::milliseconds(5)); done(facts); }).detach(); return; }
  if (how == "late") { std::thread([done, facts, bound] { std::this_thread::sleep_for(std::chrono::milliseconds(bound * 3)); done(facts); }).detach(); return; }
  // "never": the OS does not answer.
}
void StubExpire(std::function<void()> retire) {
  int bound;
  { std::lock_guard<std::mutex> lock(scriptMutex); bound = expireMs; }
  std::thread([retire, bound] { std::this_thread::sleep_for(std::chrono::milliseconds(bound)); retire(); }).detach();
}
const ReadinessBridge stubBridge = {StubRead, StubExpire};

bool Text(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::string buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, &buffer[0], buffer.size(), &length) != napi_ok) return false;
  buffer.resize(length);
  *out = buffer;
  return true;
}
napi_value Script(napi_env env, napi_callback_info info) {
  size_t argc = 6; napi_value argv[6];
  std::string how, categories; int32_t authorization, alert, previews, bound;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 6 || !Text(env, argv[0], &how) ||
      napi_get_value_int32(env, argv[1], &authorization) != napi_ok || napi_get_value_int32(env, argv[2], &alert) != napi_ok ||
      napi_get_value_int32(env, argv[3], &previews) != napi_ok || !Text(env, argv[4], &categories) ||
      napi_get_value_int32(env, argv[5], &bound) != napi_ok) {
    napi_throw_error(env, "STUB_ARGUMENTS", "script(mode, authorization, alert, previews, categories, expireMs)");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(scriptMutex);
  mode = how;
  scripted = ReadinessFacts{authorization, alert, previews, ApprovalCategoryRegistered(ParseCategories(categories)), false};
  expireMs = bound;
  return nullptr;
}
napi_value Reads(napi_env env, napi_callback_info) {
  napi_value value;
  napi_create_int32(env, readCount.load(), &value);
  return value;
}
} // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"script", nullptr, Script, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reads", nullptr, Reads, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  RegisterReadiness(env, exports, &stubBridge);
  return exports;
}
