# Calendar management with an additive contract

MAIN's 2026-11-11 additive-only ruling is implemented by a separate entry point:
`createCalendarManagementHost(deps)` in
[`calendar-management.ts`](../../server/highlevel/calendar-management.ts).
Callers supplying their own host can opt in with both
`calendarManagementOperationSpec` and `calendarManagementFamilyOperations`.
The default host, registry, manifest, schemas, endpoint declarations, identity
policy, historical tests and snapshots retain their existing contracts.

The new immutable calendar rows live alongside the original rows. The separate
`blockSelector` adds optional `originalStartTime`, `originalEndTime`, and
`originalUserId`. The new block-update workflow supplies the observed interval;
its ownership lookup uses the dedicated blocked-slot route and that original
interval. The requested replacement interval remains in the reviewed wire body.
Selectors are excluded from the wire body and editable review fields. Original
callers do not acquire required fields or a new freeze/recheck side effect.

`operation-extension.ts` associates explicitly opted-in row objects with optional
support, then carries that support on the exact held request through WeakMaps.
An operation ID alone cannot opt a legacy request in. Shared implementations
consult these optional hooks for endpoint validation, draft context binding,
review references, dispatch revalidation, returned-parent identities and qualified
recovery reads. No existing signature or schema hash is replaced. Listing and
execution use the same new schema objects. Location user reads remain a private
preflight prerequisite supplied by the new resolver.

The review repairs are retained and exercised through the new entry point:

- Calendar create/update preserve `eventType` in exact wire bodies and reviews.
- Recovery preserves every provider `readEnvelope` and `recoveryEnvelope`, checks
  selected and nonselected records, and withholds identity collisions.
- Explicit assignee B supersedes observed assignee A; a reply naming A cannot
  confirm reassignment to B.
- Calendar creation makes no unbounded pre-state or recovery collection read.
  Recovery without a qualified bound remains unknown, with no reads or resends.
- Original parents and availability are rechecked after review. Maximum-length
  notes remain complete in both approval values and wire bodies.

Verification uses network-disabled test containers, fake providers and a server
launched by `launchVerificationServer` with an isolated home/data directory.
Run `scripts/highlevel-hlf4-additive-fixture.mjs` for the new entry point. It records
Doctor, all 21 operations, file journals, a withheld foreign-parent reply and
cached durable RPC replay; the launcher stops its own child and removes its data.
No live app, real account, billable resource, desktop or Mac is used.

The three legacy calendar suites are also run unchanged at base `5335e0632` and
the final tree. Their inherited failures are compared by exact test name; only
new failures are regressions. The new `calendar-additive*.test.ts` suites exercise
the opt-in contract, including real process loss before settlement, zero-resend
recovery and old-schema compatibility. Historical contract tests are not edited.

Evidence and final counts: `/work/build/afix3-hlf4/evidence/` and the
job's `DONE`. New product English: none; the existing blocked-slot title is reused.
The project memory tool is unavailable and `.ijfw/memory` is absent.
