# No limits on a routine's follow-through turn (1.0.7)

Sean, 10-25 23:35Z: Kessler (No limits) ran a scheduled routine, handed part of it to a teammate, and when the
teammate's reply came back Kessler's next turn raised a card for `ls`/`tail` on its own files, held as
"This task started outside the desktop" (`unattended-block`).

## Root cause
- The routine's own turn is judged right: `routineRunLevel` gives it origin "routine" at the routine's level,
  and No limits covers it (`fullAccessCovers(bot, "routine")`).
- The turn that resumes the asker after a hand-off (asker wake) is marked unattended whenever the asking turn was
  a routine run: `askerWakeTurnOptions` in server/asker-wake.ts, `intent.unattended || intent.routineRun`.
  The reason (its own comment): once the run has ended, an unmarked turn in that thread would read as the
  owner's own, at the bot's level. Marking it unattended closed that, but it also sends every tool ask of the
  wake to the external-trigger rule, so a mode or grant can never answer it. Log: 23:34:48 delegation reply,
  23:34:50 `claude wake`, 23:35:07 card.
- The wake already carries what the rule needs: the routine ceiling taken when it asked (`routineAuthority`,
  `triggerSource` schedule or manual) and the asking bot's level (`askingMode`). Admission applies both to the
  turn's copy of the bot and records the ceiling in `routinePeerSources`. The permission judge ignores them
  because the unattended mark outranks them.

## The rule
1. External triggers keep the unattended rule unchanged: a webhook, a channel event, words nobody proved were
   the owner's, and any turn handed on from one of those. Their wakes stay unattended (`intent.unattended`).
2. The owner's own routine (scheduled or manual) is not external. Its own turns already run at the routine's
   level with origin "routine". New: the wake that resumes one of its hand-offs is judged the same way, as a
   routine turn, for tool permissions only:
   - level: the lower of the ceiling captured when it asked, the asking bot's level when it asked, and the
     bot's level now (all three already applied at admission; the judge reads `routinePeerSources`, never the
     thread's live run record, so raising a level after the ask never widens the wake);
   - origin "routine": Full access and No limits answer it; Auto answers what Auto answers;
   - what still holds at every level: the key guard, the always-ask commands, unread calls, and the stop line
     (No limits does not lift the stop line for a routine origin, unchanged);
   - none of the routine's own "Always allow for this routine" keys and no routine carve-out (the wake is not
     the run's executing turn, `routineRunGrants`).
3. Everything else the unattended mark drives stays exactly as it is for the wake: the browser refusal, peer
   contact and hand-off rules, auto review, the decision log's `unattended` field, the TTL.
4. Fail closed: the wake keeps the unattended judge when the asking turn was itself unattended, when no
   routine ceiling was captured, or when the ceiling's trigger is not schedule or manual.

## Grok design r1 (REVISE, all three taken)
- The judge reads the ceiling bound to the turn AFTER every admission lowering (asking level, a held replay's continuation level,
  draft-only): `routineWakeByTurn` stores min(routine ceiling, the turn's final level).
- `routineWake` needs `ownRoutine`, set when the wake is registered only if the routine manager records the live run as schedule or
  manual and the ceiling is the routine's own (never `conversationCeilings`, which reads every level as "manual").
- `notOwnerAudience` keeps the unattended judge.

## Change
- asker-wake.ts: `askerWakeTurnOptions` adds `routineWake: true` exactly when `routineRun && !unattended &&
  routineAuthority` (trigger schedule or manual). The `unattended: true` mark itself is unchanged.
- index.ts admission: `routineWakeThreads` records the thread for a turn admitted with `askerWake &&
  routineWake && routineAuthority`; every other admission clears it.
- index.ts permission judge: when the thread is unattended only because of such a wake, tool permissions read
  `unattended: false` and take `routinePeerSources` as the run (routine origin, the ceiling). `routineRunLevel`
  is not read for a wake.
- Tests: the wake options; a routine wake at No limits approves a read-only command; at Auto stays Auto; a
  stop-line hit still holds; a webhook-started routine's wake still blocks; a wake with no ceiling still blocks.

## Project-room routines (NOLIMITS-PROJECT-ROUTINE-107, same rule)
A routine that posts into a project room is queued as a room request marked `unattended: true`
(server/project-routines.ts), so every turn it ran was judged as an outside start and a No limits bot got a card for every command.
- Delivery (index.ts `projectRoutine`): for a scheduled or manual run with no other audience and no channel principal, the ceiling is
  the lower of the routine's level and its bot's level at delivery (`projectRoutineCeiling`). It is kept in memory by room request id
  (`ProjectRoutineCeilings`), only for a request this delivery just created. The row stays `unattended: true` on disk.
- The permission judge: for an unattended ask, `projectRoomRoutineCeiling` finds the room request the asking bot's room turn is
  running (`roomTurnRequests`, state running, same bot and thread) and, when it is a recorded project routine, takes the lowest of
  the delivered ceiling, the routine's level now and the running bot's level now as the routine run. Tool approvals only, exactly as
  a routine wake: the key guard, always-ask commands, unread calls and the stop line still hold; the unattended mark and everything
  else it drives (browser, peer contact, hand-offs, the decision log's `unattended`) are unchanged.
- Keeps asking: a webhook or channel run, a run for another audience, a draft-only bot, a deleted routine, and a request this process
  did not deliver (after a restart the in-memory ceiling is gone, so the row's unattended judge applies).
