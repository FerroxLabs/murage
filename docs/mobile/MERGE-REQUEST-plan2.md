# Local merge request: Plan 2 (the phone app shell) into next/0160

**Branch:** `mobile/v1`; take its current tip (see the commit that last updated this file). It already contains next/0160 up to `aa23d65e`, merged cleanly with no conflicts (second re-merge, 2026-09-27). Mirror: `mobile` remote (FerroxLabs/murage-mobile).
**Ask:** merge `mobile/v1` into `next/0160` in the release lane. The mobile lane never merges back itself.

## What it adds
- **`apps/mobile/`**, a standalone package that contains:
  - iOS and Android native shells (a Capacitor launcher plus our own workspace WebView per platform);
  - pure Swift and Java cores bound by `apps/mobile/contract/*.json`;
  - the launcher UI;
  - E2E scripts and an isolated test host.
- **Web-side hooks (small):**
  - `src/lib/native-shell.ts`: native detection and the service-worker gate;
  - `src/lib/native-route.ts`: route reporting;
  - `src/components/useDeepLinks.ts`: the `#open=` deep link;
  - `src/lib/register-sw.ts`: no service worker inside the native shell;
  - `src/lib/native-contract.test.ts`: the TS oracle for the contract.
- **`.github/workflows/ci.yml`:** a new job that runs the apps/mobile typecheck and Vitest suite, added to the `required` gate. It's a two-line revert if you don't want it gating.

Plan 2 itself changed nothing under `server/`, `electron/` or the installer.

**First-run addition (2026-09-27, Sean-approved, reviewed):** small desktop and door changes. Spec: `docs/superpowers/specs/2026-09-27-mobile-first-run-design.md`.
- `companion/src/browser.ts`: `/enter` signs in by itself only for the Murage app (MurageApp/ UA plus installId); everything else still needs a tap. If the network fails, it offers Try again and the code field.
- `companion/src/devices.ts`: a code replaced by a newer one says so, with no free guesses. A security review approved it.
- `companion/src/listener.ts` and `control.ts`: read the computer's Tailscale LoginName, used only by the local desktop UI and never logged.
- `src/components/CompanionSection.tsx`, `SettingsModal.tsx` and `PhoneSetupFlow.tsx`: the Settings tab "WebUI" becomes **"Phone and other devices"**. One **Turn on** switch starts the door and asks for remote access. The QR code sits at the top, with "On your phone, sign in to Tailscale as <login>". The switch shows the real state if either half fails.

The phone's "Get your code ready" screen shows a screenshot of this page. If you change the page, run `node apps/mobile/scripts/desktop-phone-shot.mjs`; a test flags a stale image.

## Evidence
| Check | Result |
|---|---|
| apps/mobile vitest and tsc | 385/385, clean |
| Root typecheck and vite build (Hetzner, merged tip) | OK |
| Root vitest (Hetzner, merged tip `33f22d78`) | 14376 passed, 79 failed |
| Same suite on unmodified next/0160 `aa23d65e` | 14045 passed, 79 failed |
| Failures only on the merged tip | 1: `server/memory/recall-journey` B30. It is flaky and also fails on unmodified next/0160 when rerun (checked in the first re-merge). **No regression from Plan 2.** |
| Swift core (`swift test`) | 118/118 |
| Android JUnit (Hetzner) | 143/143 |
| Hands-on on real phones (2026-09-26) | iPhone (iOS 27) and Samsung S25: scan to pair, relaunch signed in, photo upload, export, Switch computer. Tailscale off/on passed on the iPhone. See docs/mobile/plan2/ACCEPTANCE.md |
| Android E2E, **real Samsung S25 Ultra** (Android 16) | 20/20 checks, passed repeatedly |
| iOS E2E, iPhone 17 Pro simulator (iOS 26.5) | 11/11 runs; the probe passed |
| Final whole-branch review | "With fixes". All fixes done; the scoped re-review found everything addressed. |

