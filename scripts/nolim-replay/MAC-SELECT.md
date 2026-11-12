# Mac SELECT — review draft, blocked on exact keys

**Do not run until MAIN reviews the query and Sean approves this exact read.**
Nothing in this job runs on the Mac. The current sealed census cannot supply
this SELECT's join keys. This is a deliberately fail-closed recovery query,
not a claim that the original envelopes can be recovered from SQLite.

From a private reviewed directory containing `mac-select.sql` and
`accepted-keys.json`, the proposed command is:

```sh
umask 077
/usr/bin/sqlite3 -readonly -batch -bail -noheader \
  "$HOME/.murage/messages.db" < mac-select.sql > mac-select.jsonl
```

Confirm the store location with Sean first; `server/database.ts` opens
`DATA_DIR/messages.db` (a configured installation may use another directory).
Use the system SQLite shell only. No repository executable, Python, migration,
backup, extension load, attach, write query, or application startup runs here.
`readfile` reads only the adjacent reviewed key file; unavailable SQLite JSON or
readfile support is a stop, never permission to switch to a broader export.
Do not use immutable mode: committed WAL rows must remain visible.

The one SELECT reads exact `messages(thread_id,id)` rows, their `at` epoch-ms
stamp and allowlisted JSON fields, plus `memory_thread_no(thread_id,no)` and
`memory_line_lineage(thread_no,message_id,lsn,turn_lsn,mem_lsn,footprint)`.
Source: `server/message-tables.ts`, `server/store.ts` (`Message`,
`OptionCardData`), `server/index.ts` permission-card construction, and
`server/memory/schema.ts` / `lineage-write.ts`. Bot rosters are outside this
SQLite message schema; `memberBotId` is present only on some messages. The
census bot binding is labelled separately and never promoted to stored proof.
`origin` and `cardClass.origin` are stored classifications, not an authenticated
start receipt. Runtime owner-started and outside-read state are not stored on
these cards: SQL returns NULL, never false. Lineage IDs are pointers, not
reconstructed predecessor context.

It never projects message text, card subtitle/summary/why, tool results,
attachments, prompts, config, credentials, roster files, other tables, or other
conversations' rows. SQLite necessarily accesses pages containing selected
JSON; the claim is about selected fields, not physical page isolation. Tool
activity rows store name/outcome, not typed input. Some cards store JSON input in `subtitle` (`approval-text.ts:boundedToolInput`),
but that text is secret-masked and bounded; other cards store summary/reason
prose in the same field. Without a retained driver/encoding/fidelity binding,
it cannot establish original typed arguments. This draft leaves `arguments`
NULL and `argumentsAvailable` false instead of exporting ambiguous display text.

Expected bound: **0–120 rows**, at most one per reviewed census diagnostic.
The key file must contain exactly 120 unique diagnostic and `(threadId,
messageId)` bindings, each with `diagnosticId`, `threadId`, `messageId`,
`requestId`, original `botId`, `tool`, exact `at`. Join is exact on all stored
keys, never nearest-time or reason. Window is Nov 9 12:00 to Nov 10 02:15 UTC,
excluding all three ambiguous boundaries; the last 15 minutes are the annex.
Missing/duplicate keys or missing tables stop admission; never widen the window.
The sealed census has 120 asks (117 incident, 3 annex), salted bot aliases,
NULL elapsed times and no request/conversation/message IDs. Its private alias
file contains salted hashes, not a reversible ID map. Thus **no valid 120-key
file exists in this job**. MAIN needs an independently retained exact join
source, plus original typed requests and authenticated context. Do not commit
keys or SELECT output. An empty result is incomplete evidence, not zero asks.

Offline build host ingestion: `extract.py ingest-store --diagnostics CENSUS
--local-input mac-select.jsonl --local-map REVIEW --out NEW_REVIEW` inside the
prescribed `--network none` container. It validates exact fields, joins and
redaction receipts, retains the six-file seal as incomplete, and refuses to
manufacture arguments/origin. Complete request sealing remains a separate gate.
