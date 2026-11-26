# Murage Mobile: design

Date: 2026-09-25. Revision 3, **approved by Sean 2026-09-25**. Revision 2 followed the cross-audit by GPT-6 Astra (verdict
REJECT, revise first) and Kimi K3 (verdict APPROVE WITH CHANGES). Revision 3 applies
the must-fix items from both confirmation passes: Astra on revision 2 and Kimi K3 on
revision 3, both APPROVE WITH CHANGES.
Section 12 lists what changed and why.
Branch: `mobile/v1` (off `next/0160`), repo `FerroxLabs/murage-mobile` (private).
Supersedes: `muragemobile/MOBILE-PLAN.md`, `BUILD-PLAN.md` rev 3, and the Codex branch
`mobile/recovery-20260922`. That branch is kept only as a source of parts; see section 10.

## 1. What we are building

One app for iPhone and Android, built from one codebase, that lets a nontechnical person
use their own Murage from their phone. The phone is a remote control. Agents run on the
user's computer or headless server. The phone never runs agents and never copies the
database.

The jobs the app must do well:

1. Talk to the Chief of Staff and to teams, with text, files, photos, voice and calls.
2. See what needs you and approve or answer it, including from the lock screen.
3. Tell you when something needs you or has finished.

**Success measures**

- **Pairing time.** With Murage and Tailscale already running on the computer and Tailscale
  installed on the phone, a stranger goes from installing the app, through scanning the QR
  code, to chatting with the Chief of Staff in under 2 minutes. A fresh phone, including
  installing Tailscale, takes under 5 minutes.
- **Launch speed.** Measured on an iPhone 13-class and a Pixel 7-class phone, over 4G
  throttled to 10 Mbps with 150 ms RTT through a Tailscale DERP relay, at p75:
  - cold start under 3 s
  - warm start under 1 s
- **Release.** The app is on Sean's real iPhone and Android phone through TestFlight and
  Play internal testing.

**Not doing**

- Windows phones. The platform has been dead since 2017.
- A second copy of the UI, or native versions of the chat screens.
- Choosing the URL based on the Wi-Fi network name.
- Critical alerts.
- Tailscale Funnel or any other public way into a real Murage.

## 2. Architecture

The app wraps the existing web UI in native WebViews. Native code is added only where the
web cannot do the job. This is the Home Assistant Companion model: the user's own server
serves the UI into a plain native WebView, and a small, strictly checked message channel
connects the page to native features.

```
Phone app
 ├─ Launcher (Capacitor page, bundled): welcome · QR scan · saved workspaces ·
 │    can't-reach · re-pair · demo mode · settings. Uses Capacitor plugins locally.
 ├─ Workspace screen (our own native WebView, NOT Capacitor's):
 │    iOS WKWebView in a WorkspaceViewController · Android WebView in a WorkspaceActivity
 │    loads https://<host>.<tailnet>.ts.net  (= tailscale serve :443 → browser door :8813
 │    → Murage server :8799)
 │    channel: window.murageNative (native-checked: exact saved origin + main frame)
 └─ Native services: push (APNs/FCM), notification actions, iOS Notification Service
      Extension, file save/share, mic/camera permission, app lock, reachability

Push: Murage server ─(content-free event)─▶ Murage relay (Cloudflare Worker)
      ─▶ APNs / FCM ─▶ phone ─(detail fetch over Tailscale, scoped token)─▶ host
```

**Why this shape**

- **One UI.** Desktop, browser and phones all run the same web UI. A Murage update reaches
  phones immediately, with no app store release. The phone-only code is:
  - the launcher
  - the workspace screens (about 1,000 lines of native code in total)
  - the notification code
- **Authentication already works.** Because the workspace WebView loads the host's own
  origin, it behaves like a normal same-origin browser. The existing browser-door pairing,
  the `__Host-` cookie session and both origin gates all pass unchanged. A bundled
  `capacitor://localhost` UI fails both gates, which is why the Codex build needed about
  1,450 lines of native networking and its own login system.
- **The workspace uses its own WebView, not Capacitor's** (audit findings Astra 1–2,
  Kimi 6 and 15). Capacitor injects its bridge only into its own app origin
  (`Bridge.java:267-269`). On iOS it dispatches plugin calls without checking the frame or
  the origin. We never expose Capacitor plugins to remote content. Our channel is small,
  and we control it completely:
  - **iOS:** a `WKScriptMessageHandler`, plus a document-start `WKUserScript` injected
    into the main frame only. Every message is checked for `frameInfo.isMainFrame` and
    for a `securityOrigin` whose scheme, host and port equal the saved workspace origin.
    Anything else is dropped.
  - **Android:** `WebViewCompat.addWebMessageListener("murageNative", {exactOrigin})`
    with `addDocumentStartJavaScript` for that one origin. `onPostMessage` checks
    `isMainFrame`. Both `WebViewFeature.WEB_MESSAGE_LISTENER` **and**
    `DOCUMENT_START_SCRIPT` must be supported; `addDocumentStartJavaScript` throws when
    it is not. If either is missing, the channel fails closed: the web UI still works,
    but without native features.
  - **Both:** navigation outside the saved origin opens in the system browser. The shell
    Content Security Policy's `frame-src` limits iframes. Code on the workspace's own
    origin is trusted, the same as it is in a desktop browser.
