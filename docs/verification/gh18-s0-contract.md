# GH18 S0: frozen fresh-start contract

Base: `c12aaad9341e8f87126a193f35b5c2768f0aa66f`.
Authority: `GH18-RULING-1019.md`, with its retained parts of `DESIGN-r2.md`.
Scope: shared wire schemas/types, C2 obligations, C3 identity/copy, C4 type
signatures, and the pure P1 predicate. No route, UI, database migration, row
mutation, cursor mutation, or recovery behavior is implemented in S0.

## Consumer entry points

- `shared/gh18-fresh-start-contract.ts`: `GH18_POLICY_VERSION`, `GH18Reason`,
  `FreshStartPreviewRequest`, `FreshStartConfirmRequest`, `FreshStartPreview`,
  `FreshStartOutcome`, and matching `freshStart*Schema` parsers. All objects
  reject unknown fields. `GH18_SETTINGS` freezes the C3 identity and ruled copy.
- `server/memory/gh18-fresh-start.ts`: `FreshStartPlan` has the ruling's exact
  fields and `FreshStartPolicy` freezes the exact `planFreshStart` and
  `applyFreshStartRows` method signatures. S1 supplies those named function
  implementations in this module. S2 can type a stub as `FreshStartPolicy`
  until S1 lands. S0 deliberately supplies no callable mutation placeholder.
- `server/memory/gh18-fresh-start-predicate.ts`: `isFreshStartSessionRow(row,
  bot, deps)` selects a single database-shaped `memory_deny_session` row from
  an immutable snapshot. `deps.audienceRevokeIds` must come from
  `memory_revoke_audience`; `bot` must be the authenticated selected bot.
  It reuses `ownerAudienceSessions` (and therefore `sessionKeyOf`) unchanged.
  S1 owns bounded database collection and S2 owns authority and race fences.

P1's proof is attached to the function. Content readers already exclude these
rows; non-owner readers never resume owner-audience cursor sessions. Other
bots, shared chats, live tasks, member audiences, instances and incarnations
are excluded. All other mark tables and provenance classes remain outside P1.
The predicate alone is not permission to mutate. In particular, the operation
must block if *any* turn on the bot is live, even though P1 is row/task-scoped.

## Frozen HTTP obligations for S2

Base path `/api/memory/bots/:botId/fresh-start`:
`POST /preview {}`, `POST /confirm {previewToken, confirm:true, idempotencyKey}`,
and `GET /operations/:id` (the exact stored `FreshStartOutcome`). JSON responses
use `Cache-Control: no-store`. Preview TTL is 120 seconds, body limit 2 KiB,
token limit 512 UTF-8 bytes, key length 16–128 ASCII characters.

Authenticate the owner before bot lookup or preview; retain host/origin,
authenticated desktop and cloud owner step-up write gates. Recheck installation,
owner and bot at confirm and status read. Internal/phone/MCP/room authority,
a desktop-looking header and No limits never substitute for ownership.

Status mapping retained from DESIGN-r2: 400 validation, 401 missing auth,
403 boundary/owner/step-up refusal (preserve existing anti-enumeration 404),
404 unknown authorized bot/operation, 409 expired/stale token, changed bot or
generation, or idempotency conflict; 503 busy storage/unavailable audit.
Errors cannot be converted to a no-change result.

M2 ordering is mandatory: authenticate/authorize; look up durable
`(installation, owner, bot, idempotencyKey)`; equal canonical digest returns
the stored outcome, unequal returns 409 `idempotency-conflict`. Only an absent
record reaches token, snapshot, generation, busy, policy, mutation and audit.
Replay works after restart, token expiry/consumption or a changed snapshot.
C2's transaction and post-commit cursor recovery obligations are documented
beside `FreshStartPolicy`; this slice does not implement or verify them.

Retain DESIGN-r2's bounds: one confirm per bot, 100 ms classification CPU budget
with yields at 20 ms where possible, at most 5000 candidates, 2-second writer
wait, and at most 100 unresolved previews per owner session. Incomplete scans
block. Cursor application uses recorded values and must be idempotent; it is
not included in cleared-block counts. Reader verdicts stay unchanged, so no
door-epoch bump is authorized. All protected data and downgrade behavior remain
S1/S2/S4 acceptance obligations.

## Ambiguity resolutions

The ruling lists S0 as shared files but the task also requires P1 and C1–C4.
The smallest non-mutating extension is a separate pure predicate plus C4 types
in the prescribed future policy module. Function implementations remain S1.

The ruling does not assign a reason to ready/done: use `null`. Nothing-to-do
uses `no-change` with zero change counts; blocked outcomes have zero change
counts and a blocking reason. A ready/done result needs at least one block or
session change. `expiresAt` is Unix epoch milliseconds, consistent with other
shared contracts. All response fields shown by C1 remain required, including
the preview token/expiry in blocked and nothing-to-do previews.

`retainedBlocks` reports the LIMIT 5001 count (5001 is the overflow sentinel),
with `retainedCapped` true iff it exceeds 5000. It never claims an exact larger
count. `freshSessions` is a nonnegative safe integer; C4's recorded cursor list
and S1/S2 determine it independently of deleted-row count.

An absent optional `RepairTask.busy` means idle, matching existing keepall
behavior. A busy duplicate task entry fails closed. Thread ownership comes
from the selected bot's task list and the existing owner-direct callback;
the predicate never infers ownership from a row's revoke ID or cause.

## RED/GREEN evidence

Tests were written first and run through `it-remote.sh` in a Node 24 container
on fixture-runner. RED used explicit minimal scaffolds: all four schemas accepted
unknown input; P1 returned false. This avoids import-error-only evidence.
Observed: **9 assertion failures, 5 passes** across 14 tests. All four required
contract tests failed, as did positive P1 selection and exact-set selection.
The negative P1 tests already passed against the reject-all scaffold; they are
preservation assertions, not claimed REDs. Logs and the two scaffold snapshots
are retained in `/fixture/jobs/gh18s0/evidence/`.

GREEN command (same container wrapper, `IT_JOB=gh18s0`, prescribed `IT_W` and
`IT_ORIG`):

```sh
pnpm exec vitest run shared/gh18-fresh-start-contract.test.ts server/memory/gh18-fresh-start-predicate.test.ts shared/memory-learning-contract.test.ts shared/phone-ask-contract.test.ts server/memory/keepall-unwedge-upgrade.test.ts server/memory/keepall-repair-sliced.test.ts server/memory/keepall-fence.test.ts server/memory/session-incarnation.test.ts server/memory/deny-read.test.ts scripts/release-workflows.test.mjs --maxWorkers=2
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.server.json
pnpm exec tsc -p tools/flux-stream-conformance/tsconfig.json
```

Observed tests: **10 files, 189 tests passed**, including 14 new tests and
81 release-workflow tests. Both new files are registered in `ci/gate-tests.txt`
for all OSes. This is contract/synthetic-fixture evidence, not a packaged owner
flow or a claim that the full GH18 feature ships. All three TypeScript commands passed (combined container exit 0). The job DONE
records the post-push full-run comparison against the pinned baseline.
