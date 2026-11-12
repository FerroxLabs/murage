# BLD3 No limits replay preparation

This job started at `0630ff8893982468b5d5a15201aa34ad05c02f69` on
`dev/1019-bld-nolimreplay`. Both branch and hub tip matched. No Mac access,
live app mutations, external messaging, real credential handling or billable service
was used. The memory prelude tool and `.ijfw/memory` were unavailable.

The database schema cannot fulfill the proposed original-envelope recovery:
`messages` has display cards (sometimes bounded/redacted JSON tool input),
not generally faithful typed permission envelopes; runtime raw
frames are deliberately excluded from persisted events. The census lacks
original timestamps and request/thread/message IDs, and bot aliases are salted.
`MAC-SELECT.md` and the fixed SELECT document an exact-key, bounded read for MAIN
and Sean to review, but no valid 120-key allowlist exists here. The query
returns NULL arguments and NULL runtime marks rather than reconstructing them
from display prose. No SQLite query can recover fields never persisted.
MAIN's decision #3 still needs a retained original-envelope source.

`extract.py ingest-store` accepts the SELECT shape, enforces exact joins and
independent redaction receipts, retains a private sanitized projection, and
keeps the six-file census INCOMPLETE. Full envelope sealing is unchanged.
This is preparatory ingestion, not a fabricated substitute for missing input.

Synthetic work adds structured fake transport payloads for six production
adapters (OpenAI retains its existing HTTP + inert MCP transport), canonical
request projection, a test-overlay J tap on actual normalized input and runtime
context (only verdicts serialized), two-row pagination, durable SQLite/decision-log identity
reconciliation after shutdown, correlated conversion observations, and an
actual response-rejection injection at the production adapter boundary.
Phone, unproven, manual and scheduled routine paths have dedicated drivers.
`r13b-oracle.ts` supersedes the old routine/delegation all-allow assumptions;
see `R13B-RECONCILIATION.md` for the decision matrix and reader boundary.

Test-only pinned-source overlays are explicit in `instrument-synthetic.py`.
It verifies that removing the observation statements recovers the exact pinned
`server/index.ts`; it hashes all fake transports and test support separately.
It changes no product verdict or response. `summarize-synthetic.py` reports
only complete scenario counts and never emits a release receipt.

Open beyond the real-source gap: arbitrary historical transport metadata and
ACP choices; historical stored-context and predecessor replay; full
owner-channel, continuation and delegation replay; partition, draft, reader
catch and routine-record-write end-to-end fault controls; check+restore durable
witness; complete process-descendant and exact HTTP endpoint tripwire coverage.
`CONTAINMENT.md` identifies the tested guard and its current limits. Synthetic
J/W agreement is tested on actual listener context; it does not reconstruct
missing historical context from diagnostic labels. Native/UI,
public shipped-artifact equivalence, publisher identity and independent final
reviews remain with their existing owners. No approval or release PASS is
manufactured. Consult the final private SUMMARY for executed tests and counts.

Final measured synthetic result: baseline key-read owner cards **4**
(outside-turn 3, sensitive-guard 1), toolid **0**; wipe controls **7 vs 7**
(always-ask). Both pins pass 20 API conservation/reconciliation checks, with
14/14 actual-context J/W outcome and source matches. Manual and scheduled
routines each change from one baseline card to zero at tip: r13b parity defects.
The separate literal ruling comparison has 25 passes and 11 failures; candidate
zero owner cards is not a release or policy PASS. Extractor/receipt tests: 45;
focused unit assertions: 42; guard smoke/mutant checks: 2. Filtered assertions
are not counted as passes. The subsequent seven-driver guard matrix has one
pass and six failures; its failed log is retained and containment stays OPEN.
Evidence and full open-item disposition:
`/work/fuigo-builds/orph/_ev/nolim-replay/1019/bld3-nolimreplay/SUMMARY.md`.
