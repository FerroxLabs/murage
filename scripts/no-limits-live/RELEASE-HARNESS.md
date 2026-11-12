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
  --corpus /work/fuigo-builds/swarm-b/_private/nolim-cards \
  --corpus-sha256 /work/fuigo-builds/swarm-b/_private/nolim-cards/labels-v1.sha256 \
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

The approval reader requires its named columns and explicitly reports any
missing required name. Extra columns and column order are compatible. Its
regression initializes the current product's 27-column approval schema, adds
another column, and reads it independently. Live release accounting reads the
real durable policy and presentation stores rather than hypothetical export
files.

The old rehearsal webhook assertion supplied `fullAccessOrigin: 'webhook'`,
which is outside that product type. `mandatory-fixture.mjs` maps this legacy
fixture spelling to `noLimitsOrigin: 'webhook', fullAccessOrigin: 'other'`.
The ruling test itself is unchanged; the original assertion is also exercised
by the harness regression.
