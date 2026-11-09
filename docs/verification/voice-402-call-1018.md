# VOICE-402-CALL 1.0.18 verification

Audit source: `../inputs/VOICE-402-CALL-1021-BUILD.md`, rev 4.1 AGREED,
provided by the verify driver on 2026-11-06. Its original train/base/path
instructions are superseded by the 1.0.18 relaunch brief. BASE18 is
`a5450e2b532fdb4e66dc8aaf1a1c83f20422dc41`; the first implementation is
`6802abf50210279217c94bdb247e8edfe169906f`.

## Rev 4.1 checklist, relaunch 2

The full design and both formal-2 verdicts are now supplied under
`../inputs/VOICE-402-CALL-1021*.md`. The relaunch brief explicitly moves all
this work into **1.0.18**. The design's older train labels do not defer scope.
The memory prelude tool and `.ijfw/memory` are unavailable in this checkout.

| Requirement | Implementation and evidence |
| --- | --- |
| §6.1 one classifier, both G3 envelopes | `shared/flux-refusal.ts` classifies nested/flat codes, HTTP status and socket close reason. Premium is distinct; normal model prose is not a refusal. Classifier tests cover all three inputs. |
| §6.1 speech | `server/tts/flux-speech.ts` uses the shared classifier. `budget-stop.test.ts` covers OpenAI, Grok and Eleven voice families, both envelopes, no further paid speech. |
| §6.1 transcription | `flux-voice.ts` emits nonretryable budget, marks the memo; `transcribe-route.ts` returns 402 with reason budget; `call-mic.ts` preserves that reason. Own-provider payment errors do not masquerade as Flux budget. |
| §6.1 socket handshake and close | `flux-stream.ts` reads bounded handshake bodies, marks the memo, retains close reasons and closes on budget frames. Shared stream codes and relay preserve budget. Loopback handshake tests cover both budget and premium envelopes. |
| §6.1 engines | ACP and OpenAI adapters retain `ProviderErrorInfo.fluxBudget` only on a known Flux route. Both mark the existing memo. OpenAI also recognizes in-band budget frames. Fake ACP and mocked HTTP/SSE tests cover both shapes and premium controls. No payment/billing prose heuristic remains in call termination. |
| §6.2 terminal call handling | Both call views latch the existing stop ref before fallback; stop capture/host/queues, interrupt the running turn normally, attempt only system closing speech, and end with reason budget even if closing speech fails. Budget observations precede approval/narration. The call controller retains the approved message for display after hang-up and clears it on a new call. |
| §6.2 no paid fallback | Speech returns 402 for ordinary call output on budget; only the explicit closing request may return a system clip (200), otherwise 402. Server and renderer speech tests assert request counts and system-only closing. |
| §6.2 host and lookup admission | Existing per-key memo is checked before host, brief and lookup dispatch. Flux memo identity spans models, websocket/HTTP and protocol paths on the same origin; different keys and owner providers are separate. |
| §2b(i) / §6.2b HTTP 200 frames | `readCompletion` recognizes a structured budget before/after partial text, retains its type through brief/lookup catches and never hands down. `voice-budget.test.ts` covers both positions and all accepted shapes. |
| §2b(ii) / §6.2b detached warm-up | Warm-up marks the existing memo; the next host/lookup reads it. Tests assert exactly one upstream request for warm-up plus subsequent attempts and no lookup when its memo is already set. No new notification channel. |
| Formal-2 Astra Medium: search/images | Search and image adapters classify before information loss and throw typed `FluxBudgetReached`; generation, edits and image SSE are covered. Internal tool routes record the signal on the authenticated caller's existing conversation channel even when an engine consumes a tool error and continues. Both call views read it. |
| Formal-2 Low: missing regressions | Added lookup/no-hand-down, HTTP-200 before/after partial output, detached warm-up and memo admission tests, plus formal-2 tool adapter regressions. |
| §6.3 exact copy | Exact approved English call-end and Settings strings, translations in all eight packs, SHA-256 source hashes for all seven translated packs. Settings text appears under Engines and Voice. Tests pin the exact English, translations, hashes and no dash/safe/free wording. Existing speech-budget copy remains separate. |
| §6.4 speech 402 mid-call | Three voice families × two envelopes; ordinary call speech raises budget, zero later Flux speech requests, only system closing allowed. |
| §6.4 stream budget close | Executable StreamMic tests assert one terminal end, closed frame source, no reconnect and no batch fetch after 120 seconds. Premium retains the existing non-budget behavior. |
| §6.4 engine budget mid-call | Fake ACP + OpenAI HTTP/SSE produce the typed signal; call views consume typed conversation errors before narration and interrupt. Call-controller test proves reason retention, ownership and independent next call. |
| §6.4 premium does not end for budget | Classifier, host, socket, engine and image negative controls distinguish premium. Generic owner billing errors never set the Flux flag. |
| §6.4 second call on spent key | Server memo tests repeat host/brief/speech after the first refusal and assert no additional Flux request; client controller clears the last call's end reason and renderer speech hold on start, not the server memo. |
| §6.4 owner route still works | Speech and image tests explicitly select an owner provider after Flux refusal and succeed. Connection changes and explicit new call starts clear the renderer speech hold; no automatic paid fallback is introduced. |
| No new persisted budget state/seal/lease/proxy | Only the existing memo and live call lifecycle are used. Tool failures use the existing typed provider-error transcript field. No new table or billing fence. |

