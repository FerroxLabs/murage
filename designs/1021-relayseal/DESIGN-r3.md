# O12 Cloud relay seal residual: DESIGN r3 (conv-O12-r3, 2026-11-20). REDESIGN.

Owners, one per side:
- **Cloud-home turn prep, O12b omission** (`server/index.ts` computer-destination decision and the owner line, `server/cloud-home/copy.ts` one string, one optional bot flag in `server/store.ts`, flag reset in the bot PATCH): the hub server builder MAIN seats for 1.0.21.
- **Admission barriers** (`server/drivers/mcp-mounts.ts:137` role `vpsRelayMcp`, production `admit` in `server/index.ts:40750-40757`): MAIN owns the rulings. r3 leaves both byte-unchanged and pins them through the real server.
- **Cloud relay leg** (`server/cloud-home/vps-mcp-relay.ts`) and **ingress primitive** (`server/consuming-turn-ingress.ts`): **no change in 1.0.21.** revkill-1020 keeps the ingress file. The relay file keeps its current owner (hub server lane). Nobody edits either for O12.
- **Outer release leg** (`server/cloud-home/vps-relay-mcp.ts` → `runMcpBridge` releaseRole `vpsRelayMcp` → `createProxyReleaseAuthority.verdict`): OPEN NO-OWNER. It stays unmounted. It gets an owner only when MAIN opens the activation lane (§7).
- **Cloud image / own-server inventory**: MurageCloud, for information only.

Anchor: hub `dev/1021` 068a595c9a8ee59d1a9c994f7484ecd97ab4c48e. All line numbers are at that sha. Inputs: r1 (`CAUSE.md`, `FIX-vps-mcp-relay.patch`), r2 (`DESIGN-r2.md`, 75577b390a), Fable r2 AGREE (`frev-O12-r2/FABLE-R2.txt`), Astra r1 BLOCK (`arev-dsg-O12-1121/ASTRA-DESIGN.txt`), Astra r2 BLOCK (`arev2-dsg-O12-r2/ASTRA-R2.txt`), MAIN ruling O12b (int-1021-n3 QUESTIONS-FOR-MAIN.md, 2026-11-20T12:34Z).

## 0. Why this is a redesign, not a patch
Two Astra rounds blocked, and every High in both sat in the same place: the latent deferral machinery inside the Cloud relay (resume gates, queue pumps, timeout retirement, lifecycle of held frames), plus the fact that its promise cannot hold end to end because the outer verdict leg seals on pending (`consuming-turn-ingress.ts:272-291`). r1 and r2 tried to make an **unreachable** relay leg individually correct. The cluster shows that this cannot be closed inside the relay: each fix exposes another guard the real path cannot exercise, because the real path is closed by two barriers that the same design keeps.

r3 changes the approach:
1. **Close O12 by reachability, on the real path.** O12b makes the Cloud-home turn never mount, provision, bind or connect the own-server relay. So the relay's pending seal (CAUSE §3), the mount refusal (`:137`) and the `admit` refusal all become unreachable from any Cloud-home turn. The purpose ("no Cloud turn is refused for a reason that is not a proven revoke") is delivered by the turn path that real users hit, and is witnessed there with a live `checking:pending` check open.
2. **Build no latent relay code in 1.0.21.** The r1 patch and the r2 mechanism (gates, pumps, `drop(id)`, timeout table) are **withdrawn** from 1.0.21. They stay on this branch as inputs to the activation lane. Nothing unreachable is added to product code, so there is nothing unwitnessable to review.
3. **Make the remaining relay residual a single, explicit activation contract** (§7), with Astra r2 findings 1-4 carried in as its acceptance criteria, so they are parked with an owner-to-be, never dropped.

## 1. PURPOSE
On a Cloud home, a bot whose computer is its own server (VPS) never has its turn refused because of that computer: not at mount, not at relay admission, and not because held context is still `checking:pending`. A proven revoke still refuses exactly as today, and nothing unchecked reaches the engine or the server.

