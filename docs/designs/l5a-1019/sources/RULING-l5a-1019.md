# RULING: l5a (turn-text secret redaction, collector and audience wire, Murage 1.0.19)

Status: BINDING Opus ruling. Closes the second Astra DISAGREE (swarm-b/odes2-l5a/last.txt) on `orph/l5a/DESIGN-r2.md`.
Base: int/1019 `c12aaad93`. Scope is unchanged: whole-text policy, collector, execution/audience split, historical and standalone boundaries, native cleanup, G9 proof. Nothing is deferred.
Builders build DESIGN-r2 as amended here. Where this ruling and DESIGN-r2 differ, this ruling wins. No question is left for a builder or for Sean.

Open points closed: 4 (review points 1 to 4) plus the slice correction.

---

## R1. F8 answers are an atomic array (review point 1)

### Evidence

- `shared/questions.ts` `QuestionSpec` (multiSelect, allowOther, secret) and `QuestionAnswer {id, selected: string[], other?}`; `QUESTION_LIMITS.questions = 4`, `options = 10`, `otherChars = 2_000`.
- `server/index.ts:7469-7524` `questionReply` parses `body.answers` with `parseAnswers` then `validateAnswers(questions, answers)` across the complete set and forwards one `toMessageText(questions, answers)` plus `answers`.
- `server/index.ts:7351-7395` `answerAsSendReply` validates the complete set and writes one owner send with `sendId = "ask-" + message.id`.
- DESIGN-r2 line 203 F8 body `{requestHandle, questionHandle?, optionHandles?, action?, other?}` carries one question only. A four-question card cannot be answered, which loses a capability (G9).

### Decision

Replace the F8 "submitted display action" sentence in DESIGN-r2 line 203 with this frozen type in `shared/audience-wire.ts`:

```ts
export type DisplayAnswer = Readonly<{
  questionHandle: string;                 // "q.<index>", index into the stored card's questions
  optionHandles: readonly string[];       // "o.<qIndex>.<optIndex>", into that question's stored options
  other?: string;                         // owner's own words, unchanged bytes, <= QUESTION_LIMITS.otherChars
}>;
export type DisplayAction =
  | Readonly<{ requestHandle: string; action: "answer"; answers: readonly DisplayAnswer[]; sentAsMessage?: true }>
  | Readonly<{ requestHandle: string; action: "skip" }>
  | Readonly<{ requestHandle: string; action: "allow" | "deny" }>;   // permission requests only
```

Server resolution, one pure function in `server/harness/audience-collector.ts` (Wave 1B):
`resolveDisplayAction(card, action): { ok: true; legacyBody: { behavior: "answer" | "deny" | "allow"; answers?: QuestionAnswer[]; sentAsMessage?: true } } | { ok: false; status: 400 | 409; error: string }`

1. Strict schema first. Unknown fields, wrong discriminator, `allow`/`deny` on a question request, `skip`/`answer` on a permission request: 400.
2. Resolve the entire `answers` array before anything else: every `questionHandle` must index a question of THIS card (handles of another request, another card, or out of range fail); no question handle twice; each `optionHandles` entry must index that question's stored options, no duplicates, single-select gets at most one; `other` only where `allowOther`.
3. Build `QuestionAnswer[]` with `id` = the stored `QuestionSpec.id` (original provider id, unchanged) and `selected` = the exact stored original labels, in stored option order. `other` is copied byte for byte, including for `secret` questions.
4. Any failure in steps 1 to 3 returns the error and causes zero side effects: no `store.patchMessage`, no adapter `respondToRequest`, no owner send, no log of answer text. Never a partial submission.
5. On success the route passes `legacyBody` to the existing `answerAsSendReply` then `questionReply` exactly as today. Those functions keep their existing validation (`validateAnswers`), secret rule, folder-trust rule, expired rule, `ask-<message.id>` exactly-once send id, and owner proof (`origin === "unproven"` gets 403). No change to those functions' logic.
6. `skip` maps to the existing skip/deny path. `allow`/`deny` on permissions maps to the existing permission respond path.
7. The owner-typed `body.message` text path (`answersFromMessage`) stays as it is.

