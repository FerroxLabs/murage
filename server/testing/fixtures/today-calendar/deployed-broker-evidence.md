# TC-BROKER/1 deployed broker evidence — OPEN

Recorded 2026-11-10, Wave 0 / job l10btw0. No deployment or live account was contacted.

The supplied design and ruling require actual broker-owner attestation before event-adapter implementation. Neither those documents nor the supplied Today design/review artifacts contain that attestation. This file deliberately records **no verified production endpoint, source repository, revision, file manifest, provider mapping, scope, custody or retention claim**. A checked-in Worker and upstream OpenMaus source are reference material, not Flux production evidence.

The broker owner must supply a dated, reviewed, sanitized attestation identifying:

1. Actual deployment, repository, revision and exact implementation file manifest; endpoint `/v1/today-calendar/read`; contract `murage.today-calendar/1`; providerVersion `google-calendar-v3/1`.
2. Fixed account inventory / GOOGLECALENDAR_LIST_CALENDARS / GOOGLECALENDAR_EVENTS_LIST mapping, immutable account and readable-calendar proof per page, authority recheck before release, no session-default fallback; recurring expansion and moved exceptions.
3. Principal/account/calendar/window/operation/version-bound expiring page tokens; rejection of context replay, foreign/revoked accounts and unsupported versions; completion behavior.
4. Streamed bounds, disconnect cancellation, request/attempt deadlines, no hidden retry/cache/payload journal; success and error byte accounting.
5. Actual deployed OAuth scopes, provider/broker credential custody and encryption, payload logging/retention, revocation and deletion behavior. Do not include secrets, live IDs, URLs containing tokens, or real event text.
6. Reviewed replay evidence for the synthetic fixtures here (same-label A/B, A stays pinned when default switches to B, foreign/revoked/pending refusal, pagination, incompatible version, moved exceptions).

Status: **missing external prerequisite**, not unsupported_connector completion and not a fabricated signature. Wave 1B synthetic work can continue; Wave 1A event-adapter implementation and release stay blocked by the binding design until its actual owner reviews and supplies evidence. No new product decision is requested from Sean; his pre-release review remains a later release gate.

Reference reuse: strict Zod/inferred-type conventions and civil-date validation from Murage shared/app-triggers.ts; reviewed OpenMaus composio-broker-index.ts installation/session/explicit multi-account patterns to distinguish ownership from session defaults. No generic relay or HighLevel OAuth code was copied into a calendar contract. The reference does not establish a deployed Today endpoint.