## 2. USER PROMISES
- **P1:** a Cloud-home turn of a bot with `cloudBackend:"vps"` and computer Auto or Cloud runs to completion without a computer. The bot is told it cannot use a computer this turn (existing `COMPUTER_UNAVAILABLE`). The turn is not refused.
- **P2:** the owner sees one plain status line saying why, at least once and normally once per bot (§4.3). It names no host, alias, container or error.
- **P3:** on that turn nothing touches the own server: no resource claim, no provision or inspect, no `docker -H ssh://`, no relay binding, no relay socket. So no pending check can seal the turn through the relay.
- **P4:** a proven revoke on that turn refuses exactly as on any other turn (the ordinary fence path, unchanged).
- **P5:** desktop behaviour is unchanged. Cloud routines (`runOn:"cloud"`, which select Box) are unchanged. No new approval prompt, no new card. The only new owner-visible text is the P2 line.

## 3. What does NOT change
- `vps-mcp-relay.ts`, `consuming-turn-ingress.ts`, `fence-pending.ts`, `vps-relay-mcp.ts`, `mcp-bridge.ts`, `proxy-turn-release.ts`: byte-unchanged.
- `mcp-mounts.ts:137` and production `admit` (`index.ts:40750-40757`): byte-unchanged. They are the backstop if any future change reaches the relay again, and witness B1/B2 pins both through the real server.
- Fable-agreed facts kept as the activation lane's starting point: the cause (CAUSE §3), the reply-leg sequence rule, the permit hold, the 256 cap, the fixed `-32000` text, O-a left to MAIN.

## 4. Mechanism (all in the O12b owner's files)

### 4.1 One decision, at the existing unmountable-destination site
`index.ts:17241-17245` already says "A destination this engine cannot mount is not a failure: the turn runs without a computer and the bot is told so". r3 adds one term there:
```
const ownServerOmitted = isCloudHome() && cloudBackend === "vps" && (requestedWants === "cloud" || requestedWants === undefined);
const computerUnavailable = ownServerOmitted || <the three existing terms, unchanged>;
const wants = computerUnavailable ? "off" : requestedWants;   // existing line, unchanged
```
- `cloudBackend` is already `"box"` for `runOn:"cloud"` (`:17234`), so Cloud routines are not affected.
- Because the decision is taken before claims and side effects, with `wants === "off"`: `admissionComputerClaims` gets `wants:"off"` (`:17263`) so no computer or screen claim; `acquireDirectTurnResources` is skipped (`:17302`); the VPS branch (`:17358`) is not entered, so no `activeVpsThreads.set` (`:17362`), no `vps.vpsComputerAction`/`inspectVpsForAuto`, no `vpsRelayBindings.set` (`:17374`), no `integrations.localComputer` (`:17375`); no `autoVpsProblem`; no Box or host-CUA fallback. Auto does **not** fall back to Box: the owner chose their own server, and Box is a different computer that may cost money (fail closed, no spend).
- `vps.vpsDriverError` is not consulted for this case: the omission applies to every engine, because no engine can carry the mount on a Cloud home today.
- The bot is told through the existing layer: `computerUnavailable && computerKind === null` (`:18057`) → `COMPUTER_UNAVAILABLE` (`bot-shapes.ts:316,339`).

