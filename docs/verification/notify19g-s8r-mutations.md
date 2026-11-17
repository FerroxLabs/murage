# NOTIFY19g S8R mutation proof

Each mutant was applied to the green head (host, reader, card or pill-window source), the node tests
(host, reader, cross-layer race, pill-window) and, for the renderer mutants, the vitest suites
(attention-ui, pill, float) were run, and the file was restored. Every row must go red in the test(s) the design names (Q7).
Run on build-host in the lane container (no network). Red-first evidence for the new tests on 0199b7c69 is recorded in the
commit message / report: the node suites fail 18 tests there and the renderer suites fail T1, P1, P2, F1, F2.

| # | Mutant | Named killers | Result | Failing tests observed (first six) |
|---|---|---|---|---|
| M1 | host writes record.cards = new Map() before await readItems | H1, H6, X1 | RED (killed) | H1 a push (retainCards) during a pending read supersedes it, mints not; H3 bubble: retainBotKeys + retainCards keeps the bot key and the bot i; H6 (A then B) only the newest concurrent read commits; the older one m; H6 (B then A) only the newest concurrent read commits; the older one m; X1 a retaining push during a pending read keeps the card, its draft an; a pushed refresh that retains card ids keeps the same cardId across in |
| M2 | invalidateWindow does not bump record.seq | H1, X1 | RED (killed) | H1 a push (retainCards) during a pending read supersedes it, mints not; H3 bubble: retainBotKeys + retainCards keeps the bot key and the bot i; H3b bubble: retainBotKeys only keeps the key, the card id is new, and ; H4 rev strictly increases over commits and refused results carry none; X1 a retaining push during a pending read keeps the card, its draft an |
| M3 | host returns superseded where the record is gone | H2, H6c, X2 | RED (killed) | H2 a discard (plain invalidateWindow) during a pending read is reporte; H6c a read pending across a discard cannot commit into the replacement; X2 a privacy invalidation during a pending read blanks the data, empti |
| M4 | retain-one-flag path replaces the record object | H1, H3b | RED (killed) | H1 a push (retainCards) during a pending read supersedes it, mints not; H3 bubble: retainBotKeys + retainCards keeps the bot key and the bot i; H3b bubble: retainBotKeys only keeps the key, the card id is new, and ; X1 a retaining push during a pending read keeps the card, its draft an |
| M5 | reader treats superseded as terminal | R1, T1, P1, F1 | RED (killed) | R1 a superseded read is a wait: nothing is ever published as failed or; R2 a superseded read with no push queued still reads again; R4 dispose during a backoff cancels the timer and reads no more; R4 eight misses publish stalled once, keep data and drafts, then back ; R6 a redacted commit is published even while a push is queued, and dra; R7 under continuous pushes every accepted commit is published and the  |
| M6 | reader does not loop on superseded without a push | R2 | RED (killed) | R1 a superseded read is a wait: nothing is ever published as failed or; R2 a superseded read with no push queued still reads again; R3 a result whose integer rev is not newer than the applied one is rea; R4 dispose during a backoff cancels the timer and reads no more; R4 eight misses publish stalled once, keep data and drafts, then back ; R6 a redacted commit is published even while a push is queued, and dra |
| M7 | reader drops the integer rev check | R3 | RED (killed) | R3 a result whose integer rev is not newer than the applied one is rea |
| M8a | no stall publication | R4 | RED (killed) | R4 eight misses publish stalled once, keep data and drafts, then back ; R6 a redacted commit is published even while a push is queued, and dra |
| M8b | the stall publishes failed | R4 | RED (killed) | R4 eight misses publish stalled once, keep data and drafts, then back  |
| M8c | no self-recovery after the cap | R4 | RED (killed) | R4 dispose during a backoff cancels the timer and reads no more; R4 eight misses publish stalled once, keep data and drafts, then back  |
| M9a | an accepted commit is skipped while a push is queued (coalescing restored) | R6 | RED (killed) | R6 a redacted commit is published even while a push is queued, and dra; R7 under continuous pushes every accepted commit is published and the ; refreshes retain card identity, coalesce pushes into one drain, and pu |
| M9b | drafts not pruned on an accepted commit | R5 | RED (killed) | R5 drafts survive a commit that keeps the cardId, are pruned when it i; R6 a redacted commit is published even while a push is queued, and dra |
| M9c | drafts not emptied on a terminal failure | R5, X2 | RED (killed) | R5 drafts survive a commit that keeps the cardId, are pruned when it i; X2 a privacy invalidation during a pending read blanks the data, empti |
| M10 | AttentionCard keeps text in local state | P2, F2 | RED (killed) | F2 restores a Reply when the bot card is collapsed and chosen again wi; P2 restores a Reply when the stack collapses and expands again with th |
| M11 | pill hideAll and closed pass discard:false | PW1 | RED (killed) | PW1 the real pill surface retains cards on a stack change and discards |
| M12 | invalidateWindow keeps the window's opens AND open() drops the surfaceId comparison | H5 | RED (killed) | H5 a retaining push still spends the old Open and action tokens; H6 (A then B) only the newest concurrent read commits; the older one m; H6 (B then A) only the newest concurrent read commits; the older one m; refresh spends old action and Open tokens; Open cannot answer or cross |
| M13 | items() start does not windows.set a newly created record | H6d, H2 | RED (killed) | H1 a push (retainCards) during a pending read supersedes it, mints not; H2 a discard (plain invalidateWindow) during a pending read is reporte; H3 bubble: retainBotKeys + retainCards keeps the bot key and the bot i; H3b bubble: retainBotKeys only keeps the key, the card id is new, and ; H4 rev strictly increases over commits and refused results carry none; H5 a retaining push still spends the old Open and action tokens |
| M14 | a superseded read mints tokens before its currency check | H6 | RED (killed) | H1 a push (retainCards) during a pending read supersedes it, mints not; H2 a discard (plain invalidateWindow) during a pending read is reporte; H6 (A then B) only the newest concurrent read commits; the older one m; H6 (B then A) only the newest concurrent read commits; the older one m; H6c a read pending across a discard cannot commit into the replacement; a superseded read cannot mint tokens and teardown spends the last gene |
| M14b | a superseded or discarded read mints an Open token before its currency check | H6e-fwd, H6e-rev | RED (killed) | H6e-fwd and H6e-rev, each separately (rev 2.1 re-run) |
| M15 | the focus effect never calls focus() (rev 2.1 wording) | P2 | RED (killed) | P2 restores a Reply when the stack collapses and expands again with th (rev 2.1 re-run) |
| M16 | the reply textarea stays editable while refreshing | keeps a typed reply | RED (killed) | F1d, P1d, T1d, P4a, P4b, P4g (rev 2.1 re-run) |

