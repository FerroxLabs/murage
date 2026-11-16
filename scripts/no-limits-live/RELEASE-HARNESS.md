The release rig uses `release-engines.mjs` to generate an explicit fake catalogue
for every registered adapter and the Sol row. It never discovers executables
from PATH. Claude and Codex use their native wire protocols; ACP adapters use
the ACP fixture with CLI catalogue and authentication probes. Muse, Pi and
Antigravity use the repository's native protocol fixtures. HTTP adapters use a
loopback fixture service. An unavailable adapter or an HTTP 409 creates failed
scenario rows with its reason. It cannot qualify an engine or silently skip it.

Generate a catalogue inside the container so executable paths name that
container's source tree:

```sh
node scripts/no-limits-live/release-engines.mjs /work/engines.json
node --experimental-strip-types scripts/no-limits-live/run.mjs \
  --live --release --platform linux --candidate CANDIDATE_SHA \
  --engines-file /work/engines.json \
  --corpus /work/build/_private/nolim-cards \
  --corpus-sha256 /work/build/_private/nolim-cards/labels-v1.sha256 \
  --shard 0 --shards 6 --scenario-timeout-ms 10000 --out NEW_OUTPUT
```

The corpus argument also accepts its existing `mac-select-v2.jsonl`,
`display-corpus-bld5` directory, or `display-corpus-bld5/cards.jsonl`. All
resolve to the same approved private set. The SHA256 argument accepts the
reviewed label digest or its existing seal file. Admission checks that digest
against both `labels-v1.json` and `labels-v1.sha256`, checks the existing display
manifest's source and card digests, and joins all 140 unique card IDs to labels.
Fable's review remains in place. Release mode rejects substitute corpora.

Mount the existing private directory read-only at the same absolute path.
Never stream it into a container, archive it, copy it to tmpfs, or write any of
its rows or fields into evidence. The worker suppresses product diagnostics
before importing policy code and writes aggregate counts only. Stored bounded
inputs are replayed as recorded, including the No limits failed-reader ruling;
missing original arguments and runtime provenance are never reconstructed.
The report counts unavailable original inputs separately. Independent wipe
controls remain inert policy data.

Sean's approved corpus contains his own operations recorded at No limits.
Every private replay request therefore binds the authenticated owner at
`unlimited`, including both provenance and base policy context. Legacy card
origin hints never choose the actor or level. `nonowner_origin_hints` reports
only their aggregate count. Guest and missing-origin Ask behavior remains
covered independently by the mandatory assertions and live scenarios.

Each shard owns its modulo slice of the full engine catalogue. Use
`merge-release.mjs OUTPUT SHARD_REPORT...` after all six finish. Merge checks
candidate identity, isolation, shared replay counts, absolute mandatory suites,
every engine exactly once and every scenario exactly once. Replay is counted
once in the merged summary. Any timeout, unavailable engine, skipped row,
missing report, duplicate ownership or failed mandatory assertion keeps rc=1.

Scenario work defaults to 10 seconds and can be capped at 1–45000 ms with
`--scenario-timeout-ms`; timeout cleanup has a separate 5-second bound. Deadline
cancellation aborts HTTP requests, including background fixture polls, and
retains cards observed before a timeout. Native fixtures execute approved
actions only in the fresh owned workspace; catastrophe controls never execute.
Git fixture preparation uses cancellable child processes within that same
deadline. No synchronous Git timeout can multiply the scenario budget.

The approval reader requires its named columns and explicitly reports any
missing required name. Extra columns and column order are compatible. Its
regression initializes the current product's 27-column approval schema, adds
another column, and reads it independently. Live release accounting reads the
seven independent surfaces: native requests and accepted receipts, actual
decision registrations, durable records, messages, pending queues, the
Electron attention endpoint, and outbound channel presentations. Provider turn
IDs and decision provenance generations are joined through the owned thread
and request ID. An accepted receipt acquires an allow/deny behavior only from
the separately observed native resolution event. Missing evidence fails closed.

The old rehearsal webhook assertion supplied `fullAccessOrigin: 'webhook'`,
which is outside that product type. `mandatory-fixture.mjs` maps this legacy
fixture spelling to `noLimitsOrigin: 'webhook', fullAccessOrigin: 'other'`.
The ruling test itself is unchanged; the original assertion is also exercised
by the harness regression.

Private replay also traverses the production registered decision, delivery and
final native release guard. Its database uses the product schema in SQLite
memory; the host retains messages in memory. Before private input is opened,
filesystem persistence and process output are blocked. Only the worker's
captured aggregate report writer can produce output. A RUN needs exactly one
accepted final release; a refusal, hold, missing delivery or failed action is
counted as a failed row. Synthetic regression operations exercise a late wipe
and persistence attempts without reading any private input.

Dedicated fault scenarios instrument the existing provenance-reader and
ingress boundaries in the isolated server. The instrumentation records the
fault before the real decision/delivery runs; it supplies no verdict or native
receipt. The owner-restart scenario restarts the owned server. The release
fakes execute shell and file actions only after native approval, and call the
actual mounted MCP tools for browser and seat operations. Unknown scripted
instructions fail the row. HTTP fakes emit mounted tool calls and consume
results before ending the turn. The fake native wrappers retain the
repository's version, authentication and session handshakes.

The release fixture uses the product's unpackaged browser-host test seam and
a loopback-only fake browser transport. It keeps the real controller, claims,
permission routes and mounted browser tools. Page hits are actual loopback
HTTP reads. This proves policy and native adapter wiring; browser packaging
and operating-system sandbox qualification belong to their separate gates.

Each engine gets a fresh server, home and data directory. This keeps earlier
scenario bots from exhausting the product's 100-bot workspace limit. Evidence
is retained under `engine-fixtures/ENGINE/`; the workspace is removed only after
its observations have been saved.

An observational preload records synthetic native tool starts and results before
the public event projection removes tool arguments. Unasked mounted operations
need the declared input hash, matching engine/thread/turn/item identities and
exactly one successful result. They cannot conceal interruptions on another
accounting surface. Registered email operations additionally bind the full
service intent digest and the canonical prepared envelope to the native input.
This preload is not loaded by private replay.