### 4.2 Why the relay residual is unreachable from a Cloud-home turn (the O12 closure argument)
The relay's pending seal needs an upgraded `/vps-mcp` socket bridged by `vps-mcp-relay.ts`. Reaching `bridge()` requires, in order: a resolved claim, a non-`undefined` `admit` result (`:84`), and `boundContainer(botId)` non-null (`:101-102`). On a Cloud-home turn after §4.1:
1. No `vpsRelayMcp` proxy is spawned, because `integrations.localComputer` is never set to it. The mount at `:137` is therefore never offered.
2. Production `admit` returns `undefined` for every claim (`:40750-40757`), so `bridge()` is unreachable even for a hand-made socket. The admit **refusal** itself is not unreachable for a hand-made authenticated request (B2 reaches it deliberately); no automatic turn route makes that request (Parked P-3).
3. `boundContainer` is null because neither `vpsRelayBindings` nor `activeVpsThreads` is written for the bot.
Any one of the three keeps `bridge()` unreachable. 1 is the new one and is the one users depend on; it also keeps every automatic Cloud-home turn route (ordinary, Auto, explicit Cloud, routine via `index.ts:19695` which enters the same preparation) away from the `:137` and admit refusals. 2 and 3 stay as defence in depth and are pinned (B1, B2).

### 4.3 The owner line: at least once, normally once per bot (fixes Fable r2 M10, M11)
- Copy: `cloudHomeCopy.ownServerComputerOff = "Your own-server computer isn't available on Murage Cloud yet, so this bot is running without a computer here. It works when the bot runs on your own computer."` (Fable M10: no claim that the desktop app, used as a Cloud client, would make it work.)
- Where: in turn prep, right after §4.1, when `ownServerOmitted && !bot.ownServerCloudNoted`.
- **Order (Fable M11): append first, then set the flag.** `store.appendMessage(threadId, { role:"bot", kind:"text", actorKind:"murage", murage:{ kind:"status" }, from:{…}, text })`; only if that returns without throwing, `store.patchBot(bot.id, { ownServerCloudNoted: true })`. A throw from either is caught; the turn still runs. Outcomes: append fails → no flag → the next turn tries again; crash or patch failure after append → notice shown, flag unset → the next turn shows it once more. The line is therefore **at least once**, never lost, and at most one per turn. (The `LOCAL_CONTROL_OFF_NOTICE` precedent at `:17344-17346` sets the flag first; r3 does not copy that order.)
- Two first turns of the same bot started at the same instant in two threads can each show the line once in their own thread. Accepted: it is truthful in each thread and bounded by threads that start in that window.
- Reset: the flag is cleared in the bot PATCH when `cloudBackend` changes away from `"vps"` or `computer` changes, next to the `localControlOffNoted` reset (`:35984-35985`), so an owner who switches back sees the line again. One optional boolean in `store.ts` next to `localControlOffNoted` (`:1198`); an older build ignores it.

### 4.4 Failure paths, lifecycle, scale
- **Notice write fails:** §4.3. The turn runs regardless; the bot is still told.
- **Crash or restart mid-turn:** there is no relay, queue, permit, waiter or binding for this turn, so nothing can replay or be left live. The only persisted state is the flag (§4.3 order). A restarted server starts with empty `vpsRelayBindings`/`activeVpsThreads` (in-memory maps), and the next turn takes §4.1 again.
- **Stop:** the turn has no computer and no relay, so a Stop runs the ordinary interrupt path. Under the JOINT RULING STOP-VS-REFUSAL, a confirmed Stop shows the Stop. Nothing in r3 can produce a refusal row on this turn except a genuine revoke on the ordinary fence path (P4), which then follows the same ruling as every other turn. Witness O4 pins the confirmed-Stop case on this exact turn shape; the held-Stop-at-refusal-freeze case is not reachable here because r3 introduces no refusal, and the generic ruling is already owned and tested by the Stop/refusal lanes.
- **Owner changes the bot mid-turn** (PATCH to `"box"` while a turn runs): the running turn keeps its prep decision (no computer); the next turn takes the new backend. Same as any computer change today.
- **0 / 1 / 100 bots:** zero cost for bots that are not Cloud-home VPS bots. Per eligible bot: one boolean and at most one status line per turn until noted. No timers, no polling, no sockets.
- **Platforms:** Cloud-home server code only (Linux). Windows/macOS/Linux clients reach the Cloud home through the same server; no client change. Desktop (`isCloudHome()` false) unchanged.
- **Privacy:** the line is fixed text. No host, alias, container, port or error is logged or shown. No telemetry.
- **Migration / rollback:** one optional boolean; no schema step. Reverting r3 restores today's behaviour: every such turn refused at `:137`, which is safe (fail closed) but worse.

