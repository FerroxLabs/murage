# C2 rule round 2 evidence

Binding input: `../inputs/C2-RULE-archived.md`, read in full. Baseline: `b3782982ea`.
The project memory tool was not available and this checkout has no `.ijfw/memory` directory.

All database and route tests use temporary homes. The browser fixture uses an isolated HTTP server and fake transport. `fixture.json` and `doctor.json` record the separately launched control fixture. No live app or user data was used. No full rig was run.

## Search inventory and Case B audit

| Caller | Location | Policy |
| --- | --- | --- |
| All chats grouped search and pages | `src/components/AllChatsPage.tsx:73`, `src/lib/all-chats.ts:91` | Chats audience; excludes forgotten preview hits. |
| Popup search and pages | `src/components/ChatPickerSearch.tsx:10` | Same chats audience. |
| Expanded matches and pages | `src/components/ChatThreadMatches.tsx:15` | Same chats audience, scoped thread. |
| Sidebar | `src/components/SearchResults.tsx:20` | Existing chats audience. |
| Command Palette | `src/components/CommandPalette.tsx:89` | Ordinary owner search. Case A stays findable. Complete hit rows require live proof. |
| Conversation Find | `src/components/ChatFindBar.tsx:17`, `src/lib/focus-message.ts:22` | Ordinary owner search. Case A stays counted and landable. Landing checks proof before and after asynchronous work. |
| Local MCP search tool | `scripts/mcp-server.ts:1067` | Ordinary `/api/search`, non-owner audience. Never receives either forbidden case. |
| Search route, grouped and ordinary | `server/index.ts:25933` | Keeps the existing audience rule. Adds generation to ordinary answers for the same readers entitled to stream proof; predicates run before LIMIT. |
| Agent transcript recall | `server/index.ts:23614`, `server/thread-recall.ts:277` | `thread_search` uses the existing reader door, active-row checks, and forgotten-source checks. No production change. |

The source inventory searched all production callers of `searchMessagesWithMeta`, `searchChatThreads`, `searchMessages`, and client `/api/search` URLs. `server/chat-search.ts` and `newestVisibleHit` are internal implementations of the same route. Help, library, web, and connector catalog search do not return transcript-message hits.

Case B exists:

* Deleted messages: the keyed join to `messages` already excludes surviving index entries. The tests seed an indexed row then remove it.
* Inactive explicit branches: `visibleMessages` at `src/state/store.tsx:815` renders only the active path. Search now checks the same branch membership before limiting. Legacy flat rows have no explicit parent and retain flat transcript behavior. The route test seeds a surviving off-branch root.
* Hidden activity rows: `src/components/ChatView.tsx:1199`, `:1229`, `:1393` omit tool rows when Tool calls is off. Search now filters those candidates while retaining independently rendered notices. Completed or expired folder-prompt rows are also excluded, following `shared/mac-folder-prompt.ts:35`. Tests cover both indexed and window walks, and grouped continuation.
* Cards and screen rows: search's existing kind predicate never admits them. Hidden onboarding cards therefore cannot be hits.
* Deleted memory source with a surviving message: this is Case A for the owner, not Case B. Owner search keeps the row. Non-owner search previously leaked an unstamped source tombstone or deleted-source row. It now excludes these inside the SQL predicate; the reader door remains in place.
* Withheld or stamped forgotten message: still rendered with the note at `src/components/ChatView.tsx:539`. Palette and Find keep it. The unfinished `view=chats` exclusion in those two components was removed. The server's owner audience was not replaced with a blanket exclusion.

`server/message-search-forgotten.test.ts` seeds each source class, deletion, hidden tools, and expired prompts. `server/chats-api.test.ts` exercises the real authenticated owner and non-owner routes, including the off-branch row. Existing `server/thread-recall.test.ts` covers stamped, tombstoned, deleted-source, active-row and release-time checks for agents. Its forgotten filter was mutation-tested without changing its production code.

## Existing test changes

| Existing test or fixture | Change | Binding rule |
| --- | --- | --- |
| `archive resource catch retains only count even without a generation change` | Renamed to "after a generation change"; advances generation instead of an owner refresh click. Every original count-only assertion remains. Added a separate same-generation failure test requiring the complete original body. | TWO DIFFERENT LOSSES: same-generation refresh failure changes nothing shown; mismatched provenance retains count only. |
| Supplied archive fixture | Supplies its own A/0 generation for the existing valid-row tests. Adds explicitly unversioned and older variants. Existing assertions remain. | RULE and path 3: supplied rows must carry their own generation. |
| Browser fixture response header | Explicit UTF-8, required once Palette's imports brought a Unicode regular expression into the bundle. No assertion changed. | Test fixture correctness. |
| Browser fixture failure delivery | Rejects the fetch promise rather than `json()`, so `api` cannot swallow a simulated transport failure as a JSON parsing error. Existing assertions remain. | TWO DIFFERENT LOSSES and refresh failure tests. |
| Browser fixture main page identity | Memoizes `appendChatPage`, matching production `AllChatsPage`; prevents a fixture-only fold reset on proof changes. No assertion changed. | Gate metadata and path 13. |

