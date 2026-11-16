// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#ifndef WINVER
#define WINVER _WIN32_WINNT
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <condition_variable>
#include <thread>
#include "lifetime.h"

using namespace murage_presence;

static bool ClonedDisplays() {
  UINT32 pathCount = 0, modeCount = 0;
  if (GetDisplayConfigBufferSizes(QDC_DATABASE_CURRENT, &pathCount, &modeCount) != ERROR_SUCCESS ||
      pathCount == 0 || pathCount > 128 || modeCount > 512) return false;
  // No retries if the display topology changes between the two calls.
  std::unique_ptr<DISPLAYCONFIG_PATH_INFO[]> paths(new (std::nothrow) DISPLAYCONFIG_PATH_INFO[pathCount]);
  std::unique_ptr<DISPLAYCONFIG_MODE_INFO[]> modes(new (std::nothrow) DISPLAYCONFIG_MODE_INFO[modeCount ? modeCount : 1]);
  if (!paths || !modes) return false;
  DISPLAYCONFIG_TOPOLOGY_ID topology = DISPLAYCONFIG_TOPOLOGY_INTERNAL;
  return QueryDisplayConfig(QDC_DATABASE_CURRENT, &pathCount, paths.get(), &modeCount, modes.get(), &topology) == ERROR_SUCCESS &&
         topology == DISPLAYCONFIG_TOPOLOGY_CLONE;
}

static napi_value Read(napi_env env, napi_callback_info) {
  bool fullscreen = false, sharing = false, focus = false;
  QUERY_USER_NOTIFICATION_STATE state = QUNS_ACCEPTS_NOTIFICATIONS;
  if (SUCCEEDED(SHQueryUserNotificationState(&state))) {
    fullscreen = state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE;
    sharing = state == QUNS_PRESENTATION_MODE;
    focus = state == QUNS_QUIET_TIME;
  }
  sharing = sharing || ClonedDisplays();
  return Snapshot(env, fullscreen, sharing, focus);
}

struct WinSubscription;
// WinEvent callbacks execute on the hook's message thread, never another environment's thread.
static thread_local WinSubscription* threadSubscription = nullptr;

struct WinSubscription final : Subscription {
  HANDLE stopEvent = nullptr;
  std::thread worker;
  std::mutex startupMutex;
  std::condition_variable startup;
  DWORD threadId = 0;
  bool ready = false;
  bool installed = false;

  static void CALLBACK Foreground(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD) {
    if (threadSubscription) threadSubscription->Emit();
  }

  void Loop() {
    MSG message;
    // Establish the queue before publishing threadId to the JS thread.
    PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
    threadSubscription = this;
    const HWINEVENTHOOK hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr,
      Foreground, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    {
      std::lock_guard<std::mutex> lock(startupMutex);
      threadId = GetCurrentThreadId();
      installed = hook != nullptr;
      ready = true;
    }
    startup.notify_one();
    if (hook) {
      bool quit = false;
      while (!quit) {
        // An event also wakes shutdown if posting WM_QUIT meets a full message queue.
        // INFINITE is a blocking wait for messages or shutdown, with no polling.
        const DWORD wake = MsgWaitForMultipleObjects(1, &stopEvent, FALSE, INFINITE, QS_ALLINPUT);
        if (wake != WAIT_OBJECT_0 + 1) break;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
          if (message.message == WM_QUIT) { quit = true; break; }
          if (WaitForSingleObject(stopEvent, 0) == WAIT_OBJECT_0) { quit = true; break; }
          TranslateMessage(&message);
          DispatchMessageW(&message);
        }
      }
      // Win32 requires removal on the same thread that installed the hook.
      UnhookWinEvent(hook);
    }
    threadSubscription = nullptr;
  }

  bool Start() {
    stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stopEvent) return false;
    try { worker = std::thread([this] { Loop(); }); }
    catch (...) { return false; }
    std::unique_lock<std::mutex> lock(startupMutex);
    startup.wait(lock, [this] { return ready; });
    return installed;
  }

  void Stop() override {
    active.store(false);
    if (worker.joinable()) {
      PostThreadMessageW(threadId, WM_QUIT, 0, 0);
      SetEvent(stopEvent);
      worker.join();
    }
    if (stopEvent) { CloseHandle(stopEvent); stopEvent = nullptr; }
    CloseCallback();
  }
};

static napi_value OnChange(napi_env env, napi_callback_info info) {
  State* state = nullptr;
  napi_value callback;
  if (!Arguments(env, info, &state, &callback)) return nullptr;
  try {
    const auto subscription = std::make_shared<WinSubscription>();
    state->current = subscription;
    if (!subscription->Connect(env, callback, subscription) || !subscription->Start()) {
      subscription->Stop();
      state->current.reset();
      napi_throw_error(env, "PRESENCE_HOOK_UNAVAILABLE", "PRESENCE_HOOK_UNAVAILABLE");
      return nullptr;
    }
    return UnsubscribeFunction(env, subscription);
  } catch (...) {
    if (state->current) { state->current->Stop(); state->current.reset(); }
    napi_throw_error(env, "PRESENCE_HOOK_UNAVAILABLE", "PRESENCE_HOOK_UNAVAILABLE");
    return nullptr;
  }
}

NAPI_MODULE_INIT() {
  // Exports: read(), onChange(callback) -> unsubscribe(). No thread starts until subscribed.
  napi_property_descriptor properties[] = {
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"onChange", nullptr, OnChange, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  return Install(env, exports, properties);
}
