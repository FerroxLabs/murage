# D-REDACT-MD r3.2, Codex fold by Fable, 2026-11-06

## 0. Scope (reviewers judge this scope only)

Full design for Murage 1.0.18. This is one targeted fold of D-REDACT-MD-r31, preserving unfaulted rules and tests. In scope: user-visible text and every caller of `redactSecretsInText`; per-turn engine-output protection on native logs and the live bus for Claude, Pi, Codex, ACP, Antigravity, openai-chat and boxagent; torn native records; exact oracles; and the L7 text ownership handoff. All named fixes and tests belong to 1.0.18. Nothing is deferred.

Code citations are relative to `/root/swarm1018/_base18-ro`, BASE18 `a5450e2b`. Input design: `/root/swarm1018/D-REDACT-MD-mac/designs/D-REDACT-MD-r31.md`. Review: `/root/swarm1018/_reviews/D-REDACT-MD-astra-r31.md:1`, findings 1-7, with `VERDICT: BLOCK` at line 69. Findings are named A32-H1, A32-H2, A32-M1 through A32-M4, A32-L1 here. All seven are valid; none is refuted.

Out of scope: L7's machine span collector implementation, Electron diagnostics and feedback implementation, table-cell policy, renderer behavior, phone-withhold policy and owner-authored prompts outside an open turn. The shared label vocabulary is consumed, not independently redefined. The review's OUT OF SCOPE section at lines 65-67 contains no additional findings; it excludes detector vocabulary, table cells, renderer behavior and phone withholding. L7 owns the shared registry and collector. REDACT owns user-visible policy and `redactSecretsInText`, including row 24 replacement.

Status: proposed design closure, not runtime evidence and not AGREED. After this fold: Astra on another account, file-reading Grok, then one Fable critique of the final revision. Agreement requires Fable's explicit AGREE. Another High round on the same root or a round-1 item NOT FIXED returns this lane to a Fable design pass.

## 0.1 The three binding rules (MurageMain, approved) and where each lives

