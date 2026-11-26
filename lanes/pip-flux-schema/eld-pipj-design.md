# PIP-RETRY-JOURNAL-1018, r5 (lane PIP-FLUX-SCHEMA, Murage 1.0.18)

r5 folds in main's ruling on r4 and Astra's PASS on it (eld-pipr5-astra.md): what a used-up charge costs, a test per crash window, no unique intents, and main's six later rulings: tokenless runs settle at the byte estimate (Rule 2a, replacing the reservation text), two accurate refusal lines ("Refusal lines"), the per-bot cooldown ("Cooldown"), the purpose check for Astra ("Purpose"), receipts ("Receipts"), and the tests reworded to match.

Replaces the retry checkpoint in commit 1f672d2474 (head 42b46d0d86). Base b2588099f. The lane head is now 87a2fa974f, which already carries the fallback rule below.

r2 added main's three asks: which way uncertainty counts, every crash window as a row, a bounded boot scan. r3 answered Astra's review of r2 (eld-pipr3-astra.md). r4 answers Astra's review of r3 (eld-pipr4-astra.md: 2 Highs, 1 Medium, plus its checks): the sections "Paid calls", "Unconfirmed exit dominates", "Rule 2" and "COMMIT failure" changed.

## The problem
A Flux-routed headless turn can run twice under one learning reservation: run 1 returns a schema miss, then one retry runs (`withOneSchemaRetry`, server/drivers/headless-text-only.ts). Both runs settle once, as their sum, when the turn ends. If the process dies between the runs, or during run 2, that settlement never happens. What must still be right after restart:
1. Run 1's measured usage above the reservation is on the day and month ledgers.
2. Run 2, which may have reached the provider, counts as a call of unknown cost.
3. Nothing is counted twice, and nothing stays on the month row for good.
4. No live child or credential-bearing temp root loses its owner.

## Why the current code does not meet it
- The recovery payload lives on `f.transport.retryUsage` in reflection state, so `conclude` can clear it while a deferred settlement is pending. The month row then holds a bare marker nothing can act on.
- Only the reaper's walk of reflection attempts reads it, so with no attempt row there is no recovery and markers accumulate.
- `released++` happens in `onAdmit`, in the gate's transaction. The spawn runs before that transaction's COMMIT (server/memory/learning-send.ts:267-272), so a crash rolls the count back after the child may have started.

## The design
One self-contained record on the month ledger row, keyed by reservation id. It leaves reflection state entirely.

```
month row: retryRecords: { [reservationId]: { boot, ledgerId, tokens: {input, output}, usage: {prompt_tokens?, completion_tokens?}, estimated?: true } }
```

`estimated: true` means run 1 was a tokenless run and `usage` holds its byte estimate (Rule 2a).

Every record means: run 1 finished with this usage, and a second call may have been released.

### Rule 1: write before release
After run 1's schema miss, and before the retry's `gate.send`, `withOneSchemaRetry` calls a new extract.ts function, `journalMemoryRetry(usage | undefined)`. It is written even when run 1 reported no usage, with `usage: {}`, because the second call still needs counting.

It must really commit. If `db.isTransaction` is already true at the call, `transaction()` would only open a SAVEPOINT, so `journalMemoryRetry` refuses instead of writing.

The retry does NOT run, and `first` is returned so the schema miss stands, when any of these holds:
- the journal is refused because a transaction is open;
- the write throws (busy, disk);
- no reservation is in scope;
- the row already holds `UNSEEN_EXCESS_CALLS` records (the hard bound, see Bounds).

The retry is optional and the accounting is not.

### Rule 2: settlement removes it atomically, and keeps what it knows (Astra finding 3)
`reserveExtraction`'s `write()` deletes `retryRecords[handle.id]` in the same transaction that settles the month row, for a report and for `finish()` alike. While a settlement is deferred by a held lock the record stays, so a crash in that window is still recoverable.

Settlement must not lose known usage. Today `sumUsageReports` turns a side undefined if any run left it unreported, so run 1's known excess vanishes when run 2 reports nothing. And `engineRun: true` makes it metered, so run 2 is not counted either. Change:
- `MemoryUsageReport` gains `knownFloor?: {prompt_tokens?, completion_tokens?}` and `extraUnseen?: number`.
- `withOneSchemaRetry` tracks each run separately: whether the gate released it (`gate.released` moved across its `once()`) and whether its report had both token sides. A report holding only `replyBytes` or `engineRun` is incomplete, and so is no report at all.
- When a side's sum is undefined and some run reported that side, `sumUsageReports` sets `knownFloor` to the sum of the defined values. `write()` then adds `max(0, floor - reserved)` to that side on both ledgers, the same formula as Rule 3. The side's token field stays undefined, so existing Stop tests still hold.
- On a request with a record, `extraUnseen` is the number of released runs missing either token side. `write()` adds it to `unmetered` once, and the ordinary `usage !== null && !metered` increment does not also apply. This matches recovery: run 1 unknown and run 2 unknown is two unseen both live and after a crash.
- `withOneSchemaRetry` always reports once a record exists, even with `reports` empty, so `finish(null)` can never delete a record for a released retry with nothing counted. If the retry was never released (Stop before it, or a gate refusal), it adds nothing and the record is deleted.
- Rule 1's cap check and insert happen in the same transaction.

### Rule 2a: Flux zero or missing usage is UNKNOWN (MurageMain, 2026-11-06 ~23:15Z)

This ruling supersedes the earlier byte-estimate and empty 0/0 rules **on Flux routes only**, including historical test 29 below. Use the same route decision as schema-in-prompt: `isFluxUrl` for HTTP and `reflectionRoutesToFlux` / its `schemaInPrompt` result for Fuigo/Grok and the same predicate carried as a ledger-only flag for routed Claude. Do not introduce another detector.

