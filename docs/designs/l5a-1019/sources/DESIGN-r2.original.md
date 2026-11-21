# REDACT-MD, audience collection, and appendNative cleanup — revised design
Revision: r2, author Astra, status DRAFT: needs an Astra AGREE on a different account plus a Fable read, seated by MAIN, before any build

Job odr2-l5a; lane L5a; Murage 1.0.19; 2026-11-10. This document replaces DESIGN.md in full. The required file-reading Grok security review is also a gate unless MAIN explicitly supersedes it. READY-FOR-REVIEW means this design is submitted for review, never permission to build.

## 1. Scope, authority, and evidence

Deliver the entire REDACT-MD user-text rule, historical U1G3+L7 collector/execution separation and machine-sink preservation, historical bot-display sanitization, carrier/sink/UX proof, and the S appendNative dead-mask cleanup. No row moves out of 1.0.19. No Settings switch, secret reveal, new retention store, or weakened approval is introduced.

Paths: B = `/root/fuigo-builds/orph/_base` (supplied int/1019 c12aaad93); E = `/root/fuigo-builds/orph/_ev`; H = `/root/swarm1018`; P = `/root/fuigo-builds/orph/ORPHAN-PLAN-1019.md`. Code and build paths below are relative to B. Source inspection was read-only, using searches and bounded ranges; no tests, builds, Node, Docker, or product edits were performed. Test REDs below are predictions, not results.

| Authority | Binding decision and disposition |
|---|---|
| BRIEF.md:9; P:52–53 | `REDACT-MD ... markdown secret rule (sinks landed)` and `appendNative dead mask ... S`: both delivered, cleanup after redaction integration. |
| P:93–95 | `5a: REDACT-MD, U1G3+L7, appendNative mask`; current L7 is `ENGINES-ACP`. Every historical L7 responsibility in this document belongs to current L5a, with one integration owner. |
| E/handoffs/FIX-LEDGER.md:1560,1569,1620,3469 | Machine extent A is fail-closed to end of text; user-text was a separate unfinished row, subsequently moved to 1.0.19. Earlier separation is not permission to omit it. |
| E/handoffs/SWARM-W1-STATUS.md:1717,1721 | `monotonic per turn; one shared scanner at one choke point for all drivers; open turn masks every carrier`. D7–D14 implement this for audience collection. Existing native text-free projection remains an independent stricter sink, not a second turn scanner. |
| E/handoffs/FIX-LEDGER.md:3546 | `merge order L7 then REDACT`, single collector ownership, no orphaned text rows. Current L5a merges the collector before enabling whole-text policy. |
| E/handoffs/FIX-LEDGER.md:3547; H/_r3b/r6-redact-plain-ruling.txt:1–3 | `colon only, one word ... value must end its line`; fixed type list includes `token`; `password: 1234` masks and `tokens: 1200` stays. D3 and T3 implement the later ruling, superseding r3.2's earlier “no type-word exception” sentence. |
| E/handoffs/SWARM-W1-STATUS.md:1690 | File-reading Grok is **required** at zero Highs on REDACT before AGREED. A SKIPPED stub is not a review. |
| `/root/fuigo-builds/swarm-b/_designs/MURAGE-UX-BAR.md`:6–46; E/designs/SETTINGS-NO-REGRESS-GATES-1019.md:18 | G9 is mandatory: simple surface, all existing capabilities, working defaults, usable controls, desktop/phone and both themes, Fable and packaged proof. |
| `/root/fuigo-builds/swarm-b/odes-l5a/last.txt`:5–35 | All nine answers and all ten amendments are adopted; the traceability tables below bind them to rules and tests. |

Recovered evidence beyond the initial evidence copies:

* H/D-REDACT-MD-1018/inputs/REDACT-MD-REDESIGN-3-1104.md, especially :11–65, supplies pass-3 findings and the original case families.
* H/D-REDACT-MD-1018/designs/D-REDACT-MD-1018-1018.md:1–12 identifies the Fable-authored fresh design, H-UT/H-SR, and carried pass-3 findings. This is not evidence of a later AGREE.
* H/D-REDACT-MD-r32/designs/D-REDACT-MD-r32.md:13–42,56–74,374–489,490–551 supplies the binding rules, type list, MOVE LIST and individually identified review findings.
* H/D-REDACT-MD-r32/inputs/D-REDACT-MD-astra-r31.md:1–69 supplies the seven r31 findings; H/_r3b/r6-rules-redact-r32.txt and H/_r3b/r6-redact-plain-ruling.txt supply the authoritative later rulings.

Evidence gate, decided rather than left as a question: MAIN must attach these exact recovered texts and the exact named `D-REDACT-MD-1018-r1.md` Fable/r1 artifact, or positively establish its identity with the recovered Fable document, before build. The exact r1 filename was not found in the inspected archival filename inventory. Early BLOCK summaries cannot substitute. The reconciliation in §7 covers the findings actually recovered; unseen findings are never certified. Recovery/identity verification and individual reconciliation are mandatory build prerequisites, not a proposed scope cut. All future evidence must be copied into this lane's review packet, never written back to archival or other-lane directories.

## 2. Checked facts on the supplied base

| File:line | Verified fact and design consequence |
|---|---|
| server/redact.ts:151–155,202–240 | KEY_VALUE has an eight-character floor; TEXT_RULES has no Markdown rule; the short-string exit precedes all rules. `password: 1234` is a real predicted RED. Sink text already applies extent A. |
| shared/md-secret-label.mjs:10–14,30–68,73–93 | Shared vocabulary and offset-preserving normalization exist; all matches are visited; only LF splits lines; deletion before the value may make a label wrapped. The scan has a 1,048,576-unit line budget. Existing whole-machine wrapper returns a fixed marker on budget exhaustion. |
| shared/md-secret-label.mjs:103–175 | Incremental scanner exists, but no complete audience turn-lifetime policy. Preserve speech compatibility while adding the new policy interface. |
| server/contracts.ts:85–97,121–360 | RuntimeEvent carries optional provider turnId and raw payload. Neither is trusted harness admission. The union includes plans, subtasks, commands, questions, image alt, requests and nested error details as well as text deltas. |
| server/harness/bus.ts:243–255,267–278,317–340,448–463 | Adapter attach stamps instanceId; publish has raw no-log/live-only delivery; immediate and durable subscribers share raw events; durable delivery queues/retries. Sanitization must precede every branch and occur once per intake. |
| server/index.ts:9207–9240,9543–9568,10547 | foldRuntimeEvent sends speech, mutates display text, and handles permission decisions. It must be internally split; neither a wholly raw fold nor a wholly sanitized fold suffices. |
| server/index.ts:16630–16642,16733–16768 | sendProjectUsageTurn is the common fenced send path; direct, shared-owner and project-usage branches call adapter.sendTurn. Admission must precede all three and synchronous emissions. |
| server/transcript-page.ts:42–61 | wireThread maps message/messages/openCards and sequence metadata, but forwards display text unsanitized. Store validation is not read-time redaction. |
| server/store.ts:890–944; server/inbox.ts:56; server/tool-results.ts:56 | Existing bot storage, previews and model-facing text use the plain redactor; changing it affects these consumers. |
| server/auto-approve.ts:370; server/done-when.ts:20 | A changed redacted string refuses an exact allow key or drops a done_when value. Preserve these effects; never exempt execution policy by substituting display text. |
| server/artifacts.ts:40; server/memory/record-write.ts:36; server/memory/capture.ts:46–53 | Artifact metadata and memory text/action labels use plain redaction and need named boundary proofs. |
| server/drivers/native.ts:246–265,285–328; server/runtime-event-out.ts:378–382,406–433,459–466 | nativeTraceFrame discards delta/text/partial_json/thinking before maskStreamDelta. The latter requires object delta/event.delta, which cannot survive that projection. Its branch is unreachable on non-lifecycle appendNative writes. |
| server/drivers/native.ts:145–160,169–179,295,322–325 | Phone tracking still uses the 256 bound; streamDelta/STREAM_FIELDS still recognize size exemptions; rawChars precedes phone/projection; final rejection measures UTF-8 bytes. These survive cleanup. |
| electron/diagnostics.mjs:120–139,485–494 | Whole log tails already receive machine extent A before splitting. Existing diagnostics tests are guards, not automatically new REDs. |

## 3. Normative design (D1–D20)

### Whole text and caller policy

**D1 — original input and precedence.** The shared scanner shall find candidates in original text before PEM, bearer, key/value, provider or financial-ID rewrites can destroy wrapping. The user adapter selects wrapped extent-A spans plus D3 plain spans and renders them before the legacy rules, whose relative order remains unchanged. Evaluate new rules before the under-eight-character return. One vocabulary lives in shared/md-secret-label.mjs; expose original-offset candidates for the text adapter, machine wrapper and incremental scanner. Do not copy a local name regex into server/redact.ts. If integrating the historical registry work, its shared definitions replace this vocabulary at the same interface; no second vocabulary is allowed. Existing provider/query/equals/PEM protections cannot be weakened by a type exemption.

**D2 — wrapped extent.** At the first qualifying wrapped label, preserve the original prefix through `:` or `=`, then suppress the entire remaining supplied text unit, including whitespace, quotes, blank lines, subsequent labels, fences, links and punctuation. Do not find a closer or infer a safe resume point. Empty wrapped values detect immediately. Standalone fresh replacement is `«redacted N chars»`, N the original suffix's JavaScript UTF-16 length; render one separating space. Thus `**password**: hunter2` becomes `**password**: «redacted 8 chars»`, and with `\nmore\n` appended N is 14. Turn display uses the stable marker in D20 instead of growing counts.

