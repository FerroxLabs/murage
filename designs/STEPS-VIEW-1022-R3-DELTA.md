# STEPS VIEW r3: what changed from r2, and why (per finding id)
Owners: design = steps-design-r3. Build (server and client) = steps-view-build-1022 until MAIN names another lane. Fuigo emitter items (F1-F18) = OPEN NO-OWNER, Fuigo lane.
Inputs closed here: STEPSAUDIT-UX (`stepsaudit-ux-fable/AUDIT.md`: 11 High, 14 Medium, 9 Polish), STEPSAUDIT-ASTRA (`stepsaudit-astra/AUDIT.md`: 10 High, 4 Medium), STEPSREF (`stepsref-fable/REFERENCE.md`: 15 adopt items). r2 is kept beside r3 as `STEPS-VIEW-1022-r2.md` and `steps-view-mockup/index-r2.html`. Section numbers are r3's.

## The five big moves
1. **One live indicator.** §1 now lists every indicator the chat has and says what happens to each. The live line is the pill, the now-line and (when there is one) the plan row. TurnPresence keeps only its mascot; LiveThinking and LivePlanCard become rows; HelpersLine, TaskTimeline and the old folds go.
2. **Labels that cannot understate, for every tool.** §4 has the full table (Murage's own tools, connected apps, three kinds of delegation), a real shell tokenizer with a 31-line witness table, and the rule that ACP titles are never labels. The raw-command hint is gone.
3. **The real thing on one click.** §5.3: a terminal block for a command, a diff for an edit, typed panes for the rest, each with its own words for every state.
4. **A contract the builder can implement without guessing.** §2 (ask matching), §3 (identity, status, all registered engines), §6 (commit order, deletion, snapshot sync), §7 (one projector; who can see what), §9 (bounds and what to measure).
5. **The app's own look.** §5.9 maps every part to a Murage token or component; the mockup is rebuilt at 1280 × 800 and 390 in Dark and Light from the tokens in `src/styles.css`, with lucide icons, native buttons, working keyboard and Copy.

## STEPSAUDIT-UX
| Id | State | Change | § |
|---|---|---|---|
| H1 | Closed | Quiet labels only when every segment is read-only; else the most consequential segment names the row; kinds `delete`, `move` | 4.3, 3.1 |
| H2 | Closed | Quote-aware tokenizer, wrapper and prefix stripping, value flags, Windows shells, known programs, Codex by item type and `commandActions`; hint removed | 4.3, 3.4 |
| H3 | Closed | Tail name resolved before the app branch; full table; app display names; batch count; objects restored | 4.1, 4.2 |
| H4 | Closed | The one-indicator table. Differs from the audit in one place: LivePlanCard is folded into the group as the plan row instead of staying a card (the brief's "fold or replace", and STEPSREF 7) | 1, 5.4, 5.5 |
| H5 | Closed | Approvals stay in the panel above the composer and the one-line waiting row; the row sits under the group; its existing Answer button is the way to the panel (no new focus behaviour on the pill) | 5.7 |
| H6 | Closed | Scroll rules: a hand open breaks follow and keeps the row in place; auto-close only if untouched; "Hide steps" | 5.8, 5.2 |
| H7.1 | Closed | Web rows show the host only | 4.2, 7.3 |
| H7.2 | Closed | Typed text always masked in the Request | 7.3 |
| H7.3 | Closed | The missing rules are added to the step scanner with a witness each; the r2 claim about `bot-package-scan` is withdrawn | 7.3 |
| H7.4 | Closed | A search pattern goes through the scan; witness | 7.3 |
| H7.5 | Closed | Spoken line has no object | 5.13 |
| H8.1 | Closed | Scan per string value; a label masks to the end of its line | 7.2 |
| H8.2 | Closed | 16 KB windows, each with its own budget; partial notice instead of withholding the whole log | 7.2 |
| H8.3 | Closed | Linear scans only; 1 MiB pathological witness under 50 ms | 7.2, 4.3 |
| H8.4 | Closed | Test arithmetic corrected | 0 |
| H9 | Closed | Three delegations with three wordings, `childRef` for all, child waiting raises the parent header, counts are top-level, Codex collab mapped, a witness per kind | 5.6, 3.4 |
| H10 | Closed | One line per row; status phrase may take a second line on the text column; header segments never break inside; 44 px; real breakpoint | 5.10 |
| H11 | Closed | Token and component map; both skins; lucide; app type scale; mockup rebuilt | 5.9 |
| M1 | Closed, one part rejected | One helper (`formatElapsed`, extended with hours); row time only at 2 s or more. **Rejected:** one decimal under 10 s. Reason: one format everywhere, and STEPSREF 10 shows the field hides short times rather than refining them | 1, 5.2 |
| M2 a-f | Closed | Most recently started step; 1 s hold and 1.5 s before "Thinking"; tabular numbers; "Writing"; single app named; "Using the browser" | 5.1 |
| M3 | Closed | The now-line and "step N" | 5.1 |
| M4 a | Closed, narrowed | Runs fold, but only the quiet look-up kinds. **Rejected:** folding commands, edits and app actions. Reason: anything that changes something keeps its own row (five reference products agree, STEPSREF 12) | 5.2 |
| M4 b, c | Closed | Grey kind icons on done rows; newest 12 live, first 30 finished, no nested scroller | 5.2 |
| M5 a-c | Closed | Worked time excludes waiting; several groups per turn; server `now` offset | 5.1, 6.3 |
| M6 | Closed | "Stopping…", "Interrupted after …", settle at `markTurnToolsUnrecorded` | 5.1, 3.3 |
| M7 a-f | Closed | "×2" for identical neighbours with a line that says why; stored text as the Request; header "27 steps"; "N earlier steps not kept"; opens on a find hit; D3 and mounted-only adapter | 10 |
| M8 a-e | Closed | One tab stop with roving focus; four announcements only; status in the accessible name; house focus ring; no new keyframes | 5.11, 5.9 |
| M9 a-f | Closed | Diff, typed panes, per-state words, Copy everywhere, "Connected apps" footer, exit only on failure, no scroll trap | 5.3 |
| M10 | Closed | "Wants to …" / "Wanted to …" forms | 4.1 |
| M11 a-e | Closed | Keys in all eight locales, header from counts, bold by splitting at `{object}`, `<bdi>`, function replacement, frozen-name checks | 5.12, 0 |
| M12 | Closed | Parent folder on duplicate basenames; inclusive "lines 40-90"; full text in `title` | 4.1 |
| M13 | Closed | `TextEncoder`; request cap covers command text | 0 |
| M14 | Closed | No avatar on the pill in rooms; GroupView mounted | 5.6, 1 |
| P1 | Closed | No clock while waiting | 5.1 |
| P2 | Closed | List capped at 40rem | 5.2 |
| P3 | Closed | Notes in normal weight grey on the text column | 5.2 |
| P4 | Closed | Now-line only while collapsed | 5.1 |
| P5 | Closed | "Show N more steps" / "Show N earlier steps" | 5.2 |
| P6 | Closed | Mockup uses `--color-bubble-user` | mockup |
| P7 | Closed | "Loaded the **gmail-triage** skill" | 4.2 |
| P8 | Closed | Friendly forms for the five common git commands | 4.3 |
| P9 | Closed | No new Stop control; the mockup draws the two that exist | mockup |
| Gap list | Closed | "Image, shown in the chat"; the No limits trace survives Off | 3.4, 5.13 |

## STEPSAUDIT-ASTRA
| Id | State | Change | § |
|---|---|---|---|
| H1 | Closed | Delivery deduplicated by broker request id; an id-made provisional row is adopted only by that id; an ID-less ask attaches only on a unique match, else no row attribution; unexecuted attempts settle from the decision; the capture witness is widened (Steps on and off, crossed sources, replayed start); old lines shown as approval records that may repeat | 2, 10 |
| H2 | Closed | Every registered driver against one contract, with recorded fixtures; Codex output and statuses; ACP sparse updates and final-first frames; API engines mint a counter before validation; Pi and Antigravity; "Request / Response unavailable" | 3.4, 5.3 |
| H3 | Closed | Operation token under turn generation and attempt epoch; `(engineId, argsHash)` removed; orphans dropped; cards tracked by request id with union wait time; held-Stop results stay pending; invalid calls; fence after settlement | 3.2, 3.3 |
| H4 | Closed | Step frames go to desktop connections only and never enter the shared replay buffer; routes need owner-surface proof and thread access on every request and child read; tails on the subscriber's own connection; generic anchor text; search carries labels only | 7.5, 6.5, 6.1, 6.6 |
| H5 | Closed | One projector at the execution fold for every displayed string; tool name sanitised; live tail uses the same rules as the final detail; raw reasoning is never a note | 7.1, 7.4, 3.1, 3.5 |
| H6 | Closed | `steps.v1`: epoch, consistent `asOfRev`, group state, `firstRetainedSeq`; snapshot on reconnect with frame buffering; per-row revisions; eviction, deletion and restore rules; witnesses during paging | 6.3 |
| H7 | Closed | One transaction for row + group + anchor, then publish; detail as a fenced, recoverable sidecar; deletion through the funnel and the pending record; boot order awaited; sweep by committed step keys; physical budget apart from the payload cap | 6.1, 6.2 |
| H8 | Closed | `childRef (threadId, groupId)` for all delegation; child groups; late parents; "Earlier helper" after eviction; Codex collab and Fuigo sub-agents; StepsGroup in rooms, tasks and helper conversations | 3.1, 3.4, 5.6 |
| H9 | Closed | Turn-wide row and detail budgets across split and child groups; bounded token map, scanners and pending bytes; paced background work; client cache bounds; a list of what the scale run must measure | 9, 6.4, 7.2, 7.4 |
| H10 | Closed | Native buttons, roving focus, Copy wired, every chevron opens something real; the mockup shows collapsed-live, open-live, waiting, failure and phone detail in both skins; the No limits trace survives Off; nothing is folded under Off | 5.11, 5.13, 3.5, mockup |
| M running detail | Closed | Request stored at step start; loading, withheld, not kept, unavailable each have their own words | 6.1, 5.3 |
| M labels and timers | Closed | Hint removed; phase rule; header = turn worked time, row = step active time; no duration without a trusted start | 4.1, 5.1, 3.1 |
| M search | Closed | Label words added to the anchor message's index entry; `?match=` to find rows | 6.6 |
| M accountability | Closed | Owners named in the first lines; scroll, settings search, rooms and helper witnesses are a gate | header, 11 |

## STEPSREF adopt list
| # | State | Change | § |
|---|---|---|---|
| 1 | Adopted | ACP label from `rawInput`, `kind`, `locations`; `title` never a label | 4.4 |
| 2 | Adopted | Status-less updates re-label a non-final row | 3.2, 3.4 |
| 3 | Adopted | Typed detail bodies; `content` before `rawOutput`; real diffs | 3.1, 5.3 |
| 4 | Adopted | `+N −M` and file count on the row; file chips with Copy path | 3.1, 5.3 |
| 5 | Adopted, one part rejected | Terminal block; non-zero exit is a failure whatever the status says. **Rejected:** "Failed · exit 1" on the row. Reason: the row stays plain ("Failed"); the code is in the pane | 3.3, 5.3 |
| 6 | Adopted | Fuigo streams too; ACP content replaces, never appends | 6.5, 3.2 |
| 7 | Adopted, placed differently | One plan row, no step rows for todo tools. It sits under the now-line while live so the plan stays visible with the group collapsed | 5.4 |
| 8 | Adopted in part | "Thinking" → "Thought for 12s" row; retry notices are not thoughts. **Rejected:** a note from the first line of an ACP thought segment (raw reasoning is not narration; ASTRA H5). **Parked:** keeping reasoning text with the turn (new data surface) | 5.5, 3.5 |
| 9 | Adopted | Engine evidence of "never ran" is `denied`; unknown ACP status means running | 3.3 |
| 10 | Adopted | First view 12 lines (tail for commands, head otherwise); durations from 2 s | 5.3, 5.2 |
| 11 | Adopted with the stated default | Now-line; the header keeps "27 steps" and the breakdown is the first grey line of the list (D4) | 5.1, 5.2 |
| 12 | Adopted, one part rejected | Quiet runs fold at 4 (D5). **Rejected:** unfolding runs under "Open while working" (one rule in every mode; the newest live row is never inside a fold) | 5.2 |
| 13 | Adopted | `result` on the row when the engine gives a count | 3.1, 4.2 |
| 14 | Adopted | Fuigo sub-agents from its notifications; child activity on the row | 3.4, 5.6 |
| 15 | Adopted | One un-masked Fuigo capture first; witnesses on real recorded frames | 11, 3.4 |
| (c) | Followed | Nothing on the do-not-copy list is in r3 | |
| (d) F1-F18 | Routed | Fuigo lane; not needed for 1.0.22 | 3.4 |
One r2 fact corrected on STEPSREF's note: the reason given for "completed before started" (Fuigo hosted tools) was unverified; the rule stays as a safety net without that claim (§3.3).

## Self-review before push (one Opus read-only pass, all folded in)
Two blocking finds: r2 and the r3 draft named `deleteThreadRecord` as the delete funnel, but the boot deletion triage bypasses it, so the details hook stays in `message-db.ts deleteThread` (§6.2); and a content-keyed provisional row could never be adopted for two identical parallel calls, so an ID-less ask now never opens a row (§2). Also folded in: the No limits count is rows tagged automatic, never asks (§8); the frame is `stepgroup.upsert`, not `group.upsert` (§7.5); running rows carry no clock (§5.2); the header only toggles (§5.7); "Stopping…" is local (§5.1); comm chips and done-when receipts listed as unchanged (§1); `sort -o`, `find -fprint`, `curl -X` rules (§4.3); kind follows the words, the pane follows the tool (§4.3); a `spoken` label form and `Intl.ListFormat` (§4.1, §5.12); child 404 (§6.3); crash and delegation witnesses (§6.2, §5.6); approval tag only on accepted delivery (§2); nothing in logs (§6.2).

## What r3 means for code already built
See §0 of the design: one table, file by file, of what to keep and what to change in feat/1022-steps-view (f1b5cc30cf plus the uncommitted client files).

## r3.1 refresh (rvd-1022-x17-steps, 2026-11-23): dev/1022 6d4b5932a8, build 9c156c2fad, MAIN-RULING 2026-11-21T14:59Z
| Change | Why | Where |
|---|---|---|
| New §3.6: today's Fuigo emits (F1-F18 absent; in_progress only for hosted tools and bash; no retryDiscard/streamStartMs; full-buffer bash output) → what 1.0.22 renders, and what each F-field adds when Fuigo 1.0.48 sends it | MAIN-RULING 14:59Z: render fully with today's emits, light up richer data when present | §3.6 |
| Output-only in-progress updates write no row, frame or detail; the Response comes from the completing frame | Cumulative 100 ms frames would make one command 600 writes and frames (P6) | §3.6 F11, §6.5 |
| `fuigo/incrementalBashOutput` is not set in 1.0.22 | Not today's emit (ruling) | §6.5 |
| Hosted rows close as `no_result` at a retry without `retryDiscard`; `HOSTED_ROW_INTERRUPTED` → `no_result` on both paths | Only the retryDiscard path closes them today (`core.ts:5528`) | §3.6 F13 |
| `rawOutput` is the Response fallback; the completing frame applies before final; `pending` = running; a `failed` after Murage's cancel is held | Today's frame shapes (F10, F8, F5, F4/F16) | §3.6 |
| Confirmed Stop comes from `confirmedStopGenerations`, never from the `cancelled` outcome | Room deadline, watchdog and settings change also settle `cancelled` (`core.ts:~8050`); the build's `index.ts` keyed on it (JOINT RULING) | §0, §3.3 |
| Builder delta re-read at 9c156c2fad; 3 merge conflicts with dev/1022 named with resolutions | The build is on b45d0259e6; dev/1022 moved 332 commits | §0, §11 |
| Fuigo emitter owner: Fuigo coordinator, 1.0.48 (was OPEN NO-OWNER) | Ruling | header |
| GAP-CHECK r3.1 | GAP-CHECK-BAR | §13.1 |
| Independent Opus pass (read-only), all folded in: 1 High (a Stop confirmed after the terminal fold read "Interrupted": rows now held until the receipt or the unconfirmed path), 4 Medium (a late tail subscriber or a restart could release part of a private key; Fuigo closing a hosted row before `retry_state`; a reused id stuck in `interruptedRows`; a non-Stop cancel ending "Failed") | GAP-CHECK-BAR one pass | §0, §3.3, §3.6 F4/F11/F13, §13.1 |