### Tests (RED first), `server/harness/audience-collector.test.ts` and `server/redact-output-boundaries.test.ts`

- `execution.answers-multi-question.unchanged`: four-question card (mixed single, multi-select, Other, one secret); submit one `DisplayAction`; the adapter receives one `QuestionAnswer[]` deep equal to the original ids and labels; the secret `other` text arrives byte identical and appears in no log, transcript, SSE or card output. RED: current F8 cannot express it.
- `execution.answers-multiselect-order`: options picked in reverse; `selected` is in stored order with exact original labels (masked display labels never reach the adapter).
- `execution.answers-other-only`: Other text alone on an `allowOther` question.
- `execution.answers-mixed-request-handles`: one answer carries a `questionHandle` from another card: 400, zero patches, zero adapter calls, zero sends.
- `execution.answers-duplicate-and-range`: duplicated question handle, out-of-range option, two options on single-select: 400, zero side effects.
- `execution.answers-secret-late-refused`: `sentAsMessage` on a card with a secret question still returns the existing 409.
- `execution.answers-legacy-body-equivalence`: for each valid action, `legacyBody` passed to the existing functions produces the same store patch and adapter call as today's client body.

---

## R2. Three handle lifetimes (review point 2)

### Evidence

- `server/index.ts:7351-7380` `answerAsSendReply`: `answerAsSend` cards (`question.async`) have no adapter request; expired direct questions accept a late `sentAsMessage` answer; one owner send per card (`ask-<message.id>`).
- `src/components/QuestionCard.tsx:150-173`: an expired, non-folder-trust card stays editable and calls `onSendAsMessage` unless secret.
- `server/engine-commands.ts:140-170` `EngineCommandCache`: a disk-backed per bot, per driver list (`{commands, at}`), available between runs and after restart.
- DESIGN-r2 line 203 ties every handle to a live pending request and deletes it on resolution or timeout; that breaks all three of the above.

### Decision

Replace the F8 lifetime sentences of DESIGN-r2 line 203 ("Create request/option mappings before publication ... reject the stale action without forwarding it.") with three handle classes. All handles are derived deterministically from server-held authoritative records, so they need no new retention store, survive restart and reconnect, and carry no raw provider value.

1. Permission handles. `requestHandle = "p." + message.id` of the stored approval card. Resolution requires the existing live pending permission record for that card's request id and the authenticated audience/thread. Resolved, timed-out, cancelled, torn-down or replaced requests are non-executable: 409 `request_unavailable`, nothing forwarded. The original adapter request id is passed unchanged. This keeps DESIGN-r2's rule for permissions only.

2. Conversation-question handles. `requestHandle = "q." + message.id` of the stored question card; question and option handles index into that stored card (`q.<i>`, `o.<i>.<j>`). Resolution reads the authoritative stored card through `cardByRequest`/message id, not a live request. Allowed exactly when today's code allows it:
   - live engine question: forwarded through `questionReply` to the adapter;
   - `answerAsSend` (`question.async`) card: owner send through `answerAsSendReply`, no adapter request needed;
   - expired direct non-secret, non-folder-trust question: late `sentAsMessage` answer through the existing path.
   Settled, folder-trust-expired, secret-late and already-sent cards return today's exact 409s. Handles are never deleted at turn end; they stop working only when the stored card says settled.