**D3 — exact additions and exceptions.** Keep existing normalization and its conservative wrapping, including `+`, indentation, prefixed labels and all matches on a line. Keep the current recognized label vocabulary: api key/api_key/api-key/apikey, secret, token, password, passwd, authorization, auth token/auth_token/auth-token, access key and private key forms, with the existing plural/prefix behavior. Add the binding unwrapped plain form: a recognized secret name at its token boundary, colon only, optional horizontal whitespace, one nonempty non-whitespace word of any length ending its line, optional horizontal trailing whitespace. Preserve separator/trailing whitespace and mask the word only. LF is the line boundary; CR is not an independent boundary (D10). Equals, empty values, multiple words and multiline values are outside this **new plain rule**, and retain pre-existing protections.

The fixed lowercase type-word list is exactly `string`, `number`, `boolean`, `null`, `object`, `array`, `undefined`, `unknown`, `any`, `void`, `never`, `token`. The first eleven are r3.2 §2's list; the final `token` and the plain-form guard are the later binding ruling. An unquoted exact type word is exempt from this new plain rule. A code-span secret label followed on the same line by exactly one such unquoted word and horizontal whitespace only is also exempt from the standalone wrapped user-text addition; a later nonempty line rejects that code-type exemption. Case variants, quoted words, `string[]`, `string | null`, `Optional[str]`, functions and URLs do not qualify. These narrowly specified user-text exceptions never undo other rules or a turn latch, and never weaken machine extent A.

Required literals: `password: 1234` → `password: «redacted 4 chars»`; `password: hunter2` → `password: «redacted 7 chars»`; `token: x` and `my_token: x` mask; `tokens: 1200` stays; `token: token` stays; `password: hunter2 and more` is unchanged by this new form; code-span `password` followed by `: hunter2` masks, code-span `token` followed by `: string` stays in standalone user text. Numeric values are exempt only under count-like plural labels (the frozen count-label set is `tokens`); numbers under password, secret or authorization mask. Do not create a global numeric exemption. If a live turn detects a wrapped code-type label, the stricter turn latch wins.

**D4 — markers.** Keep an existing marker only when the entire trimmed suppressed suffix is exactly `«redacted»`, `«redacted N chars»` with 1–9 digits, `«redacted private key»`, or `«redacted provider credentials»`. Embedded, fake, incomplete and suffixed markers are ordinary secret text. Marker syntax conveys no trusted provenance.

**D5 — repeated passes.** Require Markdown-pass idempotence and monotonic secrecy. Preserve caller-specific legacy outputs outside explicitly changed cases. Do not demand a false global fixed point from all legacy rules; later passes may hide more but never restore original text. Keep base/final comparison outputs in the corpus.

**D6 — failure.** Detector failure or exhaustion returns a fixed marker for the complete text unit, with no second unrestricted scan, serialization or logging of the failed input. Expose a result `{text, detected, exhausted}` and candidate offsets through the shared adapter without rescanning; retain compatibility exports, including the current string-returning machine wrapper and speech detector behavior. Error strings contain no input. Any pre-transform that can introduce a recognized label must happen before intake, or pass a new bounded standalone display boundary before output; downstream consumers never inject raw text into an already admitted projection.

### Trusted intake, streaming, and bounded state

**D7 — admission and provenance.** Only the harness allocator may mint an opaque `TurnAdmission`, bound to process incarnation, provider attachment epoch, instanceId, threadId and a monotonically fresh harness generation. Mint it inside sendProjectUsageTurn after the execution fence admits the send and before any adapter invocation, covering its direct branch (:16754), sharedOwnerUsageTurn (:16639) and dispatchProjectUsageTurn callback (:16768). Preserve the token across transport retries, relaunches and steering of that turn; a genuinely new harness send receives a new token. Prewarm/idle traffic is unowned and MASKED for audience text.

Bind the token out of band to the driver operation before synchronous output; a provider's optional turnId is merely a correlation value. The seven driver capture sites are Claude sendTurn (:3773, including relaunch :5695), Codex sendTurn/sendTurnBody (:2848/:662), Pi sendTurn (:827), ACP sendTurn/sendTurnFenced (:6304/:2603), Antigravity sendTurn (:1081), boxagent sendTurn (:106), and openai-chat sendTurn (:1084). Their per-process/run callbacks and pending flush closures capture that token; ACP/Codex prewarm captures no token. Provider emits carry a nonserializable host context as a second callback argument, never an engine-controlled JSON field. Memory decoration forwards that context unchanged. Bus.attach binds it to its captured attachment epoch. Never resolve a missing context through the currently active thread or a reused turnId. Invalid/missing context means MASKED output; execution validation remains its own authority.

**D8 — monotonic state and retirement.** A fresh valid admission may create a CLEAN entry; detection, uncertainty, failure, overflow or loss of unfinished detector history removes CLEAN eligibility permanently. No observed turn.started, reset, tool result, retry, user-shaped protocol frame, or late callback can allocate/reopen it. Absence from the CLEAN map means MASKED, without a masked map or tombstones. Terminal intake sanitizes/flushes first, queues terminal last, then retires the admission; already computed immutable safe emissions may finish delivery afterward. Cancellation discards unfinished pending content and retires; session.exited flushes only sanitized content or discards it before its terminal skeleton; no raw exit flush. Provider detach/replacement and restart invalidate old attachment/process epochs. New process admission cannot validate old tokens. No raw scanner state is persisted.

**D9 — event atomicity.** Every audience carrier of a generation shares one latch. A whole event is a batch: inspect its recognized free-text fields in manifest order before releasing any field. A hit masks every other free-text field in that batch and all pending carriers; the triggering field may retain its D2 safe prefix, then the fixed marker. No traversal order can leave an earlier sibling unmasked. Already delivered safe complete lines cannot be recalled and remain safe. Control facts are reconstructed separately from trusted authority, never from familiar-looking field names.

**D10 — detect now, present complete lines.** Feed every raw text delta into the shared incremental scanner synchronously at collector intake, before any subsequent event can deliver. Detection does not wait for LF. `reasoning.delta("**password**:")` (canonical content.delta/reasoning_text) latches before a following assistant or tool event containing `hunter2`, even with no newline. On the first hit, sanitize all pending carriers and mask every later audience event. Buffer clean presentation until LF or authoritative item completion; retain normalization, original offsets and bare CR until LF/completion. Never release on bare CR. Split CRLF and repeated CR have the same detector meaning as whole text, including `*\rthe token: alpha beta`. Incremental normalization must retain needed lookahead (notably underscores) and defer ambiguity; losing it latches rather than guessing.

At LF, release only a line already scanned and safe under the whole-text policy, including D3's end-of-line plain check. Plain-form detection requiring EOL is decided there; wrapped detection is immediate. An item completion closes the final unterminated line. content.reset discards pending presentation, but if any unfinished detector history exists it first latches the generation (the conservative alternative to maintaining reset forks); reset of an already complete clean stream keeps it clean. Cancel discards pending content; session exit applies D8. No reset/stop path releases a raw buffer. Status, Stop and approval controls bypass text buffering through typed trusted control emissions, not through a text bypass.

**D11 — budgets before work.** Keep at most 256 CLEAN admissions globally and 64 Ki (65,536) pending UTF-16 units per turn across all streams. Exact limit is accepted; cap+1 masks. Add at most 64 semantic stream entries per CLEAN turn and 4,096 globally; the 65th or 4,097th removes that turn's CLEAN eligibility. An absent/empty itemId uses one fixed stream per streamKind, never a fresh key per event; untrusted item strings cannot become map keys without bounded host interning. Invalid IDs use the fixed anonymous slot or omission, never unbounded entries. MASKED tokens need no text/stream allocation and have no registry entry. Marker/dedup state lives in the existing bounded delivery/item record, released on delivery or retirement, not an unbounded masked-state table.

Per event, limit traversal to 20,000 nodes, depth 40, 256 Ki UTF-16 scalar/key units in aggregate, 1,024 code units per inspected arbitrary key, and a 1,048,576 work-unit budget (including normalization and rendering). Charge before string copies, offset maps, enumeration steps, descendant access and buffering. Read fixed schema properties directly; do not Object.keys/JSON.stringify an arbitrary large object merely to decide that it is over budget. Unknown subtrees are omitted without enumeration. Known arbitrary tool preview maps are converted to a bounded list of scanned key/value pairs with fixed output keys; never copy attacker keys into JSON. Stop incremental own-entry iteration at budget; malformed/accessor/proxy shapes fail to the skeleton without evaluating getters or revisiting the remainder. Charge a scalar's length in O(1) before allocating/scanning it. Incremental streams consume only new units, never repeatedly scan the accumulated line per chunk.

On exhaustion discard the partial projection and return a fixed typed omission skeleton built solely from the trusted envelope: `{type:"audience.omitted", eventId, threadId, generation, reason:"redacted", text:"«redacted»"}`; maintain required terminal/control semantics as separate bounded trusted emissions. Do not “mask all fields” with a second traversal. Unknown/unadmitted floods produce the same bounded result without allocating CLEAN or tombstone state. Existing bus intake/backpressure limits apply to sanitized output and execution delivery; slow consumers cannot create spill files. Stop and terminal control capacity is reserved separately from text queues.

**D12 — snapshots, replay, identity and order.** Intake computes the audience result exactly once. Queue that immutable result with per-subscriber owed bits; writer retries/reconnect replay never advance the scanner or recompute from raw events. Source event identity comes from a host intake counter; provider eventId is correlated privately, not trusted for deduplication. Synthetic IDs are `(incarnation, attachmentEpoch, generation, sourceIntakeOrdinal, emissionOrdinal)`, serialized as host opaque IDs; emission ordinals cover buffered line flushes, omissions and terminal in deterministic order. Queue retains them unchanged. Retries target only owed subscribers; speech/output dedup use those IDs and bounded item revisions.

A completed snapshot is checked as a complete display unit, without replaying its duplicated prefix into incremental state. MASKED always overrides it. For CLEAN, compute append suffix only when it is a verified exact prefix extension of already emitted sanitized text; otherwise replace the display with a newly sanitized snapshot and do not speak it again. Never restore a region previously suppressed for that item/generation. Flush pending sanitized text before the terminal envelope even with held writers. Retirement happens at intake, not after an arbitrary subscriber retry. Late events remain bound to the old token and become omitted, even while a new turn on the same thread is CLEAN. Reconnect reuses sanitized stored/display copies and does not speak historical snapshots.