Flux forces streamed usage on. `/v1/messages` reports real usage only at the final `message_delta`: `message_start` has 0/0 and cancellation can leave no final usage. `/v1/responses` emits zeros when upstream sends nothing.

Any Flux 0/0 report (including an empty answer), or wholly missing usage from a finished or cancelled released run, is UNKNOWN. Retain the held reservation on both token ledgers, add `estimatedRuns: 1`, and count exactly one unseen call for that run. Do not derive a replacement charge from bytes, read receipts or spend records, or call a provider. Real nonzero reports, including partial reports, keep their existing accounting. The trace and reported-over-limit decisions still use the provider's report.

The per-run report leaves both token fields undefined and carries `extraUnseen: 1`. The retry wrapper preserves this on a single run; for a journaled retry it counts each incomplete released run once and sums the estimate markers independently. First-report guards prevent cancellation or throwing hooks from counting twice. A retry journal stores unknown usage as `{}` with `estimated: true`; dead-boot recovery retains the reservation and counts both unknown runs by the existing Rule 3. No run released means no unknown charge.

Required regressions, each through HTTP and headless adapters: cancelled Messages with only message_start 0/0; Responses with zero usage; finished missing usage; off-Flux 0/0 controls. Assert the reservation on day and month rows, the estimate marker, and exactly one unseen for each single unknown Flux call. The first two have named mutation entries in `eld-pipmut.json`.

The following r5 text now applies **only off Flux**; no off-Flux behavior changes:

#### Off-Flux behavior retained from r5: a tokenless run settles at the byte estimate, and never pauses learning for that reason alone (main's ruling)
Evidence, source only (Fuigo headless/reducer/messages/usage.rs, read not run): `result.usage` always carries both token fields, and with no upstream usage it emits 0 with only a tracing warning. No real receipt exists for this path, because reflection on Flux has failed since at least 1.0.17 and schema-in-prompt is new in this lane. See "Receipts".

- A run is **tokenless** when it finished with a result line, and its report has neither side, or both sides 0 with `answerBytes` above 0. "Finished with a result line" means a result was parsed at any point in the run: `runHeadlessCli` keeps that evidence itself, because a stdout overflow clears `chunks` while `reportedUsage` survives, so reading only the final `parsed.result` would miss it.
- Two byte figures, because the stdout counter includes the result line itself and so is never 0 once a result was parsed. `replyBytes` is the existing stdout counter (`bytes`). `answerBytes` is the size of the accepted answer: UTF-8 bytes of the result's text, or serialized bytes of its `structured_output`, or of Claude's `StructuredOutput` tool input (`structuredCalls[0].input`, the fallback `gateRun` accepts at pip-transport.ts:734). It uses presence checks, not truthiness, keeps the last value seen before any overflow, and counts as above 0 if the overflow came first.
- A tokenless run settles at the **byte estimate**, per run and per side: `ceil(requestBytes / 3.5)` input and `ceil(replyBytes / 3.5)` output, the 3.5 rule at pip-transport.ts:759. It does not settle at the reservation. A real result line with 0/0 and an empty answer has `answerBytes` 0, so it is not tokenless and settles at 0 as today.
- One pure helper in pip-transport.ts decides this, and `runHeadlessCli` calls it at both report points (`accountUsage` and the normal end, headless-text-only.ts:153 and :237). The report it sends is `{prompt_tokens: est, completion_tokens: est, replyBytes, engineRun: true, estimatedRuns: 1}`. So the rule covers single runs and all three CLI engines, each run reports complete numbers, and nothing downstream needs a tokenless branch.
- `requestBytes` is a new `runHeadlessCli` option set by each caller: `Buffer.byteLength(prompt)` in `headlessAttempt` (schema instruction included, so each run counts its own), and the byte length of system plus text in `claudeTextOnlyTurn`.
- A retry charges both runs: `sumUsageReports` adds the two runs' numbers and `estimatedRuns`. A mix of reported and estimated adds the same way. If the other run left a side unreported, the estimate goes into `knownFloor` like any known usage (Rule 2).
- It adds 0 unseen: the report is complete, so `extraUnseen` does not count it, and `engineRun: true` keeps it metered.
- A non-zero report is unchanged, including a one-sided one. 0/0 with NO output settles as today (at 0), and a test holds that.
- **Marking.** `write()` adds `estimatedRuns` to a month-row counter of the same name, so a tokenless route can be told apart from a reported one later. Reconciliation adds 1 when a record has `estimated: true`. Nothing reads the counter for any decision.
- **Crash path.** `journalMemoryRetry` receives run 1's complete report, so a tokenless run 1 is journaled as `usage` = its estimate with `estimated: true`. Rule 3 then treats it as reported on both sides: `max(0, estimate - reserved)` is added, `open[boot]` loses 1 and `unmetered` gains 1. Net one unseen, like any crash, with no special case. The reservation stays on the rows after a crash because run 2's cost is unknown, the same as when run 1 reported real tokens.
- **Run 2 crash on the same route.** Its tokens are unknown after a crash whichever route it is, so it is the one unseen call. Two such crashes in a month pause learning, as for any route.
- The run's trace value (`onUsage`, `result.usage`) and `isReportedOverLimit` do not change: the helper feeds the ledger report only, and over-limit still reads what the CLI really reported.
- Everything else counts as Rule 2 says **on a journaled retry**: a Stop or a crash with no result line, and a one-sided report, each add one to `extraUnseen`. A **single run** with no record keeps today's behaviour for those cases: `engineRun: true` is metered, and an unreported side keeps its reservation. `extraUnseen` does not apply to it. Rule 2a changes a single run only when it is tokenless.
- `estimatedRuns` sums on its own, so it survives when the token totals become undefined. The unsent path never estimates. A run can invoke reporting twice (cancellation reports and then the outer catch does; a throwing `onUsage` hook does the same), so both first-report protections stay: `seen` in `withOneSchemaRetry` and the lease's `open` state.

