# UX-L4B slice 2: the Ask panel follows its turn from the server (H3 redesign, 1019)

Why: two reviews blocked H3. The panel decided "our turn ended" from the transcript and the thread's live frames
(busy off, a grace timer, another turn's rows, seenLive). A turn that ran and ended before the panel saw it, or an
earlier turn's late rows landing after our queued question, left it Running forever or Saved too early. Stop inferring.

## Server (slice 1 owns it; NOT built in this lane)
Slice 1's finisher adds an owner-only GET returning `{ state: queued | running | ended | unknown, endedAt? }`;
`unknown` never means ended. The client asks it with threadId, sendId and (once released) our turnId, behind one
provisional `ASK_STATE_PATH`, fixed from slice 1's hand-off on the rebase onto feat/1019-ux-l4b-server. (A lane-local
route drafted at 161cc3354 was withdrawn at the coordinator's word to avoid conflicts.)

## Client
- Done ONLY when the server says `ended` with turnId == our row's `dispatchedIn` (stored as `endedTurn`, so a turn
  restamped after a rebuild is not Done). Terminal rows (ours before a restamp, other turns' late rows) and live frames
  (an unnamed `turn.completed` takes the thread's current id) are hints: they make the panel ask the server at once.
  Removed: `movedOn`, `seenLive`, `seenBusy`, the 4 s grace timer, terminal-row Done, "Stop said not live = ended".
- Following is by VIEW, not phase: queued, starting, running, approval (so `uncertain` with our row found is followed).
  Ask on start, every 5 s, and at once on a hint (live turn or ended flips, busy flips, turnId changes, Stop returns).
  One read in flight, each bounded at 15 s, all aborted on close. The follow key includes our turnId, so a restamp after
  Done follows again.
- Last resort: ONE absolute limit, `ASK_FOLLOW_MS` = 10 min from the Ask's first follow (kept in a ref by gen+sendId, so
  polling, errors, restamps and leaving approval never reset it) sets `lost`; `ended` with no turn sets `lost` too.
  `lost` overrides queued, starting, running and approval: "Open in chat". The 60 s starting timer goes.
- Remove from line: every callback carries its attempt id; a timeout retires the attempt, so a late A never overwrites
  B, nor schedules another DELETE. Stop: its deadline and request use an AbortSignal the unmount cleanup aborts; `patch`
  also checks `gen.current`.
- Copy: `en-help/ask.json` gets the same DASH/SAFE/non-empty/not-in-en.json checks as the en-ux fragments.
- Test HelpAsk.test.ts:95 (and the r1 movedOn case): another turn's rows after ours now stay Running, on purpose.
- Dependency: the turn-scoped Stop (`{turnId}` -> `stopped:false` on a miss, generation captured) is slice 1
  (feat/1019-ux-l4b-server b206d08da, local, not yet on dev). This branch rebases onto it before merge; it is NOT
  re-built here. Until then Stop on base stops the thread, as the hand-off already notes.

The loop is `startFollow()` (pure, fake-timer tested); each follow aborts its own read on cleanup. Remove uses
`attempts()`.

Tests: client follow loop with a fake api
(ended, waiting stays queued, unsure, limit -> inChat, restamp), Remove attempt race, Stop abort on unmount.

## Finisher (11-05, on slice 1 37abf2204)
- Route fixed: GET /api/bots/:id/turn-state?threadId&sendId[&turnId] -> {state, endedAt?}. Slice 1 keys "ended" on the SEND
  and gives it only for a send whose last turn holds rows with nothing of it live or queued (a rebuild reads running/unknown).
- So `ended` is Done even before our row's turn id lands (`endedSend`); with a turn id it is stored as `endedTurn` too, so a
  restamp after the word is followed again. `ended` no longer maps to `lost`.
- 403 (paired phones, follow-up L4B-PHONE-TURNSTATE) and any failed read are unknown: never Done; the 10 min limit hands over.