**D13 — typed collector contract.** The frozen interfaces in §4 define trusted admission, zero-or-more audience emissions, separate immutable execution delivery, and terminal retirement. Collector intake is before omitLog, !persistsEvent, closed-log, phone-log, immediate-listener and durable-listener branches. Audience types have no raw, execution payload, private token or fallback to RuntimeEvent. Logs consume the same computed audience payload with their additional existing stricter projection/phone policies. The trace's existing native projection remains text-free. Any malformed/unknown variant becomes the fixed omission skeleton. New union variants require a manifest entry, serialization test and execution classification before typecheck passes.

**D14 — owner and integration order.** Current L5a owns both policy and historical U1G3+L7 collector. Merge Wave 1 collector and scanner integration first, then whole-text activation and standalone/history boundaries, then native cleanup. Giving the existing fold raw events or rewriting its whole event in place is prohibited. Split execution handling from speech, transcript/card rendering and notifications. All original authorized arguments, file paths, tool identities, grants, execEnv, mount records, request IDs, answer labels and command bytes reach execution unchanged. Display replies reference host-bound action/option IDs; the server resolves those to original values, never sends redacted labels as answers. Unknown display provenance suppresses text but grants no new authority and does not waive existing approval checks.

**D15 — historical and standalone boundaries.** Add copy-only `sanitizeBotDisplayMessage` at wireThread for all message, messages and openCards rows before slim/seq shaping, for slim true/false and legacy true/false. A known owner-authored row stays unchanged. Bot-authored rows sanitize every text-bearing field (text, removedText, tool/card summaries, detail, spoken, routine/goal text, attachment alt/caption and nested preview fields) as one bounded display unit; cross-field detection masks sibling free text. Unknown authorship/shape is omitted safely, never treated as owner text. Preserve IDs, parents, activeLeaf, seq/newestSeq, paging metadata and known control handles. Never rewrite stored rows/cache objects or owner originals. Request execution still reads the original authority record, not this sanitized display copy.

Existing stored secrets must be absent from paginated, unpaginated, branch, delta, open-card, frame/POST and reconnect serialized outputs. Standalone text (channels, notifications, routines, inbox, memory/artifact text and model-facing results) uses D1–D6 at its actual output boundary; truncation/preview shortening follows sanitization. A structured standalone card is one unit, not unrelated leaf calls. This train closes the known wireThread bypass. This does not claim to rewrite old external backups or inspect raster pixels.

### Native cleanup and UX

**D16 — remove only unreachable machinery.** Remove maskStreamDelta invocation at native.ts:322, its pending/tail/latched maps and private scan/reset helpers, obsolete :316–321 reset call/comment, and imports only used by them. Do not delete shared Markdown whole-sink scanning. Current projection proves the branch unreachable: object delta/event.delta required at :246–265 is discarded at runtime-event-out.ts:378–382,406–433 before the call at native.ts:322.

**D17 — preserve order and containment.** Keep rawChars rejection at :295 ahead of phone/deep/projection work, nativeTraceFrame before remaining redaction, phone withholdStrings, redactSecretsForSinkWalk, page-output scrub, lifecycle redaction with validated UUID restoration, omission/rotation/error containment and encoded UTF-8 rejection at :323–325. Never move scanning before projection or restore discarded trace text.

**D18 — retain recognition and phone bound.** Preserve streamDelta as recognition (rename to streamDeltaShape if clarifying), STREAM_FIELDS wherever that recognition uses it, and carriesStreamState's type:user/raw-delta/event.index exemptions. Rename STREAM_TAIL_THREADS to PHONE_BLOCK_THREADS_MAX = 256 for surviving phone state. Remove LATCHED_MAX only after repository-wide reference inventory, including tests/docs/imports. Current rg inventory found only native.ts:179,187; final builder inventory must be empty after removal. No compatibility export or replacement native latch is allowed.

**D19 — honest native proof.** Existing native absence tests are projection guards. T11 prohibits the removed streaming/tail machinery, not all Markdown scans: surviving allowlisted sink strings still require the sink redactor. Preservation tests plus mutations removing projection or reordering rawChars are sufficient; no fictional new behavioral RED is required for unreachable-code removal. Test both directions, nested tool input/output, unknown payloads, lifecycle and first/subsequent phone blocks.

**D20 — conversation UX and G9.** Redaction is automatic, on by default, with no switch, reveal, prompt or new Settings page. Each contiguous suppressed display region uses one stable `«redacted»` marker keyed by region ID; later chunks and snapshots update/reference that region without appending markers or changing counts. Distinct tool/card regions may each have one marker; a stream of masked deltas must not become a wall of markers. Render no hidden raw text in DOM, accessibility names, title attributes, copy text or serialized client state. Suppressed text is never spoken; replay/completion cannot duplicate speech.

Clean multiline replies appear line by line; the final unterminated line appears at completion. While buffering, existing progress/status remains visible, Stop remains actionable, and a pending approval retains trusted “Allow once”, “Deny” and other actually authorized existing action labels/handles. Model descriptions may be masked without erasing those controls or replacing the execution input. On cancellation no raw partial bubble flashes; terminal status states the outcome. One obvious primary action per view remains; status uses words, not color alone. No capability is removed in Simple or Advanced.

Fable shall inspect the five scenarios (clean multiline, unterminated, cancellation, masking then approval, reconnect) at desktop 1280px and phone 390px, light and dark, in the existing Simple and Advanced contexts. Each check includes keyboard/focus/screen-reader state, stable markers, working progress/Stop, correct approval destination, and no repeated speech. A first-time user must identify status and next action within five seconds. Record the G9 15-task Settings regression check (≤3 clicks or one search), defaults/no-new-control result, zero lost capabilities, 20+ bots/four teams and fresh profile, packaged Mac/Windows/Linux evidence, and Sean's required pre-ship review. This lane owns conversation evidence; the release gate owns the combined Settings/profile/platform evidence. None is waived because no Settings page changed.

## 4. Frozen interfaces and subscriber migration

The following are proposed types, not claims about existing exports. Put public type definitions in server/contracts.ts; keep constructors and admission brands private to server/harness/audience-collector.ts. The policy lives in server/redact-turn.ts. DeepReadonly means callers cannot mutate the handed-off graph; adapters transfer ownership on emission, and consumers needing derived values create separate views. Do not recursively clone enormous execution payloads just to mask display; preserve their immutable owned graph. Type restrictions and mutation-tripwire fixtures enforce this handoff.

```ts
// F1: private capability, never serialized or reconstructed from provider text.
type TurnAdmission = Readonly<{ readonly __turnAdmission: unique symbol }>;
type SourceContext = Readonly<{ admission?: TurnAdmission; attachment: AttachmentCapability }>;
type HostEnvelope = Readonly<{
  eventId: HostEventId; instanceId: HostInstanceId; threadId: HostThreadId;
  generation: HostGeneration; intakeOrdinal: number; createdAt: HostTimestamp;
}>;
// Host* and AttachmentCapability constructors are harness-private.

// F2: scanner/policy seam. Candidate offsets refer to original UTF-16 input.
type ScanResult = Readonly<{
  text: string; detected: boolean; exhausted: boolean;
}>;
interface TurnTextPolicy {
  admit(cap: TurnAdmission): void; // called only after private allocator mint
  consume(cap: TurnAdmission | undefined, batch: ManifestBatch): PolicyDecision;
  reset(cap: TurnAdmission | undefined, stream: HostStreamKey): PolicyDecision;
  finish(cap: TurnAdmission | undefined, how: "complete" | "cancel" | "exit"): PolicyDecision;
  retire(cap: TurnAdmission): void;
}
type TextCarrier = Readonly<{
  path: ManifestPath; stream: HostStreamKey;
  mode: "delta" | "whole" | "snapshot"; text: string;
}>;
type ManifestBatch = Readonly<{
  envelope: HostEnvelope; variant: ManifestVariant;
  carriers: readonly TextCarrier[]; controls: TrustedControlFacts;
  terminal?: "complete" | "cancel" | "exit";
}>;
type SafeTextOperation = Readonly<{
  path: ManifestPath; stream: HostStreamKey; regionId: HostRegionId;
  revision: number; op: "append" | "replace" | "omit";
  text: string; speech: "append" | "none";
}>;
type PolicyDecision = Readonly<{
  masked: boolean; exhausted: boolean;
  operations: readonly SafeTextOperation[];
}>;
// ManifestPath/Variant are the finite M01–M29 schema paths, not arbitrary keys.
// The bounded manifest extractor charges all input before building this batch.

// F3: disjoint execution and audience channels.
type ExecutionEvent = DeepReadonly<RuntimeEvent>;
type AudienceEvent = AudienceRuntimeVariant | AudienceOmitted;
// AudienceRuntimeVariant is a separately declared exhaustive manifest union;
// never Omit<RuntimeEvent, "raw"> plus arbitrary spread.
// It contains safe text, host IDs, validated control facts, optional regionId,
// itemRevision, and speechDisposition: "append" | "none".
type AudienceEmission = Readonly<{
  envelope: HostEnvelope; emissionId: HostEmissionId;
  event: DeepReadonly<AudienceEvent>;
}>;
type IntakeResult = Readonly<{
  execution: ExecutionEvent;
  audience: readonly AudienceEmission[];
}>;
interface AudienceCollector {
  admitNewTurn(host: TrustedSendContext): TurnAdmission;
  intake(event: ExecutionEvent, source: SourceContext | undefined): IntakeResult;
  cancel(cap: TurnAdmission): readonly AudienceEmission[];
  detach(attachment: AttachmentCapability): readonly AudienceEmission[];
}
// intake performs all scanning before returning, including finish+retire on terminal.
// Raw execution exists only on the internal result, never inside AudienceEmission.

// F4: subscribers cannot accidentally consume the wrong projection.
subscribeExecution(listener: (e: ExecutionEvent) => void,
                   options?: { durable?: boolean }): () => void;
subscribeAudience(listener: (e: AudienceEmission) => void,
                  options?: { durable?: boolean }): () => void;
// Remove ambiguous subscribe from application call sites; no raw default.
// F5: immutable output ledger queues audience emissions once, tracks owed listeners,
// bounded item revisions, stable regions and ordered terminal; retry takes no raw input.
// F6: sanitizeBotDisplayMessage(row, trustedRowMetadata) -> copied safe display row.
// F7: redactSecretsInText/ForCard/ForSink signatures stay source-compatible.
// F8: trusted action/option/command handles resolve to original execution records.
```