## 5. Witnesses (each RED on base or on its mutant, GREEN on the fix)
Real-path witnesses O1-O5 and B2 run in a new `server/cloud-home/own-server-omitted-1021.test.ts` that boots the **real `server/index.ts`** the way `server/vps-routing.test.ts` does (fake ACP CLI engine that dumps its MCP config and echoes its prompt, fake `docker` and `ssh` on PATH that log every invocation), with the Cloud-home role env and Cloud owner auth used by the existing Cloud-home server suites (neutral fixture names). The turn is dispatched through the authenticated Cloud-home message route and runs through actual engine launch. POSIX-only like the suite it follows. The fake `docker`/`ssh` fixtures answer inspect/provision as **ready**, so that on base and under M17 the turn really reaches `mcp-mounts.ts:137` (the claimed refusal), not an earlier setup error; the fix asserts they are never invoked.

| id | closes | scenario | asserts | mutant (must go RED) |
|---|---|---|---|---|
| O1 | P1, P3 / O12b | Cloud home, bot `cloudBackend:"vps"`, computer Auto; send a message | the turn finishes with the engine's echo; the engine's MCP dump has no `computer` server and no `SPAWNED_PROXIES.vpsRelayMcp` path; the docker/ssh log is empty; the echoed prompt contains `COMPUTER_UNAVAILABLE`; exactly one status message equal to `ownServerComputerOff`; no refusal row / `LEDGER_REFUSAL_LINE`; a second turn adds no second line | M17: drop the `ownServerOmitted` term → base behaviour, refused at `:137` (no echo, refusal row) |
| O2 | P1, P3 | as O1 with `computer:"cloud"` (explicit) | as O1 (explicit Cloud is the path that would provision) | M17 |
| O3 | **O12 closure** (Astra r2 #1/#2, Astra r3 #1) | **Twin turns, same fixture, same moment:** bot V (Cloud home, `cloudBackend:"vps"`, Auto) and control bot C (same engine, computer off). Each thread first has an accepted owner turn whose prompt carried remembered line X, so X is a **retained held reference** of the thread (asserted from the turn's recorded lineage, not assumed). Then a second turn starts on each thread and the engine fake blocks after acceptance (prompt accepted, engine running). **Only then** the deterministic obligation for X is opened `pending` (the relay suites' `job(...).pending(...)` move). While it is pending, the engine fake emits one answer chunk and waits ~2 poll intervals. The obligation is asserted still `pending` at the end of that interval, then finished **withheld**, then the engine fake ends its turn | (i) during the pending interval on V: the server log has no `vps relay` line, no `/vps-mcp` upgrade, no docker/ssh invocation, and no `checking:not-built` ledger refusal; (ii) V's outcome equals C's outcome field by field (refusal rows, status lines except the P2 line, answer kept/dropped, rebuild or not), whatever the pin's ordinary fence does for a running owner turn whose held X becomes withheld (today: answer retained, revoked held ref dropped, `send-fence.ts:136`, `index.ts:17003`); (iii) **P4, prospective release:** a third turn on V that would carry X now gets the pin's ordinary outcome for withheld context, equal to C's, and X's bytes appear in no engine-received prompt and no delivered frame after the withhold (0 withheld bytes) | M19: in the server's real integration construction (`index.ts`, after the §4.1 decision, before `buildMcpServers`/mount admission) set `integrations.localComputer` to the `vpsRelayMcp` entry again while `wants` stays `"off"` → V's turn is refused by mount admission at `mcp-mounts.ts:137` (ENGINE_OWN refusal row, no engine start), C is not → (ii) RED. M17 likewise RED |
| O4 | lifecycle: Stop | O1 turn shape; the engine fake blocks until interrupted; the owner sends Stop and its confirmed receipt lands | the card shows the Stop, no refusal row, no docker/ssh lines, no computer claim was taken (a second thread of the same bot sent during the block starts without a "computer in use" wait) | M17 (turn never starts; refusal row instead of Stop) |
| O5 | lifecycle: crash/restart + Fable M11 | (a) the status append throws once (injected through the existing store test seam) → turn still finishes, flag stays unset, the next turn shows the line once; (b) after the line, start a turn, let the engine fake block mid-turn, kill the real server process (SIGKILL, exact PID) and restart it on the same data dir → next turn shows no second line and still mounts nothing | (a) one line in total after two turns, both turns finish; (b) the interrupted turn ends with the pin's ordinary restart outcome (no replay, no relay activity), the next turn shows zero new lines, docker/ssh log empty | M20: set the flag before the append (precedent order) → (a) zero lines ever → RED |
| O6 | reset | after the line, PATCH `cloudBackend:"box"` then back to `"vps"` | the next turn shows the line once more | M18: flag never cleared |
| B1 | backstop `:137` | real `createMcpMountAdmission(...).mount({command: process.execPath, args:[SPAWNED_PROXIES.vpsRelayMcp]})` | ENGINE_OWN refusal | M16: remove `vpsRelayMcp` from `:137` |
| B2 | backstop `admit` (Astra r2: production admit, not a stub) | real server from O1, during a live O1 turn: open `/vps-mcp` with a computer-kind internal capability for that turn's generation (minted by the same `internalToken` path, `index.ts:5583`) | upgrade rejected; no docker spawned; and, as production `admit` does today, that turn gets one ledger refusal (pinned as is, Parked P-3) | M21: production `admit` drops its `onLedgerRefused` call → the turn's recorded ledger refusals 0 → RED. The assertion reads the turn's ledger/refusal row, never the relay's `vps relay refusals=1` log (that log is unconditional, `vps-mcp-relay.ts:88`) |
| R0 | desktop / P5 | existing `vps-routing.test.ts` (desktop VPS mount) and the Cloud-routine Box path in the existing suites | unchanged GREEN | — |
| R1 | relay untouched | `git diff 068a595c9a -- server/cloud-home/vps-mcp-relay.ts server/consuming-turn-ingress.ts server/memory/fence-pending.ts server/cloud-home/vps-relay-mcp.ts server/drivers/mcp-mounts.ts` | empty | — |

Existing suites stay GREEN unchanged: `vps-mcp-relay.test.ts`, `vps-mcp-release.test.ts`, `computer-engine-gap.test.ts`, the revkill/revkill2 relay suites, `vps-routing.test.ts`. No assertion is weakened. B2's turn-refusal side effect (production admit refuses the claim's turn) is asserted as it is today, not changed (Parked P-3).