- **The connection layer can be swapped.** To the app, a workspace is simply an HTTPS
  origin the phone can reach. Tailscale Serve is how you get one today. Murage Cloud or a
  future private tunnel would just be another origin. The app accepts any HTTPS origin and
  recommends Tailscale.

**Rejected alternatives**

- **Bundling `dist/` into the app.** It breaks same-origin authentication and ties the
  phone's UI to the app release. Compression and code splitting (section 6) recover most
  of the speed without those problems.
- **Pointing Capacitor's WebView at the remote origin.** The bridge does not get injected
  on Android, and there are no origin or frame checks on iOS.

## 3. Components

### 3.1 Launcher (bundled Capacitor page)

A plain TypeScript and HTML page, a few hundred lines. It uses Capacitor plugins locally
for the camera, secure storage, push registration and haptics.

- **Welcome, then Scan.** The native scanner comes from the Codex branch. It accepts the
  existing browser-door URL `https://<host>/enter#murage_pair_…`. As a fallback, the user
  can type an address and a 6-digit code.
- **Reachability probe.** Before loading a workspace, native HTTP calls `GET /healthz`
  (section 3.3).

  | Probe result | What the launcher does |
  |---|---|
  | 200 with `{mobile: 1}` | Load the workspace. |
  | Any other HTTP reply from the door (an old host answers `/healthz` with 401, because unknown routes require a session: `browser.ts:1297`) | Old Murage: load it in basic mode and show "Update Murage on your computer for notifications". |
  | Timeout or TLS failure | Can't-reach screen. |

- **Saved workspaces.** `{origin, name, bindingId?, lastConnected}` is stored in the
  Keychain or Keystore. The session lives in the WebView's persistent cookie store, and
  push tokens are stored separately (section 3.5).
- **Can't reach your Murage.** Plain-language screen with:
  - "Is Tailscale on?" and an Open Tailscale button (an App Store or Play link; on Android,
    it launches Tailscale directly when installed)
  - "Your computer may be asleep"
  - "Last connected N min ago"
  - Retry
- **Re-pair.** Used when a session has expired or been revoked. It says "Scan the code on
  your computer again". It never tells the user to open the Camera app, because that would
  put the session into Safari instead of the app.
- **Demo mode.** A bundled, functional sample workspace for App Review and curious users.
  It includes a scripted Chief of Staff chat, an approval card, a question card and a
  local-notification demo, and it needs no server.
- **Splash.** The native splash and background colour stay up until the workspace signals
  ready, so there is never a white flash.

### 3.2 Workspace screen and native channel

**Native workspace WebView duties (both platforms)**

- Persistent default cookie store and data store.
- User agent token `MurageApp/<version> (<platform>)`.
- Mic and camera permission prompts:
  - iOS: `requestMediaCapturePermission`.
  - Android: `onPermissionRequest` backed by `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` and
    `CAMERA`.
- File input (Android `onShowFileChooser`; handled natively on iOS).
- Downloads:
  - iOS: `WKDownloadDelegate`.
  - Android: `DownloadListener`, with blob URLs sent through `saveFile`.
- External links open in the system browser.
- Main-document HTTP status:
  - 401 → re-pair screen
  - network error → can't-reach screen
- **Readiness deadline.** If the UI has not posted `ready` within 20 s of the page load,
  show "Loading is taking a while" with Retry. An old host that never sends `ready`
  still shows its page, in basic mode.
- **Recovery after the WebView process dies:**
  - iOS: `webViewWebContentProcessDidTerminate`.
  - Android: `onRenderProcessGone` returns `true`, then the dead WebView is destroyed and
    a new one is created, re-registering the listener and scripts. Android forbids
    reusing a WebView whose renderer has died.

  The page reloads behind the splash and returns to the persisted route.
- **Persisted state.** The native side persists the active workspace, the last route and
  any pending notification intent, so they survive the app being killed.

**The `window.murageNative` channel**