3. Command handles. `commandHandle = "c." + rev + "." + index`, where `rev` is the first 16 hex characters of SHA-256 over the canonical JSON of `EngineCommandCache.get(botId, driver)` (the normalized list) and `index` is the position in it. Resolution requires: authenticated owner surface; `botId` is the bot of the authenticated thread; `driver` is that bot's currently configured engine driver; the cache's current list hashes to `rev`; `index` in range. Then the server sends the original command name and the caller's `args` unchanged, with `sendId` keeping today's idempotency. Mismatch returns 409 `command_list_changed` with the fresh safe command view, and nothing is sent. After restart or reconnect the server rebuilds the same handles from the disk cache with no live turn.

Duplicate submit: permission and live question use the existing settled checks; `answerAsSend` and late answers use the existing `ask-<message.id>` row; commands use the existing `sendId` dedupe. No new dedupe store.

### Tests (RED first), `server/harness/audience-collector.test.ts`

- `execution.handle-async-question-answer`: `question.async` card with no adapter request; answer via handles; one owner send with `sendId = ask-<message.id>` and original answer text. RED: current F8 rejects it as no live request.
- `execution.handle-expired-late-answer`: question expires; late `sentAsMessage` via handles; one owner message with `answersAsMessage` text; secret and folder-trust variants still 409.
- `execution.handle-post-terminal-question`: turn completes, card still open; answer works per existing rules.
- `execution.handle-permission-timeout`: permission times out; `p.` handle returns 409 and nothing is forwarded.
- `execution.handle-restart-command`: restart the server with a populated cache; build the menu; send a command handle; the adapter receives the exact original command bytes and args.
- `execution.handle-reconnect-command`: SSE reconnect between turns; same as above.
- `execution.handle-stale-provider-command`: change the bot's engine, or rewrite the cache list; the old handle returns 409 `command_list_changed` with a fresh list; nothing sent.
- `execution.handle-duplicate-submit`: double submit for each class; exactly one effect.
- `serialized.handle-no-raw`: every emitted handle matches `^(p|q)\.[A-Za-z0-9-]+$`, `^q\.\d+$`, `^o\.\d+\.\d+$` or `^c\.[0-9a-f]{16}\.\d+$`; no provider question id or label appears in any handle.

---

## R3. Engine setup-check path is a classified sink (review point 3)

### Evidence

- `server/engine-reply-check.ts:33-41` `engineLine` uses private regexes; `(password)\s*[:=]` does not match `password**: hunter2`, then control characters and newlines are flattened, so `rate limit **password**: hunter2\nTAILSECRET` leaves as one line with both secrets.
- `server/engine-reply-check.ts:44-56` `replyCheckFailure` passes `failure.engineLine` or `failure.message` to `engineLine`.
- `server/drivers/cli-memory-learning.ts:44-52` stores the raw engine `message` as `engineLine` on the error; its direct subscribers are at `:86` (interactive tracking) and `:163` (hidden reply collection).
- `server/harness/instance-holds.ts:306` subscribes directly with `original.onEvent` for hold accounting.
- `server/index.ts:32019-32029` `POST /api/engine-setup-check` returns `reply` (including `line`) to the client.
- `server/redact.ts:232` `redactSecretsForSink` already exists (F7 keeps the signature).

### Decision

1. In `replyCheckFailure`, compute classification on the original `raw` exactly as today (LIMIT_WORDS, SIGNIN_WORDS, POLICY_WORDS, codes, status). Then compute `const safe = redactSecretsForSink(raw)` on the complete raw text, and call `engineLine(safe)`. The standalone policy always runs before any substitution, flattening or truncation in `engineLine`. `engineLine` keeps its own regexes as a second layer. The `result` enum for every input stays identical to base.
2. Add sink row `S17 engine-setup-check` to DESIGN-r2 section 5: output boundary `server/index.ts` `/api/engine-setup-check` response `line`; policy D1 to D6 via `redactSecretsForSink` before `engineLine`.
3. Add to the subscription manifest (DESIGN-r2 section 4 table):
   - `server/drivers/cli-memory-learning.ts:86` and `:163`: execution-only hidden-session subscribers; they never publish text to an audience. Their only outward text is `error.engineLine`, which reaches the client only through S17. Proof: `execution.memory-learning-subscriber.unchanged`, `serialized.engine-setup-check`.
   - `server/harness/instance-holds.ts:306`: execution-only lifecycle (turn.started/completed/session.exited), no text. Proof: `execution.instance-holds.unchanged`.
   - `subscription.inventory` must list all three.