If the real server cannot be booted in the Cloud-home role in-process, the builder adds the missing fixture env with neutral names. A unit test of the decision expression is an addition, never a substitute for O1-O5.

Builder gate (THRUST-RULES §5): every witness GREEN and its mutant RED; paired cloud-home + vps + computer shards vs the current train tip, 0 lane-only NEW; typecheck 0 NEW; gitleaks 0; private strings 0; the new test file listed in `ci/gate-tests.txt`.

## 6. CHANGES-r3 (vs r2 75577b390a)
| # | source | r2 | r3 | witness / mutant |
|---|---|---|---|---|
| X1 | Sean two-fail rule; Astra r1 H1-H4 + r2 #1-#4 cluster | latent relay deferral machinery (gates, pumps, `drop(id)`, timeout table) built in 1.0.21 behind closed admission | **withdrawn from 1.0.21**; relay and ingress byte-unchanged; O12 closed by reachability on the real Cloud-home turn (§0, §4.2) | O3 / M17, M19; R1 |
| X2 | Astra r2 #1 (end-to-end timeout) | outer leg named, deferred, inner-only timeout built | no timeout exists on the reachable path (no relay is reached); the end-to-end contract is the activation lane's acceptance criteria A1 (§7) | O3; §7 A1 |
| X3 | Astra r2 #2 (false collapses read error/unresolved/cancel into timeout) | boolean waiter kept | no waiter is used in 1.0.21; requirement carried to §7 A2 | §7 A2 |
| X4 | Astra r2 #3 (retired downstream, stale-destination after settle, drain/teardown proofs) | partial guards | no resumed write exists in 1.0.21; requirements carried to §7 A3 | §7 A3 |
| X5 | Astra r2 #4 (crash/restart, confirmed Stop) | E1/W7 predicate flips only | real-server lifecycle witnesses on the reachable turn: confirmed Stop (O4), restart and notice-write failure (O5); relay-side lifecycle carried to §7 A4 | O4, O5 / M17, M20 |
| X6 | Astra r2 O12b note | B1 used a stub `admit`; O1/O2 via harness | O1-O5 dispatched through authenticated Cloud-home route to engine launch; B2 exercises production `admit` on the real server | B2 / M21 |
| X7 | Fable r2 M10 | "It still works in the desktop app." | "It works when the bot runs on your own computer." | O1 copy equality |
| X8 | Fable r2 M11 | flag before append (precedent) | append first, flag after; at-least-once | O5 / M20 |
| X9 | Fable r2 M6-M9 | relay pump/timeout build conditions | moot in 1.0.21 (no relay change); carried into §7 A1-A3 | §7 |
| X10 | r2 §4.6 | O12b decision | same decision, now the primary mechanism; Auto never falls back to Box (stated) | O1, O2 |
| X11 | Astra r3-1 #1 | O3 opened pending before send (pre-dispatch rejection/rebuild could mask it); M19 mutated the engine fake's config | O3 = twin turns with a retained held reference, obligation opened only after the engine is running, asserted pending through the interval, V equals control C field by field, P4 as a prospective-release turn with 0 withheld bytes; M19 moved into the server's integration construction before mount admission and must yield the `:137` refusal; §4.2 admit wording narrowed; O5b kills the server mid-turn; B2 reads the ledger, not the log | O3 / M19, M17; O5; B2 / M21 |

