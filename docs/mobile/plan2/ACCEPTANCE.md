# Plan 2 acceptance

Last E2E runs: 2026-09-26.
- iOS simulator: `ios-e2e.sh` at `75158ee9`.
- Android on a real phone: `android-e2e.sh` at `beb5afcf`.
- Merged with next/0160 at `9b44eccd`.

Spec §8: "done means the acceptance tests pass on real phones". Device cells stay `pending` until someone checks them on the phone.

P26 ran on Sean's **real Samsung S25 Ultra (SM-S938B, Android 16)** instead of an emulator. So the Android column is device evidence, not emulator evidence.

| Check (spec) | iOS simulator (P25) | Android phone, automated (P26, S25) | iPhone (iPhone19,7, iOS 27, hands-on 2026-09-26) | Android phone, hands-on (S25) |
|---|---|---|---|---|
| Scan the QR code to chat in under 2 minutes (§1) | typed code only (no camera) | typed code only | pass: scan → one tap on the pairing page → chat (2026-09-26) | pass: scan → one tap → chat; Back cancels the scanner cleanly (2026-09-26) |
| Typed address and code pair through /enter with installId (§3.1, A5) | pass | pass | covered by the scan pairing | covered by P26 |
| Killed and relaunched: still signed in (§9 Q2) | pass | pass | pass | pass |
| Web process / renderer dies: back in the same chat (§3.2, §7) | pass | pass (both WebViews, via CDP Page.crash) | pending | covered by P26 |
| Channel: hello lists 8 methods; subframe refused; foreign page opens outside (§2) | pass | pass | pending | covered by P26 |
| Foreign form POST never stays in the workspace (P26 F1) | pass (blocked before load) | pass (goes back to the origin) | pending | covered by P26 |
| Safe area owned as decided (Decision 1) | pass (web, 62px) | pass (native, page sees 0) | pending | covered by P26 |
| Save a generated file (§3.2) | share sheet | Downloads | pending | covered by P26 |
| Save a server file by URL, e.g. a thread export (§3.2) | not automated | not automated | pass: Export → share sheet → Files, named conversation-test-that-image | pass: Export → Downloads |
| Mic in a foreground call; file picker (§5, §3.2) | not automated | not automated | file picker + photo upload pass; call not tested (fake engine) | photo upload pass; call not tested (fake engine) |
| Deep link #open= through the pending-open path (§3.6) | pass | pass | pending | covered by P26 |
| Back leaves the app, the icon returns to the workspace (§4) | n/a | pass, including after a shortcut start (F2) | n/a | covered by P26 |
| Door down → can't-reach → Try again (§3.1, §7) | pass | pass | pending | covered by P26 |
| Tailscale off → can't-reach → Open Tailscale → back on (§8) | not possible on this Mac | not automated | pass (Open Tailscale goes via its App Store page; Tailscale has no documented URL scheme on iOS) | pending re-check with the new 'Tailscale is off' wording |
| Computer asleep (§8) | n/a | n/a | skipped: sleeping the host Mac also pauses the test driver; the wording and the door-down path are covered | skipped (same reason) |
| Session revoked → re-pair screen, never the Camera app (§3.1) | pass | pass | pending | covered by P26 |
| Sign-out deletes the session (R4) | pass (the computer answers 401) | pass | pending | covered by P26 |
| Two computers, switch with the "Switch computer" shortcut (§4) | not automated | the shortcut task path only | the shortcut opens Your computers (one computer; a second host wasn't available) | the shortcut opens Your computers (one computer) |
| Dark-mode switch doesn't reload the workspace | not automated | pass | pending | covered by P26 |
| Cold start under 3 s, warm under 1 s on 4G via DERP (§1) | n/a | n/a | not measured | launcher activity on Wi-Fi: cold p75 ~316 ms, warm p75 ~26 ms (10 runs, am start -W). Full chat-visible time on 4G/DERP not measured |

Known differences, accepted:
- Android shows a toast, not a system notification, when a server download finishes. A proper notification comes with Plan 3.
- Samsung's Google code scanner reports Back as MlKitException 13, so the app treats any exit other than a scan as a cancel once the module is installed.

Pairing with Sean's live Murage waits for a build with Plan 1 (0.1.60). Device checks pair with the isolated test host (`apps/mobile/e2e/host`).


Post-acceptance follow-up (commits 58d73543 and fde1634a): the launcher says "Tailscale is off on this phone" when the phone has no Tailscale address. On Android it offers Get Tailscale when Tailscale isn't installed. Last connected updates on every load. Installed on both phones; the Tailscale-off wording is still to be seen on device.