What this gives at the default ceiling of 100M input and 15M output (numbers main accepted): settling at the full reservation allows 53 to 103 calls a day, the byte estimate 188 to 387, which does not starve learning short of real heavy use.

What it does not give: the estimate sees only our bytes, not what a CLI or provider adds, so spend on a tokenless route can read low. No unseen count covers that gap, so the bound at extract.ts:52-56 does not hold on such a route by itself. The same gap exists at base for engine runs that keep their reservation uncounted, and for 0/0 it is smaller than base, where the run settles at nothing. Stated in "Stated limits". The UNSEEN_EXCESS_CALLS comment gains one sentence saying so.

### Rule 3: reconcile from the ledger, not from attempts
A transaction-free helper `reconcileDeadRetries(db, monthRow)` works on an already-parsed month row. It is called with an open transaction by every caller below. For each record whose `boot` is not this process's `RESERVATION_BOOT`:
- add `max(0, reported - reserved)` per side to the record's `ledgerId` day row and to the month row (the reservation is still on both; a side not reported adds nothing);
- `unmetered += 1` on the month row, for the possible second call;
- when run 1 reported BOTH sides (a byte estimate counts, Rule 2a), subtract 1 from `open[record.boot]` and delete that key at 0, because run 1 is no longer an unknown call. When a side is missing, leave `open` alone, because then there really are two unknown calls;
- when `estimated` is true, `estimatedRuns += 1` on the month row;
- delete the record.

A missing day row is skipped and the month row is still handled. A record that does not parse to this shape is deleted and logged once, never thrown on.

Call sites:
- `reserveExtraction`'s admission transaction, on the month row being admitted, before the ceiling and `unseenExcessCalls` checks. It writes the reconciled row and every later line in that transaction uses it, never an earlier snapshot. It never calls the month scan.
- `clearUnseenExcess`, first, in the settings transaction, so a limit raise adds the tokens and then clears unseen counts.
- The boot scan below, which owns its transaction.

Records from this process's boot are never touched.

### Boot scan cost (extreme-scale rule)
`reconcileRecentMonths()` runs once per process, not per turn and not per bot. It sits in `maintainPip` BEFORE its no-bots and no-state early return, and outside the reflection-attempt loop, because an insert at pip-reflect.ts:1257 would miss the absent-attempt case. A module flag holds it to once.

It does not query by kind and does not walk the table. It builds 13 ledger ids (the current server-local month and the 12 before it) and reads each by primary key, in one short transaction per month that has records. Worst case: 13 point reads, plus one day-row read per record, at most 2 per row, so at most 39 point reads in a boot. A busy write leaves the flag unset and the next maintenance pass retries.

A record on a month older than 12 months is left alone. It affects no live figure, because admission reads only its own month.

### Rule 4: the reservation handle reaches every lease
One AsyncLocalStorage value `{settle, handle}` replaces the two stores. Every entry sets it: extraction (extract.ts:201), `groundMemoryClaim` (:403), the inference lease (:547). `captureMemoryUsage` (:104) replaces the sink and keeps the handle. Production reflection and probes use the Continuity lease.

### Removed
`RetryUsageCheckpoint`, `checkpointMemoryRetry`, `reconcileMemoryRetry`, `retryReservations`, `AttemptTransport.retryUsage`, `TransportHooks.onSchemaRetry`, `released++` in `chargePaidCall` (the ordinary `f.paidCalls` increment stays), and the `reconcileAttempt` call to it. daf1ae6c8 on dev and every shipped build have none of these, so no migration.

## Process ownership (Astra findings 1 and 2, and the earlier High)

### Fallback rule, already building in round eld2
In `withOneSchemaRetry`, fall back to `first` only when run 2 confirmed its exit and its verdict is not `uncertain-transport`. Otherwise return run 2 with the summed usage.

### Unconfirmed exit dominates (finding 1)
Line 231 can overwrite an uncertain verdict with a counted `refused/isolation` while the tree is still unconfirmed, and `conclude` would then `retryOrStop` and clear `f.transport`. Fix: in `conclude`, right after `f.isolation = result.isolation` and the `recordMiss` write, `if (!result.isolation.exited) { f.state = "uncertain-transport"; f.reason = verdict.state === "uncertain-transport" ? verdict.reason : "unconfirmed-exit"; return uncertain; }`, before any validation, retry or terminal transition, for every verdict.

HTTP routes always report `exited: true` (http-text-only.ts:36, :145), so they are unaffected. This also applies to single runs, which is the same hole and is correct for them.

With this rule a transient refusal with `exited: false` also goes through uncertain, reap, then advance, so the design has one path and no transient special case.

Probes bypass `conclude`, so the same rule goes there too (pip-reflect.ts:796 and :849). A probe with `isolation.exited` false is NOT written to `s.support[...].probe`, because `paidCallsOf` and `needsProbe` both read validated probes. The shortcut at line 849 requires `box.captured.isolation.exited`, so an unconfirmed probe falls through to `conclude`, whose guard keeps the transport and enters `uncertain-transport`. An unconfirmed probe therefore spends no cached validation and is probed again.

