# Phase 0 feasibility spike: findings

Date: 2026-09-25. Time used: about 1.5 hours of the 6-hour box. All code is throwaway and lives in `spike/`.

**Test host:** an isolated Murage (fake engine, temp data directory, ports 28799, 28800, 28811 and 28813, device door off, no Bonjour) behind `tailscale serve --https=8444` at `https://test-laptop-pro.tail000000.ts.net:8444`. Sean's Murage, its data and ports 8799 and 8810–8813 were never touched.

**Test devices:**
- **iOS:** iPhone 17 Pro simulator, iOS 26.5, Xcode 26.6.
- **Android:** local AVD `MurageMobileDemo` (API 36, google_apis, arm64, WebView 133). The APK was built on Hetzner in `ghcr.io/cirruslabs/android-sdk:35`, with platform 36 added inside the container.

## Verdicts

| Q | iOS | Android | Evidence |
|---|---|---|---|
| **Q1** WebView loads the tailnet origin; `/enter#` pairing works | **PROVEN** | **PROVEN** | `ios-02-enter.png`, `ios-03`; `android-02-enter.png`, `android-03-signed-in.png`. Log sequence: `main-document status=200 path=/enter`, then `status=200 path=/`, then `bridge ACCEPT method=hello`. The current web UI already calls `hello()`. |
| **Q2** Session cookie survives kill and relaunch | **PROVEN** | **PROVEN** | **iOS:** `simctl terminate` + launch, and a full simulator shutdown and boot (`ios-03`, `ios-04`); `/api/bots` returned 200. **Android:** `am force-stop` (no process left), then launcher → workspace; `/api/bots` returned 200 (`android-04`). Also survives an app upgrade install. |
| **Q3** Channel enforced natively | **PROVEN** | **PROVEN** | See the Q3 table below. |
| **Q4** Mic, file picker, downloads, blob | **PROVEN** (mock mic) | **PROVEN** | See the Q4 notes below. |
| **Q5** Recovery after the web content process dies | **PROVEN** | **PROVEN, after a fix** | **iOS:** killed WebContent pid 73422; `webViewWebContentProcessDidTerminate` fired and the page reloaded; new pid 75056; still signed in; channel back. **Android:** `chrome://crash` and `WebViewRenderProcess.terminate()` both led to `onRenderProcessGone`, which returned `true`; the WebView was destroyed, recreated and reloaded, and the channel re-registered. The first attempt crashed the whole app (Surprise 1). |
| **Q6** Push | **PARTIAL / BLOCKED ON SEAN** | **PARTIAL** | See the Q6 notes below. |
| **Q7** Architecture breakers | Nothing fatal. Six items must be designed in (see Surprises). | | |

### Q4 notes

**iOS**
- **Mic:** `requestMediaCapturePermission` granted. The stream came back live, labelled "Mock audio device 1".
- **File picker:** the native picker menu opened (`ios-07`).
- **Server download:** `WKDownload` saved the thread export: a 714-byte JSON file and a 114-byte Markdown file.
- **Blob:** `saveFile` wrote a 200,050-byte file.

**Android**
- **Mic:** `onPermissionRequest` triggered the runtime `RECORD_AUDIO` prompt (`android-07`). After granting, the track was live.
- **File picker:** `onShowFileChooser` opened the document picker (`android-08`). The page received one file of 46 bytes.
- **Server download:** `DownloadManager` sent the Cookie header (`cookieHeaderPresent=true`); status 200.
- **Blob:** `saveFile` wrote a 200,010-byte file.

### Q3 detail