| rule | design section | one line |
|---|---|---|
| R1 Protection is monotonic per turn: an evicted or ended id can never read as clean, and a repeated start never reopens it | §3.1 (the id life cycle: fresh allocation, live, retired, unknown; observed starts never allocate) | state for an id only ever moves toward "masked" |
| R2 One shared scanner sits at one choke point for every driver (Pi, Codex, ACP, Claude), before the native log and the live gate | §3.2 (`admit` at the driver's intake; the two gates consume its decision and never scan) | one admission per emitted byte run; its sinks share the decision |
| R3 An open turn masks every carrier, including tool title, summary, detail and whole completions | §3.3, §3.4 (`withholdEvent`, `withholdFrame`, `maskItem` whole) | after the label, nothing of the turn is readable but discriminators |

## 0.2 Rev 3 findings and the structure that closes each

| id | reviewer | sev | one line | closed by |
|---|---|---|---|---|
| A1-r3 | Astra | High | completion ownership inferred from a counter the reasoning stream shares; `hunter2` completion released | R3: an open turn's completions are masked whole, no ownership (§3.3) |
| A2-r3 | Astra | High | eviction then a repeated `turn.started` recreates the id as clean | R1: evicted and ended ids retire; a start on a retired id is a no-op (§3.1) |
| A3-r3 | Astra | Medium | native scans first and sets `open`; the live gate then drops the opening head | R2: one `admit` at the driver, one decision for both sinks (§3.2) |
| A4-r3 | Astra | Medium | T8, T-14(c), T-14(d), T-X(c) oracles contradict the code | §6, §8.3 literals recomputed from the code |
| G-H1 | GrokBuild | High | a non-delta native frame never opens the turn (non-stream `assistant`, same-frame label and value) | R2: `admit` walks every string leaf of a non-delta frame before the log (§3.2) |
| G-H2 | GrokBuild | High | same as A1-r3 | R3 (§3.3) |
| G-M1 | GrokBuild | Medium | `content.reset` deletes an unfinished label line while `open` is false | §3.2 reset forks the scanner: the next bytes are read as a continuation and as a new line |
| G-M2 | GrokBuild | Medium | T8's last oracle: one 25-char marker, not two markers | §6 (E10) |
| G-M3 | GrokBuild | Medium | tool input, result, detail and `plan.updated` reach the events log and the plan UI raw in an open turn | R3: `withholdEvent` on every event of an open turn; `plan.updated` entries get extent A always (§3.3) |
| G-M4 | GrokBuild | Medium | same as A3-r3 | R2 (§3.2) |
| G-M5 | GrokBuild | Medium | only Claude's `appendNative` calls carry `turnId` | R2: every driver admits and tags at its intake; static test per driver (§3.5) |
| G-L1 | GrokBuild | Low | `withholdSecrets` restores any letter-only `msg.type` | §3.4: restore only exact paths with values in a fixed per-source allowlist |
| G-L2 | GrokBuild | Low | last-byte read placed before the rotation block | §5: read after rotation, right before the one `appendFileSync` |
| G-L3 | GrokBuild | Low | `turnStarted` "keep as is" vs "move to newest" | §3.1: delete and set again, `open` kept |
| G-L4 | GrokBuild | Low | a same-id relaunch after `turn.completed` would be unknown | not a sequence the code produces (§3.1, evidence); closed anyway by R1 and T-L1 |
| G-L5 | GrokBuild | Low | citations | §8.3, §8.4 corrected; the base.json lines are 46, 47, 49 (see §8.4) |

Rev 1 and rev 2 closures that rev 3 made and the reviews did not fault are kept (§9 lists them all).

## 1. What stays (never faulted, kept as shipped)

- The shared detector behavior, consuming L7's sole label registry rather than copying the vocabulary (shared/md-secret-label.mjs:47-59); `createLabelStream` and `scanLabelDelta` (85-105, `scanSegment` 107-159); the split-equivalence test (native-md-stream.test.ts:209-239) and the clock (241-258).
- REDACT does not change L7 machine policy. Retained BASE18 extent A guards cover `maskSecretLabelsToEnd` (md-secret-label.mjs:63-76), `redactSecretsForSink` and `redactSecretsForSinkWalk` (redact.ts:232-241), electron `redactSecretsInLine`. G1 and G2 preserve wrapped-label guards; additional machine behavior belongs to L7.
- The markers `«redacted N chars»` and `«redacted»` and `isExactMarker`.
- "Detect by label, never parse a value"; one function per audience; linear time per rule (redact.test.ts:465).
- The 64 KiB line cap as a reason to open, the 512-character shape tail (`maskWithTail`, native.ts:210-217, moved), `STREAM_TEXT_RULES`.
- pi.ts:227-236 and acp/core.ts:2235-2240 run `redactSecretsInText` on one line, no code change.
- S1 (extent A for user-visible text, §2), S3 (§5) and S4 (§6) of rev 3, with the corrections named in §0.2.

Not kept from rev 3: `openedAt` and `items` (ownership by counter); the two-kind key space (`live:` and `native:` streams) and both gates scanning; the `turnEnded` delete with recreation on a later start; the regex restore in `withholdSecrets`; `resetStream` as a plain delete; the `type: "user"` reset (already removed in rev 3, G2-r2).

## 2. S1: user-visible text, owned by REDACT

Retain extent A for wrapped labels: after the first qualifying separator, mask to end of supplied text, including prose, blank lines, quotes, fences and PEM. Keep the original prefix and §6 marker formula. Do not parse a secret value or search for a closer. The one new exception is a code-span label followed on that same line by exactly one unquoted lowercase type word and no other content except horizontal whitespace. The fixed list is `string, number, boolean, null, object, array, undefined, unknown, any, void, never`. Those words are unchanged only for this code-span form. `String`, `string[]`, quoted words, `string | null`, and a type word followed by another nonempty line do not qualify. A label must name a secret according to the shared registry. Bare code mentioning a field is not a label. K-CODE-SECRET: `` `password`: hunter2 `` masks as `` `password`: «redacted 8 chars» ``. K-CODE-TYPE: `` `token`: string `` is unchanged, with the other code-shaped prose rows. Test every listed type word and each rejection case.

Plain-label addition, held at this exact rule until the replay count: colon only, one non-whitespace word on one line, any positive length. Match a registry-recognized label at its token boundary, colon, optional horizontal whitespace, a nonempty word through line end, optional horizontal whitespace. Preserve the separator whitespace and mask the word. Do not add a type-word exception to plain labels. Do not let this new rule match equals, empty values, multiple words or multiline values. Existing provider, query, Bearer and equals rules remain. Thus `password: hunter2` becomes `password: «redacted 7 chars»`; `token: x` becomes `token: «redacted 1 chars»`. BASE18's eight-character value floor is at server/redact.ts:152 and its blanket short-text exit at :220. Remove the blanket short-text exit for newly protected cases. Registry prefix handling applies equally here, including `my_token: x`, which therefore ceases to be a text guard. No local name regex.

K-REPLAY: replay the complete available owner-text corpus and existing text fixtures through base and this exact rule; report total records, changed records, counts by wrapped/code/plain/provider rule, and counts of new exact-grant refusals and dropped done_when values. Use synthetic or masked examples in the report, never raw credentials. Do not invent a count in this design. MurageMain rules on the count before implementation begins; this is a pre-build acceptance gate, not a deferred feature. Retain the rule above until that ruling. At server/auto-approve.ts:382, any new text change refuses an exact allow key. At server/done-when.ts:20, any new text change drops the value. K-CALLERS exercises the actual functions for `password: hunter2`, the code secret, the code type guard, and ordinary prose; also checks restored done_when through doneWhenBriefLine at :27. No independent caller policy changes.

### 2.1 L7 collector seam and merge order

Merge L7 first, then REDACT. L7 BF-9 creates shared/credential-patterns.mjs and .d.mts; that file is absent on BASE18, so do not cite it as existing code. BF-9 at /root/swarm1018/BF-L7-VISIBILITY-cx/designs/BUILD-FIX-L7-VISIBILITY.md:91-101 and L7 §4.1 at /root/swarm1018/D-L7-VISIBILITY-r31/designs/L7-VISIBILITY-1018-r31.md:196 define the sole vocabulary. Consume its offset-preserving label candidates and provider spans. The seam in server/redact.ts is audience-specific span selection/rendering before replacement: the machine collector keeps L7's tail-to-end semantics; the REDACT text adapter chooses §2 label spans and the type exception. Do not wire the broader machine label policy into redactSecretsInText or make a machine sink depend on that text policy. Extract shared lexical recognition if needed; do not copy name patterns into server/redact.ts or shared/md-secret-label.mjs. The streaming detector consumes that same name registry while keeping its incremental state API.

L7 leaves redactSecretsInText's audience policy and md-secret-label.test.ts:112 row 24 alone. BF-9's prior direction to adapt that text function and its text R1 assertions moves here. Provider/collector improvements still ship in L7's machine sinks, Electron and feedback. L7 then REDACT has a gap no worse than BASE18: existing user-text behavior and row 24 remain during the gap, and machine protection only improves. K-MERGE checks base and the L7-only intermediate revision before the final REDACT revision.

For text, retain PEM-first precedence: collect PEM and label positions on original input; discard a text label candidate whose separator is inside an already protected PEM body. A label before PEM still extends to input end. This reproduces E10 without passing text altered by provider masking into label recognition. Union provider and selected label spans on original input, then render once. Preserve exact markers and unrelated financial masking. Expose this as the text MD_LABEL policy slot after PEM selection, before provider replacements, not as a second destructive pass over L7 output. STREAM_TEXT_RULES excludes label extents and uses the shared provider collector; the incremental turn scanner supplies the conservative wrapped-label latch.

Extent A meets L7 tail-to-end where both recognize a wrapped labelled value, including blank lines and dedentation. It is intentionally not equivalent for plain no-separator/multiline labels or the code type exception. Those are audience policy differences, not a missing machine fix. K-PARITY feeds `**password**: hunter2\nmore\n` through the sink and visible text: both exactly `**password**: «redacted 14 chars»`. K-CODE-TYPE stays visible as written in the standalone text function while machine collection masks it. Once an engine turn has latched, whole-carrier withholding still overrides standalone text exceptions.

All callers remain in scope, including store, cards, channels, plan text, Pi error detail (pi.ts:227-236) and ACP notice (acp/core.ts:2235-2240). The latter two still take one line. No rendering change. T10 measures the adapter and shared span selection without quadratic rescans.

## 3. S2: one owner of turn state, three binding rules

### 3.1 Registry-owned fresh allocation, never allocation by observation (R1)

Only `allocateTurn()` creates a clean state and returns a fresh server ID. It takes no caller-supplied ID. Use a registry-owned process incarnation nonce plus an increasing nonwrapping counter in the UUID-compatible ID generator; incarnation identity must be fresh on process/registry creation and must never be restored from a turn or engine frame. Use cryptographic uniqueness as for existing server IDs; fail closed on entropy or counter failure. Tests inject separate fresh incarnations, never restart the counter in the same incarnation. A registry reset creates a new incarnation. No import, restore, deserialization, start event or driver retry can insert an arbitrary ID.

```
TURNS_MAX = 4096
RETIRED_MAX = 65536
TAIL_CHARS = 512
Kind = "text" | "reasoning" | "tool_input"
Stream = { label: LabelStream, pending: LabelStream | null, tail: string }
TurnState = { open: boolean, streams: Map<Kind, Stream> }
live = Map<serverTurnId, TurnState>()
retired = Set<serverTurnId>()   // bounded diagnostic cache, never an admission authority

allocateTurn(): generate fresh ID; insert {open:false, streams:new Map};
                retire oldest live entries beyond TURNS_MAX; return ID
turnStarted(id): if live.has(id), move that SAME state to newest; otherwise no-op
turnEnded(id): live.delete(id); retire(id)
retire(id): add tombstone; evict oldest tombstones beyond RETIRED_MAX
turnOpen(id?): true unless live contains id with open === false
openTurn(id): if live contains id, set open=true; otherwise no-op
```

Unknown stays unknown on start, and remains masked. Retired stays retired on start. Neither tombstones nor the lack of one authorize a clean state. A fresh allocation is a new identity, never a state transition of an old ID. Registry maps are private; no public register(id), clear-and-repopulate or restore-live API exists. Repeated live starts refresh recency but keep scanners and open state.

Replace turn ID allocation at pi.ts:836, codex.ts:663, acp/core.ts:2525, antigravity.ts:537, boxagent.ts:111 and openai-chat.ts:1059. At claude.ts:3615 use `relaunch?.turnId ?? allocateTurn()`; a retry keeps its original ID, even if that ID has retired. Claude prewarm's newId at :5638 is a reservation identity, not a clean real turn: leave it unregistered and withhold its input. The real send allocates separately. Retire allocations on terminal failures and cancellation, including failures before turn.started. Native and bus state is ready before the first prompt because allocation precedes emission.

G-L4's retry evidence remains: claude.ts:3635, :3649, :3660 emit starts only when !relaunch; :5347-5351 retries before the one final completion. A hypothetical late start still cannot reopen an ended identity. Capacity remains bounded at 4096 live states with three stream kinds and two bounded scanners per kind, plus 65536 tombstones; no unbounded historical-ID set is needed. Measure actual heap use in S-5 rather than asserting exact JavaScript object sizes.

Every tombstone departure, including whole-cache loss, has its own row. No other departure is allowed; a static mutation test rejects deletion outside retire's capacity loop and registry destruction.

| Departure path | Rule | Test |
|---|---|---|
| RETIRED_MAX capacity eviction after live-capacity retirement | Old ID stays unknown, starts cannot allocate | T-E-cap: open T, live-evict T, tombstone-evict T, repeat start T, send delta and completion; log masked, bus delta absent, completion whole |
| RETIRED_MAX capacity eviction after turn.completed | Same | T-E-end: end T, overflow tombstones, repeat start and both carriers |
| RETIRED_MAX capacity eviction after session.exited or pre-start failure cleanup | Same | T-E-exit: both terminal routes, overflow, repeat start and both carriers |
| Clean shutdown and process restart | Fresh registry incarnation, old IDs never imported | T-E-restart: old T repeated start first after restart, delta/completion masked; newly allocated Q works |
| Abrupt crash/process death | No in-memory history survives; absence cannot grant | T-E-crash: same as restart after injected loss during write; T-X repair assertions also apply |
| Module reload, hot reload or test registry replacement | New incarnation and no restore-live path | T-E-reload: recreate module, old T start plus late token/delta/completion rejected or masked |
| Explicit clear, individual removal, timer expiry, persistence restore, allocator accepting an ID | Forbidden paths, not supported operations | T-E-api: import/API inventory and bypass mutations; removing a tombstone manually in a test still cannot make an observed start clean |

T-E is the dedicated A32-H1 High test and runs every T-E row with both originally open and clean-ended T. Assert late delta and completion after the repeated start, not merely turnOpen. Remove the allocator boundary in a test mutation and reproduce the review leak.

### 3.2 The one scanner at one choke point (R2)

```
admit(turnId: string | undefined, frame: { delta?: { kind: Kind; text: string }; msg?: unknown }): Admitted
class Admitted { turnId; kind; source; frameSequence; deltaPath; registryIncarnation; consumedNative: boolean; state: "clean" | "opened" | "closed"; text; native; live; consumedLive: boolean }
```

`admit` is the ONLY function that scans engine output for labels in the turn path, the only reader of `scanLabelDelta` and the only caller of `openTurn` besides `maskItem` (§3.3) and the reset rule below. The native log and the live gate never scan; they consume the `Admitted` object (the "decision") and the registry state.

Where it is called: in each driver, at the line where the engine's frame is first in hand, BEFORE that frame's `appendNative` and before any live `emit` derived from it. Use the driver-specific flows in §3.5; callback-based providers do not have a universal native-first order. Frame-based intake anchors are claude.ts:4821 (then the `switch` at 4959-5010), pi.ts:1152 (then the `switch` at 1180 on), codex.ts:2189, acp/core.ts:4321 (active, not idleLine at :2280), antigravity.ts:842, boxagent.ts:243 and 275, openai-chat.ts:1221 (callbacks), :1314 (later whole completion).

What `admit` does:

1. `turnId` undefined, unknown, or retired: return `closed` (`live: null`, `native: «redacted N chars»` over the supplied delta length (whole frames are recursively withheld)). No state is touched (nothing exists to touch).
2. Live and `open`: return `closed`. (After the opening frame every carrier of the turn is masked: R3.)
3. `frame.delta` absent (a whole frame: `assistant`, `user`, `result`, a Pi `message_end`, a Codex `item/completed`, an ACP `session/update` that is not a chunk): walk every string leaf of `frame.msg`; if any has a wrapped label (`hasWrappedLabel`, the new one-line export of the line loop of `maskSecretLabelsToEnd`): `openTurn`, return `closed` (the whole frame is withheld, G-H1 same-frame case included). Else return a clean whole-frame decision.
4. `frame.delta` present: `stream = state.streams.get(kind)` or a fresh one. If either retained scanner's `len` plus the first line of `text` passes `MD_STREAM_CAP`: `openTurn`, return `opened` with `text: ""`, `native: «redacted N chars»` over the whole delta, `live: "«redacted»"` (today's cap latch, native.ts:230-234).
5. `at = scanLabelDelta(stream.label, text)`. If `stream.pending` (a reset fork, below): `atP = scanLabelDelta(stream.pending, text)`; `at = min of the non-negative ones`; after a newline in `text`, `pending = null`.
6. `at < 0`: `pass = text`; return `clean` with `text = native = live = maskWithTail(stream, pass)` (shape rules over `tail + pass`, prefix diff, as native.ts:210-217 today, with `redactSecretsInTextStream`).
7. Else: `pass = text.slice(0, at)`, `head = maskWithTail(stream, pass)`, `openTurn`; return `opened` with `text = head`, `native = head + «redacted ${text.length - at} chars»`, `live = head + "«redacted»"`. The withheld rest is never stored on the object.

