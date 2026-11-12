# Customer busy-loop boundary fix (cfix-busyA22)

Baseline: `3110d04b555525de9e77e73b21c3ec88eef45e52`, branch
`dev/1019-busyloop`. The reference remains A2.2: Python SHA-256
`d38a0661457f97406a86ce0c2d3a67cac0b0affd2f2de5d3223ede9c5d27b84e`,
126-row TSV SHA-256
`951a3b878684280577a8f18b1563911e7f283198eee672322e1e6ab849829ba4`.
Neither reference file nor any existing expectation was changed.

The review found that otherwise correct decisions were lost before reaching
retry and room-goal dispatch logic. `fluxResponseDecision` is now the shared
entry for HTTP envelopes, parsed SSE/JSON bodies, ACP upstream projections and
Claude error text. Nested Codex CLI envelopes and headless result frames also
reach that entry before retries or schema recovery. HTTP boundaries inspect responses before redirects, tool
recovery, catalog fallback or output validation. A bounded JSON reader scans
past long diagnostic strings, retains their containing structure and subsequent
fields, and fails closed on resource/read limits. Fetch's comma-combined hold
headers retain every code; the spec's ordered terminal rules choose the result.
Equal duplicate waits collapse; differing valid waits use the longest delay.

Stream errors preserve partial output and the decision. A non-PASS decision
precedes tool repair, so a `tool_use_failed` plus `batch_rate` waits 60 seconds.
Retries default to scale 1 when a decision prescribes them. ACP prompt results
are inspected even without a retry notice and even with `end_turn`. The room
subscriber latches terminal decisions before considering memory redispatch or
successful completion, and the goal loop checks the decision before retrying.
Both reflection transports expose terminal decisions without labeling them
transient; a terminal headless frame also stops its isolated child and prevents
a schema retry. Codex carries the decision into its retry guard and runtime
events, and closes a turn on a terminal error notice. Configurable catalog probes and the shared driver memory transport
use the same HTTP entry.

`server/__fixtures__/flux-refusals/review-a22/expected.tsv` adds 14 witnesses.
`scripts/busyloop-review-fixtures.py` obtains their verdicts from the unchanged
Python reference and refuses to rewrite existing data. The combined/conflicting
header row uses the terminal normalized dictionary value for the reference's
single-value header interface; its raw fixture retains the combined wire value.
The original 126 rows remain directly loaded by the parity suites.

On the baseline, 10 review cases failed and the four 402 budget variants passed.
Each of the seven review findings has a behavioral RED. The four added 402
cases cover `key_budget_reached` and `free_tier_exhausted`, with and without a
hold header; each stops after one POST. A separate baseline replay of both ACP
room-goal cases observed two dispatches, while the fixed workflow observes one.
The fixture uses `launchVerificationServer`, an isolated data directory and a
fake engine. It never contacts a live model or the user's app.

`scripts/busyloop-sites.mjs` enumerates executable driver fetch sites, including
injected and aliased fetches, the shared memory socket and parsed payload
boundaries. Each HTTP response must enter the classifier before the next
response-handling statement. Payload adapters are checked by their actual input
expression. Explicit non-model control endpoints carry pinned source hashes, so
a destination change requires another review. Tests remove each entry while
leaving imports intact, and add a new aliased Flux fetch; these mutations must
make the structural check RED. `scripts/busyloop-review-mutants.py` additionally
executes ten behavioral boundary mutations, including nested CLI envelopes,
Codex retry guards and headless frame observation. Mutations run in a disposable
source copy and cannot alter the concurrently validating checkout.

All verification runs use `/work/fuigo-builds/tools/it-remote.sh`,
`IT_JOB=cfix-busyA22`, the supplied worktree and local-wrapper fallback, with at
most two offline containers. Reproduction commands are in
`scripts/busyloop-review-validate.sh`, `scripts/busyloop-review-red.py` and
`scripts/busyloop-isolated-mutants.py`. Evidence is retained under
`evidence/cfix-busyA22/`: baseline RED logs, parity and neighbor logs, the site
inventory, mutation results and workflow launch/action/message/request-count
records. Baseline source snapshots are evidence only and are not committed.

Final evidence: the transport run passed 447 tests; the raw nested CLI adapter
also matched all 49 response-endpoint reference rows (348 parity tests total).
The complete OpenAI, Fuigo and Codex suites passed 468 tests. The complete
headless suite passed 56 tests. Both fresh room-goal replays passed with exactly
one session and one prompt. The initial neighbor sweep exposed seven regressions
in diagnostic clipping and legacy refusal metadata; these were repaired and all
three affected suites were rerun in full.

The inventory contains 31 sites: six Flux-capable HTTP sites, fourteen payload
boundaries and eleven pinned non-model control sites. All twenty classifier-entry
removal mutants go RED, as does an added unclassified aliased socket. All ten
behavioral boundary mutants and all four required TypeScript port mutants were
killed. The unchanged Python reference checker reports 126 rows, zero parity
mismatches, 25 traces and 24/24 reference mutants killed. Its target-654 artifact
is absent in the supplied baseline, so these results do not claim that separate
artifact's acceptance.

The Codex terminal-notification close is recorded in the existing stop-gate close
handler inventory: it synchronously latches settlement and closes the existing
process through cleanup; it cannot launch another turn. Client/server types and
the CI test-tier inventory are checked separately from behavioral tests.

The final stop-gate, nested CLI parity and CLI adapter run passed all 467 tests
(109 stop-gate, 348 parity, 10 CLI). Final server type checking passed; client
type checking and test-tier inventory also passed.