F8's wire types live in new `shared/audience-wire.ts`, separate from execution QuestionAnswer and EngineCommand. A display option is `{handle, label, description?}`; a display command is `{handle, label, description?, hint?, takesArguments}`. A submitted display action is `{requestHandle, questionHandle?, optionHandles?: readonly string[], action?: "allow" | "deny" | "answer", other?: string}`; a selected command send is `{commandHandle, args, sendId}`. Existing owner-typed command text retains its original path. The server checks authenticated audience/thread, original admission and request lifetime, then resolves handles to the exact original provider request, option labels or command name. Never accept a display label as an execution identifier. Create request/option mappings before publication, bind them to the existing pending request record, and delete them on resolution, timeout, cancellation, teardown or provider replacement. Existing approved reconnect cards reconstruct only from their authoritative pending record; if no live request exists, show unavailable and reject the stale action without forwarding it. No raw value is embedded in a handle, no new secret-retention store is added, and the original adapter request ID is passed unchanged. Tests `execution.handle-roundtrip.unchanged`, `execution.handle-stale-replacement`, `execution.handle-timeout-cleanup`, and `serialized.handle-reconnect` cover all seven drivers and question/permission/command choices.

Intake order is fixed: validate host context/envelope → assign ordinal → inspect bounded manifest and feed deltas → compute complete immutable audience list → enqueue execution separately and audience list once → deliver immediate safe emissions / log safe projection / enqueue durable safe emissions. No raw event is stored in audience queues. The execution queue retains the original payload under existing bounded intake/backpressure controls. Logging failure emits a host-authored fixed warning, never recursively republishes raw data. Execution completion may release resources, but audience queue ordering still flushes safe text before terminal. A transport retry is delivery, not a second intake. A real repeated provider event is a new intake with its captured old generation, never a fresh admission.

Subscriber migration table: anchors are index.ts unless otherwise stated. Test names in the right column are required named cases in server/redact-output-boundaries.test.ts or server/harness/audience-collector.test.ts. Each `execution.<name>.unchanged` asserts deep byte-equivalent arguments, paths, grants and IDs before/after audience masking; each `serialized.<name>` asserts actual emitted bytes, not a helper invocation.

| Existing consumer | Required channel and internal split | Named proof |
|---|---|---|
| :1930 coordination release; :2793 attribution; :6859 image wait; :8221 botCalls completion | Execution lifecycle; no free text leaves here | execution.lifecycle.unchanged |
| :3467 ask_bot reply waiter; :3488 wake subscription; :3510 ticket acceptance | Execution decides acceptance/wake; reply payload comes only from sanitized display ledger | execution.ask-waiter.unchanged; serialized.ask-waiter |
| :8574 dispatch receipt/memory acceptance | Execution receipt/identity; any copied memory/audience text uses safe ledger | execution.dispatch-receipt.unchanged; serialized.memory-dispatch |
| :9207 foldRuntimeEvent, registered :10547 | Split foldRuntimeExecution (accounting, permission, grants, tool scheduling, attachment ingest) and foldRuntimeAudience (speech, display rows, cards, previews); do not mutate either event in place | execution.fold-permission.unchanged; execution.image-ingest.unchanged; serialized.fold; serialized.speech |
| :9556/:9813 watchApprovalRequest and response callbacks | Execution events/handles for liveness, denial, request IDs, filePaths, toolCall, execEnv/mcpMounts; display card uses safe projection plus trusted action labels | execution.approval-watch.unchanged; serialized.approval-card |
| :10971 macFolderPrompt; :10975 following lifecycle handler | Execution for folder/session/turn policy; UI notifications from safe projection | execution.folder-session.unchanged; serialized.folder-session |
| :11149 loopNudge/repeats | Execution for actual calls/repetition policy; safe text for displayed nudge | execution.loop-policy.unchanged; serialized.loop-nudge |
| :11193 queued delegations; :11205 queued sends | Execution completion/cancellation semantics | execution.queue-drain.unchanged |
| :11214 engineCommandCache | Store original validated command execution records privately; safe command view with opaque command handles for menu/cache API | execution.engine-command.unchanged; serialized.engine-commands |
| :12219 steer confirmation | Execution interjection binding and original owner text; display uses safe bot copy, owner text unchanged | execution.steer.unchanged; serialized.steer |
| :17482 limitTurns | Execution accounting and continuation; safe display for offers/notices | execution.limit-continuation.unchanged; serialized.limit-notice |
| :18192 room terminal wake; :18361 matcher; :18626 dispatch boundary; :19728 handshake watcher | Execution identity/terminal state; response summaries/results read audience ledger, never raw completions | execution.room-watchers.unchanged; serialized.room-results |
| :21826 connector/secret/browser resumes | Execution completion and pending original grant/request records; safe generated notices | execution.resume-drains.unchanged; serialized.resume-notice |
| server/harness/memory-adapter.ts:14–27, send wrapper :29–73 | Trusted internal session bookkeeping preserves source context; no user payload export from its raw callback | execution.memory-adapter.unchanged; admission.memory-wrapper |
| server/harness/bus.ts attach sign-in observation :250; sentinel :270 | Execution-only classification/observations; console/log detail uses fixed or sanitized strings | execution.sign-in-observer.unchanged; serialized.bus-warning |
| SSE, transcript frame fanout, speech, canonical log, notification/channel delivery | Audience only; native projection retains stricter behavior; any direct audience adapter.onEvent subscriber is forbidden | serialized.sse; serialized.canonical-log; serialized.no-log; serialized.speech; subscription.inventory |

`subscription.inventory` enumerates all production bus subscriptions and direct adapter.onEvent consumers and compares them to this classification. No new unclassified raw consumer can merge. Execution helpers may inspect secrets for authorization but cannot log or display their inputs directly. Existing phone privacy and audience eligibility filters remain in force on top of sanitized delivery.

## 5. Exhaustive RuntimeEvent carrier manifest and standalone sinks

The manifest is keyed by `(type,itemType)` where applicable, and is a compile-time exhaustive mapping of server/contracts.ts:121–360. Below, **T** means scan as untrusted free text and withhold under a turn latch; **H** means reconstruct only from trusted host authority or a fixed validated enum/finite numeric domain; **X** means execution-only original, absent from audience JSON. Validating a string's shape or field name alone does not prove host provenance. Provider-supplied names/IDs not matched to host records are text or opaque interned handles, never restored by UUID/letters regex alone.

Common envelope for **every row**: provider/instance/thread/generation/event/time are H only from host envelope; provider turnId/itemId/requestId/sessionId/interjectionId become bounded host handles mapped to original execution IDs. Raw.source/raw.payload are X and cannot be serialized on the audience path. Unknown extra properties are omitted without reflecting their names. Each row below defines `manifest.<id>.serialized`: exercise real bus intake and capture immediate/durable/replay SSE JSON, canonical log where persisted, and display/speech where applicable. Plant sentinels separately in every listed text path, all siblings, unknown keys/subtrees and familiar structural names; assert full serialized shape and sentinel absence. No-text rows get forged-envelope and latched-skeleton tests. Every execution-bearing row additionally defines `manifest.<id>.execution-unchanged` against original bytes and types.