### COMMIT failure keeps the child (finding 2)
At headless-text-only.ts:113 the child is assigned only after `gate.send` returns. If COMMIT throws after the spawn, `MemorySendCommitFailed` lands in the catch that assumes no process, and `finish(true)` removes a live child's root. Fix: capture `spawned` inside the callback. In the catch, when `spawned` exists, take it as `child`, set `commitFailed`, install the close, error and output listeners and keep registration and `onChild` as normal, then call `stop()`. After the normal wait and `finish(exited)`, rethrow `MemorySendCommitFailed`. `commitFailed` is carried through every early return and through the catch at line 246, which would otherwise turn it into a result. The root stays when the stop is unconfirmed, and the intent stays when registration fails. `conclude`'s `transportError` branch keeps `f.transport`, and the durable intent was already written at line 96, so the reaper owns it. This applies to first runs and retries alike.

### Paid calls (r3 finding 1, and the gap the earlier revisions stated)
Today the charge is in `onAdmit`, inside the gate's transaction, and the spawn happens before that COMMIT. A crash or a COMMIT failure rolls the charge back after a call may have gone out, and `paidCallsOf`'s `attempt - 1` cannot rebuild more than one release per attempt, so a family can reach four released calls against `MAX_PAID_CALLS` of 3.

Fix: charge before release, durably.
- `learningGate` gains a `preSend` option. `send` calls it BEFORE `BEGIN IMMEDIATE`, synchronously, on the same turn of the loop. In pip-reflect it runs `chargePaidCall`, committing in its own `mutateReflect` transaction, and throws `readMoved("paid-cap")` at the cap. A busy write there takes the same path as `MemorySendBusy`. It refuses inside a transaction, as Rule 1 does.
- `onAdmit` no longer charges and stays the fence.
- Refund: when the gate refuses after `preSend` and before the release (`check`, `checkHeld`, busy, or `onAdmit` throwing), the catch takes the charge back in its own transaction (`f.paidCalls - 1`, never below `attempt - 1`, and only for the same run, family and attempt). A failed refund leaves the charge in place. Without the refund, a moved read or a held lock would use up the family's calls with nothing sent.
- No refund once `then` has started: from there "the attempt was released: keep it" is the existing rule (learning-send.ts:274).
- The `fence` path at line 748 and the after-return charge at line 763 stay, because their `mutateReflect` already commits before the bytes leave or after the call returned. `charged` keeps `turn` from charging twice.

No unique intent ids: Astra's r4 review rules them not required, since nothing replays or consumes a charge one by one and there is no deferred refund retry. A later replayable refund would need them.

The refund is taken only for a charge this invocation actually committed, never after a cap refusal or a failed charge. It runs after the gate's transaction has rolled back, or it would be a SAVEPOINT and roll back with it. A crash before the refund keeps the charge.

Direction: this counts high. A crash between the charge and the release consumes a call with nothing sent.

What the family loses when a crash uses up a charge: at most one of its three calls for that run. If that brings it to the cap, it stops as `refused:unstable` with reason `paid-calls`, and `s.cooldownUntil = now + COOLDOWN_MS`, 2 hours (pip-reflect.ts:36, :914). The owner sees the `refused:unstable` line under "Refusal lines". No money moves, and reflection resumes after the cooldown.

### Cooldown (main's ruling: accepted)
`cooldownUntil` is per bot, not per family (pip-reflect.ts:363, :394). `FAMILIES` is `["lived"]` today, so a family's cooldown and the bot's are the same thing. **Turning on more families changes that: one family reaching a cooldown stops all of that bot's families for 2 hours.** Whoever turns them on must decide whether that stands. A comment at `FAMILIES` says so.

### Refusal lines (main's ruling: both fixed in this lane)
The refusal lines live in `REFUSAL_LINES` (src/lib/continuity.ts:215), not in en.json. Each cause gets a line that is true for that cause. Final text is in the table. Standing copy rule: frame as strengths.

| Cause, where admission finds it | Reason from admission | State | Line today | New line |
|---|---|---|---|---|
| This call would pass the month's ceiling, extract.ts:313 | `spend-ceiling` | `refused:monthly-limit` | "Stopped: daily limit reached" | "Paused: this month's learning limit has no room for this run" |
| Two calls of unknown cost, extract.ts:317 | `unseen-calls` (Continuity only) | `refused:unseen-calls` | "Stopped: daily limit reached" | "Paused to protect your limit: some learning calls did not report their usage" |
| Calls per minute, extract.ts:323 (the setting may be 0) | `call-pace` (Continuity only) | `refused:call-pace` | "Stopped: daily limit reached" | "Paused: the learning pace has no room for this run" |
| 2 MiB a day of input bytes, extract.ts:324 (refused when this request would pass it) | `daily-bytes` (Continuity only) | `refused:cap`, key `refused:cap:daily-bytes` | "Stopped: daily limit reached" | "Stopped: today's input allowance has no room for this run" |
| 24 runs a day, pip-reflect.ts:629 | `daily-cap` | `refused:cap` | "Stopped: daily limit reached" | unchanged, true |
| `refused:unstable`, all reasons | as today | `refused:unstable` | "Stopped: three attempts did not finish" (wrong for fewer attempts or a crash) | "Stopped: this run did not finish" |

"Has no room for this run" is deliberate: :313 refuses when a call's reservation WOULD pass the ceiling, which can be before the ceiling is reached.

**(a) How the causes split.** `reserveExtraction` knows the cause where it returns. For `purpose === "continuity"` only, :317 returns `unseen-calls`, the pace half of :323 returns `call-pace`, and :324 returns `daily-bytes`. `output<1` keeps `budget-exhausted`. `lease.request` refuses `maximumOutputTokens<1` (extract.ts:535) and the family caps are positive (:232), so the Continuity lease cannot reach it; only a direct `reserveExtraction` call with 0 can. Every other purpose keeps `spend-ceiling` and `budget-exhausted` exactly, so jobs.ts:371, consolidate.ts:339-340, the shared contract list and automatic-learning.ts:12 are untouched. A Continuity reason reaches `lease.request` at pip-reflect.ts:827, then `box.leaseRefusal` at :828 and `conclude` at :937, where the map names each reason. It also passes `observer.refused` (extract.ts:530), but that takes any string and PIP's lease supplies no observer. `learning-budget.test.ts` changes where a Continuity case expects the old reason.