Note: M2 is also killed by H1 alone; X1 was tightened (the overtaken read must not be published) so it kills M2 too.

Added after Astra r1: M14b (Open tokens minted by a superseded read), M15 (no explicit Reply focus), M16 (textarea editable while refreshing).

## S8R rev 2.1 (Reply focus and draft ownership)

M10, M14b, M15 and M16 above were re-run on the rev 2.1 head (M10 now removes the reader as the draft owner). Each mutant below was applied
to the green rev 2.1 head, the node suites (host, reader, race, pill-window) and the vitest suites (attention-ui, pill, float) were run,
and the file was restored. Every row went red in the tests the design names (D5).

| # | Mutant | Named killers | Result | Failing tests observed (first six) |
|---|---|---|---|---|
| M14c | a superseded read mints an Open token whenever record.surfaceId is set (against the current surface) | H6e-rev only | RED (killed) | H6e-rev superseded reads mint no Open tokens, completing newest first (forward order never sees it) |
| M17 | reader publishes {data:null} on superseded before re-reading | R1d, T1d, P1d, F1d | RED (killed) | R1, R1d, R4, X1, F1d, P1d, T1d |
| M18 | Reply-start writes the captured text instead of latest.current | P3 | RED (killed) | P3 keeps words typed while the focus request is pending |
| M19 | Reply-start calls focus() directly after the await, bypassing both intent checks | P5 | RED (killed) | P5 focus moved elsewhere during the focus request is not stolen back |
| M20 | blur-with-relatedTarget cancel (D2.1) and focusin cancel (D2.2) both removed | P4a, P5 | RED (killed) | P4a, P5 (D2.1 has no killer of its own, by design) |
| M21 | focusin cancel removed (D2.1 kept) | P5, P4a | RED (killed) | P4a, P5 |
| M22 | pointerdown cancel removed | P4b | RED (killed) | P4b a click on a non-focusable area during a refresh is not undone by recovery |
| M23 | every blur cancels (locked null-relatedTarget too) | P4g | RED (killed) | P4f, P4g |
| M24 | unlocked, document-focused null-relatedTarget blur does not cancel | P4e | RED (killed) | P4e guard: blurring to nowhere |
| M25 | null-relatedTarget blur cancels while document.hasFocus() is false | P4f | RED (killed) | P4f switching windows keeps the place in the field across a refresh |
| M26 | focusin on this card's Reply button cancels | P6 | RED (killed) | P6 guard: the window handing focus back to the Reply button |
| M27 | restoration mints an intent (the effect focuses a restored draft) | P2 | RED (killed) | P2 (also P4a, P4b, P4e, P6) |