### Scope of local proof

The isolated fake-engine fixture passed doctor and was stopped; all its data,
logs and runtime directories stayed under this lane. Unit/adapter tests drive
real loopback sockets and the production microphone, speech and call-controller
code with fake providers. The large call views also have source-contract tests;
these are **not a rendered Electron end-to-end call test**. The verification
harness explicitly cannot drive renderer-only behavior. A packaged/rendered
smoke remains a driver validation gate, not claimed by a doctor pass.
No provider keys, paid API calls, installations, billable resources or pushes.

## Staging endpoint contract implemented by this client

Configure an enabled Flux connection with the staging `baseUrl` INCLUDING
`/v1` and a staging-only key. `voiceEndpoints` trims trailing slashes and
uses that connection for host, lookup and speech. There is no hard-coded
production URL in these call paths. Keys stay on the server.

All three routes use Bearer authentication and JSON request bodies:

- `POST <baseUrl>/chat/completions`: model, messages, streaming OpenAI-shaped
  completion deltas/tool calls. Warm-up requests one token, without streaming.
- `POST <baseUrl>/voice/lookup`: `{query,instructions,model}`. Success is
  SSE OpenAI text deltas followed by `{object:"flux.voice.lookup.done",...}`;
  HTTP 200 or `[DONE]` alone does not establish success. Errors can use
  `{object:"flux.voice.lookup.error",error:{code,message}}` or flat `error`.
- `POST <baseUrl>/audio/speech`: OpenAI-shaped speech body (`model`, `input`,
  `voice`, audio format); successful audio has an `audio/*` content type.
  Speech models include `flux-voice-speak`, `flux-voice-speak-grok`, and
  `flux-voice-speak-eleven`.

HTTP 402 supports `{error:{code:"key_budget_reached",message:"..."}}` and
`{error:"key_budget_reached",message:"..."}` (also top-level `code`).
`budget_exceeded` and balance refusals are supported. `premium_locked` stays
a plan refusal, not a budget memo. Other HTTP 402 responses stop for budget.
Host/brief/lookup HTTP 200 SSE streams can contain those structured budget
errors before or after text. A recognized terminal frame must suppress later
lookup, completion and hand-down; ordinary model text mentioning budget is
not a refusal. The memo is shared by key/base URL/provider for ten minutes;
a new key, explicit recheck, or route reset clears the applicable hold.

The renderer requests `/api/tts/speak` with `call:true` for normal call speech.
A budget refusal returns HTTP 402 `{error:<plain line>,code:"voice_budget_reached"}`.
The final request uses `budgetClosing:true`, bypasses paid preparation, and
uses only a system voice: HTTP 200 audio if available, otherwise 402. The
call ends after that attempt regardless of whether audio is available.

Driver staging evidence should record request counts and terminal events
for both HTTP shapes, both partial-output positions, warm-up-only refusal,
lookup memo admission, and all three speech voice families. This contract is
the implemented client contract, not confirmation of Flux F-1..F-6.