4. Ownership: add `server/engine-reply-check.ts` and new `server/engine-reply-check.test.ts` to Wave 2B (2B already owns `server/index.ts` in Wave 2).

### Tests (RED first), Wave 2B

- `serialized.engine-setup-check`: real route, fake instance whose `checkReply` rejects with `engineLine = "rate limit **password**: hunter2\nTAILSECRET"` (and a variant with a PEM header, and with `token = sk-...` across a newline). Assert the actual serialized HTTP body contains neither `hunter2` nor `TAILSECRET`, and `result` is `"limit"` exactly as on base. RED today.
- `engine-reply-check.classification-unchanged`: a table of base inputs; the `result` value for each is identical before and after.
- `engine-reply-check.order`: a spy proves `redactSecretsForSink` sees the unflattened, untruncated raw text.

---

## R4. Bounded execution-queue accounting (review point 4)

### Evidence

- `server/harness/bus.ts:53-55` `eventBytes` runs `JSON.stringify(event)` on every enqueued event.
- `server/harness/bus.ts:352-361` `enqueue` calls `eventBytes` before `checkCapacity` (`:371-382`). With a held writer every event is enqueued, so a huge or accessor-bearing execution payload gets an unbounded traversal (and getter calls) after audience exhaustion stopped scanning it.
- DESIGN-r2 line 205 relies on "existing bounded intake/backpressure controls", which are not bounded in work.

### Decision

1. New file `server/harness/event-charge.ts` (Wave 1B) exports:

   ```ts
   export const CHARGE_BUDGET_UNITS = 1_048_576;   // 1 Mi units of work per event
   export const OVERSIZE_CHARGE_BYTES = 8 * 1024 * 1024;
   export type EventCharge = Readonly<{ bytes: number; oversize: boolean }>;
   export function boundedEventCharge(event: unknown, budget?: number): EventCharge;
   ```

   `boundedEventCharge` walks own enumerable properties with `Object.getOwnPropertyDescriptor` only. It never invokes a getter, setter, proxy trap beyond descriptor reads, `toJSON` or `toString`. Strings cost their length plus 2; numbers, booleans and null cost 8; each object/array node costs 16; each key costs its length plus 4; an accessor property costs 64 and is not followed. It stops as soon as the running total exceeds the budget and returns `{ bytes: OVERSIZE_CHARGE_BYTES, oversize: true }`. Otherwise `{ bytes: total, oversize: false }`. Cycles cannot loop forever because the budget bounds total work.

2. The collector computes the charge once during its own bounded manifest extraction when it can (same walk, same budget) and attaches it with a module-private `WeakMap<object, EventCharge>`. On audience exhaustion it stops scanning text but finishes the charge walk under the same budget, never past it.

3. `bus.ts` deletes `eventBytes`. `enqueue` uses the attached charge, else calls `boundedEventCharge(event)`. `JSON.stringify` is never called on a queued event for accounting.

4. Oversize events are still delivered with their original graph unchanged (authorized execution inputs are never altered or truncated). Their 8 MiB charge means at most 2 can sit in one thread's half share (16 MiB) before the existing overflow release and intake close run, which is the backpressure.

5. Reserved terminal/control capacity: events of type `turn.completed`, `session.exited`, `request.resolved` and `runtime.error` (the terminal and control types in `server/contracts.ts`) are enqueued even when intake is saturated, counted in a separate reserve of 256 events and 1 MiB charge. They never count against `maxEvents`/`maxBytes`. If the reserve itself is full, the existing behavior applies and a fixed host-authored warning (no event content) is logged.