Red evidence for the new tests. On 8354a974 (rev 2, only the tests applied): P3, P4a, P4b, P4f, P5 fail on behavioural assertions
(P3: expected 'Draft survives' to be 'Draft survives, edited'; P4a and P5: expected the textarea to be the outside input; P4b: expected the
textarea not to be the active element; P4f: expected the textarea to be the active element, got body); P4e, P4g, P6 are green there.
On 0199b7c69 the coverage tests fail: R1d, T1d, P1d, F1d (P2, P3, P4a, P4b, P4f, P4g, P5, P6 and F2 also fail there, the draft and focus
rules not existing yet). H6e-fwd and H6e-rev are green on 0199b7c69 and 8354a974 by construction (the host already mints nothing for a
superseded read); their red evidence is M14b (both) and M14c (rev only).

## S8R rev 2.2 (async continuations own what they write)

Each mutant was applied to the green rev 2.2 head (AttentionCard.tsx only), the node suites (host, reader, race, pill-window) or the vitest
suites (attention-ui, pill, float) were run, and the file was restored. Every row went red in the tests the design names (E3). M30 went red
in P8 and in P8t separately. M10, M15, M16 and M18-M27 were re-run on the rev 2.2 head and all stay red.

| # | Mutant | Named killers | Result | First failing tests observed |
|---|---|---|---|---|
| M28 | startReply's ownership ignores `mounted` | P7 | RED (killed) | P7 a deferred Reply on an unmounted card writes nothing after a remount |
| M29 | startReply's ownership ignores `replyReq` (request currency) | P8, P8t | RED (killed) | P8 an obsolete refusal ...; P8t an obsolete throw ... |
| M30 | ownership checked only on the success path (refusal and throw fall back unconditionally) | P8 and P8t | RED (killed) | P8 an obsolete refusal ...; P8t an obsolete throw ... (each separately) |
| M31 | `open()` reads the closure's `item.openToken` instead of `itemNow.current` | P8f | RED (killed) | P8f an owned refusal after a token refresh falls back to the current Open authority |
| M32 | the `replyTyping`-off fallback does not cancel the intent | P9 | RED (killed) | P9 the Reply-typing-off fallback cancels the focus intent |
| M33 | `answer`'s refusal/catch `setError` is not guarded | P10 | RED (killed) | P10 a stale act refusal after a token refresh shows nothing |
| M34 | `open`'s refusal/catch `setError` is not guarded | P11 | RED (killed) | P11 a stale Open refusal after a token refresh shows nothing |
| M35 | every post-await guard also requires "no refresh since start" (over-guarding) | P8f | RED (killed) | P8f an owned refusal after a token refresh falls back to the current Open authority |
| M36 | the successful act's clear and `onAnswered` are guarded by `mounted` | P12 | RED (killed) | P12 guard: a successful act still clears the draft and refreshes after the pill collapsed |
| M18 | the success draft write uses a closure `text` | P3 | RED (killed) | P3 |
| M19 | Reply-start focuses the field directly after the await | P5 | RED (killed) | P5 |
| M20 | D2.1 and D2.2 cancels removed | P4a, P5 | RED (killed) | P4a, P5 |
| M21 | focusin cancel removed | P5, P4a | RED (killed) | P4a, P5 |
| M22 | pointerdown cancel removed | P4b | RED (killed) | P4b |
| M23 | every blur cancels | P4g | RED (killed) | P4f, P4g |
| M24 | unlocked null-relatedTarget blur does not cancel | P4e | RED (killed) | P4e |
| M25 | null-relatedTarget blur cancels while the window is unfocused | P4f | RED (killed) | P4f |
| M26 | focusin on the Reply button cancels | P6 | RED (killed) | P6 |
| M27 | restoration mints an intent | P2 | RED (killed) | P2 (also P4a, P4b) |
| M10 | AttentionCard keeps text in local state | P2, F2 | RED (killed) | F2, P12, P2 |
| M15 | the focus effect never calls focus() | P2 | RED (killed) | P2, P3, P4a |
| M16 | the reply textarea stays editable while refreshing | keeps a typed reply | RED (killed) | F1d, P1d, P4a |

Red evidence for the new tests on fd1997285 (only the tests applied, behavioural assertions): P7 `expected 'Draft survives' to be 'Edited after
remount'`; P8 and P8t `expected [ 'focus', 'fresh-focus', 'open' ] to deeply equal [ 'focus', 'fresh-focus' ]`; P8f `expected [ 'focus', 'open' ]
to deeply equal [ 'focus', 'fresh-open' ]`; P9 `expected <textarea> not to be <textarea>` (the effect refocuses the field); P10 and P11
`expected 'That request changed. Open it in Mura...' to be null`. P12 is green there (its red evidence is M36).
