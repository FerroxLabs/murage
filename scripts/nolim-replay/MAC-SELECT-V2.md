# Mac SELECT v2 — masked permission-card display evidence

This replaces v1's unusable exact-key requirement under MAIN's v2 ruling.
No accepted-key file is required. This job never accesses the Mac. Sean must
confirm the database path before the owner runs this command; the default is
`~/.murage/messages.db` (`server/database.ts` opens `DATA_DIR/messages.db`).
From a private directory containing the reviewed `mac-select-v2.sql`:

```sh
umask 077
/usr/bin/sqlite3 -readonly -batch -bail -noheader \
  "$HOME/.murage/messages.db" < mac-select-v2.sql > mac-select-v2.jsonl
```

Run only that system SQLite command on the Mac. The SQL contains **one
read-only SELECT**, including its CTEs and count row. No repository executable,
key file, `readfile`, extension, migration, backup, ATTACH, app launch, or write
is involved. Do not use immutable mode: committed WAL rows must remain visible.
Missing tables or JSON support are an error; do not broaden the read.

The window is **2026-11-09 12:00:00Z inclusive through 2026-11-10 02:15:00Z
exclusive**. The last 15 minutes, starting 02:00Z, are the annex. Unlike the old
log parser, this timestamped store query does not drop the exact start or annex
boundary. Rows must be `messages.kind='options'` with text-valued
`card.requestId` and `card.tool`, the permission-card discriminator.

Output is JSON Lines: one count line (`total`, `emitted`, `limit`), followed by
**0–2,000 cards**, ordered by timestamp, thread ID, message ID. The census has
**120 accepted asks (117 incident, 3 annex)**. This is a wider timestamp census
of stored cards, so equality with 120 is not assumed: logs can suppress asks,
retention/deletion can remove cards, and the store includes boundaries excluded
by the old log parser. A count over 2,000 means the export is capped, never a
complete window. Zero rows is missing evidence, never zero owner interruptions.

The projection is restricted to thread/message IDs, timestamp, card request ID,
tool, bounded masked input, truncation bit, message origin, the card class's
origin/unattended/automated bits, actor kind, member bot ID, stored
`answered`/`dismissed`, parent/turn pointers, and the v1 memory pointers:
`memory_thread_no.no`, `memory_line_lineage.lsn/turn_lsn/mem_lsn/footprint`.
The lineage schema has a unique `(thread_no,message_id)` index, so the joins do
not multiply cards. No separate decision log is read; `answered` and `dismissed`
are the persisted answer fields in the 1.0.18 card schema.

Storage citations are at **1.0.18 pin
`292df98d80a1c55db3e6f232166fc05162b632ab`**:

- `server/approval-text.ts:61–90`: `boundedToolInput` masks with
  `redactSecretsForCard`, serializes JSON, and bounds the whole input. A top-level
  shell `command` bypasses the per-value cap at lines 68–74; the overall cap
  still applies. No command tail is reconstructed.
- `server/approval-text.ts:172–175`: `cardDetail` returns `event.toolInput` when
  present, otherwise summary/labelled reason prose.
- `server/index.ts:9708–9725`: the permission writer stores that value in
  **`card.subtitle`**, stamps a separate summary when detail differs, and stores
  `toolInputTruncated` when cut.
- `server/store.ts:121–140`: subtitle, answered, dismissed, requestId, tool,
  summary and truncation declarations; `server/memory/schema.ts:206–211`:
  thread-number and unique message-lineage pointers.

The SQL exports subtitle **only** when it differs from the stored summary and
is a JSON object, or is a marked whole-input cut beginning with an object key.
The summary is used solely as a discriminator and is never projected. This
rejects the prose fallback; missing/ambiguous input is **NULL**, never replaced
with summary text. A tool input identical to the summary cannot be distinguished
with this guard and remains NULL. Per-value cuts remain JSON and retain their
stored truncation bit. Whole-input cuts remain the exact masked display prefix
and marker. These are display bytes, not original provider arguments.

