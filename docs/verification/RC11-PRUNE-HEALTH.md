RC11 prune and health report

Worktree: `codex/rc11-prune`, base `7da331a56787f38189b14ceaf34b4278cf21fe99`. Changes are uncommitted. The supplied data copy was accessed only through `sqlite3 -readonly`; no live app was used.

Cause and evidence

1. At the base revision, `server/harness/event-log.ts:993` joins `messages` on `m.id=s.message_id`, while its primary key is `(thread_id,id)`. `server/index.ts:2882` executes this statement synchronously for every 200-tombstone page. On the supplied copy, EXPLAIN QUERY PLAN reports `SEARCH m USING AUTOMATIC COVERING INDEX (id=?)`. Full EXPLAIN shows `OpenAutoindex`, a complete message-table loop, and `IdxInsert` of `(id,thread_id,text,json,rowid)`. Each qualifying page therefore rebuilds an index over 103,179 messages, including 56,221,899 bytes of JSON and 24,218,017 bytes of text, before matching its tombstones. The row limit bounds the input tombstones, not the index build. The copy contains 6,643 tombstones, 6,642 of type source, and 6,066 joined sources with a non-null message ID. The legacy lookup returns zero surviving message matches on this snapshot; even the empty first page pays for the full index. The 34 pages can repeat roughly 76.7 MiB of payload indexing each, excluding keys and index overhead.

2. The 2,463 ms health probe starts at `2026-10-14T12:12:08.706728Z` (`t=1791979928.706728`, `logpos=743`). The following log region includes a 1,123 ms forgotten lookup and, at byte 1,194 / line 14, `blocked=2375ms holder=events.prune.forgotten:2227msx2`. This identifies the first prune pages as the dominant stall holder in the peak's window. There is also a 1,108 ms `BEGIN IMMEDIATE` line in this startup region. The log lacks timestamps on individual stall lines, so the byte-offset bracket and holder are the available attribution, not a timestamp for each SQL call.

3. The 2,736 ms fast ping starts at `2026-10-14T12:51:07.378037Z` (`t=1791982267.378037`). The surrounding probe starts at `12:51:06.985617Z`, records `logpos=57452`, and reports health 2 ms and `search2` 2,765 ms. Its preceding endpoint durations put the short search's start near `12:51:07.217Z`, overlapping the ping. Exactly at byte 57,452 / line 448 the log says `blocked=2716ms holder=sqlite:route:GET /api/search:2755msx2`. At the base revision, `server/message-db.ts:1341` runs candidate verification and JSON extraction synchronously; `server/index.ts:20011` calls the whole search synchronously. Splitting SQL into chunks did not yield the event loop between them. This peak occurs long after the forgotten lookup, and requires a separate fix.

What changed

- `server/harness/event-log.ts`: replaced `forgottenTextsPage` with a stateful two-pass reader. It pages tombstones and indexed source lookups, then message identities by rowid, and reads bodies only for matching IDs. Each call executes at most two statements, each returning at most 200 rows. No automatic transcript index is built. Copies in other threads and sources without a usable thread remain covered. Worker results carry the existing escaped 160-character text prefix and turn ID, not full message bodies. Collection is incremental, waits during owner turns, and supports asynchronous pages. A lookup failure leaves the prune incomplete and does not certify partially read forgotten data.
- `server/harness/event-log-matcher.ts` and the streamed scanner in `event-log.ts`: prune matching uses a shared-prefix automaton instead of one `includes` scan per forgotten text per event. Construction yields in work batches; matching yields after 4,096 characters, retaining state across boundaries. The existing bounded final catch-up uses the same matcher synchronously. Turn matching and escaped text-prefix semantics are preserved.
- `server/transcript-read.ts`, `server/transcript-read-worker.ts`: one dedicated read-only worker performs forgotten-message lookup, large JSON parsing, and search. Admission is capped at eight outstanding requests. Worker failures reject requests without an inline database fallback. Shutdown waits for worker termination.
- `server/message-search-read.ts`, `server/message-db.ts`: extracted the existing search algorithm into a connection-taking function, retaining the synchronous API for existing internal callers and tests.
- `server/index.ts`: awaits worker search and forgotten pages, checks current thread visibility again after the asynchronous read, returns 503 when search cannot be admitted or completed, and closes the worker during shutdown. The health endpoint's identity and status contract is unchanged.
- `server/proxy-paths.ts`, `scripts/bundle-server.mjs`, `scripts/after-pack.mjs`: resolve, bundle, and require the new worker in packaged builds.