| Case | iOS (`WKScriptMessageHandlerWithReply` + main-frame-only `WKUserScript`) | Android (`addWebMessageListener` with an exact origin + `addDocumentStartJavaScript`; both features reported `true`) |
|---|---|---|
| **1.** Main frame, saved origin | `bridge ACCEPT method=probe`, reply `{pong:true}` | Same |
| **2a.** Same-origin `srcdoc` iframe posting directly | Dropped (`isMainFrame=false`); the promise rejects with "unavailable". `window.murageNative` is undefined in the frame, but `webkit.messageHandlers.murageNative` exists there. | Dropped (`isMainFrame=false`), no reply. The raw listener object is injected into same-origin iframes; the `murageNative` wrapper is not. |
| **2b.** Sandboxed (opaque-origin) iframe | Dropped (`origin=://:0`) | Gets no listener object at all |
| **2c.** Same-origin iframe calling `parent.murageNative.probe()` | **Accepted** | **Accepted** |
| **3a.** Navigation to `https://example.com`, default policy | Opened in Safari (`ios-05`) | Opened in Chrome (`android-05`) |
| **3b.** Foreign page forced to load in-app (spike flag) | Dropped (`isMainFrame=true origin=https://example.com`). Wrapper undefined; raw handler object present. | Wrapper and raw object both undefined, so the page cannot post at all |

Case 2c is expected: a same-origin frame is same-origin code, which the spec already treats as trusted. It does make the shell CSP `frame-src` (plus `sandbox` on frames that render HTML) the real guard against injected frames, so that CSP is required, not optional.

### Q6 detail

**iOS**
- The Notification Service Extension is built, embedded and registered (`pluginkit` lists it). Provisional notification authorization was granted (`status=3`).
- `simctl push` with `mutable-content:1` delivered the notification but never launched the extension, with the app both backgrounded and terminated. That matches the documented simulator limitation. Two approaches failed, so I stopped there.
- **Proven instead:** the extension's fetch code (ephemeral `URLSession`, 5 s deadline) reaches the door from the simulator: `HTTP 401 in 32 ms`.
- **BLOCKED ON SEAN** for the question that decides rich text: can the extension fetch over Tailscale while the phone is locked? That needs an Apple Developer team and certificate, the iPhone's UDID for a development profile, an APNs key, and Tailscale on the phone.

**Android**
- With `adb root`, I sent `am broadcast` to `com.google.firebase.iid.FirebaseInstanceIdReceiver` (action `c2dm.intent.RECEIVE`) while the app was force-stopped.
- The app cold-started, `onMessageReceived` ran, and the tailnet fetch returned `HTTP 401 in 1723 ms`, cold start included. The notification "Rewritten by FCM service" appeared (`android-10`).
- **Caveat:** `FirebaseApp` used placeholder options because there is no Firebase project, so there was no push token and no real FCM delivery. Doze and standby behaviour are untested and need Sean's Firebase project.

## Surprises (Q7)

1. **Android: one renderer crash kills the whole app unless every WebView handles it.** All WebViews in the app share one renderer, including the Capacitor launcher behind the workspace. Capacitor's `BridgeWebViewClient` doesn't handle `onRenderProcessGone`, so the first crash ended with `FATAL … crash wasn't handled by all associated webviews, triggering application crash`. The fix was a `BridgeWebViewClient` subclass in `MainActivity` that destroys the launcher WebView and recreates the activity on resume. After that, recovery was clean.
2. **Android: the scaffold's `singleTask` launcher destroys `WorkspaceActivity`** when the app icon is tapped again, for example after an external link sent the user to Chrome. Switching the launcher to `launchMode="standard"` fixed it. The auto-handoff also needs a guard: pressing Back in the workspace landed on the launcher, which opened the workspace again, in a loop.
3. **iOS: a navigation that turns into a download fires `didFailProvisionalNavigation` with WebKitErrorDomain 102** ("frame load interrupted"). The rule "network error → can't-reach screen" must ignore 102 and cancellations.
4. **Blob downloads differ by platform.**
   - On iOS, a `blob:` link with `download` goes straight to `WKDownload`, no channel needed.
   - On Android, `DownloadListener` receives the `blob:` URL but cannot fetch it, so `saveFile` is required there.
   - On Android, `saveFile({url})` names the file from the URL (`export.bin`) rather than the server's filename. It needs a `name` parameter, or a native HEAD request first.