The 78 to 81 root failures are environmental on the Hetzner container: no git repo, no Chrome, timing. They exist on next/0160 as well.

## Post-acceptance addition
The launcher now says "Tailscale is off on this phone" when it is, and "Get Tailscale" when it's missing (Android). Last connected stays current. These are commits `58d73543` and `fde1634a`, reviewed and re-reviewed.

## Plan 3a addition (2026-09-27): push, host side, plus the relay (not deployed)
Tip `a8cafe37`. Plan: `docs/superpowers/plans/2026-09-27-plan-3a-push-host-and-relay.md`. Every task was reviewed, and the whole branch was reviewed on the most capable model with its fixes re-reviewed. The ledger with every ruling is `.superpowers/sdd/2026-09-27-plan-3a-push-host-and-relay/progress.md`.

**Harness (`server/`):**
- New `mobile-push-*.ts` modules:
  - store, outbox, relay client, routes, detail, respond, risk, keys and hooks;
  - plus `mobile-presence.ts`.
- **`database.ts`:** calls `initializeMobilePush`.
- **`installation-database-snapshot.ts`:** knows the new tables, and marks the push columns that older databases lack as optional.
- **`index.ts`:**
  - `notify` feeds the outbox, after the preference filter;
  - permissions get a risk rating;
  - a card patch resolves its push;
  - adds `POST /api/presence` and `/api/mobile/push/*`, behind the companion proof.
- With no `MURAGE_PUSH_RELAY_URL`, the host uses the deployed relay, `https://murage-push-relay.sean-874.workers.dev`, the same one the phones build in. The variable overrides it. `MURAGE_PUSH_RELAY_URL=off` (or anything that is not a bare https origin) turns push off: enrol and `/tokens` answer 503 `push_off`, and the page then stops asking the phone for a binding.

**Door (`companion/src`):**
- `devices.ts` keeps the scoped detail and respond tokens, stored as hashes.
- The new `push-door.ts` covers the three bearer routes. The origin-gate exemption is exactly that narrow.
- The new `push-revocations.ts` is a persistent queue.
- `browser.ts`, `routes.ts` and `index.ts` are wiring.

**Web (`src/`):** `usePresence` in `App.tsx`. A visible desktop or browser tab keeps the phones quiet, and the phone's own web view never counts.

**Shared:**
- `shared/mobile-push.ts` is the contract.
- `apps/mobile/contract/push.json` is the fixture.

**Relay:** `cloudflare/push-relay/` is a standalone Worker package with its own lockfile, and it is not part of the root build. It is **not deployed**; that happens in Plan 3b D1.

**Repo config:** `.gitignore` gains one exception, for Apple's public App Attest root certificate.

**Evidence:**
- host push, presence, snapshot, companion and shared suites: 1067/1067;
- `server/index.test.ts`: 261/261;
- relay: 129/129;
- all three `tsc` runs are clean, and the relay bundles in a wrangler dry run.
- **Root suite on Hetzner** (docs-only tip `61767f02`, the same code as `a8cafe37`) against the base before Plan 3a (`363dc8d8`): typecheck and vite build OK on both.
  - **Tip:** 14825 passed, 79 failed.
  - **Base:** 14422 passed, 79 failed.
  - **Only-on-tip failure:** one, `server/memory/testing/b34-extractor-adapter` Q03. Run alone three times, it also fails on the base 3 out of 3, so it's environmental or flaky, like the B30 case in Plan 2's run. **No regression from Plan 3a.**

## Plan 3b addition (2026-09-27): push on the phones, and the relay live
Plan: `docs/superpowers/plans/2026-09-27-plan-3b-push-native.md`. Every task was reviewed. The whole branch was reviewed on the most capable model; its fixes and one follow-up round were re-reviewed. The ledger with every ruling and parked minor is `.superpowers/sdd/2026-09-27-plan-3b-push-native/progress.md`.