| ID | Runtime variant | Exact text paths / structural and execution disposition |
|---|---|---|
| M01 | turn.diagnostic | No T; category exact enum, quietMs finite nonnegative H. Never export unknown diagnostics strings. |
| M02 | session.started | model T unless matched host catalog; sessionId host handle H, replayPending boolean/sessionContract bounded integer H. Raw session ID stays X. Unowned session text MASKED. |
| M03 | turn.subtask | subtask.label and subtasks[].label T; id host handles; status exact started/running/done/failed; timestamps/toolCount bounded H. One label hit masks every sibling label. |
| M04 | session.exited | reason T; terminal H. Sanitize/discard pending then terminal. |
| M05 | turn.started | No T; observation only; never creates CLEAN. |
| M06 | turn.retrying | reason T; attempt/delayMs/maxAttempts finite bounded H. Retry does not re-admit. |
| M07 | turn.completed | stopReason, denials[], toolsUnavailable[] T (host-catalog names may be reconstructed); ok, cost, charge, chargePartial, usage.input/output/cachedInput, mcpReadiness, deniedBy H after validation. Always flush before terminal; do not infer text safety from an enum-like string. |
| M08 | item.started/tool | title, summary, spoken T; input arbitrary subtree uses bounded scanned key/value preview; toolKind/toolIdentity.namespace/name/kind are T unless exact trusted tool catalog identity, then catalog labels H. origin/lateFrame H from trusted adapter; callKey X; actual input/identity X unchanged for execution. |
| M09 | item.started/reasoning | title, summary, input and toolKind/toolIdentity handled as M08; no tool authority synthesized. |
| M10 | item.updated/tool | No T; tokens finite nonnegative H; itemType fixed. |
| M11 | item.updated/reasoning | Same structural treatment as M10. |
| M12 | item.completed/tool | detail T; result recursive preview with scanned keys and values; ok H. Original result remains X for authorized internal processing; any model-facing result crosses its own text boundary. |
| M13 | item.completed/assistant_text | text T; origin host enum, beforeItemId host handle H. Snapshot/speech rules D12. |
| M14 | item.completed/assistant_image | alt T; data X to immutable validated attachment ingestion, never base64 on SSE/log. Audience gets safe attachment handle and sanitized alt. MASKED turn withholds new image display payload/preview too; no claim of pixel scanning. Original attachment handling remains authorized execution/storage. |
| M15 | content.delta/assistant_text | delta T, fed immediately; streamKind fixed H. Zero or more safe line/region emissions. |
| M16 | content.delta/reasoning_text | delta T, same shared latch and scanner; interleaving tests with all carriers. |
| M17 | content.reset/assistant_text | No T; streamKind H; drop assembly, latch before losing unfinished context. |
| M18 | content.reset/reasoning_text | Same as M17, cannot clear another stream's latch. |
| M19 | plan.updated | entries[].content T; status exact pending/in_progress/completed H; unknown entry subtree omitted. |
| M20 | engine.commands | commands[].name, description, hint T. Execution record retains original validated name/arguments X; audience receives host command handle and safe label. A syntactically valid name alone is not trusted display content. |
| M21 | steer.confirmed | interjectionId only as verified host binding H; original X. Unrecognized confirmation cannot mark another request delivered. |
| M22 | question.async | questions[].question/header/options[].label/options[].description T; question/option IDs host handles, multiSelect/allowOther/secret validated booleans H. Original option labels X. Masked question options remain distinct by fixed host “Option 1”, etc. with safe handles; never turn redacted display strings into selected execution labels. |
| M23 | request.opened/permission | tool, summary, choices[], questions[].question/header/options[].label/description, toolInput, reason, toolInputMissing, localHold T if displayed. filePaths[], toolResultDirs[], folderTrust.folder/sources[] display copies T; folderTrust.key/declines[] X except safe host handles. toolKind/toolIdentity catalog rule as M08. requestType/approvalScope/questionTool/toolEngine/commandShell/itemUnseen/callKeyAmbiguous/toolInputTruncated H only from validated authority. toolCall.name/input, execEnv, mcpMounts, callKey and original paths/grant identities X. envInfo.names[], absent[], shell[] and managedEnv[] are T unless reconstructed from a fixed trusted shell form; capture/unread/unchecked.reason/provenance are H only as exact validated authority enums. Unknown nested subtree omitted, never arbitrary restored keys. Trusted permission action labels/handles reconstructed H. |
| M24 | request.opened/question | All M23 fields treated identically; questions/choices remain display-only, original question/option labels bound to host answer handles X. No auto-approval from sanitized descriptions. |
| M25 | request.resolved | decidedBy T unless an exact host decision-rule label; behavior/source/approvalScope/folderTrustLate fixed H; request host handle preserved, original identity X. No raw answers serialized. |
| M26 | thread.token-usage.updated | No T; input/output/cachedInput finite nonnegative H; never infer a turn admission from it. |
| M27 | turn.served-model | routed, requested T unless exact host model-catalog matches. Requested model's actual routing value X unchanged. |
| M28 | runtime.error | message, details, errorKind, engineCode, gatewayCode, localFailureEngine T unless a host-known code selects fixed copy. providerError.providerSaid/providerTeam T; engine/connection.preset T unless host catalog, kind/provider fixed enums, httpStatus/fluxBudget/signIn validated H. diagnostic fields version/diagnosticId/turnId/processGeneration/rpcId/method/rpcCode/httpStatus/terminalKind/observedKind H only after strict schema plus host provenance; otherwise omit diagnostic whole. setup/authRequired/claudeUpdate/localFailure/gatewayResetsAt/limitResetsAt H when trusted/validated; no raw error objects/stack fallback. |
| M29 | unknown variant, unknown nested subtree, arbitrary key | Fixed omission payload without copying type value, keys, values, toString or stack. Bounded known preview maps emit fixed key/value slots after scanning their key strings. No audience raw escape hatch. |

For any complex record not explicitly listed (including future envInfo/error extensions), the unknown-subtree rule applies. For every string listed as potentially H, tests inject secret text under the familiar field name, a well-shaped but unbound ID and a valid host record; only the last may survive as structural data. Human owner messages are not RuntimeEvents and use D15's trusted row-authorship distinction.

Standalone sink manifest: each row is a required actual output test family in server/redact-output-boundaries.test.ts unless a specific test file is named. A sink is not proven merely because it imports a redactor. Parameterize every named site separately; inspect serialized transport bodies, persisted test rows, stdout/stderr capture, spoken input or exported file bytes as appropriate.

| Sink ID and exact source family | Named serialized-output test and unchanged authority proof |
|---|---|
| S01 store.ts:890–944 bot append/patch, removedText, cards/tool/routine/goal/push fields | serialized.store-append; serialized.store-patch; serialized.cross-field-card; execution.store-original-approval.unchanged |
| S02 transcript-page.ts:42 wireThread message/messages/openCards, all index.ts wireThread outputs including :26611–26666,28882,29010,30510,30762–30783,31090 | historical.message; historical.messages; historical.openCards, each × paginated/unpaginated/branch/delta/reconnect/frame/post × numbered/pending/legacy × slim; historical.owner-and-storage-unchanged |
| S03 inbox.ts:56; index.ts channel replies :15436,15491,15552,15634; routines.ts:3242–3244 | serialized.inbox; serialized.channel-15436/15491/15552/15634; serialized.routine-output; serialized.routine-error; execution.routine-input.unchanged |
| S04 index.ts notifications/goal notices :5744–5750,5810–5820,14581,14735 | serialized.notification-5744/5810/14581/14735; title/body/detail/preview scanned before truncation, trusted click action unchanged |
| S05 tool-results.ts:56, bot-to-bot response/room result boundaries | serialized.model-tool-result; serialized.room-results; execution.tool-arguments.unchanged |
| S06 index.ts:9211–9216 and tts/speech-source.ts:66 | serialized.speech.delta; serialized.speech.snapshot; serialized.speech.reconnect; no duplicate audio; retain speech-source guards |
| S07 drivers/pi.ts:237; drivers/acp/core.ts:2388,4616,4773 | serialized.pi-error; serialized.acp-notice-2388/4616/4773, planted Markdown-only secret; execution.driver-command.unchanged |
| S08 index.ts console :10135,10153,10321,14966,20246,20248,28097 | serialized.console-10135/10153/10321/14966/20246/20248/28097; capture actual safe output and fixed exception fallback |
| S09 harness/bus.ts logging/live/no-log/closed-log/immediate/durable/retry | serialized.bus-all-branches; serialized.canonical-log; serialized.sse; execution.bus-original.unchanged |
| S10 drivers/native.ts:285–328 and runtime-event-out.ts | native-projection-contract; native-raw-size-order; native-cleanup-no-dead-stream-scan, actual NDJSON/no-write assertions |
| S11 electron/diagnostics.mjs:485–494 desktop/server tails | diagnostics-md-order-and-suffix in electron/diagnostics.test.mjs; inspect full exported tails before/after line splitting |
| S12 artifacts.ts:40 metadata/title/description fields | serialized.artifact-metadata; execution.artifact-source.unchanged (original file/path/content not overwritten by display redaction) |
| S13 memory/record-write.ts:36, capture.ts:46–53, import.ts:110, consolidate.ts:120 | serialized.memory-record-write/capture/import/consolidate; execution.memory-source.unchanged |
| S14 memory/feedback.ts:613–615, pip-reflect.ts:538, review.ts:449, outcomes.ts:88,344,434 | serialized.memory-feedback/pip-reflect/review/outcomes; execution.memory-policy.unchanged; no before/after equality bypass of scrubbing |
| S15 memory/authority.ts:89,376, bring-in.ts:159, reveal-capture.ts:253, identity.ts:117 | serialized.memory-authority/bring-in/reveal/identity; execution.memory-authority.unchanged; scrub before preview truncation, no original text leaks in rejection |
| S16 auto-approve.ts:370, done-when.ts:20 and doneWhenBriefLine | caller.exact-grant-refusal; caller.done-when-drop; caller.done-when-restored; original authorization checks retained |

`redact-callsite.inventory` inventories production imports/calls of redactSecretsInText, redactSecretsForCard, redactSecretsForSink and new display exits. Every callsite maps to one sink ID or an explicitly execution-only consumer; inventory changes require a new real output fixture. This is a release acceptance check, not permission to silently leave a newly found bypass for another train. Memory/artifact storage, scope eligibility and execution policies remain untouched except where the shared redaction rule intentionally changes their safe text.

## 6. Tests-first acceptance, golden migration, and resource proof

No tests were executed for this design. Builders record exact base/head, run the named behavior tests first and retain assertion-failure RED evidence before implementing. A missing module/import/type failure is not a behavioral RED; seat test adapters against the current raw behavior to expose the leak. Existing machine/native checks are GREEN preservation guards and are labeled honestly. Mutation checks are additional proof, not replacements for real missing-behavior REDs.

