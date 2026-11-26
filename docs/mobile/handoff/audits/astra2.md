Read-only review completed; no edits, builds or servers. **RESOLVED** below means resolved in the design, not runtime-verified.

| Section 12 finding | Assessment |
|---|---|
| Astra 1, 2; Kimi 6, 15 — bridge | **PARTIAL** — Dedicated WebViews and native origin/frame checks address isolation; Android’s document-start injection needs its own capability check. |
| Astra 3, 6 — action tokens | **PARTIAL** — Separate storage, strict decisions and server-side risk refusal resolve action authority; detail reads still lack explicit event/device ownership, expiry and current-visibility checks. |
| Astra 4; Kimi 3 — renewal | **PARTIAL** — Lost responses become recoverable, but fresh reissuance introduces an overlapping-response race described below. |
| Astra 5 — Inbox | **RESOLVED** — Explicit remote authorization and filtered read/write scope address both the desktop-only gate and hidden-thread exposure. |
| Astra 7; Kimi 4 — enrolment | **RESOLVED** — Attestation, binding-scoped publishing, quotas and a global kill switch address the anonymous-enrolment design finding. |
| Astra 8; Kimi 1, 2, 12 — payloads | **RESOLVED** — Platform-specific delivery, required APNs fields, stable collapse keys, revisions and binding identity are specified. |
| Astra 9; Kimi 10 — workspace/badge | **RESOLVED** — Binding-based routing, per-workspace counts and switching fences are explicit. |
| Astra 10; Kimi 7, 9 — recovery/skew | **PARTIAL** — Old hosts return **401**, not the assumed 404, to cookie-free `/healthz`; Android renderer recovery also needs recreation, not instance reuse. |
| Astra 11; Kimi 15 — pruning | **PARTIAL** — Protected devices are excluded, but browser pairing also creates `tokenHash`; the proposed discriminator cannot identify existing browser-only records. |
| Astra 12; Kimi 11 — compression/heartbeat | **RESOLVED** — Scrubbing/injection precede compression, SSE remains uncompressed, and heartbeat timing is preserved. |
| Astra 13; Kimi 5 — store/Funnel | **RESOLVED** — Functional demo, privacy inventory and isolated demo contingency preserve the private-host boundary. |
| Astra 14 — phasing | **PARTIAL** — Feasibility comes first; §8’s rejection of round limits still conflicts with the AGENTS instructions supplied for this review. |
| Kimi 8 — presence | **RESOLVED** — Heartbeat, expiry, bounded suppression and resolution bypass are defined. |
| Kimi 13, 14 — harness/preferences | **RESOLVED** — The named harness exists, and `notify()` already applies category and quiet-hours filtering. |

The compatibility and pruning findings follow directly from [browser authentication](/Volumes/Fixture/workspace/muragemobile/app/companion/src/browser.ts:1297) and [device creation](/Volumes/Fixture/workspace/muragemobile/app/companion/src/devices.ts:680).

**New High issues; no evidenced Critical issue:**

- **Android compatibility failure (§§2–3.2).** Checking `WEB_MESSAGE_LISTENER` does not authorize `addDocumentStartJavaScript`: unsupported `DOCUMENT_START_SCRIPT` throws, defeating basic-mode fallback. Separately, a terminated WebView must be destroyed and recreated. These are explicit [injection API requirements](https://developer.android.com/reference/androidx/webkit/WebViewCompat) and [renderer recovery requirements](https://developer.android.com/develop/ui/views/layout/webapps/handle-termination).
- **Renewal response race (§3.3).** Under the specified two-hash rule: A renews to B; before receiving B, A retries and gets C; C arrives, then delayed B overwrites the cookie. B is neither current C nor retained A, causing logout. Define idempotent pending issuance and throttle precedence.
- **Hidden-preview privacy regression (§§3.4–3.5).** The existing [filter](/Volumes/Fixture/workspace/muragemobile/app/shared/notification-preferences.ts:45) strips private text when `previewContent=false`. The new metadata-only outbox discards that presentation decision, while detail hydration independently restores rich lock-screen text. Enqueue-time filtering alone cannot preserve this setting.

Must-fix items:

1. Correct Android feature gating/recreation and old-host 401 fallback.
2. Make pending renewal retries safe under reordered responses.
3. Specify detail-read authorization and enforce preview privacy during hydration.
4. Define a reliable browser-only discriminator without pruning bearer-capable devices.
5. Reconcile §8’s process-policy conflict before execution.

**APPROVE WITH CHANGES.**