- Methods, each versioned and feature-detected by the UI:
  - `hello()` returns `{version, methods[]}`
  - `ready()`
  - `registerPush()` and `pushStatus()`
  - `issuePushTokens(grant)` (section 3.5)
  - `saveFile(...)`. Server files are passed as a URL, and native downloads them directly
    using the WebView's cookies (iOS `WKDownload`, Android `DownloadManager` with the
    cookie header), so large files never cross the channel. Blob or generated content is
    sent in 1 MB chunks, capped at 25 MB (Kimi, rev 3).
  - `openExternal(url)`
  - `haptic(kind)`
  - `appLock(on)`
  - `signOut()` and `rePair()`
  - `setBadgeCount(n)`
- Events: `resume`, `pause`, `notificationOpened({bindingId, threadId, messageId})`,
  `backButton`.

### 3.3 Host changes: companion (browser door :8813)

| Change | Why |
|---|---|
| **Session renewal made recoverable and idempotent** (rules below) | Phones lose the renewal response when the app is suspended or the network drops, which leaves a dead cookie and a silent sign-out (`devices.ts:919-955`). A fixed grace does not heal a phone that sleeps longer (Astra 4, Kimi 3). Minting a fresh credential on each retry creates a race when responses arrive out of order (Astra, rev 2). This deliberately weakens "a stolen copy dies on rotation". That is acceptable because the door has no public ingress. |
| Public `GET /healthz` returning `{ok, name, mobile: 1}`, with no session and no CORS | A cheap probe plus a capability handshake (today `/api/health` returns 401 without a session) |
| Skip the in-app-browser warning when the user agent contains `MurageApp/` | Android WebView's `; wv)` string triggers it (`browser.ts:801`) |
| **Remote Inbox access model.** A remote device with owner-level access gets `/api/inbox` and `/api/inbox/state`. Its threads are filtered by that device's visibility (`sse-visibility`), and state changes are limited to those threads. | Today the server passes `owner:false` for remote callers and `inbox.ts:226` rejects them. Simply allowing the route would still fail, and forcing `owner:true` would leak hidden threads (Astra 5). |
| Allow `/api/tts/prepare`, `/api/bots/:id/call-note`, `/vad/*`, and `.wasm`/`.onnx` under assets | Voice is blocked for every remote client today |
| Keep the upstream `cache-control` on `/api/attachments/*` and message images | The `no-store` override (`browser.ts:1379`) forces a re-download on every view |
| **Compression** (see below) | The 5.5 MB main script is sent raw (section 6) |
| Shell Content Security Policy, including `frame-src` | There is no policy today; chat renders some raw HTML |
| Bearer-only push routes `GET /api/mobile/push/:eventRef` and `POST /api/mobile/push/respond`, exempt from the origin gate **only** for these two routes and only with `Authorization: Bearer` | Native notification code cannot use the HttpOnly cookie (section 3.5) |
| Remote "Sign out this phone" (revokes the device, its sessions and push binding), plus the `installId` replacement rule described under "Device records" below | Reinstalls accumulate devices, and pairing fails at 20. Records are never pruned automatically (Astra 11, Kimi 15, Astra rev 2). |
| The Mermaid frame becomes a content-hashed, immutably cached file, and the `/mermaid-frame.html` entry in `BROWSER_STATIC` changes to match (`routes.ts:206`) | It is 5.1 MB and currently served `no-store` |

**Session renewal rules**

- Each session holds a `current` hash and at most one `pending` successor.
- The successor is **derived, not random**:
  `pending = HMAC(serverSecret, currentHash ‖ generation + 1)`. The server can therefore
  send the same successor again without storing any plaintext.
- `renew(X)` behaves as follows:
  - If X is `current` and a `pending` exists, the server re-sends that same `pending`.
    Every retry gets an identical value, so responses arriving out of order can't
    conflict.
  - If X is `current`, there is no `pending`, and renewal is due, the server derives a
    new `pending`.
  - If X is `pending`, the server promotes it to `current` (commit on first use) and drops
    the old `current`.
- Any request that presents `pending` also commits it.
- The generation counter is monotonic, stored with the device record, and never reused.
  The HMAC input includes the session id and the session's `createdAt`, so restoring a
  server state from backup cannot bring a retired credential back to life (Kimi, rev 3).
- `current` stays valid until `pending` is committed. An uncommitted `pending` expires
  after 7 days.
- Renewal is due 24 h after the last commit, not 24 h after the session was created.
- Revoking the device kills both hashes.

**Device records**

- There is no automatic pruning. Existing browser pairings also carry a `tokenHash`
  (`devices.ts:680`), so there is no reliable way to tell a browser-only record from one
  that can use a bearer token (Astra, rev 2).
