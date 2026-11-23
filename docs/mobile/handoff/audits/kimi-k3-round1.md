## Verdict

**APPROVE WITH CHANGES.** The core bet — Capacitor WebView loading the remote host origin so pairing, cookie auth and the origin gates pass unchanged — is correct and is *proven* by the door code it cites: a bundled `capacitor://localhost` UI genuinely fails both gates (`browser.ts:215-351`, `routes.ts`), and nearly every codebase claim in the spec checks out. But the push half has three concrete defects the "carry over" framing hides (Android's notification-vs-data model, missing `mutable-content`/badge/stable collapse IDs in the relay, and an under-specified anonymous enrolment with a real abuse hole), the 5-minute renewal grace as written does not fix the bug it exists to fix, and the Tailscale Funnel demo host contradicts the browser door's own documented "no public ingress, ever" invariant. None of this requires re-architecting; all of it requires spec amendments before implementation.

## Findings

**1. Android rich notifications cannot work with the carried-over relay payload.** *Severity: High.* The spec says "on Android, the FCM service fetches the detail from the host" (§3.5). The Codex relay sends FCM with a `notification` block plus `data` (`mobile-notification-providers.ts:123`). When the app is backgrounded, FCM displays `notification` payloads itself and `onMessageReceived` never runs — no fetch, no rewrite, no rich text. Rich text and reliable action handling require **data-only messages** on Android. *Change:* state explicitly that the relay sends data-only on Android and that this is a required modification to the carried-over providers file.

**2. The relay lacks everything the iOS NSE and the badge/stale-replacement plans need.** *Severity: High.* The Codex APNs payload has no `mutable-content: 1` (the NSE will never fire), no `aps.badge`, no `thread-id`, no `interruption-level` (`mobile-notification-providers.ts:141`). Worse, `apns-collapse-id` and the FCM `tag` are set to `event.eventId` — a fresh UUID per event (`:123,:140`) — so the spec's "replacement push (same collapse id)" can never replace anything; the collapse key must be stable per request (e.g. `requestId`). FCM `channel_id` is hardcoded to one channel, but the spec wants three. *Change:* the carry-over section must list these as explicit relay deltas: `mutable-content`, badge, `thread-id`, `interruption-level: time-sensitive` for blocked approvals, per-category channels, and request-scoped collapse keys.

**3. The 5-minute rotation grace, as written, doesn't fix the lost-renewal bug.** *Severity: High.* Today `renewSession` overwrites the single hash and "the old value dies" (`devices.ts:908-910,934`). The failure mode the spec cites: phone suspends mid-renewal-response, keeps old cookie A while the server holds B. With a resolve-only grace, A works for reads for 5 minutes — but the next `POST /session/renew` presents A, matches nothing, returns 204 with no `Set-Cookie` (`browser.ts:1200-1214`), and the phone dies when the grace lapses. *Change:* specify that on a grace match the renew endpoint re-issues the *current* credential (healing the cookie jar), not just that `resolveSession` tolerates the old hash; and note the deliberate weakening of the "stolen copy dies on rotation" property (`devices.ts:262`).

**4. Anonymous relay enrolment is a one-liner with a real abuse hole.** *Severity: High.* The Codex relay's registration, binding challenges and all three rate-limit scopes are keyed on `accountSession` (`mobile-notifications.ts:66-70,203-206`); the contract doc makes account auth the enrolment root (`notifications-contract.md:25-35`). The spec removes the account but never says what replaces it: who enrols (the phone installation, presumably), how the host learns the binding post-pairing, and what stops an attacker registering *arbitrary harvested APNs tokens* anonymously and spamming real users' phones through Murage's APNs key with no account to ban. *Change:* add an enrolment subsection — phone enrols after pairing, host redeems its publisher grant over the authenticated session, per-installation rate limits replacing the account scope, operator volume caps, and a kill-switch.

**5. The Tailscale Funnel demo host contradicts the door's security model.** *Severity: High.* `browser.ts:27-29` states "funnel never appears anywhere in this design… funnel is the public internet," and `devices.ts:219` rests the whole stolen-cookie argument on "no public ingress and never will be." A Funnel-fronted demo host puts `/enter` and the 6-digit code on the public internet, where the sign-in limiter keys on the socket address — which under serve/funnel is always `127.0.0.1` (`browser.ts:1109-1116`), so one internet stranger's flood locks out the reviewer too. *Change:* drop the Funnel host; rely on the bundled demo mode plus review notes, or a Tailscale-joined review account. If a public host is truly needed, it must be a separate seeded deployment with pairing disabled, not a normal Murage behind Funnel.

**6. "Bridge honoured only from the main frame, never from iframes" is not enforceable as stated.** *Severity: Medium.* On Android, `addJavascriptInterface` exposes the bridge to every frame with no frame info; on iOS the stock Capacitor plugin dispatch doesn't expose `frameInfo`. The origin check *is* enforceable natively (compare `webView.url` against the saved origins on every call). *Change:* rewrite the rule as "native-side exact-origin check against the main-frame URL on every call," add `frame-src` to the planned shell CSP (§3.3) as the real iframe control, and drop or iOS-scope the iframe absolute.

**7. Host/app version skew is unaddressed.** *Severity: Medium.* §7 has no skew row. An old host without `/healthz` will 404 the launcher's probe and read as "asleep"; a new host UI calling a bridge method an old app build lacks (e.g. `rePair()`) throws in the WebView. *Change:* the probe must distinguish 404 (old Murage → "update Murage on your computer") from timeout (asleep); the UI must feature-detect each `murageNative` method; state a minimum host version for the app.

**8. "No push while active at the desk (presence within 2 min)" has no existing signal.** *Severity: Medium.* Nothing server-side tracks client activity; notification suppression is client-side today (`store.tsx:966-975`), and `sse-visibility.ts` scopes threads, not presence. *Change:* specify the activity signal (what the desktop/browser reports, at what cadence, over which channel) or downgrade the claim to "stream-connected," which is a materially weaker promise.

**9. Lifecycle coverage is iOS-only.** *Severity: Medium.* §4 covers `webViewWebContentProcessDidTerminate` but not Android's `onRenderProcessGone`; and "back to the same chat" silently depends on the not-yet-built `#open=` routing (there is no URL routing today — confirmed, no `location.hash` handling in `src/`). *Change:* add the Android renderer-gone path and name the routing dependency.

**10. Multi-workspace badge arithmetic is unspecified.** *Severity: Medium.* Two paired hosts each "set the badge in every payload"; APNs badge is one number — last writer wins. *Change:* state the rule (sum? max? per-host replacement on resume?).

**11. Mobile SSE heartbeat range straddles the client watchdog.** *Severity: Low.* The spec proposes 30–45 s; the client declares a stream stale at 40 s (`live-events.ts:10`). At 45 s the phone reconnect-loops forever. Pin below 40 s or adjust the watchdog for mobile.

**12. Payload field list drops `bindingId`.** *Severity: Low.* §3.5 lists `{eventRef, category, badge, collapseId}`, but the NSE/FCM detail fetch needs `bindingId` too — the Codex payload carries it (`mobile-notification-providers.ts:123,141`). Doc fix.

**13. `verify-omb` doesn't exist.** *Severity: Low.* The name appears only in the spec; the repo has the isolated-fixture harness (`docs/verification/README.md`). Name the real harness or create the script.

**14. Quiet hours already exist.** *Severity: Low.* `shared/notification-preferences.ts` implements them and `notify()` applies them (`server/index.ts:3526`); if the outbox hooks `notify()` post-filter, quiet hours are free in V1. The V1.1 item is really per-bot mute. Also, the content-hashed Mermaid frame requires changing the exact `/mermaid-frame.html` entry in `BROWSER_STATIC` (`routes.ts:206`) — call it out.

**15. Minor inaccuracies.** *Severity: Low.* "allowNavigation set dynamically" is not a Capacitor API — it needs custom `decidePolicyFor`/`shouldOverrideUrlLoading` code. The NSE needs App Groups for shared-Keychain access to the push-action token (add to §11's entitlement list). Device pruning "with no live sessions" won't catch reinstalls whose idle sessions live up to 60 days (`SESSION_IDLE_MS`, `devices.ts:229`). The Settings 1.5–3 s poller claim (§3.6) I could not verify.

## Things the spec gets right

- The central architecture decision, argued from measured door behavior rather than preference — including the correct rejection of bundling `dist/` (auth + version-pinning reasons are real).
- Claim verification is unusually accurate: `/api/inbox`, `/api/tts/prepare`, `call-note`, `/vad/*.onnx` and `.wasm` genuinely absent from `BROWSER_ALLOWED`; `no-store` genuinely overrides upstream image caching (`browser.ts:1379`); instant hash death on renewal; `MAX_DEVICES=20`; `screens=off` and `messages=0` already exist; the 20 px hover-only Remove button (`ComposerAttachments.tsx:235`); infinite 401 retry; opt-in `powerSaveBlocker` (`main.mjs:944`); the `; wv)` in-app-browser trap (`browser.ts:801`); ~5 MB raw bundle (5,072,957 B in the reference dist).
- Content-free push + phone-side detail fetch is the right privacy shape, and the relay's fixed alert strings confirm feasibility.
- Step-up for risky approvals, first-decision-wins idempotency bound to request/device/expiry, and `.authenticationRequired` are correct platform usage.
- Build order ships host fixes first, helping every remote browser before the app exists; V1/V1.1 split (esp. deferring background-audio calls, which genuinely can't be done in the web layer) is sound.

> build · moonshotai/kimi-k3

→ Read app/docs/superpowers/specs/2026-09-25-murage-mobile-design.md

$ ls /Volumes/Fixture/workspace/muragemobile/
app
audit-20260916
build-audit-20260916
BUILD-CROSS-AUDIT.md
build-execution
BUILD-PLAN.md
CROSS-AUDIT.md
ijfw
implementation
integration-20260922
MOBILE-PLAN.md
MOBILE-PROPOSAL.md
output
research
RESEARCH-RECORD.md
SOURCE-EVIDENCE.md
SOURCE-IDENTITY.json

$ ls /Volumes/Fixture/workspace/muragemobile/app/ && echo "---" && ls /Volumes/Fixture/workspace/muragemobile/app/companion/src/ 2>/dev/null && echo "---" && ls /Volumes/Fixture/workspace/muragemobile/integration-20260922/ 2>/dev/null
AGENTS.md
apps
bot-library
brand
build
cloudflare
CODE_OF_CONDUCT.md
companion
CONTRIBUTING.md
docs
electron
electron-builder.yml
ember-rename.sh
ijfw
index.html
installer
LANE-CARDS-NEEDS.md
LANE-CHANNELS-NEEDS.md
LANE-CHANNELS-UI-NEEDS.md
LANE-FIXES-NEEDS.md
LANE-SERVER-NEEDS.md
LANE-SHELL-NEEDS.md
library
LICENSE
LICENSES
mascot-preview.html
native
NOTICE
package.json
playwright.config.ts
playwright.first-run.config.ts
pnpm-lock.yaml
pnpm-workspace.yaml
public
README.md
rebrand.sh
scripts
SECURITY.md
server
shared
skills
skills-library
src
third_party
tsconfig.companion.build.json
tsconfig.json
tsconfig.server.build.json
tsconfig.server.json
vite.config.ts
---
advertise-watch.ts
browser.ts
connected-devices.ts
control.ts
devices.ts
door-identity.ts
endpoints.ts
index.ts
listener.ts
mdns.ts
origin.ts
proxy.ts
routes.ts
state.ts
wire.ts
---
AGENTS.md
apps
bot-library
brand
build
cloudflare
CODE_OF_CONDUCT.md
companion
CONTRIBUTING.md
dist
dist-companion
dist-server
docs
electron
electron-builder.yml
ember-rename.sh
index.html
installer
LANE-CARDS-NEEDS.md
LANE-CHANNELS-NEEDS.md
LANE-CHANNELS-UI-NEEDS.md
LANE-FIXES-NEEDS.md
LANE-SERVER-NEEDS.md
LANE-SHELL-NEEDS.md
library
LICENSE
mascot-preview.html
native
node_modules
NOTICE
package.json
playwright.config.ts
playwright.first-run.config.ts
pnpm-lock.yaml
pnpm-workspace.yaml
public
README.md
rebrand.sh
scripts
SECURITY.md
server
shared
skills
skills-library
src
third_party
tsconfig.companion.build.json
tsconfig.json
tsconfig.server.build.json
tsconfig.server.json
tsconfig.tsbuildinfo
vite.config.ts

$ cd /Volumes/Fixture/workspace/muragemobile/app && git log --oneline -5 2>/dev/null; git branch -a 2>/dev/null | head -20; git status 2>/dev/null | head -5
139a546d docs(mobile): design spec for the Murage phone app
a1144813 fix(stop line): a here-doc body is the command's input, not more commands
a6612666 fix(prompt): the clock rides the message, never the system prompt
0601e6b0 fix(permissions): say when a bot's engine cannot ask, on the levels where that costs it commands
f6bc2070 fix(pi): ask Murage before pi runs commands, edits outside its folder, or connected-app calls
+ build/0158-win-20260922
  chore/cua-driver-0.28.2-20260918
  chore/fuigo-1.0.8
  ci/linux-human-suite-sharding-20260918
  codex/0150-recovery-snapshot
  codex/0150-recovery-transport
  codex/0150-recovery-uac
  codex/murage-reliability
  feat/0158-acp-codex-20260921
  feat/0158-bounded-20260921
  feat/0158-box-20260921
  feat/0158-context-vps-20260921
  feat/0158-images-20260921
  feat/0158-policy-20260921
+ feat/0158-routines-20260921
  feat/0158-small-20260921
  feat/0158-spec-w16-20260921
  feat/0158-w16-all-20260922
  feat/0158-w16-chief-20260921
  feat/0158-w16-cleanup-20260921
On branch mobile/v1
Your branch and 'next/0160' have diverged,
and have 1 and 22 different commits each, respectively.
  (use "git pull" if you want to integrate the remote branch with yours)

→ Read app/companion/src/browser.ts
→ Read app/companion/src/routes.ts

$ cd /Volumes/Fixture/workspace/muragemobile/app && wc -l companion/src/devices.ts companion/src/proxy.ts server/index.ts src/state/store.tsx src/lib/live-events.ts src/mermaid-frame/* 2>/dev/null; ls src/mermaid-frame/ 2>/dev/null
1046 companion/src/devices.ts
     752 companion/src/proxy.ts
   16996 server/index.ts
    3144 src/state/store.tsx
     539 src/lib/live-events.ts
      20 src/mermaid-frame/frame-page.test.ts
     137 src/mermaid-frame/frame.ts
      39 src/mermaid-frame/protocol.test.ts
      74 src/mermaid-frame/protocol.ts
   22747 total
frame-page.test.ts
frame.ts
protocol.test.ts
protocol.ts

✱ Grep "renewSession|sessionHash|previousHash|grace" in app/companion/src/devices.ts · 7 matches
→ Read app/companion/src/devices.ts [offset=180, limit=260]
→ Read app/companion/src/devices.ts [limit=130, offset=900]
✱ Grep "function notify|const notify|notify\(|sse-visibility|requestSurface" in app/server/index.ts · 64 matches
→ Read app/companion/src/browser.ts [offset=1073, limit=420]
→ Read app/companion/src/browser.ts [limit=240, offset=1493]
→ Read app/server/index.ts [limit=80, offset=3490]

$ cd /Volumes/Fixture/workspace/muragemobile/app && ls -la dist/assets/ 2>/dev/null | sort -k5 -n -r | head -8; echo "---mermaid---"; ls -la dist/mermaid-frame.html public/mermaid-frame.html 2>/dev/null; find . -maxdepth 3 -name "mermaid-frame.html" -not -path "*/node_modules/*" 2>/dev/null | head; echo "---integration ref---"; ls integration-20260922/apps/ 2>/dev/null; ls /Volumes/Fixture/workspace/muragemobile/integration-20260922/apps/ 2>/dev/null
---mermaid---
---integration ref---
docs
mobile

✱ Grep "openNotificationTarget|focusMessage" in app/src/state/store.tsx · 16 matches
→ Read app/src/state/store.tsx [limit=70, offset=960]

$ cd /Volumes/Fixture/workspace/muragemobile/app && ls -la dist/assets 2>/dev/null | head -3; du -sh dist 2>/dev/null; echo "---vite manualChunks---"; grep -n "manualChunks\|lazy\|React.lazy" vite.config.ts 2>/dev/null | head; echo "---find built index js---"; find . -maxdepth 4 -path "*/dist/assets/index-*.js" -not -path "*/node_modules/*" 2>/dev/null | head -3
---vite manualChunks---
8:  // murageRenderPlugins: the sandboxed diagram frame page, and the lazy
---find built index js---

$ cd /Volumes/Fixture/workspace/muragemobile/integration-20260922 && ls -la dist/assets/ 2>/dev/null | sort -k5 -n -r | head -6; echo "---mermaid frame---"; ls -la dist/mermaid-frame.html 2>/dev/null; echo "---apps/mobile---"; ls apps/mobile/ 2>/dev/null; echo "---cloudflare mobile-notification---"; ls cloudflare/control-plane/src/ 2>/dev/null | grep -i mobile; echo "---server mobile-notification---"; ls server/ | grep -i mobile; echo "---shared---"; ls shared/ | grep -i mobile
-rw-r--r--@   1 fixtureuser  staff  5072957 Sep 22 23:00 index-WAaSe_3c.js
-rw-r--r--@   1 fixtureuser  staff   790007 Sep 22 23:00 emacs-lisp-C_m_b--Z.js
-rw-r--r--@   1 fixtureuser  staff   785490 Sep 22 23:00 cpp-BMRokrvK.js
-rw-r--r--@   1 fixtureuser  staff   622336 Sep 22 23:00 wasm-CG6Dc4jp.js
-rw-r--r--@   1 fixtureuser  staff   262391 Sep 22 23:00 wolfram-lXgVvXCa.js
-rw-r--r--@   1 fixtureuser  staff   198044 Sep 22 23:00 index-Bucd-t0d.js
---mermaid frame---
---apps/mobile---
android
capacitor.config.ts
demo
DESIGN.md
dist
dist-demo
icon-assets-manifest.json
index.html
ios
node_modules
package.json
public
scripts
src
tsconfig.json
vite.config.ts
---cloudflare mobile-notification---
mobile-notification-providers.ts
mobile-notifications.ts
---server mobile-notification---
mobile-documents.test.ts
mobile-documents.ts
mobile-notification-host.test.ts
mobile-notification-host.ts
mobile-notification-outbox.test.ts
mobile-notification-outbox.ts
mobile-notification-publisher.test.ts
mobile-notification-publisher.ts
mobile-notification-storage.ts
mobile-thread-history.test.ts
---shared---
mobile-contract.ts
mobile-notification-vectors.ts
mobile-notifications.test.ts
mobile-notifications.ts

$ cd /Volumes/Fixture/workspace/muragemobile/integration-20260922 && find . -maxdepth 4 -name "*mermaid*" -not -path "*/node_modules/*" 2>/dev/null | head; echo "---"; ls cloudflare/control-plane/ 2>/dev/null; echo "---migrations---"; find cloudflare -name "0007*" 2>/dev/null | head -3; echo "---wc relay---"; wc -l cloudflare/control-plane/src/mobile-notifications.ts cloudflare/control-plane/src/mobile-notification-providers.ts server/mobile-notification-outbox.ts server/mobile-notification-host.ts server/mobile-notification-publisher.ts shared/mobile-notifications.ts 2>/dev/null
./dist/assets/mermaid-CQcHuHx7.js
./bot-library/builtins/beautiful-mermaid.json
./third_party/fuigo/vendor-notices/mermaid-to-svg
---
migrations
node_modules
package.json
README.md
src
test
tsconfig.json
vitest.config.ts
worker-configuration.d.ts
wrangler.jsonc
---migrations---
cloudflare/control-plane/migrations/0007_mobile_notifications.sql
---wc relay---
     253 cloudflare/control-plane/src/mobile-notifications.ts
     165 cloudflare/control-plane/src/mobile-notification-providers.ts
     134 server/mobile-notification-outbox.ts
      70 server/mobile-notification-host.ts
      78 server/mobile-notification-publisher.ts
      34 shared/mobile-notifications.ts
     734 total

$ cd /Volumes/Fixture/workspace/muragemobile/app && cat vite.config.ts | head -60; echo "===frame.ts==="; head -40 src/mermaid-frame/frame.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { murageRenderPlugins } from "./scripts/vite-render-plugin";

export default defineConfig({
  // murageRenderPlugins: the sandboxed diagram frame page, and the lazy
  // katex/mermaid/dompurify imports that fall back to source when missing
  plugins: [react(), tailwindcss(), murageRenderPlugins()],
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "shared/**/*.test.ts",
      "companion/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(process.env.MURAGE_UI_PORT) || 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.MURAGE_PORT || process.env.MURAGEBOX_PORT || 8799}`,
      },
    },
  },
});
===frame.ts===
// The diagram frame's own script. It runs only inside /mermaid-frame.html,
// which the app loads in <iframe sandbox="allow-scripts"> (no
// allow-same-origin), so this document has an opaque origin: no app DOM, no
// cookies, no storage, no desktop bridge. The page's CSP allows this one
// inline script (by hash), inline styles for mermaid's SVG, data: images and
// nothing else — no network at all.
//
// What it does: wait for a render request from the app, draw it with mermaid
// at securityLevel "strict" with HTML labels off, sanitize the SVG with
// DOMPurify, put it in the page and report the page's height. Errors are
// reported as one of four fixed words, never as text from the diagram.
//
// Built by scripts/vite-render-plugin.ts into a classic inline script (a
// module script from an opaque origin would need CORS on every chunk).
import {
  FRAME_RENDER_TIMEOUT_MS,
  MAX_DIAGRAM_SOURCE,
  parseRenderRequest,
  type FrameFailure,
  type FrameMessage,
  type RenderRequest,
} from "./protocol";

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}
interface PurifyApi {
  sanitize(dirty: string, config: Record<string, unknown>): DocumentFragment;
  addHook(name: string, hook: (node: Element) => void): void;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

let libraries: Promise<{ mermaid: MermaidApi; purify: PurifyApi } | null> | undefined;
function load() {
  libraries ??= Promise.all([
    // @ts-ignore -- optional until the package is installed; see vite-render-plugin
    import("mermaid"),
    // @ts-ignore -- optional until the package is installed; see vite-render-plugin

→ Read integration-20260922/cloudflare/control-plane/src/mobile-notifications.ts
→ Read integration-20260922/server/mobile-notification-outbox.ts
→ Read app/src/lib/live-events.ts [limit=120]

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -rn "setInterval" src/components/Inbox*.tsx src/components/SidebarPhoneButton*.tsx src/components/ComputerPanel*.tsx 2>/dev/null | head -12; echo "---settings pollers---"; grep -rn "setInterval" src/components/settings/ 2>/dev/null | head -8; echo "---inbox poll---"; grep -rn "5000\|5_000\|15000\|15_000" src/components/Inbox*.tsx src/components/SidebarPhoneButton*.tsx 2>/dev/null | head -8
src/components/Inbox.tsx:244:    const timer = window.setInterval(() => setRevision(current => current + 1), 5000);
src/components/SidebarPhoneButton.tsx:146:    const timer = window.setInterval(() => void refresh(), SIDEBAR_PHONE_POLL_MS);
src/components/ComputerPanel.tsx:606:    const timer = setInterval(shoot, bot.busy ? 4000 : 30_000);
src/components/ComputerPanel.tsx:632:    const timer = window.setInterval(() => void shoot(), bot.busy ? 3000 : 30_000);
src/components/ComputerPanel.tsx:660:    const timer = setInterval(shoot, bot.busy ? 3000 : 30_000);
---settings pollers---
---inbox poll---
src/components/Inbox.tsx:244:    const timer = window.setInterval(() => setRevision(current => current + 1), 5000);
src/components/SidebarPhoneButton.tsx:10:const SIDEBAR_PHONE_POLL_MS = 15_000;

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "api/inbox\|tts/prepare\|call-note\|/vad/" server/index.ts | head -20; echo "---powerSaveBlocker---"; grep -rn "powerSaveBlocker" electron/ --include="*.mjs" --include="*.ts" -l 2>/dev/null | head -3; echo "---verify-omb---"; grep -rn "verify-omb\|fake-engine" playwright.config.ts docs/verification/README.md 2>/dev/null | head -6
67:import { CALL_NOTE_PATH, handleCallNoteRoute } from "./voice/call-note.ts";
10367:    if ((method === "GET" && path === "/api/inbox") || (method === "POST" && path === "/api/inbox/state")) {
10388:      const result = inboxRequest(database(), { method: "GET", path: "/api/inbox", query: { view: "decisions", page: 0, pageSize: TRAY_ITEM_LIMIT } }, { owner: true, threads });
16460:    if (method === "POST" && path === "/api/tts/prepare") {
16539:          const result = inboxRequest(database(), { method: "GET", path: "/api/inbox", query: { view: "decisions", page: 0, pageSize: 10 } }, { owner: true, threads });
16549:    // (server/voice/call-note.ts). Built from the call's own log, no model.
---powerSaveBlocker---
electron/main.mjs
---verify-omb---

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "applyNotificationPreferences\|quietHours\|quiet" server/*.ts | head -10; echo "---presence---"; grep -n "presence\|lastActive\|userActive\|visibilityState" server/index.ts server/sse-visibility.ts 2>/dev/null | head -10; echo "---vad route---"; grep -n "vad" server/index.ts | head -6
server/approval-notification-state.ts:3:import {applyNotificationPreferences} from "../shared/notification-preferences.ts";
server/approval-notification-state.ts:15: const allowed=applyNotificationPreferences(notification,preferences,now);if(!allowed)return null;
server/auto-approve.ts:26:// bot reading your keys is quiet, permanent, and unrecoverable.
server/auto-approve.ts:394:  // stop line above and the key guard: a bot reading your keys is quiet,
server/avatar-image.test.ts:204:  it("does not quietly move the bill when Flux merely breaks", async () => {
server/avatar-image.ts:180: * provider blip should surface, not quietly move someone's billing to their
server/branching.test.ts:245:      // the thread is truly quiet enough to edit
server/browser-engine.ts:240:    // after each minute of quiet. Closing the session never closes Chrome.
server/browser-lock.ts:6:// prompt still promised one, and bots quietly reached for other browsers. Each
server/browser-unavailable-turn-api.test.ts:9:// is absent this turn, and the conversation carries one quiet note — never
---presence---
server/index.ts:9297:    // Flux Router: presence only. The key is workspace-scoped and must never
server/sse-visibility.ts:150: *     way out with a forged `?surface=desktop` either. Read as presence, not
---vad route---

$ cd /Volumes/Fixture/workspace/muragemobile/integration-20260922 && cat apps/mobile/package.json | grep -A3 -B1 "capacitor"; echo "---contract doc---"; ls docs/mobile/ 2>/dev/null; wc -l docs/mobile/notifications-contract.md 2>/dev/null
"dependencies": {
    "@capacitor/core": "8.5.2",
    "@capacitor/ios": "8.5.2",
    "@capacitor/android": "8.5.2",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "lucide-react": "^0.539.0",
--
  "devDependencies": {
    "@capacitor/cli": "8.5.2",
    "@types/react": "^19.1.9",
    "@types/react-dom": "^19.1.7",
    "@vitejs/plugin-react": "^4.7.0",
---contract doc---
AUDIT.md
EXECUTION.md
headless-native-acceptance.md
notifications-contract.md
protocol-draft.md
README.md
verification
      45 docs/mobile/notifications-contract.md

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -rn "vad" server/index.ts src/lib/ --include="*.ts" -il | head; echo "---silero/onnx paths---"; grep -rn "silero\|onnx" server/index.ts | head -6; grep -rn "vad" src/ -l 2>/dev/null | head -5; echo "---public vad---"; ls public/ 2>/dev/null | head -20; find public -name "*.onnx" -o -name "*vad*" 2>/dev/null | head -5
src/lib/call-mic.ts
src/lib/silero-vad.ts
---silero/onnx paths---
src/locales/pt-br.json
src/locales/es.json
src/lib/call-mic.ts
src/lib/silero-vad.ts
src/e2e/silero-vad.human.spec.ts
---public vad---
app-icon.svg
favicon.ico
icons
manifest.webmanifest
murage-logo-dark.png
murage-logo.png
sw.js
vad
public/vad
public/vad/silero_vad.onnx

$ cd /Volumes/Fixture/workspace/muragemobile/app && head -60 shared/notification-preferences.ts 2>/dev/null; echo "===visible/activity reporting==="; grep -rn "reportVisibility\|active-view\|notifySuppress\|suppression" server/ src/lib/ --include="*.ts" -l 2>/dev/null | head -5
import { z } from "zod";

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z.string().min(1).max(100).refine(value => {
  if (value.trim() !== value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}, "Choose a valid time zone");
export const notificationPreferencesSchema = z.object({
  attention: z.boolean().default(true), completion: z.boolean().default(true), failures: z.boolean().default(true), previewContent: z.boolean().default(true),
  quietHours: z.object({ enabled: z.boolean(), start: clockTime, end: clockTime, timeZone }).strict()
    .refine(value => value.start !== value.end, "Quiet hours must have different start and end times").optional(),
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export function resolveNotificationPreferences(value?: unknown): NotificationPreferences {
  return notificationPreferencesSchema.parse(value === undefined ? {} : value);
}
export interface PreferenceNotification {
  kind: "approval" | "question" | "takeover" | "done" | "routine-failed" | "turn-failed";
  botId: string;
  threadId: string;
  title: string;
  body: string;
  botName?: string;
  avatarUrl?: string;
  privatePreview?: boolean;
  requestId?: string;
  messageId?: string;
  requestTurnId?: string;
}
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
/** A pure delivery filter: suppression does not queue work, replay alerts,
 * approve a request, or affect the conversation's own pending cards. */
export function applyNotificationPreferences<T extends PreferenceNotification>(notification: T, currentPrefs: unknown, now: Date): T | null {
  const prefs = resolveNotificationPreferences(currentPrefs);
  const category = notification.kind === "done" ? "completion"
    : notification.kind === "routine-failed" || notification.kind === "turn-failed" ? "failures" : "attention";
  if (!prefs[category]) return null;
  const quiet = prefs.quietHours;
  if (quiet?.enabled) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
    const current = Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
    const start = minutes(quiet.start), end = minutes(quiet.end);
    if (start < end ? current >= start && current < end : current >= start || current < end) return null;
  }
  if (prefs.previewContent) return notification;
  // Construct an allowlisted frame instead of spreading unknown presentation
  // fields that could carry private details in a future notification version.
  return { kind: notification.kind, botId: notification.botId, threadId: notification.threadId,
    ...(notification.requestId ? { requestId: notification.requestId } : {}),
    ...(notification.messageId ? { messageId: notification.messageId } : {}),
    ...(notification.requestTurnId ? { requestTurnId: notification.requestTurnId } : {}),
    botName: "", title: "Murage", body: category === "attention" ? "Your attention is needed."
      : category === "completion" ? "A task has finished." : "A task needs review after a failure.",
    privatePreview: true } as T;
}
===visible/activity reporting===
server/inbox.ts

→ Read integration-20260922/server/mobile-notification-host.ts
→ Read integration-20260922/shared/mobile-notifications.ts

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "activity\|visible\|presence" server/inbox.ts | head -10; echo "---notifications.ts type---"; grep -n "interface Notification\|type Notification" server/notify.ts 2>/dev/null | head -3; ls server/notify.ts 2>/dev/null
56:      WHEN 'activity' THEN CASE
86:      WHEN 'activity' THEN CASE
103:    -- An 'activity' row that is a missing login or an unfinished setup is a
109:      WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.tool.authRequired')=1 OR json_extract(m.json,'$.tool.setup')=1 THEN 'connection' ELSE 'routine' END
114:    AND m.kind IN ('options','secret','connector','routine.run','goal.run','activity','text')
121:      WHEN 'activity' THEN json_extract(m.json,'$.tool.ok')=0 AND (json_extract(m.json,'$.tool.setup')=1 OR json_extract(m.json,'$.tool.authRequired')=1 OR json_type(m.json,'$.tool.providerError')='object')
161:    --   An ENGINE THAT IS NOT SIGNED IN arrives as a failed activity. It
234:  const kind = row.kind === "options" ? "request" : row.kind === "secret" || row.kind === "connector" ? "connection" : row.kind === "activity" ? "error" : row.kind === "routine.run" ? "routine" : row.kind === "text" ? "artifact" : "goal";
303:  // Counts describe the visible page's filter, not hidden audiences. Reading
313:  // reading, and then the one he could act on is invisible inside it.
---notifications.ts type---
20:export interface Notification {
server/notify.ts

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "screens\b\|screens=" server/index.ts | head -8; echo "---heartbeat/ping interval---"; grep -n "ping\|heartbeat\|KEEPALIVE\|keepAlive" server/sse*.ts server/index.ts 2>/dev/null | grep -i "interval\|ms\|_MS\|000" | head -8; echo "---hash routing in src---"; grep -rn "location.hash\|#open=" src/ --include="*.tsx" --include="*.ts" -l 2>/dev/null | head -5
2971:  screens: boolean;
3025:  if (entry.kind === "screen" && !client.screens) return false;
5648:      // The broker arbitrates actual host actions; private screens and other
11853:        screens: url.searchParams.get("screens") !== "off",
---heartbeat/ping interval---
server/sse-scope.e2e.test.ts:9:// Two streams on one harness: the renderer's, which opts out of scoping with
server/index.ts:6947:// after the user confirms a durable card. Keeping this beside the scheduler
---hash routing in src---

$ cd /Volumes/Fixture/workspace/muragemobile/app && sed -n '225,245p' src/components/ComposerAttachments.tsx; echo "---offline banner---"; grep -rn "offline\|Offline" src/components/ConnectionBanner*.tsx src/components/*Banner*.tsx 2>/dev/null | head -8; ls src/components/ | grep -i "banner\|offline\|connection" | head
<Icon size={11} className="text-ink-secondary/70" />
        <span className="rounded border border-hairline/60 px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-secondary">
          {label}
        </span>
      </div>
      {/* hover reveals it, but so must focus: `hidden` would take the only
          way to drop a chip out of reach of the keyboard */}
      <button
        onClick={onRemove}
        aria-label={`Remove ${label === "PASTED" ? "pasted text" : "file"}`}
        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}
---offline banner---
zsh:1: no matches found: src/components/ConnectionBanner*.tsx
ConnectionDetail.test.ts
ConnectionDetail.tsx
FluxRouterConnection.test.ts
FluxRouterConnection.tsx
ServerLifecycleBanner.test.ts
ServerLifecycleBanner.tsx
UpdateBanner.test.ts
UpdateBanner.tsx

→ Read integration-20260922/cloudflare/control-plane/src/mobile-notification-providers.ts

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "401\|status" src/lib/live-events.ts | head -12; echo "---reconnect wording---"; grep -rn "reconnect\|Reconnect\|lost connection\|Lost connection" src/components/*.tsx src/App*.tsx 2>/dev/null | grep -iv test | head -8
160:      secretRetryable = res.ok || (res.status !== 403 && res.status !== 404);
---reconnect wording---
src/components/AndroidDevicePanel.tsx:231:            : `The phone is ${selected.state}. Reconnect the USB cable and keep USB debugging enabled.`}
src/components/DiscordSettings.tsx:30:  if (status.state === "retry") return "Connection saved · reconnecting";
src/components/DiscordSettings.tsx:47:    "retry-limit": "Automatic reconnect attempts stopped. Check your connection and Discord app access, then retry.",
src/components/DiscordSettings.tsx:52:    "gateway-reconnecting": "The saved connection is reconnecting. Pairing is preserved; do not resend a task until you have checked its result.",
src/components/DiscordSettings.tsx:89:          resume: "Reconnect could not complete. Check your connection and Discord app access, then refresh status.",
src/components/DiscordSettings.tsx:164:      {canRetry && <button type="button" className={buttonClass} disabled={Boolean(busy) || status?.busy} onClick={() => void run("resume", async expected => { await api("/api/discord/resume", { method: "POST", body: "{}" }); await refresh(expected); })}>{busy === "resume" ? "Reconnecting…" : "Retry connection"}</button>}
src/components/Inbox.tsx:73:  connections: "Something needs your hands. A login has gone, and no amount of waiting brings it back. Anything depending on it is stopped until you reconnect it.",
src/components/Inbox.tsx:112:  if (routine.cause === "connection") return "Stopped, needs reconnecting";

$ cd /Volumes/Fixture/workspace/muragemobile/integration-20260922 && head -80 apps/mobile/DESIGN.md 2>/dev/null; echo "===contract==="; head -30 shared/mobile-contract.ts 2>/dev/null; echo "===native transport size==="; find apps/mobile/src -name "*ransport*" -o -name "*sse*" 2>/dev/null | head; wc -l apps/mobile/src/**/*.ts 2>/dev/null | tail -3
# Murage mobile: one shared interface

Sean clarified on 22 September 2026 that Capacitor must wrap the existing Murage
web interface, not maintain a parallel mobile chat UI. The active entry mounts
src/App.tsx with its existing Sidebar, ChatView, GroupView, Composer, settings,
questions and rendering. Responsive behavior and visual tokens belong to those
shared components and src/styles.css. Do not recreate them under apps/mobile.

The native shell owns only launch branding, first connection, workspace selection,
secure credentials/storage, platform transport, notifications and device media.
Workspaces and notifications are reached from the existing shared sidebar.
Unpaired users have a clear Connect action and the retained QR-first pairing flow.
The native splash waits for real readiness, with no artificial minimum duration.

Shared APIs use the explicit platform-runtime adapter. Browser/Electron defaults
remain unchanged; native sessions are bound to one verified profile and switching
reloads the page to discard caches. Native credentials never enter JavaScript.
Shared drafts use protected, workspace-scoped native storage. Files and documents
use the native media adapter inside shared components.

Sean explicitly approved matching the existing paired-web API permissions while
retaining desktop-only administration restrictions. Route/body/capability gates
remain authoritative; sharing UI does not bypass them. Voice representation is
limited to the approved transcription and TTS routes and byte caps.

Evidence and all inherited attempt limits live in ../RESEARCH-RECORD.md relative
to the checkout root. Current Android Share qualification is unresolved after a
system IntentResolver ANR; do not replace it with an older APK's passing receipt.
===contract===
/** Frozen private mobile v1 wire contract. No credentials belong in URLs. */
export interface MobileInvitation {
  version: 1;
  installationId: string;
  publicKey: string;
  origin: string;
  name: string;
  expiresAt: number;
  token: string;
}
export interface MobileIdentityResponse {
  version: 1;
  installationId: string;
  publicKey: string;
  origin: string;
  nonce: string;
  issuedAt: number;
  signature: string;
}
export const MOBILE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MOBILE_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// DER SubjectPublicKeyInfo for Ed25519 has this fixed algorithm prefix.
export const MOBILE_PUBLIC_KEY = /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
export function privateMobileOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 300) throw new Error("invalid private HTTPS origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid private HTTPS origin"); }
  if (url.protocol !== "https:" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/.test(url.hostname)
    || value !== url.origin || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid private HTTPS origin");
===native transport size===
apps/mobile/src/transport.ts
       1 apps/mobile/src/vite-env.d.ts
      47 apps/mobile/src/workspace-storage.ts
    1011 total

$ cd /Volumes/Fixture/workspace/muragemobile/integration-20260922 && ls apps/mobile/src/ && wc -l apps/mobile/src/transport.ts apps/mobile/src/*.ts 2>/dev/null | tail -8; echo "===git count of desktop edits on codex branch==="; cd /Volumes/Fixture/workspace/muragemobile/app && git log --oneline next/0160..HEAD -- src/ 2>/dev/null | head -3; git diff --stat next/0160...HEAD -- src/ 2>/dev/null | tail -2
appearance.ts
avatar-source.test.ts
avatar-source.ts
client.ts
ConnectWorkspace.tsx
document-receipts.test.ts
main.tsx
Markdown.tsx
model.test.ts
model.ts
native-live-events.test.ts
native-live-events.ts
native-shell.css
notifications.test.ts
notifications.ts
NotificationSettings.tsx
onboarding.test.ts
onboarding.ts
Question.tsx
shared-media.ts
shared-runtime.ts
shared-ui.css
SharedWorkspace.tsx
transport.ts
vite-env.d.ts
workspace-storage.ts
      65 apps/mobile/src/onboarding.test.ts
     146 apps/mobile/src/onboarding.ts
      25 apps/mobile/src/shared-media.ts
      63 apps/mobile/src/shared-runtime.ts
      32 apps/mobile/src/transport.ts
       1 apps/mobile/src/vite-env.d.ts
      47 apps/mobile/src/workspace-storage.ts
    1043 total
===git count of desktop edits on codex branch===

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "ping\|PING\|interval" server/index.ts | grep -i "sse\|event\|ping" | head -6; grep -n "setInterval" server/index.ts | head -12; echo "---powerSaveBlocker opt-in---"; grep -n "powerSaveBlocker" electron/main.mjs | head -5; echo "---launch mjs---"; ls /Volumes/Fixture/workspace/muragemobile/integration-20260922/scripts/ 2>/dev/null | grep -i mobile; find /Volumes/Fixture/workspace/muragemobile/integration-20260922 -maxdepth 2 -name "mobile-notification-launch.mjs" 2>/dev/null
119:import { isOwnWorkspaceBookkeeping, ownWorkspaceRoots } from "./own-workspace-approval.ts";
1224:  // Close-confirmed stop (A2): the run stays "stopping" and keeps its folder,
1340:  return run?.generation===claimId&&run.botId===botId&&run.phase!=="stopping"&&store.taskByThread(botId,threadId)?.busy===true;
2430:/** A bot as a client may see it: no provider session bookkeeping.
2432: * `resumeCursors` is the harness's own bookkeeping — the native session id
2568:  // closed for private text; with multiple overlapping guards there is no
5121:    timer: ReturnType<typeof setInterval> | null;
5160:    timer: null as ReturnType<typeof setInterval> | null,
5191:  entry.timer = setInterval(() => void entry.capture(), SCREEN_POLL_MS);
10611:        const revoked = setInterval(() => { try { active(); } catch { controller.abort(); } }, 100);
10631:        const revoked = setInterval(() => { if (!internalCapabilities.isActive(internalClaim)) controller.abort(); }, 100);
10694:        const revoked = setInterval(() => { if (!authorized()) controller.abort(); }, 100);
11841:      let keepalive: ReturnType<typeof setInterval> | undefined;
11901:      keepalive = setInterval(() => {
---powerSaveBlocker opt-in---
4:import { app, BrowserWindow, WebContentsView, clipboard, desktopCapturer, dialog, ipcMain as electronIpcMain, Menu, Notification, Tray, nativeImage, nativeTheme, powerMonitor, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from "electron";
947:    companionPowerBlocker = powerSaveBlocker.start("prevent-app-suspension");
949:    if (powerSaveBlocker.isStarted(companionPowerBlocker)) powerSaveBlocker.stop(companionPowerBlocker);
---launch mjs---
build-mobile-demo.mjs
mobile
mobile-demo.ts
package-mobile-polished-preview.py
package-mobile-shared-preview.py
start-mobile-demo.mjs
stop-mobile-demo.mjs
verify-mobile-android.mjs
verify-mobile-demo.mjs
verify-mobile-markdown-ui.mjs
verify-mobile-notification-ui.mjs
verify-mobile-owner-integration.ts
verify-mobile-parity-native.mjs
verify-mobile-polished-preview.mjs
verify-mobile-question-ui.mjs
verify-mobile-shared-android.mjs
verify-mobile-shared-ui.mjs
verify-mobile-simplification-android.mjs
verify-mobile-simplification.mjs

→ Read integration-20260922/docs/mobile/notifications-contract.md
→ Read app/server/index.ts [limit=80, offset=11840]

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "SSE_HEARTBEAT_MS" server/index.ts | head -3; grep -rn "SSE_HEARTBEAT_MS =" server/ | head -2; echo "---hydrate messages=0---"; grep -n "messages=0\|pageSize" server/index.ts | sed -n '1,6p'; echo "---WKWebView process kill handling exists?---"; grep -rn "webViewWebContentProcessDidTerminate\|contentProcess" /Volumes/Fixture/workspace/muragemobile/integration-20260922/apps/mobile/ios 2>/dev/null | head -3
2996:const configuredSseHeartbeatMs = Number(process.env.MURAGE_SSE_HEARTBEAT_MS);
2997:const SSE_HEARTBEAT_MS =
11903:      }, SSE_HEARTBEAT_MS);
server/index.ts:2997:const SSE_HEARTBEAT_MS =
---hydrate messages=0---
2890:function pageSize(raw: string | null): number | null | undefined {
10352:          page: Number(url.searchParams.get("page") ?? 0), pageSize: Number(url.searchParams.get("pageSize") ?? 25),
10374:          page: Number(url.searchParams.get("page") ?? 0), pageSize: Number(url.searchParams.get("pageSize") ?? 25), includeSnoozed: url.searchParams.get("includeSnoozed") === "true" },
10388:      const result = inboxRequest(database(), { method: "GET", path: "/api/inbox", query: { view: "decisions", page: 0, pageSize: TRAY_ITEM_LIMIT } }, { owner: true, threads });
11909:      const limit = pageSize(url.searchParams.get("messages"));
11949:      const limit = pageSize(url.searchParams.get("limit"));
---WKWebView process kill handling exists?---

→ Read app/server/index.ts [limit=14, offset=2994]

$ cd /Volumes/Fixture/workspace/muragemobile/app && sed -n '2885,2900p' server/index.ts; echo "---app Store review references in spec? already have---"; grep -rn "capacitor.config" /Volumes/Fixture/workspace/muragemobile/integration-20260922/apps/mobile/capacitor.config.ts 2>/dev/null; cat /Volumes/Fixture/workspace/muragemobile/integration-20260922/apps/mobile/capacitor.config.ts 2>/dev/null | head -40
// endpoint. Omitting the parameter returns exactly what it always did.
const MESSAGE_PAGE_MAX = 200;
const DEFAULT_PAGE = 50;

/** undefined = absent, null = present but unusable (the caller answers 400). */
function pageSize(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) return null;
  return Math.min(size, MESSAGE_PAGE_MAX);
}

/** A screen message without its pixels. The client fetches those from
 * `/api/threads/:threadId/messages/:id/image` when it actually shows one. */
function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
---app Store review references in spec? already have---
import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.murage.mobile', appName: 'Murage', webDir: 'dist',
  loggingBehavior: 'none',
  server: { androidScheme: 'https' },
  ios: { contentInset: 'never', webContentsDebuggingEnabled: false },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
};
export default config;

$ cd /Volumes/Fixture/workspace/muragemobile/integration-20260922 && ls apps/mobile/ios/ 2>/dev/null; find apps/mobile/ios -maxdepth 3 -iname "*notification*" -o -maxdepth 3 -iname "*NSE*" -o -maxdepth 3 -iname "*extension*" 2>/dev/null | head -6; echo "---android---"; ls apps/mobile/android/ 2>/dev/null | head; echo "---powerSaveBlocker setting---"; cd /Volumes/Fixture/workspace/muragemobile/app && grep -n "keepAwake\|keep-awake\|prevent-app-suspension\|companionPowerBlocker" electron/main.mjs | head -8
App
capacitor-cordova-ios-plugins
debug.xcconfig
MediaPolicyTests.swift
TransportPolicyParityTests.swift
apps/mobile/ios/App/App/NotificationSyncPolicy.swift
apps/mobile/ios/App/App/MurageNotifications.swift
apps/mobile/ios/App/App/NotificationAccount.swift
---android---
app
build
build.gradle
capacitor-cordova-android-plugins
capacitor.settings.gradle
gradle
gradle.properties
gradlew
gradlew.bat
settings.gradle
---powerSaveBlocker setting---
942:let companionPowerBlocker = null;
944:function syncCompanionKeepAwake(companionEnabled, keepAwake) {
945:  const shouldBlock = companionEnabled && keepAwake;
946:  if (shouldBlock && companionPowerBlocker === null) {
947:    companionPowerBlocker = powerSaveBlocker.start("prevent-app-suspension");
948:  } else if (!shouldBlock && companionPowerBlocker !== null) {
949:    if (powerSaveBlocker.isStarted(companionPowerBlocker)) powerSaveBlocker.stop(companionPowerBlocker);
950:    companionPowerBlocker = null;

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -rn "verify-omb\|omb" playwright.config.ts package.json docs/verification/README.md 2>/dev/null | head -6; grep -rn "fake-engine\|fakeEngine" playwright.config.ts docs/verification/README.md 2>/dev/null | head -6; ls docs/verification/ 2>/dev/null | head
0150-private-preview.md
channels.md
chat-turns.md
data-safety-probes
data-safety.md
engines.md
full-access-stops.md
installation-recovery.md
memory.md
questions.md

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -rn "murage pair\|headless" installer/ scripts/ --include="*.mjs" --include="*.ts" -l 2>/dev/null | head -4; echo "---qr terminal---"; grep -rn "qrcode-terminal\|terminal QR\|printQR" installer/ scripts/ companion/ 2>/dev/null | head -4; echo "---multiple workspaces / device per origin?---"; grep -n "workspace" companion/src/devices.ts | head -5
installer/test/sidecar.test.mjs
installer/test/start-lifecycle.test.mjs
installer/test/cli.test.mjs
installer/bin/murage.mjs
---qr terminal---
installer/lib/ui.mjs:181: * Render a URL as a terminal QR block if `qrencode` is available.
---multiple workspaces / device per origin?---

$ cd /Volumes/Fixture/workspace/muragemobile/app && grep -rn "omb" docs/verification/README.md playwright.config.ts playwright.first-run.config.ts 2>/dev/null | head -5; grep -rln "verify-omb" . --include="*.ts" --include="*.mjs" --include="*.json" --include="*.md" 2>/dev/null | grep -v node_modules | head -5; echo "---fake engine refs---"; grep -rn "fake.engine\|fakeEngine\|isolated" docs/verification/README.md 2>/dev/null | head -8
./docs/superpowers/specs/2026-09-25-murage-mobile-design.md
---fake engine refs---
docs/verification/README.md:20:harness/webhook port pair, installs only the repository's fake engine, prints



