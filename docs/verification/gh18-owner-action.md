# GH18 integrated owner action

This integrates S0 e252b31ed3, S1 10ca4c2631, S2 0017d30cd2 and S3
838f48a521 against 7c9ce6fe. Ruling r2's applying/save-pending state is shared
by the server and renderer. Only a durable completed outcome says "starts
fresh". Reopening a pending operation reads its status once; another failed
save or failed status request never becomes completion. Network retries reuse
the same canonical request and idempotency key.

Blocked classifications may stop before counting retained marks. Their placeholder
zero is not rendered as a measured protection count; completed checks retain their
count. Six blocked previews and a blocked terminal result are pinned RED/GREEN.

## Explicit namespace amendment to the original schema contract

The original frozen name `memory_gh18_operations` contradicts the mandatory
1.0.18 downgrade gate: that released validator rejects every unfamiliar
`memory_*` object. The original S2 implementation therefore disabled its own
production action, and its mandatory downgrade assertion failed. Both cannot
ship together unchanged.

The integration uses `gh18_operations` and `gh18_operations_pending` in the
existing application-metadata namespace. This is a deliberate internal schema
amendment, not a weakening of the old validator or a different clearing policy.
All original columns, installation/owner/bot/key binding, outcomes, and recovery
ordering remain. The audit is still in messages.db and commits atomically with
P1 deletion. There is no sidecar transaction, audit discard, clear-all, new
visibility exception or removal of protected marks. Production never created
the original incompatible table because its feature flag was false, so there
is no shipped audit to migrate. Unknown/tampered audit schema remains refused
by the new exact-shape check.

The mandatory original unknown-memory-object assertion remains. A separate
test imports the actual frozen validator (Git blob
23f5cc9c83ba009661c32c867b3503492f39d9ae) and runs its migration and validation
before and after installing the application audit, with a protected mark
retained. Backup inspection registers the exact audit objects. Explicit exports
to older application formats drop them through the existing downgrade inventory;
ordinary restarts retain them for idempotency and cursor recovery.

## Fixture evidence and limits

Use `docs/verification/README.md`; no user's installation is involved.
`server/memory-gh18-fresh-start-api.test.ts` launches the control-surface fixture
with a temporary home, data directory, selected ports and fake engine. It records
the child log path, sends an authorized replay sentinel, withdraws a generated
line, commits an operation at each crash boundary, restarts the exact fixture,
and proves durable completion and a fresh next session whose submitted payload
contains authorized replay and excludes the withdrawn bytes. The policy tests
separately prove exact P1 deletion and content/non-owner preservation.

The four constructed legacy profiles previously recovered on the baseline;
this does not establish recovery on the reporter's own installation. No
customer-installation or packaged Mac/Windows GUI qualification is claimed.

## Bot activity and dismissal regressions

Classification checks bot-wide activity before the P1 policy. The server supplies
busy state, active room admissions and direct runs, including room threads that
are outside the selected bot's tasks. Task activity uses one live-thread snapshot
for the whole classification, with that scan inside the existing CPU budget.
The real room regression first establishes an idle direct engine session, holds
a separate room turn at its fake engine's submission boundary, and requires both
preview and confirm to report `bot-busy` without clearing the direct cursor.

Escape follows the same close path as the dialog's Close button. Closing a
terminal result discards its cached request so reopening takes a new preview.
An unknown or applying result retains the canonical request for reconciliation.
The component regressions distinguish those two cases.

The crash/replay fixture observes derived-memory leases independently of the
engine's busy flag. Before its final production preview/confirm, it uses the
normal owner-interaction hold and waits for existing leases to drain. This
keeps unrelated background publication out of that strict snapshot interval;
no snapshot check, assertion, retry policy or timeout is relaxed.

## Browser acceptance and remaining package gate

The GH18 cases in `src/e2e/bot-settings.human.spec.ts` launch an isolated server,
mount the real Settings/store/layer components, and exercise 390 px and 1440 px
layouts in both palettes. Screenshots and request traces cover preview, Escape
cancellation, focus return, one primary action, applying status and a single
status read when Memory reopens. Owner-action responses in those presentation
cases are controlled fixtures. They do not claim an actual P1 deletion.

The separate real room and crash/replay API fixtures use production server
paths. Neither browser presentation evidence nor Linux fake-engine fixtures
substitute for S4's packaged Mac/Windows/Linux run, fifteen-task G9 check or
independent UX acceptance. Those gates must retain their own native receipts.

## Extended packaged acceptance

Run `node scripts/verify-gh18-linux-package.mjs --executable /absolute/murage
--out /absolute/new-evidence-directory` in an isolated Linux display container.
The artifact must carry the current production main, preload, UI and bundled
server. The output directory must be outside the checkout. No live profile,
network model or other installation is involved.

Alongside the existing exact-target clear, audit, cursor and cancellation
checks, the script stages protected and visible lines, protected memory,
a tombstone and a reachable member session. It compares the production read
predicates over the packaged app's database before and after the owner action,
for content, owner and nonowner readers. It also checks the production audience
selector excludes owner-native sessions for nonowner turns. This observation
uses the read modules from the same source as the package; it does not claim
an external messaging-service login.

The fifteen-task G9 check searches the real Settings window and opens each
concrete destination: OpenAI keys, bot engine, approvals, Gmail, quiet hours,
phone pairing, house rules, routines for a morning brief, MCP servers, browser
access, voice, backups, spending, Grok Bot migration and working folder. Each
row retains the search, target, anchor, click count and screenshot. It opens
controls without connecting accounts, spending money or changing permission
levels. `gh18-acceptance.json` retains those fifteen rows and both reader
projections; `result.json` remains false unless the whole workflow succeeds.
The broader multi-platform release and reporter-profile gates retain their
own scope; this recipe implements the accepted isolated Linux alternative.