It never projects chat message text, summaries, title/wants/held/why prose,
tool results, attachments, other message kinds, roster/config files, native
frames, or credentials. SQLite accesses pages containing stored message JSON;
this is a field projection guarantee, not physical page isolation. Secret
masking is the product's stored masking, re-checked at offline admission. Never
unmask a value or substitute an original command for a masked one.

Census matching uses **tool + UTC minute**, labelled **APPROXIMATE** even if
there is only one candidate. Keep all candidates within that minute; do not
pick a nearest row, use reason prose as a join, or claim exact correlation.
The existing six-file census discarded timestamps (`elapsedMs` is NULL), so it
cannot itself supply minutes. If an authorized timestamp-bearing census source
is available offline, supply a minute-only JSONL index to `--census-minutes`:

```json
{"diagnosticId":"d0001","tool":"Bash","minute":1794225600000}
```

`minute` is epoch milliseconds rounded down to the UTC minute. This optional
index is **not** a Mac query key file. Without it the seal records unavailable
minute matching and an empty match list. Missing times are never invented.

Offline ingestion and replay run inside `it-remote.sh`'s **`--network none`**
container. Set the job wrapper environment exactly as follows on the build host, using
only authorized private copies staged in the worktree's ignored evidence area:

```sh
export IT_JOB=bld4-nolimreplay
export IT_W=/work/fuigo-builds/swarm-b/bld-nolimreplay/wt
export IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh
/work/fuigo-builds/tools/it-remote.sh \
  'python3 scripts/nolim-replay/extract.py ingest-cards --local-input .nolim-evidence/bld4/mac-select-v2.jsonl --out .nolim-evidence/bld4/display-corpus'
```

Append `--census-minutes PRIVATE_MINUTES_JSONL` inside the quoted container
command only when that index is available. Admission checks the exact field
allowlist, window, count/cap, unique IDs, JSON, masking and file integrity. Any
redaction change causes refusal before output; it never silently edits display
bytes. Success seals four private files (`manifest.json`, `cards.jsonl`,
`matching.json`, `redaction-report.json`) with payload hashes and source digest,
labelled **DISPLAY-FIDELITY**, `releaseEligible:false`. The runner rechecks the
seal and redaction. This is separate from the unchanged six-file release gate.
No input, diagnostic or exception content is printed, only counts and paths.

For a given full toolid tip SHA, prepare immutable git snapshots on the build host:

```sh
python3 scripts/nolim-replay/prepare-display-pins.py FULL_TIP_SHA
/work/fuigo-builds/tools/it-remote.sh \
  'python3 scripts/nolim-replay/replay-display.py --corpus .nolim-evidence/bld4/display-corpus --pins .nolim-evidence/bld4/display-pins --tip FULL_TIP_SHA --out .nolim-evidence/bld4/display-comparison'
```

The runner calls each pin's real production permission judge, with an identical
adapter and verified file inventory. It never executes the displayed command.
It reports **owner-class counterfactual cards by reason**, routines, and other
non-owner rows separately. For routine/non-owner rows, base parity compares a
hash of every verdict field plus mode, not just card counts. Missing/truncated
input is counted as unavailable and cannot establish parity. Results are bound
to the corpus digest, base pin, tip pin and adapter hash.

Stored classifications do not prove the start route or runtime owner state.
The report explicitly records assumptions: No limits, empty grants, unlimited
routine ceiling, Claude structured input, POSIX shell, fixture paths, unavailable
filesystem, no outside-read mark, and ownerStarted derived from the stored card
class for this counterfactual only. There is no inferred historic driver,
predecessor content, routine ceiling, denial history, or authenticated owner
receipt. Historical owner-turn totals and actual workflow card totals remain
NULL. DISPLAY-FIDELITY is not exact request fidelity or a release PASS.