The driver then uses `a` and only `a`:
- Its native entry: `appendNative(threadId, { dir:"in", source, msg, turnId, late, admitted: a })`, where the native gate alone installs `a.native` at the recorded exact delta path after withholding the original frame (the Claude SDK shape is the reshaping `maskStreamDelta` does today at native.ts:252-263, exported as `withSdkDelta`; Pi, Codex and ACP each name their one field). For a whole frame, `msg` is logged as is (the gate decides, §3.4).
- Its live delta: `emit({ ...base(threadId, turnId), type: "content.delta", streamKind, delta: a.live, admitted: a })` only when `a.live !== null`. Every downstream use the driver makes of the bytes (Pi's `assistantText` after its todo filter, ACP's `state.text`, `recordSeg`, `askStopReply`, Codex's accumulators) reads `a.text`, never the raw delta. A driver-authored delta (`"\n\n"` at acp/core.ts:4157, the `note` at codex.ts:1896 and acp/core.ts:3900) is admitted too: it is clean when the turn is not open and dropped when it is.

Pi's todo filter (pi.ts:1014-1020) stands between the engine and the bubble and changes bytes (a `<todo>` block leaves the answer and becomes a `plan.updated`). The rule for any transform between the engine and a sink: the transform runs first, on the raw delta, and what it emits is the one byte run that is admitted. For Pi: `out = todo.push(e.delta)`; `a = admit(turnId, { delta: { kind: "text", text: out.text } })`; the native gate installs `a.native` into the entry's delta field (so Pi's log carries the text the person was shown; a held `<todo` prefix makes that frame's field empty and the released text appears in the frame that releases it); the live delta is `a.live`; the plan entries go through step 7 of §3.3 (extent A within each entry). Raw bytes the filter removed never reach a sink, so they need no scan. A deletion by the filter cannot build a label from label-free bytes unseen: the scanner reads the filter's output, which is what both sinks carry (T-DRV-pi rows d and e).

`content.reset` (G-M1, A32-M1): preserve the two-history bound without losing history. For a live, not-open turn: with no pending and a nonempty fresh label, move label to pending and install a fresh label; with pending and empty fresh label, retain pending unchanged; with pending and nonempty fresh label, open the turn BEFORE dropping either. With both empty, do nothing. Keep shape tail. An already open turn stays open. Unknown or retired reset does nothing. Both scanners are cap-checked before each feed; either exceeding MD_STREAM_CAP opens the turn. Drop pending only after the feed has scanned through a newline and the histories have converged, or after opening has made their history unnecessary. The second reset in `**pass`, reset, `wo`, reset, `rd**: hunter2` therefore opens before discarding history. Adjacent resets retain the first history. T-RS covers both sequences, normal prose, both kinds, each cap boundary and real Pi/ACP retry paths (pi.ts:1183-1186, acp/core.ts:3912-3916; scanner shared/md-secret-label.mjs:85-105).

Transforms: Pi's only text path is `todo.push(raw)` then `admit(out.text)`, then native projection and live projection. Every `todo.flush()` text result uses the SAME helper, including end, error, retry and Stop. Plan output goes through §3.3. Never append raw e.delta to assistantText before admission (base pi.ts:1233); append admitted text, and sanitize final whole items independently. Flush text with no original frame gets a tagged synthetic native record and one admission shared with the live output. Filter-removed plan strings cannot remain as raw alternate leaves in a logged frame: project them through the plan text rule before log serialization. Complete raw engine frames are independently walked by whole-frame admission when they are separate records. T-DRV-pi(d/e) asserts the actual intake and flush sequence. No downstream transform may delete bytes after admission and assemble a new label unseen.

Why this closes A3-r3 and G-M4 whole: there is no second scan to disagree with the first. The native log and the live event of one frame carry the two forms of one `Admitted`, computed once, before either sink. "Native first" no longer sets a flag the live gate reads back: the live gate reads the token. Token validation also checks the current incarnation and frame binding; these are opaque host-issued objects, not engine-deserializable data.

Why this closes G-H1 and G-M5: `admit` is called for every frame of every driver, delta or not, and a whole frame with a wrapped label in any string opens the turn before the frame is logged. A later frame whose only string is `hunter2` is `closed` and withheld. Pi, Codex, ACP, Antigravity, boxagent and openai-chat all tag their entries with the turn id their own `base(threadId, turnId)` uses at the nearest emit (pi.ts:1148 `turnId` is in scope at 1152; codex.ts and acp/core.ts carry the current turn in the session closure that emits at 1973 and 4158). The static test T-TAG asserts it per driver.

### 3.3 The live gate (server/harness/bus.ts) and R3

`EventBus.publish` (bus.ts:242) begins with `event = gateRuntimeEvent(event); if (!event) return;` before the `omitThread` line. `publish` is the one intake: `attach` (218-230) calls it for every adapter (the spread at 226 copies the event, so the token travels as the field `admitted`, never through object identity); the events log (252), the fold (index.ts:9928, broadcast 8781, store 8830), the replay buffer (index.ts:6021, built from the broadcast frame), the ask_bot fold and every subscriber get the gated object.

`gateRuntimeEvent(event)` (in turn-secrets.ts, synchronous), in this order:

1. `turn.started`: `turnStarted(turnId)` only refreshes an allocated live state. Continue through structural projection; do not return an unchecked payload.
2. Decide `masked = turnOpen(turnId)` for every event (unknown and retired ids included).
3. `content.delta`: `a = event.admitted; delete event.admitted`. Drop the event unless `a instanceof Admitted && a.turnId === event.turnId && a.kind === kindOf(streamKind) && !a.consumedLive && a.live !== null && live.has(event.turnId) && (a.state === "opened" || !masked)`. Then `a.consumedLive = true; delete event.raw`. Keep a.live locally; continue through step 8 and install it only at top-level delta, then deliver. A delta with no token, another turn's token, the other kind's token, a reused token, a `closed` token, or any token for a turn that is retired or unknown at gate time is dropped (fail closed, T-TOK, T-L2). The `opened` token is the one carrier of an open turn that is delivered, and it holds only the head before the label plus the marker.
4. `content.reset`: `resetStream(turnId, kindOf(streamKind))`; recompute masked and continue through projection.
5. `item.completed` with `itemType: "assistant_text"`: `event.text = maskItem(turnId, text)`:
   - unknown or retired: `«redacted ${text.length} chars»`.
   - live and open: `«redacted ${text.length} chars»` (R3: whole completions; no ownership, no counter: A1-r3, G-H2).
   - live and not open: `out = redactSecretsInText(text)`; if `hasWrappedLabel(text)`: `openTurn` (the completion is the first carrier of the label: a non-streamed item). Return `out`.
   Save this gate-computed text locally as `safeItemText`, then recompute `masked`. After withholding other fields, install safeItemText at the exact top-level `text` path once. Never re-mask it or preserve other equal strings.
6. `item.completed` with `itemType: "assistant_image"` and `masked`: drop the event (a withheld `data` is not an image; the fold must not see it). Not masked: pass through.
7. `plan.updated`: if clean, project content through redactSecretsInText and reconstruct the schema status; if masked, leave original content for step 8 to mask once. Never pre-mask the string that step 8 will count.
8. Every masked event goes through `withholdEvent`: build a new object, remove raw and admitted, mask every string leaf in payload subtrees without any key-name exception. Numbers, booleans and null retain the r31 rule. Restore only the exact structural paths listed in §3.3.1, after validation of value AND provenance. Preserve the locally computed safeItemText only at top-level text. A plan entry's content is processed once: either its extent-A text result for a clean turn or whole-field mask for an open turn, never both. A content.delta likewise uses the validated admission projection only at top-level delta; every sibling payload field still goes through withholding. Strip admitted on ALL event types and construct the native log envelope explicitly so private tokens never serialize.
9. `turn.completed` and `session.exited` with a string `turnId`: after step 8, `turnEnded(turnId)`; pass through.
10. Everything else: pass through (already withheld when masked by step 8).

The bubble after a label reads `...**password**:«redacted»` and stops moving until the settled rows replace it (store.tsx:6429-6432). The first-token probe (index.ts:8672) sees the opening delta because it is delivered with its head; when the head is empty (a split label, a non-streamed item) it sees `«redacted»`, still a first token.

Stale events (A3-r2): a retired turn P's `content.reset` carries P's id and forks P's stream, or does nothing if P is retired; Q is a different key. `open` is never cleared by anything.

### 3.3.1 Exact structural paths, no familiar-key exceptions (A32-H2)

server/contracts.ts:83-93 provides the envelope, but does not prove provenance. Its :166 input and :175 result are unknown payloads. Pi at :1253 copies an engine toolName; Codex at :2008 copies title/name and item.arguments. Therefore none of these names or IDs is trusted merely by spelling.

Top-level event type is a fixed RuntimeEvent union value, itemType is the valid value for that event, streamKind is assistant_text or reasoning_text, origin is engine or murage, deniedBy is user/timeout/system. Restore only a validated exact top-level path; invalid required routing fields drop the event rather than inventing a valid event. provider must match the host adapter's DriverKind; threadId, turnId and providerInstanceId come from the bound host session, eventId and createdAt from the host base constructor. Engine item/request/before IDs must be mapped to host-generated opaque IDs consistently per turn and generation before publication; never echo raw engine IDs. Unknown beforeItemId is omitted. Host metadata must be passed separately from engine payload, not validated only by UUID shape.

stopReason is an unconstrained string in contracts.ts:140, so mask it unless the host explicitly maps it to a fixed internal value such as cancelled; merely matching letters or a familiar value does not grant an exception. status and priority have NO whole-tree or top-level exception. For plan entries only, the schema projector may reconstruct entries[i].status using pending/in_progress/completed from shared/agent-plan.ts:10-14. Priority is not carried by that schema (line 8) and is omitted, never restored; all other entry string fields are payload. Similarly preserve subtask status only through its explicit schema enum, never generic key traversal.

Tool identity is restored only from the trusted host tool catalog that was established for the session independently of engine output. Reconstruct exact top-level toolKind and toolIdentity.{namespace,name,kind} from the matched catalog entry. A name from an engine frame cannot populate that catalog. When no independently trusted catalog exists for a driver, mask the identity and kind; do not fall back to evt.toolName. This validation applies even if an unknown tool happens to spell a familiar type or status. Unknown extension keys default to masking.

T-PAYLOAD is the dedicated High test. EACH row below is an independently named test: open a turn, put sentinel hunter2 under that key in input, result, detail objects, array entries and an extra nested object. Assert full bus serialization, events log, replay/store subscriber and native serialization contain no sentinel. Test the same key at top level with forged provenance or invalid enum. Include valid host controls at allowed paths. Remove the subtree boundary as a sensitivity mutation and prove the reviewed leak.

| Familiar key | Explicit permitted path or disposition | Test row |
|---|---|---|
| eventId | top-level host-generated only | T-PAYLOAD-eventId |
| provider | top-level bound adapter enum only | T-PAYLOAD-provider |
| providerInstanceId | top-level bound host instance only | T-PAYLOAD-providerInstanceId |
| threadId | top-level bound host thread only | T-PAYLOAD-threadId |
| createdAt | top-level host timestamp only | T-PAYLOAD-createdAt |
| turnId | top-level bound registry identity only | T-PAYLOAD-turnId |
| itemId | top-level host opaque mapping only | T-PAYLOAD-itemId |
| requestId | top-level host opaque mapping only | T-PAYLOAD-requestId |
| type | top-level RuntimeEvent discriminator only | T-PAYLOAD-type |
| itemType | top-level event-specific enum only | T-PAYLOAD-itemType |
| streamKind | top-level event-specific enum only | T-PAYLOAD-streamKind |
| origin | top-level host-selected enum only | T-PAYLOAD-origin |
| stopReason | masked unless fixed host mapping | T-PAYLOAD-stopReason |
| deniedBy | top-level host-selected enum only | T-PAYLOAD-deniedBy |
| toolKind | trusted catalog reconstruction only | T-PAYLOAD-toolKind |
| toolIdentity | trusted catalog reconstruction only, no recursive exemption | T-PAYLOAD-toolIdentity |
| beforeItemId | host mapping to known prior item only | T-PAYLOAD-beforeItemId |
| status | explicit plan/subtask schema enum only | T-PAYLOAD-status |
| priority | omitted by plan schema; elsewhere payload | T-PAYLOAD-priority |
| name | only catalog-derived toolIdentity.name | T-PAYLOAD-name |
| namespace | only catalog-derived toolIdentity.namespace | T-PAYLOAD-namespace |
| kind | only catalog-derived toolIdentity.kind | T-PAYLOAD-kind |
| any new or unknown key | payload, never implicitly permitted | T-PAYLOAD-unknown |

T-PAYLOAD-toolIdentity additionally sends Pi toolName hunter2 and Codex item.tool hunter2 through actual drivers. All nested type/status/itemId fields are masked even when their values are valid enums or look like host IDs. Test duplicate copies of an admitted projection under unrelated keys: only its exact target path can be installed. This table covers every r31 exempt key plus all identity children; arbitrary new keys cannot create a new exemption.

### 3.4 The native gate (server/drivers/native.ts) and R3

`appendNative`'s entry gains `turnId?: string`, `late?: boolean`, `admitted?: Admitted`. The shipped per-thread maps (`pendingStreams`, `latchedStreams`, `latchedOverflow`, `latchStream`, `freshPending`, `resetStreams`, `maskLatched`, `maskStreamField`, native.ts:166-240) and the `type: "user"` reset (301) are deleted. `openPhoneBlocks` keeps `PHONE_BLOCK_THREADS = 256`.

`maskForTurn(entry)` replaces `maskStreamDelta(threadId, entry.msg)` at native.ts:302, with `turn = entry.late ? undefined : entry.turnId`:

1. `dir === "lifecycle"`: unchanged (`redactLifecycle`).
2. `dir === "in"` with no `turnId` and not `late` (engine output before any turn: a prewarm's `init`, a session handshake): `withholdFrame` (S-1). `dir === "out"` untagged (the dispatch trace, a `claude.session` row, a boxagent prompt): the sink walk as today.
3. For an unknown, retired or open turn, withhold the ORIGINAL frame first, recursively masking every payload string. Restore only source-specific exact discriminator paths and enum values; never use a leaf-equals-keep exception. The retained SDK_DISCRIMINATORS rule covers Claude msg.type, msg.subtype and msg.event.type, Pi msg.type, Codex/ACP msg.method and ACP msg.params.update.sessionUpdate, and Antigravity msg.event. Build fixed sets from the actual driver case arms. Unknown values stay masked. No nested payload type/status/name is a discriminator.
4. For a live clean turn, apply the machine sink walk to the original frame.
5. Finally install a validated admission's native projection at its exact recorded source-specific delta path, once, for clean, opened AND closed decisions. Validation binds token identity, registry incarnation, turn, source, frame sequence, kind and path; consume it once per native record separately from consumedLive. A clean/opened token whose turn has since retired or whose clean state is no longer current cannot authorize an old projection: withhold the original delta instead. A closed projection remains safe but still requires its exact frame binding. Never restore by string equality. Whole-frame tokens have no delta path to install. The token contains no raw frame or withheld rest. Strip admitted before encoding, including lifecycle and untagged rows.

The admission's projections already ran required provider rules. After installation do not run a second label mask on that delta, which would re-count its marker. The page-output scrub may run as retained behavior, then the byte budget and append. T-SERIAL verifies the final serialized record after every stage. The driver passes the original msg and token to appendNative; it does not pre-substitute a.native. For clean whole frames the machine sink collector is independent of the REDACT text adapter (§2.1).

Use the retained page-output scrub, byte budget and append order just specified.

Why this is R3 for the log: once a turn is open, every later frame of the turn (`assistant` text blocks, `tool_use` inputs, `result` text, `user` tool results, steers written during the turn, Pi, Codex and ACP frames alike) is withheld to the turn's end; only the discriminators and the opening head survive (S-2).

### 3.5 Per-driver intake (the build's call sites)

| driver | admit before | native tag | live deltas carry the token | whole-frame carriers admitted |
|---|---|---|---|---|
| Claude | claude.ts:4821: `const a = admit(currentTurnId(), sdkFrame(o))` where `sdkFrame` yields `{delta:{kind,text}}` for a `stream_event` `content_block_delta` with `text_delta`, `thinking_delta` or `input_json_delta` (kinds text, reasoning, tool_input; the fields `streamDelta` reads today, native.ts:243-250) and `{msg:o}` otherwise | `turnId: currentTurnId()`, `late: session.turn?.lateContinuation === true`, on every session-scope `appendNative` (3267, 3321, 3390, 3485, 4821, 5246, 5522, 3084 with `s.turn?.turnId`); the dispatch trace at 4180 stays untagged (`out`) | 4969, 4971; the fallback delta at 4996 admits `text` as a `text` delta (closed when the `assistant` frame's walk opened the turn) | `assistant` (4975: text blocks, `tool_use.input`, 5007), `user` tool results, `result`, `system` |
| Pi | pi.ts:1152 | `turnId` (in scope, 1148) | 1019 (the filter's output, admitted), 1238 | `message_end`, every non-delta event |
| Codex | codex.ts:2189 | the session's current turn id | 1896, 1973, 1980, 2022, 2034 | `item/completed` and every non-delta frame (2023, 2037 completions are gated by `maskItem`) |
| ACP | acp/core.ts:4321, active handleStdoutLine; :2280 idleLine is explicitly unowned | the session's current turn id | 3900, 3956, 3961, 4157, 4158, 4176 | every `session/update` that is not a chunk, `session/request_permission`, responses |
| Antigravity | antigravity.ts:842 | `turnId` | 902 | the `response` frame (903 completion gated by `maskItem`) |
| boxagent | boxagent.ts:243, 275 | `turnId` | 203 | 195, 288 completions gated by `maskItem` |
| openai-chat | transformed callbacks at :1210-1234 and flushes at :1309-1313; separate whole admission before :1314 | `turnId` | 1210, 1213 | 1287, 1340, 1354 completions gated by `maskItem` |

Why this closes A5-r1 without ordering logic (kept from rev 3): a retired Claude session carries its own turn object (`closeSession` 3063-3095 does not clear `s.turn`), so its late frames go to P's state, which is open or retired. Q's prompt starts Q's state.

### 3.6 Driver-specific ordering and allocation

Frame-based drivers admit once per final byte run before either native or live consumption. Native-first is allowed but not required by the security rule. Projection and downstream accumulators consume that same admission; neither gate rescans. Each derived distinct byte run has its own admission, not a token reused across multiple runs.

ACP active handleStdoutLine at acp/core.ts:4313-4321 must prepare any text-affecting normalization, admit, then log and pass the decision into notification handling. Base acpRestampFrame at :4323 must not create new text after admission; move necessary transforms before it or keep them strictly structural with an explicit test. idleLine at :2271-2280 remains unowned and withheld. Overflow at :4307 is tagged with the owning turn and fails closed. State/recordSeg/askStopReply consume admitted projections. Generated notes and held flushes also admit before publish.

openai-chat callbacks at :1221 occur while complete() is pending. Run SecretStreamFilter and todo.push first, then admit final answer text; reasoning applies its filter and scrub before admission. The callback has one token for the live output; no artificial native event is required if the driver has none. Later whole completion at :1314 has its own whole-frame admission before native logging, not a second stream scan of the callback bytes. Whole completion conservatively withholds when the turn is open. At flush, feed filter.flush() through todo.push BEFORE todo.flush(), admit each final emitted text run and its plan output. This avoids the base's direct filter.flush bypass at :1312 and permits a label assembled across filter boundaries to be scanned. Error, abort, Stop and buffered-output paths use the same helper; after retirement no token may release bytes.

Pi uses todo.push before admission (§3.2), with flush through the same helper. Claude, Codex, Antigravity and boxagent keep §3.5 frame sites and add admissions for every separate buffered or generated output. Do not claim raw logging always precedes live emission. AllocateTurn precedes all turn-owned output; turn.started refreshes state only. Unowned prewarm/handshake input stays withheld.

T-DRV has seven real-driver harness rows, one for each scoped driver, with normal clean streaming controls, split labels, same-frame labels, whole-frame labels, concurrent turns, Stop while callbacks are paused, and all end/error/retry/Stop flushes. T-TAG is supporting inventory, never a substitute for those runtime tests.

## 4. State transitions: rule and test

| transition | rule | test |
|---|---|---|
| crash mid-write | masking runs before `appendFileSync`; a torn record is a masked prefix; the next append on that file reads the last byte and writes `\n` plus a `native_trace_record_torn` marker (§5); after restart the registry is empty: every pre-restart turn is unknown, masked | T-X (a), (b), (c), (d) |
| restart | no thread-keyed warm path; the first entry for the thread in the new process, whatever it is, meets an unknown turn | T5, T-R |
| Stop | the Stop frame is a frame of the turn (withheld if open); state lives until `turn.completed`, then the id is retired | T-S |
| tool result mid-turn | a `user` tool result is a whole frame of the turn: admitted (opens if it holds a label), withheld if open; never a boundary | T-TR |
| concurrent turns on different threads | different ids, nothing shared | T-C |
| same thread, two process generations | each session's frames carry its own turn id | T-G |
| stale live reset | a reset touches its own id's stream only; `open` never cleared | T-L3 |
| reset with an unfinished line, continuation, second reset | retain pending; when two nonempty histories would be discarded, open first | T-RS |
| cross-item, cross-kind | an open turn masks every later carrier whole: completions, tool items, plan entries, images dropped | T-OWN, T-TOOL |
| second `turn.started`, relaunch, retry | live id: recency refreshed, state kept; retired id: no-op | T-L1 |
| turn end then a late delta or completion | retired: delta dropped (no token can be minted for it), completion whole | T-L2 |
| eviction or forgotten tombstone, then repeated start | start cannot allocate; old identity remains masked | T-E and every §3.1 row |
| over-long line | `MD_STREAM_CAP` opens the turn | T-16 |
| untagged engine input | withheld (S-1) | T-N |
| open turn, later frames and events of every type | withheld with the allowlisted discriminators restored | T-W, T-W-live |
| native then live on one frame, every driver | one decision: the log holds `head«redacted N chars»`, the bus delivers `head«redacted»`, then nothing | T-DRV (one per driver) |

## 5. S3: torn records without repair memory (G-L2 placement)

In `appendNative`, after `capExisting` (native.ts:306-307) and AFTER the rotation block (308-312), immediately before the one `appendFileSync` (313): if `size(current) > 0` and its last byte is not `\n` (one `openSync`, one 1-byte `readSync` at `size - 1`, one `closeSync`), the bytes written are `"\n" + marker("native_trace_record_torn", {}) + encoded` in that one call. The rotation writes a fresh `current` that ends in `\n` (the retention marker), so after a rotation the check sees a whole file; the rotated `previous` segment may keep one torn last line with no marker, which the reader skips (S-4). No set of repaired paths, no truncation, no process memory (A4-r2). The reader (`readRecentLines`, thread-events.ts:120-130) skips the invalid line a torn record makes and keeps every valid record around it: "recovers" in T-X means that, never "every line parses".

## 6. S4: one formula for every exact oracle

`N = text.length - sepEnd`, `sepEnd` the index just after the first wrapped label's separator (md-secret-label.mjs:56, `map[sep] + 1`), output `text.slice(0, sepEnd) + " " + «redacted N chars»` (71). Row 21 (md-secret-label.test.ts:72-76) reads this way: `**password**: hunter2\nmore\n` gives 14.

| id | input (`\n` is a line break) | exact output |
|---|---|---|
| E1 | `**password**: hunter2` | `**password**: «redacted 8 chars»` |
| E2 | `**password**: hunter2\nmore\n\nNext` | `**password**: «redacted 19 chars»` |
| E3 | `**password**: hunter2\n\nNext step` | `**password**: «redacted 19 chars»` |
| E4 | `- **Password**: leave blank\n- **Click** Next\n- **Done**` | `- **Password**: «redacted 40 chars»` |
| E5 | `**password**:` | `**password**: «redacted 0 chars»` |
| E6 | `**password**: «redacted 8 chars»` | unchanged |
| E7 | `**password**: x1y2z3\nBearer: abcdefghijklmnop\n- Hint: hunter2secret` | `**password**: «redacted 54 chars»` |
| E8 | `Fuigo: **api key**: hunter2secret moved to ~/x` | `Fuigo: **api key**: «redacted 27 chars»` |
| E9 | `**token**: /tmp/sk-abcdefghijklmnop/rest more` | `**token**: «redacted 35 chars»` |
| E10 (A4-r3, G-M2) | `[RSA private-key header]\nAAAA\n**password**: x\nBBBB\n[RSA private-key footer]` | `[RSA private-key header]\n«redacted 25 chars»\n[RSA private-key footer]` |

E10 by the code: `redactPemBlocks` (redact.ts:117-131) masks `text.slice(bodyAt, close.index).trim()` = `AAAA\n**password**: x\nBBBB` (4 + 1 + 15 + 1 + 4 = 25) and keeps the footer; the label is inside the marker, so `MD_LABEL` finds nothing; pass 2 keeps the exact marker (redact.ts:36). One marker, not two.

Stream forms (native, `admit` step 7, no blank before the marker because `at` is `sepEnd`, md-secret-label.mjs:150): opening delta `**password**: hunter2` writes `**password**:«redacted 8 chars»`; the live form is `**password**:«redacted»`.

## 7. Known limits (MurageMain rows, documented in code)

- U-1 User-visible text after a wrapped secret label is masked to the end of that text, prose included (§2).
- U-2 Table cells (`| **Password** | hunter2 |`) have no separator and are not labels (pre-existing).
- U-3 (R3) Once a turn is open, every completion of that turn is stored as one `«redacted N chars»`, the prefix prose included; the live bubble showed the head up to the label until the settled rows replaced it. The price of removing ownership (A1-r3, G-H2).
- L-1 A prefix-shaped key split across live deltas can show its first fragment before the shape completes; the stored row is exact.
- L-2 After a wrapped label the live bubble shows nothing more for that turn, Murage's own cap note included.
- L-3 In an open turn, `runtime.error.message`, Murage-authored `origin: "murage"` items and tool titles read as markers (R3, every carrier).
- L-4 A non-streamed item that holds the label shows no head in the bubble (its fallback delta is `closed`); the log withholds that whole frame.
- L-5 An `assistant_image` of an open turn is dropped.
- S-1 Untagged engine input (a frame before its turn's `turn.started`, a session handshake) is withheld; discriminators stay.
- S-2 Once a turn is open, every later native frame of that turn is withheld to its end; discriminators and the opening head stay.
- S-3 Past `TURNS_MAX` live turns the oldest retires and is masked from then on, even if still streaming.
- S-4 A torn native record is one invalid line plus a marker (or, in a rotated previous segment, one invalid line); the reader skips it.
- S-5 Past `RETIRED_MAX` retired ids the oldest is forgotten; it still reads as masked.
- `plan.updated` entries are plan text: extent A within each entry always; withheld whole in an open turn.

## 8. Test plan

Security additions require base failure or a targeted reversal mutation where the API does not exist on base. Guards remain controls. Named fresh test turns are created by allocateTurn before turnStarted; repeated, unknown, retired and replayed starts never allocate. A literal P or Q in a retained test is a fixture alias for its allocated ID, not an argument to allocateTurn. "masked" means the secret text is absent and the label is kept; exact rows compare whole strings. f(f(x)) = f(x) on every text row. New files go on the gate tier (ci/gate-tests.txt) with the user failure each prevents.

### 8.1 Retained High tests, plus T-E and T-PAYLOAD for r31

| id | High | test |
|---|---|---|
| T1 | G3-r1 stored half | every secret ROWS entry except the explicit K-CODE-TYPE guard of md-secret-label.test.ts:27-67 through `redactSecretsInText`: none of its secrets survives, the output ends in one marker, second pass equal (server/md-secret-label-user-text.test.ts) |
| T2 | store, card, channel | `store.appendMessage` of E3 reads back E3's output; a card `pushBody: "**token**: abcdef12"` reads back `**token**: «redacted 9 chars»`; `channelReplyText` (index.ts:14540 closure) on E3 gives E3's output (server/store-redact-md.test.ts) |
| T3 | pi.ts:227 | `piToolErrorDetail({ result: "**token**: /tmp/sk-abcdefghijklmnop/rest more\nsecond" })` is E9's output; `{ result: "**password**:\nhunter2" }` is E5's output |
| T4 | acp/core.ts:2240 (G4-r1) | the notice splitter on `Fuigo: **api key**: hunter2secret moved to ~/x` calls `hooks.notice` with E8's output; `Fuigo: memory moved to ~/x` passes unchanged |
| T5 | A3-r1, G1-r1 A and B | module A: `turnStarted("P")`, admit and log `**pass` (P); `vi.resetModules`; module B: first entry for the thread is `word**: hunter2` tagged P (no `turnStarted` in B): the written line ends in `«redacted 15 chars»`, no `hunter2`; variants with a lifecycle row, a ping, a thinking delta `x` first: masked; then fresh allocate Q and `turnStarted(Q)`, `clean` (Q): written |
| T6 | A6-r1, G3-r1 live | `new EventBus(noopAppend)` with a recorder; a driver stub that admits and emits like §3.5: `turn.started` T, deltas `**pass`, `word**: hunter2`, `more`: delivered `**pass`, `word**:«redacted»`, nothing; `JSON.stringify` of every delivered event holds no `hunter2` and no `admitted`; the same with no `turn.started`: nothing delivered; `item.completed` T `**password**: hunter2` on a fresh turn: E1's output |
| T-OWN | A1-r3, G-H2, A2-r2 | (a) `turn.started` T, reasoning delta `**password**:` (opens; delivered `**password**:«redacted»`), text delta `hunter2` (dropped), `item.completed` assistant_text `hunter2`: delivered and stored as `«redacted 7 chars»`. (b) text deltas `**pass` then `word**: hunter2`, `item.completed` `**pass` then `item.completed` `word**: hunter2`: both completions whole. (c) reasoning opens, `item.completed` assistant_text `hunter2 **token**: x`: whole. (d) no deltas: `item.completed` `**password**:` gives `**password**: «redacted 0 chars»`, then `item.completed` `hunter2` gives `«redacted 7 chars»`. (e) `item.completed` with a retired or unknown id: whole |
| T-E | A2-r3 | `turn.started` T, delta `**password**: x` (T open); `TURNS_MAX` more turns started (T evicted, retired); `turn.started` T again; delta `hunter2` for T: dropped on the bus and `«redacted 7 chars»` in the log; `item.completed` for T: whole. Same with `turn.completed` T instead of eviction. Then `RETIRED_MAX` more ended ids: T is forgotten; repeat turn.started(T), admit and log hunter2, and complete with hunter2: bus delta absent, native delta and live completion exactly «redacted 7 chars». Repeat after registry restart and each tombstone departure in §3.1 |
| T8 | A1-r1 | the three PEM-after-label inputs of rev 3: no `Proc-Type`, `abcdef`, `SENSITIVEBASE64BODY`, `Next steps`, exactly one marker after the label; the label-inside-PEM input is exactly E10; second pass equal |
| T9 | A2-r1, A1-r2, G1-r2 | the six composed-opener inputs of rev 3: each exactly `<text up to the first separator> «redacted N chars»`, N by §6; no `alpha`, `TAILSECRET9`, `Keep`, `Next` |
| T10 | A4-r1 | the row 19 clock (md-secret-label.test.ts:122-136) through `redactSecretsInText` with the chain units; ratio under 6, 256 KiB under 250 ms; MD_LABEL in redact.test.ts:465's per-rule loop |
| T-DRV | G-H1, G-M5, A3-r3, G-M4 | one per driver (Claude, Pi, Codex, ACP, Antigravity, boxagent, openai-chat), on the driver's own fake-engine harness, real `appendNative` to a temp dir and a real `EventBus`: (a) frames `**pass` then `word**: hunter2` then `more`: bus deltas `**pass`, `word**:«redacted»`, nothing; for drivers with native delta records the second record holds `word**:«redacted 8 chars»` at its exact delta path and the third is withheld. For openai-chat callbacks without native delta records, assert live outputs as specified and the later native whole completion withheld. In both cases no hunter2 survives. (b) one frame `Hello\n**password**: hunter2`: bus `Hello\n**password**:«redacted»`, log `Hello\n**password**:«redacted 8 chars»`. (c) a non-delta frame whose strings are `**password**:` and, in a second string, `hunter2` (Claude: an `assistant` message with two text blocks on the non-stream path; Pi, Codex, ACP: the frame shape their completion path logs): no `hunter2` in the log, the frame withheld, and the next frame whose only string is `hunter2` withheld; the bus completion whole. (d) Pi only: raw delta `**pass<todo>x</todo>word**: hunter2`: the filter's output is admitted; no `hunter2` on the bus or in the log. (e) Pi only: a `<todo>` block holding `**password**: hunter2`: the `plan.updated` entry reads `**password**: «redacted 8 chars»` and the log has no `hunter2` |
| T-G | A5-r1 | §8.2 |
| T-S | G2-r1 | §8.2 |
| T-TR | G2-r2 | §8.2 |
| T-L3 | A3-r2 | §8.2 |

### 8.2 One test per transition (server/drivers/native-md-stream.test.ts unless noted; `send(n, t, text, kind, turnId)` admits then logs; `written(t)` as at line 24)

| id | test |
|---|---|
| T-X | (a) a thread file with one complete record then a partial record with no newline, under `SEGMENT_BYTES`; fresh module; one `appendNative`: `readRecentLines` returns the first record and the new one, the partial line is the only invalid line, a `native_trace_record_torn` marker precedes the new record, the file ends in `\n`. (b) a torn current at or below SEGMENT_BYTES, with incoming encoded bytes chosen to force rotation: no torn marker in current, current begins with retention marker, previous ends with the torn line and the reader skips it. (b2) separately start over SEGMENT_BYTES: capExisting drops the invalid suffix before any rotation; assert suffix absent from both segments and all valid retained records readable; do not require rotation. (c) `appendFileSync` mocked to write half the record and throw once (ENOSPC), then succeed: the next append writes the marker and the record; the reader recovers every whole record and skips the half one. (d) module A: `turnStarted("P")`, `**pass` (P); module B: `turnStarted("Q")`, prompt row (Q), `hunter2` delta (Q): written (B's own new response) |
| T-R | module A: `turnStarted("P")`, `**password**: x` (P), 70 KiB of `x` (P, `«redacted 1024 chars»` rows); module B: for each of row 18's FRAMES (110-122) plus ping and `content_block_stop` as the first entry (tagged P), then `tail hunter2` (P): masked; B with a thinking delta first then `word**: hunter2`: both masked; `turnStarted("Q")`, `clean` (Q): written |
| T-S | (a) `turnStarted("P")`, `**password**: ` (P), the Stop frame `{dir:"out", msg:{type:"control_request", request:{subtype:"interrupt"}}, turnId:"P"}`, `hunter2` (P): masked; the Stop frame withheld with `msg.type` restored and `request.subtype` masked; `turnEnded("P")`; `still hunter2` (P): masked (retired); `turnStarted("P")` again: still masked; `turnStarted("Q")`, `clean` (Q): written. (b) `**pass` (P), Stop, `word**: hunter2` (P): masked. Live (turn-secrets.test.ts): `turn.completed` then a delta for P: dropped |
| T-TR | `turnStarted("P")`, `**password**: ` (P), `{type:"user", message:{content:[{type:"tool_result", content:"hunter2"}]}}` (in, P): withheld; `hunter2` delta (P): masked; the prompt-shaped `{type:"user"}` (out, P) between label and value: withheld. A `user` tool result that itself holds `**password**: hunter2` on a not-open turn: opens, withheld. Live: deltas `**password**: `, `item.completed` tool, delta `hunter2`: dropped |
| T-C | turns A and B on threads tA and tB interleaved one character at a time: A `**password**: hunter2`, B `plain words`: A's characters after the separator masked, B's written; `turnEnded("B")`: A's next delta masked (open), B's masked (retired); A text and A reasoning split across each other (`**pass` text, `word` reasoning, `word**: hunter2` text): text masked at `word**:`, reasoning written |
| T-G | one thread: `turnStarted("P")`, `**password**: x` (P, open); `turnStarted("Q")`, prompt row (Q); `clean` (Q): written; `hunter2` (P): masked; `turnEnded("P")`, `late` (P): masked. Variant: `**pass` (P), Q's prompt, `word**: hunter2` (P): masked |
| T-TAG (static, server/drivers/native-turn-tag.test.ts) | for each of claude.ts, pi.ts, codex.ts, acp/core.ts, antigravity.ts, boxagent.ts, openai-chat.ts: every owned `appendNative(` with `dir: "in"` carries `turnId:` and `admitted:`; explicitly unowned idle/prewarm entries have a named withheld-path fixture; every `dir: "out"` call inside a session scope carries `turnId:`; every `type: "content.delta"` emit carries `admitted:`; besides explicitly withheld unowned incoming paths, the only untagged appendNative calls are the listed out rows (claude.ts:4180 dispatch trace, boxagent.ts:142 prompt); and neither native.ts nor bus.ts imports `scanLabelDelta` or `hasWrappedLabel` |
| T-L1 | live: `turn.started` T, `**password**: x`, `turn.started` T again, delta `hunter2`: dropped; codex-style retry with no second start: dropped; G-L3: open T, start `TURNS_MAX - 1` others, `turn.started` T again, one more new turn: T is still live and open (its next delta is dropped as open, and `turnOpen` of the turn started right after T is true: that one was evicted instead) |
| T-L2 | live: `turn.completed` T, then `admit` for T returns `closed` and the delta is dropped; a `clean` token minted for T before the end and emitted after it: dropped (the gate requires T live and not masked); `item.completed` for T after the end: whole; `session.exited` with `turnId` T: same |
| T-L3 | live: Q open (`**password**:`), `content.reset` for P (stale), delta for Q: dropped; `content.reset` for Q, delta for Q: dropped (`open` kept); Q not open, reset after a newline, then `clean`: delivered |
| T-RS (G-M1) | `**pass`, `content.reset`, `word**: hunter2`: `opened` at `word**:` (live `word**:«redacted»`, log `word**:«redacted 8 chars»`); `**pass`, reset, `**password**: hunter2`: opened at the fresh label; `Hello wor`, reset, `ld\n`: clean, pending dropped at the newline; `**pass`, reset, reset, `word**: hunter2`: opened (pending retained); `**pass`, reset, `wo`, reset, `rd**: hunter2`: open at second reset, late bytes masked; exercise pending lengths at cap minus 1, cap, cap plus 1 with a fresh empty scanner; Pi and ACP real reset emitters drive every sequence through T-DRV |
| T-TOK | a `content.delta` with no `admitted`; with a token of another turn; with a token of the other kind; with a token already consumed; with a `closed` token: all dropped; a `clean` token: delivered with `delta === token.live` and no `admitted` field on the delivered object |
| T-TOOL (G-M3) | open turn: `item.started` tool with `input: "hunter2"`, `title: "hunter2"`, `toolIdentity: {name: "fs_write"}` with an independently provisioned trusted catalog entry: delivered and logged with `input` and `title` as `«redacted 7 chars»`, `toolIdentity.name` kept only for a match in the independently trusted catalog; otherwise masked; tool `item.completed` with `result: "hunter2"`, `detail: "hunter2"`: both withheld; `plan.updated` entry `**password**: hunter2` on a not-open turn: E1's form; on an open turn: withheld; `item.completed` `assistant_image` on an open turn: not delivered |
| T-16 | `turnStarted("P")`, `**password**` then blanks to 64 KiB - 1, 64 KiB, 64 KiB + 1, then `: hunter2` (P): masked |
| T-N | an untagged `in` delta frame: withheld, `msg.type` restored; an untagged `out` `{type:"user"}` row: walked as today (exact row) |
| T-W (G-L1) | open P: an `assistant` frame with `hunter2` in a text block and `{type:"hunter"}` in a tool input, a `result` frame with `result: "hunter2"` and `total_cost_usd: 0.1`, a `user` tool result with `hunter2`: no `hunter2` in the file, `msg.type` and `msg.subtype` present as written, `total_cost_usd` present, the tool input's `type` masked; a frame with `msg.type: "hunter"` (letters only, not listed): masked; `msg.type: "assistant"`: restored |
| T-W-live | open P: a `runtime.error` with `message: "hunter2"`, an `item.started` with a made-up key `note: "hunter2"`: both withheld; only exact validated structural fields kept; engine stopReason masked |

### 8.3 Shipped rows rewritten (where each goes)

| shipped row | fate |
|---|---|
| 14 a-d (33-61) | T-14 under `turnStarted("P")`, tagged P, exact `written(t)` (no blank before the marker: `at` is `sepEnd`, md-secret-label.mjs:150): (a) `**password**:«redacted 8 chars»` + `«redacted 20 chars»` x 30; (b) `**password**` + 600 blanks + `:«redacted 8 chars»`; (c) first delta `**password**:` + 600 blanks fires at the separator (the scanner returns `sepEnd` whenever a mark was deleted before, line 152, blanks or not): `**password**:«redacted 600 chars»`, then `\n\nhunter2` as `«redacted 9 chars»`; (d) first delta exactly `**password**:`: `**password**:«redacted 0 chars»`, then `«redacted 1024 chars»` x 70, then `«redacted 7 chars»`, no `After` |
| 15 eviction (63-79) | T-E |
| 16 line cap (81-90) | T-16 |
| 17 latched capacity (92-104) | T-E |
| 18 FRAMES "does not reset" (109-132) | T-R and T-TR |
| 18 "a prompt (out) resets" (134, 136-144) | T-S (a): a new turn id starts clean |
| 18 "a tool result (in) resets" (135, 133-144) | DELETED (pinned G2-r2); T-TR |
| 18 ping/block stop (148-156) | T-R |
| 18 latched then in entry (157-165) | T-S (a) |
| 18 interleaved fields (166-173) | T-C |
| 18 every split (174-184) | T-18s: unchanged inputs under a started turn; `afterLabel(written(t))` empty |
| 18i `**pass`, in entry, `word**: hunter2` (185-191) | T-TR |
| split equivalence (209-239), row 19 (241-258) | unchanged |
| md-secret-label.test.ts row 24 (`it` at 112, body 112-117) and server/testing/md-secret-label-user-text.base.json | DELETED (pinned the user-text leak); T1, E1-E10, K |

### 8.4 Text rows (server/md-secret-label-user-text.test.ts)

| id | rows |
|---|---|
| E1-E10 | §6, exact, through `redactSecretsInText` |
| K-CODE-SECRET | `` `password`: hunter2 `` becomes `` `password`: «redacted 8 chars» ``; every rejected type-shaped case in §2 masks |
| K-CODE-TYPE | `` `token`: string `` unchanged; parameterize all eleven fixed type words in §2, with ordinary code/prose controls |
| K (guard) | unchanged: `the token: leave this prose alone`, `const token = await getToken();`, `use a **strong password** here`, ``the `password` field``, `| **Password** | hunter2 |`; and the shipped base outputs copied literally before the fixture is deleted: `password=«redacted 10 chars»` (base.json line 46), `Authorization: Bearer «redacted 16 chars»` (47), `api_key: «redacted 30 chars»` (49). G-L5 named 47-49; the file read shows `my_token: x` at 45 and the XAI row at 48, so the three rows are 46, 47 and 49 |
| G1 (guard) | md-secret-label.test.ts wrapped-label rows and row 21 (72-76) exact through redactSecretsForSink; L7 owns changes to machine plain-label guards. Compare all machine fixtures against the merged L7 baseline, not stale pre-L7 plain-label expectations |
| G2 (guard) | electron/diagnostics.test.mjs rows 12 and 13 (515-536) unchanged; REDACT adds no Electron code; L7 owns its shared collector imports |
| I | every E, K, T1, T8, T9 input: f(f(x)) = f(x) through `redactSecretsInText`, `redactSecretsForSink`, `redactSecrets` and `redactSecretsForCard` |
| C | T10 |

### 8.5 Full serialization regression (A32-M4)

T-SERIAL compares entire published events and parsed native records with deterministic host IDs and timestamps, not just absence of secrets. Cases: open turn completion hunter2 gives exactly «redacted 7 chars», never «redacted 18 chars»; fresh non-streamed assistant completion **password**: hunter2 gives E1 at top-level text while sibling payload is withheld; fresh empty label gives E5, then next completion hunter2 is whole. Native opening delta preserves head plus original withheld-length marker, closed delta hunter2 is «redacted 7 chars», and clean delta remains clean after the full pipeline. Include equal-string siblings, forged tokens, stale clean tokens, duplicate consumption and private admitted/raw removal. Reprocessing an already projected event is not a supported intake; assert downstream text redaction remains idempotent. The native gate must not serialize its original frame or token alongside the projected msg.

T-DRV-STOP and T-DRV-FLUSH are parameterized across all seven drivers. Pause after a callback or buffer has captured a turn, Stop and complete it, allocate a concurrent fresh turn, then resume the old flush. Old content remains masked/dropped, fresh content stays readable. Repeat Stop before completion with an open and an unfinished-label turn. Compare native, bus, replay and subscriber outputs. T-C and T-G remain separate concurrency and same-thread generation proofs.

## MOVE LIST from L7

This is the single move ledger. L7 source is /root/swarm1018/D-L7-VISIBILITY-r31/designs/L7-VISIBILITY-1018-r31.md §4.1 (:196-227), R1 (:263), and /root/swarm1018/BF-L7-VISIBILITY-cx/designs/BUILD-FIX-L7-VISIBILITY.md BF-9 (:91-101). Every server-text branch moves to the named K row in server/md-secret-label-user-text.test.ts. The sink, Electron, report and feedback branches stay in L7 R1/R2/R5. Those branches are not deleted or moved out of 1.0.18.

For row 24, the source is server/md-secret-label.test.ts:101-117 and server/testing/md-secret-label-user-text.base.json. Every fixture entry has one ledger row below. Copy the ORIGINAL CORPUS input, not the already-redacted base output, into the named K row before deleting row 24 and its fixture. For the first 39 entries the original input is the indicated ROWS line; for the remaining ten it is the corresponding explicit CORPUS entry at :103-106. Every K row asserts §2 output and idempotence, and keeps its former base output as comparison evidence. Wrapped outputs use §6's formula, not guessed lengths. The type-word guard at fixture :39 is explicitly exempted from T1's secret assertion. The row at :48 must mask TAILSECRET9 because an exact marker followed by a suffix is not an exact marker.

| Source row being moved or deleted | REDACT K row / test | Destination rule and expected behavior |
|---|---|---|
| L7 §4.1 table row 1, password:\nfirst-value\nsecond-value | K-L7-01 | Visible text unchanged by the new plain rule (multiline); machine tail masked. Explicit audience distinction. |
| L7 §4.1 table row 2, token\n  arbitrary-value\n\nmore-value | K-L7-02 | Visible text unchanged (no separator); machine tail masked. |
| L7 §4.1 table row 3, private key then PEM | K-L7-03 | Visible text masks the PEM body under retained PEM policy; machine masks the entire labelled tail. |
| L7 §4.1 table row 4, private_key=BEGIN with unmatched body | K-L7-04 | Visible text and machine protect all PEM body bytes; no unmatched footer leak. |
| L7 §4.1 table row 5, token=SG. plus 22 a, dot/newline, 43 b | K-L7-05 | Shared provider spans protect both SG segments in text and machine; no provider suffix survives. |
| L7 §4.1 table row 6, Bearer pypi-AgE plus wrapped 82-character suffix | K-L7-06 | Shared complete Bearer/provider spans protect every segment in text and machine. |
| L7 §4.1 table row 7, token=sk- plus 20 a and /rest.~tail | K-L7-07 | Complete scalar/provider span masks suffix as well as provider core; same protection in both. |
| L7 §4.1 table row 8, ordinary status: ready | K-L7-08 | Unchanged in both audiences; status is not a secret label. |
| L7 R1 :263 and BF-9 :99 LF/CRLF variants of every §4.1 case | K-L7-LINES | Parameterize K-L7-01 through 08 with LF/CRLF; retain the same extent in each audience. |
| L7 R1/BF-9 plain, wrapped and no-separator forms | K-L7-LABELS | Enumerate registry label candidates for each form. Text applies §2, machine applies L7. Wrapped parity uses K-PARITY; no-separator differences use 01-03. |
| L7 R1/BF-9 indentation, blank and unindented continuation, fences and PEM | K-L7-TAIL | Wrapped text extends to end for each variant; plain multiline follows 01-04. Machines retain tail-to-end throughout. |
| L7 R1/BF-9 short values | K-L7-SHORT | password: x, token: x and code-span secret all mask in text; no blanket length bypass; test empty and equals controls. |
| L7 R1/BF-9 overlapping spans and punctuation suffixes | K-L7-UNION | Union original provider and selected text spans before rendering; exact complete suffix absence; E7/E9 preserved. |
| L7 R1/BF-9 exact markers, repeated/interleaved/double application | K-L7-MARKER | Exact marker alone stays stable; appended suffix is not a marker. I covers all functions independently. |
| L7 R1/BF-9 complete and unmatched PEM plus repeated BEGIN | K-L7-PEM | E10 and T8 retain user precedence; unmatched body protected. Machine follows L7 union; T10 bounded work. |
| L7 R1/BF-9 existing provider/JWT, Basic auth and SG/PyPI/xAI additions | K-L7-PROVIDER | Run shared provider fixtures through text adapter and sink; no copied provider regex, retain Basic-auth protection. |
| L7 BF-9 :95 explicit text adapter and short-return change | K-L7-OWNER | REDACT implements §2 in server/redact.ts; L7-only revision leaves row 24 intact; K-MERGE proves the handoff. |
| row 24 fixture :2; ROWS md-secret-label.test.ts:28 | K-24-01 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :3; ROWS md-secret-label.test.ts:29 | K-24-02 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :4; ROWS md-secret-label.test.ts:30 | K-24-03 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :5; ROWS md-secret-label.test.ts:31 | K-24-04 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :6; ROWS md-secret-label.test.ts:32 | K-24-05 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :7; ROWS md-secret-label.test.ts:33 | K-24-06 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :8; ROWS md-secret-label.test.ts:34 | K-24-07 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :9; ROWS md-secret-label.test.ts:35 | K-24-08 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :10; ROWS md-secret-label.test.ts:36 | K-24-09 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :11; ROWS md-secret-label.test.ts:37 | K-24-10 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :12; ROWS md-secret-label.test.ts:38 | K-24-11 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :13; ROWS md-secret-label.test.ts:39 | K-24-12 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :14; ROWS md-secret-label.test.ts:40 | K-24-13 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :15; ROWS md-secret-label.test.ts:41 | K-24-14 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :16; ROWS md-secret-label.test.ts:42 | K-24-15 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :17; ROWS md-secret-label.test.ts:43 | K-24-16 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :18; ROWS md-secret-label.test.ts:44 | K-24-17 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :19; ROWS md-secret-label.test.ts:45 | K-24-18 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :20; ROWS md-secret-label.test.ts:46 | K-24-19 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :21; ROWS md-secret-label.test.ts:47 | K-24-20 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :22; ROWS md-secret-label.test.ts:48 | K-24-21 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :23; ROWS md-secret-label.test.ts:49 | K-24-22 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :24; ROWS md-secret-label.test.ts:50 | K-24-23 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :25; ROWS md-secret-label.test.ts:51 | K-24-24 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :26; ROWS md-secret-label.test.ts:52 | K-24-25 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :27; ROWS md-secret-label.test.ts:53 | K-24-26 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :28; ROWS md-secret-label.test.ts:54 | K-24-27 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :29; ROWS md-secret-label.test.ts:55 | K-24-28 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :30; ROWS md-secret-label.test.ts:56 | K-24-29 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :31; ROWS md-secret-label.test.ts:57 | K-24-30 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :32; ROWS md-secret-label.test.ts:58 | K-24-31 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :33; ROWS md-secret-label.test.ts:59 | K-24-32 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :34; ROWS md-secret-label.test.ts:60 | K-24-33 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :35; ROWS md-secret-label.test.ts:61 | K-24-34 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :36; ROWS md-secret-label.test.ts:62 | K-24-35 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :37; ROWS md-secret-label.test.ts:63 | K-24-36 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :38; ROWS md-secret-label.test.ts:64 | K-24-37 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :39; ROWS md-secret-label.test.ts:65 | K-24-38 | Code type guard unchanged, K-CODE-TYPE. |
| row 24 fixture :40; ROWS md-secret-label.test.ts:66 | K-24-39 | Wrapped-label extent A under §2 and §6; all original secret sentinels absent. |
| row 24 fixture :41; CORPUS explicit entry 1 at md-secret-label.test.ts:103-106 | K-24-40 | Ordinary prose/code guard unchanged. |
| row 24 fixture :42; CORPUS explicit entry 2 at md-secret-label.test.ts:103-106 | K-24-41 | Ordinary prose/code guard unchanged. |
| row 24 fixture :43; CORPUS explicit entry 3 at md-secret-label.test.ts:103-106 | K-24-42 | Ordinary prose/code guard unchanged. |
| row 24 fixture :44; CORPUS explicit entry 4 at md-secret-label.test.ts:103-106 | K-24-43 | Ordinary prose/code guard unchanged. |
| row 24 fixture :45; CORPUS explicit entry 5 at md-secret-label.test.ts:103-106 | K-24-44 | Plain colon short value now masks to my_token: «redacted 1 chars». |
| row 24 fixture :46; CORPUS explicit entry 6 at md-secret-label.test.ts:103-106 | K-24-45 | Retained equals output password=«redacted 10 chars». |
| row 24 fixture :47; CORPUS explicit entry 7 at md-secret-label.test.ts:103-106 | K-24-46 | Retained Authorization: Bearer «redacted 16 chars». |
| row 24 fixture :48; CORPUS explicit entry 8 at md-secret-label.test.ts:103-106 | K-24-47 | Marker plus suffix is not exempt; protect TAILSECRET9, retain original-input complete-value coverage. |
| row 24 fixture :49; CORPUS explicit entry 9 at md-secret-label.test.ts:103-106 | K-24-48 | Retained api_key: «redacted 30 chars». |
| row 24 fixture :50; CORPUS explicit entry 10 at md-secret-label.test.ts:103-106 | K-24-49 | Wrapped extent A, E1/row-21 formula: **password**: «redacted 14 chars». |

No source row is orphaned: 8 explicit L7 examples plus all R1/BF-9 variant families, and all 49 row 24 entries are listed. The builder records inventory equality between the original corpus and K-24-01 through K-24-49 before deleting the fixture. K-MOVE fails on any missing or duplicate source index. Keep sink row 20's code-type case masked in L7; user K-CODE-TYPE is unchanged by deliberate policy. Add K-CODE-SECRET beside it. Tests K-CALLERS, K-PARITY, K-MERGE, K-REPLAY and K-MOVE are blocking acceptance work for this same release.

## 9. Closing table (every finding of r1, r2, r3 and r31)

| finding | reviewer | severity | rule section | test |
|---|---|---|---|---|
| A1-r1 PEM body exposed by U | Astra | High | §2 (PEM first, extent A) | T8, E10 |
| A2-r1 chained labels | Astra | High | §2 (no opener search) | T9 |
| A3-r1 first-entry-delta, cross-field, lifecycle | Astra | High | §3.1 (unknown is masked), §3.4 | T5, T-R |
| A4-r1 quadratic chains | Astra | High | §2 (one line scan) | T10 |
| A5-r1 process overlap | Astra | High | §3.5 (turn id per session) | T-G |
| A6-r1 raw replies on SSE and replay | Astra | High | §3.3 (gate at `publish`) | T6, T-DRV |
| A7-r1 idempotence | Astra | Medium | §2 | I, E6 |
| A8-r1 crash recovery; teardown claim | Astra | Medium | §5 | T-X (a), (b) |
| A9-r1 contradictory oracles | Astra | Medium | §6, §8.3 | E2, E7, E8, T-S, T-14 |
| G1-r1 H-SR A, B (C not a leak) | GrokBuild | High | §3.1, §3.6 | T5, T-R, T-X (d) |
| G2-r1 Stop vs reset | GrokBuild | High | §3.1, §4 | T-S |
| G3-r1 live reply never redacted | GrokBuild | High | §3.3 | T6, T-DRV, T-L1, T-L2, T-L3 |
| G4-r1 T4 keeps the path | GrokBuild | Medium | §6 | T4 |
| G5-r1 U13 count | GrokBuild | Medium | §6 | E2 |
| A1-r2 openers destroyed | Astra | High | §2 | T9 |
| A2-r2 completions bypass the latch | Astra | High | §3.3 (R3 whole completions), §3.4 | T-OWN, T-W, T-DRV (c) |
| A3-r2 stale reset clears another turn | Astra | High | §3.3 step 4, §3.2 reset | T-L3 |
| A4-r2 repair memory | Astra | Medium | §5 | T-X (c) |
| G1-r2 closer search | GrokBuild | High | §2 | T9 |
| G2-r2 tool result clears a latch | GrokBuild | High | §3.2 step 3, §4 | T-TR |
| G3-r2 U13 is 13 | GrokBuild | Medium | §6 | E2 |
| A1-r3 ownership by counter | Astra | High | §3.3 step 5 (R3) | T-OWN |
| A2-r3 eviction then repeated start | Astra | High | §3.1 (R1) | T-E, T-S (a) |
| A3-r3 native first drops the live head | Astra | Medium | §3.2 (R2) | T-DRV (a), (b) |
| A4-r3 oracles | Astra | Medium | §6 E10, §8.3 T-14 (c), (d), §5 and T-X (c) | T8, T-14, T-X |
| G-H1 non-delta frame never opens | GrokBuild | High | §3.2 step 3 (R2) | T-DRV (c), T-TR |
| G-H2 ownership by counter | GrokBuild | High | §3.3 step 5 (R3) | T-OWN |
| G-M1 reset deletes the label line | GrokBuild | Medium | §3.2 reset fork | T-RS |
| G-M2 T8 oracle | GrokBuild | Medium | §6 E10 | T8 |
| G-M3 tool payloads, plan entries | GrokBuild | Medium | §3.3 steps 7, 8 (R3) | T-TOOL |
| G-M4 both gates scan | GrokBuild | Medium | §3.2 (R2) | T-DRV, T-TOK |
| G-M5 only Claude tagged | GrokBuild | Medium | §3.5 | T-TAG, T-DRV |
| G-L1 regex restore | GrokBuild | Low | §3.4 step 3 | T-W |
| G-L2 last-byte placement | GrokBuild | Low | §5 | T-X (b) |
| G-L3 keep vs move | GrokBuild | Low | §3.1 `turnStarted` | T-L1 |
| G-L4 relaunch after end | GrokBuild | Low | §3.1 (not produced; R1 anyway) | T-L1, T-L2 |
| G-L5 citations | GrokBuild | Low | §8.3, §8.4 | K, G1 |
| A32-H1 / review finding 1 at :1 | Astra r31 | High | §3.1 registry allocator, every tombstone exit | T-E, T-E-cap/end/exit/restart/crash/reload/api |
| A32-H2 / review finding 2 at :8 | Astra r31 | High | §3.3.1 exact paths and payload isolation | T-PAYLOAD, every key row; T-DRV-pi/codex |
| A32-M1 / review finding 3 at :15 | Astra r31 | Medium | §3.2 preserve pending or open before loss | T-RS, T-DRV-pi/acp reset and cap cases |
| A32-M2 / review finding 4 at :22 | Astra r31 | Medium | §3.5-3.6 actual active intake and callbacks | T-DRV all seven, T-DRV-STOP, T-DRV-FLUSH |
| A32-M3 / review finding 5 at :31 | Astra r31 | Medium | §3.2 transform before admission and flush | T-DRV-pi(d/e), T-DRV-FLUSH |
| A32-M4 / review finding 6 at :38 | Astra r31 | Medium | §3.3-3.4 exact projection installed once | T-SERIAL, T-OWN, T6 |
| A32-L1 / review finding 7 at :47 | Astra r31 | Low | §5 and §8.2 corrected rotation fixture | T-X(b), T-X(b2) |

## 10. Build brief

Build on BASE18 a5450e2b plus L7 first, for Murage 1.0.18. No build or test was run for this design. Building/testing occurs on Hetzner /root/fuigo-builds/<lane>/, never on the Mac. All seven r31 findings have named implementation rules above, not deferred BUILD-FIX entries. Review acceptance still requires actual behavior and sensitivity evidence.

1. Complete K-REPLAY on the exact proposed text policy and obtain MurageMain's ruling on the count before implementation. Record L7's merged revision and its collector API. Implement the §2.1 adapter seam using L7's sole shared label registry and original-input spans. Keep L7's machine, Electron and feedback policy separate. REDACT alone changes redactSecretsInText and row 24. Add all K move rows first, prove source-index equality, then delete row 24 and the base fixture. Keep E1-E10, T1/T3/T4/T8/T9/T10 and I with the explicit type exception. Test auto-approve and done-when effects, merge gap, and visible/sink parity.
2. Add server/turn-secrets.ts with private live/retired maps, allocateTurn, observational turnStarted, terminal retirement, monotonic open, bounded reset histories and token projections. No public register(id) or arbitrary restore path. Change every real driver allocation listed in §3.1, preserve retry IDs and keep prewarm unowned. Gate: T-E and every departure row, T-L1/L2/L3, T-RS, T-TOK, T-OWN, T-C and T-G.
3. Implement payload-first withholding and exact path reconstruction in §3.3.1. Establish trusted host envelopes and per-turn opaque item/request mappings, not validation by key name or UUID shape. Reconstruct tool identities only from a trusted catalog; unknown catalog means masked identity. Add every T-PAYLOAD row, real Pi/Codex tool-name cases, plan enums, whole completions and image drop. Gate: T-PAYLOAD, T-TOOL, T-W-live and T-SERIAL.
4. Gate EventBus.publish before logging, fold, replay and subscribers (bus.ts:242-252). No early lifecycle/control return may bypass projection. Strip private admission fields on every event. Keep the phone policy separate and unchanged. Gate: bus-turn-secrets, bus.test, bus-phone-withhold, bus-image-log, runtime-event-out, sse-visibility and index tests.
5. Replace native thread maps/type:user reset with the shared turn registry. Withhold original frames then install validated projections at exact paths once, with explicit native envelope serialization and independent per-sink token consumption. Preserve source discriminator sets and record limits. Place last-byte torn guard after capExisting and rotation. Gate: T-SERIAL, T-X including (b2), T5/T-R/T-S/T-TR/T-N/T-W, native-md-stream and native tests. Preserve split equivalence and bounded scanner clocks.
6. Wire Claude at :4821, Pi's transformed text before logging/publication around :1152/:1234, Codex at :2189, ACP active handleStdoutLine before :4321, Antigravity :842, boxagent :243/:275, and openai-chat callback/flush admission at :1210-1234/:1309-1313 with separate whole completion admission before :1314. Carry decisions into actual emit paths and sanitized accumulators. Pi uses todo.push(raw) BEFORE admit(out.text), never the reverse; all flush text uses that same helper. ACP idleLine :2280 remains unowned. Add or extend each real fake-engine harness through native files and EventBus. Gate: all seven T-DRV rows, T-DRV-STOP and T-DRV-FLUSH with clean controls and concurrent new turns.
7. Add native-turn-tag inventory and store-redact-md integration tests. Allow only explicitly unowned incoming handshake/idle/overflow exceptions where §3.6 says so, all withheld; do not falsely require an active token at ACP idleLine. Assert every allocated driver path and every delta/flush path is covered. Retain exact T-14 and T-18s updates and T2 store/card/channel coverage.
8. Put every new suite and all K, T-E, T-PAYLOAD and seven-driver rows in blocking ci/gate-tests.txt with user failure descriptions. Run focused suites, the full affected server suite, typecheck and lint; preserve L7 collector/runtime/packaging gates. Report commands, actual results, original-input span budgets, replay counts and reversal evidence. No runtime or memory claim is accepted on source inspection alone.
9. Send the concrete revision through Astra on another account, file-reading Grok, then one Fable critique. This document is not AGREED until Fable explicitly says AGREE. A repeated High root or NOT FIXED round-1 item returns to Fable design work. No finding leaves 1.0.18.

No owner-facing strings change: stored marker remains «redacted N chars», live latch marker remains «redacted». Do not create state from observed IDs, drop unfinished history before opening, use key-name exemptions, log tokens/raw originals beside projections, transform label-bearing text after admission, or re-mask a computed projection.

## 11. BUILD-FIX