## Release baseline and release-note limits

Compare the complete lane diff with BASE18, and compare runner head/base
results with release run `42028153798`. The supplied ledger identifies that
release with short SHA `f28a6bad`, but neither that commit nor the run artifacts
are present here (`git rev-parse --verify f28a6bad^{commit}` fails). No network
or release credentials are available/authorized for retrieving them. The
driver owns full-suite comparisons; local targeted green is not evidence of
zero NEW against the release. No READY row or push claim is made here.

Required release wording until F-1/F-2 confirmation: **The call ends on
Flux's existing 402 codes.** Do not claim a pre-spend budget fence, reservation,
zero in-flight overshoot, or verified capability billing. The provided ledger's
Flux audit says those were not established. All scope remains in 1.0.18.

## Earlier relaunch results (2026-11-06, before full design)

- Targeted Vitest plus direct neighbours: **499 passed, 0 failed, 17 files**
  (`../scratch/relaunch-tests.log`). No full suite run.
- Expanded speech matrix rerun: **12 passed, 0 failed**
  (`../scratch/relaunch-speech-matrix.log`). These overlap the targeted set.
- New HTTP-402/callback regression cases against BASE18 implementation:
  **5 failed as expected, 15 skipped** (`../scratch/relaunch-client-base-red.log`).
  The fixed source was restored after the test; no baseline mutation committed.
- Server and renderer tsc: **exit 0 each**, both with
  `NODE_OPTIONS=--max-old-space-size=8192`; logs in
  `../scratch/relaunch-tsc-{server,client}.log`.
- Initial launcher attempt could not find `pnpm` (exit 127); tests and tsc
  were then run successfully through the already-installed local Node entry
  points. No dependency installation was performed.
- Fixture doctor: **PASS**, fixture closed (`../scratch/relaunch-fixture.log`).
- Those earlier results preceded the full-design audit above; relaunch-2 results below supersede them.
- Restored client head rerun: **20 passed, 0 failed**
  (`../scratch/relaunch-client-head.log`), including all five baseline-red cases.

## Flux and release gates

F-1/F-2 need FluxMain confirmation of all billed routes/credentials and exact budget versus premium bytes. F-3 needs the stream-close bound and overlapping in-flight overshoot; F-4 needs counter reconciliation/drift evidence; F-5 needs confirmation refusals are unbilled and do not revoke keys; F-6 needs the production limits route and reset/manage fields. None can be established with local mocks. The driver supplied no staging endpoint/key or release-run artifacts. Do not call production to manufacture this evidence. The full design confirms these are Flux dependencies, not a Murage local fence.

The supplied formal-2 AGREE verdicts are design reviews, not reviews of this diff. The driver runs the new Astra/Grok reviews and pushes. Until those gates and release comparisons are supplied, this lane is NOT READY. Nothing is assigned to a later train.

## Relaunch 2 results (2026-11-06)

- Full-design audit and implementation span shared classification, voice/STT/TTS,
  ACP/OpenAI adapters, search/image tools, both call views/controller, Settings,
  all eight locale packs/hashes and their targeted regressions.
- Broader targeted pass (including the entire direct ACP neighbour file):
  **1,374 passed, 0 failed, 26 files** (`relaunch2-tests-final.log`).
- Updated targeted files plus direct neighbours: **1,004 passed, 1 failed,
  29 files** (`relaunch2-final-targeted.log`). The sole failure was the generic
  price-copy rule rejecting the exact §6.3 approved sentence. A documented,
  single-key exception fixes it; the locale test still pins the exact text.
- Final rerun of that correction and updated classifier/call neighbours:
  **365 passed, 0 failed, 11 files** (`relaunch2-final-check.log`).
- New fake-ACP budget/premium envelope matrix: **4 passed, 0 failed,
  453 skipped** (`relaunch2-acp-budget-final.log`). Its first attempt used a
  synthetic driver that cannot carry Flux headers; using the fixture's Fuigo
  driver identity exercises the real adapter boundary and passes.
- Final own-key/new-call and speech-hold regressions: **26 passed, 0 failed,
  3 files** (`relaunch2-call-own-final.log`). These reruns overlap; do not sum
  their counts as unique tests. No unresolved local test failure.