| ID | Exact test names / file | Assertions and predicted current-base status |
|---|---|---|
| T1 | `redact-md-user-text.extent-a`, `redact-md-user-text.short-before-return` — server/redact.test.ts | Short wrapped values, blank lines, fences, quotes/escaped quotes, brackets, double backticks, multiline/unterminated values and later labels suppress the entire suffix. RED: no Markdown user-text rule. |
| T2 | `redact-md-user-text.all-labels-and-wraps`, `redact-md-user-text.code-type-exception` — server/redact.test.ts | Unwrapped first label cannot hide wrapped second; prefixed/spaced label, env wrap, indentation, +/-/> and every fixed type word/rejection case. RED for masking rows; caller-specific KEEP and machine parity guards. |
| T3 | `redact-md-caller-contract.plain-colon`, `.numeric-password`, `.count-label`, `.fixed-types`, `.caller-baselines`, `caller.exact-grant-refusal`, `caller.done-when-drop`, `caller.done-when-restored` — server/md-secret-label.test.ts and server/redact.test.ts | Exact D3 literals, equals/multiword/empty controls, both code/plain type guards including token; auto-approve/done-when real functions. `password: 1234` and `password: hunter2` predicted RED; tokens count and ordinary prose guards GREEN. No caller policy workaround. |
| T4 | `redact-md-marker-boundaries.exact`, `.fake-and-suffix`, `.markdown-idempotence`, `.monotonic-secrecy` — server/redact.test.ts | All exact/fake/partial/embedded/suffixed markers, original UTF-16 counts including CR/surrogates. RED for new user-text masking; existing machine/electron behavior guards. |
| T5 | `redact-turn.every-split`, `.one-unit-chunks`, `.empty-label-immediate`, `.reasoning-then-assistant`, `.reasoning-then-tool`, `.cr-equivalence` — server/redact-turn.test.ts | Every two-way split and one-unit chunks of T1/T2 cases, label/separator/whitespace boundaries, 600+ continuation units. Immediate no-LF cross-carrier interleaving; `*\rthe token: alpha beta`, split CRLF, repeated CR whole-versus-stream comparisons. Assert safety after **each** emission, not only final concatenation. RED. |
| T6 | `redact-turn.monotonic-all-carriers`, `.reset-unfinished`, `.cancel-pending`, `.session-exit`, `.late-old-generation`, `.provider-replaced`, `.restart`, `.snapshot-no-restore` — server/redact-turn.test.ts | All M01–M29 after a reasoning/tool/whole-frame hit; every split before interleaving; reset/retry/duplicate-start/tool result never clean; two threads independent; old token cannot bind to replacement. RED. |
| T7 | `redact-turn.pending-64ki`, `.clean-256`, `.streams-64-global4096`, `.empty-id-flood`, `.wide-object`, `.huge-scalar`, `.depth-nodes`, `.detector-failure`, `.no-tombstones`, `.budget-no-second-walk` — server/redact-turn.test.ts | Limit−1/limit/limit+1 for 65,536 pending units, 256 CLEAN admissions, 64 per-turn/4,096 global streams; repeated empty IDs allocate ≤one slot per kind. Wide objects/huge keys/scalars and throwing accessors never trigger unbounded preflight/fallback. Missing admission floods add no registry entries; progress/Stop/terminal survive. RED for new policy limits, existing shared budget guards GREEN. |
| T8 | `admission.synchronous-send`, `.memory-wrapper`, `.all-seven-drivers`, `.old-flush-after-stop`; `collector.immediate-no-log`, `.held-writer-retry-once`, `.terminal-flush-order`, `.synthetic-id-stability`, `.reused-thread`, `.unknown-carrier`; all §4–§5 names — server/harness/audience-collector.test.ts, server/redact-output-boundaries.test.ts | Actual bus serialized bytes, subscriber retries with scanner invocation count unchanged, held writer then latch/terminal, provider replacement and restart, every execution consumer unchanged. RED where currently raw; machine-only guards GREEN. |
| T9 | `diagnostics-md-order-and-suffix` — electron/diagnostics.test.mjs | Both tail exports scrub before splitting; env value `**alpha1234)TAILSECRET9**`, long/fake marker, hostile PEM/KV, multiline. Existing order guards GREEN; any discovered new bypass gets its own honest RED. |
| T10 | `native-projection-contract`, `.phone-first-and-next`, `.lifecycle-uuid` — server/drivers/native-md-stream.test.ts, server/runtime-event-out.test.ts | Both directions, nested/unknown frames, text/thinking/partial_json absent, safe metadata survives. GREEN guards; mutation bypassing nativeTraceFrame must fail. |
| T11 | `native-cleanup-no-dead-stream-scan` — server/drivers/native-md-stream.test.ts | No native streaming scanner/tail-buffer/reset machinery invocation; surviving sink Markdown scanning remains allowed and tested. May pass on base because dead call is unreachable; static removal review plus guards, no fabricated RED. |
| T12 | `native-raw-size-order`, `.stream-exemptions`, `.utf8-byte-limit` — server/drivers/native.test.ts | Oversize rawChars non-state frame omits before projection/getter/deep walk; type:user, streamDelta and index exemptions still track phone; UTF-8 encoded >64KiB is rejected even with smaller character count. GREEN guards; reorder/remove guard mutations fail. |
| T13 | `historical.message`, `.messages`, `.openCards`, `.owner-and-storage-unchanged` and matrix suffixes from S02 — server/transcript-page.test.ts, server/redact-output-boundaries.test.ts | Seed preexisting bot Markdown secrets directly into fixture DB (not via new append scrub); every page/branch/reconnect output safe, originals/owner text/sequence semantics byte-identical. RED: wireThread forwards text today. |
| T14 | `ux.clean-multiline`, `.unterminated`, `.cancel-no-flash`, `.mask-then-approval`, `.reconnect-no-speech`, `.stable-region` — src/components/ChatView.redaction.test.ts, src/components/ApprovalCard.redaction.test.ts | 2 widths × 2 themes × existing mode contexts; progress/Stop/focus remain usable, controls survive masking, no raw DOM/copy/accessibility text or repeated speech. Missing behaviors RED; existing unaffected affordances guards. Packaged/Fable checks supplement these, never claimed from source alone. |
| T15 | `redact-performance.detector`, `.end-to-end`, `.one-unit`, `.many-streams`, `subscription.inventory`, `redact-callsite.inventory`, `manifest.exhaustive`, `golden.move-equality`, `collector-before-user-text` — server/redact-performance.test.ts, server/redact-output-boundaries.test.ts, server/md-secret-label.test.ts | Separate bounded work counters from timings; verify no missing variant/sink/corpus row and activation order. Structural inventories are guards; new policy/ordering behavior RED. |

Shared fixtures go in `shared/testdata/md-secret-label-cases.mjs` with stable case IDs, original input, per-caller expected outputs, sentinels, and prior base outputs. `server/testing/md-secret-label-user-text.base.json` becomes an explicit versioned base/final comparison corpus, rather than silently deleting the proof of changed behavior. Golden row 24 changes only after collector integration and inventory equality; existing machine and speech baselines stay separate.

MOVE LIST from historical L7 (now current L5a): carry the recovered r3.2 ledger :418–489 without dropping a source index. K-L7-01 through K-L7-08 cover respectively plain multiline password, no-separator token, private-key/PEM, unmatched PEM, split SG provider, wrapped PyPI bearer, sk-prefix suffix, and ordinary status. K-L7-LINES/LABELS/TAIL/SHORT/UNION/MARKER/PEM/PROVIDER/OWNER preserve the nine named variant families and audience-policy differences. The historical U1G3+L7 provider-span/registry work must pass these guards on the integrated baseline; a missing protection is repaired within current L5a before text activation. Standalone user text may differ from machine no-separator/multiline/type policy, but complete provider spans may never expose tails.

The 49 original row-24 fixture entries map one-to-one: source index 1–37 → K-24-01–37 (wrapped extent A); 38 → K-24-38 (code type guard); 39 → K-24-39 (wrapped extent A); 40–43 → K-24-40–43 (ordinary prose/code); 44 → K-24-44 (`my_token: x`, new plain mask); 45 → K-24-45 (retained equals); 46 → K-24-46 (retained Bearer); 47 → K-24-47 (fake/suffixed marker); 48 → K-24-48 (retained api_key output); 49 → K-24-49 (wrapped multiline, 14 original suffix units). Resolve original inputs from server/md-secret-label.test.ts ROWS/CORPUS, never use an already-redacted base output as input. Add separate K-PLAIN-NUMBER, K-COUNT, K-PLAIN-TOKEN-TYPE and K-CODE-TYPE-01–12 rows for the later ruling. `golden.move-equality` fails on missing/duplicate source indexes. Retaining the versioned comparison corpus supersedes the old instruction to delete that evidence; it no longer asserts that leaks must remain.

K-REPLAY acceptance: replay available approved owner-text fixtures plus synthetic boundary cases on exact base/final policy, report totals and changes by rule and caller without storing raw credentials. The recovered binding ruling records 0 changed exact-grant commands of 8,761 historical commands and no done_when values available to measure; these are historical evidence, not a result on c12aaad93. Current builders must run actual auto-approve and done-when fixtures, including restored done_when, and report available-corpus limitations honestly. MAIN records the accepted replay outcome before activation. No invented count or global unchanged-caller claim is allowed.

Performance proof: measure detector alone and end-to-end collector/serialization/sink consumers separately. Hostile shapes at 64 and 256 KiB include repeated labels, unmatched PEM headers, `a-` runs, long whitespace, backticks/guillemets/underscores and suffixes. On an idle Hetzner fixture record load/hardware and repeated medians: 256KiB under 250ms and 4× size ratio under 6 for each measured path. Exercise the same logical content in one-unit chunks and many identities, with deterministic operation/allocation counters: each new unit is charged once per bounded pass, limits stop work, no fallback traversal remains. Measure ordinary clean throughput and maximum bounded-state memory separately; no speed claim follows merely from a cap. Timeouts/nonlinear behavior fail and are fixed in this train. Run focused suites, speech/bus/store/card/routine/channel/projection neighbors, typecheck and repository tier checks only during authorized build; this design ran none.

## 7. Review reconciliation and fixed decisions

All required amendments from the current DISAGREE are applied, with no disagreement notes needed:

