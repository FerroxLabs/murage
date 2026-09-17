#pragma once
#include <node_api.h>
#include <memory>
#include <mutex>

namespace murage_notification {
struct Answer { int authorization; int alert; int sound; bool failed; };
struct Pending {
  std::mutex mutex;
  napi_deferred deferred = nullptr;
  napi_threadsafe_function callback = nullptr;
  bool retired = false;
  bool closing = false;
};
using Shared = std::shared_ptr<Pending>;
using Holder = Shared;
// Both the native OS completion and bounded retirement timer enter here.
// No caller ever keeps a bare Pending* or uses the TSFN after retirement.
inline void Deliver(const Shared& pending, Answer* answer) {
  std::lock_guard<std::mutex> lock(pending->mutex);
  if (pending->retired) { delete answer; return; }
  pending->retired = true;
  const auto callback = pending->callback;
  pending->callback = nullptr;
  if (!callback) { delete answer; return; }
  if (pending->closing) {
    delete answer;
    napi_release_threadsafe_function(callback, napi_tsfn_release);
    return;
  }
  const auto result = napi_call_threadsafe_function(callback, answer, napi_tsfn_nonblocking);
  if (result != napi_ok) delete answer;
  // napi_closing consumes this thread's reference. No subsequent API call is
  // allowed; the implementation may have destroyed the TSFN before returning.
  if (result != napi_closing) napi_release_threadsafe_function(callback, napi_tsfn_release);
}
inline void Finalize(napi_env, void* data, void*) {
  auto* holder = static_cast<Holder*>(data);
  { std::lock_guard<std::mutex> lock((*holder)->mutex); (*holder)->closing = true; }
  delete holder;
}
} // namespace murage_notification
