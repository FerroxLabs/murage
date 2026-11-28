# L5a Slice 0: review packet and interface freeze

Job `l5ar0`, base `c12aaad9341e8f87126a193f35b5c2768f0aa66f`, branch `dev/1019-l5ar0`.
This slice changes documentation only. It does not implement the collector,
policy, wire types or any other slice's product/test files.

Start with [the consolidated design](DESIGN-r2.md). It retains D1–D20,
F1–F8, M01–M29, S01–S16, the corpus mapping and individual historical
finding dispositions; applies the binding R1–R5 changes; and adds S17.
The [binding ruling](sources/RULING-l5a-1019.md) wins any transcription
conflict. [The original design](sources/DESIGN-r2.original.md) is preserved
byte for byte. Historical documents are evidence, not competing contracts.

[Evidence manifest](evidence-manifest.json) records the original location,
SHA-256 and byte count for every copied source. [GATES.md](GATES.md) records
what is established and what MAIN still has to attach. A frozen contract is
not a test result, reviewer agreement or release approval.

## Contract ownership

| Contract | Frozen definition | Implementation owner |
|---|---|---|
| F1 | Private TurnAdmission/AttachmentCapability, SourceContext and HostEnvelope; harness admission before synchronous sends; no provider-created authority | 1B contracts/collector/drivers |
| F2 | TurnTextPolicy, ScanResult, TextCarrier, ManifestBatch, SafeTextOperation, PolicyDecision; original UTF-16 offsets and D11 budgets | 1A policy; 1B extracts the manifest |
| F3 | Original immutable ExecutionEvent graph, separate AudienceEvent/Emission, IntakeResult, AudienceCollector; zero-or-more audience emissions | 1B |
| F4 | subscribeExecution / subscribeAudience, optional durable flag; no ambiguous raw default | 1B bus |
| F5 | Once-at-intake immutable audience ledger, owed subscribers, stable regions/revisions, terminal ordering and retry without rescanning | 1B |
| F6 | sanitizeBotDisplayMessage(row, trustedRowMetadata), copy-only historical display boundary preserving owner originals | 2B |
| F7 | Source-compatible redactSecretsInText / ForCard / ForSink signatures; shared original-input policy before destructive transforms | 2A and 2B; 3A consumes machine compatibility |
| F8 | R1 DisplayAnswer[] / discriminated DisplayAction and pure resolveDisplayAction; R2 permission, stored-question and cache-command lifetimes | 1B shared/audience-wire.ts and server; 1C read-only consumer |
| R4 | EventCharge, boundedEventCharge(event, budget?), CHARGE_BUDGET_UNITS=1,048,576, OVERSIZE_CHARGE_BYTES=8 MiB; private WeakMap, descriptor-only accounting, 256-event/1-MiB control reserve | 1B event-charge/collector/bus |

No replacement runtime declarations or provisional implementation are introduced
by Slice 0. The frozen design deliberately leaves private representations to
the named implementation owners. Missing concrete exports remain their work;
a documentation freeze must not preempt their files with stubs.

## Review amendment disposition

| Latest review item | Binding correction | Required evidence owner |
|---|---|---|
| Four-question capability lost | R1 atomic answer array, exact stored IDs/labels and stored selection order, zero side effects on invalid input | 1B R1 REDs; 1C atomic submission |
| Async/late questions and cached commands lost | R2 three lifetimes, original authorization and exactly-once paths retained | 1B R2 REDs; 1C reconnect/late answer |
| Setup-check bypass/subscriber omissions | R3 raw classification, whole raw sink redaction before engineLine, S17 and three subscriber sites | 2B R3 REDs; 3B inventory completion |
| Unbounded execution serialization | R4 bounded descriptor accounting, original execution identity, oversize backpressure and terminal reserve | 1B R4 REDs |
| UI migrated too late | R5 1C runs with 1A/1B; combined Wave 1 checkpoint before Wave 2 | 1A/1B/1C integrator |

All ten first-review amendments and recovered historical finding IDs retain
their individual disposition in consolidated design §7. Those dispositions
are design closures, not runtime verification. All R1–R4 named tests remain
in the consolidated contract and the exact ruling source.

## Scope and reference reuse

The supplied HighLevel source notes (hl-amend.md, hl-refs.md) were removed with the HighLevel leftovers in 1.0.24; they remain in git history.
The HighLevel S0 manifest/registry is a different slice from L5a Slice 0;
no HighLevel API, family or UI files are changed here. The HighLevel rules
remain binding on their own lane. No provider operation was researched,
qualified or declared absent by this packet.

Reused the supplied L5a design, ruling, both lane reviews, the recovered
Fable/r1 design and reviews, r3.2 design and reviews, and binding plain-label
rulings. Exact copies and hashes replace paraphrased evidence. No upstream
HighLevel implementation is relevant to this documentation-only L5a freeze.

## Test scope

Slice 0 lists no behavioral RED-first tests and explicitly owns no product
code. RED/GREEN for new behavior is therefore **not applicable**, not claimed
as passed. No new test file is introduced, so there is no new
`ci/gate-tests.txt` row. Existing release workflow/tier, redaction, speech and
bus guards plus typecheck run in the required container path; the full run
is queued only after push. Job-local DONE contains actual results and the
base-relative NEW count. The full-run result cannot close the review gates.