Everything reading the result must treat it as before. Readers found: `isTerminalFamilyState` (:111), the reaper and settle checks that use `startsWith("refused:")` (:1157, :1164, :1248, :1261, :1431), `noteRefusal` (:547) into `refusals`, status at :1423, and `refusalLine` through ContinuityView.tsx:215. None of these names `refused:cap` in production code. The other writers are :629 (`daily-cap`) and :725 (`input-limit`, which calls no `noteRefusal`, so it shows no line); they keep the state. The builder repeats this grep on the final tree, lists every reader in the lane's verification file, and adds each new state to the TERMINAL list in pip-r8-resume-terminal.test.ts. No cooldown is added, matching today's path. `refusals` persist, and an older row can't say which cause it had, so `refused:cap:spend-ceiling` and `refused:cap:budget-exhausted` both read "Paused: a learning limit stopped this run". `refusalLine` already tries that key first.

**The owner's pause card has the same problem.** `paused` is `ceilingReached || unmeteredPause` (settings.ts:305), but `settings.l6.paused.body` ("It reached this month's learning limit...") and `memoryLearning.ceiling.paused` ("Learning paused: it reached this month's learning limit.") say the limit in both cases. That is untrue when only unseen calls hold the pause. `LearningCeilingStatus` (shared/memory-learning-contract.ts:42) gains optional `pausedBy: "limit" | "unseen"`, present only while paused: "limit" when `ceilingReached`, else "unseen". `learningCeilingStatus` (settings.ts:301), the only builder, sets it. `InboxLearningPaused` (shared/inbox.ts:144) gains it and server/inbox-learning-paused.ts:60 copies it. LearningPausedCard.tsx:35 and memory-learning-text.ts:54 pick the key by it, and an absent value reads as "limit". It does not go in `learningCeilingSchema` (learning-policy.ts:62), which validates configuration, not status. The existing keys stay unchanged, because they are true for "limit". Two new en.json keys, with every locale and source-hashes.json handled as the repo requires. They say "usage", not "cost", because `settings.l6.*` copy may not mention price (LearningPausedCard.test.ts:49), and tokens are what went unreported:
- `settings.l6.paused.bodyUnseen`: "Some learning calls did not report their usage, so learning paused to protect your limit. Your bots still answer and remember what is already learned. Murage keeps noting new chats so learning picks up where it left off."
- `memoryLearning.ceiling.pausedUnseen`: "Learning paused to protect your limit: some learning calls did not report their usage."

`settings.l6.paused.title` and `settings.l6.usage.paused` ("for the rest of the month") hold for both causes. "Double the limit and resume" raises both sides, which clears unseen calls (settings.ts:550).