- The app sends a stable `installId` when it pairs. Pairing again with the same
  `installId` replaces that install's old record. The id is not a secret.
  - **iOS:** stored in the Keychain, which survives an uninstall and reinstall.
  - **Android:** stored in backup-eligible app preferences. Keystore contents are wiped
    on uninstall, but Android Auto Backup restores these preferences. Without a backup
    it becomes a new install.
- When pairing hits the device cap, the pairing screen on the computer offers "Replace an
  old device", with devices sorted by when they were last seen, instead of failing (Kimi,
  rev 3).
- Remote "Sign out this phone" and the desktop device list handle everything else.
- When the 20-device cap is reached, the error lists devices by when they were last seen.

**Compression rules**

- Pre-compressed `.br` and `.gz` files for static assets.
- JSON is compressed only after it has been scrubbed.
- HTML is compressed only after the renewal script has been injected.
- The event stream (SSE) is never compressed.
- Responses carry `Vary: Accept-Encoding`.
- The Content Security Policy is preserved.

### 3.4 Host changes: server and installer

- **Push outbox**, hooked in `notify()` **after** `applyNotificationPreferences`. Quiet
  hours and the per-category switches already exist there, so they apply to phones for
  free (Kimi 14).
  - The outbox is durable and retries.
  - Each entry is `{kind, botId, threadId, requestId, revision, createdAt, expiresAt}`,
    with no names or text.
  - Delivery follows the same per-device visibility rules as `sse-visibility.ts`.
  - Adapted from Codex's `server/mobile-notification-*`.
- **Presence**, so phones are quiet while you're at your desk (Kimi 8):
  - Desktop and browser clients `POST /api/presence {visible}` when the page's visibility
    changes, and every 60 s while it is visible.
  - Presence counts only if a non-phone client has been visible within the last 90 s.
  - While present, an attention push is held for up to 2 min. If the item is still
    unanswered after that, it is sent.
  - Resolution updates are never held.
- **Resolution events.** Answering an approval or question anywhere sends a replacement
  push with the same collapse key and a higher revision. It reads "Answered on desktop" and
  updates the badge. This is best-effort, and the phone also reconciles when it opens
  (section 3.5).
- **`murage pair` command** for headless setups. It opens a pairing window and prints a
  terminal QR of the `/enter#…` URL, using `installer/lib/ui.mjs` `qrencode` rendering,
  plus the 6-digit code.
- **Keep-awake offer.** When a phone is set up on a Mac or PC, offer "Keep this computer
  awake while a phone is paired". This uses the existing opt-in `syncCompanionKeepAwake`
  (`electron/main.mjs:944`). The wording says a closed lid still sleeps the computer.
- **Setup copy for tailnets without HTTPS certificates**, because `serve` fails there.

### 3.5 Push, enrolment and notification actions

**Enrolment**

Enrolment is rooted in the phone, with no Murage account (Astra 7, Kimi 4).

1. After pairing, the phone enrols with the relay and proves it is the genuine app, using
   iOS App Attest or Android Play Integrity. The relay stores the device's push token and
   returns a `deviceBinding` plus a short-lived single-use `publisherGrant`.
2. The phone hands the grant to its host through the authenticated WebView session
   (`POST /api/mobile/push/enrol`).
3. The host redeems the grant for a `publisherToken`, which can publish only to that
   binding.

Abuse controls:

- Only genuine app installs can create bindings.
- At most 10 bindings per device.
- At most 500 pushes per binding per day.
- Enrolment rate limits per IP address and per device.
- A global volume cap, a bounded queue and an operator kill switch.

Signing out, re-pairing or revoking the device on the host deletes the binding.

**Relay changes to the carried-over Codex relay** (Kimi 1–2, Astra 8)

- **iOS (APNs):**
  - `alert` with generic text, `mutable-content: 1`, `category`, `thread-id` (binding
    plus bot), `badge`, and `interruption-level` (`time-sensitive` only when an approval
    is blocking work).
  - `apns-collapse-id` is a hash of binding plus request id, stable per request. Today it
    is a fresh event id, so replacement never works.
  - `apns-expiration` equals the request's expiry.
- **Android (FCM):** data-only, high priority. Our `FirebaseMessagingService` builds the
  notification itself. Three channels: Approvals (high), Questions (default) and
  Finished (low). The tag uses the same stable collapse key. With a notification payload,
  Android skips `onMessageReceived` while the app is in the background.
- **Opaque payload:** `{bindingId, eventRef, category, revision, workspaceBadge, collapseKey}`.
  The phone ignores any revision older than one it has already shown.

**Two scoped tokens per device** (Astra 3 and 6)

Both are issued by the host over the authenticated session and handed to native code with
`issuePushTokens`. Both are bound to the device record, and both are revoked on sign-out,
device revocation or re-pair.

