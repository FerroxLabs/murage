# Streaming speech-to-text with end-of-turn detection, through Flux Router

Private rollout flag names and implementation paths below use neutral placeholders.

**Status:** design, revision 14, 2026-10-01. Owner: Sean. Murage builds C, D, E and F. The Flux Router team builds B against contract A.
**Plans:** `docs/superpowers/plans/2026-09-30-flux-streaming-transcription-murage.md` (C to F) and `docs/superpowers/plans/2026-09-30-flux-streaming-transcription-flux-handoff.md` (B, stands alone).
**Audit reconciliation:** `.superpowers/sdd/2026-09-30-flux-streaming/converged-findings.md` (67 rows, FS-01 to FS-67, each with code, doc, probe or spike evidence).
**Spike evidence:** `.superpowers/sdd/2026-09-30-flux-streaming/stt-spike-results.md` (63 real-time sessions against AssemblyAI v3, 21 fixtures, three `say` voices).
**Owner-voice evidence:** `.superpowers/sdd/2026-09-30-flux-streaming/bakeoff-final.md` (Sean's own voice, 25 scripted lines, four conditions, five providers).
**Confirming audits:** `.superpowers/sdd/2026-09-30-flux-streaming/confirm-astra.md` (Revision 3 below) `confirm-astra-2.md` (Revision 4 below), `confirm-astra-3.md` (Revision 5 below), `confirm-astra-4.md` (Revision 6 below), `confirm-astra-5.md` (Revision 7 below), `confirm-astra-6.md` (Revision 8 below), `confirm-astra-7.md` (Revision 9 below), `confirm-astra-8.md` (Revision 10 below), `confirm-astra-9.md` (Revision 11 below), `confirm-astra-10.md` (Revision 12 below), `confirm-astra-11.md` (Revision 13 below) and `confirm-astra-12.md` (Revision 14 below).
**Executed plans:** since Revision 4 every code block in both plans has been run (Revision 6 re-ran every changed block): the Murage TypeScript under `tsc` and vitest in a scratch worktree of the app, the Flux Python under pytest on a copy of Flux Router (converged-findings.md, "Revision 4").

## Revision log

Revision 2 (2026-09-30) applies four independent adversarial audits (Astra, Sol, Claude, Gemini), each finding checked against Flux `the reviewed router revision`, LiteLLM `v1.67.4-stable`, Murage `0efaab22`, the AssemblyAI v3 docs and seven live probes (P1 to P7). 53 findings were confirmed, 8 partly confirmed, 3 refuted (FS-13, FS-60, FS-61); a benchmark spike then added three confirmed findings (FS-65 to FS-67) and revised the model, the timing anchors and every target. By area:

| Area | Findings | What changed |
|---|---|---|
| Billing | FS-01, FS-02, FS-03, FS-04, FS-05, FS-06, FS-10 | Each lease is priced from its own metadata (the first design re-charged every earlier lease); leases settle cumulatively so rounding never accumulates; close is idempotent; the prepaid gate, draw and release run per lease with pinned ids; the real prepaid refusal codes (`credit_exhausted`, `daily_cap`, `monthly_cap`) join 4402; one effective billing identity feeds every gate and charge; crashes are billed through the last 5 s heartbeat by a sweeper; the provider session is bounded by `inactivity_timeout`. The batch-fallback double charge is accepted and bounded (A.14, B.5, C.7). |
| Admission | FS-07, FS-08, FS-09 | A stream-owned Redis gate keyed per session and per lease replaces the shared counters (Gemini's "infinite bypass" is refuted: the settled bucket still caps, but the rest was real); the harness budget counts open leases (B.2, C.2). |
| Auth | FS-11, FS-12, FS-14, FS-58 | The stream paths are registered as LiteLLM API routes (without it no customer key authenticates); the auth adapter carries a model body so restricted keys get 4403; the provider registry is bootstrapped explicitly; LiteLLM's own unmetered `/v1/realtime` websockets are evicted (A.2, B.1, B.3). |
| Phone and desktop path | FS-15, FS-16, FS-17, FS-18, FS-19, FS-20 | The ticket route carries the companion launch proof and the desktop surface headers; the companion's upgrade runs the browser door's origin gate, cookie session and revocation tracking; tickets are bound to a companion-stamped principal; managed origin, Vite and the Electron gateway are covered; credential changes and shutdown close streams (1.3, C.2, C.5, C.9). |
| Provider mapping | FS-21 to FS-27, FS-30 | Partials and finals come from `words[]` (probes P1 and P2 show `transcript` means different things per model and `utterance` is not a final); finals are new words only; `turn.end` is the formatted rendering of the finals; end of turn is deduplicated per provider turn; `SpeechStarted` is used when sent; a new `turn.cancelled` closes a turn that ended with no words; effective config is reported and unsupported updates are refused (A.4, A.6, A.8, A.16). |
| Audio lifecycle | FS-28, FS-31 to FS-38 | The provider may run 3 s ahead of real time, so a start-up backlog drains instead of lagging all call (P3, P4 show the provider accepts it); the relay attaches listeners before the Flux handshake; pre-start audio is buffered by rule with oldest-first drops reported after `session.started`; commit and close are barriers behind queued audio; chunk sizes follow the sample rate; outbound messages go through one bounded writer; clocks are defined and `server_lag_ms` is reported by the server (A.5, A.7, A.12, C.2, C.4). |
| Session lifecycle | FS-39 to FS-46 | Rollover uses a replacement slot and a fresh uplink; hold, mute and hang-up have explicit transitions with generation fencing; a mid-turn fault hands the ring's audio to the batch recorder so the sentence is finished, not cut; deploys drain through a preStop file; the device fault test targets the live session (A.11, C.7, D, F). |
| End of turn | FS-47 to FS-50 | TurnAssembler is removed: CallView's existing `HeldLine` and `joinTurn` (commits `8260cf9d`, `28e7c572`, `0efaab22`) own the continuation hold and the late merge for both transports; late corrections are measured as what they are (C.6, C.8, E.4). |
| Conformance and simulator | FS-51 to FS-55 | Acceptance mode fails on any missing check, sample or gate; checks assert what their rows say; latency clocks are defined per frame and warm; the simulator passes its own suite, meters leases and states its fidelity boundary; fixtures parse the WAV `data` chunk (P6: it starts at byte 4088) (D, E). |
| Deployment | FS-45, FS-56, FS-57, FS-59 | Cloudflare, per-IP limits, the websocket backend and pings, drain on deploy and scale-down, the Python 3.13 runtime (B.6, G). |
| Plan quality and privacy | FS-62, FS-63, FS-64 | Snippets match HEAD (no import cycle, real signatures, config types), no credential-shaped strings, access-log redaction, the v1.1 token store (A.2, A.15). |
| Spike evidence | FS-65, FS-66, FS-67, and FS-21, FS-27, FS-31, FS-47, FS-49 revisited | The model is pinned to `universal-3-6-pro` at its balanced defaults (0.3 % WER, final text 661/703 ms, end of turn 672/1749 ms at p50/p90; the English model lost words and split every pause). `reason` no longer claims "semantic": the provider's confidence is a silence ramp. Provider word times are approximate (first word after a pause about 840 ms early, word ends about 230 ms late), so Murage times holds, merges, evidence and fallback clips from its own frame clock and Silero. Silero, not partials, stops the bot on "stop". A continuation hold of 2.2 s applies to a trailing comma or ellipsis on the stream path, the late merge stays required (16 of 34 pause sessions split), and Murage sends `turn.commit` when a partial ends in `.`, `?` or `!` after 400 ms of local silence (replayed p90 end of turn about 1.0 s), never on silence alone. Connect with the key in a header (1.32 s) rather than a temporary token (2.2 to 2.8 s). Acceptance targets are set from these numbers (1.2, A.4, A.6, B.4, C.4, C.6, C.8, E.4, F). |

### Revision 3

Revision 3 (2026-09-30) answers Astra's confirming audit (`confirm-astra.md`: 2 Critical, 22 Important, 4 Minor, verdict "Not ready") and folds in the owner-voice bake-off (`bakeoff-final.md`). Each finding was checked against Flux `the reviewed router revision`, LiteLLM `v1.67.4-stable` (its pinned `websockets==13.1.0`, `uvicorn==0.29.0` and `proxy_cli`'s uvicorn arguments), Murage HEAD and the plans' own snippets. 26 were accepted and fixed; M1 was accepted as a correction to FS-13's reasoning (FS-13 becomes PARTIAL; 4401 stays); M2 was partly refuted and its confirmed half fixed. Rows are in `converged-findings.md`, section "Revision 3".

| ID | Finding | Fix (sections) |
|---|---|---|
| C1 | A crash during renewal could bill the same seconds under two lease ids | One session record with contiguous lease ranges and a write-ahead `pending {n, units, through}`; the charge id is always the lease id `{sid}:{n}`; retries reuse it and the ledger, meter and draw are idempotent on it (A.14, B.5; hand-off Task 3) |
| C2 | A failed ledger write was reported as billed and its recovery record deleted | `settled_through` advances only after a confirmed write; a failed write stays pending and is retried every heartbeat and by recovery; the record is deleted only when closed and fully settled; armed accounts end `credit_unresolved`, unarmed ones end 4503 after three failed renewals (A.14; hand-off Task 3 tests (c) to (e)) |
| I1 | The orphan sweeper was neither scheduled nor crash-proof | A recovery loop per worker, started by the registrar's startup hook and by the route; an atomic Lua claim of stale records (30 s stale, 60 s claim, every 15 s); `LostOwnership` fences a live session whose record was claimed (A.14, B.2, B.5; hand-off Tasks 3 to 5) |
| I2 | Mappers could duplicate an end of turn and omit finals | End of turn deduplicated per provider turn with a re-check after the flush; a final covers every word before `turn.end`, or the text itself when no words came; both mappers and their tests (A.16; hand-off Task 2; Murage plan Task 4) |
| I3 | T-final was calibrated from a different metric than the runner measured | T-final replaced by T-text (hindsight-stable text, the spike's "final text") and T-eot (protocol end of turn), each measured as the spike measured it (E.3, E.4) |
| I4 | Targets were not reconciled with the owner-voice bake-off | Bake-off added to 1.2; T-owner qualification with per-condition p50 targets and WER at most 5 % (`OWNER_TARGETS`); targets labelled as targets (1.2, E.4, F, G.16) |
| I5 | The punctuation commit was never tested on the pause fixtures | `E-murage` runs one commit policy over plain and pause fixtures in the same sessions; `--commit on/off` is compared in Task 14 (E.3, E.4, G.15) |
| I6 | StreamMic lacked capture-clock and per-utterance ownership | Frames carry `capturedAt` from `call-mic.ts`; each utterance is a span matched to its `turn.end` by stream position and uplink (C.4; Murage plan Task 12) |
| I7 | After a reconnect StreamMic could not deliver the next line | `listening` restored when the new uplink is live; queued lines delivered in order; a test for two lines after a reconnect (C.4; Task 12) |
| I8 | Rollover and hold shared and leaked session state | Per-uplink `StreamState`; the rollover deadline fixed on receipt of `session.expiring`; `suspend()` bumps the generation and closes every uplink, the replacement included (C.4, C.7; Task 12) |
| I9 | The stated fallback and retry bounds were false | `MAX_FAULTS = 2` and `MAX_ATTEMPTS = 4` per call, every attempt counted; 1012 counts as a fault; the batch double charge bounded at two turns of 30 s (A.11, A.14, C.7) |
| I10 | Pre-start control ordering was broken through both relays | One ordered queue of audio and controls before `session.started`, in Flux and in the harness relay; the commit deadline set before the provider commit (A.5, C.2; hand-off Task 4; Murage Tasks 3 and 8) |
| I11 | Graceful close kept accepting audio and had no overall deadline | Intake stops at `session.close`; one absolute deadline; the session is marked final before `session.closed`, the ledger write after (A.7, B.2; hand-off Task 4) |
| I12 | The outbound writer could lose terminal messages and leaked after disconnect | The writer never drops an in-flight message; terminal messages are written before the close frame; the queue is disposed after a disconnect; only `slow_consumer` discards finals (A.12; hand-off Task 4) |
| I13 | Pacing accumulated idle allowance, and commit padding shifted timestamps | A credit bucket capped at `burst_ms`; padding recorded and provider times mapped back (`to_accepted`, `toAccepted`) (A.12; hand-off Task 2; Murage Task 4) |
| I14 | Config acknowledgements claimed changes not applied | Requested and effective configuration kept apart; `session.updated` reports the effective one; `idle_timeout_s` made immutable (A.4, A.7, D) |
| I15 | The simulator failed its own forced-end test | The commit timer is set before the provider commit; the simulator runs its own suite (D; Murage Task 3) |
| I16 | Credential changes and shutdown did not fence pending or newly redeemed streams | Close handlers registered before the Flux handshake; tickets revalidated at redemption (4503); a `session.closed` during the fence rewritten to `going_away` (C.2; Murage Task 8) |
| I17 | Companion upgrade ownership began too late | Close, error and 10 s timeout attached at the `upgrade` event; live recheck before completing (C.9; Murage Task 9) |
| I18 | Acceptance coverage contradicted the inventory | P04's coalescing half, L06 through a real-provider `connect_delay_ms`, M01 at 125 s, T11's formatted text; the excluded list is exactly A06, E-latency, E-nosplit-flux and T09 in the offline test; real-Flux fault expectations for F (E.2, F; Murage Tasks 6 and 15) |
| I19 | The harness budget test expected an impossible result | Cumulative settlement from `startedAt`; tests corrected (a 126 s stream charges 126 s) (C.2; Murage Task 8) |
| I20 | Privacy fixes did not reach the companion logging path | The ticket is redacted from a copy of the request before `originGate` and every log (C.9; Murage Task 9) |
| I21 | The drain flag survived a container restart | preStop writes PID 1's start time; a worker drains only when it matches its own (B.6; hand-off Task 6) |
| I22 | The hand-off was not standalone for acceptance | Hand-off Task 7 carries the artifact contract, fixtures, required checks, gates and steps (hand-off Task 7) |
| M1 | FS-13's refutation had a false premise | Corrected: LiteLLM raises budget errors inside its auth call, so 4401 for them is a choice matching the batch route, not a technical necessity; FS-13 becomes PARTIAL (A.2) |
| M2 | "Typecheck clean" had counterexamples | Partly refuted: the `WebSocket` default import was only used as a type (valid under `ws`'s typings), but it is now an explicit `import { type WebSocket }`; the unused T08 parameter was real and is gone (Murage Tasks 3 and 6) |
| M3 | The smoke command selected nonexistent checks | `--only T01-T03` (Murage Task 4) |
| M4 | The hand-off did not pin its websocket dependency | `websockets==13.1.0`, matching LiteLLM's constraint, with the 13.x asyncio client (B.4, B.6; hand-off Task 6) |

### Revision 4

Revision 4 (2026-09-30) answers Astra's second confirming pass (`confirm-astra-2.md`: 1 Critical, 16 Important, 3 Minor, verdict "Not ready") with a changed method: instead of only reading the plans, every code block was **executed**. The Murage TypeScript was extracted into a scratch worktree of the app at HEAD `d28664ef` with the plan's edits to existing files applied, and `pnpm exec tsc -b`, `pnpm exec tsc -p tsconfig.server.json --noEmit` and the plan's vitest files (plus the existing tests of every file the plan edits) were run until all passed. The Flux Python was applied to a copy of Flux Router `the reviewed router revision` on the Linux build host, in a Python 3.13 venv matching the Flux image built that day (LiteLLM 1.92.2, websockets 15.0.1, uvicorn 0.54.0), and pytest was run until all passed. The plans now hold those files byte for byte. Running them found defects no reader had: the T10 and T11 traces did not exist, four StreamUplink tests fired `open` on the previous test's socket, a companion upgrade whose client left during the handshake kept its slot (an http server's sockets are half-open), an oversize page message threw out of the harness, the plan's tests of two existing files (`tts.test.ts`, `CallView.test.ts`) broke, a commit sent before a close was reported as `session_end`, and the companion test paths were wrong. All 20 findings are fixed; none is refuted.

| ID | Finding | Fix (sections) |
|---|---|---|
| C1 | Recovery could emit the same Stripe charge again after Stripe's dedupe window | Stripe events go to Flux's durable meter outbox with their original time and the charge id; metering never posts to Stripe; the drainer retries at most 12 times inside 23 h and sends the rest to reconciliation; settlement stages are persisted (A.14, G.19; hand-off Task 3) |
| I1 | `save()` replaced the dict settlement kept modifying | `SessionRecord.data` is one authoritative dict, updated in place; tests assert the persisted record after each transition; `close()` twice is idempotent (A.14; hand-off Task 3 tests) |
| I2 | Reported billing contradicted "confirmed only" | `usage` carries `billed_seconds` (accrued), `confirmed_seconds` and `pending_seconds`; `session.closed` goes out inside the deadline and claims nothing unconfirmed (A.6, A.14; both contract modules, the simulator, the route) |
| I3 | The empty-words fallback could finalize discarded or different words | An end with no words never promotes tentative words: text-only ends finalize the text's new words; no text and nothing final is `turn.cancelled`; both mappers and tests (A.16; hand-off Task 2; Murage Task 4) |
| I4 | StreamMic did not typecheck against HEAD | Its timestamp is `lastHeardAt`; the whole chain typechecks under `tsc -b` (C.4; Murage Task 12) |
| I5 | Per-uplink capture and utterance ownership existed only in the spec | Ring frames record their stream and position; utterances belong to the stream of their first frame; a `turn.end` takes only its own stream's utterances begun before its end; capture time follows the source's sample clock; tests reproduce Astra's cases (C.4; Murage Task 12) |
| I6 | `attach()` discarded buffered messages | State and ownership are installed before subscribing; a test uplink that holds and flushes messages (C.4; Murage Task 12) |
| I7 | Muting during startup could replay discarded speech | A mute drops the start queue (C.4; Murage Task 12) |
| I8 | Hold and hang-up could not cancel opening uplinks | StreamUplink connects are cancellable and bounded (10 s); StreamMic owns connects in flight and closes them on hold or hang-up (C.4, C.5; Murage Tasks 11, 12) |
| I9 | Admission banked unbounded idle credit | A credit bucket capped at `burst_ms` in Flux and in the simulator; tests send 10 s after 4 s idle (A.12; hand-off Task 4; Murage Task 3) |
| I10 | Close was neither an immediate barrier nor fully bounded | The barrier is set when the close is read, a queued close stops the pre-start replay, marking is inside the close deadline, and the startup deadline runs from the upgrade (A.7, A.10; hand-off Task 4; Murage Task 3) |
| I11 | L06 measured the second fixture on the first fixture's clock | `sendPaced` returns its origin and `sentTimeOf(ms, origin)` uses it (E.2; Murage Task 6) |
| I12 | Owner-voice scoring was not the bake-off's and could skip lines | Word alignment against the whole script, spoken-number normalization, an explicit result per line, missing or non-finite samples fail, and the run uses the policy under test (E.4, G.16; Murage Task 6) |
| I13 | Flux acceptance contradicted the executable | `--target flux` and `--target murage` with their own required gates; Flux's command no longer runs the profile (E.4; hand-off Task 7; Murage Task 6) |
| I14 | P04 could pass without coalescing | `flood_partials` is specified in both fakes (numbered 4 KB partials); P04 asserts the flood arrived, some was replaced, and no slow-consumer close (E.2; hand-off Task 4 fake provider; Murage Tasks 3, 6) |
| I15 | Acceptance could hang or leak sessions after a failure | The handshake is bounded; the runner terminates every socket a check left open (E.2; Murage Task 6) |
| I16 | Preset resolution could produce an invalid configuration | Validation runs on the resolved silences in both contract modules; a refused update keeps the previous configuration (A.4) |
| M1 | The owner summary discounted real latency and flattened the split counts | 1.2 now states the per-condition p90s, calls the merging delay user-visible, and gives 3/8 in three conditions and 2/8 on the phone |
| M2 | Labels disagreed | L05 is 90 s with the notice at 60 s everywhere; both plans are marked Revision 4 |
| M3 | Lost ownership closed with 4500 | 4503 `service_unavailable` in code, tests and the hand-off's test list (A.14; hand-off Task 4) |

### Revision 14

Revision 14 (2026-10-01) answers Astra's twelfth confirming pass (`confirm-astra-12.md`: 0 Critical, 2 Important, verdict "Ready after fixes"). Both findings were reproduced on Revision 13's code with the audit's own numbers before they were fixed. Executed: 165 stream tests (metering 65, route 46), the 9 real-Postgres settlement tests, the interruption matrix (now 52 cases) and Flux's own 23 audio and auth tests, all passing. Nine tests are new; on Revision 13's code 8 fail (48 s billed for an 8 s startup write plus 40 s; 43 s for a 3 s `session.started` send plus 40 s; 60 s for a renewal stalled at 60 s and a crash at 80 s; a session store that stopped answering let the session serve on; 4 more because Revision 13 has no checkpoint path) and the ninth, a startup that never activates, bills zero on both. Billing formulas are unchanged. Murage is unchanged: a mid-session 4503 is already "retry with backoff" (C.7).

| ID | Finding | Fix (sections) |
|---|---|---|
| I1 | The monotonic billing origin was read before the startup write, so its persistence time was billed (8 s write plus 40 s billed 48 s) | The billing origin is the moment the writer confirms the `session.started` frame was sent: the monotonic clock and a wall-clock anchor are read there together; the anchor, stored with the activation write as `session_start`, dates the meter events. The startup write and the send are never billed; a startup that never activates bills zero (A.14; hand-off Tasks 3, 4) |
| I2 | Elapsed checkpoints rode the ticker's heartbeat, which waited behind a renewal holding the meter's lock through settlement: a renewal stalled at 60 s and a crash at 80 s billed 60 s, against a stated "at most 5 s short" | A separate checkpointer writes the billable seconds every 5 s to their own key, without the meter's lock or the record's version; one script fences it by ownership and by the cutoff and only ever raises the value. Recovery bills the cutoff, else the larger of the record's `elapsed` and the checkpoint. Exact bound: the meter never bills more than 10 s (two heartbeats) past the last confirmed checkpoint, and the session stops with `service_unavailable` and 4503 when it reaches that bound, so a crash loses at most 10 s, and at most 5 s plus one write's round trip while the store answers (A.11, A.14; hand-off Tasks 3, 4) |
| Table | Both fixes checked against the await table | Neither adds an await to the session's end: the call-graph walk finds 43 functions and 57 points (53 awaits, 4 `async with`), the same points as Revision 13. One row and two stall cases cover a checkpoint in flight when the session ends, which the end cancels and never awaits (hand-off Task 4; `converged-findings.md`, Revision 14) |

### Revision 13

Revision 13 (2026-10-01) answers Astra's eleventh confirming pass (`confirm-astra-11.md`: 0 Critical, 2 Important, 1 Minor, verdict "Ready after fixes"). Each finding was reproduced on Revision 12's code before it was fixed. Executed: 158 stream tests (metering 63), the 9 real-Postgres settlement tests, the interruption matrix (now 50 cases) and Flux's own 23 audio and auth tests, all passing. On Revision 12's code the 15 new metering tests fail: 11 on the bill (100 s and 20 s for a 40 s session after a +60 s and a -20 s wall-clock step, as the audit measured, and 95 s or 15 s for 35 s when recovery had only the last heartbeat) or on an early renewal, and 4 controls without a step only because Revision 12 persists a time of day rather than a duration; 3 of the 15 new matrix cases fail (`session.closed` and 1000 after a stalled final mark); the other 12 new cases pass there, since they add coverage for points that already behaved. Billing formulas are unchanged. Murage is unchanged: a 4503 at the close is already "retry with backoff" (C.7).

| ID | Finding | Fix (sections) |
|---|---|---|
| I1 | A final mark that timed out (the session store not answering) still ended `session.closed` and 1000 | A final mark that does not complete inside the close deadline, whether the store fails or does not answer, is answered with the sanitized `service_unavailable` error and 4503 with what is left of the deadline. Protected cleanup and the recovery of a write that landed unseen are unchanged (A.7, A.11; hand-off Task 4) |
| I2 | Billable time was a difference of wall-clock times, so a clock step mid-session changed the bill (40 s billed as 100 s or 20 s) | Billable time is measured on a monotonic clock from the startup write and persisted as a duration (`elapsed`) with every heartbeat, renewal and final mark; the durable cutoff is the duration at the end. Recovery bills from those persisted durations only, never from a difference of wall-clock times, and with no cutoff it bills the last persisted duration. Wall-clock times are kept for liveness and the meter event's date (A.14; hand-off Task 3) |
| M1 | The await table missed `meter.close()`'s lock, the cleanup of a session never activated, and the fleet-slot release | Rows and cases added (zero billed for a session never activated), plus stalled-store cases at the graceful final mark. The table was rechecked by walking the code's call graph from the session's end: every await and `async with` on that path is a row or is named as covered (hand-off Task 4; `converged-findings.md`, Revision 13) |

### Revision 12

Revision 12 (2026-10-01) answers Astra's tenth confirming pass (`confirm-astra-10.md`: 0 Critical, 2 Important, verdict "Ready after fixes"). Both findings were in the session's end, as in the two passes before it, so this revision enumerates every await in `_graceful`, the fatal path, `_cleanup` and its settlement. Each await is a row of a table (hand-off Task 4; `converged-findings.md`, Revision 12), and one parametrized real-Postgres test cancels the caller at each and, where the point touches the session store, fails the store there: 35 cases, each billing the true 40 s exactly once with the listed wire tail. On Revision 11's code 4 cases fail: the audit's two, reproduced exactly, and two the enumeration found. Executed: 143 stream tests, the 9 real-Postgres settlement tests, the 35 matrix cases and Flux's own 23 audio and auth tests passing. Murage is unchanged: 4503 already means "retry with backoff" (C.7), and a 4503 on a stream the client is closing (a rollover's old stream, an app hold) is not counted as a fault.

| ID | Finding | Fix (sections) |
|---|---|---|
| I1 | Cancelling cleanup before its settlement task existed skipped finalization (40 s billed 35) | Cleanup creates and retains one protected task before any await; inside it the cutoff is persisted, the provider closed (bounded), then the session settled and its slot released. The caller's cancellation propagates and the task carries on (A.14; hand-off Task 4) |
| I2 | The graceful close swallowed a session-store failure: `session.closed` and 1000, no error | The store failure at the final mark is answered with the sanitized `service_unavailable` error and 4503 inside the close deadline; settlement and recovery follow (A.7, A.11; hand-off Task 4) |
| New | Found by the enumeration: a store failure at cleanup's final mark left recovery to bill through the last heartbeat (40 s billed 35) | Recovery bills through the durable cutoff when one was written, else the last heartbeat. The billing formulas are unchanged (A.14; hand-off Task 3) |

### Revision 11

Revision 11 (2026-10-01) answers Astra's ninth confirming pass (`confirm-astra-9.md`: 0 Critical, 2 Important, verdict "Ready after fixes"). The pass confirmed Revision 10's two fixes and found two regressions in them; both were reproduced and fixed. Executed: 143 stream tests, the 9 real-Postgres settlement tests and Flux's own 23 audio and auth tests passing. The 3 new tests failed first on Revision 10's code, one of them billing a 60 s session 80 s exactly as the audit reported. Two existing route tests were corrected: one flaky because it used the server's fakeredis client from another event loop, one that waited for a ledger row after the test client had cancelled the app. Murage is unchanged.

| ID | Finding | Fix (sections) |
|---|---|---|
| I1 | A renewal finishing after cleanup's waits let a heartbeat extend billing (60 s billed 80 s) | The ticker rechecks `quiesced` after a renewal. The session's end is an immutable billing cutoff: it is persisted first in cleanup, without the meter's lock, every later `seen_at` and mark is clamped to it, and recovery bills through `min(seen_at, cutoff)`. Settlement finalizes even when cleanup's waits expire (A.14; hand-off Tasks 3, 4) |
| I2 | Cleanup swallowed its caller's cancellation | No blanket `BaseException`. Settlement is its own managed task: cancelling cleanup raises `CancelledError` in the caller and the billing step and finalization still complete (hand-off Task 4) |

### Revision 10

Revision 10 (2026-10-01) answers Astra's eighth confirming pass (`confirm-astra-8.md`: 0 Critical, 2 Important, verdict "Ready after fixes"; no billing finding). Both findings were confirmed against the plan's code and fixed without touching billing. Executed: 140 stream tests, the 9 real-Postgres settlement tests and Flux's own 23 audio and auth tests passing; the 4 new tests failed first on Revision 9's code. The Murage side is unchanged: no close code or contract rule changed. StreamMic already handles a 4503 from a stream as a fault: batch for the turn at once (a turn in flight handed over), a reconnect at the next silence, and batch for the rest of the call after two faults, as C.7 specifies for "retry with backoff".

| ID | Finding | Fix (sections) |
|---|---|---|
| I1 | `usage` could follow `session.closed` | The session is quiesced before the terminal message: the ticker produces nothing more and the writer drops anything queued after it; a renewal or heartbeat already running finishes, and cleanup waits for it, bounded (A.6, A.11; hand-off Task 4) |
| I2 | A Redis failure at startup escaped with no error or controlled close | Session-record failures become a sanitized `service_unavailable` and close 4503, sent before the bounded cleanup, which no longer lets an exception escape; cancellation and ambiguous-write recovery unchanged (A.11; hand-off Tasks 3, 4) |

### Revision 9

Revision 9 (2026-10-01) answers Astra's seventh confirming pass (`confirm-astra-7.md`: 1 Critical, 4 Important, 1 Minor, verdict "Not ready"). Each finding was verified against Flux `the reviewed router revision` and on a real Postgres 16 built from Flux's migrations; all six were confirmed and none refuted. The owner's rule is unchanged: every paying customer streams. Executed: 136 stream tests, 9 real-Postgres settlement tests and Flux's own 23 audio and auth tests passing. Flux's credit, draw and sweep tests, and its 89 on-behalf and MCP tests, are unchanged by this plan's two Flux changes. The 6 new tests failed first on Revision 8's code. The Murage side is unchanged: no close code or shared contract rule changed.

| ID | Finding | Fix (sections) |
|---|---|---|
| C1 | The stream's 150 s reservation TTL could drop other requests' reservations | Flux applies the caller's TTL to the account's whole reservation set; the stream now passes none and uses Flux's shared policy (`FLUX_CREDIT_RESERVATION_TTL_SECONDS`, default 600 s), as chat does. Tested on Postgres: a 180 s old chat reservation survives a stream's admission and renewal (A.14; hand-off Task 3) |
| I1 | A healthy sweep could draw a lease after its reservation lapsed | Under the shared 600 s policy the worst normal path (about 300 s) leaves 300 s of margin; the sweep's draw releases the lease's reservation (shared id); a new alarm on the oldest undrawn prepaid stream row warns at 300 s and pages at 450 s. Tested on Postgres: another stream is refused on balance an undrawn lease still owes, and the sweep releases it (A.14; hand-off Task 3, Task 6 Step 9) |
| I2 | A turn end covered audio delivered for the next turn | Each event advances progress only through the audio it acknowledges (A.10; hand-off Task 4) |
| I3 | The on-behalf resolver refused prepaid accounts without a Stripe customer | An opt-in keyword on Flux's resolver (default unchanged for every other caller); the stream requires the Stripe customer only for Stripe-metered leases; authenticity, revocation and entitlement checks kept. Tested with the real resolver against a `flux_keys` table on Postgres (A.14; hand-off Tasks 3, 4) |
| I4 | The bug note's mitigation forgives usage the included allowance or rollover should pay | Disclosed in the note and proven on Postgres: a fully included request was stamped settled with nothing consumed, whereas Flux as it is charges it once. Fully included, mixed and rollover cases added to its test matrix; the fix is the Flux lane's (`flux-bug-salvage-sweep.md`) |
| M1 | Zero-balance acceptance expected batch to still work | Both paths expect `credit_exhausted` at zero balance; the batch fallback is checked separately with a funded balance (hand-off Task 7) |

### Revision 8

Revision 8 (2026-10-01) answers Astra's sixth confirming pass (`confirm-astra-6.md`: 1 Critical, 4 Important, verdict "Not ready") and an owner ruling. All five findings were verified against Flux `the reviewed router revision` and on a real Postgres 16 built from Flux's migrations, and none was refuted. **The owner's ruling (Sean, verbatim): "I want this available for every paying customer, whether they're on a plan, prepaid credit, pay-as-you-go, or what have you."** Revision 7's refusal of prepaid-armed accounts and its Phase 2 are withdrawn. Prepaid streams are billed through Flux's own undrawn-row sweep (A.14); the stream never draws during a session. That one change was checked on real Postgres against chat rows swept by the same sweep: the exact sale, included allowance first, the same clamp at an insufficient balance, and the same refusal at zero balance. Executed: 134 stream tests, 5 real-Postgres settlement tests and Flux's own 23 audio and auth tests passing; Flux's credit, draw and sweep suites unchanged by the one Flux change; 32 new tests failed first on Revision 7's code. Murage follows: the contract module and the simulator replace `prepaid_unsupported` with `billing_unavailable` (2 new tests failed first; both typechecks clean and 1401 tests passing in a scratch worktree).

| ID | Finding | Fix (sections) |
|---|---|---|
| C1 | The salvage patch in the bug note did not cover missing or late anchors, and it locked in the opposite order to a draw | The note is rewritten. The patch is presented as a partial mitigation (an anchor that exists only). It is reordered to lock the ledger row first, as the draw does, and to skip a request already drawn. Tested concurrently on Postgres: Revision 7's one-statement form deadlocked against a draw of the same request; the reordered form waits and charges once. A race between a salvage and a draw of the same request charged both even on Flux as it is, with no sweep. The late-anchor gap is proven and stays. The complete fix is a recommendation for the Flux team (`flux-bug-salvage-sweep.md`) |
| I1 | Activation could land before `session.started` was sent | The writer confirms the `session.started` frame's send; activation waits for it inside the startup deadline; a blocked or failed send, or death before it, bills nothing (A.10, A.14; hand-off Tasks 3, 4) |
| I2 | A partial cleared the stall tracker | Provider progress (the furthest reported audio position) against delivered audio; a partial advances progress but never covers audio after it; the limit uses the max silence in effect (A.10; hand-off Task 4) |
| I3 | A missing Stripe customer silently produced ledger-only settlement | Admission needs the lease channel's identity: a Stripe customer for `stripe_meter` (else 4402 `billing_unavailable`, before the provider connects), an armed account for `prepaid`; a record without one keeps its charge owed (A.11, A.14; hand-off Task 3) |
| I4 | A lost expiry could close admission for good | Increment and expiry in one Lua step, repairing a key left without one, for the per-account and fleet counters (A.10; hand-off Task 3) |

### Revision 7

Revision 7 (2026-10-01) answers Astra's fifth confirming pass (`confirm-astra-5.md`: 2 Critical, 5 Important, 1 Minor, verdict "Not ready"). Each finding was verified against Flux `the reviewed router revision` before any change, this time also on a real Postgres 16 built from Flux's own migrations and driven by Flux's own ledger, credit-state, salvage and sweep code; all eight were confirmed and none refuted. The controller's rulings were applied: **streaming v1 settles on the Stripe meter only**. Flux refuses a prepaid-armed account with 4402 `prepaid_unsupported` and the client uses batch transcription. The stream no longer touches the prepaid gate or draw. One small Flux change keeps stream ledger rows out of Flux's undrawn-row sweep and orphan-fence self-heal. Prepaid streaming becomes a Phase 2 item owned by the Flux team (hand-off, "Phase 2"). Executed: 107 stream tests, 3 real-Postgres settlement tests and Flux's own 23 audio and auth tests passing, and Flux's credit, draw and sweep suites unchanged by the Flux change; 14 new tests failed first on Revision 6's code. On the Murage side, the contract module, the simulator and its AssemblyAI bridge follow (1401 tests passing in a scratch worktree, both typechecks clean; 4 new tests failed first). The same real-Postgres run showed that Flux's existing, non-stream traffic has a double debit: a funded-account salvage followed by the undrawn-row sweep charges one request twice (a 150,000 microcent sale cost 350,000). It is written up for the Flux team in `.superpowers/sdd/2026-09-30-flux-streaming/flux-bug-salvage-sweep.md`, with a repro and a fix that was tested.

| ID | Finding | Fix (sections) |
|---|---|---|
| C1 | Persisted channels did not constrain Flux's sweep | Stripe only: armed accounts refused at connect and renewal; `sweep_undrawn` and `clear_orphan_fences` exclude `capability_kind = 'audio_transcription_stream'`, tested on a real Postgres with an account that arms after streaming (A.11, A.14, B.5; hand-off Task 3 Steps 3, 5, Task 6 Step 9) |
| C2 | Salvage then sweep could debit twice | The stream never draws, so it cannot reach that path; the same double debit was proven in Flux's existing traffic and reported separately; prepaid streaming deferred to Phase 2 with its open questions (A.14; hand-off Phase 2) |
| I1 | A process that died after the startup write was billed by recovery | An activation write after `session.started`; recovery bills only activated records (A.14; hand-off Tasks 3, 4) |
| I2 | A barrier after a full burst passed `burst_ms` | Admission keeps one barrier's padding free (A.7, A.12; hand-off Tasks 2, 4; Murage Tasks 3, 4) |
| I3 | A word-bearing end's transcript was trusted unchecked | The end's transcript must agree with its words in spoken form, else the finals' text is used and the conflict counted (A.8, A.16; hand-off Task 2; Murage Task 4) |
| I4 | The provider-stall timer needed client activity | The timer runs on delivered audio the provider has not answered, for 10 s plus the turn's max silence, whatever the client does (A.10; hand-off Task 4) |
| I5 | Drainer sizing omitted completions and existing traffic | Fleet-wide bounds on open sessions and session starts (4503 at capacity); the drainer must post concurrently; the supported workload and the required capacity are stated (A.10, A.14; hand-off Task 6 Step 8) |
| M1 | The alarm scenario never crossed its threshold | Delivery recovery and alarms qualified separately; an overdue alarm and an unresolved-age alarm, each fired on purpose (hand-off Task 6 Step 8) |

### Revision 6

Revision 6 (2026-10-01) answers Astra's fourth confirming pass (`confirm-astra-4.md`: 1 Critical, 7 Important, 1 Minor, verdict "Not ready"), which was Flux-scoped. Each finding was treated as a hypothesis and checked against Flux `the reviewed router revision` and by running the plan's code before anything was changed; all nine were confirmed (the I5 evidence needed one correction: the undrawn-row sweep's flag defaults to false in code, but Flux's manifests set it true on the proxy and the reconciler, so the hand-off names it as a prerequisite to keep rather than one to enable). The Flux Python was executed as before on a copy of `the reviewed router revision` in the LiteLLM 1.92.2 environment: 111 stream tests and Flux's own 23 passing, mapper and sender also on websockets 13.1.0; 22 new or changed tests failed first on Revision 5's code, each on its defect. The Murage mirrors of the changed contract rules (the shared contract module's end reconciliation, the simulator's AssemblyAI bridge and its close) were changed to match and run under `tsc` and vitest in a scratch worktree. The controller's rulings were applied: the billing channel is persisted at reservation; Revision 5's inline Stripe post is withdrawn in favour of the drainer as the single delivery owner; the startup boundary and the billing end are explicit.

| ID | Finding | Fix (sections) |
|---|---|---|
| C1 | A prepaid lease recovered after a flag change was charged on both Stripe and prepaid credit | The prepaid gate's answer at reservation fixes each lease's channel (`prepaid` or `stripe`), persisted with the lease; write-ahead, settlement and recovery read only that, never `_should_emit_meter` or the flags (A.14; hand-off Task 3) |
| I1 | The inline Stripe writer had no horizon and no fence against the drainer | Withdrawn: the stream only inserts outbox rows, due at once; the drainer (one CronJob, `Forbid`) is the one delivery owner and checks age before each post; its cadence goes to every minute with a 1000-row batch, a new alarm on the oldest due row, and a staging qualification (A.14, G.19; hand-off Task 3, Task 6 Step 8) |
| I2 | A cancelled startup could bill 10 s; cleanup time could be billed | `session_start` reaches memory only after Redis confirms it; a failed or cancelled startup reads the record back and settles at zero; the billing end is captured when the session ends (close answered, fatal error, client gone), before the provider close and cleanup (A.14; hand-off Tasks 3, 4) |
| I3 | The backlog omitted in-flight work and pacing padding; controls were unbounded | Outstanding work counts the chunk in flight and reserves the most padding each queued barrier can need; KeepAlive never queues; consecutive updates merge; controls cost no pacing sleep; the pre-start replay is admitted against the same bound; a route test runs the real sender (A.7, A.12; hand-off Tasks 2, 4; Murage Task 4) |
| I4 | Ends carrying words ignored the immutable finals | The finals actually sent are kept apart from provider hypotheses; an end with words is reconciled in spoken form exactly as a text-only end, including one formatted word that covers a final and a new word; formatted ends are never finalized by position (A.8, A.16; hand-off Tasks 1, 2; Murage Tasks 1, 4) |
| I5 | A prepaid draw's normal return was taken as proof | The draw is called at most once per lease and its result read back from the ledger anchor; unreadable stays pending and is re-read; undrawn is handed to Flux's undrawn-row sweep, which requires `the router incremental metering switch=true`, a named prerequisite (A.14; hand-off Task 3, Task 6 Step 9) |
| I6 | A failed seconds-cap settlement was swallowed | `settle_lease` reports success; each settlement is owed in the session record until Redis applies it, and the record is not deleted while one is owed (A.14; hand-off Task 3) |
| I7 | A graceful close could drop the last dropped-audio ranges | Every range still owed is sent before `session.closed` or a fatal `error`, whatever the once-a-second limit (A.6, A.12; hand-off Task 4; Murage Task 3) |
| M1 | Metering prose contradicted the code | One definition in the module text and the plan: the stream never posts to Stripe, `confirmed_seconds` is `recorded_through`, `settled_through` means every stage finished (hand-off Task 3) |

### Revision 5

Revision 5 (2026-09-30) answers Astra's third confirming pass (`confirm-astra-3.md`: 0 Critical, 12 Important, 3 Minor, verdict "Not ready"), executed as in Revision 4: the Murage TypeScript in a fresh scratch worktree at HEAD `1830ae62` (`tsc -b` and the server typecheck clean; the plan's tests and the existing tests of every file it edits passing), the Flux Python on a copy of Flux Router `the reviewed router revision` in the LiteLLM 1.92.2 environment (79 stream tests and Flux's own 23 passing; mapper and sender also on websockets 13.1.0). Every new test, on both sides, was first run against Revision 4's code: all but three regression guards (tests of behaviour Revision 4 already had right) failed there, so each finding is pinned by a failing-first test in the task that owns it. All 15 findings are fixed; none is refuted. The owner scorer was also qualified: it is now the bake-off's own scoring, ported, and replaying the bake-off's saved AssemblyAI events through it reproduces the bake-off table exactly (622/717/945/719 ms p50, 5139/5140/5335/3881 ms p90, 2.7 % WER, pause splits 3, 3, 3 and 2 of 8, the same flagged lines).

| ID | Finding | Fix (sections) |
|---|---|---|
| I1 | Text-only ends still disagreed with the finals | Reconciled with the immutable finals in spoken form (the bake-off's normalization); a contradiction leaves the finals standing and is counted; both mappers, both contract modules (A.8, A.16; hand-off Task 2; Murage Tasks 1, 4) |
| I2 | Utterance ownership broke on cancellation and dropped onsets | Owned by the first sent frame; stream-scoped cancellation; consumed-then-continuation for a provider end during speech; no global "earliest" fallback (C.4; Murage Task 12) |
| I3 | The capture clock went wrong after a hold and put batches in the future | Capture time comes from the source: each native frame is its event's arrival less the audio after it; nothing carries between events (C.4; Murage Task 12, `call-mic.ts` edit 5 and its test) |
| I4 | A mute then an empty commit swallowed the next turn | A discard by position, retired by `turn.committed {turn: null}` (C.4; Murage Task 12) |
| I5 | Header acquisition escaped cancellation | Raced against the connect's abort and deadline, never cancelled itself (C.5; Murage Task 11) |
| I6 | A pre-start close let later audio evict earlier audio | The close is a barrier the moment it is read, in Flux and the simulator (A.7; hand-off Task 4; Murage Task 3) |
| I7 | The startup deadline missed the startup write and the timeout waited for cleanup | The startup write is inside the deadline; the 4504 is sent before a separately bounded cleanup; leftovers go to recovery (A.10; hand-off Task 4) |
| I8 | Commit padding broke the 3 s queue bound | The sender counts queued work including padding; admission refuses a frame that would pass `burst_ms` of it; repeated barriers coalesce; one commit in flight; deadlines use the real backlog (A.7, A.12; hand-off Tasks 2, 4; Murage Tasks 3, 4) |
| I9 | Aggregated drop warnings lost the gap positions | `warning.ranges` lists every separate run; StreamMic's `acceptedPos` walks them and maps a frame inside a gap to the gap (A.6, A.12, C.4; hand-off Task 4; Murage Tasks 1, 3, 12) |
| I10 | Owner qualification was not the bake-off's scoring or StreamMic's policy | The bake-off's scoring ported, the 25-line manifest enforced, StreamMic's commit replayed in pauses inside lines, and the replay check done (E.4, G.16; Murage Task 6) |
| I11 | The DLQ drainer became the only delivery path, at 40 rows a minute | The inserting process posts once at once and marks done; the drainer carries only failures; its migrations, image, throughput, alarm and reconciliation owner are hand-off requirements, qualified on staging (A.14, G.19; hand-off Tasks 3, 6, 7) |
| I12 | F04 could hang the run | `closedWithin` in F04 and an overall deadline per check, with cleanup after it (E.2; Murage Task 6) |
| M1 | `confirmed_seconds` meant fully settled | It now counts what the ledger has rows for (`recorded_through`), separately from full settlement (A.14; hand-off Task 3) |
| M2 | Companion test paths were still wrong in the prose | `companion/test/` throughout Task 9 |
| M3 | An obsolete budget paragraph remained | Replaced with the cumulative rule the tests pin (Murage Task 8) |

## 0. Summary

Murage calls today run: phone mic, then an 850 ms silence endpoint, then a WAV upload, then Flux `POST /v1/audio/transcriptions` (Groq Whisper, batch only), then the host LLM, then TTS. The transcript lands an estimated 1.5 s after the endpoint (not logged per turn; `call-cutoff-analysis.md:78-80`), and the fixed-silence endpoint splits sentences at natural pauses ("Blues Brothers," ... "Heartbreak Ridge."). CallView at `0efaab22` already softens the split: a line that sounds unfinished waits 1.2 s for the rest (`HeldLine`), and a second half that lands as the reply starts is joined to the first (`joinTurn`). The transcription wait remains.

A benchmark spike (1.2) measured AssemblyAI `universal-3-6-pro` at 661 ms p50 from end of speech to final text and 672 ms p50 (1749 ms p90) to end of turn, against today's estimated 2.35 s. This spec adds a streaming transcription endpoint to Flux Router: a websocket that takes PCM and returns partial words, stable finals and an end-of-turn event whose payload already carries the whole turn's text. The transcript is ready when the turn ends, and the turn ends on meaning plus silence rather than on 850 ms of silence alone. Users still need only a Flux key: the provider key (AssemblyAI first) lives inside Flux, and on Murage the Flux key stays on the harness.

Murage proves the chain before Flux builds anything: a local simulator implements contract A and bridges to AssemblyAI with a test key, and a conformance suite checks the contract. The same suite is then the acceptance gate for real Flux.

## 1. Verified facts this design rests on

### 1.1 Flux Router (local copy `the reviewed router checkout`, HEAD `the reviewed router revision`, 2026-07-15; the live service is newer)

| Fact | Where |
|---|---|
| Batch STT is a custom FastAPI route mounted by a LiteLLM `CustomLogger` registrar that evicts LiteLLM's native route, front-moves its own and self-checks ownership; on mount failure it installs a 503 fallback. | `the Flux router's batch audio registrar`, `:130`, `:178` |
| A custom path is refused to every non-admin key by LiteLLM's route check unless it is appended to `LiteLLMRoutes.openai_routes` (exact match); Flux does this for `/v1/fetch`. | `the Flux router's fetch registrar`; LiteLLM v1.67.4 `auth/route_checks.py:180-213` |
| `user_api_key_auth` reads the request body and checks the key's model list only when the body names a model; LiteLLM's own websocket adapter synthesizes `{"model": ...}`. | LiteLLM v1.67.4 `auth/user_api_key_auth.py:102-117`, `:758-769`, `:1033` |
| LiteLLM 1.67.4 serves its own websocket realtime proxy at `/v1/realtime` and `/realtime`, outside Flux metering. | LiteLLM v1.67.4 `proxy/proxy_server.py:4265-4272` |
| Batch request order: dark guard, auth (every shim failure is 401), on-behalf, size cap, params, entitlement 402, sniff, probe, per-account gate 429 with a reservation, prepaid gate with a pinned request id, dispatch, bill, prepaid draw or fence, settle. | `the Flux router's batch audio route` |
| Per-account gate: fixed-window RPM plus hourly billed seconds with one inflight counter per account whose TTL is set once (120 s); stale releases clamp at 0; keys shared with batch audio and images; fails closed without Redis. | `the Flux router's account admission gate`, `:112-131`, `:160-178` |
| Billing stamps accumulate in `metadata["flux_capability_stamps"]` and the sale sums every stamp, so one metadata object must never carry two charges. | `the Flux router's refusal handler`, `:385-420` |
| Prepaid gate reasons: `credit_unresolved`, `credit_exhausted`, `daily_cap`, `monthly_cap`; the gate takes a `request_id` and `ttl_seconds`; `release_inflight` releases an unused reservation. | `the Flux router's credit state handler`, `:1553-1569`, `:1575-1603`, `:1848` |
| On-behalf resolution enforces the customer's own entitlement and returns its account, customer, tier and key hash. | `the Flux router's on-behalf resolver` |
| Pricing lives in `config/capability-pricing.yaml` per capability kind and arm. Public aliases only in any response. | `config/capability-pricing.yaml:24-33`, `the Flux router's batch audio route` |
| Runtime: Python 3.13 on `litellm-database:main-v1.67.4-stable`, started by the `litellm` CLI, four workers per pod. | `Dockerfile:8`, `:28`, `:309-311`; `the router deployment manifest:158` |
| Deploy: rolling `maxUnavailable: 1`, grace 60 s, `preStop` sleeps 15 s, `/tmp` is an emptyDir; HPA 2 to 4 pods. | `the router deployment manifest:60-68`, `:900-921`; `k8s/hpa.yaml:33-34` |
| Ingress: nginx behind Cloudflare (origin certificate, Full strict), `proxy-read-timeout`/`proxy-send-timeout` 300, `limit-rps` 50, `limit-connections` 20 per IP. | `k8s/ingress.yaml:11-31` |

### 1.2 AssemblyAI Universal-Streaming v3 (official docs, fetched 2026-09-30, plus live probes)

Sources: [Streaming API reference](https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api), [Generate streaming token](https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token), [Turn detection](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection), [Message sequence](https://www.assemblyai.com/docs/streaming/message-sequence), [Common session errors and closures](https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures), [Session-based pricing FAQ](https://www.assemblyai.com/docs/faq/how-does-universal-streaming-session-based-pricing-work).

| Fact | Detail |
|---|---|
| Endpoint | `wss://streaming.assemblyai.com/v3/ws` (also `streaming.us.` and `streaming.eu.`). |
| Auth | `Authorization` header with the API key, or `?token=` with a temporary token (`GET /v3/token?expires_in_seconds=1..600&max_session_duration_seconds=60..10800`); one token opens one websocket. |
| Query params | `sample_rate`, `encoding`, `speech_model` (`universal-3-6-pro` default, `universal-3-5-pro`, `universal-streaming-english`, `universal-streaming-multilingual`), `format_turns`, `end_of_turn_confidence_threshold`, `min_turn_silence` (older name `min_end_of_turn_silence_when_confident`), `max_turn_silence`, `keyterms_prompt`, `inactivity_timeout` (5 to 3600 s). |
| Messages | client: binary audio (50 to 1000 ms), `UpdateConfiguration`, `ForceEndpoint`, `KeepAlive`, `Terminate`; server: `Begin`, `SpeechStarted`, `Turn {turn_order, turn_is_formatted, end_of_turn, transcript, utterance, end_of_turn_confidence, words[{text,start,end,confidence,word_is_final}]}`, `Termination`. |
| Close codes | 1008 unauthorized, 3005 server error, 3006 invalid message or inactivity, 3007 chunk duration or faster than real time, 3008 max session, 3009 too many sessions, 1011 internal. |
| Billing unit | Session duration from websocket open to end, idle included; an unclosed session bills to the 3 h cap. |

**Probes, 2026-09-30** (key from `~/.config/murage-mobile/assemblyai.key`, never printed; `say` clips, 16 kHz, from Sean's Mac; single samples):

| # | Probe | Result |
|---|---|---|
| P0 | the design-draft probe: "Blues Brothers, [1.34 s] and Heartbreak Ridge." on five configs | Token plus connect to `Begin` 2.66 to 2.95 s (0.6 s in later probes). Both `universal-streaming-english` and `universal-3-6-pro` split at defaults and tightened settings; formatting turned the comma into "Blues Brothers?"; only `universal-streaming-english` with threshold 0.95, `min_end_of_turn_silence_when_confident=1600`, `max_turn_silence=3000` kept one turn (end of turn about 2 s after speech). An empty end-of-turn Turn followed a real one. |
| P1 | `universal-streaming-english`, `format_turns=true` | `transcript` holds only finalized words; in-progress words are only in `words[]`. `utterance` appeared just before end of turn and on it. One formatted end of turn per `turn_order`. No `SpeechStarted`. A trailing empty end of turn. |
| P2 | `universal-3-6-pro` | `transcript` holds unstable words; every word stays non-final until end of turn; `SpeechStarted` is sent. |
| P3 | 3 s of audio at once after `Begin` | Accepted, no 3007; results caught up 1.3 s faster than real-time sending. |
| P4 | 40 s of audio at 20x real time | Accepted, no 3007; results arrived at about 1.3x to 2.5x real time. |
| P5 | `UpdateConfiguration` with either silence name plus `max_turn_silence` 3000 and threshold 0.95 | Both accepted; both merged the paused sentence (end of turn about 1.7 s after speech). |
| P6 | `afconvert -f WAVE -d LEI16@16000` | The WAV `data` chunk starts at byte 4088 (a `FLLR` chunk precedes it), not 44. |
| P7 | `inactivity_timeout=5` with and without `KeepAlive` every 2 s | With `KeepAlive` the session lived; without it, 3006. |

**Spike, 2026-09-30** (`stt-spike-results.md`: 63 real-time sessions, 21 fixtures × 3, voices Samantha, Daniel and Karen, 50 ms chunks, straight from Sean's Mac to AssemblyAI with no Flux hop, about 20 minutes of audio; measured unless marked):

| Measure | `universal-3-6-pro`, balanced defaults (config F) | `universal-streaming-english`, defaults |
|---|---|---|
| End of speech to final text, p50 / p90 | **661 / 703 ms** | 728 / 876 ms |
| End of speech to `end_of_turn`, p50 / p90 | **672 / 1749 ms** (the p90 is the max-silence fallback, about 1280 + 470 ms, on "Yes," or an uncertain question) | 728 / 876 ms |
| First partial after speech starts, p50 / p90 | 822 / 923 ms | 1153 / 1593 ms |
| WER (all / pause fixtures) | **0.3 % / 0.0 %** | 3.9 % / 8.6 % ("Heartbreak Ridge" came back "heartbreak") |
| Splits: no-pause / pause fixtures | 0 of 36 / **16 of 34** (every "Blues Brothers." pause at 0.8, 1.3, 2.0 s, and a 2.0 s pause after a comma; held every pause after "and", "because", "are,") | 0 of 12 / 7 of 7 |
| Connect to `Begin` | 1.32 s p50 with the key in a header; 2.2 to 2.8 s with a temporary token | same |
| `ForceEndpoint` to `end_of_turn` | 308 / 349 ms | 155 / 221 ms |

Other spike findings: `min_turn_silence` and `min_end_of_turn_silence_when_confident` behave identically on both models; `end_of_turn_confidence_threshold` has no effect on `universal-3-6-pro`, where `end_of_turn_confidence` is a silence ramp (0.3 rising to 1.0 over about 1.2 s; every end of turn reports 1.0); raising `min_turn_silence` to 1500 ms stops the Blues split but makes every turn about 1.76 s; forcing an end of turn after 600 ms of silence splits every pause fixture, while forcing only when a partial ends in `.`, `?` or `!` (not `...`) after 400 ms of silence moved the replayed p90 end of turn from 1749 to about 1000 ms with no new splits (*offline replay*); partials arrive punctuated ("Yes,", "because...", "at 6?"); provider word timestamps drift (first word after a pause about 840 ms early, word ends about 230 ms late, the first word of a session at 0); "stop" (460 ms of speech) gets its first partial about 350 ms after the word ends. The spike used synthetic voices and digital silence; Sean's own voice is the next check (F).

What this means for the design: (1) pin `universal-3-6-pro` at its balanced defaults (A.4, B.4); (2) no provider setting both avoids the "Blues Brothers." split and ends turns in under a second, so Murage relies on CallView's continuation hold (2.2 s on a trailing comma or ellipsis on the stream path) and join on top of the provider's end of turn, and the join is required (C.6); (3) the adapter builds text from `words[]` and never trusts `transcript` or `utterance`, whose meaning differs by model (A.16); (4) the provider's confidence carries no meaning, so `reason` does not pretend it does (A.6); (5) provider times are approximate, so Murage anchors every hold, merge, evidence window and fallback clip on its own frame clock and Silero (C.4); (6) Silero, not partials, is what stops the bot on "stop" (C.8); (7) the provider accepts a short burst, so a start-up backlog drains quickly (A.12); (8) a call opens its stream when the call opens and keeps it.

The owner-voice bake-off (`bakeoff-final.md`, Sean reading 25 scripted lines on his Mac, rescored by text alignment) confirms the provider choice on the voice that matters: `universal-3-6-pro` had 2.7 % WER, and end of speech to the covering final at p50 622 ms clean, 717 ms quiet, 945 ms noisy and 719 ms phone. Its p90 was 5139, 5140, 5335 and 3881 ms (clean, quiet, noisy, phone). Turn merging explains that tail but does not excuse it: the provider merged adjacent short lines into one turn, and an early line's text did not appear until the merged turn ended, a delay the owner sees. It split 3 of 8 deliberate pauses in clean, quiet and noisy, and 2 of 8 on the phone line. Line 1 scored a negative latency in clean, quiet and noisy (-907, -805 and -534 ms: the scoring VAD ended it on room noise), which is why owner results count such lines instead of dropping them. What it changes: the targets in E.4 are split into the spike's fixture gates and an owner-voice qualification (E.4, `OWNER_TARGETS`), and the late merge (C.6) is required on Sean's voice too.

### 1.3 Murage (app worktree HEAD `0efaab22`, 2026-09-30)

| Fact | Where |
|---|---|
| Flux batch client, key read per call via `fluxKey()`, base override read per call, failure vocabulary `TranscriptionFailure`. | `server/voice/flux-voice.ts:28-31`, `:127-170`, `:212` |
| `POST /api/voice/transcribe`: refused 409 while `providerConfigBusy`; counted in `fluxMediaRequests`, which the harness's busy check reads. | `server/index.ts:734-738`, `:18395-18407` |
| The harness has no websocket upgrade handler; `ws` 8.21.3 is a dependency; the `ws` client rejects a subprotocol it did not offer. | `server/index.ts`; `package.json:132`; `node_modules/ws/lib/websocket.js:966-972` |
| Door: `inboxDoor` is `desktop` only with `x-murage-surface: desktop` plus the per-launch secret, `companion` only with the companion's launch proof, else `unproven`. Desktop page calls add `desktopSurfaceHeaders()`. | `server/inbox-access.ts:40-46`, `server/sse-visibility.ts:180-192`, `src/lib/composer-image-upload.ts:8` |
| The browser door adds the launch proof only for `needsLaunchProof` routes (Inbox, call routes, image upload, presence) and refuses them without it; the device door adds only `launchProofHeaders` (owner-voice routes). | `companion/src/routes.ts:74`, `:91-123`; `companion/src/browser.ts:1719-1756`; `companion/src/proxy.ts:442` |
| The browser door runs `originGate` on every request, resolves the cookie session with `devices.resolveSession`, and registers live streams with `connected(deviceId, disconnect, sessionId)` so a revoke or sign-out ends them. | `companion/src/browser.ts:292-330`, `:1440`, `:1651`, `:2157-2230`; `companion/src/index.ts:412-417` |
| The iPhone shell loads the workspace's own origin in a WebView (the browser door, with a cookie session). `src/lib/live-events.ts:271` is the browser's own `EventSource`, not a native bridge. | `apps/mobile/ios/App/MurageShell`, `src/lib/live-events.ts:271` |
| A tunnel-fronted `managedOrigin` shares the device handler; the Vite dev proxy forwards `/api` without websockets. | `companion/src/index.ts:436`; `vite.config.ts:53-56` |
| `FrameSource` gives 16 kHz mono Float32 frames of 1024 samples (64 ms) with a sample-counted clock `at`; `toInt16` converts. | `src/lib/call-mic.ts:92-99`, `:310-428` |
| `FluxMic` (not exported): Silero-gated recording with 6-frame preroll, 850 ms endpoint, 30 s utterance cap, `private transcribe(clip, speech, endedAt)`, keeps hearing while a transcription is out (`carrying`, `queued`), drops a half-heard utterance on mute. `Capture.lines` and `.ends` are protected; muted frames never reach `frame()`. | `src/lib/call-mic.ts:115`, `:433-600`, `:615-771` |
| `CallAudio` builds the call's mic once per call; `start()`/`stop()` run per turn. | `src/lib/call-audio.ts:83-140`, `src/components/CallView.tsx:114` |
| CallView owns the end of the owner's turn: `HeldLine` holds a line that sounds unfinished (comma, ellipsis, and/but/because/so/or) for 1.2 s, waiting up to 6 s while `mic.pending()` or new speech says more is coming; `joinTurn` joins a line whose speech began within 3 s of the send with under 2 s of the reply heard, aborting that host turn and taking its history and call-log entries back, unless it already acted. | `src/lib/call-turns.ts`; `src/components/CallView.tsx:230-260`, `:881-900`, `:1269-1278` |
| The page learns voice routes from `describeVoice(cfg).routes` (`Record<VoicePart, string or null>`); the store type has no stream field. | `server/tts/index.ts:25-35`, `:180-194`; `src/state/store.tsx:505-515` |

Concurrency note: another agent commits voice fixes to `CallView.tsx`, `call-mic.ts` and `voice-host*.ts` in the same worktree. This design touches those files only at the named integration points in C.9 and keeps new logic in new files. Merge their work first; never rebase.

## A. The Flux public contract (`flux.stt.v1`)

Provider-neutral by construction: nothing in A names AssemblyAI; A.16 shows how three providers map onto it.

### A.1 Endpoint

```
GET wss://api.fluxrouter.ai/v1/audio/transcriptions/stream
Sec-WebSocket-Protocol: flux.stt.v1
```

Also mounted at `/audio/transcriptions/stream`. The contract is Flux-native and deliberately not OpenAI-compatible.

The version is the subprotocol. When the client offers `flux.stt.v1`, the server echoes it. When the client offers none, the server answers with none and serves v1 (a client library rejects a subprotocol it did not ask for). When the client offers only unknown versions, the server accepts echoing the first one (so the client can read the error), sends `error unsupported_protocol` and closes 4400. A later breaking change ships as `flux.stt.v2` side by side.

### A.2 Authentication

1. **Server-to-server (Murage harness, v1):** `Authorization: Bearer <flux key>` or `x-api-key`. Any authentication failure is 4401 (the batch route answers 401 for every failure). That includes LiteLLM's own key budget and rate errors, which LiteLLM raises inside its auth call (`BudgetExceededError` in `user_api_key_auth`), so the route cannot tell them apart without parsing messages; they close 4401 as the batch route answers 401. A key whose model list excludes `flux-voice-stream` is 4403. Flux's own prepaid and cap refusals come later, from the stream's gate, as 4402 or 4429 with their reasons (A.11).
2. **Browser-direct (v1.1, reserved):** `POST /v1/audio/transcriptions/stream/sessions` with the key mints a single-use `client_token` (1 to 300 s, default 60), bound to the minting key's account, redeemed with `?client_token=`; entitlement checked at mint and at redeem; tokens live in Redis and redeem with `SET NX` so they are single use across workers and pods.
3. Never in the query string: the key. A key-like query parameter (`api_key`, `apikey`, `key`, `authorization`, `access_token`, any case) closes 4400 `invalid_param` with `param` set to the name sent.

### A.3 Model aliases

| Alias | Meaning |
|---|---|
| `flux-voice-stream` | Default. Low-latency streaming English with semantic end of turn. |
| `flux-voice-stream-multilingual` | Reserved: `4400 model_not_available`. |

The backing provider and model never appear in any message.

### A.4 Connect parameters and config

Scalars ride the query string at connect; mutable fields can change with `session.update` (A.7). Unknown query parameters are ignored and listed in `session.started.ignored_params`.

| Param | Type, default | Rule | Mutable |
|---|---|---|---|
| `model` | `flux-voice-stream` | A.3 | no |
| `encoding` | `pcm_s16le` | only value in v1 | no |
| `sample_rate` | 16000 | 8000, 16000, 24000 | no |
| `channels` | 1 | only 1 | no |
| `language` | `en` | other ISO-639-1: `4400 language_not_available` | no |
| `partials` | true | emit `transcript.partial` | yes |
| `format` | true | casing, punctuation and number forms on `turn.end` | no |
| `words` | false | word timings on `transcript.final` and `turn.end` | yes |
| `eagerness` | `medium` | `low`, `medium`, `high` presets; `medium` is the provider's balanced defaults, `low` must pass E.4's no-split gate | yes |
| `min_silence_ms` | preset | 100 to 5000 | yes |
| `max_silence_ms` | preset | 300 to 10000, at least `min_silence_ms` | yes |
| `turn_detection` | `semantic` | `manual`: turns end only on `turn.commit`, on `max_silence_ms`, or at session end | no |
| `keyterms` | none | up to 100 terms of up to 50 chars; an empty list in an update clears them | yes |
| `idle_timeout_s` | 30 | 5 to 300 | no (the provider's `inactivity_timeout` is set from it at connect and cannot change) |
| `max_session_s` | 10800 | 60 to 10800 | no |

`session.started.config` and `session.updated.config` carry resolved values (a preset's silences filled in, never `null`) that the provider actually runs: the adapter keeps the requested configuration and the effective one apart, and an update the provider could not apply leaves the effective one unchanged. There is no provider-specific confidence knob. Mutable: `partials`, `words`, `eagerness`, `min_silence_ms`, `max_silence_ms`, `keyterms`; every other field is fixed at connect. The silences are validated AFTER the preset resolves them (explicit value, else the eagerness preset's: low 1500/3000, medium 400/1280, high 160/800, a preset maximum raised to an explicit minimum): `eagerness=low&max_silence_ms=500` would resolve to 1500/500 and is refused `4400 invalid_param` with `param: max_silence_ms`; an update that would cross them is refused non-fatally and the session keeps its previous configuration.

### A.5 Audio

- Binary frames only, raw little-endian s16 mono PCM at `sample_rate`, each 20 to 1000 ms (at 16 kHz, 640 to 32000 bytes, even). Recommended 64 ms. Over 1000 ms closes `4413 frame_too_large`; odd length or under 20 ms closes `4400 invalid_audio_frame`. A text frame over 16 KiB closes `4400 invalid_request_error`.
- The adapter re-chunks for the provider by sample rate; clients never see the provider's chunk rules.
- Audio may be sent before `session.started`. The server buffers up to 3000 ms and drops the **oldest** beyond that; the drop is reported by `warning audio_dropped` after `session.started` (which is always first).
- Control messages sent before `session.started` (`session.update`, `turn.commit`, `session.close`, `keepalive`) are held in the same ordered queue as the pre-start audio and applied in the order they were sent once the provider is up, so a `turn.commit` sent after 2 s of audio is a barrier behind that audio, not ahead of it. Oldest-first drops remove audio only, never a control message. A relay in front of Flux (C.2) keeps one ordered queue of its own for the same reason.
- Pace: real time; A.12 for bursts.
- `audio_ms` counts samples of **accepted** audio from the first accepted sample. Dropped audio is not accepted and does not advance the clock; every drop is reported with `at_audio_ms`, the accepted position where the gap sits, so a client can map its own clock onto the server's.

### A.6 Server-to-client messages (JSON text frames)

Every message has `type`, `seq` (strictly increasing by exactly 1 from 1) and `received_audio_ms` (accepted audio when it was emitted).

```jsonc
// always first
{"type":"session.started","seq":1,"received_audio_ms":0,
 "session_id":"fss_01J...","model":"flux-voice-stream",
 "config":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1,"language":"en",
           "partials":true,"format":true,"words":false,"eagerness":"medium",
           "min_silence_ms":400,"max_silence_ms":1280,"turn_detection":"semantic",
           "keyterms":["Sable"],"idle_timeout_s":30,"max_session_s":10800},
 "limits":{"min_frame_ms":20,"max_frame_ms":1000,"prestart_buffer_ms":3000,"burst_ms":3000},
 "ignored_params":[],"expires_at":1790003600}

// voice activity, before words (optional per provider)
{"type":"speech.started","seq":2,"received_audio_ms":1210,"turn":0,"audio_ms":1150}

// every word heard so far in the turn, stable and unstable; replaces the previous partial
{"type":"transcript.partial","seq":3,"received_audio_ms":1530,"turn":0,
 "text":"blues brothers","audio_start_ms":1150,"audio_end_ms":1480}

// the words that just became final; they never change
{"type":"transcript.final","seq":4,"received_audio_ms":2100,"turn":0,
 "text":"Blues","turn_text":"Blues","audio_start_ms":1150,"audio_end_ms":1490,"server_lag_ms":212}

// the turn is over; text is the whole turn, formatted
{"type":"turn.end","seq":9,"received_audio_ms":4410,"turn":0,
 "text":"Blues Brothers, and Heartbreak Ridge.","reason":"endpoint","confidence":1.0,
 "audio_start_ms":1150,"audio_end_ms":3470,"server_lag_ms":640}

// a turn the client saw open ended with no words
{"type":"turn.cancelled","seq":10,"received_audio_ms":5200,"turn":1}

// a commit that found no turn to end
{"type":"turn.committed","seq":11,"received_audio_ms":5300,"turn":null}

// every 60 s
{"type":"usage","seq":40,"received_audio_ms":60010,
 "session_seconds":60,"audio_seconds":60,"billed_seconds":60,"confirmed_seconds":0,"pending_seconds":60,
 "unit":"session_second"}

// fatal errors are followed by a close; non-fatal ones are not
{"type":"error","seq":41,"received_audio_ms":61000,
 "error":{"code":"idle_timeout","type":"invalid_request_error","message":"no audio or keepalive for 30 s",
          "fatal":true,"close_code":4408,"retry_after_ms":null}}

{"type":"warning","seq":12,"received_audio_ms":9300,"code":"audio_dropped","message":"...","dropped_ms":640,"at_audio_ms":9000,
 "ranges":[{"at_audio_ms":9000,"dropped_ms":340},{"at_audio_ms":9300,"dropped_ms":300}]}   // every separate run, in order; what is owed goes out before session.closed or a fatal error

{"type":"session.expiring","seq":90,"received_audio_ms":3570000,"closes_in_ms":30000}

// the last message of a graceful close (client_close, max_duration, going_away); not promised on a transport loss
{"type":"session.closed","seq":91,"received_audio_ms":3600000,"reason":"client_close",
 "usage":{"session_seconds":3600,"audio_seconds":3598,"billed_seconds":3600,"confirmed_seconds":3540,
          "pending_seconds":60,"unit":"session_second"}}
```

**The max_duration close sequence.** When a session reaches its maximum duration the server sends, in order: `session.expiring` with a 30 s lead (`closes_in_ms: 30000`), then at the limit `session.closed {reason: "max_duration"}`, then close 1000. A client that rolls over to a second session on `session.expiring` must also treat an unrequested `session.closed` with reason `max_duration` as the same trigger, because the expiring notice may have been missed.

`turn.end.reason`: `endpoint` (the provider ended the turn, whether on meaning or on `max_silence_ms`; the spike showed the provider's confidence cannot tell the two apart), `forced` (`turn.commit`), `session_end` (flushed at close, expiry or drain). `confidence` is the provider's number, 0 to 1 or `null`, reported for diagnostics only: on `universal-3-6-pro` it is a silence ramp that reads 1.0 on every end of turn.

**Provider times are approximate.** `audio_start_ms`, `audio_end_ms` and `speech.started.audio_ms` come from the provider's word timings (the spike: the first word after a pause about 840 ms early, word ends about 230 ms late). They order events and serve captions; clients must not time holds, merges, evidence windows or clips from them. `server_lag_ms` (the server's monotonic time from accepting the audio at `audio_end_ms` to emitting the message) inherits that error and is telemetry, as is `received_audio_ms - audio_end_ms`.

### A.7 Client-to-server messages

```jsonc
{"type":"session.update","config":{"eagerness":"low","keyterms":["Sable","Heartbreak Ridge"]}}
{"type":"turn.commit"}
{"type":"keepalive"}
{"type":"session.close"}
```

- `session.update`: mutable fields only (A.4). An immutable field gets non-fatal `config_immutable` with `param`; a change the provider cannot apply in place gets non-fatal `config_unsupported`; either way nothing changes. Success is `session.updated {config}` with the effective configuration (A.4).
- `turn.commit` is a barrier behind all audio accepted before it. If a turn is open, `turn.end reason=forced` arrives within 1000 ms plus the backlog at the commit (at most `burst_ms`); if no turn ends in that time, `turn.committed {turn: null}`. One commit is in flight at a time: a `turn.commit` sent while one is unanswered is covered by it and gets no answer of its own. The backlog is the provider work not yet delivered: queued audio, the chunk in flight, and the most padding each queued barrier can add (A.12).
- `session.close`: the server stops accepting audio the moment it reads the close (later frames are discarded, not counted in `received_audio_ms`, not billed; a close sent before `session.started` is a barrier the moment it is read: nothing after it is queued, so later audio can never evict the audio before it, and the replay of the pre-start queue ends at its place), delivers what it accepted, flushes an open turn as `turn.end reason=session_end` (or `turn.cancelled`; a turn that a `turn.commit` sent before the close had ended stays `forced`), sends `session.closed` and closes 1000 (or, if the final mark cannot complete inside the deadline because the session store fails or does not answer, the `service_unavailable` error and 4503, A.11), all under one absolute deadline of 2000 ms plus the backlog at the close. Settlement never holds the socket: the session is marked final before `session.closed` is sent and the ledger write completes after (A.14).
- Unknown `type`: non-fatal `unknown_message_type`. Malformed JSON: non-fatal `invalid_json`. The fifth non-fatal protocol error closes `4400 too_many_protocol_errors`.

### A.8 Partial, final and end-of-turn semantics

1. `transcript.partial` is a guess: every word heard so far in the turn. The next partial of the same turn replaces it. For barge-in and captions, never as input to an LLM.
2. `transcript.final` carries only words that just became final. They never change or disappear. `turn_text` is all the turn's finals so far.
3. Before `turn.end`, the server sends a final for every word of the turn not yet final. `turn.end.text` is the formatted rendering of exactly the turn's finals: formatting may change case, punctuation and number forms (`twenty five` to `25`), never add or drop spoken words. **The text is complete when `turn.end` arrives.** The end the provider reports, with words or with only text, is reconciled with the finals already sent in spoken form: only what comes after them is new, one formatted word may cover a final and a new word (`25` after the final `twenty` adds `five`), and an end that contradicts them, or whose transcript disagrees with its own words, leaves them standing (A.16).
4. Turns start at 0 and advance by 1 on each `turn.end` or `turn.cancelled`. After either, nothing more arrives for that turn.
5. A provider turn with no words never produces `turn.end`. If the client saw that turn open (`speech.started`, a partial or a final), it gets `turn.cancelled`.
6. `speech.started` is optional per provider; when sent, it precedes the turn's first partial.

### A.9 Keepalive

- The server sends websocket ping frames every 20 s. They keep nginx's read timeout and Cloudflare's idle limit from closing a quiet session.
- A client that sends no audio (muted) sends `{"type":"keepalive"}` at least every `idle_timeout_s / 2`. The server keeps the provider session alive (AssemblyAI `KeepAlive`, which P7 shows resets the provider's inactivity clock).

### A.10 Idle and session limits

| Limit | Default | Behaviour |
|---|---|---|
| Idle | 30 s (`idle_timeout_s`) | no audio and no `keepalive`: `error idle_timeout`, close 4408 |
| Max session | 10800 s (3 h) | `session.expiring` 30 s before; at the limit the open turn is flushed, `session.closed {reason: max_duration}`, close 1000. Clients that need longer open a second session and switch. |
| Startup | 10 s from the websocket upgrade to `session.started` having been sent, covering auth, admission, the first lease, the provider connect, the startup write and the send of the `session.started` frame | `error upstream_timeout`, close 4504, sent before any cleanup; cleanup is bounded separately and what it cannot finish stays for the recovery loop |
| Provider stall | a turn is open, audio delivered to the provider is ahead of the provider's progress (the furthest audio position its partials, finals, turn ends and speech starts report; each event advances it only through the audio it acknowledges, so neither a partial nor a turn end covers audio delivered after it), and that progress has not moved for 10 s plus the `max_silence_ms` in effect now, whatever the client sends meanwhile | `error upstream_timeout`, close 4504 |
| Concurrency | 4 per account | `4429 concurrency_limit` |
| Fleet capacity | open sessions and session starts per minute across all accounts (200 and 90 by default), set so the meter rows they create stay within the outbox drainer's measured capacity (A.14) | `4503 service_unavailable` with `retry_after_ms` |
| New connects | 30 per minute per account | `4429 rate_limit_error` |
| Seconds | 36000 billed seconds per rolling hour per account | `4429 seconds_limit` at connect or a lease renewal |

### A.11 Errors and close codes

Rule: the close code is **4000 + the HTTP status Flux would return for the same condition**, and `error.code` is the string Flux already uses. Every fatal condition sends `error` first, then closes. Conditions found before the session starts (auth, dark, entitlement, params) are reported the same way: the server accepts the upgrade, sends `error`, closes. Only a mount failure may answer the handshake with HTTP 503 and the Flux JSON envelope, which conformance treats as `4503`.

| Close | `error.code` | `error.type` | When | Client should |
|---|---|---|---|---|
| 1000 | (none; `session.closed` first) | | `session.close`, max session | done |
| 1001 | (none; `session.closed {reason: going_away}` first) | | server draining for a deploy or scale-down | reconnect now |
| 1012 | (sent by the server runtime on an abrupt restart) | | restart without a drain; the open turn was not flushed | reconnect; the open turn is lost, as after 4502 |
| 1006 | (no close frame) | | transport loss (network, an edge restart) | as 4502 |
| 4400 | `invalid_request_error`, `unsupported_protocol`, `invalid_audio_frame`, `model_not_available`, `language_not_available`, `too_many_protocol_errors`, `invalid_param` | `invalid_request_error` | bad input | fix, do not retry |
| 4401 | `unauthorized` | `invalid_request_error` | missing, bad, blocked or revoked key; bad or used client token | re-auth |
| 4402 | `premium_locked` | `invalid_request_error` | plan does not include streaming STT | upgrade prompt |
| 4402 | `billing_unavailable` | `invalid_request_error` | a plan or pay-as-you-go account Flux would meter on Stripe has no Stripe customer on this key, at connect or a lease renewal | batch transcription for the call; no error shown |
| 4402 | `credit_unresolved`, `credit_exhausted`, `daily_cap`, `monthly_cap` | `invalid_request_error` | Flux's prepaid gate, at connect or a lease renewal, as for a chat or batch request (`credit_exhausted` at zero balance) | top-up or cap prompt |
| 4403 | `forbidden` | `invalid_request_error` | key restricted from `flux-voice-stream` | settings prompt |
| 4404 | `not_found` | `invalid_request_error` | capability dark | treat as unavailable |
| 4408 | `idle_timeout` | `invalid_request_error` | A.10 | reconnect when audio resumes |
| 4413 | `frame_too_large` | `invalid_request_error` | frame over 1000 ms | fix |
| 4429 | `rate_limit_error`, `concurrency_limit`, `seconds_limit` | `rate_limit_error` | per-account gates | retry after `retry_after_ms` |
| 4500 | `internal_error` | `api_error` | Flux bug | retry once |
| 4502 | `capability_unavailable` | `api_error` | provider error at connect or mid-session | retry once, then fall back |
| 4503 | `service_unavailable`, `slow_consumer` | `api_error` | overload, drain in progress, mount failure, the session store unavailable (at startup, mid-session or at the close, failing or not answering in time: then this error and 4503 replace `session.closed`; mid-session this includes no elapsed checkpoint confirmed for 10 s of billable time), client not reading | retry with backoff |
| 4504 | `upstream_timeout` | `api_error` | provider did not start or stalled | retry once, then fall back |

Non-fatal codes: `config_immutable`, `config_unsupported`, `unknown_message_type`, `invalid_json`, `invalid_param` (in an update). A mid-session provider failure is never papered over by reconnecting the provider inside the same Flux session (words in flight would vanish without a signal); the client decides (C.7).

### A.12 Backpressure

- **Client to server:** admission is a credit bucket of `burst_ms` (3000 ms): it refills at real time up to that cap and each accepted frame spends its length, so a client can run at most `burst_ms` ahead of real time however long it was idle before (a minute of silence banks no more than 3 s), and the backlog in front of the provider never exceeds what the provider pacer drains within the commit and close deadlines. After `session.started` the bucket holds `burst_ms` less the replayed pre-start audio. A frame is also refused while the provider work not yet delivered (the adapter's own count: queued audio, the chunk in flight, and for each queued barrier the most silence it can pad a short tail with up to the provider's 50 ms minimum, since pacing can leave any tail under 50 ms in front of it) plus the frame, plus one barrier's padding kept free for a commit, update or close that may follow, would pass `burst_ms`, so no mix of frames, commits, updates and keepalives can grow the queue past it. Keepalives never queue (one at most is due, sent ahead of the queue, padding nothing), consecutive updates merge, repeated commits coalesce, and controls cost no pacing time. The pre-start queue is replayed against the same bound. Beyond it the newest audio is dropped with `warning audio_dropped {dropped_ms, at_audio_ms, ranges}` at most once a second (`ranges` lists every separate contiguous dropped run since the last warning, so a client maps its positions exactly), and whatever is still owed goes out at once before `session.closed` or a fatal `error`; the server never closes for a burst.
- **Server to provider:** audio goes out as soon as 50 ms is buffered, in chunks of at most 1000 ms, never more than `burst_ms` ahead of the provider's clock since its session began. A start-up or burst backlog therefore drains at once (P3, P4) instead of adding its length to every later turn. The lead is a credit bucket capped at `burst_ms`: idle time adds credit only up to the cap, so a long silence never banks a larger burst. Commit and close are barriers behind queued audio. A tail shorter than the provider's minimum chunk is padded with silence; each padding is recorded, and provider times after it are mapped back to accepted-audio time (`audio_*_ms` never counts padding), so a commit does not shift later timestamps.
- **Server to client:** one ordered outbound queue per session, one writer. Over 256 KiB queued, an older queued partial of a turn is dropped when a newer one of the same turn is queued; finals, `turn.end`, `turn.cancelled`, `error`, `usage` and `session.closed` are never dropped. Over 1 MiB queued: `4503 slow_consumer` (the only case that discards queued finals, because the client is not reading them). A message already handed to the socket is never lost to a later drop; terminal messages (`error`, `session.closed`) are written in order before the close frame, within the close deadline; after a disconnect the writer and its queue are disposed. Lease renewal and limits never wait on a client send.

### A.13 Plan gating

Capability kind `audio_transcription_stream`. Dark unless `the router cap audio stream switch=true` AND `FLUX_PLAN_BASED_ACCESS=true`. Entitled via `_capability_entitled("audio_transcription_stream", ...)`; free or uncleared keys get `4402 premium_locked` before any provider session. An unpriced capability is refused 4502 before any provider session.

### A.14 Billing and metering

- **Unit: the session-second.** Billed seconds = `max(10, ceil(session_seconds))`, a session running from `session.started` to its end. A client that leaves before `session.started` is not billed (the provider socket is closed at once; Flux absorbs the connect time). **Billing time begins when the writer confirms the `session.started` frame was sent**: the monotonic clock is read there, with a wall-clock anchor read at the same moment to date the meter events; the startup write before it (which must be confirmed first) and the send itself are never billed. A startup that fails or is cancelled, the startup write's answer lost included, is read back and settled at zero, since it never activated. The end is captured once, when the session ends: the close answered (`session.closed`), a fatal error decided, or the client gone; the provider close and cleanup after it are never billed. That end is an immutable billing cutoff, written durably first by cleanup's one protected task, which cleanup creates before it awaits anything and which no cancellation of the request stops. No later write, whether a renewal finishing late, a heartbeat or a delayed save, can extend billable time, and recovery bills through the cutoff when it was written (the exact end), else through the larger of the last persisted elapsed seconds and the last elapsed checkpoint. **Billable time is a duration on a monotonic clock**, measured by the live process from the billing origin and persisted as elapsed seconds with every heartbeat, renewal and final mark, and every 5 s as an **elapsed checkpoint** on its own key, written without the meter's lock, so a renewal or settlement in flight never delays it; one script fences it by ownership (a recovery claim) and by the cutoff, and only ever raises it. The cutoff is the elapsed seconds at the end. **A crash loses at most 10 s of billable time, exactly:** the meter never bills more than 10 s (two heartbeats) past the last checkpoint the store confirmed, and when it reaches that bound (the store down or not answering) the session stops with `service_unavailable` and 4503 rather than serve time a crash could not bill; while the store answers, a crash loses at most 5 s plus one write's round trip. A wall-clock step on any machine (NTP, an operator) never changes the bill: recovery bills only from those persisted durations and never subtracts one wall-clock time from another. Wall-clock times are kept for liveness (the heartbeat a recovery claim tests) and to date the meter event. A session is billed, live or by recovery, only once its **activation write** has landed, and that write waits for the writer to confirm the `session.started` frame itself was sent (handed to the socket), inside the startup deadline: a send that fails or blocks past the deadline, or a process that dies before it, bills nothing, and one that dies between the send and the activation write goes unbilled too (a crash-only window of milliseconds, on the customer's side).
- **Every paying account streams** (owner's ruling), each lease billed on the channel Flux bills that account's other usage on. When a lease is reserved, Flux's own prepaid gate decides it, exactly as for a batch audio request (both overflow flags on: it reserves the lease's estimate and answers armed, unarmed or a refusal; flags off: unarmed), and the answer is stored with the lease and never re-evaluated, recovery included. `stripe_meter` (plan or pay-as-you-go accounts Flux meters): the ledger row, then a Stripe meter event through the outbox; it needs a Stripe customer on the key, else `4402 billing_unavailable` and the client uses batch. `prepaid` (accounts Flux draws from prepaid credit): the ledger row only, left undrawn; the stream never draws. The lease's credit reservation uses Flux's shared reservation policy (600 s by default), as chat does, never a shorter stream-specific TTL, because Flux applies the caller's TTL to the account's whole reservation set; the sweep's draw releases it. The on-behalf path (an MCP gateway billing a customer's account) resolves a prepaid account without a Stripe customer too (an opt-in change to Flux's resolver), keeping its authenticity, revocation and entitlement checks. Flux's existing undrawn-row sweep draws it at its exact sale with the same code as a chat row: the month's included allowance first, then rollover, then funded credit, clamped to the funded and cap headroom with Flux absorbing any excess, and a fence if the draw fails. A prepaid account at zero balance is refused at admission with `4402 credit_exhausted`, as a chat request is. Because a stream never draws inline it never reaches Flux's salvage path. Each row stores its channel (`capability_kind` `audio_transcription_stream` or `audio_transcription_stream_prepaid`), and one Flux change makes the sweep and the orphan-fence self-heal select stream rows by it: a Stripe row is never drawn even if the account arms later, a prepaid row is drawn even if it disarms, and every other row keeps today's rule. The sweep must run every minute to keep up with prepaid streams (hand-off Task 6 Step 9).
- `usage` every 60 s and in `session.closed` reports `session_seconds`, `audio_seconds` and three distinct billing amounts: `billed_seconds`, what the session has accrued under the billing rule (what it will be charged); `confirmed_seconds`, what the ledger had rows for when the message was sent (a row whose meter event or prepaid draw is still being settled counts); and `pending_seconds`, the difference, still being recorded. `session.closed` goes out inside the close deadline, so its `pending_seconds` is usually the last lease; that charge is then settled exactly once after the socket closes. Nothing is ever reported as confirmed that the ledger has not confirmed.
- Flux meters in **leases** of 60 s. Lease `n` covers a contiguous range of session-seconds and has one id, `{session_id}:{n}`, pinned before it is reserved; that id is also the ledger `request_id` and the meter `identifier`, so one range can only ever be charged under one key. Each lease is reserved against the per-account seconds cap, then given its channel as above, and is priced from its own metadata (FS-01); nothing reads the rollout flags at settlement.
- **Settlement is exactly once.** Each session has one Redis record (`flux:cap:stream:sess:{sid}`) holding its leases (`n`, channel, `through`), the seconds-cap settlements still owed, `session_start` and `activated`, `settled_through`, a write-ahead `pending` charge, `closed` and the owning worker, changed only by a compare-and-set on its version and owner. At a renewal the next lease is reserved first; then the finished lease is marked in the record as `pending {n, units, through}` (units = `settled_through(through) - settled_so_far`, whole seconds at renewals, the ceiling with the 10 s floor at the close, so rounding never accumulates and the ranges are contiguous); only then is the ledger written under that lease's id. `settled_through` advances and `pending` clears only after the ledger write (and, for a Stripe lease, the outbox row) is confirmed. A crash at any point leaves either nothing charged and the pending mark, or the charge written and the pending mark: in both cases a retry writes the same id, which `record_charge`'s `ON CONFLICT (request_id)` and the outbox's unique identifier make a no-op if it already landed. No second id can ever cover the same seconds.
- **Settlement runs in persisted stages.** A pending charge moves `ledger` (the row under its id, which for a prepaid lease is the last stage) to `meter` (Stripe leases: the Stripe meter event inserted into Flux's durable meter outbox, `flux_stripe_meter_event_dlq`, keyed by the same id, carrying the ORIGINAL event time fixed at write-ahead, and due at once). Each stage is saved before the next begins, so a crash re-runs at most the one step in flight, and each step is idempotent. **The stream never posts to Stripe.** The outbox drainer (`the Flux router's stripe dlq retry helper`, one CronJob with `concurrencyPolicy: Forbid`) is the single delivery owner: it checks each event's age before posting, posts with the identifier and original time, retries at most 12 times inside Stripe's identifier window (it stops at 23 h, since Stripe deduplicates identifiers for at least 24 h) and marks anything undelivered after that dead for reconciliation, so no post of a charge can happen outside that window. Revision 5 had the inserting process post at once as well; that second writer had no age check and no fence against the drainer and is withdrawn. Because every stream row goes through the drainer, its operation is a deployment requirement (hand-off Task 6 Step 8): migrations present, current image, every minute with a 1000-row batch, and **concurrent posting** (required; serial posting manages about 180 rows a minute). The stream creates one row per open session per minute and one per finished session; fleet-wide bounds on open sessions and session starts (200 and 300 a minute by default, 4503 beyond them) cap that at 500 rows a minute, and per account the existing 4 sessions and 30 connects a minute cap it at 34. The drainer's measured capacity must be at least twice those bounds plus Flux's existing DLQ peak, or the bounds are lowered before enabling. Two alarms, each qualified on purpose: overdue (the oldest due row waiting over 10 minutes) and unresolved age (any undelivered row over 1 hour old), plus an owner for dead rows.
- **The seconds cap is settled exactly once too.** Each marked lease owes a seconds-cap settlement (reservation to used units, idempotent on the lease id); one Redis refuses stays owed in the session record and is retried, and the record is not deleted while one is owed. The session record is the one authoritative copy: a save updates it in place and every transition is asserted in Redis by the tests.
- **A failed ledger write is not billed.** It stays `pending` and is retried at every heartbeat and by recovery; it counts in `pending_seconds`, never in `confirmed_seconds`. A Stripe-channel call continues and ends 4503 after three consecutive failed renewals; a prepaid-channel call with a charge still unrecorded at the next renewal ends 4402 `credit_unresolved`, since the sweep cannot draw what the ledger does not hold. The record is deleted only when the session is closed and fully settled; a record with anything owed is never deleted.
- A refused renewal marks the finished lease as the last one and ends the session with `4402` or `4429`, at most 60 s after the account ran out.
- **Crashes and recovery:** the owner refreshes the record's heartbeat every 5 s. Every worker runs a recovery loop (started from the registrar's startup hook and again by the route on first use, so it runs even on a worker that never served a stream) every 15 s: one Lua script atomically claims records whose heartbeat is over 30 s old (or that closed with charges owing), for 60 s, so two workers never recover the same record and a recoverer that dies releases its claim. The claimant settles the pending charge and bills the rest through the durable cutoff if the session had ended, else through the larger of the elapsed seconds the last heartbeat, renewal or mark persisted and the last elapsed checkpoint (at most 10 s short, as above), under the next contiguous id, then deletes the record only once `settled_through` covers it. A live session whose record was claimed loses ownership at its next compare-and-set (`LostOwnership`) and closes 4503 without charging. The provider session of a crashed pod ends within `idle_timeout_s + 15` s (`inactivity_timeout`).
- **Mid-call batch fallback** (C.7) bills the recovered turn's audio on the batch route although the stream session also billed that time. It is bounded: at most one turn of at most 30 s per fault, and at most two faults per call (StreamMic's `MAX_FAULTS`), so at most 60 s per call. It is disclosed and accepted; no billing bypass exists.
- The rate lives in `capability-pricing.yaml` and is Flux's decision.

### A.15 Logging and privacy

- No audio anywhere but memory; freed at close.
- Transcripts are never logged. Logs carry session id, account id, alias, counts, close codes and latencies only.
- `ticket`, `client_token` and `keyterms` query values are redacted in every access log (ingress, ASGI, companion, harness).
- The provider's session id stays internal, in a restricted ops log for disputes.
- Provider retention and training settings are confirmed and written down before launch (G.3).

### A.16 Provider neutrality check

| Contract | AssemblyAI v3 | Deepgram live (reference, re-verify when built) | OpenAI realtime transcription (reference) |
|---|---|---|---|
| binary PCM | binary audio 50 to 1000 ms (adapter re-chunks by rate) | binary audio | `input_audio_buffer.append` base64 |
| `speech.started` | `SpeechStarted` when the model sends it (P2), else the first word (P1) | `SpeechStarted` | `input_audio_buffer.speech_started` |
| `transcript.partial` | all of `words[]` joined, final and not (never `transcript`, P1/P2) | `Results` with `is_final: false` | `...transcription.delta` |
| `transcript.final` | the leading run of `word_is_final` words not yet sent (never `utterance`) | `Results` with `is_final: true` | `...transcription.completed` |
| `turn.end` | `Turn` with `end_of_turn: true`, deduplicated per `turn_order` (formatted one preferred, 300 ms wait); `reason: endpoint` | `speech_final` or `UtteranceEnd` | `committed` plus `completed` |
| `turn.cancelled` | an opened turn's end of turn with no words, no text and nothing already final (tentative words are never promoted) | a `speech_final` with no words | `committed` with an empty transcript |
| an end of turn, with words or with only text | reconciled with the finals already sent, which are immutable and kept apart from the provider's later hypotheses, in spoken form (the bake-off's normalization: "25 dollars" after the finals "twenty five" adds "dollars"; after the final "twenty" alone, "25" covers it and adds "five"); only what comes after them becomes a final and `turn.end` carries the end's text, provided that text agrees with the end's own words in spoken form; an end that contradicts the finals, or whose transcript disagrees with its words, leaves them standing, `turn.end` carries their text, and the adapter counts the conflict, so the finals and the end always agree. A formatted end's words are never finalized by position | | |
| `turn.commit` | `ForceEndpoint` behind queued audio | `Finalize` | `input_audio_buffer.commit` |
| `session.update` | `UpdateConfiguration` (both silence names) | `config_unsupported` (no in-place update) | `transcription_session.update` |
| `keepalive` | `KeepAlive` | `KeepAlive` | (nothing) |
| `session.close` | `Terminate` then `Termination` | `CloseStream` | close |
| `eagerness` | `universal-3-6-pro`: every eagerness sends `min_turn_silence` and `max_turn_silence` resolved from the preset (medium 400/1280); the threshold is never sent and the legacy name is never sent | endpointing and utterance-end settings | `semantic_vad.eagerness` |

## B. Flux implementation design (summary; the hand-off has the code)

B.1 **Registrar** `the Flux router's streaming audio registrar` (the `CustomLogger` pattern): first appends both stream paths to `LiteLLMRoutes.openai_routes` so non-admin keys pass LiteLLM's route check (as `fetch_route_registrar` does for `/v1/fetch`); imports the provider bootstrap and fails the mount if the configured provider is missing; mounts the websocket routes front-moved; evicts LiteLLM's `/v1/realtime` and `/realtime` websockets in favour of a 4404 refusal and alarms on any other websocket route; self-checks ownership with a websocket scope; on failure installs a websocket endpoint that closes 4503.

B.2 **Route** `the Flux router's streaming audio route`, order: accept with the A.1 subprotocol rule; dark guard (4404) and drain (4503); key in the URL (4400); auth through a scope adapter carrying a `{"model":"flux-voice-stream"}` body (4401, or 4403 for a restricted key); on-behalf resolution into one effective billing identity (4402 fail closed); params (4400); entitlement (4402); price (4502); admission through `the Flux router's streaming audio gate` (connects per minute, concurrency as per-session sorted-set members with heartbeats; 4429); the client reader starts (pre-start buffer); first lease (seconds cap and prepaid gate; 4429 or 4402); provider connect with a 10 s deadline, cancelled if the client leaves (4504 or 4502); `session.started` (billing begins when its send is confirmed); then provider pump, ticker (idle, commit deadline, stall, expiring, max session, usage, lease renewal, 5 s heartbeat with pending-charge retry, drain), the elapsed checkpointer (every 5 s, never behind the ticker; 4503 when none is confirmed for 10 s of billable time) and one outbound writer. Control messages that arrive before `session.started` join the pre-start queue in order (A.5). A graceful close stops intake at once and runs under one absolute deadline; the session is marked final before `session.closed`, and the ledger write happens after the socket closes. `finally`: close the provider, mark and drain the metering (idempotent), release the slot; a `LostOwnership` closes 4503 without charging.

B.3 **Provider interface** `the Flux router's streaming audio provider`: `connect(config)`; the session's `send_audio`, `commit`, `update` (returns false when it cannot apply), `keepalive`, `effective_config`, `close(deadline)`, and an event iterator ending in exactly one `closed` or `error`. A registry filled by an explicit bootstrap module picks the provider from `FLUX_AUDIO_STREAM_PROVIDER`.

B.4 **AssemblyAI adapter**: `speech_model=universal-3-6-pro` pinned (spike); the account key rides only the `Authorization` header of Flux's server-to-server websocket (no temporary token: 1.32 s to `Begin` against 2.2 to 2.8 s); A.16's mapping rules; an ordered sender with rate-derived chunks, a 3 s lead cap over the provider clock, barriers for commit and close, and silence-padded tails; `inactivity_timeout = idle_timeout_s + 15`; cancellation-proof connect; close codes 1008 to 4502 with an ops alarm, 3009 to 4503, 3005 and 1011 to 4502, 3008 to a normal flush.

B.5 **Metering** `the Flux router's streaming audio metering`: A.14's leases on the existing spine (`record_charge` per lease with `request_id = {session_id}:{n}`, `capability_kind="audio_transcription_stream"`, a fresh metadata copy per lease; per lease either an outbox row (Stripe) or an undrawn row for Flux's sweep (prepaid), on the channel stored at reservation, and the channel-aware sweep change in Flux), one session record per session with a write-ahead pending charge, compare-and-set on version and owner, and a per-worker recovery loop with an atomic claim (started by the registrar and by the route). A failed ledger write stays pending, never reported as billed. The batch gate module is untouched.

B.6 **Config and deployment**: flags `the router cap audio stream switch`, `FLUX_AUDIO_STREAM_PROVIDER`, `ASSEMBLYAI_API_KEY` (secret), `FLUX_AUDIO_STREAM_MAX_CONCURRENT_PER_ACCOUNT` (4), `FLUX_AUDIO_STREAM_MAX_SECONDS_PER_HOUR` (36000), `FLUX_AUDIO_STREAM_CONNECTS_PER_MINUTE` (30), `FLUX_AUDIO_STREAM_CLIENT_TOKENS` (false), `FLUX_AUDIO_STREAM_TEST_FAULTS` (staging only). A dedicated Ingress for the stream paths with 3700 s timeouts and per-IP limits only if the controller restores the client address behind Cloudflare. Cloudflare websockets on, pings verified through the public hostname. The image decides the `websockets` version (13.1.0 beside LiteLLM 1.67.4, whose proxy extra also caps uvicorn below 0.30; 15.0.1 with uvicorn 0.54.0 in the LiteLLM 1.92.2 image Flux built on 2026-09-30); Flux requires `websockets>=13.1,<16` and never pins it, and the adapter's `websockets.asyncio.client` tests pass on both 13.1.0 and 15.0.1. uvicorn runs with `ws=auto` (which picks `websockets`) and its default 20 s pings, as `proxy_cli` passes no ws arguments; the built image is checked. Drain: the `preStop` hook writes PID 1's start time (field 22 of `/proc/1/stat`, the container's boot identity) to `/tmp/flux-drain` before its existing 15 s sleep; a worker drains only when the file's value equals its own container's PID 1 start time, so a file left by a previous container in the same pod (`/tmp` is an `emptyDir`, `the router deployment manifest:917-921`, which survives a container restart) never drains a fresh one. Every worker drains its sessions (flush, mark final, `session.closed {reason: going_away}`, 1001) within a second or two; grace stays 60 s.

B.7 **Tests**: pytest with `TestClient.websocket_connect`, a scripted provider, `fakeredis[lua]`, the real `litellm_auth_shim` for auth (unrestricted, restricted and blocked keys), money-per-lease assertions, the mapper against recorded probe sequences, then Murage's conformance suite against staging in acceptance mode.

## C. The Murage side

### C.1 Shape

```
iPhone engine / WebAudio
  -> FrameSource (16 kHz Float32, 64 ms)
  -> StreamMic (extends FluxMic): Silero, voice gate, 30 s ring, start queue, batch hand-over
       -> StreamUplink (a fresh page websocket per connect, Int16 frames, contract A)
            -> companion browser door (origin gate, cookie session, revocation, principal stamp, launch proof)
                 -> harness /api/voice/stream (ticket bound to principal, budget, relay)
                      -> FluxStreamClient (Bearer Flux key) -> Flux (or the simulator)
CallView: HeldLine and joinTurn own the end of the owner's turn on both transports.
```

The page speaks contract A to the harness; the harness relays it to Flux. One schema module (`shared/flux-stream-contract.ts`) serves the page, the harness, the simulator and the suite.

### C.2 Harness websocket route (`server/voice/stream-route.ts`)

- `POST /api/voice/stream/ticket`: needs a proven door. The desktop proves it with the surface headers and per-launch secret; the companion with its launch proof, which it now adds for this route on both doors (the ticket route joins `needsLaunchProof` and `launchProofHeaders`). The companion also stamps `x-murage-stream-principal` (`companion:<deviceId>:<sessionId>`, any client copy stripped), trusted only with the launch proof. Returns `{ticket, expiresInMs: 30000, path: "/api/voice/stream"}`; the ticket is 32 random bytes, single use, bound to the principal. Refused 409 when there is no Flux key, streaming is off, or the harness is changing credentials or stopping; 429 when the principal already has a stream (unless it is expiring and asks for its replacement slot) or the hour's seconds are reserved.
- `GET /api/voice/stream?ticket=...` upgrade from `server.on("upgrade")`: loopback Host, an allowed Origin (the same Host and Origin checks as the HTTP gate), path, and a ticket that is valid, unused and bound to this principal. The companion's upgrade carries launch proof; the desktop page's upgrade is proven by its ticket (single use, 30 s, minted only under desktop proof, bound to that principal), and the desktop secret never travels in the websocket URL. A bad ticket: accept, send `error unauthorized`, close 4401.
- Budget (`createStreamBudget`): per principal 1 open stream plus 1 replacement while its stream is expiring; per harness 2 plus 1 replacement; 3600 session-seconds per rolling hour, reserved a 60 s lease at a time; each renewal settles the stream's cumulative seconds since it started (`through` minus `startedAt`, never a per-lease rounding), so open streams count and a 126 s stream is charged 126 s, not 180; the ticket route only reads it.
- Relay: the page's `message` and `close` listeners are attached synchronously in the upgrade callback; page frames and page JSON share one ordered early queue until Flux is open, then flush in order (a `turn.commit` sent after audio stays behind that audio) (past 3 s queued, the harness stops reading the page, so the page's own uplink drops what it cannot send and knows it); a page close during the Flux handshake aborts it. Page binary frames go to Flux unchanged; page JSON is allowlisted (`session.update` with `eagerness`, `keyterms`, `min_silence_ms`, `max_silence_ms`; `turn.commit`; `keepalive`; `session.close`). Flux messages go to the page unchanged. Harness-originated errors take the next `seq` after the last one forwarded and the last `received_audio_ms`. When Flux's socket has over 1 s buffered, the harness pauses reading the page until it drains (the page's uplink then drops frames it knows about, so its clock stays exact); it closes the page 4503 `slow_consumer` when the page's socket has over 1 MiB buffered. Page messages over 64 KiB are refused. The harness never reconnects to Flux: the page owns fallback policy.
- A credential change or a harness stop closes open streams (each relay has a 2 s deadline: if Flux has not closed by then, the harness closes Flux itself, sends `session.closed {reason: going_away}` if none was relayed, and closes the page 1001; shutdown runs this as its earliest job and awaits it, and from that moment no ticket opens a stream) with `session.closed {reason: going_away}` and 1001 (a `session.closed` Flux sends during that close has its reason rewritten to `going_away`, so the page reconnects rather than falling to batch); the page reconnects and the harness reads the key again. The fence covers streams still connecting: each relay registers its close handler before it awaits the Flux handshake, and a ticket is revalidated at redemption (streaming still on, a key present, the harness not changing credentials or stopping), so a stream redeemed during a change closes 4503 instead of opening on the old key. Streams never count as "busy" (an hour-long call must not block a credential change).
- Test faults for real Flux: when `MURAGE_FLUX_TEST_FAULT` is set and `MURAGE_FLUX_STREAM_API` points at any host other than `api.fluxrouter.ai` (an exact host check), the relay adds `flux_test_fault=<value>` to the connect query; never for production.
- The Flux key is read per connect and sent only as `Authorization: Bearer`. Content-free logging (`[voice-stream] open door=companion`, `close code=4402 billed=37s`); the ticket is redacted in any logged URL.

### C.3 Server-side Flux stream client (`server/voice/flux-stream.ts`)

`openFluxStream({key, query, env, signal})`: base URL from `MURAGE_FLUX_STREAM_API` read per call, default `wss://api.fluxrouter.ai/v1`; `ws` with `protocols: ["flux.stt.v1"]`, `headers: {authorization}`, `maxPayload: 1 MiB`; 10 s handshake deadline; an `AbortSignal` terminates a pending handshake; every server message parsed with the shared schema (unparseable ones counted, never forwarded). Close codes map to `TranscriptionFailure` (`4401` auth, `4402` premium, `4403`/`4404` unavailable, `4429` rate_limit, `4400`/`4413` format, others upstream).

### C.4 FrameSource tee and StreamMic (`src/lib/stream-mic.ts`)

`StreamMic extends FluxMic` (`FluxMic` becomes exported). It is built by `call-audio.ts`, never by `call-mic.ts`, so there is no import cycle (a class that extends an import cannot be evaluated while that module is still loading). It keeps everything FluxMic does and adds:

- **Ring:** every captured frame goes to a 30 s ring (FluxMic's utterance cap) with its Silero verdict, its capture time (`capturedAt`, supplied by the frame source: the native source stamps each frame from its event's arrival less the audio after it in that event, so frames delivered together keep their spacing, none is stamped after it arrived, and a hold shifts nothing because nothing carries between events; a web source's frame arrives when it was captured), wall time and, once sent, its stream position and the uplink it went to. Frames captured before the uplink is live wait in a 3 s start queue (oldest dropped) and are sent when it opens; a frame the uplink refuses under backpressure stays in the ring, marked unsent.
- **Clock:** all timing is Murage's own. The owner's utterance starts at the Silero voice-gate start and its speech ends at the last Silero speech frame, both read from the ring by capture time.
- **Ownership (Revision 4, from running the code):** StreamMic's own timestamp is `lastHeardAt` (HEAD's `Capture` has a private `lastSpeechAt` on another clock). Each ring frame records the stream it was sent on and its position there (ms sent on that stream before it), or stays unsent. `attach()` installs a stream's state and ownership before subscribing to it, because subscribing flushes the messages the uplink held. A mute drops audio still waiting in the start queue, so nothing said before it is sent after it. Connects in flight are owned from the start: a hold or hang-up closes them, and closing cancels the ticket fetch or handshake (C.5).
- **Ownership (Revision 5):** an utterance belongs to the stream its first SENT frame went to, at that frame's position, so an onset dropped from the start queue or refused under backpressure never leaves it unowned; a provider end that arrives while Silero still has the utterance open marks it consumed (owed no line), and speech that resumes makes it a continuation, timed and owned from there; `turn.cancelled` removes only its own stream's earliest ended utterance; a mute with speech sent but no provider turn yet commits and records a discard by position, which the provider's answer settles (C.7), so the next turn is never swallowed; server drop ranges map positions exactly.
- **Utterances:** each Silero utterance is a span of its own (start, last speech, the stream positions it covers, and the uplink it was sent on). A `turn.end` is matched only to utterances sent on its own uplink, and of those to the ones that began before its `audio_end_ms` on the server's clock (else its earliest the server had received; server drop ranges shift positions), so a late end of turn that arrives while the owner has started the next utterance times and evidences the earlier one, never the one in progress. State that belongs to a connection (turn numbering, pending commit, positions, drop counts) lives in a per-uplink `StreamState`, never on StreamMic, so a replacement or reconnected uplink starts clean and cannot inherit the old one's turn.
- **Listening:** after a reconnect, StreamMic is listening again as soon as the new uplink is live; lines queued while it was connecting are delivered in order, so the first two lines after a reconnect both reach CallView. Provider times (`audio_*_ms`) are used only to order messages, never to time anything (A.6, the spike). Stream position counts frames handed to the uplink, and server drops are reported with `at_audio_ms`, so the number of frames that reached the provider is known.
- **Lines:** a partial becomes `MicLine {text, partial: true, speech}` while live (speech evidence over the ring frames since the utterance's Silero start). Each `turn.end` becomes one final `MicLine {text, partial: false, speech, endedAt}` (`endedAt` = the wall time of the utterance's last Silero speech frame) followed by `MicEnd {code: 0}`, the sequence FluxMic emits today. `turn.cancelled` ends the turn with no line. The local voice-gate start emits "…" as FluxMic does.
- **Speech order:** every final line, stream or batch, leaves through one outbound queue ordered by when its speech began on Murage's clock (the utterance's Silero start; for a turn with no utterance of its own, the first speech sent from the provider's start that is not discarded audio), one line and its end per `start()`. A sentence handed to batch (C.7) takes its place in that queue the moment its audio goes to FluxMic's recorder, and every sentence said after it waits there until its batch line comes back, or until its failed transcription's `MicEnd` goes out in that place. The wait is bounded: once the handed clip has been complete for `BATCH_LINE_WAIT_MS` (6 s, CallView's `TRANSCRIPT_WAIT_MS`), the lines after it go out, and its batch line follows late when it comes, never dropped (an out-of-order sentence is better than a lost one). As a backstop, each attempt of FluxMic's transcription request gives up after 65 s (just over the server's 60 s) and ends as `transcription-failed`. A sentence said before it is never held behind it. A turn with no utterance of its own takes its place from the first speech sent from the provider's start that is not discarded audio. `start()` counts as listening from the moment it is called, so a hand-over adopted while CallView restarts the mic inside its end handler is transcribed as part of that start, and an adopted clip is carried by FluxMic, so a `start()` that arrives while it is still being said goes on with it.
- **`pending()`:** true from a local voice-gate start, `speech.started` or the first partial until that turn's `turn.end` or `turn.cancelled` (or until 3 s pass with neither stream events nor local speech), and for `STREAM_CONTINUATION_HOLD_MS` (`CALL_ENDPOINT_LONG_MS`, 2800 ms) after the Silero speech end of a final line that `soundsUnfinished` (call-turns) says will go on: a trailing comma or ellipsis, or a last word a clause cannot end on. CallView's `HeldLine` reads it to know more of the owner's sentence may be coming, so on the stream path such a line waits out the call's long endpoint window, the same wait the batch path gives.
- **End-of-turn commit (built, off by default):** the switch `STREAM_COMMIT` ships `false` (Sean's end-of-turn rule: Murage ends a turn only on the provider's `turn.end`, and never reads or thresholds `confidence`), so by default no punctuation `turn.commit` is sent. The one exception is the discard-only commit (below, and C.7): it is never used to end the owner's turn early. With it on, when a partial ends in `.`, `?` or `!` (not `...` or `…`) and Silero has heard at least 400 ms of silence since the utterance's last speech, StreamMic sends `turn.commit` once for that turn. The provider's end of turn then follows in about 308 ms (spike) instead of waiting for its max-silence fallback, which moved the replayed p90 from 1749 ms to about 1000 ms with no new splits. It never commits on silence alone: forcing after 600 ms of silence split every pause fixture.
- **Transport:** `transport(): "stream" | "batch"`; `kind` stays `"flux"` so CallView's Flux rules apply.
- **Hold, mute, hang-up:** `suspend()` (hold) bumps the generation, cancels the rollover and reconnect timers, and closes every uplink it owns (the live one and a replacement being opened); `resume()` reopens one without spending a reconnect; a mute commits the open stream turn and discards its line (FluxMic's rule: a half-heard utterance is dropped on mute) and sends `keepalive` every 10 s; `close()` bumps a generation counter and cancels every timer, and anything that resolves under an old generation is closed at once.

### C.5 StreamUplink (`src/lib/stream-uplink.ts`)

A page-side contract A client, one instance per connect (StreamMic takes a factory). Gets a ticket with `fetch("/api/voice/stream/ticket", {method: "POST", headers})`, where `headers` are the desktop surface headers on the desktop and nothing on the phone (the browser door adds the proof); connects to `/api/voice/stream?ticket=` on the same origin; attaches its message listener before `open` resolves; is cancellable and bounded (`close()` before `open` abandons the wait for the desktop headers and aborts the ticket fetch or the handshake in flight, the whole connect has 10 s, and a closed uplink never connects again); sends binary Int16 frames; refuses a frame when more than 1 s is buffered and counts it. It never sees a Flux key.

### C.6 End of turn: CallView's HeldLine and joinTurn

The stream path adds no second turn logic. CallView at HEAD already decides when an owner line is a whole turn, for both transports:

1. **Hold** (`HeldLine`, `call-turns.ts`): a final line that sounds unfinished waits `CONTINUATION_WAIT_MS` (1200 ms) and keeps waiting, up to `CONTINUATION_CAP_MS` (6 s from the pause), while `mic.pending()` or a new utterance start says the owner is going on; the next line joins it.
2. **Join** (`joinTurn` with `joinsTurn`): a line whose speech began within `JOIN_WITHIN_MS` (3 s) of the last send, with under `JOIN_PLAYED_MS` (2 s) of the reply heard, stops that host turn, takes its history and call-log entries back, and asks both halves as one, unless the turn already acted.

The stream path feeds both: `pending()` is right sooner (a stream turn is open from its first sign) and stays true for 2.8 s after a line that sounds unfinished (C.4), `endedAt` comes from Silero on Murage's clock, and partials set `utteranceBegan`. `soundsUnfinished` already treats `…` and `...` as a continuation, which matters here because `universal-3-6-pro` partials and turns arrive punctuated ("because..."). The provider often ends a paused noun phrase with a period ("Blues Brothers." in every spike run at 0.8, 1.3 and 2.0 s), which the hold does not see; the join catches it at the cost of one host call, not a stutter, because the pauses (0.8 to 2.0 s) are shorter than the host's time to first audio (about 3.5 s), so the owner hears one reply. The join is required: 16 of 34 spike pause sessions split. `CALL_ENDPOINT_MS` stays for batch mode only.

### C.7 Fallback to batch, including mid-call

| Event | Action |
|---|---|
| Ticket 409 or 403, or the connect fails before `session.started` | Batch for the call. `[call-diag] stream: unavailable (<reason>) -> batch`. |
| Close 4400, 4401, 4402, 4403, 4404, 4413, 4429 | Batch for the rest of the call. 4402 shows no plan error unless batch also returns 402. |
| Close 1006, 4408, 4500, 4502, 4503, 4504 | If a stream turn is open (or local speech since the last committed turn): hand the ring's frames from the utterance's Silero start (less 384 ms preroll; never the provider's `speech.started` time, which can be 840 ms off) to FluxMic's recorder (`adoptUtterance`), so FluxMic's own endpoint ends the sentence and transcribes all of it. Then reconnect at the next silence boundary (retried each boundary for 60 s). Counted as a fault: at most 2 faults per call (`MAX_FAULTS`); after the second, batch for the rest of the call. |
| Close 1000 (max session) or 1001 (drain, or the harness changing credentials) | Reconnect now; frames wait in the 3 s start queue meanwhile (the server flushed the open turn first, so nothing is lost); not a fault, but counted as an attempt. |
| Close 1012 (a restart without a drain) | As 4502: the open turn is handed to batch and it counts as a fault (a restart without a drain lost the turn, like any other fault). |
| `session.expiring` | Open a replacement stream (the budget's replacement slot) alongside, with its own `StreamState`; the switch deadline (2 s before the close) is fixed when `session.expiring` arrives, not when the replacement opens; switch the tee on a frame boundary at the next silence, or at that deadline; send `session.close` to the old one. A failed replacement counts as an attempt. |
| App hold (`suspend`) | Close with `session.close`; reopen on `resume`. |

**Discard-only commit.** A hand-over to batch (above) and a mute each ask, with `turn.commit`, the stream that heard the audio to end what it heard. It is never used to end the owner's turn early; it only stops later speech merging into a discarded turn. One commit is in flight per stream at a time (A.7: a commit sent while one is unanswered is covered by it and gets no answer of its own), so a second hand-over or a mute before the answer sends nothing: it widens the pending commit's range to cover its audio, and the one answer settles both. The punctuation commit (C.4, off by default) is not sent while any commit is unanswered, and since the commit in flight is known, its forced end is never taken as a discard's answer. The provider's answer decides what is thrown away, by turn number: the forced `turn.end` it sends (or `turn.committed {turn}`) names the turn it ended, and every turn at or below that number is discarded, so a provider that split the audio into several turns is covered, and every later sentence has a higher number and is never touched. Audio merged into the range after the commit was sent lies past its barrier, so that part stays a range of positions after the answer, and it gets a discard-only commit of its own then, unless the owner is already saying something new (a turn open, or an utterance underway), which that commit would end early. A turn already open at the hand-over is discarded at once. Until the answer arrives the covered audio is a range of the stream's sent positions: a turn that first appears well inside it (more than a second before its upper edge, which allows for the provider's early word times) is discarded, and one that begins just short of the upper edge is held, in order, until the answer comes or 2 s pass, then emitted if the answer did not name it. A `turn.committed {turn: null}` means no turn ended in time (no turn was open, or the provider was slow), so a late turn for the handed audio can still come. The range then stays: a turn well inside it is discarded, and one that begins just short of its upper edge is held until its own `turn.end`, then discarded only if it ends at or before the edge AND no speech was sent past the edge (at least Silero's voice-gate length, about 0.2 s) in audio the server had received by that turn's `received_audio_ms`. Otherwise it is emitted, and it is emitted after 2 s whatever comes. The second test matters because nothing is sent while muted and a hand-over's tail goes to FluxMic, so on the stream's clock the owner's next words start right at the edge, and a short reply ("Yes.") reported early can end inside the range. A commit with no answer after 2 s is taken as lost. A hand-over carries only its own utterances' frames (never another stream's utterance underway, and never a sentence that already has its line), and FluxMic's recorder takes one clip at a time, so later hand-overs wait their turn. Every final line, stream or batch, reaches the call one per `start()`, in speech order (C.4).

Budgets per call: at most 2 faults (`MAX_FAULTS`) and at most 4 connect attempts after the first, successful or not (`MAX_ATTEMPTS`, covering fault reconnects, 1000 and 1001 reconnects and rollover replacements). When either is spent the call goes to batch. So the batch fallback runs at most twice per call, each time for one turn of at most 30 s.

Bounded loss: none while the ring holds the turn (30 s, FluxMic's cap); for a longer turn, the oldest audio beyond 30 s. The recovered turn is billed again on the batch route (A.14).

### C.8 Barge-in and talk-over with partials

- **Silero stops the bot, not partials.** The first partial arrives 810 to 930 ms after speech starts; for "stop" (about 460 ms of speech) it lands about 350 ms after the word ends (spike). CallView's existing Silero `onVoice` hold pauses the bot on sustained speech within about 0.2 s, locally, and that is what makes "Stop." fast. The `STOP_NOW` test on partial lines then confirms the word and keeps the bot quiet instead of resuming it.
- The "…" line at a local voice-gate start is emitted on the stream path too: CallView's talk-over hold relies on it.
- The one-word evidence rule uses the partial's own Silero evidence (StreamMic attaches it), so a one-word partial with real speech can stop the bot and a word guessed from music cannot.
- `speech.started` from Flux is not used to stop the bot (Silero's `onVoice` is local and faster).

### C.9 Feature flag, config and integration points

- Harness env `MURAGE_VOICE_STREAM`: `off` (default until F passes), `on`. Streaming is offered when the flag is on, a Flux key exists, and `voiceRouteFor("transcribe")?.via === "flux"`.
- The page learns it from `describeVoice(cfg).streamTranscribe` (a new boolean beside `routes`, injected through `useVoiceRoutes`), typed in `src/state/store.tsx` as `tts.streamTranscribe?: boolean`.
- `MURAGE_FLUX_STREAM_API`: base URL override (`ws://127.0.0.1:8787/v1` for the simulator).
- Integration points in files another agent edits, and only these: `call-mic.ts` (export `FluxMic` and `toInt16`; `transport?()`, `suspend?()`, `resume?()` on `CallMic`; a protected `adoptUtterance(frames, judged)` on `FluxMic`; `endedAt` already on `MicLine`); `call-audio.ts` (builds `StreamMic` when `kindFor` says `"stream"`); `CallView.tsx` (`kindFor` passes the stream flag; the hold and resume handlers call `suspend?.()`/`resume?.()`; one timing diag line). No changes to `voice-host*.ts` or `call-turns.ts`.
- Companion: `companion/src/stream-upgrade.ts` forwards the upgrade for exactly `GET /api/voice/stream`. It owns the socket from the `upgrade` event: close and error listeners and a 10 s handshake timeout (504) are attached before any await, a revocation during the handshake closes it, and the session is rechecked live before the upgrade completes. The `ticket` (and any other secret-bearing) query value is redacted before the request reaches `originGate`, the access log or any error log, which all see a redacted copy of the request. On the browser door it runs `originGate` on that copy, resolves the cookie session, registers the socket with `connected(deviceId, disconnect, sessionId)`, rechecks the session, stamps the principal and the launch proof, and allows one socket per session (two while expiring). On the device door (paired bearer clients) it requires the bearer. The managed origin refuses the upgrade (426) in v1. The ticket route joins `needsLaunchProof` and `launchProofHeaders`. Vite's `/api` proxy gets `ws: true`. The Electron origin gateway forwards HTTP only, so desktop builds behind it use batch until it is qualified.

### C.10 Turn-timing diagnostics

One line per committed stream line, numbers only:

```
[call-diag] stream-timing speech_end=48213 eot_rx=48902 eot_lag=689 server_lag=412 backlog=40 reason=endpoint committed=0 dropped=0
```

- `speech_end`: wall time of the ring frame holding the last Silero speech of the turn. `eot_rx`: wall time the line was emitted. `eot_lag = eot_rx - speech_end`. `committed`: 1 when StreamMic sent the punctuation commit for this turn.
- `server_lag`: `server_lag_ms` from `turn.end` (approximate, A.6). `backlog`: `received_audio_ms - audio_end_ms`. `dropped`: frames the uplink or the server dropped this turn.
- CallView's existing `turnTiming` line (`call-turns.ts`) adds host and playback stages from `endedAt`, so batch and stream turns compare directly.
- The iPhone build persists `[call-diag]` lines to its `Documents/` log (Murage plan Task 13 if the cut-off work has not).

## D. The simulator (`tools/flux-stream-sim/`)

A Node server implementing contract A so Murage can build and prove C before Flux starts, with a stated fidelity boundary.

- **Implements:** subprotocol rules, auth, params, limits, pre-start buffer (oldest dropped, warning after `session.started`), burst drops with `at_audio_ms`, `seq`, turn numbering with `turn.cancelled`, commit and close barriers, usage and **leases with the same cumulative arithmetic as Flux** (reported in `usage` and `session.closed`), per-account concurrency, real outbound queue pressure (a `slow_consumer` is a client that stops reading), `server_lag_ms`.
- **Keys:** only keys it was told about are paid keys (`--keys <file>` of `key=account` lines, and `sim_key`, `sim_key2` on accounts `acct-1` and `acct-2`); anything else is 4401, so conformance A02 passes. Magic keys: `sim_bad` (4401), `sim_free` (4402 `premium_locked`), `sim_noCredit` (4402 `credit_exhausted`), `sim_nobilling` (4402 `billing_unavailable`), `sim_forbidden` (4403), `sim_dark` (4404), `sim_limited` (4429 `concurrency_limit` on the second session). Keys are never logged.
- **Providers:** `assemblyai` (A.16's mapping and B.4's sending rules, key from `~/.config/murage-mobile/assemblyai.key`) and `scripted` (offline, deterministic; energy VAD; text from `sim_script` per speech segment; it can also emit provider-shaped duplicate and unformatted ends and empty turns, so the mapper's traps are replayed offline).
- **Faults:** per session with `sim_fault=` (only with `--faults`), globally for new sessions, or **armed on open sessions** with `POST /__sim/faults {"spec":..., "open": true}`: `latency_ms`, `begin_delay_ms`, `flood_partials` (bursts of partials so the outbound queue coalesces them, for P04), `reject=<code>`, `close_after_ms=<ms>:<code>`, `close_after_speech_ms=<ms>:<code>` (fires that long after the next `speech.started`, logging the session and turn it fired on), `drop_after_ms`, `idle_timeout_s`, `partial_drop_pct`, `max_session_s`.
- **Config:** the session keeps the requested configuration and reports the provider's effective one in `session.started` and `session.updated`; pre-start controls are applied in order with the pre-start audio (A.5), and a commit's deadline is set before the provider is asked to commit, so a fast forced end is never reported as `turn.committed {turn: null}`. The simulator passes its own suite (`npm test` in `tools/flux-stream-sim`, and the conformance suite in dev mode against it).
- **Out of v1 fidelity (declared):** client tokens (A06 runs against Flux only), provider trace recording, Flux's ledger and prepaid gate (M01 checks the ledger on Flux).
- Privacy: logs no audio and no text.

## E. The conformance suite (`tools/flux-stream-conformance/`)

`node --experimental-transform-types tools/flux-stream-conformance/run.ts --mode acceptance|dev --base <ws base> --key-env FLUX_KEY [--key2-env ...] [--free-key-env ...] [--restricted-key-env ...] [--sim] [--flux-faults] [--profile] [--only <ids>] [--report out.json]`

(`--experimental-transform-types` because the suite imports `src/lib/call-turns.ts`, which uses constructor parameter properties.)

**Modes.** `acceptance` runs a fixed inventory and fails on any missing check, skipped required check, missing sample, missing metric or missing gate. `dev` allows `--only`; an unknown or empty selection exits 2; a dev report says "not an acceptance run" at the top.

### E.1 Fixtures

`fixtures/gen.sh` uses macOS `say` (voice Samantha, rate 180) and `afconvert -f WAVE -d LEI16@16000 -c 1`, then extracts the WAV `data` chunk by parsing the RIFF chunks (P6: `afconvert` writes a `FLLR` chunk and the data starts at byte 4088), checks format, rate, channels and even length, and computes `speech_segments` with an energy analyser (10 ms windows, RMS over 0.01, gaps over 300 ms split segments). The `.pcm` files, their SHA-256 and `manifest.json` are committed.

| id | Text (`[[slnc N]]` = N ms pause) | Expected turns | Class | Purpose |
|---|---|---|---|---|
| f01-plain | "What's the weather like in Bangkok today?" | 1 | plain | baseline latency, accuracy |
| f02-comma | "My favourite movies are Blues Brothers, [[slnc 1200]] and Heartbreak Ridge." | 1 | pause | the T11 split |
| f03-list | "Blues Brothers, [[slnc 900]] Trading Places, [[slnc 900]] and Ghostbusters." | 1 | pause | chained pauses |
| f04-clause | "I wouldn't say cliche because most people [[slnc 1300]] never actually watch it." | 1 | pause | the T9 split |
| f05-tail | "I appreciate that, and dead on the money [[slnc 1100]] across the board there." | 1 | pause | the T24 split |
| f06-frame | "Put yourself in the fixer frame [[slnc 1000]] and think about strengths." | 1 | pause | the T21 split |
| f07-two | "Tell me a joke. [[slnc 3500]] Actually, make it about cats." | 2 | plain | no over-merge |
| f08-stop | "Stop." | 1 | plain | barge-in partial latency |
| f09-backchannel | "Uh-huh." | 1 | plain | short turns survive |
| f10-long | a 25 s paragraph | 1 or more | long | partial cadence, commit |
| f11-silence | 8 s of digital silence | 0 | silence | no `turn.end` |
| f12-names | "Ask Sable about Heartbreak Ridge." with `keyterms=Sable` | 1 | plain | keyterms reach the provider |

The sender waits for `session.started` (except L06), then paces each fixture at real time in 64 ms frames, recording each frame's send time, and sends 3 s of silence.

### E.2 Contract checks

Every wait in a check is bounded (the handshake 10 s, `closedWithin` default 15 s, `rtt` 5 s), and every check runs under an overall deadline (180 s, longer for the long-session checks), so a silent or defective server fails the check instead of hanging the run, and after every check the runner terminates any socket the check left open, so a failed check cannot hold a concurrency slot or feed a later one. A check that sends two fixtures on one session measures each on its own send's clock. Latency and profile checks are rows too: `E-latency` (the plain fixtures at the session's eagerness: T-text and T-eot samples), `E-nosplit-flux` (T-nosplit-flux) and `E-murage` (below, E.4).

Tags: `sim-only` (needs the simulator), `flux-faults` (needs `--flux-faults`: the simulator, or staging with `FLUX_AUDIO_STREAM_TEST_FAULTS=true`), `flux-only`. Every check is required in acceptance mode unless its tag excludes the target.

| id | Rule | Pass |
|---|---|---|
| P01 | subprotocol | offered: echoed; not offered: none returned, session starts |
| P02 | `session.started` | first message, `seq` 1, all A.6 fields, resolved silences (not null), public alias, no provider name |
| P03 | unknown params | listed in `ignored_params` |
| P04 | `seq` | strictly +1 across every message of a fixture run, and again after a `flood_partials` fault (numbered 4 KB partials of one turn every 5 ms, 1.6 MB while the client stops reading for 2 s): at least 20 flood partials arrive, some numbers are missing (coalescing replaced them), the session closes 1000 (not a slow consumer), and `seq` has no gap; the coalescing half needs `--sim` or `--flux-faults` and is required in acceptance |
| P05 | `received_audio_ms` | present and non-decreasing |
| A01 | no key | `error unauthorized`, 4401 |
| A02 | bad key (`not-a-flux-key`) | 4401 |
| A03 | key in query (`APIKEY=not-a-flux-key`) | 4400, `param` is `APIKEY` |
| A04 | free key | `error premium_locked`, 4402, no `session.started` |
| A05 | dark | 4404 (`sim-only`) |
| A06 | client token | mint, connect, reuse is 4401 (`flux-only`, v1.1; reported, not gated, until built) |
| A07 | restricted key | 4403 `forbidden` |
| V01 | bad `sample_rate` | 4400 `invalid_param`, `param: "sample_rate"` |
| V02 | odd frame | 4400 `invalid_audio_frame` |
| V03 | 1100 ms frame | 4413 |
| V04 | unknown type | non-fatal `unknown_message_type`, session continues |
| V05 | malformed JSON | non-fatal `invalid_json` |
| V06 | five protocol errors | 4400 `too_many_protocol_errors` |
| V07 | 17 KiB text frame | 4400 |
| T01 | turn numbering | from 0, +1 per `turn.end` or `turn.cancelled`, nothing after a turn closes |
| T02 | order per turn | `speech.started` (if any) before the first partial; finals before `turn.end`; no partial after the turn's last final |
| T03 | finals and end | finals never repeat a word position; normalized `turn.end.text` agrees with the turn's finals (WER at most 0.1); non-empty; WER against the manifest at most 15% |
| T04 | f11 silence | no `turn.end` |
| T05 | commit | mid-utterance `turn.commit` gives `turn.end reason=forced` within 1000 ms |
| T06 | commit, no turn | `turn.committed {turn:null}` within 1500 ms |
| T07 | update | `session.updated` with the new value, then f02 at `eagerness=low` yields one turn |
| T08 | immutable update | non-fatal `config_immutable` for `sample_rate` and for `format` |
| T09 | keyterms (f12) | "Sable" spelled correctly |
| T10 | empty turn | a scripted opened turn with no words yields `turn.cancelled` (`sim-only`) |
| T11 | duplicate end | a scripted unformatted end then a formatted end of the same provider turn yields exactly one `turn.end`, and its text is the formatted one ("Blues Brothers.", with the capitals and the period) (`sim-only`) |
| L01 | keepalive | 45 s muted with keepalives, through the public hostname: session alive |
| L02 | idle | `idle_timeout_s=5`, nothing sent: `idle_timeout`, 4408 within 7 s |
| L03 | close with an open turn | `session.close` during f10 speech: `turn.end reason=session_end` (or `turn.cancelled`), then `session.closed` with usage, 1000 within 2 s |
| L04 | usage | `billed_seconds` in `session.closed` equals `max(10, ceil(session seconds))` within 1 s; a 3 s session bills 10 |
| L05 | max session | `max_session_s=90`: `session.expiring` at 30 s left (60 s in, within 2 s), 1000 at 90 s (within 2 s), `reason: max_duration` |
| L06 | pre-start | the provider starts 1.5 s late (sim `begin_delay_ms=1500`; Flux `flux_test_fault=connect_delay_ms=1500` on the real provider, `flux-faults`) and f01 is sent from `open` with 1.5 s of trailing silence: `session.started` at least 1200 ms after open; the first word of f01 is in the transcript (the word itself never reported); the next fixture's EOT lag minus RTT, on the fixture's clock, is under 2000 ms (the backlog drained, no lasting lag) |
| L07 | concurrency | over the limit: 4429 `concurrency_limit` (`sim-only`, or a staging key limited to 1) |
| L08 | pings | at least one ping in 26 s, through the public hostname |
| L09 | usage cadence | a `usage` message between 58 and 62 s into a session |
| B01 | burst | 6 s at once: `warning audio_dropped` with `at_audio_ms`, session alive, and a fixture spoken after it is transcribed |
| B02 | slow consumer | the client stops reading while the server has output: 4503 `slow_consumer` (`flux-faults`) |
| F01 | provider error | `error capability_unavailable`, 4502 (`flux-faults`) |
| F02 | provider start timeout | 4504 (`flux-faults`) |
| F03 | 429 with retry | `retry_after_ms` present (`sim-only`) |
| F04 | 503 at handshake | HTTP 503 or 4503 (`sim-only`) |
| X01 | isolation | two concurrent sessions on two keys of two accounts with f01 and f12: each transcript is non-empty, matches its own fixture (WER at most 15%) and holds none of the other's distinctive words |
| M01 | metering | a 125 s session: `usage` messages report about 60 and 120 billed seconds (within 1), and `session.closed` agrees with `billed_seconds` for the session (the Flux team checks the ledger rows `{sid}:0` to `{sid}:2`, hand-off Task 7) |

### E.3 Latency measurement

- **Send clock:** the sender records the wall time each frame left (`t_sent(frame)`); fixture time `x` was sent at `t_sent` of the frame holding it. All sessions are warm: sending starts after `session.started`. Startup is measured apart (`T-start`).
- **Stable-text lag (T-text):** for the fixture's last turn, the first message (partial, final or `turn.end`) after which the turn's running text, normalized, equals the turn's final text and never changes again, judged in hindsight once the turn has ended; its receipt minus `t_sent(speech_end_ms)`. This is what the spike called "final text" (661/703 ms). Protocol finals are not used: on `universal-3-6-pro` the words are marked final only with the end of turn, so a final-lag metric would duplicate T-eot.
- **Server lag:** `server_lag_ms` on that message (Flux's monotonic time; includes the provider hop, excludes the client network; approximate because it is anchored on the provider's word end, so reported, not gated).
- **Speech end** comes from the fixture's own energy analysis (`speech_end_ms` in the manifest), never from a provider timestamp.
- **RTT:** websocket ping round trips to the server during the run; the median is subtracted once from client numbers (audio up, result down).
- **EOT lag (T-eot):** `turn.end` receipt minus `t_sent(speech_end_ms)`, per class (plain or pause).
- **Murage EOT lag (T-eot-murage):** the same, in `E-murage`'s sessions, where the suite runs StreamMic's commit policy (`--commit on`, the default, or `--commit off`).
- A missing sample for a fixture that should produce one is a failure, not an omission.

### E.4 Acceptance targets

The fixture gates are set from the spike's direct measurements (final text 661/703 ms, end of turn 672/1749 ms at p50/p90, from Sean's Mac with no Flux hop), with room for the hop, and each gate measures the same quantity the spike measured (E.3). The owner-voice targets are set from the bake-off (1.2). All are targets for a new path, not results: F and the owner qualification decide.

| Target | Gate |
|---|---|
| T-text | plain fixtures: stable-text lag minus RTT, p50 under 800 ms and p90 under 1000 ms (raw reported) |
| T-eot | plain fixtures at `eagerness=medium`, no client commit: EOT lag minus RTT, p50 under 900 ms and p90 under 2000 ms (the p90 is the provider's max-silence fallback, about 1.75 s) |
| T-eot-murage | `E-murage`: every plain and pause fixture runs through one Murage session policy, StreamMic's punctuation commit included (sent when a partial ends in `.`, `?` or `!`, not an ellipsis, and the fixture has been silent for 400 ms; never on silence alone), so the same policy that is timed on the plain fixtures is tested for splits on the pause fixtures. Plain fixtures: p90 EOT lag minus RTT under 1300 ms. The run with `--commit off` is the control: the commit ships only if `--commit on` passes T-nosplit-murage with no more superseded sends and no audible restarts than `--commit off` (Murage plan Task 14) |
| T-nosplit-flux | `eagerness=low`: f02 to f06 one `turn.end` each; f07 two |
| T-nosplit-murage | `E-murage` (same sessions and commit policy as T-eot-murage): the live events of f02 to f07 are replayed through `call-turns.ts` (`soundsUnfinished`, the hold's timings with the 2.2 s stream hold on a comma or ellipsis, `joinsTurn`) on one timeline, with the host's first audio modelled 3500 ms after a send (the spike's remainder of today's gap). Reported: owner turns, superseded sends (a join after a send) and audible restarts (a join after the reply began playing before the owner went on). Gate: f02 to f06 one owner turn each; f07 two provider turns (CallView may join them into one host turn when no reply audio has played, which is its rule and costs nothing); superseded sends at most 2 of 5 (the spike split 16 of 34 pause sessions at `medium`, mostly the "Blues Brothers." fixtures, of which this set has one); audible restarts 0. |
| T-errors | every required A, V, L, B and F row passes |
| T-owner | owner-voice qualification (`--owner-recording`, local to Sean's machine, numbers only): Sean's 25 bake-off lines per condition through the stream, run with the session policy under qualification (its query and commit setting), with StreamMic's commit predicate replayed on the recording's own speech segments (pauses inside a line included), scored by the bake-off's own scoring, ported (its normalization, alignment, hindsight true end of speech from each condition's audio, interpolated percentiles; replaying the bake-off's saved AssemblyAI events through it reproduces the bake-off table exactly: 622/717/945/719 ms p50, 5139/5140/5335/3881 ms p90, 2.7 % WER, splits 3/3/3/2 of 8); the manifest is the bake-off run's own 25-line `lines.json`, and anything else is refused; every line gets an explicit result, and a line with nothing aligned (or a non-finite sample) fails the condition; p50 at most 800 ms clean, 900 ms quiet, 1100 ms noisy, 900 ms phone (`OWNER_TARGETS`: the bake-off's 622, 717, 945 and 719 ms plus the hop), WER at most 5 %; p90, pause splits and negative-latency lines are reported, not gated (the p90 is turn merging, 1.2) |
| T-server | report only: p50 `server_lag_ms` |
| T-start | report only: p50 connect to `session.started` (the spike: 1.32 s to the provider with the key in a header) |

Acceptance runs name whose acceptance they decide (`--target`): **Flux** (`--target flux`) is every contract check plus T-text and T-eot (p50 and p90), with Murage's profile checks excluded, since the profile is Murage's to tune; **Murage** (`--target murage`) adds the profile checks and T-eot-murage, T-superseded and T-audible-restarts, and T-owner when run with the owner recording. Each target's required gates are listed in the runner, and a missing one fails that target.

The report is JSON plus a markdown table of checks, metrics and gates (counts, codes and WER only, never transcript text), and the run exits non-zero on any failed or missing gate.

## F. Device acceptance on Sean's iPhone

Setup: `MURAGE_VOICE_STREAM=on` on the harness, the iPhone native call audio path, bot Sable, `[call-diag]` persisted to the phone's `Documents/` log. Before the phone: the owner-voice qualification (T-owner, E.4) passes against the simulator with the chosen config. First against the simulator (`MURAGE_FLUX_STREAM_API=ws://127.0.0.1:8787/v1`, provider `assemblyai`, `--faults`), then against real Flux staging once B passes E.

Scripted call, said naturally:

1. "Hi Sable, can you hear me?" (the stream opened at call start: `stream: live` before the first turn).
2. "My favourite movies are Blues Brothers, (pause about 1.5 s) and Heartbreak Ridge."
3. "I wouldn't say cliche because most people (pause) never actually watch it."
4. "Put yourself in the fixer frame (pause) and think about strengths."
5. Ask for a long answer ("tell me about Casablanca in detail"), then say "Stop." about 5 s into the reply.
6. While she talks, say "uh-huh" twice (she carries on).
7. While she talks, say "Actually, wait, change of topic, what's the time in London?"
8. Mute for 45 s, unmute, ask a question.
9. Take a real phone call (hold), end it, tap Resume, ask a question.
10. On the harness, arm the fault on the open session (`POST /__sim/faults {"spec":"close_after_speech_ms=1500:4502","open":true}`), then speak a long sentence; the sim logs the session and turn it fired on. On real Flux staging there is no arming endpoint: run steps 10 to 12 as a second call: set `MURAGE_FLUX_TEST_FAULT=error_after_speech_ms=1500` on the harness (read per connect; the relay passes it as `flux_test_fault` to any base other than `api.fluxrouter.ai`, C.2), start the call and speak the long sentence first; every stream of that call fails 1500 ms into its first turn, so the second fault lands on the reconnected stream's first turn (step 11). Expect: two faults, each turn arriving once via `path=batch`, then batch for the rest of the call (`MAX_FAULTS`), so steps 10 to 12 collapse into that one sequence.
11. Two more turns (the first after a reconnect at a silence boundary).
12. Arm `reject=503` for new sessions and `close_after_speech_ms=1500:4502` on the open one, speak once more, then two more turns (batch for the rest of the call). On real Flux: covered by step 10's sequence.
13. Hang up. Check the call note.

Targets, from `[call-diag]` lines:

| Measure | Target | Today |
|---|---|---|
| `eot_lag` over the plain turns (1, 5, 7, 8) | p50 900 ms or less, p90 1300 ms or less (simulator from Asia, with the punctuation commit); real Flux the same plus 100 ms | an estimated 2.35 s (0.85 s endpoint plus about 1.5 s transcription, not logged per turn) |
| lines 2 to 4 | one owner turn each (held or joined); no audible restart (a join before any reply audio is allowed and expected on line 2) | split on T9, T11, T19, T21, T24 before `8260cf9d` |
| "Stop." to bot silent | 600 ms or less from the first Silero speech frame of "stop" (ring wall time) to the bot's audio pausing (Silero's `onVoice` hold, not the partial) | endpoint plus upload, about 2.5 s |
| stop-talking to first bot audio (`turnTiming` total) | p50 4.5 s or less, p90 5.0 s or less (spike projection: about 4.3 s and 4.65 s with the commit) | about 6 to 6.5 s |
| backchannel "uh-huh" | bot continues both times | |
| mute 45 s | no 4408, no reconnect | |
| hold and resume | `stream: closed (hold)` then `stream: live`; no reconnect counted | |
| step 10 | the fault fired while the turn was open; the long sentence arrives once, whole, via `path=batch`; step 11 turns are `path=stream` (simulator). Real Flux: two faults, each sentence once via batch, then `path=batch` | |
| step 12 | the sentence arrives once via batch; later turns `path=batch`; the call continues | |
| call note | every turn present, no duplicates | |

Pass: every row on two consecutive calls. Record the diag lines in the handoff.

## G. Risks and open questions (each with a recommendation)

1. **Provider end of turn alone splits mid-sentence pauses at low latency** (P0; the spike: 16 of 34 pause sessions at the balanced defaults, every "Blues Brothers." pause). *Recommendation:* start at `eagerness=medium` (no turn knobs), rely on CallView's hold (2.2 s on a comma or ellipsis on the stream path) and join (C.6), gated by T-nosplit-murage and F; do not buy fewer splits with `min_turn_silence=1500`, which makes every turn about 1.76 s. Ask Flux to tune `low` to pass T-nosplit-flux for other customers. F on Sean's own voice is the final word; the bake-off already shows the same pattern on his voice (3 of 8 pauses split).
2. **Model choice.** *Recommendation (settled by the spike and confirmed on Sean's voice by the bake-off):* pin `universal-3-6-pro` at its balanced defaults: 0.3 % WER and 661 ms p50 to final text on the fixtures, 2.7 % WER and 622 to 945 ms p50 across four conditions on Sean's voice; `universal-streaming-english` lost words and split every pause fixture.
3. **Provider data handling.** *Recommendation:* Flux confirms retention and training settings before launch (their zero-retention terms depend on the account's opt-out) and states them in the public docs; Murage's copy says "not stored by Flux" only.
4. **Session-second billing for a whole call**, and the bounded double charge of a batch fallback (A.14). *Recommendation:* v1 keeps the stream open for the call; v1.1 adds an idle park in StreamMic (close after 120 s without speech during engine work, reopen on the next speech start, that one turn through batch).
5. **AssemblyAI parameter drift.** Both silence names work; the threshold does nothing on `universal-3-6-pro`; `Begin` echoes no turn knobs. *Recommendation:* one per-model mapping in the adapter; both silence names sent; the threshold never sent; the suite checks behaviour; pin `speech_model`.
6. **Connect time** (1.32 s with the key in a header, 2.2 to 2.8 s with a temporary token; plus the Flux hop). *Recommendation:* Flux connects with the key in a header, and Murage opens the stream at call start, buffers pre-start audio (A.5) and drains the backlog under the 3 s lead cap (A.12).
14. **Provider timestamps.** Word times drift by hundreds of milliseconds (spike). *Recommendation:* the contract calls them approximate (A.6), Murage times everything from its own clock and Silero (C.4), and the suite takes speech end from the fixtures (E.3).
15. **The punctuation commit** was an offline replay. It is now tested live against the pause fixtures in the same sessions that time it (`E-murage`, `--commit on` against `--commit off`, E.4). *Recommendation:* ship it in StreamMic behind `COMMIT_SILENCE_MS`, keep it only if the on run adds no superseded send or audible restart over the off run, and confirm in F.
16. **Owner-voice targets are unproven through the stream.** The bake-off measured the provider directly, not through Flux, and its p90 is dominated by turn merging. *Recommendation:* gate p50 and WER per condition (T-owner), report p90 and splits, and let F decide; revisit the targets after the first real-Flux run. The scorer is the bake-off's own, ported, and replaying the bake-off's saved AssemblyAI events through it reproduces the bake-off table exactly (Revision 5); rerun that replay after any change to it.
17. **Recovery relies on one Redis with Lua and `cjson`.** The claim script builds record keys inside Lua, which Redis Cluster forbids. *Recommendation:* Flux confirms its Redis is a single primary (or a hash-tagged key scheme is added) before launch, and runs the metering tests on `fakeredis[lua]` and once on the staging Redis.
18. **Flux is moving to LiteLLM 1.92.2.** An image built on 2026-09-30 carries LiteLLM 1.92.2, websockets 15.0.1 and uvicorn 0.54.0, while the local Flux copy targets 1.67.4. *Recommendation:* never pin `websockets` exactly (`>=13.1,<16`); the hand-off's tests were run on 1.92.2's versions and the adapter's also on 13.1.0; recheck the auth-route registration (`LiteLLMRoutes.openai_routes`) and `proxy_cli`'s uvicorn arguments on whichever LiteLLM ships.
19. **Stripe meter events for a charge stuck longer than 23 h go to reconciliation.** The outbox drainer stops at 23 h of the event's original time, which is right for an ambiguous post but also catches an event that was never posted because the ledger was down for a day. Every stream row is due for the drainer at insert and the drainer runs every minute, so a row reaches 23 h only when the ledger, the outbox or Stripe is down for most of a day, or the drainer stops. *Recommendation:* accept it for v1 (an outage that long pages first, and the oldest-due-row alarm fires at 10 minutes); if it happens, post never-attempted rows by hand inside the meter's backdate window (check it in Stripe; the drainer's own comment assumes 35 h).
7. **LiteLLM integration.** *Recommendation:* register the stream paths as API routes, carry a model body in the auth adapter, test with the real shim; confirm the `websockets` backend and 20 s pings in the built image (hand-off Task 6).
8. **Proxies.** *Recommendation:* a dedicated Ingress with 3700 s timeouts, Cloudflare websockets on, pings verified through the public hostname, per-IP limits only with the real client address.
9. **LiteLLM's realtime websocket** is unmetered. *Recommendation:* the registrar evicts it (4404) until Flux has a metered realtime plan.
10. **Companion upgrade forwarding is new surface.** *Recommendation:* exactly one path; the browser door's origin gate, cookie session and revocation tracking; tickets bound to a companion-stamped principal; one socket per session; covered in the companion suite (Murage plan Task 9).
11. **Uplink bandwidth:** 256 kbps of PCM. *Recommendation:* fine on Wi-Fi and Tailscale; `encoding=opus` in v2; measure on cellular during F.
12. **Concurrent edits to CallView and call-mic.** *Recommendation:* land Tasks 1 to 11 first (new files, plus server and companion wiring), then Tasks 12 and 13 after merging the other agent's work (never rebase).
13. **Name overlap:** Deepgram has a streaming model called "Flux". *Recommendation:* keep `flux-voice-stream` and never name providers.
