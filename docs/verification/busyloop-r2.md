# Busy-loop MAIN R1/R2 (cfix2-busyA22)

Baseline: `b796fbc9f143f407b37e3159cfc5c24729733a5d`, verified against
`/work/mb-105-git.git` before edits. Binding inputs: crev2-busyA22 BLOCK,
MAIN-NOTE-r2.txt, MAIN-NOTE.txt, and the unchanged A2.2 executable specification
(`d38a0661…`) and TSV (`951a3b87…`).

`shared/flux-route.ts` is the single Flux destination decision. It receives the
request URL, retains it unchanged for the transport, and reports whether its
HTTP(S) hostname is `fluxrouter.ai` or a subdomain. Presets, provider names,
models and credentials do not enter that decision. The existing `isFluxUrl`
API delegates to it. Codex and Claude budget routes, ACP refusal handling,
HTTP chat/text readers and headless frame handling use its result. CLI prompt
markers carry the configured request URL; Claude's retained session keeps that
URL for steering writes as well as initial turns.

The inventory parses every production TypeScript/JavaScript source under
`server` and `shared`. HTTP calls (including injected and aliased fetches), model
RPC/prompt constructions, and typed CLI request markers must pass their URL
through `fluxRouteFor`. Conversation HTTP calls also retain the immediate
`inspectFluxResponse` guard. Its scope argument must resolve to the shared URL
decision, rather than an unconditional boolean or a preset predicate.

Payload entries are discovered from classifier calls and JSON decode syntax.
`registerBusyloopPayloadSite` is a typed identity wrapper: `read` identifies a
raw decode and `classify` identifies the adapter boundary. The AST checks the
surrounding call, so deleting a marker, deleting a classifier while retaining
its marker, or adding an unmarked decode fails verification. There is no list
of payload filenames, arguments or counts that supplies inventory entries.
Non-model services and local persistence sources have explicit source hashes;
changing one requires reviewing its exclusion again. Raw decode counts include
configuration/catalog reads and are reported separately from refusal boundaries.

RED-first evidence is `evidence/cfix2-busyA22/red.log`: the exact custom OpenAI
Responses route failed to attach STOP and made three `turn/start` calls; the
request-route and payload-inventory requirements failed their assertions.
The first corrected behavioral run passed 309 tests, including the full Codex
and headless suites. Subsequent verification includes added prompt-write markers
and URL-only scope cases, not just that intermediate run.

Run tests only through `/work/fuigo-builds/tools/it-remote.sh`, with
`IT_JOB=cfix2-busyA22`, the busyloop worktree and the supplied local fallback.
`scripts/busyloop-r2-validate.sh` runs the complete busy-loop, neighboring,
workflow, stop-gate, type and tier checks. `scripts/busyloop-r2-mutants.py` runs
R1/R2 mutants and every retained boundary/port mutant in a disposable source
copy; it restores mutated files byte-for-byte and retains assertion logs.
No live app or provider is contacted. Workflow tests launch fresh isolated
verification servers. Four Flux 402 fixtures record STOP and the POST count in
`evidence/cfix2-busyA22/workflows/flux-402/`.

The reference checker must receive `server/__fixtures__/flux-refusals/prod-00000000`
as its fixture directory. Passing its parent directory finds no leaves and is
not valid parity evidence. The supplied corpus has no `target-654` artifact;
this verification covers the pinned current corpus, as in the prior verdict.

Final evidence is in `evidence/cfix2-busyA22/final-report.json`. The completed
13-file driver sweep has 1,483 passing cases and two existing skips, combining
the original sweep with the corrected affected-suite rerun (572 passes, two
skips). The pinned port/transport run passed 509 cases; the closing run passed
380 cases, including every transport row, all current structural tests, the
native ACP model-override witnesses and the background request sites. Six
fresh-server workflow tests and 80 neighboring tests passed. Server, client
and stream-conformance types and test-tier checks passed. All 109 stop-gate
checks passed after refreshing the expression fingerprints of the synchronous
identity markers; no new stop-gate exemption was added. All 42 shared Flux
header behavior and lint tests also passed; the lint records why local probes,
catalog discovery and CDP/control code do not send Flux model turns.

The four 402 records each contain STOP and exactly one POST. The Python
reference reports zero mismatches and 24/24 mutants killed. All 44 required
implementation mutants are RED (nine R1/R2, ten boundary, 23 table/port, reset
projection and B8 guard). Per-site structural removals are also RED: 42 URL
routes, 28 classifier entries and 161 payload markers (231 total). The native
ACP provider-default/model-override witness was additionally RED against the
aggregate-URL predicate and GREEN with the selected model URL.

The inventory has **280 distinct AST sites**: 42 URL/request sites, 22 payload
adapter boundaries, 139 raw decodes and 77 non-model sockets. Six HTTP guard
checks overlap request sites, producing 286 inventory entries. Background
model calls include transcription, dictation cleanup and local model probes.
The [complete per-source counts](busyloop-r2-sites.tsv) are generated from the
AST result and are not an input to verification.

| Driver source | Distinct sites | URL/request | Payload adapters | Raw decodes |
|---|---:|---:|---:|---:|
| `codex.ts` | 7 | 2 | 3 | 2 |
| `claude.ts` | 18 | 6 | 1 | 11 |
| `openai-chat.ts` | 11 | 1 | 3 | 7 |
| `http-text-only.ts` | 4 | 1 | 0 | 3 |
| `headless-text-only.ts` | 7 | 4 | 2 | 1 |
| `acp/core.ts` | 10 | 3 | 3 | 4 |

Earlier failing logs are retained. They include the original RED witnesses,
the reference command initially pointed at the parent fixture directory,
obsolete preset-based fixture URLs, the temporary unsupported synthetic driver
name in the new scope test, and stale stop-gate expression fingerprints. The
final report points to the successful rechecks, rather than treating those
intermediate runs as acceptance evidence.