| Token | What it allows | Storage |
|---|---|---|
| `detail` | Read only. `GET /api/mobile/push/:eventRef` returns `{title, body, target}`. The title and body are rebuilt at read time from the referenced message, using the same
builders `server/notify.ts` uses for each kind: approval, question, done and failure. If
the message is gone, it returns the generic text (Kimi, rev 3). It works only for events
queued to **this device's binding** that have not expired, and only while the thread is **still visible** to this device when read. The notification preferences are re-applied at read time: when `previewContent` is false, it returns the generic title and body from `applyNotificationPreferences`, so turning previews off also hides lock-screen text. | App Group Keychain on iOS, readable after first unlock, so the Notification Service Extension can use it. Keystore on Android. |
| `respond` | `POST /api/mobile/push/respond` with a strict body `{requestId, decision: "allow"\|"deny", revision}`, only for request ids that were pushed to this device and have not expired | Readable only while the phone is unlocked. Never shared with the extension. |

**Rich but private text**

- On iOS, the Notification Service Extension fetches the detail with a **5 s** deadline and
  rewrites the notification, for example "Lena wants to delete 3 files". If the fetch times
  out, the extension's expiry handler fires, or the phone has not been unlocked since boot,
  the generic text stays.
- On Android, the messaging service does the same fetch with the same deadline.
- Generic text is a complete, working outcome in its own right. Apple, Google and our relay
  never see content.

**Lock-screen actions**

- **Categories:**
  - `APPROVAL`: Approve, Deny, Open.
  - `QUESTION`: Open (inline reply comes in V1.1).
  - `DONE`: no actions.
- **Requirements:** iOS uses `.authenticationRequired`. Android uses
  `setAuthenticationRequired(true)`, which needs **API 31 or later**. Below API 31, the
  notification offers Open only.
- **Server enforcement:**
  - The first decision wins; later decisions are rejected cleanly.
  - Each decision is atomic and bound to the request id, device, revision and expiry.
  - Deny is always allowed.
  - The server **refuses Allow via the `respond` token** for approvals it rates risky or
    has not rated. Risky means deleting outside the workspace, spending, sending email or
    messages, or credentials. For those, the notification shows only Open and Deny, and
    Allow happens in the app. With app lock on, the app first asks for Face ID or the
    device biometric.
- **If the action cannot reach the host,** the phone shows a local "Couldn't reach your
  Murage, open the app" notification.

**Badge and reconciliation**

- Every push carries the pending count for its own workspace. The phone keeps one count
  per binding and sets the app badge to their sum (Astra 9, Kimi 10).
- When the app opens, it fetches each workspace's pending list, removes notifications
  already resolved, and corrects the counts.

**Tapping a notification**

1. The binding id selects the workspace; switching away from another workspace fences off
   late results from the old one.
2. The UI resolves the target from the thread id. `openNotificationTarget` is extended to
   accept a thread with no bot, resolving the bot after the data has loaded.
3. If that workspace has been removed, the phone drops the notification and shows a toast.
   If it needs re-pairing, the phone re-pairs first and then opens the target.

### 3.6 Web UI changes (shared with desktop and browser)

**Plumbing**

- **Deep links.** A `#open=<threadId>&msg=<messageId>` handler and the
  `notificationOpened` event call the extended `openNotificationTarget` and
  `focusMessage` once data has loaded. Today there is no URL routing.
- **Handling a 401.**
  - When an API call or the event stream returns 401, the UI checks `GET /session`.
  - If that also returns 401, the UI stops reconnecting. It calls `murageNative.rePair()`,
    or in a plain browser shows a "Signed out, pair again" card.
  - The event stream can't report its HTTP status, so a stream error triggers the same
    `/session` check.
- **Remote offline banner**, driven by the connection flag, with wording written for
  remote clients.
- **Native-shell detection** (`window.murageNative` from `hello()`, or the user agent
  token) drives four behaviours:
  - hide the PWA install prompt
  - send blob downloads to `saveFile`
  - send `window.open` and `_blank` links to `openExternal`
  - force the event stream to reconnect on `resume`
- **Lifecycle.** Pause every `setInterval` poller while hidden, for example the Inbox
  (5 s), SidebarPhoneButton (15 s), the WorkspacePane probe and ComputerPanel screenshots
  (3–4 s). Reload once on a lazy-chunk load failure after a host update.
- **Presence reporting** (section 3.4).
- **Composer on touch devices.** Return inserts a newline; the arrow button sends.
- **Drafts.** Failed sends are persisted, not only held in memory (`src/lib/drafts.ts:37`).

**Phone polish**, from the 390 px and 412 px screenshot study:

