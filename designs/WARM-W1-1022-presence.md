# WARM W1 1.0.22 ADDENDUM: warm engines follow OWNER PRESENCE (design-1022-warm-presence, r2)

Addendum to the AGREED warm engine design W1 r3.5 (designs/WARM-W1-1022-r3.5.md, design/1022-warm-r35 516ce12b49, ASTRA + FABLE
AGREE) and to MAIN-RULING warm-active-only 2026-11-22T04:30:19Z (int-1021-n4/QUESTIONS-FOR-MAIN.md). It reopens NO agreed row: every
r3.5 rule, Sean D1 G1-G5, D2 S1-S3, the flag `warm.s2r` (default OFF) and the warm-active-only ruling stay as written. This file only
ADDS rows: P-SIG, P-AWAY, P-KEEP, P-PRE, P-FENCE and witnesses W-PR1..W-PR7. Where this file and r3.5 seem to differ, r3.5 wins, except
that this file may REMOVE warmth (retire an engine sooner, or skip a speculative start). It never adds reuse: r2 PARKS the r1 mounted
pre-warm (old P-PRE 7), so the S1 guard (claude.ts:6932, codex.ts:3300) is untouched and no new process enters r3.5 `qualifying`.
ONE PLACE THIS FILE KEEPS A PROCESS OUTSIDE RULING ITEM 1 (Sean's instruction (C), "open the chat and it is warm"): an UNCLAIMED
pre-warm for the chat he just opened, for at most 120 s after his last open/typing beat (P-PRE 5). Nothing else is kept for a bot
without an owner turn. Code read at hub dev/1022 b45d0259e6 (the warm1022-* builders' base) and warm1022-driver 38cebb4cde.
Design only: nothing built or run.

r2 closes ASTRA-DESIGN 9dddafd19b (BLOCK 2H 3M) and FABLE-DESIGN 9dddafd19b (BLOCK 1H 4M); see R2 CHANGES at the end.

## OWNERS (each side of every contract)
| side | owner |
|---|---|
| Presence signal (new server/owner-presence.ts), its wiring in index.ts handleRequest / turn start and settle / POST /api/presence, desk `state` field and post queue (electron/desk-presence.mjs, server/mobile-presence.ts parsePresenceBody), chat-open trigger and gesture flag (src/hooks/use-warm-intent.ts), prewarm limiter and hold (warmThread in index.ts, /typing trigger with threadId check), witnesses W-PR1..W-PR7 | NEW slice **warm1022-presence** (one builder lane, seated by MAIN) |
| PRE-DETACH row (P-FENCE 2-3): `abandon(threadId)` on the prewarm gate (warm-pool.ts createPrewarmGate :95) and its callers in the drivers: the send takeover (claude.ts:4334-4347, codex.ts:753-765) and the teardown waits on the gate (claude.ts:7315, codex.ts:3385). An abandoned pre-warm leaves the thread slot at once and finishes its close on the driver's existing replaced-predecessor path (claude.ts `retiringByThread` :3637; the Codex equivalent) | **warm1022-presence** writes the hunks, stacked on warm1022-driver (Claude + gate) and warm1022-codex (Codex) tips; **warm1022-driver** reviews the claude.ts and warm-pool.ts hunks, **warm1022-codex** reviews the codex.ts hunk |
| Door launch proof on POST /api/bots/:id/warm and /typing: `launchProofHeaders` (companion/src/routes.ts:204-210), which BOTH the browser door (:282-285) and the device door (:310-313) call | **warm1022-presence** |
| Pool hooks the presence slice adds in server/drivers/warm-pool.ts: `ownerAway(cause)`, the presence gate at the top of `enforce()` and in `markIdle()`, the admission epoch on unclaimed pre-warms, the prewarm hold length, the no-evict-owner-engine prewarm admission, `moveIntent` (:427-432) limited to unclaimed pre-warms | **warm1022-presence** writes them, stacked on warm1022-driver's tip (see SEAM); warm1022-driver reviews the seam |
| Per-bot keep set (MAIN-RULING warm-active-only items 1-5), E1 spare limit 3 per kind, E2/E3, pool budget and LRU order, driver DECISIONS D2 intent-hold exemption | **warm1022-driver** (unchanged; r3.5 OWNERS row "Warm pool"); presence shortens the D2 hold to 120 s through the hold-length hook only |
| S1 mounted pre-warm guard (claude.ts:6932, codex.ts:3300) | **warm1022-driver** / **warm1022-codex**, UNCHANGED by this addendum (r1 PRE-MOUNT row withdrawn) |
| Memory rules (C-R*, D-R*, W-LMB) | **warm1022-memory** (unchanged; this addendum adds no memory row) |
| Codex engines in the shared pool | **warm1022-codex** (presence reaches them through warm-pool.ts; the only Codex code change is the PRE-DETACH hunk) |
| ACP parking outside warm-pool.ts, if design-1022-grokwarm lands it (contract C7 below) | design-1022-grokwarm Side M builder (still **OPEN NO-OWNER GROKWARM-1022 Murage builder**, carried from grokwarm) |
| Rulings: Q-PR1 (lock rule while the phone is used), Q-PR2 (N = 120 s), Q-PR3 (mounted bots cold on first open) | Sean via MAIN |

SEAM (warm1022-presence <-> warm1022-driver): warm1022-presence branches from `fix/1022-warm1022-driver` at its newest PUSHED sha
(38cebb4cde at the time of writing; it merges driver's later tips itself under the merge-train rule). It owns ONLY the hunks named in
its OWNERS rows. warm1022-driver owns everything else in warm-pool.ts and claude.ts. The keep predicate is one expression, and each
slice owns its own term:
`kept(engine) = present() [presence] AND ( botOwnerTurnWithin15(bot) [driver, ruling 1/3] OR (unclaimedPrewarm(engine) AND
now - lastIntentBeat(thread) < PREWARM_HOLD_MS) [driver D2 exemption, hold length set by presence] ) AND oneper-bot/3-per-kind/budget/LRU [driver]`.
Driver D2 already exempts an intent-held engine (warmIntent(threadId, bot.id)); presence only shortens that hold from the 15-min window
to 120 s and makes it unclaimed-only. `botOwnerTurnWithin15` is the driver's term and is never fed by intent (P-KEEP).

## PURPOSE
Warm engines exist only while Sean is actually using Murage. While he is away, no engine process is kept. While he is present, only
the bots he is using stay warm. When he opens a chat, its engine starts before he sends, so the first reply is not a cold start.

## USER PROMISES
- PP1 AWAY = ZERO: after 15 min with no owner input anywhere in Murage (desktop app, browser door, phone app) and no owner turn in
  flight, or at the moment the desktop locks or sleeps, every idle warm engine is retired and none is kept. A routine or scheduled job
  then runs on a cold single-use background engine that is retired at its settle (r3.5 E2, unchanged).
- PP2 PRESENT = ONLY WHAT HE USES: while present, the kept set is exactly MAIN-RULING warm-active-only: one engine per bot with an owner
  turn in the last 15 min, at most 3 per engine kind, inside the pool budget min(25% RAM, RAM - 6 GB), least-recently-active retired
  first. Opening a chat or typing in it is NOT an owner turn and does not earn a kept engine (only the 120 s pre-warm of PP3).
- PP3 PRE-WARM: opening a bot chat or typing in it, when that bot has no warm engine, starts one in the background, so the first send
  usually finds it ready. If he sends nothing within N = 120 s of the last open/typing beat, leaves for another chat, or goes away, the
  pre-warm is cancelled and retired; typing again later starts a new one (within the limits). This covers UNMOUNTED turns (draft-only
  Claude, Codex with no integrations). A bot with tools or connectors (a mounted turn) is never pre-warmed by this addendum: its
  first turn after opening the chat is cold, as today, whatever `warm.s2r` says (Q-PR3).
- PP4 NEVER IN THE WAY: presence and pre-warm never refuse or reword a turn, and never make a send wait for a cancelled or failed
  pre-warm. A send that finds a LIVE pre-warm still starting takes it over when it is ready: that process started before the send,
  so it is ready no later than the cold start it replaces would be. Only a HUNG pre-warm (still not ready PREWARM_WAIT_MS = 20 s after
  its OWN spawn, the driver's existing bound, now counted from the pre-warm's spawn instead of the send) is abandoned, and the send
  then runs at once on a fresh cold spawn while the old process closes on its own; a pre-warm never makes a send fail. A skipped or cancelled pre-warm only means a cold start (No limits; MAIN-
  RULING local-memory-budget). No new prompt, card, setting or button.
- PP5 PRIVATE: presence is computed on the machine that runs the server, kept in memory only, never written to disk, never sent to
  Murage Cloud, the control plane or any other service, and logged without content (no telemetry).

## P-SIG: the presence signal (warm1022-presence)
One in-memory clock, `OwnerPresence` (server/owner-presence.ts, injectable `now`, same shape as OwnerIdleClock). It is separate from
OwnerIdleClock, which keeps its VACUUM meaning unchanged.
1. COUNTS AS OWNER INPUT (any one of these sets `lastInput = now`):
   (a) an HTTP request for which `countsAsOwnerAction(method, url)` (server/owner-activity.ts:16, unchanged) is true AND that arrives on
       an OWNER surface: `requestSurface(...) === "desktop"` (the desktop renderer's per-launch proof, and an owner-signed browser tab or
       Cloud phone, as route-policy.ts:15/581 already classify) OR `companionAuthorized(headers)` (the phone app's workspace
       WebView, companion-authority.ts:29). This covers sends, edits, card answers and settings changes, plus POST
       /api/bots/:id/typing (composer beats; a key press is a real gesture) from the desktop AND the phone, because the phone runs the
       same web UI (Composer.tsx:444 -> use-warm-intent.ts).
       POST /api/bots/:id/warm counts ONLY when its body carries `gesture: true`. The client sets it from
       `navigator.userActivation.isActive` (true only within seconds of a real click, tap or key; a renderer reload, an app relaunch
       that restores the last chat, or a programmatic window focus never grants it) AND `document.hasFocus()`. Where
       `navigator.userActivation` is missing, the client sends `gesture: false` (fail closed). A /warm without the gesture still warms if
       he is ALREADY present, but never makes him present (P-PRE 2: reason `away`).
       ON A LOCAL INSTALL the doors stamp the launch proof (`x-murage-companion-token`) only on owner-voice / owner-decision routes
       (`launchProofHeaders`, companion/src/routes.ts:204-210, shared by the browser door :282 and the device door :310), so today a
       phone's /warm and /typing arrive WITHOUT it (requestSurface "remote", sse-visibility.ts:246, companionAuthorized false), and
       would not count. Fix: add POST /api/bots/:id/warm and POST /api/bots/:id/typing to the routes `launchProofHeaders` stamps
       (low-impact routes: they only warm and hold; no content, no decision); both doors get it through that one function. On Murage
       Cloud home the owner-phone scope already reads "desktop" (sse-visibility.ts:243).
   (b) an owner-origin turn start (`isOwnerOrigin(origin)`, store.ts:336 = desktop | companion only, and not automationSource /
       cardContinuation / unattended, the same predicate as index.ts:16407). This predicate is NOT widened: a comms-channel or
       "unproven" sender never makes Sean present.
   (c) the SETTLE of such an owner-origin turn (reply delivered or the turn ended), and PRESENT holds while one is in flight (rule 4).
       A turn Sean is waiting on is presence: a 20-min turn he watches without clicking must not settle into "away" and lose its
       engine at once (ruling item 1). The lock edge still wins (rule 3): an owner turn running at a lock finishes, and its engine is
       retired at settle unless input after the lock made him present again.
2. NEVER COUNTS: GET/HEAD/OPTIONS, SSE, POST /api/presence beats (desk or tab, BACKGROUND_WRITES), the other BACKGROUND_WRITES
   routes, /warm without `gesture: true`, routines, schedules, memory and recall work, card continuations, member or guest turns,
   push-relay or control-plane calls, any request not on an owner surface. Keyboard or mouse use OUTSIDE Murage does not count: the
   desk "active" beat (desk-presence.mjs, 120 s OS idle) stays a notification signal only. Sean said input "in Murage".
3. AWAY EDGES (set `lastInput = -Infinity` and fire P-AWAY at once):
   (a) the desktop reports the machine locked or asleep. desk-presence.mjs (Electron main process; the same code on macOS, Windows and
       Linux) already computes `locked` / `asleep` (deskState). Its POST /api/presence body gains an OPTIONAL `state: "locked" |
       "asleep"`, sent only with `visible: false`. It is posted on EVERY transition into locked or asleep, also from idle (today
       desk-presence.mjs:96-99 posts only when the present boolean flips, so an idle-then-auto-lock machine would post nothing).
       QUEUE: the post queue (desk-presence.mjs:54-77, today one boolean `next = visible`) carries `{visible, state}`; a later flush
       never drops a pending `state` (a `state` report is coalesced only with a newer `state` report). UNLOCK / RESUME always post
       (with no `state`), even while idle, so P-SIG 5 has its trigger. A LOST EDGE (post error, or `suspend` froze the process before
       the POST landed) falls back to the wall-clock rule 4: he reads away at most 15 min after his last input, and on the first
       check after wake. parsePresenceBody accepts the key set `clientId,seq,state,visible` only with that value set and visible
       false. The server takes `state` only from `requestSurface === "desktop"` (the Electron main process's report), and ignores it
       from a companion or tab. Older bodies are unchanged.
   (b) a server start: presence starts AWAY (memory only, like Presence in mobile-presence.ts). Nothing is pre-started at boot.
   LOCK IS AN EDGE, NOT A STATE (Q-PR1): the lock retires everything at that moment. Owner input after it, for example Sean using
   the phone app while the desktop stays locked, makes him present again under rule 1. A sticky lock would make every phone turn cold
   while he is out.
4. PRESENT = (`now - lastInput < W`) OR (an owner-origin turn is in flight and no away edge has fired since it started), where W is
   the pool's activity window (warm-pool.ts:54, 15 min, same env override MURAGE_WARM_ACTIVITY_WINDOW_MS). AWAY otherwise. Wall-clock
   based, so a machine that slept 2 h reads away on its first check after wake.
5. WAKE CHECK: a desk report with no `state` after a lock or sleep (unlock or resume), and any input, runs `warmPool.tick()` once. The
   pool's 15-min timer is a setTimeout that can fire late after OS sleep, so wake must not wait for it.
6. LOGS (content-free, on change only): `presence warm state=present cause=input|turn` and
   `presence warm state=away cause=idle|locked|asleep|restart`. No bot, thread, route, client id or text.
7. MURAGE CLOUD HOME: there is no desktop and so no lock/sleep edge. Presence there is owner input from the owner phone/browser scope
   (rule 1) and owner turns only, with the 15-min wall-clock rule.

## P-AWAY: away retires everything (warm1022-presence, hook in warm-pool.ts)
- `warmPool.ownerAway(cause)`: bump `presenceEpoch`, clear every intent hold, evict every IDLE member with reason `owner away <cause>`,
  and ABANDON every unclaimed pre-warm still spawning (P-FENCE 2). Busy engines are never killed mid-turn (warm-pool.ts:4, unchanged).
  An owner turn running at the lock finishes, and its engine is retired at settle (unless he is present again then, P-SIG 1c/4).
- While away, `markIdle()` closes every member at once with reason `owner away` (owner engine, borrowed owner engine, background
  engine, pre-warm). `enforce()` starts with the same gate, so nothing survives a tick while away. Retirement uses each driver's
  existing close path (confirmed teardown and generation retire, r3.5 R8/F8), and nothing new is added there.
- ROUTINES WHILE AWAY: there is no idle owner engine to borrow, so a routine dispatch spawns cold. The r3.5 E2 rules apply unchanged
  (own native session, cursor publish guard), and its settle closes the engine (`background turn`, or `owner away` if markIdle runs
  first). A routine never counts as input (P-SIG 2), so it can never make the owner present.
- Every pre-start path (today warmThread "intent"; the "rearm" cause has no caller at b45d0259e6 but is gated the same way) returns
  `started: false` while away.

## P-KEEP: present composes with the ruling (no new keep rule)
While present, the kept set is exactly warm1022-driver's MAIN-RULING warm-active-only set plus the 120 s unclaimed pre-warm (SEAM).
- An intent hold (focus, chat open, typing) is NOT an owner turn. It never adds a bot to `botOwnerTurnWithin15`, matching the
  existing comment at index.ts:15549 ("Intent is not a user turn").
- An intent hold on a bot that IS active keeps renewing that bot's engine as today. On a bot with no owner engine, it holds only an
  unclaimed pre-warm, under P-PRE's 120 s hold.
- With `warm.s2r` OFF (the default), mounted Claude/Codex/Fuigo turns are single-use (r3.5 W-FLAG), so after a turn nothing mounted is
  kept anyway. Whatever the flag, no mounted turn is pre-warmed: the S1 guard (claude.ts:6932, codex.ts:3300) stays exactly as it is,
  because a process spawned before any admitted turn (no generation, no bootstrap ticket) is a new entry into r3.5 `qualifying`
  that D1 G2/G3 never exercised on a real CLI (P-PRE 7, Q-PR3).

## P-PRE: pre-warm trigger and its thrash limits (warm1022-presence)
1. TRIGGERS: (a) NEW chat open: useWarmIntent calls `warmIntent(botId, threadId, {gesture})` once when the composer mounts with a bot
   and thread, or when the thread changes, in addition to the existing window focus and typing triggers. (b) Typing: POST
   /api/bots/:id/typing gains the body `{threadId}` and checks it exactly as /warm does (`botByThread(threadId) === bot.id`,
   index.ts:40754; a thread of another bot, or a missing thread, means no hold and no start). It then calls the SAME warmThread path as
   /warm (today it only renews ownerFirst, index.ts:40759): it renews the hold of an existing pre-warm, and when the thread's bot has
   no engine (for example the 120 s hold lapsed while he paused a long draft) it starts a new one under rules 2-4. Beats come every
   5 s (TYPING_BEAT_MS). The desktop and the phone share this code.
2. START ONLY IF all of these hold, else renew the hold only and log `prewarm skipped reason=<r>`, content-free: present (a typing beat
   or a gesture /warm has just made him present unless a lock raced it; reason `away`); the thread's bot has no live or idle engine on
   the instance its next turn resolves to (reason `warm`); the thread is not tainted (unchanged rule, index.ts:15561); the next turn is
   not mounted (reason `mounted`, the S1 guard's answer, unchanged); the limits in 3 allow it (reason `rate`); and admission in 4
   allows it (reason `budget`).
3. LIMITS (server side; the client's 60 s gap, use-warm-intent.ts:14, stays): at most ONE pre-warm start per thread per 60 s (a
   phone and a desktop open of the same chat, or a lapse-and-retype within 60 s, start once); at most THREE pre-warm starts across all
   bots in any rolling 60 s; at most ONE unclaimed pre-warm per engine kind (the existing `intent-moved` eviction, warm-pool.ts:427-431:
   opening another chat retires the previous unclaimed one). Over a limit means no start, and the send still runs, cold.
4. ADMISSION: a pre-warm is speculative, so it NEVER evicts an engine that has settled an owner turn (`ownerOrder.has`) to make room.
   If `poolBytes + averageBytes > budget`, or free memory is under the floor, after evicting only unclaimed pre-warms, it is skipped
   (`budget`). A real turn's spawn keeps `beforeSpawn` unchanged (never refused).
5. HOLD AND CANCEL (N = 120 s, Q-PR2): an unclaimed pre-warm (`hold: true`, no send yet) is held for `PREWARM_HOLD_MS = 120_000` from
   the last open/focus/typing beat on its thread, not for the 15-min window (warm-pool.ts:553/593 today; driver D2's exemption). It is
   retired `prewarm unused` when the hold lapses, `intent-moved` when he opens another chat of that kind, and `owner away` on P-AWAY.
   A send claims it (`warmPool.sent`, unchanged). The claimed engine then follows P-KEEP like any owner engine.
6. Pre-warm counts toward the 3-per-kind cap and the pool budget like any idle member. `moveIntent` (warm-pool.ts:427-432) today
   evicts EVERY idle member of the kind on another thread, owner engines included. It is limited to UNCLAIMED pre-warms (`hold` and
   not in `ownerOrder`), so focusing or opening chat C never closes the kept engines of active bots A and B (ruling items 1-2).
7. MOUNTED PRE-WARM: PARKED in r2 (FABLE H1, ASTRA M3b). The S1 guard is unchanged, so with `warm.s2r` OFF or ON a mounted bot's
   first turn after opening its chat is cold. Lifting it later needs its own default-OFF switch, a real-CLI "pre-warm a mounted bot,
   then send, report `process=reused` with every mount relisted" step in the W-MAC and W-WIN-R scripts, and a `prewarm-qualify`
   failure reason that never counts toward the r3.5 R3 back-off. That is a separate design for Sean (Q-PR3), not this addendum.
8. NO REMEMBERED INPUTS: a driver pre-warm is a no-op when the thread has no remembered last-turn inputs (claude.ts:6926, codex.ts:3296),
   for example after a server restart. The first open after a restart is cold (PARKED; it would need persisted spawn inputs).

## P-FENCE: in-flight starts, detach, and the epoch (warm1022-presence)
1. ADMISSION EPOCH: warmThread records `presenceEpoch` synchronously when it ADMITS a pre-warm (before its first await, so before the
   driver's `prewarming.begin`). On `markIdle()`, an UNCLAIMED pre-warm whose admission epoch is older than the current one is closed
   with reason `owner away`, even if he is present again by then. This closes the one window ownerAway's abandon cannot reach: an away
   edge that lands after warmThread admitted the pre-warm but before the driver registered it on the gate. Owner turn engines carry
   no epoch rule: at their settle the away gate (if away) or the driver's ruling (if present) decides.
2. DETACH, NEVER WAIT ON A CANCELLED PRE-WARM (PRE-DETACH row). The prewarm gate gains `abandon(threadId)`: it ends the gate entry at
   once (so `prewarming.has(threadId)` is false and any waiter resolves), marks the token abandoned, and the driver moves the
   pre-warm OFF the thread's slots at once: on Claude its reservation in `active` and its session in `sessions` (claude.ts:5700) go
   to the existing replaced-predecessor path (`retiringByThread`, :3637-3652); on Codex its `retained` entry (codex.ts:1770) and its
   `active` entry go to `closeProcess` / `closingProcs`. In both, abandon ends the process tree AT ONCE (`killCliTree`, as
   `retireSession` does, claude.ts:3758), not after the stdin grace (:3733), so the abandoned process and the send's fresh
   `--resume`/thread-resume process overlap only for the kill, and the abandoned one never received input (it is unclaimed, so it
   appended nothing to the native transcript/rollout; W-PR6 (a) checks this). A late spawn or settle of an abandoned token never
   writes back into `active`, `sessions`, `retained`, the pool or the gate (token check, like `prewarming.current`). ownerAway
   abandons every unclaimed spawning pre-warm. A send on that thread then finds no pre-warm and free slots and dispatches at once on
   a fresh cold spawn. The Codex rule "nothing new starts beside a process that would not stop" (codex.ts:767-772 `stuck`) stays as
   it is: it applies only if the killed tree is still not confirmed stopped past its existing deadline (the r3.5 inherited case).
   The teardown waits on the gate (claude.ts:7315, codex.ts:3385) then wait on the retiring/closing record (deletion holds stay
   confirmed), never on an abandoned gate entry.
3. CLAIM, BOUNDED ONLY AGAINST A HANG: a send on a thread whose pre-warm is LIVE (not abandoned, not failed) and still starting
   waits for it until it is ready (then claims it) or fails (then runs cold at once), or until the pre-warm has been starting for
   PREWARM_WAIT_MS (20 s, existing constant and env MURAGE_PREWARM_WAIT_MS) counted from the PRE-WARM's spawn, not from the send.
   Past that it is hung: the send abandons it (rule 2) and runs cold at once, in place of today's takeover (TAKEOVER_BOUND_MS 10 s
   and TAKEOVER_FAILED_MESSAGE). A fixed short bound would be WRONG: a send 1 s after opening a chat whose pre-warm needs 5 s would
   wait 3 s, abandon, and cold-start, slower than both waiting and no pre-warm. The send never fails because of a pre-warm. A Stop or
   close of a REAL turn keeps today's rules (unchanged).
4. A pre-warm that a send has already claimed (busy) is never cancelled. P-AWAY touches only idle members and unclaimed
   still-spawning pre-warms.

## MEMORY / FENCE RULES (MAIN-RULING local-memory-budget, r3.5 W-LMB)
- The pool budget (min(25% RAM, RAM - 6 GB)) is a PROCESS memory ceiling, not a local-memory store budget. This addendum makes it
  tighter only by retiring idle engines and skipping speculative starts. Nothing here stops, refuses, truncates or rewords an owner
  turn or its reply; the only wait it allows is the PP4 claim of a live pre-warm that started before the send.
- No memory store, recall or deletion rule changes. A retired engine's native session follows r3.5 unchanged (a cold turn resumes,
  resumed=true, unless a memory rule resets it). Pre-warm keeps the existing fence (checkPrewarmFence, index.ts:15566) and the taint rule.
- Not an engine: the memory helper model (memoryWorker.warmForIntent) is outside this addendum (PARKED).

## CONTRACT C7 (with design-1022-grokwarm)
If grokwarm unparks ACP reuse with parking OUTSIDE warm-pool.ts (acp/core.ts), that parking must subscribe to
`ownerPresence.onAway(cause)` and to `present()` at park time, with the same retire-at-idle and epoch rules. Parking inside warm-pool.ts
gets presence with no extra work. Owner: grokwarm Side M (OPEN NO-OWNER, carried). Until then ACP stays parked (r3.5), so no ACP
engine is kept and there is nothing to retire.

## FLAG AND SEAN D1/D2
- No new flag. P-SIG, P-AWAY, P-PRE limits and P-FENCE are ON by default because they only remove warmth or shorten a wait (fail
  closed to cold). `warm.s2r` stays default OFF, and its meaning, gate record and MAIN's flip are unchanged. Presence never lifts
  INT-CONFLICT-DEFAULT. The S1 guard is unchanged, so no D1 gate gains a new path.
- D1 G1-G5 unchanged. G2 (W-MAC >= 4 turns reused+resumed) runs with the owner active and the machine unlocked, so presence is present
  throughout. The W-MAC script must not lock the machine between turns (one added note for MAIN's relay script; no gate change).
  D2 S1-S3 unchanged.
- Test-only env: MURAGE_WARM_ACTIVITY_WINDOW_MS (existing) also scales W; MURAGE_PREWARM_WAIT_MS (existing) scales the hang bound.
  New, tests only: MURAGE_WARM_PREWARM_HOLD_MS (1 s..120 s) sets N.

## TEST PLAN (warm1022-presence; W-PR1..W-PR4 and W-PR7 are RED on b45d0259e6 or on the driver tip they stack on and GREEN on the presence tip; W-PR5/W-PR6 guard new code and are proved by mutants; each mutant targets one assertion and its receipt cites that assertion's file:line; receipts.tsv + machine check per THRUST-RULES)
| id | witness (real server + fake CLI fixture engines, real warm pool, real driver prewarm gate, injected clock; no mock of warm-pool, owner-presence or the gate) | RED on base because | mutant -> RED cell |
|---|---|---|---|
| W-PR1 away 15 min -> 0 engines | (a) owner turns on bots A, B (desktop surface) then nothing; desk "active" beats every 30 s, phone GETs continue, AND an idle real renderer session: the app shell rendered in jsdom with its real hooks (presence, SSE reconnect, warm intent) under fake timers for W + 1 min, every request it makes forwarded to the server; at W + 1 s: idleCount() == 0, both fixture pids gone, log `presence warm state=away cause=idle`; and every non-GET the idle session sent is in BACKGROUND_WRITES (spy on the real fetch, listing routes). (b) owner turn on A, owner focuses chat C (intent, no send), then desk reports `state: locked`: idleCount() == 0 within one tick, C's hold cleared, `cause=locked`. (c) same with `state: asleep`, then clock + 2 h, then a resume report: tick runs, 0 kept. (d) after (b), a POST send from the phone through the real door forward function makes him present: that turn's engine is handled by P-KEEP (kept), so lock is an edge. (e) away; the composer mounts and the window gains focus with NO user activation (programmatic focus / reload): /warm goes out with `gesture: false`, he stays away, 0 engines, `prewarm skipped reason=away`. (f) an owner turn on A that runs W + 5 min with no other input settles; at settle + 5 min A's engine is still kept (driver rule decides), `cause=turn`. (f') during that turn, at W + 1 min, the composer of chat C mounts with `gesture: false`: the pre-warm starts (present because an owner turn is in flight), not `reason=away` | (b)/(c): base keeps engines until the window and keeps intent-held C even when inactive (warm-pool.ts:476); (e): base has no gate and warms on focus; (f): base has no presence (the cell is RED against M-PR1f only) | M-PR1a ignore desk `state` -> (b) RED; M-PR1b P-AWAY keeps intent-held members -> (b) C RED; M-PR1c count desk presence beats as input -> (a) RED; M-PR1d lock sticky until unlock -> (d) RED; M-PR1e /warm counts without gesture -> (e) RED; M-PR1f1 no stamp at owner-turn settle -> (f) RED (A closed `owner away` at settle); M-PR1f2 no in-flight presence -> (f') RED (`reason=away`) |
| W-PR2 routine while away -> cold single-use, 0 kept after | owner turn on A, then lock (away). Routine on A with the SAME warm key at +2 min: the routine logs a fresh spawn (no `reused`), reason `background single-use`/cold, own session (stored owner cursor byte-identical, r3.5 W-P1 rule). After settle idleCount() == 0, routine pid gone, presence still away. (b) idle-away (W + 1 s), routine at W + 5 min: same, and `present() === false` after it | base: the lock does not retire A's owner engine, so the same-key routine borrows it and hands it back: 1 kept (warm-pool.ts:549-569) | M-PR2a markIdle while away keeps a borrowed owner engine -> (a) RED; M-PR2b routine turn start or settle touches presence -> (b) RED |
| W-PR3 open chat + type -> engine warm before send | (a) client: rendering Composer with bot X / thread T (jsdom, real hook, user activation simulated by a real click event) posts /api/bots/X/warm once with `gesture: true`, no focus, no key; (a') server: that POST on a bot with no engine starts the fixture engine, and its pid is alive before the send POST. The send's turn has no `spawned` line, its pid equals the pre-warm pid. (b) typing beats every 5 s renew the hold past 120 s. (b') hold lapses (no beat for 120 s + 1 tick, retired `prewarm unused`), then typing resumes on T after 61 s: a NEW pre-warm starts from /typing. (b'') /typing with the threadId of bot Y on /api/bots/X/typing: no hold, no start. (c) open, no send: at 120 s + 1 tick retired `prewarm unused`, 0 engines. (d) open 5 different bots in 20 s: at most 3 starts, at most 1 unclaimed per kind alive, and a send on the 5th bot dispatches at once (cold). (d') the SAME thread opened from the desktop and then from the phone 10 s apart, after the first pre-warm was retired: exactly 1 start, second `prewarm skipped reason=rate`. (e) EPOCH ONLY: the fixture driver's prewarm start pauses (test hook) after warmThread admitted it and before `prewarming.begin`; desk posts `state: locked`; then a phone typing beat on the SAME thread T makes him present again (same hold term with and without the mutant); then the start resumes and the fixture reaches idle: it is closed `owner away` by the epoch while `present() === true` (the away gate cannot be the closer), 0 engines. (f) budget = 1 engine (MURAGE_WARM_POOL_BUDGET_MB), A's owner engine idle with A active, open chat B: `prewarm skipped reason=budget`, A still kept. (g) MOUNTED bot (fixture MCP integration), with `warm.s2r` OFF and again ON: `prewarm skipped reason=mounted`, send cold `spawned reason=mounted-single-use` (OFF) or through the unchanged r3.5 path (ON); no pre-warm pid exists before the send in either run. (i) A and B (same kind) each had an owner turn 2 min ago; open chat C: A and B still kept, no `intent-moved` on them. (j) phone: the /warm and /typing POSTs go through the REAL door forward function (device door and browser door, companion/src/routes.ts :310 and :282) for a door-marked request, the desktop locked (away): /warm with `gesture: true` (and, in a second run, a /typing beat alone) makes him present and the pre-warm starts (not `reason=away`) | (a): base warms only on window focus and typing; (b'): base /typing starts nothing; (c): base holds 15 min; (d): base starts 5; (d'): base has no per-thread limit beyond the client's own gap; (f): base beforeSpawn evicts A (`pool reserve`); (i): base moveIntent closes A and B; (j): base door sends no launch proof on /warm | M-PR3a drop the mount trigger -> (a) RED; M-PR3b hold = window -> (c) RED; M-PR3c no starts-per-minute limit -> (d) RED; M-PR3c2 no per-thread 60 s limit -> (d') RED; M-PR3d no admission-epoch check at markIdle -> (e) RED; M-PR3e pre-warm may evict owner engines -> (f) RED; M-PR3f /typing does not renew -> (b) RED; M-PR3f2 /typing renews only, never starts -> (b') RED; M-PR3f3 /typing skips the botByThread check -> (b'') RED; M-PR3g mounted pre-warm allowed when `warm.s2r` is ON -> (g) ON run RED; M-PR3i moveIntent evicts owner engines -> (i) RED; M-PR3j /warm, /typing dropped from launchProofHeaders -> (j) RED (both doors) |
| W-PR4 5 bots, 1 active -> 1 kept | present. Owner opens the chats of 5 bots (same engine kind) over 2 min, types in each, and sends one owner turn only on A. At +5 min: exactly 1 kept engine (A), every other close reason is `prewarm unused` or `intent-moved`. At A's last owner turn settle + W + 1 s with no input: 0 | base: A plus the last intent-held pre-warm of the kind = 2 kept at +5 min | M-PR4a an intent hold counts as an owner turn for the ruling's per-bot set -> RED (5 or 2 kept) |
| W-PR5 local only, memory only | (a) after present/away changes, no new file under DATA_DIR and no network call from owner-presence (container --network none, and a spy on the real fetch/http agents, not on the module); (b) server restart while present: after restart `present() === false`, pool empty, no pre-warm at boot; (c) every presence log line matches `^presence warm state=(present|away) cause=(input|turn|idle|locked|asleep|restart)$` | GUARD witness for new code (base has no presence clock, so there is nothing to be RED about): RED-first is proved by its mutants only, each reaching its own assertion | M-PR5a persist lastInput to a file -> (b) RED; M-PR5b log the route or thread on change -> (c) RED |
| W-PR6 never in the way | (a) away; run on the Claude driver AND the Codex driver. A pre-warm on T was ABANDONED by the lock while still spawning (its fixture CLI's SIGTERM handler sleeps 3 s; abandon's kill escalates per killCliTree). The owner sends on T from the phone: dispatch within 500 ms of the POST on a NEW pid (not the abandoned one), reply delivered, the abandoned pid then exits on the retiring/closing path and is never in `sessions` (Claude) / `retained` (Codex) or the pool, and the fixture's native transcript/rollout gains only the new turn's appends. (a') present, MURAGE_PREWARM_WAIT_MS = 2 s. A LIVE pre-warm on T whose fixture start hangs for 30 s; the owner sends 1.5 s after the pre-warm spawned: dispatch on a new cold pid by pre-warm spawn + 2 s + 500 ms, reply delivered, no TAKEOVER_FAILED_MESSAGE. (a'') present. A LIVE pre-warm on T whose fixture start takes 5 s; the owner sends 1 s after it spawned: the turn dispatches on the PRE-WARM's pid at about +5 s, no `spawned` line for the turn. (b) member POST from a non-owner surface and a comms member turn do not make him present. (c) present. A send claims the pre-warm on T (busy, fixture turn runs 10 s); the desk posts `state: locked` mid-turn: the turn runs to its end and the reply is delivered on the SAME pid, then that engine is closed `owner away` at settle | (a') base counts 2 s from the send, then takeover, and can fail the send (claude.ts:4334-4347, warm-pool.ts:78-90); (a)/(a'')/(c): GUARD for new code (no abandon or away on base): RED-first by mutants | M-PR6a no abandon (send takes today's wait/takeover path) -> (a) RED (dispatch later than 500 ms); M-PR6b hand the abandoned pre-warm to the turn -> (a) RED (pid); M-PR6b2 abandoned token's late settle writes back into `sessions`/`retained` -> (a) RED (abandoned pid in the slot); M-PR6d hang bound counted from the send -> (a') RED (dispatch after +3.5 s); M-PR6f fixed short claim bound (3 s from the send, then cold) -> (a'') RED (new pid); M-PR6c count every non-GET request -> (b) RED; M-PR6e ownerAway also abandons/stops claimed (busy) pre-warms -> (c) RED (reply missing or pid changed) |
| W-PR7 desk state on the wire | electron/desk-presence.test.mjs: lock-screen posts `{visible:false,state:"locked"}`, suspend posts `state:"asleep"`, unlock/resume post with no `state` EVEN WHILE IDLE; (b) idle 2 min (visible false already posted) then auto-lock: a second post with `state:"locked"`; (c) a lock while the previous post is still in flight: after it answers, the queued post carries `state:"locked"` (not dropped by the boolean coalesce); parsePresenceBody accepts `clientId,seq,state,visible` only with state in the set and visible false, and rejects `state` with visible true; the server ignores `state` from a companion-authorized report | base sends no state (new key) | M-PR7a desk drops state -> RED; M-PR7c post only on the present-boolean flip -> (b) RED; M-PR7d queue keeps only the boolean -> (c) RED; M-PR7e no post on idle unlock/resume -> (a) unlock cell RED; M-PR7b server takes state from companion -> RED |
New test files go in ci/gate-tests.txt (W-PR1, W-PR3, W-PR4, W-PR6, W-PR7) or ci/extended-tests.txt (W-PR2, W-PR5) in the same push.
Witness W-PR4 is the composition check on the presence tip; warm1022-driver's own ruling witness (5 bots, 1 active) stays in driver.

## SIZE
About 165 server lines (owner-presence.ts about 55, warm-pool hooks and gate abandon about 60, index.ts wiring/limiter/typing about 35,
driver detach hunks about 15), about 15 client lines (mount trigger, gesture flag), about 5 door lines, about 20 electron lines (state
field, queue, idle unlock post), and about 850 test lines. That is under 20% of W1 r3.5. r2 REMOVES the r1 mounted-guard hunk.

## GAP-CHECK (one adversarial pass per round, GAP-CHECK-BAR)
Fixed in r1 (kind + scenario):
1. (a) Sean locks the desktop and goes out, then uses the phone app, which the desktop's server serves. A sticky "locked = away"
   would make every phone turn cold for hours. Fixed: the lock is an away EDGE (P-SIG 3), and phone input makes him present again.
   W-PR1 (d). Confirm in Q-PR1.
2. (b) OS sleep freezes timers: the 15-min setTimeout fires late, so engines would outlive "away" after wake. Fixed: the `asleep`
   edge, the wall-clock PRESENT test, and the wake tick (P-SIG 3a, 4, 5). W-PR1 (c).
3. (d) Opening a chat under memory pressure would evict the owner engine of the bot he is actively using (beforeSpawn evicts LRU),
   so his next real turn is cold because of a speculative start. Fixed: P-PRE 4 admission. W-PR3 (f).
4. (b) He locks while a pre-warm is being admitted. It reaches idle after the away sweep and would be kept. Fixed: P-FENCE 1-2
   (abandon + admission epoch). W-PR3 (e), W-PR6 (a).
5. (c) MAIN-RULING local-memory-budget / No limits: a send arrives while a cancelled pre-warm's close is unconfirmed. Waiting for
   it, or reusing it, would delay or misroute his turn. Fixed: P-FENCE 2. W-PR6 (a).
6. (a) "Opens a bot chat" had no trigger at b45d0259e6 (only window focus and typing). Fixed: P-PRE 1 (a). W-PR3 (a).
7. (b) The intent hold was the full 15-min window (warm-pool.ts:593), so browsing 5 chats keeps unused engines for 15 min. Fixed:
   P-PRE 5, N = 120 s. W-PR3 (c), W-PR4.
8. (c) Privacy / no telemetry: presence could be persisted, sent to Cloud, or logged with thread ids. Fixed: P-SIG 6, PP5. W-PR5.
9. (b) Restart: a restart must not pre-start engines for the last bots used. Fixed: start AWAY, no boot pre-warm. W-PR5 (b).
10. (d) Non-owner traffic would keep "present" true while Sean is away. Fixed: P-SIG 1-2. W-PR6 (b), W-PR1 (a).
11. (b) Thrash: rapid chat switching would spawn an engine per click. Fixed: P-PRE 3. W-PR3 (d), (d').
12. (a) Pre-warm was claimed for every bot, but S1 refuses a mounted pre-warm. Fixed: PP3 scoped to unmounted turns (r2: always).
13. (a) A phone's /warm and /typing lack the door launch proof on a local install. Fixed: P-SIG 1(a), both doors. W-PR3 (j).
14. (d) `moveIntent` closed every idle engine of the kind, so opening chat C closed active bots' engines. Fixed: P-PRE 6, W-PR3 (i).
15. (b) An idle-then-auto-lock desktop posted no lock. Fixed: P-SIG 3a, W-PR7 (b).
Fixed in r2 (reviewer findings that pass the bar, plus this round's own pass):
16. (b+c) ASTRA H1: a send on a thread whose pre-warm is spawning waits up to 20 s (+10 s takeover, then can fail); with a cancelled
    pre-warm after a lock, Sean's phone send would stall. Fixed: PRE-DETACH row with owners, P-FENCE 2 abandon onto the existing
    retiring/closing path, P-FENCE 3 claim bounded only against a hang, never TAKEOVER_FAILED because of a pre-warm, PP4 names the bound. W-PR6 (a), (a').
17. (test integrity) ASTRA H2: W-PR3 (e) could not go RED with the epoch removed (the away gate closed it). Fixed: the epoch is an
    ADMISSION epoch for unclaimed pre-warms; cell (e) makes him present again before the pre-warm settles, so only the epoch closes it.
18. (b+d) FABLE H1 / ASTRA M3b: a mounted pre-warm under `warm.s2r` ON was a new, real-CLI-unproved entry into `qualifying`; a
    failed qualification would make the first reply slower than cold and count toward the R3 back-off. Fixed: PARKED (P-PRE 7), S1
    guard unchanged, W-PR3 (g) runs flag OFF and ON with mutant M-PR3g. Q-PR3 restated.
19. (a) ASTRA M1: a >15-min owner turn settled into "away" and lost its engine at once. Fixed: P-SIG 1(c)/4 (settle stamps, in flight
    = present). W-PR1 (f), (f').
20. (test) ASTRA M2: no cell for 1 pre-warm per thread per 60 s or for "claimed pre-warm never cancelled by away". Fixed: W-PR3 (d'),
    W-PR6 (c) with mutants M-PR3c2, M-PR6e.
21. (a) ASTRA M3a: after the 120 s hold lapsed while he kept typing, nothing restarted the engine. Fixed: /typing runs warmThread
    (P-PRE 1b). W-PR3 (b').
22. (doc) FABLE M1: SEAM predicate omitted the unclaimed pre-warm term; header said only "removes warmth". Fixed: SEAM expression,
    header names the one exception (Sean's instruction (C)), driver D2 hold shortened to 120 s through the hook.
23. (d) FABLE M2: a reload, app relaunch or programmatic focus while Sean is away made him "present". Fixed: /warm counts only with
    `gesture: true` from userActivation + hasFocus, fail closed when missing. W-PR1 (e); idle real renderer session in W-PR1 (a).
24. (b) FABLE M3: a lost lock/sleep post, or an idle unlock, had no outcome. Fixed: state rides the queue, unlock/resume always post,
    lost edge falls back to the 15-min rule. W-PR7 (a), (c).
25. (doc+test) FABLE M4: both doors named; W-PR3 (j) and W-PR1 (d) go through the real door forward function; /typing validates
    threadId (W-PR3 b'').
26. (a+c) Own pass (Opus self-review r2): a fixed 3 s claim bound would make a send 1 s after opening a slow-starting chat SLOWER
    than no pre-warm (PP3/PP4 inverted). Fixed: P-FENCE 3 waits for a live pre-warm until ready/failed, bounded only against a hang
    counted from the pre-warm's spawn. W-PR6 (a'') + M-PR6f.
27. (b+d) Own pass: the Codex detach path and the Claude `sessions` slot were unnamed, and an abandoned process could overlap the new
    `--resume` process for the 5 s stdin grace. Fixed: P-FENCE 2 names `sessions`/`retained`/`closeProcess`, kills the tree at once,
    W-PR6 (a) runs on both drivers and checks the transcript/rollout.
28. (doc) Parked-by-reviewers made cheap: "Mac" -> desktop on every OS (P-SIG 3a); Murage Cloud home presence stated (P-SIG 7).
Parked (one line each, for Sean):
- An explicit "left the chat" beacon from the client (a new beat surface). The 120 s lapse plus `intent-moved` bound the waste.
- Phone app foreground/background reporting (a new phone signal). Phone input still counts.
- Pre-warm after a restart (needs persisted spawn inputs, P-PRE 8); the restart frequency itself is a separate bug.
- Mounted pre-warm (P-PRE 7): needs its own switch, a real-CLI W-MAC/W-WIN-R step and a non-counting `prewarm-qualify` reason (Q-PR3).
- The memory helper model's own warmth (memoryWorker.warmForIntent fires before the away gate; not an engine kind; separate scope).
- A setting for N or W (a new surface; values are test-env only).
- Keeping one engine warm through a short lock (for example a 2-min coffee break): Sean asked for zero at lock, so not added.
- The `settingsRead` browser scope mapping to the desktop surface (ASTRA parked): route-policy classification, not presence scope.
- An owner turn left in flight for hours (a hung engine) keeps presence true until it ends: bounded by the driver's existing turn
  deadlines, and nothing beyond that one bot's engine is kept.
REJECTED (r2 pass): "pre-warm a mounted bot through a fixture admitted by S2-R" (r1 W-PR3 h): a fixture CLI reconnects by
construction, so it cannot stand for the real-CLI proof (FABLE H1).

## QUESTIONS (MAIN / Sean; the design proceeds with the fail-closed choice)
- Q-PR1: lock retires everything at that moment, and later phone input makes him present again (edge, not sticky). If Sean wants
  "locked = no warm engines even for phone use", flip one rule (P-SIG 3 sticky until unlock) and witness cell W-PR1 (d) flips with it.
- Q-PR2: N = 120 s for an unclaimed pre-warm, renewed (or restarted) by typing every 5 s. If Sean wants a different N, it is one constant.
- Q-PR3: a tool-using (mounted) bot is NOT pre-warmed, with `warm.s2r` OFF or ON, so "open chat -> first reply not cold" covers
  unmounted turns only. Lifting it is a separate small design (own switch, one real-CLI W-MAC/W-WIN-R step run by MAIN's relay,
  `prewarm-qualify` never counted in R3). Sean: confirm cold first replies for tool bots are acceptable for now, or order that design.

## R2 CHANGES (finding -> where closed)
| finding | severity | closed by |
|---|---|---|
| ASTRA H1 send waits on spawning/cancelled pre-warm (claude.ts:4334-4347, codex.ts:753-765, teardown :7315/:3385); no owner | High | PRE-DETACH OWNERS row (presence writes, driver/codex review), P-FENCE 2 abandon onto the retiring/closing path on both drivers, P-FENCE 3 claim bounded only against a hang, PP4, W-PR6 (a)/(a')/(a'') + M-PR6a/b/b2/d/f; parked line removed |
| ASTRA H2 W-PR3 (e) + M-PR3d cannot go RED | High (test) | P-FENCE 1 admission epoch; W-PR3 (e) present again before settle, assertion on the epoch close with `present() === true` |
| FABLE H1 mounted pre-warm = new unproved `qualifying` entry | High | option (i): P-PRE 7 PARKED, S1 guard unchanged, PRE-MOUNT row withdrawn, W-PR3 (g) flag OFF + ON, M-PR3g; Q-PR3 |
| ASTRA M1 long owner turn settles into away | Medium | P-SIG 1(c), 4; W-PR1 (f)/(f') + M-PR1f1/f2 |
| ASTRA M2 no per-thread-limit cell, no claimed-never-cancelled cell | Medium | W-PR3 (d') + M-PR3c2; W-PR6 (c) + M-PR6e |
| ASTRA M3 typing never restarts a lapsed pre-warm; mounted path vs D1 | Medium | P-PRE 1(b) + W-PR3 (b') + M-PR3f2; mounted parked (above) |
| FABLE M1 SEAM predicate / header | Medium | SEAM expression, header exception paragraph, OWNERS driver row |
| FABLE M2 unattended focus/mount counts as input; idle renderer | Medium | P-SIG 1(a) gesture rule; W-PR1 (e) + M-PR1e; W-PR1 (a) idle real renderer session |
| FABLE M3 lost lock/sleep post, idle resume | Medium | P-SIG 3(a) queue + always-post + fallback; W-PR7 (a)/(c) + M-PR7d/e |
| FABLE M4 both doors, (j) through the real forward path, /typing threadId | Medium | OWNERS door row, P-SIG 1(a), W-PR3 (j)/(b''), W-PR1 (d), M-PR3f3 |
| Parked by both: "Mac", Cloud home | (parked) | P-SIG 3(a) every OS, P-SIG 7 |
| Opus self-review r2: fixed 3 s claim slower than cold (High); Codex detach path / `sessions` slot unnamed, 5 s overlap on one native session (Medium); M-PR1f split, (j)/(e) triggers, slot names (Low) | High/Medium/Low | P-FENCE 3 + W-PR6 (a'') + M-PR6f; P-FENCE 2 + W-PR6 (a) both drivers; M-PR1f1/f2, W-PR3 (j)/(e), W-PR6 slot assertions |