**What ends an unseen pause (main's check).** Two things, and the card shows both:
1. The month rolling over. Unseen counts live on the month row (`unseenExcessCalls` reads only that row), so a new month starts at 0. The title says "for the rest of the month", and "Leave paused" says "Left paused until next month".
2. The owner's press. At base this fails when a side is already at the maximum of 1,000,000,000,000: `doubledCeiling` leaves that side unchanged, the server's increase-on-both-sides check fails, and the pause stays until the month ends with no way out. Hiding the button would leave it that way, so the server changes instead.

**The fix.** In `configure` at settings.ts:550, a side counts as raised when it increased, or when `input.ceiling` was sent and that side is at the maximum (a new exported `LEARNING_CEILING_MAX` in learning-policy.ts, also used by `learningCeilingSchema`, `doubledCeiling` and `raisedCeiling`). `input.ceiling` is sent only by an explicit limit action: the card's button, the Memory page's raise, and the limit editor. A side at the maximum has no higher value left, so the press is the same acceptance of unknown cost that a raise is. A ceiling save that clears unseen calls also calls `releaseCeilingDeferrals`, or sources waiting for next month would stay held after learning resumes.

**Labels.** One side at the maximum: the button stays "Double the limit and resume", because the other side doubles. Both sides at the maximum on an unseen pause: nothing can double, so the button reads the new "Resume learning" and sends the unchanged ceiling. A limit-caused pause with both sides at the maximum can only clear when the row is below the limit, which needs a new month, so the button is absent there and the title states the end. On the Memory page, `ceilingStatusLine` gives `follow: "none"` with both sides at the maximum, because the raise button would change nothing. The card remains the way out, and after "Leave paused" so does a save in the limit editor. Three more new keys:
- `settings.l6.paused.resume`: "Resume learning"
- `settings.l6.paused.resuming`: "Resuming learning"
- `settings.l6.paused.resumed`: "Unseen usage is cleared. Learning resumes as soon as a run fits your limit."

Its failure line reuses `settings.l6.paused.leaveFailed` ("That could not be saved. Try again.").

**What the press promises (Astra eld-pipr8, Medium).** A press removes the unseen hold, and it can't promise the next run: status compares usage with the limit, and admission compares usage plus the reservation (extract.ts:313). So the `resumed` line says "as soon as a run fits your limit", which holds with little room left. A side at the maximum whose usage has already reached it can't be raised, so doubling the other side can't end that pause: the Double button and the Memory page's raise only show when every side whose usage has reached its limit is below the maximum. Otherwise the card shows no raise button and the title states the end, as with both sides at the maximum, and `ceilingStatusLine` gives `follow: "none"`. That screen always shows a way out (main's check): the month rollover stated in the title, with "Leave paused" still there, and on an unseen-only pause at both maximums the "Resume learning" button. An owner there is never left with nothing to read or press. The server condition doesn't change: a limit-editor save at the maximum can still clear unseen calls with that side exhausted, and the limit keeps the pause until the month ends.

**(b) `refused:unstable` keeps one line for every reason.** That state carries `paid-calls`, `read-moved`, `run-bound`, the validation path through `retryOrStop` (:928), the reaper and other notes (:1045, :1066, :1125, :1138, :1253, :1263). "This run did not finish" holds for all of them, with no count, so no split by reason is needed. The line promises no resumption, because one path has none on a timer (Astra eld-pipr6 finding 1): when stopping a leftover process fails three times, the reaper returns `unstable/reaper`, and the run keeps `transport` (pip-reaper.ts:284, pip-reflect.ts:1263). `settleRun` won't clear it while `transport` remains (:1157), so the cooldown ending doesn't free it, and "Try again" keeps it too (:1431). That ownership guard stays. `refusalLine` may append `: <reason>` for leftover-process and similar reasons (continuity.ts:226), so the line must not end in a clause that reads badly before a colon.

Tests pin each cause to its line (test 30).

**Copy records (main's ruling).** The lane merges L-COPY head a10aa1083 before `propose`. The five new keys take full copy records in all packs: `scripts/copy-review.mjs propose`, Sol read, `record`, on final text. Sol reads every new line, including the TypeScript refusal lines, which `propose` may not list; if it doesn't, the READY row says so. The lines stand if Sol passes them. If Sol objects to "protect" as implying a guarantee, reword both unseen-calls strings as Sol advises and propose again. Never `--accept`.

### Purpose (main's ruling: Astra confirmed, eld-pipr6)
PIP reflection and its probes are the only production route into `headlessTextOnlyTurn` and `claudeTextOnlyTurn`: fuigo.ts:1034, grok.ts:652 and claude.ts:2783, exposed through core.ts:5942, consumed at pip-reflect-host.ts:57 and invoked at pip-reflect.ts:762. Extraction, grounding and evaluation take other routes (extractor-connections.ts:154, cli-memory-learning.ts:133, evolution-runtime.ts:127, procedure-evaluator.ts:120). The lease purpose PIP uses is `continuity`, so "reflection only" names the feature, not that enum value.

### Receipts (main's ruling)
"Fuigo usage: read, not run" stays on the source claim: that reading of trust1013-src headless/reducer/messages/usage.rs is not necessarily the bundled 1.0.39. FluxMain's answer on flux-auto stream usage comes through main. The LFU2 Fuigo trial in the final real-engine gate records whether usage came back, and that goes in the READY row. This lane makes no new provider calls.

### Run 1's root
A genuine schema miss follows a confirmed exit, and normal completion removes that root before the wrapper retries. Tests assert both roots' lifecycle.

## Crash table
| Crash point | Record | After restart |
|---|---|---|
| Before the journal commits | none | Run 1 is one stale unseen, as today. No retry was released. Run 1's excess is lost; the window is one synchronous step after run 1 returned. |
| After the journal commits, before spawn | yes | Excess added, one unseen (see below). Counts a second call that never went out. |
| After spawn, before the gate's COMMIT | yes | Same. This is the window the old count missed. |
| COMMIT throws while the process lives on | yes, then settled | Child stopped, root kept if unconfirmed, reaper owns it, one settlement with `extraUnseen`. |
| During run 2 | yes | Same as after spawn. Run 2's tokens are unknown and are covered by the unseen count. |
| Between settlement and clear: settlement deferred by a lock, `conclude` clears the transport, then crash | yes | Same. The transport no longer holds anything this needs. |
| Between settlement and clear: settlement committed, `conclude` not yet run, then crash | deleted | Ledger already right, including `knownFloor` and `extraUnseen`. The reaper handles the leftover as today, with no charge. |
| During reconciliation | rolled back | Next pass does it once. Replay adds nothing. |
| Missing attempt: reflection row gone, reset, or never written | yes | Admission or the boot scan reconciles from the ledger row alone. |
| Crash, restart, crash again | at most the bound | Every retry passes an admission first, which reconciles that row. See Bounds. |
| Downgrade v11 to v10 | gone | That downgrade deletes month rows, so the ledger and its records go together. Stated, not fixed. |

## Which way uncertainty counts (main's ask 1)
This writes a local ledger only. It never sends a charge, a refund or a usage record to anyone.

| Layer | When a second call is unconfirmed | Direction |
|---|---|---|
| Reservation (month and day tokens) | Run 1's reservation stays on the rows, run 1's reported excess is added, and run 2 adds no tokens because they are unknown. | Tokens may read LOW by run 2's real usage above what the reservation still covers. The unseen rule bounds that. |
| Quota (the unseen-call count behind the learning pause) | Run 1 known: run 1 leaves the count and run 2 enters it, net one unseen, the same as any ordinary crash today. Run 1 unknown: two unseen, because two calls really are unknown. | Over by one call only if the crash fell after the journal and before the spawn. |
| Real money | No change. If run 2 reached the provider, its cost is real and falls on whoever pays that route (the owner's key or Flux balance), like any call. If it never went out, it cost nothing. | The over-count costs no money. |

Who bears an over-count: the owner, as learning pausing sooner this month (`UNSEEN_EXCESS_CALLS` is 2; server/memory/extract.ts:317). Nothing is billed, and chat and all other features are untouched. One crash in a retry where run 1 reported usage is the same cost to the owner as one crash in any learning call. A live Stop while the retry runs counts `extraUnseen`, so two of those in a month also pause learning.

What clears it: the owner raising the limit on both sides (`clearUnseenExcess`, server/memory/settings.ts:550), or the new month, which starts its own row. The existing Needs you line tells the owner about the pause.

Why this direction: an undercount would let learning spend past what the ceiling promises. The bound in extract.ts:52-56 (at most two calls' positive excesses past the ceiling) holds only if every call of unknown cost is counted.

Family paid-call cap: counts high, per "Paid calls" above. An over-count is borne by that bot's family, as an earlier `refused:unstable` and cooldown. No money moves, and the cooldown clears it.

## Bounds (records stay bounded)
A record is about 200 bytes. Rule 1 refuses a retry when the row already holds `UNSEEN_EXCESS_CALLS` (2) records, so 2 is enforced, not argued. Separately, every retry runs under an open reservation, and admission refuses when `inFlight + settled >= 2` (extract.ts:318), so in practice a row is not expected to reach the cap. The learning and Continuity slots are separate and deferred settlements can outlive a slot, so `learningSlot` is not the bound.

Per-turn work stays constant: admission reads the row it already reads and loops over at most 2 records.

## Tests required (each must fail with its rule removed)
Committed state is observed from an independent read connection, never the writer, which can see uncommitted data. Retry tests run inside a real reservation scope.
1. Dead-boot record, run 1 fully reported: excess on day and month rows, unmetered + 1, `open[boot]` - 1, record gone. Net unseen stays 1.
2. Dead-boot record, run 1 side missing: `open` unchanged, net unseen 2.
3. Replay is a no-op.
4. Inside the spawn stub, an independent connection sees the committed record.
5. Parent crash after spawn, before COMMIT: close and reopen; the record survives the rollback and reconciles.
6. Deferred settlement: a held lock, then a simulated crash with the transport cleared: the record still reconciles.
7. No attempt row, and `maintainPip` with no bots and no state: the boot scan still reconciles.
8. Day and month boundary: a record reconciles onto its own ledgers, and the new month's row is untouched.
9. Admission reconciles first and uses the reconciled row: figures and the unseen rule match, and no earlier snapshot is written back.
10. `clearUnseenExcess`: tokens added, unseen counts cleared, record gone.
11. A record from this boot is left alone.
12. Journal refused: write throws, an outer transaction is open, no reservation in scope, cap reached. Each: no second spawn, `first` returned, one settlement.
13. Run 1 with no usage block: record `usage: {}`, adds only unmetered, `open` unchanged.
14. Malformed record: deleted, admission still answers.
15. Grounding lease: a Flux schema miss under `groundMemoryClaim` writes a record. `captureMemoryUsage` keeps the handle.
16. Settlement, Rule 2: complete, partial and absent run 2 usage, plus cancellation, deferred settlement and restart after settlement. Run 1's excess lands every time. A released silent run 2 adds one unseen, and an unreleased one adds none. `finish(null)` cannot drop a released retry.
17. Boot scan: count reads with 100 month rows and 10,000 unrelated rows planted: at most 13 month reads plus one day read per record, and a second pass in the same process reads nothing. A busy write leaves the flag unset and the next pass finishes.
18. Bound: crash a retry in a loop 50 times with each new boot through admission: the row never holds more than 2 records.
19. Over-count path: a record whose second call never went out gives net unseen 1, and `clearUnseenExcess` clears it and resumes learning. Run once with reported tokens and once with a tokenless run 1: the second adds `max(0, estimate - reserved)` per side and `estimatedRuns` 1.
20. Unconfirmed exit, host level, with a real gate: a `refused/isolation` verdict from a failed debug read with `exited: false`, and the same with transient and with validated: `f.transport` kept, state `uncertain-transport`, no further spawn before the reap, and after a confirmed reap the attempt advances. All of it on both the content path and a single-run probe, and the unconfirmed probe is not cached as validated.
21. COMMIT failure, injected at the gate's real COMMIT, with registration succeeding and failing: the child is captured and stopped; root removed only on a confirmed stop and kept otherwise; `transportError` keeps `f.transport`; separately from test 5's abrupt death.
24. Paid calls near the cap, for a first run, a retry and a probe, one test per crash window: before the charge commits (nothing charged, nothing sent), after the charge and before BEGIN, after spawn and before COMMIT, a live COMMIT exception, after COMMIT, and a gate refusal with a crash before the refund (charge kept). The durable count is right, and the family never releases more than `MAX_PAID_CALLS` across restarts. Read with an independent connection.
25. Refund: `check`, `checkHeld`, busy and `onAdmit` refusals each return the charge, and a repeated moved read does not exhaust the family. Once `then` started, no refund. A cap refusal or failed charge subtracts nothing.
28. By name, "an unconfirmed probe keeps its transport": a validated probe with `exited: false` is not cached, keeps `f.transport`, and enters `uncertain-transport`.
29. Tokenless route: double schema miss with both sides absent, and again with 0/0 and an answer: unseen 0, no pause, across 10 turns, and day and month rows equal the two runs' byte estimates exactly (reservation gone), with `estimatedRuns` 2 per turn. The same for a single run, on each CLI engine. Real non-zero tokens settle unchanged with `estimatedRuns` absent. A retry mixing one reported and one tokenless run adds both. Estimated plus a released absent report, and estimated plus a released Stop: floor = estimate, settled at `R + max(0, E - R)` per side, one unseen, `estimatedRuns` 1. Estimated plus a retry stopped before release: only the estimate, none unseen. A crash on that route gives net one unseen, including across a month boundary. On a journaled retry a Stop with no result line counts one, and a one-sided report counts one and is not estimated. On a single run those two cases behave as they do today, asserted separately. A real result line with 0/0 and an empty answer settles at 0 as today, with `estimatedRuns` absent, and a helper-level case covers zero bytes. A Claude answer only in a `StructuredOutput` tool call (the existing fixture at pip-transport.test.ts:70) with 0/0 is estimated, not settled at 0. Result evidence survives a stdout overflow. A throwing `onUsage` hook, which reports twice, settles once. Over-limit and the trace value are unchanged by the estimate.
30. Refusal lines, each cause through a real `reserveExtraction` and the real result to its line, one case per row of the table: ceiling, unseen calls, calls per minute (including a setting of 0), daily bytes (including a request that doesn't fit below the cap), `daily-cap`. Older `refused:cap` rows with `spend-ceiling` and `budget-exhausted` read the older-row line. `paid-calls`, `read-moved`, `run-bound` and the validation path each give the `refused:unstable` line. Each new state is terminal, settles the run, and adds no cooldown. Every other purpose still gets `spend-ceiling` and `budget-exhausted` for the same causes. A refusal below the ceiling, where only the reservation doesn't fit, gives the month line, and admission reopens once an outstanding reservation settles lower. Repeated reap failure: `refused:unstable` keeps `transport`, the run survives an elapsed cooldown and an unsuccessful "Try again", and a confirmed cleanup finally clears it.
31. Pause card: ceiling reached gives `pausedBy: "limit"` and the existing body and ceiling line. Unseen calls alone give `pausedBy: "unseen"` and the new body and ceiling line. Both together give "limit". An absent value reads as "limit". The Inbox row carries it, and doubling the limit clears the unseen pause. Every way out, each asserting learning admits again through a real `reserveExtraction`: (a) a new month with no press, where the old month's unseen calls don't carry over and the old row is untouched; (b) one side at the maximum, Double clears it; (c) both at the maximum, "Resume learning" sends the unchanged ceiling and clears it, and `releaseCeilingDeferrals` frees held sources; (d) after "Leave paused", the card is gone until next month, and a limit-editor save at the maximum still clears it. Limits on the fix: a one-side raise with the other side below the maximum does NOT clear; a `configure` carrying only `learning` and no `ceiling` does NOT clear at the maximum; a limit-caused pause with both at the maximum has no button and states the month. One side at the maximum with its usage already at that limit: no Double button, the month is stated, "Leave paused" is still shown, and `ceilingStatusLine` gives `follow: "none"`. Every no-raise-button state renders a way out, checked as a table row for each state: limit pause at one exhausted maximum and at both maximums show the month line and "Leave paused"; unseen pause at both maximums shows "Resume learning". After an unseen hold clears with less room than the next reservation, the pause is gone from status, `reserveExtraction` still refuses that run, and it admits once it fits. `ceilingStatusLine` gives `follow: "none"` with both at the maximum. The cases that assert admission have enough token room for the reservation. Update the exact-object expectation at learning-budget.test.ts:69 and the fixture at MemorySection.test.ts:16 as the new shape needs.
26. Same boot with two reservations open: reconciling one fully reported record leaves `open[boot]` at 1.
27. Unseen count: incomplete first, partial second, tokenless report, and both incomplete, each applied once and matching the crash path's figure.
22. Selector: validated second, second schema miss, confirmed transient, isolation and unsupported, uncertain, paid-cap and cancellation, with both roots' lifecycle asserted.
23. Keep the tests for items 1, 2, 4, 5 and 6. Rewrite the two pip-paid-calls crash tests onto the journal, and the existing adapter retry tests into reservation scopes.

## BUILD-FIX list (AGREED-FOR-BUILD: every item fixed, code review confirms each by number)
From Astra eld-pipr6, PASS with no Critical or High. The text above already carries each one.
1. `refused:unstable` line promises no resumption, because the reaper path can hold a run past its cooldown. The guard stays, and test 30 covers it.
2. The `spend-ceiling` line holds for a reservation that doesn't fit below the ceiling. Test 30 covers the refusal and admission reopening.
3. `replyBytes` is stdout bytes and `answerBytes` decides the 0/0 case. Test 29 covers a real empty answer and the helper's zero-byte case separately.
4. Single-run and journaled-retry accounting are specified and tested separately.
5. Result evidence is kept through a stdout overflow, `estimatedRuns` sums on its own, both first-report protections stay, and tests cover each.

From Astra eld-pipr7, PASS with no Critical or High:
6. `answerBytes` includes Claude's `StructuredOutput` tool input, with a test on the existing fixture.
7. `daily-bytes` and `call-pace` lines describe fit, not a limit already hit, with cases for a request below the cap and a setting of 0.
8. An unseen pause always has a way out: at the maximum the owner's press clears it, and the month rolling over ends it, with tests for each way out (main's check replaced the earlier hidden-button text).
9. The new copy says "usage", which passes the existing price-word test at LearningPausedCard.test.ts:49 with that test unchanged.

From Astra eld-pipr8, PASS with no Critical or High:
10. The press promises only what it does: the `resumed` line says learning resumes when a run fits, no raise button shows when a side at the maximum is already exhausted, every no-raise-button state still renders a way out (main's check), and test 31 covers all three, with enough token room in its admission cases.

## Stated limits
- Run 2's tokens are not recoverable after a crash. They count as one unseen call.
- A crash before the journal commits loses run 1's excess. Run 1's reservation stays as a stale unseen call.
- A record older than 12 months at a boot stays on its dead month's row.
- The byte estimate sees only our bytes, so spend on a tokenless route can read low, and nothing counts that gap (Rule 2a).
- More families would share one bot's cooldown ("Cooldown").
- Fuigo's usage behaviour rests on a source reading until the LFU2 trial records it ("Receipts").
- Learning pauses through the existing Needs you path. The only string changes are the refusal lines and the five new en.json keys.
- An older refusal row can't say which cause it had, so it reads a line true for all of them until newer rows replace it.