1. Add top safe-area padding to `SettingsModal` and `FirstRunPhases`.
2. Make the attachment Remove button always visible and 44 px on touch, and show the file
   name (`ComposerAttachments.tsx:235`).
3. On phones, Settings becomes a list you tap into, instead of a sideways strip that hides
   10 of its 12 sections.
4. The phone header is a single row. The folder, search, computer and memory buttons move
   into the overflow menu.
5. Approvals appear on one surface on phones, with 44 px buttons.
6. Every touch target is at least 44 px: the composer's attach, Ask and mic buttons; the
   question-card radios and Send; the hamburger; and the setup-strip close button.
7. The call "unavailable" popover is anchored to the call button.
8. Smaller fixes:
   - closing the Inbox also closes the drawer
   - the Inbox chips scroll instead of wrapping
   - the settings gear gets an accessible name

## 4. Quality of life

**V1**

- Lock-screen Approve and Deny, with step-up for risky approvals, plus rich but private
  notification text (section 3.5). Both depend on the Phase 0 spike (section 9). If the
  extension can't reach the host reliably, generic text still ships.
- Notifications:
  - the badge counts only what is waiting on you, summed across workspaces
  - three channels, grouped by bot
  - held while you're at your desk
  - quiet hours (already built)
  - replaced when answered elsewhere
- No white flash; recovery after the WebView process dies on both platforms; drafts
  restored.
- Android back button: closes the open sheet or drawer, then goes back, then exits the app.
- Haptics on approve, deny and send.
- Optional Face ID or biometric app lock.
- Long-press shortcuts on the app icon: "Ask Chief of Staff", "Needs you" and "Voice".
- Multiple workspaces, switchable from the launcher.

**V1.1**

- A lock-screen progress readout for long tasks: a Live Activity on iOS and an ongoing
  notification on Android.
- Reply to a question directly from its notification.
- Per-bot mute.
- Voice calls that keep going when the screen locks. This needs a native audio plugin:
  on iOS, `AVAudioSession` play-and-record with `UIBackgroundModes: audio`; on Android, a
  foreground service of the microphone type.
- Share to Murage from other apps.

**Later**

- Widgets.
- Siri, Shortcuts and the Action button.
- Apple Watch approvals.
- CarPlay voice.
- Cloud or private-tunnel workspaces. To the app, these are only a new kind of origin.

## 5. Calling and voice

- **V1 works in the foreground.** Calls and push-to-talk run in the web layer while the app
  is on screen, using the mic permission handling in section 3.2.
- **Host fixes it needs:** allow the voice-activity model and its wasm, plus `tts/prepare`
  and `call-note`; lazy-load silero/onnxruntime.
- **Known limit:** a call ends if the screen locks or you switch apps. The call screen
  says "Keep Murage open during a call" until V1.1 adds native audio.

## 6. Performance

**The measured problem:** `dist/assets/index-*.js` is 5.07–5.5 MB and is served
uncompressed through the companion and `tailscale serve`. On cellular, a cold launch takes
about 10–20 s.

| Fix | Expected effect (a hypothesis until measured) |
|---|---|
| Brotli/gzip, following the rules in section 3.3 | Main script from about 5.5 MB to about 1 MB; JSON about 10× smaller. Helps every remote browser too. |
| `React.lazy` for CallView (plus onnxruntime), the TipTap editors, the Settings pages and ComputerPanel; load silero with `await import()` | First-paint bundle 40–60% smaller |
| Mermaid frame content-hashed and immutably cached | No re-download whenever a diagram appears |
| Keep image cache headers; add a `?w=` thumbnail variant and `srcset` | Image-heavy chats stop re-downloading full-size originals |
| Phone mode: `screens=off` on the event stream; at boot, load only the active thread (`messages=0` for the rest) | Less data and battery; faster boot |
| `content-visibility: auto` on message rows, then trim the transcript window at both ends | Long threads scroll without jank |

**Guardrails**

- The event-stream heartbeat stays at 15 s. The client's 40 s stale watchdog stays as it
  is (Astra 12, Kimi 11).
- CI fails if the first-paint brotli size goes over budget.
- The targets are measured under the conditions in section 1.

## 7. Error handling