No existing assertion was removed or weakened. No existing size or timing budget was changed. No production changes were needed in store hydration, replay handling, shared snippet rendering, ChatPickerSearch, ChatThreadMatches, SearchResults, TaskPicker, task-window, or the recall door.

## Red evidence

All red runs were executed. Rollback and mutation scripts saved the working bytes, ran tests, and restored them in `finally` blocks. Infrastructure failures from browser installation and an exploratory branch-engine suite are not counted as reds.

| Log | Deliberate rollback or mutation | Observed failures |
| --- | --- | --- |
| `red-head-client.log` | Restore the six changed client implementations from baseline | 12 failures: proof fallback, same-generation failure, Palette/Find fencing, count lifetime, stale landing, main memory disposal, owner retry, and unversioned retry bound. |
| `red-head-server.log` | Restore index, message DB, and grouped search from baseline | 6 failures: ordinary generation, non-owner sources, rendered predicate, grouped counts and continuation. |
| `red-gate-mutation.log` | Make `chatsEligible` always true | 15 failures across main, popup, search consumers, first paint, routine rows, proof and hydration assertions. |
| `red-merge-mutation.log` | Remove the immutable expected-generation check in `fetchChats` | Both popup and expanded page merge tests fail on a changed-generation page. |
| `red-hydration-mutation.log` | Delay live forgot handling until hydrated | Both mounted provider tests fail while the snapshot is blocked. |
| `red-replay-mutation.log` | Process replayed generation frames | Replay and restart-proof tests fail. |
| `red-recall-mutation.log` | Bypass recall's forgotten filter | 12 agent search cases fail for stamped, tombstoned and deleted-source rows. |
| `red-memory-mutation.log` | Disable retained-row disposal on generation mismatch | The main memory test still finds transcript bytes and fails. |
| `red-supplied-mutation.log` | Accept an older supplied generation as current | Older supplied-row test fails. |
| `red-branch-mutation.log` | Remove active-path predicate | Real route returns the surviving off-branch row. |
| `red-hidden-mutation.log` | Make activity rendering predicate always true | Hidden tool/expired-prompt predicate test fails. |
| `red-path-mutation.log` | Remove resource request-lifetime fence | Late prior-query answer erases the accepted current Find result. |
| `red-owner-query-head.log` | Restore original Palette and Find | Ordinary-search guard fails because the components lack the shared versioned resource. |

| `red-owner-retry.log` | Click Try again after a settled-generation refresh failure | No request starts until the explicit resource refresh is wired. |
| `red-phone-generation.log` | Ordinary phone search before generation is added for entitled readers | The paired-phone Find response has no own generation. |

## Environment and commands

Commands use `node_modules/.bin/vitest` and `corepack pnpm` because `pnpm` is not on this container's PATH. Browser tests set `PLAYWRIGHT_BROWSERS_PATH=/tmp/c2-playwright`. Chromium and its OS libraries were installed into the container. Server TypeScript exceeded the default 4 GiB heap on its first attempt; it passed with `NODE_OPTIONS=--max-old-space-size=8192`, also used for the successful build.

The exploratory `server/branching.test.ts` run could not launch its fake ACP engine without the shipped bwrap. No assertions or infrastructure in that suite were changed. The added branch regression instead uses seeded rows through the isolated authenticated search route, which passes and has its own branch-only mutation red.

The routine-fold test opens the fold only if it is closed after invalidation. Fold persistence itself is not a requirement. Its credited red is the gate mutation, which fails at the snippet assertion, not the earlier baseline run's fixture assumption about fold state.

The later archive mutation disables disposal and supplied-generation comparison. Three variants fail; the folded fetched variant is additionally covered by the retained-resource memory test and the count lifetime test. All four mounted archive variants also reject a late answer across restart and accept the new-generation replacement.

## Rule and path coverage

C = `11677f9f33` (client proof, counts and tests). S = `1dbb9c5137` (search audience and rendered-row predicates). T = `acc0544b63` (store-task and equivalent-fallback tests only).