| Amendment | Closure |
|---|---|
| 1 plain labels/type list | D1/D3, T3, fixed twelve-word list, K-PLAIN/K-COUNT and all 49 golden moves. Later binding ruling wins. |
| 2 incremental latch | D9/D10, T5 immediate empty-value/interleaving/all-split cases; pending carriers suppressed before the next event. |
| 3 identical CR semantics | D10, T5 CR/CRLF/repeated-CR comparisons, T6 reset/cancel/exit. No bare-CR flush. |
| 4 typed collector/mixed fold | §4 F1–F8 and subscriber table; D13/D14; actual execution-unchanged tests. No raw audience field. |
| 5 admission/order/replay | D7/D8/D12, seven capture sites, deterministic IDs, immutable queued result, T8 writer/retry/late/restart/terminal/snapshot cases. |
| 6 exhaustive carriers | M01–M29 plus S01–S16, exact nested text paths, provenance rules and serialized/unchanged-input fixtures. |
| 7 resource limits | D11, T7/T15; 64Ki and 256 CLEAN retained, stream counts bounded, no tombstone allocation or second fallback walk. |
| 8 historical output | D15, S02, T13 at wireThread for all three row fields and all page modes; originals and owner text preserved. |
| 9 UX | D20, T14, stable contiguous-region marker, no duplicate speech, retained action controls, G9/Fable/package evidence. |
| 10 ownership/native/sequencing | P:93 ownership, D14/D16–D19, T10–T12 and final six build slices. STREAM_FIELDS/phone bound/rawChars/UTF-8 retained; all LATCHED_MAX references inventoried. |

Every recovered earlier finding receives an individual disposition below; related rows share tests but are not dropped. These are design closures, not claims that tests passed or reviewers agreed.