6. Replace in DESIGN-r2 line 205 "The execution queue retains the original payload under existing bounded intake/backpressure controls." with "The execution queue retains the original payload; accounting uses R4's bounded charge, never serialization."

### Tests (RED first), `server/harness/bus.test.ts` and new `server/harness/event-charge.test.ts`

- `bus.held-writer-huge-payload-bounded`: real bus, held gate, audience exhausted, an execution event with a 64 MiB nested unknown subtree; assert `JSON.stringify` is never called (spy) and charge work counter stays at or under the budget. RED today.
- `bus.accessor-tripwire`: event with a getter that throws or counts calls, inside an unknown subtree; the getter is never invoked by accounting, the collector or the bus; the listener still receives the same object identity.
- `bus.oversize-backpressure`: three oversize events on one thread while held; overflow release happens on schedule; all three are delivered unchanged after release.
- `bus.reserved-terminal-capacity`: saturate intake with oversize events, then emit `turn.completed`; it is queued and delivered in order after earlier events of its thread.
- `event-charge.exact-small`: small events get exact, deterministic charges; cycles terminate.
- `execution.oversize-unchanged`: deep equality and identity of the delivered execution payload.

---

## R5. Ordered slices (binding)

DESIGN-r2 section 8 stands with these changes.

- 0 Freeze: freeze F1 to F8 as amended by R1 (answer array), R2 (three lifetimes) and R4 (`EventCharge`). Keep the evidence identity gate, independent Astra/Grok/Fable gates and replay acceptance.
- 1A detector/policy (2 to 3 sessions), parallel with 1B and 1C: unchanged files and REDs.
- 1B collector/drivers/execution (3 to 4 sessions): DESIGN-r2 file list plus `server/harness/event-charge.ts` (new), `server/harness/event-charge.test.ts` (new), `server/engine-commands.ts` and `server/engine-commands.test.ts`. 1B owns `shared/audience-wire.ts`. REDs: DESIGN-r2 list plus every R1, R2 and R4 test.
- 1C client wire migration (1 to 1.5 sessions), parallel with 1A and 1B after the freeze: moved here from Wave 3B are the production UI files `src/state/store.tsx`, `src/components/ChatView.tsx`, `src/components/ApprovalCard.tsx`, `src/components/QuestionCard.tsx`, `src/components/OptionCard.tsx`, `src/components/Composer.tsx`, `src/components/EnginesSettings.tsx`, `src/lib/engine-commands-menu.ts`, and the handle/region interaction tests (`src/components/ChatView.redaction.test.ts`, `src/components/ApprovalCard.redaction.test.ts`, new `src/components/QuestionCard.handles.test.ts`). Consumes frozen `shared/audience-wire.ts` read-only. REDs: four-question submit sends one `DisplayAction`; expired card send-as-message via handles; command menu after reconnect; approval allow/deny via `p.` handles. The combined Wave 1 checkpoint (1A+1B+1C) proves question, command, approval and reconnect behavior end to end before Wave 2.
- 2A whole-text activation (1 session) and 2B historical/standalone (1.5 to 2 sessions), parallel after Wave 1: 2B adds `server/engine-reply-check.ts` and `server/engine-reply-check.test.ts` and the R3 tests.
- 3A native cleanup (0.5 session) and 3B sink/performance/diagnostics/CI/packaged G9 (1 to 1.5 sessions), parallel after Wave 2. 3B no longer owns the UI production files (moved to 1C); it keeps test registration in `ci/gate-tests.txt` and `ci/extended-tests.txt`, including the new suites from R1 to R4.

Estimate: 10 to 13 builder-sessions (DESIGN-r2's 9 to 12 plus about one for R1 to R4). G9 packaged proof, Fable UX proof and independent Astra/security review on the combined head stay required.

## Decisions for Sean

None. All four points are technical and closed above.