5. **Web UI problems visible inside the app:**
   - The pairing page shows the in-app-browser warning on Android (already covered by Plan 1's `MurageApp/` skip).
   - The "Add Murage to your home screen" banner appears inside the iOS app (`ios-03`).
   - The header draws under the status bar on iOS and on Android API 36, which forces edge-to-edge. We need to decide whether the web UI or the native view owns safe-area insets.
   - The iOS user agent reports `iPhone OS 18_7` on 26.5, so detect the app by the `MurageApp/` token only.
6. **The door only trusts a Tailscale Serve front on `:443`** (`inspectBrowserServe`). Behind `:8444` it would advertise `http`, set a non-`__Host-` cookie and fail the Origin gate. For the spike I faked only the door's read-only `serve status --json` reading, using a `--require` preload (`host/fake-serve-preload.cjs`); no Murage files were changed. Phones use `:443`, so the product is unaffected, but test rigs and users on non-443 Serve ports are. Consider accepting `host:port` fronts in Plan 1.
7. **Reachability from the simulator and emulator was fine.** The emulator resolved the MagicDNS name with no DNS flags. Both only reached this same Mac, though; a phone on cellular through the Tailscale app is untested.
8. **Test tooling notes:**
   - `simctl openurl` to a custom scheme shows an "Open in Murage?" prompt that can't be tapped headlessly, so the iOS test hooks read commands from a file in the app container.
   - macOS privacy settings block `simctl io screenshot` from writing to `/Volumes/Fixture`, so screenshots go via `/tmp`.

### Cookie attributes observed (both platforms)

`__Host-murage_session`, host-only domain `test-laptop-pro.tail000000.ts.net`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, persistent (Max-Age about 90 days, expires 2026-12-24), value 58 characters.

## Recommendations

**Plan 2 (app shell)**
- Keep the architecture.
- **iOS channel:**
  - Normalise `WKSecurityOrigin.port == 0` to the default port before comparing origins.
  - Reply to dropped messages with a generic error, so the page's promise doesn't hang.
- **Android channel:**
  - Define the `murageNative` wrapper only in the top window.
  - Give the raw listener a separate name from `murageNative`.
  - Check `isMainFrame` natively.
- **Must add:**
  - The launcher WebView handles renderer death (Surprise 1).
  - The launcher activity is not `singleTask` (Surprise 2).
  - Can't-reach ignores WebKit 102 and cancellations (Surprise 3).
- **Android route:** persist the last route natively, because `sessionStorage` is lost when the WebView is recreated.
- **`saveFile`:** take `{url, name}`. The blob chunk path is needed on Android.
- **Safe area:** decide who owns safe-area insets.
- **Plan 1 additions:**
  - Add the home-screen-banner `MurageApp/` skip.
  - Make the CSP `frame-src` mandatory.

**Plan 3 (push)**
- **Android:** the data-only FCM → fetch → self-built notification pipeline works mechanically. It still needs a Firebase project to test the push token, real high-priority delivery, and Doze and standby.
- **iOS:** keep generic text as the complete V1 outcome. Make "rich text on the lock screen" depend on a test on a locked real phone, and make that Plan 3's first task.

**Spec changes suggested**
- **§3.2:**
  - The launcher WebView must also handle renderer death.
  - The launcher must not be `singleTask`.
  - Can't-reach excludes interrupted and cancelled loads.
  - `saveFile(url, name)`.
- **§3.3:** optionally accept Serve fronts on non-443 ports.
- **§3.6:** add the in-app skip for the home-screen banner and the safe-area ownership decision.

## Native code sizes (spike, in lines)

| File | Lines |
|---|---|
| **iOS** | |
| `WorkspaceViewController.swift` | 239 |
| `WorkspacePlugin.swift` | 36 |
| `SpikeDebug.swift` (test only) | 72 |
| `MobileViewController.swift` | 10 |
| `SceneDelegate.swift` | 22 |
| Notification Service Extension | 35 |
| **Android** | |
| `WorkspaceActivity.java` | 275 |
| `WorkspacePlugin.java` | 27 |
| `MainActivity.java` | 33 |
| `SpikeMessagingService.java` | 35 |
| `SpikeApp.java` (placeholder Firebase) | 21 |
| `SpikeHook.java` (test only) | 14 |
| **Launcher page** | 14 |

Without the test hooks, the workspace and channel core is about 550 lines across both platforms. That is consistent with the spec's estimate of about 1,000 lines once the real error screens and remaining channel methods are added.

## Cleanup done

- **Tailscale Serve:** only `:8444` was added, then removed. `tailscale-serve-after.json` is identical to `tailscale-serve-before.json` (checked with `diff`). The `:443` and `:8443` entries were never touched.
- **Isolated Murage:** the harness (pid 58566) and door (pid 58634) are stopped, and ports 28799–28813 are free. The temp data directory, `host/companion-data` and `host/web-dist` are deleted. `git status` in the `app/` worktree is empty.
- **Simulator and emulator:** the simulator is shut down and the emulator killed. The old Codex demo build of `com.murage.mobile` on the `MurageMobileDemo` emulator was uninstalled, because its signature clashed with the spike's, and replaced by the spike APK.
- **Hetzner:** the gradle cache and all build directories are deleted. `/root/mb-mobile/spike` is now 4.9 MB (sources, build script, debug keystore). Disk is at 29%. No peer directories were touched.
- **Local Mac:** the iOS DerivedData (133 MB) is deleted. The spike APK remains at `spike/build/app-debug.apk`.
## Push feasibility (Plan 3a Task 0)

Run on 2026-09-27 on Sean's iPhone (iPhone19,7, iOS 27, sandbox APNs) and Samsung S25. Each fetch was a `GET https://<mac>.ts.net:8444/healthz` on the isolated E2E host over Tailscale. The spike code stays on the local branch `spike/push-feasibility`. Results come from the extension's and service's own logs, pulled off the phones, not from the screen.

| Case | Result |
|---|---|
| iPhone locked, extension fetch over Tailscale | `fetch 200 in 106 ms`, `fetch 200 in 77 ms`, `fetch 200 in 109 ms` (3/3; the banners appeared on the locked phone) |
| iPhone before first unlock | All 6 sends were delivered once the phone was back up. Locked, the previews were hidden ("6 notifications"). Unlocked, each read `fetch 0 in ~5 ms, error …`: the extension ran before first unlock, replaced the body and delivered, with no crash and no expiry. Tailscale was also off for this case (it can't start before first unlock anyway), so this case can't separate "before first unlock" from "no VPN". The extension couldn't write its own log file before first unlock (data protection). |
| iPhone with Tailscale off | `fetch 0 in 268 ms, error -1003`, `fetch 0 in 7 ms, error -1003`, `fetch 0 in 5 ms, error -1003` (can't find host; fails fast, notification still delivered) |
| Android data-only FCM, app stopped, locked | Process dead (not force-stopped), deep Doze forced: `fetch 200 in 138 ms`, `fetch 200 in 92 ms`, `fetch 200 in 100 ms`. Backgrounded in deep Doze: 68, 82, 75 ms. After a user **force-stop**, nothing was delivered until the app next ran; then all 3 held messages arrived and each showed `fetch 200` |

- nseFetchWhileLocked: true
- fcmDataFetch: true

Notes for Plan 3b:
- I3 must show the generic text on any fetch error. Tailscale off gives -1003 within milliseconds, and before first unlock the fetch can't succeed.
- A3 should document that a force-stopped app gets no pushes until it is opened again (Android's stopped state).
- The relay's APNs client needs connect retries. From the Mac, `api.sandbox.push.apple.com` often timed out (`ETIMEDOUT`), and one send needed 5 attempts.
- An extension's log must not assume it can write files: before first unlock its container is unavailable.
- FCM v1 accepted a gcloud **user** access token (default scopes) with `x-goog-user-project`.
