I'll verify the key code claims behind section 12's rows. Budget: 12 calls; I've used 1. Let me check the layout and the most load-bearing references.
Verification complete (8 of 12 budget used). All spot-checked citations hold: `Bridge.java:267-269` confirms bridge injection only for `appUrl`'s origin; `companion/src/browser.ts` confirms the `; wv)` warning (~801) and credentialed 401 fallthrough (~1297); `routes.test.ts:38` confirms unknown routes (`/healthz`) → 401 on old hosts; `inbox.ts` `scope()` rejects `owner !== true`; `devices.ts` confirms rotate-on-renewal ("stolen copy dies on rotation", line ~223); `applyNotificationPreferences`/`previewContent`/quiet hours exist in `shared/notification-preferences.ts`; `approval-notification-state.ts` regenerates approval cards; `sse-visibility.ts` exists; `syncCompanionKeepAwake` at `electron/main.mjs:944`.

## 1. Section 12 — row verdicts

**Revision 2 table**

| Finding | Verdict | Reasoning |
|---|---|---|
| Astra 1,2; Kimi 6,15 (bridge/origin/frame) | RESOLVED | Verified bridge injects only into `appUrl` origin; dedicated WebView + `addWebMessageListener` exactOrigin + `isMainFrame` checks close it. |
| Astra 3,6 (ambiguous push token) | RESOLVED | Two scoped tokens, separate storage, strict routes/bodies, server-side step-up. |
| Astra 4; Kimi 3 (grace didn't heal) | RESOLVED | Commit-on-first-use generations + 7-day cap; deterministic HMAC successor kills the out-of-order race. |
| Astra 5 (Inbox refused) | RESOLVED | Verified `scope()` rejects non-owner; visibility-filtered owner-level model uses existing `sse-visibility`. |
| Astra 7; Kimi 4 (anonymous enrolment) | RESOLVED | App Attest / Play Integrity root + quotas + kill switch. |
| Astra 8; Kimi 1,2,12 (relay payloads) | RESOLVED | Data-only FCM, APNs fields, stable collapse keys, revisions. |
| Astra 9; Kimi 10 (identity/badge) | RESOLVED | `bindingId` routing, per-workspace sums, switch fencing. |
| Astra 10; Kimi 7,9 (recovery/skew) | RESOLVED | `hello()` handshake, native status handling, `onRenderProcessGone` recreate; rev3 fixed the 404→401 detail (verified). |
| Astra 11; Kimi 15 (pruning) | PARTIAL | Browser-only pruning in rev2; rev3 replaced with `installId` + explicit sign-out — but see new issue H1 (Android). |
| Astra 12; Kimi 11 (compression/heartbeat) | RESOLVED | Ordering rules stated; heartbeat untouched at 15 s. |
| Astra 13; Kimi 5 (store review/Funnel) | RESOLVED | Functional demo mode, no Funnel, privacy inventory. |
| Astra 14 (phasing) | RESOLVED | Phase 0 spike added; round-cap decline is explicitly Sean's call. |
| Kimi 8 (presence) | RESOLVED | Presence model defined with phone-clients-excluded rule. |
| Kimi 13,14 (harness; quiet hours) | RESOLVED | Verified `applyNotificationPreferences` + quietHours exist in `shared/notification-preferences.ts`. |

**Revision 3 table**

| Finding | Verdict | Reasoning |
|---|---|---|
| Android feature gating | RESOLVED | `DOCUMENT_START_SCRIPT` required + destroy/recreate matches the verified WebViewCompat pattern. |
| `/healthz` 401 vs 404 | RESOLVED | Verified: unknown routes 401 on old hosts; "any non-200 `{mobile:1}`" rule is correct. |
| Renewal race | RESOLVED | HMAC-derived idempotent successor + commit-on-first-use is sound; both concurrent renews derive the same pending. |
| Detail reads/preview privacy | RESOLVED | Binding+expiry+visibility scoping; `previewContent=false` generic titles verified in `notification-preferences.ts`. |
| Browser-only records | PARTIAL | Auto-prune removed correctly, but the replacement mechanism (installId) is incomplete on Android (H1). |
| Codex round-cap conflict | RESOLVED | Downgraded to recommendation for Sean. |

## 2. New Critical/High issues from rev 2/3

- **Critical: none found.**
- **H1 (High): Android `installId` does not survive reinstall.** Android Keystore material is wiped on uninstall, so the `installId`-replacement rule — the spec's only automatic defence against the motivating problem ("reinstalls accumulate devices, and pairing fails at 20") — works on iOS but not Android. Rev3 marks the row resolved; on Android it isn't.
- **H2 (High, design-under-specification): read-time `{title, body}` regeneration is only evidenced for approvals.** The outbox is content-free, so `GET /api/mobile/push/:eventRef` must regenerate text. `approval-notification-state.ts` covers approvals; no evidenced equivalent exists for questions or completion events, so rich text may silently degrade to generic for most categories in V1.

## 3. Verdict

**APPROVE WITH CHANGES.** Must-fix before build:

1. H1: state Android's reinstall behaviour honestly and add a fallback (backup-restored installId, or server-side stale-record replacement keyed on install name + last-seen).
2. H2: specify the read-time title/body regeneration path for question and completion categories, or scope rich text to approvals in V1.
3. Define a size/streaming strategy for `saveFile` blobs (large blob→bridge memory spikes).
4. Bind the HMAC generation counter to a monotonic store (or fold `createdAt` into the HMAC input) so backup-restore rollbacks can't re-validate retired credentials.