| Finding ID (recovered r3.2 §9) | Resolution and proof in this revision |
|---|---|
| A1-r1 PEM body exposed | D1/D2 original-input span preservation; T1 PEM and K-L7-PEM. |
| A2-r1 chained labels | D2 no closer/resume parser; T1/T2. |
| A3-r1 first delta/cross-field/lifecycle | D7 missing admission masked; M01–M29 and T6/T8. |
| A4-r1 quadratic chains | D6/D11 bounded incremental work; T7/T15. |
| A5-r1 overlapping processes | D7 incarnation/attachment/run binding; T8 old-flush/replacement. |
| A6-r1 raw SSE/replay | D12/D13 intake before all branches; T8 serialized.sse/replay. |
| A7-r1 idempotence | D4/D5; T4 Markdown idempotence and monotonic secrecy, no false global fixed point. |
| A8-r1 crash recovery/teardown | D8 old admissions masked; native projection/rotation guard, T10/T12 and T6.restart. |
| A9-r1 contradictory oracles | UTF-16 formulas in D2/D3, original inputs retained in golden corpus; T4 and golden.move-equality. |
| G1-r1 H-SR A/B | Missing/restarted admission masked and native projection discards text; T6.restart/T10. |
| G2-r1 Stop versus reset | D8/D10 separate cancel/discard and reset-before-loss latch; T6. |
| G3-r1 live unredacted reply | Shared intake and all seven driver captures; T8.all-seven-drivers/serialized.sse. |
| G4-r1 path oracle | Display path T versus original execution X in M23/24; T8 full serialized and unchanged-path comparison. |
| G5-r1 count oracle | D2 original UTF-16 counts; T4 exact-output fixtures, never guessed counts. |
| A1-r2 destroyed openers | D1 original-input detection; T2 env and caller-order guards. |
| A2-r2 completions bypass latch | D12 MASKED override/snapshot rules; T6.snapshot-no-restore. |
| A3-r2 stale reset clears other turn | D7 captured generation, D10 reset cannot reopen; T6 late/reset. |
| A4-r2 repair memory | D11 bounded state and retained native bounded-file behavior; T7 and native rotation preservation fixture. |
| G1-r2 closer search | D2 no value closer parser; T1. |
| G2-r2 tool result clears latch | D8 monotonic state; T6 tool-result interleaving. |
| G3-r2 count is 13 | Exact original-input counts are recomputed per literal; D2's specific multiline literal is 14, not a copied old count; T4. |
| A1-r3 completion ownership by counter | D7 admission is authority; D12 whole snapshot; T6/T8. |
| A2-r3 eviction/repeated start | D8 no allocation by observation/no tombstones; T7.no-tombstones through repeated start and late completion. |
| A3-r3 native-first drops live head | One audience scan at intake; native keeps stricter text-free projection and consumes no turn scanner; T8/T10. |
| A4-r3 oracle contradictions | T4/golden comparison; native tests assert projected bytes actually produced on this base. |
| G-H1 whole frame never opens | D9 batch inspection, M08/M12/M13/M23; T6/T8 non-delta same-frame secrets. |
| G-H2 completion ownership | D7/D12, T6.snapshot-no-restore. |
| G-M1 reset deletes unfinished label | D10 latches before discard; T6.reset-unfinished including repeated resets. |
| G-M2 marker-count oracle | D20 stable region, D2 standalone exact count; T4/T14, separate sink expectations. |
| G-M3 tools/plan payload raw | M08–M12/M19/M23/M24; serialized fixture for each text field/key. |
| G-M4 gates scan twice | D12 once-per-intake immutable result; T8.held-writer-retry-once. |
| G-M5 only Claude tagged | D7 seven concrete capture sites; admission.all-seven-drivers and old-flush-after-stop. |
| G-L1 restore arbitrary type | Manifest H provenance, M29 unknown skeleton; forged familiar-field tests. |
| G-L2 last-byte guard before rotation | Preserve current bounded native write/rotation contract; T10 mutation/rotation fixture checks the final append target, not a rotated predecessor. |
| G-L3 keep versus refresh | Observed start neither allocates nor changes secrecy; no LRU clean reopening; T7.no-tombstones. |
| G-L4 same-id relaunch after end | Fresh harness generation required; old token remains masked even if provider reuses ID; T8.reused-thread. |
| G-L5 stale citations | Current code anchors in §2 and original indexed golden mapping in §6; no historical line number treated as current code. |
| A32-H1 (r31 #1) forgotten ID can reopen | D7/D8 private allocation, no retired table; T7.no-tombstones + T6 restart/reload/repeated-start/exit. |
| A32-H2 (r31 #2) payload under familiar keys | M01–M29 exact field/provenance rules, no arbitrary key restoration; every manifest serialized test includes forged keys/IDs. |
| A32-M1 (r31 #3) reset loses history | D10 conservative latch-before-discard; repeated reset/continuation tests T6. |
| A32-M2 (r31 #4) callback/active intake gaps | D7 named seven driver captures, memory wrapper and async flush ownership; T8 all-seven/old-flush. |
| A32-M3 (r31 #5) transforms after admission | D6 transformed audience text enters collector before emission; Pi pending/flush closures use same intake and original token; T8 old-flush plus transformed-label fixture. |
| A32-M4 (r31 #6) projection serialized twice/wrong | F3/F5 separate graph/queue, stable IDs, no raw and no rescanning; T8 full JSON equality, not sentinel-only. |
| A32-L1 (r31 #7) rotation fixture wrong | Native preservation fixture checks rotation and final destination with exact size boundaries; guard status recorded, no new behavior claimed. |

The two early BLOCK summaries' additional named examples are retained: pass-1 nested labels/backtick closer/escaped quotes/punctuation → T1/T2; fake markers → T4; multiline/blank/Word lines → T1/T6; env ordering → T2/T9; scan clocks → T15. Pass-2 H1 first unwrapped match and H2 spaced/prefixed label → T2; H3 blank/Word-line endings → D2/T1; H4 512-tail/cap/reset → D8–D11/T5–T7; H5 caller-wide quadratic claim → separately measured T15 with same-train fixes if needed. Caller-specific KEEP, `+` wrap and cap±1 → T2/T3/T7. Recovered Fable fresh design H-UT/H-SR and pass-3 escaped-quote/blank-value/chained-empty/window-overflow/outward-delivery concerns → D1/D2/D7–D15 with T1/T5–T8/T13. All arbitrary “8-line” or “512-character tail” safe-ending assumptions are rejected.

The additionally inspected H/_reviews/D-REDACT-MD-astra-r32.md findings are also individually closed: #1 arbitrary property-name leak → D11/M29 key-position serialized tests; #2 permission becomes question → M23–M25 exact trusted enums and execution.fold-permission.unchanged; #3 opaque ID response/cleanup gap → F8 round-trip/lifetime tests; #4 universal driver streaming oracle → admission.all-seven-drivers uses actual Antigravity `result.response` whole frames, boxagent cumulative snapshots, and split-delta/head expectations only for actual delta paths, each with clean controls; #5 absent turn.started mistaken for absent allocation → admission.synchronous-send explicitly permits a valid admitted clean turn before its start event, while the missing-admission test uses a never-allocated token. Native projection expectations are kept separate from live-prefix expectations.

The review's nine open-question answers are adopted as final decisions:

1. Missing review text is a build gate; recover/identify the exact Fable artifact and reconcile by finding before building (§1). Early summaries are insufficient.
2. Accept end-of-unit and monotonic turn over-masking; preserve controls and execution separately (D2/D14/D20).
3. Require the collector before user-text activation, owned by historical U1G3+L7 **within current L5a**, never current ENGINES-ACP lane L7 (D14).
4. Accept completed-line presentation with immediate incremental detection; progress/Stop/approval remain usable (D10/D20).
5. Scrub historical bot display copies in this train; never rewrite original history (D15).
6. Require monotonic secrecy and Markdown idempotence; preserve other caller expectations unless an explicit new rule changes them (D3/D5).
7. Require separate detector/end-to-end measurements and bounded exhaustion without rescanning the remaining payload (D11/T15).
8. Accept native preservation and deliberate mutations; no genuine new behavioral RED for unreachable removal (D19/T10–T12).
9. Require independent Astra, Fable UX and recorded file-reading Grok unless MAIN explicitly supersedes the latter (§1/D20).

There are no unanswered design questions. Remaining risks are acceptance gates with fixed remedies: exact historical evidence identity must be established; performance failures are fixed before merge; conservative masking/latency must pass Fable's specified UX scenarios; subscriber or sink inventory additions require classification and real output tests; replay effects require MAIN's recorded acceptance. This document starts no review agents or builders and grants no implementation authorization.

## 8. Ordered build slices to seat in parallel

Estimate: 9–12 focused builder-sessions including collector/driver migration, complete historical/standalone boundaries, security/UX evidence and review fixes; native cleanup remains S, about half a session. The original M+S estimate did not include the now-explicit collector, historical output and exhaustive proof. Do not cut scope to meet that estimate. All files below are relative to B; new filenames are marked `(new)`. A slice owns only its listed files. Shared files have one owner at a time; dependent consumers code against F1–F8, not parallel edits to another owner's file. There is no delegation into current lane L7.

**0. Review and interface freeze — no product code.** MAIN seats independent Astra, file-reading Grok and Fable, resolves the evidence identity gate and accepts the §6 replay plan. Freeze D1–D20, F1–F8, M01–M29/S01–S16 and the corpus IDs on this revision. Review packet files are this lane's DESIGN-r2.md and lane-local evidence/reconciliation records only. This is not a substitute for subsequent REDs or packaged UX proof.

**1. Wave 1A — shared detector and turn policy, M–L, 2–3 sessions; parallel with 1B.**

* Exact production files: `shared/md-secret-label.mjs`, `shared/md-secret-label.d.mts`, `server/redact-turn.ts` (new).
* Exact fixture/test files: `shared/testdata/md-secret-label-cases.mjs` (new if absent), `server/redact-turn.test.ts` (new), `server/redact-performance.test.ts` (new).
* Depends on frozen F1 admission capability shape, F2 scanner/policy seam and budget constants, D1–D12, manifest batching/stream keys. The vocabulary stays shared; historical provider/registry compatibility cases are part of this owner, not an orphan. Preserve machine/speech exports.
* RED first: T5 every-split/one-unit/empty-label-immediate/reasoning-then-assistant/reasoning-then-tool/cr-equivalence; T6 monotonic/reset/cancel/exit/restart/snapshot; T7 all bounds/flood/failure cases; plain-colon/numeric-password candidate behavior and all type words in shared corpus. Existing machine/speech guards run alongside, clearly GREEN on base where applicable. T15 detector/one-unit counters precede tuning.
* Freeze the implementation of F2 for 1B integration; do not activate server/redact.ts user policy in this wave.

**2. Wave 1B — collector and execution/audience separation, L, 3–4 sessions; parallel with 1A, then integrate together.**

* Exact production files: `server/contracts.ts`, `shared/audience-wire.ts` (new), `server/harness/bus.ts`, `server/harness/audience-collector.ts` (new), `server/harness/memory-adapter.ts`, `server/index.ts`, `server/drivers/claude.ts`, `server/drivers/codex.ts`, `server/drivers/pi.ts`, `server/drivers/acp/core.ts`, `server/drivers/antigravity.ts`, `server/drivers/boxagent.ts`, `server/drivers/openai-chat.ts`.
* Exact test files: `server/harness/bus.test.ts`, `server/harness/audience-collector.test.ts` (new), `server/redact-output-boundaries.test.ts` (new).
* Depends on frozen F1/F2/F3/F4/F5/F8, exhaustive manifest and D7–D14. Own all index.ts changes in this wave. Capture out-of-band admissions at every named send/callback/flush, split fold internally, migrate all subscribers, create sanitized command/option handle views, and preserve immutable original execution. Driver tests use fake engine fixtures in the new collector suite; no live services.
* RED first: admission.synchronous-send/memory-wrapper/all-seven-drivers/old-flush-after-stop; collector.immediate-no-log/held-writer-retry-once/terminal-flush-order/synthetic-id-stability/reused-thread/unknown-carrier; every manifest serialized case and execution-unchanged case; execution.fold-permission.unchanged, execution.handle-roundtrip.unchanged, execution.handle-stale-replacement, execution.handle-timeout-cleanup, serialized.handle-reconnect and all §4 unchanged-input names. Guards that already pass stay labeled guards.
* Merge 1A+1B only after actual writer/replay/terminal/late-event and machine/speech checks pass. This is the mandatory collector-first integration checkpoint. No raw interim path is accepted as a completion shortcut.

**3. Wave 2A — activate whole-text policy and caller contract, M, 1 session; after Wave 1 integration, parallel with 2B.**

* Exact production file: `server/redact.ts`.
* Exact test/fixture files: `server/redact.test.ts`, `server/md-secret-label.test.ts`, `server/testing/md-secret-label-user-text.base.json`.
* Depends on frozen F2/F7 and integrated collector F3–F5; D1–D6; fixed golden source-index mapping and type list. Consume shared candidates rather than copy regexes. Retain caller-specific machine/provider/speech behavior; migrate row 24 to explicit base/final assertions. auto-approve/done-when are exercised through their real functions without changing their policy files.
* RED first: T1–T4, especially short wrapped values, password numeric/short plain values, code-secret versus type guard, fake/suffixed marker and original-input ordering. `golden.move-equality`, caller.exact-grant-refusal/caller.done-when-drop/caller.done-when-restored and collector-before-user-text block activation. Record K-REPLAY evidence; no invented historical count is reused as current proof.

**4. Wave 2B — transcript and standalone display boundaries, M–L, 1.5–2 sessions; after Wave 1, parallel with 2A.**

* Exact production files: `server/transcript-page.ts`, `server/store.ts`, `server/inbox.ts`, `server/tool-results.ts`, `server/routines.ts`, `server/artifacts.ts`, `server/index.ts`, `server/memory/record-write.ts`, `server/memory/capture.ts`, `server/memory/import.ts`, `server/memory/consolidate.ts`, `server/memory/feedback.ts`, `server/memory/pip-reflect.ts`, `server/memory/review.ts`, `server/memory/outcomes.ts`, `server/memory/authority.ts`, `server/memory/bring-in.ts`, `server/memory/reveal-capture.ts`, `server/memory/identity.ts`.
* Exact test files: `server/transcript-page.test.ts`, `server/redact-output-boundaries.test.ts` (ownership transfers from 1B).
* Depends on frozen F3/F5/F6/F7/F8 and integrated Wave 1; codes to F7 while 2A implements it. index.ts ownership transfers from 1B to this slice; 2A never edits it. Sites already correctly routed need only integration proof; edits are limited to boundary, cross-field, order and bypass fixes, with every listed site still tested.
* RED first: T13 historical.message/messages/openCards across every S02 route/mode, cross-field cards, S03–S08 channels/routines/notifications/model results, S12–S15 memory/artifact outputs and truncation order. `historical.owner-and-storage-unchanged` and all execution-original tests are guards. Use seeded old rows to expose the real historical bypass. Merge 2A+2B and prove the complete text-rule family before cleanup.

**5. Wave 3A — native dead-mask cleanup, S, 0.5 session; after Wave 2 integration, parallel with 3B.**

* Exact production file: `server/drivers/native.ts`.
* Exact test files: `server/drivers/native-md-stream.test.ts`, `server/drivers/native.test.ts`, `server/runtime-event-out.test.ts`.
* Depends on F7 machine-sink compatibility, integrated audience policy, and D16–D19 projection/order contract. Inventory all repository LATCHED_MAX references before removing it; current inventory has only the two native.ts references. Preserve streamDelta recognition, required STREAM_FIELDS, PHONE_BLOCK_THREADS_MAX=256, rawChars-first ordering, lifecycle UUIDs and UTF-8 bound. Remove no shared whole-text sink scanner.
* Tests first: T10 native-projection-contract/phone-first-and-next/lifecycle-uuid; T11 native-cleanup-no-dead-stream-scan; T12 native-raw-size-order/stream-exemptions/utf8-byte-limit. These are preservation guards, not genuine new base REDs. Mutations bypassing projection and reordering rawChars must fail. Include rotation/final-append-target preservation and report removed unreachable code separately from behavior proof.

**6. Wave 3B — complete sink/UX proof and registration, M, 1–1.5 sessions; parallel with 3A, finish on their combined head.**

* Exact test files: `server/redact-output-boundaries.test.ts` (ownership transfers from 2B), `server/redact-performance.test.ts` (from 1A), `electron/diagnostics.test.mjs`, `src/components/ChatView.redaction.test.ts` (new), `src/components/ApprovalCard.redaction.test.ts` (new).
* Exact UI files for required region/handle/rendering support: `src/state/store.tsx`, `src/components/ChatView.tsx`, `src/components/ApprovalCard.tsx`, `src/components/QuestionCard.tsx`, `src/components/OptionCard.tsx`, `src/components/Composer.tsx`, `src/components/EnginesSettings.tsx`, `src/lib/engine-commands-menu.ts`. Consume F8 display types from the already frozen shared/audience-wire.ts without changing execution QuestionAnswer/EngineCommand. Store dispatch and composer send safe handles, not masked labels; stream state folds stable regions once. Existing unaffected helpers are reused; no Settings control is added.
* Exact registration files: `ci/gate-tests.txt`, `ci/extended-tests.txt`; every new Vitest suite is in exactly one list, release-critical behavior remains blocking, performance tagged per existing scripts/ci-test-tiers.mjs rules. Preserve the Electron test runner registration already used by diagnostics.
* Depends on all frozen interfaces, D20 G9 scenarios, the complete carrier/sink matrices and Wave 2 integrated behavior. No overlap with native 3A files. The collector's stable region IDs, trusted action handles and speech dispositions are consumed without client-side secret re-parsing.
* RED first where missing: T14 ux.clean-multiline/unterminated/cancel-no-flash/mask-then-approval/reconnect-no-speech/stable-region and actual serialized speech/cancellation/approval/reconnect cases; diagnostics T9 remains a guard. Finish M01–M29/S01–S16 output proofs, subscription/callsite inventories, T15 detector/end-to-end/one-unit/many-stream measurements and unchanged-execution coverage. Run focused and required repository checks on combined head, obtain independent Astra/security review, Fable UX proof and packaged G9 evidence before declaring the full lane complete.