- BASE18 comparison: a detached scratch worktree with unchanged BASE18
  implementation and the current regression tests produced **54 expected
  failures, 9 passes, 400 skipped** (`relaunch2-base-matrix.log`, 12 files).
  Selection covered speech, socket, transcription, engine, host/brief/lookup,
  warm-up, tools, call reason and exact copy. Negative controls (premium and
  independent owner routes) already passed on base; they are deliberately not
  falsified to manufacture red evidence. The worktree was removed afterward.
- Server and renderer tsc: **PASS, exit 0**, with
  `NODE_OPTIONS=--max-old-space-size=8192`, `--noEmit`, projects
  `tsconfig.server.json` and `tsconfig.json`. Logs:
  `relaunch2-tsc-{server,client}-final.log`.
- Fixture doctor **PASS**, fake engine only, fixture stopped and data removed.
  `relaunch2-fixture.log` retains the doctor JSON. Persistent server log:
  `../scratch/murage-verification-evidence/server-1793974286580-781.log`.
- Test commands use the installed `node node_modules/vitest/vitest.mjs run`
  entry point, explicit file lists above, and `TMPDIR="$PWD/../scratch"`.
  BASE18 used `--root ../scratch/base18` and the matrix name filter recorded
  in the lane execution transcript. No install or full suite was run.
- `git diff --check` passes. All log names above are under `../scratch/`.
  Release commit `f28a6bad` and run 42028153798 artifacts remain unavailable;
  no zero-NEW release comparison, external review PASS, push or READY is claimed.

## Review-fix relaunch, 6 November 2026

All nine items in `../review-findings.md` are accepted and addressed. There
were four High and five Medium findings, with no Critical or Low findings.

| Finding | Change | Executable regression |
|---|---|---|
| 1 High: Claude/Codex lose budget refusals | Classify only CLI error frames on the captured Flux route, preserve RPC data, emit `providerError.fluxBudget`, and mark that route's key. Premium and owner routes stay separate. | `claude.test.ts` and `codex.test.ts`: “preserves the routed CLI refusal … and its key”; `cli-flux-budget.test.ts` covers structured and CLI-wrapped envelopes and owner/premium controls. |
| 2 High: owner lookup 402 becomes Flux budget | OpenAI, xAI and Anthropic lookup failures no longer enter Flux classification or its memo. | `voice-budget.test.ts`: “owner … lookup 402 never sets Flux budget or holds the route” (three providers). |
| 3 High: premium bare socket close becomes budget | Preserve `premium_locked` as a typed close error even without a preceding error frame. | `stream-uplink.test.ts`: “preserves premium on a bare 4402 close for StreamMic classification”. |
| 4 High: call A's cue refusal affects B | Speech holds carry a route generation; stale and cancelled fetch results cannot update it. Prewarming carries an abort signal owned by the view. | `budget-hold.test.ts`: “ignores a late cue refusal after call reset/abort”; view prewarm test checks abort and a subsequent independent call. |
| 5 Medium: prewarm swallows budget | Forward the active call's terminal callback through CueCache and stop subsequent cue dispatch after a refusal. | `cue-cache.test.ts`: “prewarm forwards budget to its call and stops dispatching further cues”; `call-budget-behavior.test.ts`: “cue prewarming ends its call on budget and aborts when the view unmounts”. |
| 6 Medium: teardown restarts recognition | Guard recognition start, listen, open, ready and retry paths with the terminal latch. | Both bot refusal cases in `call-budget-behavior.test.ts` synchronously deliver a native end event during close and assert no additional recognition start. Removing only the openTurn/listen guards causes both tests to fail (1 expected start versus 2). |
| 7 Medium: speech completion controls terminal state | End the shared call/session and retain budget copy immediately. Optional closing speech has an independent five-second deadline, including a fetch that ignores abort. | All four bot/group × engine/speech lifecycle cases hold closing speech pending, check immediate end/copy, then complete it after starting a new same-target call; `budget-hold.test.ts`: “closing speech has a deadline even if the fetch ignores cancellation”. |
| 8 Medium: spent keys admit dispatch/retries | Check the existing memo immediately before transcription, socket creation, and every host retry. | `flux-voice.test.ts`: “a spent transcription key sends no second upstream request”; `flux-stream.test.ts`: “a memoized key never opens a transcription socket”; `voice-budget.test.ts`: “a concurrent warm-up refusal prevents the host first-token retry”. |
| 9 Medium: lifecycle tests only pin source | Execute both production views and their effects through a deterministic hook scheduler with isolated microphone, speech, session HTTP and socket fixtures. Existing source assertions remain unchanged. | `call-budget-behavior.test.ts` drives typed engine errors and speech callbacks, asserts interrupt, mic closure, no recognition restart, immediate owner notice/session end, same-target replacement and prewarm cancellation/request count. |