| Rule / path | Commit | Test | Executed red |
| --- | --- | --- | --- |
| RULE: no borrowed proof | C + T | `chats-gen.test.ts`, guard; supplied unversioned/older browser cases | `red-head-client`, `red-supplied-mutation` |
| GATE: snippets and entire hits, metadata retained | C | first paint, list/popup reconnect, search-holder matrix, routine fold | `red-gate-mutation` |
| TWO DIFFERENT LOSSES | C | main memory probe, same-generation failure, unversioned retry bound, owner retry | `red-memory-mutation`, `red-head-client`, `red-owner-retry` |
| COUNTS | C | real main query unmount then failed folded archive refresh | `red-head-client` |
| MERGE | C | picker, expanded and real All chats changed-generation pages | `red-merge-mutation`, `red-all-search-merge` |
| HYDRATION | C, tests only | mounted blocked provider, replayed frames after restart | `red-hydration-mutation`, `red-replay-mutation` |
| 1. Main list | C | list proof-loss/failure/late-answer matrix; memory disposal; owner retry | `red-gate-mutation`, `red-memory-mutation`, `red-owner-retry` |
| 2. Archive open/folded | C | four archive variants, count-only resource, parent count lifetime | `red-archive-mutation`, `red-head-client` |
| 3. Supplied archive | C | unversioned and older supplied rows; supplied open/folded restart cases | `red-head-client`, `red-supplied-mutation`, `red-archive-mutation` |
| 4. Popup and store task rows | C + T | popup matrix, empty proven page cannot borrow task snippet, `TaskPicker.test.ts`, `task-window.test.ts` | `red-gate-mutation`, `red-store-task-mutation` |
| 5. Later pages | C | changed-generation merge matrix and existing accepted-page metadata test | `red-merge-mutation`, `red-all-search-merge` |
| 6. Path change/reconnect | C | Find prior-query answer after current answer; equal hello with zero requests | `red-path-mutation`, `red-gate-mutation` |
| 7. Hydration | C, no production change | stalled snapshot, immediate live forget, restart and replay tests | `red-hydration-mutation`, `red-replay-mutation` |
| 8. All chats search/pages | C; existing consumer unchanged | `all-page` search-holder and merge cases | `red-all-search-gate`, `red-all-search-merge` |
| 9. Popup search/pages | C; existing consumer unchanged | `picker` search-holder and merge cases | `red-gate-mutation`, `red-merge-mutation` |
| 10. Expanded matches/pages | C; existing consumer unchanged | `matches` search-holder and merge cases | `red-gate-mutation`, `red-merge-mutation` |
| 11. Sidebar | C; existing consumer unchanged | `sidebar` matrix and blocked-provider tests | `red-gate-mutation`, `red-hydration-mutation` |
| 12. Shared rendering/acceptance | C; existing renderer and `fetchChats` unchanged | mounted hit renderers; own-generation, session and replay unit tests | `red-gate-mutation`, `red-merge-mutation`, `red-replay-mutation` |
| 13. Section titles/expanded/routine rows | C; existing row renderers unchanged | section archive matrix, first paint, routine-fold test | `red-gate-mutation`, `red-archive-mutation` |
| 14. Palette | C + S | palette matrix, ordinary owner route, source guard, asynchronous landing | `red-head-client`, `red-head-server`, `red-owner-query-head` |
| 15. Find | C + S | find matrix, query replacement, landing, owner/paired-reader routes | `red-head-client`, `red-path-mutation`, `red-phone-generation` |
| 16. Other callers and routes | S; existing recall unchanged | source-class matrix, real route, indexed/window predicates, grouped continuation, agent recall | `red-head-server`, `red-branch-mutation`, `red-hidden-mutation`, `red-recall-mutation` |

Every `.log` name in this table is in this directory. The additional All chats gate and merge mutations each fail the real `AllChatsPage` test, not just the shared hook.

## Completed verification

| Check | Result | Evidence |
| --- | --- | --- |
| Client touched and adjacent components | 106 passed in 6 files | `client-final.log` |
| Search routes, predicates, grouped search, generation writer guard | 34 passed in 4 files | `server-final.log` |
| Broader neighbours | 356 passed in 15 files | `neighbours.log` |
| Final guard and routine fold | 2 passed | `final-guard-fold.log` |
| Client TypeScript | Passed, including final fixture additions | `tsc-client.log`, `build.log` |
| Server TypeScript | Passed with 8 GiB heap | `tsc-server.log`, final `build.log` |
| Tier inventory | 3481 files: 1991 gate, 1490 extended | `tiers.log` |
| Catalog | Current; 283 entries, 204 profiles, 2766 references | `catalog.log` |
| Locales | Valid; 8 languages, 4060 English strings | `locale.log` |
| Production build and precompression | Passed | `build.log` |
| Bundle | 603.4 KiB brotli, budget 670 KiB | `bundle.log` |
| Control fixture doctor | Passed; fixture stopped with Ctrl-C, launcher exited 0 | `fixture.json`, `doctor.json` |

Test counts are per command and overlap. The final build includes both TypeScript projects. No full rig or push was run. Intermediate logs are retained for the audit; only the named final checks above and the final popup check below describe completion.

Final popup verification: **83 passed in 2 files** (`popup-verified.log`), including all 44 mounted browser cases and all 39 TaskPicker tests. Final strengthened proof guard: **11 passed** (`guard-final.log`). The earlier `popup-final.log` records a strict-locator fixture error corrected before this successful full rerun; it is not a product failure or credited red.

The store-task test is in `acc0544b63`. Its mutation (`red-store-task-mutation.log`) introduces a fallback from the preview map to the unversioned task object and fails on the forbidden text. `TaskPicker.tsx` itself remains unchanged.

Additional executed reds: `red-all-search-gate.log` and `red-all-search-merge.log` each have one expected failure; `red-archive-mutation.log` has three; `red-owner-retry.log` and `red-phone-generation.log` each have one. The rule and path table names the credited evidence for each path rather than treating a passing test under an unrelated mutation as a red.