| Situation | What the user sees |
|---|---|
| Tailscale off, or host unreachable | The launcher's can't-reach screen, with Open Tailscale, the asleep hint and Retry |
| Old host without `/healthz` or without a bridge-aware UI | Basic mode: the web UI works, with no push; "Update Murage on your computer" |
| Host drops mid-session | Remote offline banner; drafts kept; automatic reconnect on resume |
| Session expired or revoked (document 401, or 401 on the API and on `/session`) | The re-pair screen, never an endless retry |
| Tailnet without HTTPS certificates | Desktop setup explains how to enable them; the phone shows "This address isn't secure" |
| Push detail fetch fails, or the phone is locked since boot | Generic notification text; tapping it opens the right chat once the host is reachable |
| Approval already answered elsewhere | Notification replaced with "Answered on desktop"; a second decision is rejected cleanly |
| Lock-screen action can't reach the host | Local notification: "Couldn't reach your Murage, open the app" |
| WebView process killed (either platform) | Silent reload behind the splash, back to the same chat |
| 20-device cap reached | The error lists devices by when they were last seen; re-pairing the same install replaces its old record |
| Notification for a removed workspace | Dropped, with a toast |

## 8. Testing

- **Unit and integration tests**
  - Companion: renewal generations, `/healthz`, the scoped bearer routes, the remote
    Inbox scope and compression.
  - Server: the outbox, visibility, presence holding, revisions and step-up refusal.
  - Relay: attestation, quotas and the payload shape for each platform.
  - Web: deep links, the 401 flow, lifecycle pausing and feature detection.
- **Phone-size end-to-end tests.** Playwright at 390 px and 412 px, against the isolated
  fake-engine fixture harness (`docs/verification/README.md`). They cover pairing through
  `/enter`, chat, approvals, the Inbox, upload, the offline banner, re-pair and deep links.
- **Payload budget check** in CI (section 6).
- **Devices.** The emulator and simulator cover the launcher and channel. Sean's real
  iPhone and Android phone run the acceptance tests:
  - scan to chat in under 2 minutes
  - rich notification while the phone is locked
  - lock-screen Approve and Deny, including a refused risky Allow
  - a call in the foreground
  - saving and sharing a file
  - killing the app and resuming
  - Tailscale off, then back on
  - host asleep
  - a reboot before first unlock
  - two workspaces
- **Process** (decided by Sean on 2026-09-25). The Codex 8-round cap does not apply to
  this build; Sean gave Claude free rein. Instead:
  - each phase is time-boxed
  - after two unsuccessful attempts at the same problem, escalate to Sean with evidence
  - no hard stop that records a problem as "blocked" instead of fixing it
  - "done" means the acceptance tests pass on real phones

## 9. Build order

0. **Feasibility spike (time-boxed to 2 days, throwaway code).** Using the Codex scaffold,
   build a native workspace WebView on both platforms against a real tailnet host. Prove:
   - the cookie survives the app being killed
   - the channel's origin and frame checks work
   - mic, file picker and downloads work
   - recovery after the WebView process dies works
   - on the real iPhone, the Notification Service Extension can fetch over Tailscale
     while the phone is locked
   - on Android, a data-only FCM message can trigger a fetch

   The results decide whether rich text and lock-screen actions stay in V1.
1. **Host fixes in Murage.** These ship in the next desktop release and immediately
   improve phone browsers:
   - sections 3.3 and 3.4, except the push routes
   - the plumbing in 3.6
   - section 6

   That release becomes the minimum host version for full app features.
2. **App shell:** the launcher, the workspace screens, the channel, deep links, and the
   can't-reach and re-pair screens. Android builds on Hetzner; iOS builds on the Mac, one
   build at a time.
3. **Push:** enrolment, relay changes, the outbox and presence, the detail and respond
   tokens, the Notification Service Extension and FCM service, actions and step-up, badges
   and reconciliation.
4. **Phone polish:** the eight items in section 3.6.
5. **Store preparation** (Kimi 5, Astra 13):
   - the functional demo mode
   - review notes and a demo video showing real use
   - a statement of native value and of the limits on remote updates
   - privacy labels and Play Data Safety answers covering what the relay stores: push
     tokens, binding metadata, IP addresses in logs, and event categories and times
   - TestFlight and Play internal testing on Sean's phones

   There is no public Murage host. If Apple insists on a live server, we stand up a
   separate seeded demo deployment with pairing disabled, never a normal Murage behind
   Funnel.
6. **V1.1.**

## 10. Carry-over from the Codex branch (`mobile/recovery-20260922`)

**Keep:**

- the Capacitor scaffold: Gradle and Xcode projects, icons, splash screens and manifests
- the QR scanner
- the permission and registration code for notifications
- the server notification outbox
- `shared/mobile-notifications.ts`
- `mobile-notification-launch.mjs`
- `docs/mobile/notifications-contract.md`, rewritten for rev 2
- the Cloudflare relay and migration `0007`, with the changes in section 3.5:
  - enrolment rooted in attestation instead of the account
  - data-only FCM
  - APNs fields
  - stable collapse keys
  - channels and revisions

**Drop:**