The reviewed HEAD (`1244618c0d50c25b85b8c76911806a45d04e457c`), with only
new tests and fake-CLI stimuli copied into an isolated worktree, produced
**20 expected failures, 2 passing premium controls, 501 skipped**. The separate
recognition-guard mutation produced **2 expected failures, 3 skipped**.
Evidence: `../scratch/review-base-red.log` and
`../scratch/review-recognition-red.log`.

These are behavioral tests of the production view functions/effects and
adapters, not a packaged Electron visual/audio smoke test. No real provider
API was called. No billable resources, installations or pushes were made.
The external Flux staging/F-1–F-6 and driver review/release gates from the
previous handoff still require the driver's supplied environment.

### Isolated harness smoke

Launched with `TMPDIR="$PWD/../scratch" node --experimental-strip-types
scripts/control-murage.ts launch`. The fixture URL was
`http://127.0.0.1:20352`; its data directory was
`../scratch/murage-verify-data-SGGWPZ`. With `MURAGE_DATA_DIR` explicitly set,
ran `doctor`, `new-bot --name ReviewFixture`, `send --bot
 e9d1788e-cceb-4c31-a99f-f4932fb75a0b --text hello`, `wait --bot
 e9d1788e-cceb-4c31-a99f-f4932fb75a0b --timeout 30`, and `messages --bot
 e9d1788e-cceb-4c31-a99f-f4932fb75a0b --limit 10`, each with that explicit URL.
Doctor passed; wait returned `settled`; messages contained “hello from fake
claude”. Ctrl-C stopped the owned fixture and removed its data directory.
JSON evidence: `../scratch/review-fixture-{doctor,bot,send,wait,messages}.json`.
Persistent server log:
`../scratch/murage-verification-evidence/server-1793977686356-2778.log`.

### Container test isolation

All temporary homes and data use the lane's `../scratch` through `TMPDIR`.
This container's PID 1 does not reap orphaned fake-CLI children. Four
`claude-warm.test.ts` teardown checks reproduced identically on base/head
(`CLAUDE_SESSION_NOT_STOPPED`); the same four passed unchanged under
`../scratch/reap-run.py`, a Linux child-subreaper wrapper that reaps only its
own descendants. No test, process-exit check or timing threshold was weakened.
The final targeted command is recorded in `../scratch/review-final-tests.sh`.
The earlier broad run was superseded after identifying this fixture issue.

### Final local results

- Main targeted run: **1,395 passed, 2 failed, 2 skipped** across 33 files
  (`review-final-tests.log`). The failures were the old source assertion's
  exact cancellation-guard spelling and a noncanonical `TMPDIR` string in a
  neighbour's existing path comparison. The original guard is now retained
  verbatim with a separate preceding budget guard; `TMPDIR` is canonical.
  Neither existing test nor threshold was changed.
- Corrective run of both affected files plus call/audio/session neighbours:
  **281 passed, 0 failed**, 10 files (`review-corrections.log`). Every main-run
  failure is resolved. Final covered main assertions: **1,397 passing**, with
  the same 2 existing skips; rerun counts overlap.
- Additional stream/transcription routes, server speech and read-aloud
  neighbours: **140 passed, 0 failed**, 6 files (`review-neighbours.log`).
- Both `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.server.json --noEmit`
  passed with `NODE_OPTIONS=--max-old-space-size=8192`; logs are
  `review-renderer-tsc.log` and `review-server-tsc.log`.
- Isolated fixture doctor and chat smoke passed, fixture closed, and temporary
  regression worktree removed. Packaged UI/staging/driver gates remain external;
  no item from this review was deferred or rejected.