Kept from r2 and Fable-agreed: the cause, the O12b decision site, both barriers, the copy key, O-a parked.

## 7. Activation contract (PARKED for MAIN: new surface, not 1.0.21)
Turning on the own-server computer on a Cloud home is a new user surface (disabled on purpose since 5be0eafbea) and more than 20% of this design, so by GAP-CHECK it is parked, not built. When MAIN opens it, one lane with one owner designs it end to end, and these are its acceptance criteria (Astra r2 #1-#4, Fable r2 M6-M9, verbatim intent):
- **Single deferral point.** Exactly one place on the engine↔server path may wait on `checking:pending` per direction, and it must be the place whose verdict is final for the engine (today the outer `createProxyReleaseAuthority.verdict`). The inner relay must not run a second, independent deferral whose outcome the outer leg can contradict. This is the structural cause of r1/r2's failures.
- **A1 timeout, end to end:** correlated terminal control, timer and final supervisor contract; retirement of every matching request and permit, including a held engine reply to an already delivered server request (`consuming-turn-ingress.ts:100-104,116-119`); request- and reply-timeout through the real wrapper to engine delivery with exactly one outcome, 0 pending-only refusals, 0 payload release, no late second answer, a usable next call; reverse requests and notifications; mutants for outer refusal and missing outer retirement; the 5 s verdict/ack deadline (`proxy-turn-release.ts:57-80`) reconciled. Fable M6: after a timeout, frames meeting pending again get no second wait.
- **A2 wait outcomes:** deadline, cancel, unresolved verdict and read error are distinct; only the deadline answers "still checking", and only after live authority is rechecked; witnesses per outcome, mutant that collapses them (Fable M9).
- **A3 resumed-write guards:** downstream retirement checked on every resumed and synthetic write; stale destination between settle and writable capacity; real socket backpressure with a paused peer; pump ownership until the last send callback/drain, with fresh arrivals during it (Fable M7: no live `writableNeedDrain` refusal while a queue exists); independent age-expiry mutant; id guard tested where it can fail (Fable M8).
- **A4 lifecycle:** crash/restart with queued calls/replies and an already forwarded call of ambiguous outcome; old socket/child retired, old authority rejected, fresh generation isolated, zero replay; confirmed Stop before refusal freeze vs held Stop at freeze, per the JOINT RULING; mutants for stale authority, replay and the receipt rule.
- **A5:** real `admit` wiring, `:137` lifted for `vpsRelayMcp` only and O12b's `ownServerOmitted` removed in the same change, 100-relay scale qualification, Cloud image qualification (MurageCloud), rollback order (close admission first).
The r1 patch, r2 design and r1 witness file stay on this branch as inputs, marked not-for-1.0.21.

## 8. GAP-CHECK (one adversarial pass, GAP-CHECK-BAR)
Fixed
- (a) purpose gap, O12b: a Cloud bot with an own-server computer has every turn refused at `:137` today. Now it runs without the computer and the owner is told (O1, O2).
- (d) safety, O12 on the reachable path: a pending check open during such a turn cannot seal it through the relay, because no relay is mounted or bound (O3).
- (b) failure path, Fable M11: the notice could be lost forever if the append failed after the flag was set. Append first (O5).
- (c) rule conflict, JOINT RULING STOP-VS-REFUSAL: on the omitted turn a confirmed Stop shows the Stop and r3 adds no refusal (O4).
- (b) failure path, restart: restart mid-turn leaves no relay state and no duplicate line (O5b).
- (e) cheap enhancement, Fable M10: the line no longer suggests the desktop app as a Cloud client would make the computer work (X7).
- (d) money: Auto never falls back to Box for an own-server bot (§4.1).

Parked (for Sean/MAIN, one line each)
- P-1 Activation of the own-server computer on Cloud (§7, A1-A5): new surface and >20% of this design; Astra r2 #1-#4 and Fable r2 M6-M9 are its acceptance criteria. **SCOPE SPLIT requested from MAIN** (Astra r2 #1 asked for an explicit split).
- P-2 O-a: transport loss recorded as a memory refusal on the relay. Only reachable after activation; needs a MAIN ruling.
- P-3 Production `admit` refuses the turn of any live claim presented at `/vps-mcp` (`index.ts:40755`). Only the turn's own engine could present its token there; that is self-inflicted, rare and fail-closed. Changing it changes a deliberate barrier, so MAIN rules (B2 pins it as is).
- P-4 Copy: per-bot (precedent) vs per-thread line, and the Cloud own-server setup flow still says "Your Cloud can reach Docker on your server" (`copy.ts:228`), which is true as a connection test. Whether that screen should also say bots don't use it yet is a copy ruling.
- P-5 Desktop `ingress.drop()` with no permit (Fable r1 Low 6): desktop residual, no Cloud scenario.
- P-6 Owner-operated VPS management routes (`index.ts:40515`, `:40553`) stay reachable on a Cloud home; they are owner actions, not turns, and are outside the turn omission (Astra r3 note).

Rejected
- Building the relay fix latent in 1.0.21 (r1/r2): two rounds show it cannot be proven on a path the same design keeps closed; it adds unreachable risk with no user benefit.
- Turning `:137` into an in-place omission: `mount()` returns a record callers insert, and the same line guards three internal roles that must refuse.
- Box fallback for Auto: changes the owner's chosen computer and may spend.