Tests added or updated

- `server/harness/event-log-read-cost.test.ts`: 1,000 and 10,000-message fixtures have identical maximum statement and returned-row counts per page; query plans forbid automatic indexes and unbounded base-table scans. Also covers repeated tombstone revisions, copied IDs, missing source-thread correspondence, large JSON, escaped text and compact-result equivalence.
- `server/harness/event-log-matcher.test.ts`: 1,000 and 10,000 patterns visit the same character count per event in identical bounded slices; overlapping prefixes, suffixes, JSON escapes and surrogate pairs match across boundaries.
- `server/transcript-read.test.ts`: real worker reads execute zero SQL statements on the caller; scope handling, compact pages, bounded admission, shutdown, launch failure and packaging wiring are checked. An HTTP ordering test holds the worker inside `Atomics.wait` until health responds, so it tests independence without a latency threshold. That HTTP test could not run in this sandbox.
- `server/harness/event-log.test.ts`: an asynchronous lookup failure leaves the event file and completion marker alone, and a complete retry removes the forgotten event.
- `server/memory/rc7-background-bounds.test.ts`: uses the new reader while retaining whole-result equivalence and scaling checks.
- `scripts/after-pack-memory.test.mjs`, `scripts/after-pack-windows-signing.test.mjs`: packaged fixture inventories include the new required worker.

Verification performed

The initial seven-file regression run passed 64 tests with the HTTP ordering test excluded. After the matcher and retry changes, the five-file prune/worker run passed 35 tests; the final three-file worker, matcher and event-log run passed 20 tests. Packaging and path checks passed all 29 tests. These are overlapping runs, not additive totals. Existing chunked/bounded search tests passed. All cost assertions use statements, returned rows, query plans or character counts, not wall time.

Because the standard test setup allocates a loopback port even for database-only tests, local runs used a temporary configuration that mocked only that setup port-picker. The normal fixture-home and cleanup setup remained active. Test files themselves retain their normal configuration for the coordinator's run. The socket-based health test was explicitly excluded, not treated as a pass.

The worker was separately bundled with esbuild and run through both search and forgotten-message operations against a newly created isolated database. Native Node type-stripping also loaded the controller successfully. `git diff --check` passed.

`tsc -p tsconfig.server.json --pretty false` reports missing existing dependencies in browser and messaging-bridge modules, plus the associated existing implicit-any error in `website-publisher.test.ts`. It reports no changed-file errors, but the repository-wide typecheck is not green in this environment.

Not verified

The required `node --experimental-strip-types scripts/control-murage.ts launch` was attempted with its temporary root inside this worktree. It failed before launch because this sandbox refuses loopback binds (`no free port block for offsets 0,1 in 19600..22600`). Therefore the real server health ordering test, the fixture workflow, and the real-data latency run remain for the coordinator. The work-count bounds and removal of the identified synchronous database work are verified; actual sub-50 ms slices and sub-second health maxima on the owner's workload are not claimed from this environment. Unrelated synchronous server operations are outside these two diagnosed paths.

Integration note: search SQL performance work should update `server/message-search-read.ts`, which now owns the algorithm; the old `message-db.ts` API delegates to it. The HTTP route must continue awaiting the worker so those reads cannot hold the health endpoint's thread.

## Gate review (Claude, 2026-10-14)

- Search stays with its owner (`fix/rc11-search`): the worker search, `server/message-search-read.ts` and the `/api/search` route change are removed; `server/message-db.ts` and the search route are the release branch's. The `GET /api/search` stall in finding 3 is that lane's problem and fix.
- The prune's forgotten-message lookup keeps the read worker (`server/transcript-read.ts`, `server/transcript-read-worker.ts`, bundled and required by the packaging checks, terminated before the data-directory lease is released). A worker that cannot start or exits now falls back to the same bounded reader on the main thread (`forgottenTextsReader`: two keyed statements of at most 200 rows per page, bodies only for matching ids), named `events.prune.forgotten` on the stall line, so the prune never depends on the worker to finish.