- the bundled second UI (the `apps/mobile/src` shell and runtime)
- the native transport (`MurageTransport`, `TransportPolicy`, the event-stream parser)
- the signed host identity and the mobile device type
- the second serve route and the Electron mobile companion
- the duplicate headless QR code
- `mobile-documents`
- about 30 edits to desktop `src/` files
- the verify scripts
- email-account enrolment

**Check separately:** the `conversation-thread` / `activeLeafId` fix.

**Method:** re-apply the kept pieces by hand on `mobile/v1`. Do not rebase the branch.

## 11. What we need from Sean

- Access to the Apple Developer account, covering:
  - bundle id `com.murage.mobile`
  - the push key and the Time Sensitive capability
  - App Groups (for the Notification Service Extension)
  - App Attest
  - TestFlight
- A Firebase project for FCM, and a Google Play Console app with Play Integrity enabled.
- A Cloudflare account for the relay Worker.
- One real iPhone and one real Android phone (API 31 or later) for acceptance testing.

## 12. Revision 2: audit changes

| Finding | Change |
|---|---|
| Astra 1, 2; Kimi 6, 15: the bridge isn't injected for remote origins on Android; no origin or frame checks on iOS; `allowNavigation` can't be changed at runtime | The workspace runs in our own native WebView with a natively checked `murageNative` channel. Capacitor stays inside the launcher. |
| Astra 3, 6: the push-action token was ambiguous | Split into a `detail` token and a `respond` token, with separate storage. Strict routes and bodies, server-enforced step-up, and Android API 31 gating. |
| Astra 4, Kimi 3: the 5-minute grace didn't heal | Commit-on-first-use generations, capped at 7 days; renewing with the previous credential re-issues. |
| Astra 5: the Inbox was still refused | An owner-level remote access model with visibility-filtered threads. |
| Astra 7, Kimi 4: anonymous enrolment could be abused | Enrolment rooted in the phone via App Attest / Play Integrity, with quotas and a kill switch. |
| Astra 8, Kimi 1, 2, 12: relay payload defects | Data-only FCM, APNs `mutable-content`/badge/`thread-id`/interruption level, stable collapse keys, revisions and `bindingId`. |
| Astra 9, Kimi 10: workspace identity and badge | `bindingId` routing, summed per-workspace badges, fencing when switching workspaces. |
| Astra 10, Kimi 7, 9: recovery and version skew | Native handling of HTTP status and readiness, `hello()` capability handshake, `/healthz` 404 means basic mode, Android `onRenderProcessGone`, persisted intent. |
| Astra 11, Kimi 15: pruning revoked real devices | Prune only browser-only records; explicit sign-out. |
| Astra 12, Kimi 11: compression correctness and heartbeat | Compression-order rules; the heartbeat stays at 15 s. |
| Astra 13, Kimi 5: store review; Funnel breaks the door's no-public-ingress rule | Functional demo mode and no Funnel; a privacy inventory. |
| Astra 14: phasing | Phase 0 feasibility spike added. The request to restore round caps is declined (Sean's process decision). |
| Kimi 8: no presence signal existed | Presence reporting defined. |
| Kimi 13, 14: harness name; quiet hours already exist | Named the real fixture harness; quiet hours move into V1 through the existing filter. |

**Revision 3, from Astra's confirmation pass on revision 2**

| Finding | Change |
|---|---|
| Android feature gating | `DOCUMENT_START_SCRIPT` is now required too; a dead renderer means the WebView is destroyed and recreated. |
| Old hosts answer `/healthz` with 401, not 404 | Any HTTP reply other than 200 with `{mobile:1}` means basic mode. |
| Renewal race when responses arrive out of order | Successors are derived by HMAC and re-sent idempotently; commit on first use; `current` stays valid until then. |
| Detail reads not tied to device; preview privacy lost | Detail reads are limited to the binding, the event's expiry and current visibility; `previewContent=false` is enforced at read time. |
| No way to tell browser-only device records apart | Automatic pruning removed; `installId` replacement plus explicit sign-out. |
| Process conflict with the Codex round cap | Written as a recommendation for Sean to confirm. |

**Revision 3, from Kimi K3's final confirmation**

| Finding | Change |
|---|---|
| Android `installId` is lost on reinstall | Stored in backup-eligible preferences; at the device cap the computer offers "Replace an old device". |
| Rich text rebuilt only for approvals | The detail endpoint rebuilds the text for every kind with the `notify.ts` builders, falling back to generic text. |
| Memory spikes from large `saveFile` payloads | Server files are downloaded natively by URL; blobs are chunked and capped. |
| Session rollback after a restore from backup | Monotonic generation; session id and `createdAt` are folded into the HMAC. |