**Phones (`apps/mobile/`):**
- **iOS:**
  - a Notification Service Extension fetches the real text from the paired computer;
  - App Attest enrolment;
  - Keychain tokens: detail is AfterFirstUnlock and shared with the extension, respond is WhenUnlocked;
  - lock-screen Approve, Deny and Open, with Face ID or passcode;
  - taps open the right chat;
  - reconcile when the app opens.
- **Android:**
  - an FCM data service;
  - Play Integrity enrolment;
  - Keystore-sealed tokens;
  - lock-screen actions;
  - a private tap trampoline;
  - a reconciler.
- **Both:**
  - registration never breaks a working binding. There's no enrolment while the phone is locked, the respond token is written first, and a replace is make-before-break.
  - the Swift and Java cores are held to the TS oracles by `apps/mobile/contract/*.json`.

**Host and door (small):**
- **`server/mobile-push-relay.ts`:** the default relay is the live one, `https://murage-push-relay.sean-874.workers.dev`. `MURAGE_PUSH_RELAY_URL` overrides it, and `=off` turns push off; with push off, enrol, tokens and binding answer 503 `push_off`.
- **`server/mobile-push-routes.ts`:** a redeem outage answers 503 `relay_unavailable`.
- **`companion/src/push-door.ts`:** a harness outage answers 503, never 404.
- **`src/lib/push-enrol.ts`:** the page enrols afresh only on a real `not_enrolled`, and waits after `push_off` or `relay_unavailable`.

**Relay (`cloudflare/push-relay/`):** deployed and proven on 2026-09-27. APNs accepted a push sent by the Worker. Changes since 3a:
- `redirect: "manual"`, because workerd rejects `"error"`;
- an edge rate limit ahead of D1;
- refusals log the provider's reason code and never a token.

Secrets are uploaded only with `wrangler secret bulk`. The operator page is `docs/mobile/phase3/RELAY.md`.

**Evidence:**
- **Unit and contract tests:**
  - `swift test` 209/209;
  - Android JUnit (Hetzner) 250/250, and assembleDebug OK;
  - apps/mobile vitest 580 pass. Its 5 `e2e-host-safety` failures are only the running isolated host holding `host.lock`.
  - relay 141/141.
- **Root suite on Hetzner** (typecheck and vite build OK on both):
  - **Tip `02e24969`:** 14847 passed, 80 failed.
  - **Base `a8cafe37`, Plan 3a's end:** 14825 passed, 79 failed.
  - **Only-on-tip failure:** one, `server/attachments.test.ts` "saveImage names the bytes it read with a version that changes when a reused name gets other bytes". Plan 3b doesn't touch attachments, and run alone on the tip the file passes 35/35, so it is load-related flakiness. **No regression from Plan 3b.**
- **On real phones:** the relay → APNs → iPhone path is proven. The lock-screen actions, taps, Android delivery and E1 (Sean's real Murage) are still to be run with Sean.

**Accounts touched:** Google Cloud project `murage-mobile-260927` has the Play Integrity API turned on (Sean approved it, 2026-09-27).

## Still open (not blocking the merge)
- **Remaining hands-on checks:** the new "Tailscale is off" wording on both phones; a real call (needs a real engine, not the test host's fake one); two real computers; the computer-asleep case; full chat-visible start time on 4G. iPhone builds for iOS 27 need Xcode 27, now installed side by side at /Applications/Xcode-27.0.0.app.
- **Pairing with Sean's live Murage** needs a build with Plan 1 in it (0.1.60). The live door that is running now predates the `/healthz` probe.
- **Carried to Plans 3–5:**
  - Plan 3:
    - the notification entry must be a plain Activity with no Capacitor bridge;
    - a download notification (Android shows a toast for now);
    - a door-side guard for any session-only cookie.
  - Plan 4: mic/camera permission parity.
  - Plan 5: store-submission items.
