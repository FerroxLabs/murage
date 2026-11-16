// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <node_api.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <new>

namespace murage_presence {
struct Subscription;
using Holder = std::shared_ptr<Subscription>;

struct Subscription {
  std::mutex mutex;
  std::atomic<bool> active{false};
  napi_threadsafe_function callback = nullptr;
  virtual ~Subscription() = default;
  // Called only on the owning JS thread, including environment cleanup.
  virtual void Stop() = 0;

  static void Dispatch(napi_env env, napi_value function, void* context, void*) {
    const auto* subscription = static_cast<Subscription*>(context);
    if (!env || !function || !subscription->active.load()) return;
    napi_value receiver, result;
    if (napi_get_undefined(env, &receiver) == napi_ok) {
      napi_call_function(env, receiver, function, 0, nullptr, &result);
    }
  }

  static void Finalize(napi_env, void* data, void*) {
    auto* holder = static_cast<Holder*>(data);
    {
      std::lock_guard<std::mutex> lock((*holder)->mutex);
      (*holder)->active.store(false);
      (*holder)->callback = nullptr;
    }
    delete holder;
  }

  bool Connect(napi_env env, napi_value function, const Holder& self) {
    napi_value name;
    if (napi_create_string_utf8(env, "presence-change", NAPI_AUTO_LENGTH, &name) != napi_ok) return false;
    auto* holder = new (std::nothrow) Holder(self);
    if (!holder) return false;
    // At most one pending event. The consumer reads the current snapshot.
    if (napi_create_threadsafe_function(env, function, nullptr, name, 1, 1, holder, Finalize,
                                      this, Dispatch, &callback) != napi_ok) {
      delete holder;
      callback = nullptr;
      return false;
    }
    active.store(true);
    if (napi_unref_threadsafe_function(env, callback) != napi_ok) {
      CloseCallback();
      return false;
    }
    return true;
  }

  void Emit() {
    std::lock_guard<std::mutex> lock(mutex);
    if (!active.load() || !callback) return;
    const napi_status status = napi_call_threadsafe_function(callback, nullptr, napi_tsfn_nonblocking);
    if (status == napi_closing) {
      // Node consumed the producer reference. Never release or use it again.
      callback = nullptr;
      active.store(false);
    }
  }

  void CloseCallback() {
    napi_threadsafe_function previous;
    {
      std::lock_guard<std::mutex> lock(mutex);
      active.store(false);
      previous = callback;
      callback = nullptr;
    }
    // Pending Dispatch calls see inactive, including events queued before unsubscribe.
    if (previous) napi_release_threadsafe_function(previous, napi_tsfn_abort);
  }
};

struct State { Holder current; };

inline napi_value Undefined(napi_env env) {
  napi_value result = nullptr;
  napi_get_undefined(env, &result);
  return result;
}

inline napi_value Snapshot(napi_env env, bool fullscreen, bool sharing, bool focus) {
  napi_value result = nullptr, value;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  const char* names[] = {"fullscreen", "sharing", "focus"};
  const bool values[] = {fullscreen, sharing, focus};
  for (size_t i = 0; i < 3; ++i) {
    if (napi_get_boolean(env, values[i], &value) != napi_ok ||
        napi_set_named_property(env, result, names[i], value) != napi_ok) return nullptr;
  }
  return result;
}

inline napi_value Unsubscribe(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data) == napi_ok && data) {
    (*static_cast<Holder*>(data))->Stop();
  }
  return Undefined(env);
}

inline void FinalizeUnsubscribe(napi_env, void* data, void*) { delete static_cast<Holder*>(data); }

inline napi_value UnsubscribeFunction(napi_env env, const Holder& subscription) {
  auto* holder = new (std::nothrow) Holder(subscription);
  napi_value function = nullptr;
  if (!holder) { subscription->Stop(); return nullptr; }
  if (napi_create_function(env, "unsubscribe", NAPI_AUTO_LENGTH, Unsubscribe, holder, &function) != napi_ok ||
      napi_add_finalizer(env, function, holder, FinalizeUnsubscribe, nullptr, nullptr) != napi_ok) {
    subscription->Stop();
    delete holder;
    return nullptr;
  }
  return function;
}

inline bool Arguments(napi_env env, napi_callback_info info, State** state, napi_value* function) {
  size_t argc = 1;
  void* data = nullptr;
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, function, nullptr, &data) != napi_ok) return false;
  if (argc != 1 || napi_typeof(env, *function, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, "PRESENCE_CALLBACK_REQUIRED", "PRESENCE_CALLBACK_REQUIRED");
    return false;
  }
  *state = static_cast<State*>(data);
  if ((*state)->current) { (*state)->current->Stop(); (*state)->current.reset(); }
  return true;
}

inline void Cleanup(void* data) {
  auto* state = static_cast<State*>(data);
  if (state->current) state->current->Stop();
  delete state;
}

inline napi_value Install(napi_env env, napi_value exports, napi_property_descriptor* properties) {
  auto* state = new (std::nothrow) State();
  if (!state) return nullptr;
  if (napi_add_env_cleanup_hook(env, Cleanup, state) != napi_ok) { delete state; return nullptr; }
  properties[1].data = state;
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_remove_env_cleanup_hook(env, Cleanup, state);
    delete state;
    return nullptr;
  }
  return exports;
}
} // namespace murage_presence
