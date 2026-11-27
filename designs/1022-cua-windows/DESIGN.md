# 1.0.22 DESIGN r6: bundled computer-use driver on Windows (cua-driver 0.55.0)

## 0. PURPOSE and USER PROMISES

PURPOSE: a Windows owner can let a bot see and use their own PC (screen, mouse, keyboard), as Mac and Linux owners
already can. Murage ships the official signed driver for this, and it is never on unless the owner switches it on.

USER PROMISES
- P1 Off until I say. Nothing on my PC can be controlled until I switch Local control on in Murage *and* set a bot to
  "This computer". A bot on Auto never reaches my Windows desktop, and the app never shows Auto as "this computer".
- P2 Only the real driver. Murage runs only the exact driver bytes it shipped (pinned to upstream's published checksums
  and signature), at daemon start AND at every driver session it opens. It never runs a command named in a file.
- P3 No telemetry, no update checks. No driver process Murage starts (daemon, per-turn MCP child, cursor helper) sends
  product telemetry or checks for updates, whatever the inherited environment or a persisted config says. The
  two-switch boundary (r4, ASTRA r3 H6): the app-wide driver daemon starts only while Local control is on; it holds no
  bot session and performs nothing by itself. A bot's driver session (the per-turn MCP child) and every action need
  both switches: Local control on AND that bot explicitly on "This computer". With Local control on and every bot on
  Auto, the daemon runs and no session opens and no action reaches it.
- P4 Never as administrator. A bot can never answer a Windows administrator (UAC) prompt, and it never drives elevated
  windows. If Murage runs as administrator, or Murage cannot confirm it does not, Local control stays off and says why.
- P5 Hands off while I'm away. While my PC is locked, or Murage does not know yet, a bot's computer actions are refused
  with a plain reason, including an action that was waiting on a card when I locked. The bot's turn still runs.
- P6 Big screens never stop my turn. No size, count or memory cap ever ends, refuses, seals or delays my turn, or cuts
  off the computer tool for the rest of it (MAIN-RULING local-memory-budget; MAIN-RULING cause22-one-rule). On my turn
  every hop, on every engine that can use this computer, passes a reply whole up to the one 64 MiB ceiling; a single
  reply over it fails that one action with a plain tool error, the next action works, and the turn and reply still
  arrive. On engines whose model API cannot take a picture in a tool result (the OpenAI-chat family) the bot gets the
  text of the reply and one fixed line saying the screenshot was not shown; that is today's Mac/Linux behaviour, it is
  not a cap, and it never ends the turn (r5, section 6a). (r6) Two more declared boundaries, both today's behaviour on
  every platform and both under MAIN-RULING cause22-one-rule's "trims THAT ONE item": on Pi and on OpenAI-chat the TEXT
  part of one reply is trimmed at 50 KiB (Pi also at 2 000 lines) with a marker naming the limit, the picture (Pi) is
  untouched and the turn goes on (S30, S31); and past the frame count (10 000 frames from one mount in one turn) every
  further reply of that turn fails as its own item with the line naming the count while the turn, child and mount live (MAIN-RULING cause22-OPEN-2;
  S18). The OpenAI-chat step budget (64 model rounds, 200 tool calls a turn) is a count that ends an owner turn, so it
  is in cause22-OPEN-2's scope: the budget stays (it bounds model spend) but reaching it never fails the turn; the
  call past 200 gets a tool error naming the limit, the last allowed round offers no tools, and the turn ends with the
  bot's own reply (S32/S33, M1 (m)).
- P7 Honest where unsupported or broken. On Windows on Arm, when the driver can't start, or when it crashed, the Local
  control card names the reason in plain words, and Retry really works again. Nothing fails silently.

## 0b. r5 INVARIANT TABLE (written first; one row per High on r4 1ed75a3b2e, each with its witness)

Highs: FABLE board line 2958 (F1-F5) and ASTRA board line 2963 (A1-A7) on 1ed75a3b2e. Each is restated as an
invariant (PROCFIX P1); the counted unit, the trigger paths and the witness rows are in the section named. "Entry" is
the production entry point the witness goes through (PROCFIX P2). Nothing here is built or run: the product witnesses
are specified for the builder. A witness whose entry exists on 1ed75a3b2e (W-B1, W-B3, W-C4, W-C5, W-C6) names the behaviour that fails there. A witness of code that does not exist there (the win32
runtime) claims no base RED: its pre-fix sha is the builder's declared r4-shape checkpoint (R20b).

| id | High | Invariant | Decision / section | Witness (entry point) | Mutants (REVERT first) |
|---|---|---|---|---|---|
| I-1 | F1 owner-turn seal sites omitted: relay child-stdin drain and frame count (`cli-mount-relay.ts` 121, 176), Pi 32 MiB client (`pi-mcp-extension.ts` 181, 214), OpenAI-chat (`chat-mcp-client.ts` 478, 513) | No cap of any kind (size, count, drain) ends, seals or interrupts an owner turn at ANY site between the driver and the model, on EVERY engine that can mount this computer. Unit: one reply item; ceiling 64 MiB; over it that one call fails | section 6a SITES S1-S28, contract M1 (f)-(j) | W-B1 engine table, one row per site and per engine (booted server, real owner send route) | one per applicable SITES row, M-S01..M-S26 without M-S09 (section 6a) |
| I-2 | F2 W-B1(iii) / M-B1h unreachable: the proxy sends one reply at a time behind the ack | A witness cell exists only for a state the production path can reach; an unreachable site is a SITES row marked NOT-APPLICABLE with its reason, never a mutant | section 6a "held output", S9 marked NOT-APPLICABLE with the code path that makes it so | none claimed: cell (iii) is a pin of the deferral only | none: M-B1h deleted, no replacement |
| I-3 | F3 M-K7 stays green: the fresh harness is refused by the lock gate anyway | The generation fence is tested with every other admission term true (desktop `active`, both switches, card allowed) and only the `live` message withheld | D20, R17d W-K5 (v) | W-K5 (v) first `it`, with its setup assert `hostDesktop === "active"` and its control cell | M-K7 |
| I-4 | F4 W-C4 calls an extracted predicate; M-C4b dereferences a missing entry before its assertion | The Auto boundary is witnessed at the real turn entry, and its mutant sits on a branch the turn entry really takes | R10b W-C4 | W-C4 (booted server, real owner send route, fake engine reports its mounts) | M-C4, M-C1; M-C4b and W-C4s withdrawn |
| I-5 | F5 disable or update during pre-spawn `checking` has no cancel or join; an adopted pid's death is not proven | After a stop (disable, quit, update, Retry, integrity) nothing started before it can spawn a driver, from any await point; update admits the installer only after the pending check has ended; an adopted process is gone only when the OS says so | D18, D19, R20b W-Q4, R17d W-K5 (vi) | W-Q4 table (real `cuaCleanupStage` + real `prepareBackedUpInstall`; win32 rows RED at the builder's declared r4-shape checkpoint, no RED claimed on 1ed75a3b2e, R20b), W-K5 (vi-a..c), W-R11 | M-Q4a..d, M-K7h, M-K7i |
| I-6 | A1 consent revocation misses sibling threads and a failed Disable | When the owner takes "This computer" away from a bot, or switches Local control off, no thread of that bot (and no thread at all, for the app switch) performs another action, whatever else fails. Unit: one `tools/call`; triggers: bot set to Auto / cloud / off, Disable with the sweep failing, hanging or the setting not saved | D17, R10c W-C5, R10d W-C6 / W-C7 | W-C5 (booted server, real `PATCH /api/bots/:id`, the running turn on the bot's second thread), W-C6 (the real settings card), W-C7 (the real Disable handler) | M-C5a..d, M-C6a..b, M-C7 |
| I-7 | A2 harness re-arm loses an in-flight claim | A driver generation takes actions from at most one harness process in its life; a new harness never gets a generation that an earlier harness could have left mid-action | D20, R17d W-K5 (vii) | W-K5 (vii), (vii-b), (viii) through the real `onHarnessMessage` routing | M-K7f, M-K7g, M-K7e |
| I-8 | A3 update misses pre-spawn checking | same invariant as I-5 (one mechanism, the start epoch) | D18 | W-Q4 update rows | M-Q4a, M-Q4c |
| I-9 | A4 daemon hashing is path-racy | Every exe Murage launches is hashed through one open file whose identity equals the launch path's, at daemon start as at each session | D6 (a) r5, R5 W-S1b | W-S1b table {2 exes} x {rename, in-place write} through the real enable entry | M-S1c, M-S1d |
| I-10 | A5 orphan cleanup trusts a reusable pid | Murage ends a leftover process only when its pid AND its process start time are the ones Murage recorded at spawn | D19, R17d W-K5 (vi) | W-K5 (vi-a..c), W-R11 | M-K7c, M-K7h, M-K7i |
| I-11 | A6 W-B1 bypasses production wiring; unreachable mutants | W-B1 runs the unmodified production server: nothing of the door, the owner header, `withUpstreamOwner` or `consumingHttpWriter` is rebuilt by the test, so it also runs unchanged on the base | section 6a "W-B1 rig r5" | W-B1 (same as I-1) | every M-S row has a reachable trigger named beside it; M-B1h deleted (S9), M-B1p reworked (S12) |
| I-12 | A7 owner accounting preempts the W-B3 overflow handling | An over-ceiling driver reply has ONE overflow state, whoever notices it first; it ends by proof or by the 10 s bound, never by killing the session on the accounting cut | C7 r5, M1(j), R14b W-B3 | W-B3 (booted server, under the real `withUpstreamOwner`) | M-B3f, M-B3d |

Receipts in this design round: this lane changes only this file, so the only thing that can be RED on 1ed75a3b2e and
GREEN on the r5 tip is a check of the design text itself (one assertion per row above: the row, its decision and its
witness are present). That check, its base run and its drop-row mutants are in the lane's job dir (`receipts.tsv`,
machine-checked). It is a document check and is named as such; it is not a product witness and proves nothing about
code. Product REDs are the builder's (each witness below names what fails on the base).

## 0c. r6 INVARIANT TABLE (delta on r5 ba39e92f83; Fable round 5 AGREE, everything it agreed is kept)

Highs on ba39e92f83: OPUS board line 3011 (one High) and ASTRA board line 3014 (its verdict line plus the three further
Highs in the same review, rv-ba39e92f83-astra). FABLE 3010 Mediums M1-M3 are folded (M1 is the Opus High). The
cause22 lanes fix the generic sites; this design cites their rows (cause22-main-b `fix/1021-cause22-main-b`
76c075fd86 test `server/drivers/cause22-owner-caps-relay-1021.test.ts` rows R3 and R7; cause22-caps-opus-r4
`SITES.md` rows OPEN-2 and the "Cut, not end" list, line 44) and adds only the host-path cells that consume them.

| id | High | Invariant | Decision / section | Witness (entry point) | Mutants (REVERT first) |
|---|---|---|---|---|---|
| I-13 | OPUS 3011 / ASTRA 3014 / FABLE 3010 M1: engine-request count `requests.size >= 4096` (consuming-turn-ingress.ts 107) has no SITES row; cell (vii) sits exactly on 4096 | The 4097th engine request in flight on an owner turn fails as that one call, by its id, with the fixed line; the mount, proxy and turn live. Unit: one engine `tools/call` in flight | section 6a S29 (owner cause22 caps, cause22-main-b R7); M1 (l) | W-B1 cell (vii-c) on E1 (booted server, real owner send route) | M-S29 REVERT, M-S29n NOOP, M-S29d DROP |
| I-14 | ASTRA 3014: Pi and OpenAI-chat result truncation not in the sweep; E4/E5 equality cells fail on a large text even when fixed | Every result-text trim on the owner path is a SITES row; a trim that keeps the turn and names its limit is COMPLIANT (cause22-one-rule), and the witness reads the trimmed text plus the marker, never "text equal" beyond the limit. Unit: the text part of one reply | S30 (Pi `truncateToolText`), S31 (OpenAI-chat `capUtf8` at 1730), S34 (not on path: 1292 log view, 1727 web reads); M1 (k) | W-B1 cells (i) E4/E5 with the reply shape fixed (picture big, text 8 KiB), (i-t) E4, (i-u) E5 | M-S30a/b, M-S31a/b |
| I-15 | ASTRA 3014: OpenAI-chat turn stops (200 tool calls, 64 rounds) not in the sweep | No count ends an owner turn (cause22-OPEN-2): over 200 calls that one call fails with a tool error naming the limit; at the 64th round the request offers no tools; the turn ends with the model's own reply. Spend stays bounded (at most 64 rounds). Unit: one tool call / one model round | S32, S33; M1 (m) (cause22 caps, new term, CONTRACT-REQ) | W-B1 cell (ix) rows A/B/C on E5 (S35 per-reply count added in precheck pass 2) | M-S32 REVERT, M-S32d DROP, M-S33 REVERT, M-S33n NOOP, M-S35 REVERT, M-S35d DROP |
| I-16 | ASTRA 3014: E5 cell (v) cannot drive 10 001 `tools/list` through the production tool loop, so M-S25 is unreachable | A witness cell exists only for a reachable state. On the host mount the OpenAI-chat client cannot reach 10 000 frames in a turn, so S25 is NOT-APPLICABLE with that reason and its mutant is deleted; S18 on E1 follows cause22-OPEN-2 (the over-count reply fails as one item) | S25 NOT-APPLICABLE; S18 required text per OPEN-2; cell (v) rewritten | W-B1 cell (v) E1 only, plus its own `it` pinning the S25/S28 reason (mount lines = requests) | M-S18 REVERT, M-S18x (excess delivered: not compliant per OPEN-2), M-S25 deleted |
| I-17 | ASTRA 3014: W-C5 cell (b) cannot go RED on the base (the second call queues behind the held click in the serial proxy) | Cell (b) runs with the prior call settled, so on the base the second call reaches the driver by the missing fence alone | R10c W-C5 row (b) setup | W-C5 (b) | M-C5a, M-C5b (unchanged, now reachable) |
| I-18 | ASTRA 3014: W-Q4 omits the arm64 read; M-Q4b masked by `spawnIfCurrent` | Every await of D18 is a row, and each post-await compare except the last has an assertion only it can fail (no later step of `checking` starts); the last one is masked by `spawnIfCurrent` and is stated, not receipted | R20b W-Q4 | W-Q4 table + the "no later step" `it` | M-Q4a (all compares removed), M-Q4b (post-hash compare only, RED at the "no later step" `it`), M-Q4f (post-arm64 compare only) |
| I-19 | ASTRA 3014: W-R11's ship mutant targets the `taskkill` path D19 removed | The real-box leftover mutant targets the production stop (`terminateIfStart` + `gone(pid)`) | section 7 W-R11 | W-R11 | M-K7m (terminate is a no-op that reports `terminated`, and the stop is confirmed by that report) |
| I-20 | MAIN 3018 / ASTRA 3017 (ASTRA 3017 on the retired r4 race entry e98440eaa7, carried by MAIN 3018): orphan recovery can kill a reused pid or read a failed process query as confirmed death | A leftover process is killed only when pid AND start time match on ONE handle; a failed or unreadable query is UNKNOWN and fails closed (`driver-stuck`, spawn 0, record kept); death is proven only positively | D19 (already in r5 and agreed by FABLE 3010 A5; r6 changes nothing in it): `driver.owner.json` {pid, start}, `processStart` null = UNKNOWN (exclusion.c 2184-2200), `gone(pid)` positive only, `terminateIfStart` on one handle, `taskkill` never on an adopted pid; W-R11 r6 death proof | W-K5 (vi-a..e) unit cells, W-R11 real box | M-K7h, M-K7i, M-K7k, M-K7l, M-K7m |

Receipts r6: as in r5, a document check of this file only (one assertion per I-13..I-19 row), RED on ba39e92f83 and
GREEN on the r6 tip, plus one drop-row mutant per row; `receipts.tsv` in the lane's job dir, machine-checked. Not a
product witness. Product REDs on ba39e92f83's tree are named in each cell.

## 0d. r7 build-time corrections (MAIN 3105 folds ASTRA BLOCK on f94aa558dd into build-1022-cua-windows)

Owner of these corrections: build-1022-cua-windows (bld1022-cua-windows), on fix/1022-cua-windows; MAIN 3105 asked for
them in the same branch as the build. Nothing else in r6 changes.

| id | Finding (ASTRA on f94aa558dd) | Correction |
|---|---|---|
| I-21 | S29 rejects its own mutant receipts (DESIGN.md:830) | the seal-cause receipt rule is WITHDRAWN (it could never be met on the host path); S29 is deleted by its owner under cause22-no-transport-caps and is cited, with no S29 receipt claimed here |
| I-22 | E5 has an unrowed turn-ending cap: openai-chat.ts 1083/1093, 32 MiB tool-call reply (DESIGN.md:745) | new SITES row S38, owner cause22-eng (MAIN 3104), deleted under cause22-no-transport-caps; removed from the S34 NOT-APPLICABLE list; cited, not duplicated |
| I-23 | DROP-I-20 cannot produce its recorded failure (DESIGN.md:87 vs :1123) | both tokens the document check needs (the row marker and the MAIN-slash-ASTRA pair) now live in row I-20 only; the review-map line no longer repeats the pair, so dropping row I-20 fails the check |

MAIN-RULING cause22-no-transport-caps (2026-11-22T14:29Z, after r6) also supersedes P6's "one 64 MiB ceiling" and
section 6's ceiling terms: there is no transport size or count cap on this path, only the model-facing trim where a
tool result enters engine context (S30, S31 stay). The builder therefore builds no ceiling, no oversize answer and no
D16(b)/(c) overflow proof (bld1022-cua-windows DECISIONS D-1); the caps on the path are deleted by the cause22 lanes.

## 0a. Owners of each side (OWNERSHIP rule)

- This design: design-1022-cua-windows (r2 = design-1022-cua-windows-r2, r3 = design-1022-cua-windows-r3, r4 =
  design-1022-cua-windows-r4-opus, r5 = design-1022-cua-windows-r5 on r4 1ed75a3b2e, r6 = design-1022-cua-windows-r6
  on r5 ba39e92f83). Design only; nothing built or run.
- r6 sides: S29 engine-request count and S18 per cause22-OPEN-2: cause22 caps lanes (cause22-main-b /
  cause22-caps-opus-r4, rows R7 / R3 / Q2; M1 (f), (l)); S31 cut-note wording: cause22 caps lanes (M1 (k), new);
  S30 Pi trim: Pi driver owner, no change; S32/S33 OpenAI-chat step budget: cause22 caps lanes under cause22-OPEN-2
  (M1 (m), new, CONTRACT-REQ on the board). Consumer of all: Windows builder (build-1022-cua-windows).
- r5 sides: engine-side MCP clients on the owner turn (`server/drivers/pi-mcp-extension.ts`,
  `server/drivers/chat-mcp-client.ts`) and the relay's count/drain/input sites: cause22 caps lanes (contract M1
  (f)-(j), section 6a); consumer: Windows builder. `shared/cua-driver-identity.mjs` (new), `electron/cua-windows-runtime.cjs`
  and the settings card order: Windows builder. `processStart` (`native/engine-exclusion/exclusion.c`, used by
  `electron/data-dir-lease.mjs`): existing native primitive, consumed read-only. (r6, FABLE 3010 M3) The same addon
  gains `terminateIfStart(pid, start)` (D19, win32 only): Windows builder, listed in section 5; `processStart` and
  every existing export are unchanged.
- Windows builder (every NEW file and every Windows hunk in section 5): owner = builder lane family
  `build-1022-cua-windows` (branch `fix/1022-cua-windows`, Opus builder seated by MAIN); MAIN holds this side until
  that lane is seated (r4, ASTRA r3 M4). This side is the consumer of every contract below.
- Pin set and host broker (`package.json` `@trycua/cua-driver`, `scripts/cua-driver-0.55.0-provenance.json`,
  `server/local-computer.ts` Linux/Mac decoders, `server/host-computer-broker.ts`, the reader's claim-facing overflow
  shape): cua-upgrade lane, current round cua-upgrade-r4 (from `fix/1022-cua-upgrade-r3` c3cf3c3cf5). Contracts
  C1-C8, section 9.
- Owner-turn size caps on every hop of this path (`server/memory/upstream-reader.ts`, `release-budget.ts`,
  `consuming-turn-response.ts` release charge, `proxy-turn-release.ts` `releaseProxyFrame`,
  `drivers/headless-browser-proxy.ts` reader, `drivers/host-computer-proxy.ts` `post`, `ledger-refusal-line.ts`
  OWNER_* constants): cause22 caps lanes (cause22-caps-fable / cause22-caps-opus, CAPS-INVENTORY rows A1-A3, B1, B12,
  B13; earlier cause22-mountbudget). Contract M1, section 6. Consumer: Windows builder (build-1022-cua-windows).
- All-platform broker regression gates for C4-C8 (linux/darwin descriptor cells in `server/host-computer-broker.test.ts`):
  cua-upgrade lane (broker owner). The win32 cells (`server/host-computer-win-gate.test.ts`): Windows builder (build-1022-cua-windows).
- Lock tracker (`electron/lock-state.mjs`, `createLockReader` in `electron/attention-wiring.mjs`): owner S4a
  (NOTIFY-EVERYWHERE-1019 5.2 #3; current consumer S3B). This design adds a second read-only consumer and edits
  neither file.
- Warm pool (`server/drivers/warm-pool.ts`, `poolable` in `server/drivers/acp/core.ts`): WARM-1021-DRIVER (W1 r3.5
  builders). This design adds no warm engine and edits neither file (section 4c).
- Host route and proxy hunks (`server/index.ts` `/api/internal/host-computer`, `server/drivers/host-computer-proxy.ts`):
  shared with cua-upgrade (broker call site) and cause22 caps (`post` limit, M1(a)). The Windows builder merges onto the
  newest cua-upgrade and caps tips and resolves. The r4 extraction of the host route body into
  `server/host-computer-route.ts` (section 5) is the Windows builder's hunk.
- Mount relay and trusted ingress on the owner turn (`server/drivers/cli-mount-relay.ts` line/held caps,
  `server/drivers/mcp-mounts.ts` accept, `server/consuming-turn-ingress.ts` decode/deliver/envelope/reserve, the
  release door body cap `authority.bodyCap`): cause22 caps lanes (CAPS-INVENTORY A5-A8, A11, A12, A14; caps-opus
  C12/C13/C22, built at 22039551ff). Contract M1(d). Consumer: Windows builder (W-B1).
- Real Windows runs (WINRUN-REQ), relay, merge: MAIN.

r4 base: design/1022-cua-windows-r3 aca5a32445 (r4 lane: design-1022-cua-windows-r4-opus). r3 base: design/1022-cua-windows-r2 62adc0c5d3. Caps anchors read at fix/1021-cause22-caps-opus 22039551ff (not yet on
dev/1022). r2 base: `dev/1022` b45d0259e6 (r1 base e16373e9c8). Pins aligned with cua-upgrade r3 tip c3cf3c3cf5 (product code =
5899f52106; r4 in flight from it). Anchors below are read at c3cf3c3cf5.

## 1. Facts this design rests on

- Release `cua-driver-rs-v0.55.0` (source commit 8f484f30586eef722bede7a5ce315de1148cca96) publishes
  `cua-driver-rs-0.55.0-windows-x86_64-binary.zip` sha256
  `357b93254183c0e24a501eb9ad3a6e0f3738a67bfed55c0c292959b540d9b4a7` (32550400 B) and
  `...-windows-arm64-binary.zip` `ab1515f8893fb8b1acda5a4ffe1d2e97d19a938460d0f5ac7b6e9ed88f37f020`. Both lines are in
  the release's `checksums.txt` (sha256 `5286f927241d1b2179063baa461e9355105aebc65a7254b9b72ad882ccb08336`, the same
  file cua-upgrade pins for Mac in `scripts/cua-driver-0.55.0-provenance.json`).
- Each zip has a `.sigstore.json`; the x86_64 signature verifies over the zip (1-byte mutant fails). Cert SAN
  `https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/cua-driver-rs-v0.55.0`, issuer
  `https://token.actions.githubusercontent.com`.
- x86_64 members (sha256): `cua-driver.exe` 4a14438f4ee8ef768da6f4cdcae2403b2e58e78952f3d323cc7ba9615539ed2b
  (33300808 B), `cua-cursor-theme.exe` b8565863057f5471c939f65ef0afb9154829c8da0e09c42fcddba8dfbabd7604,
  `cua-driver-uia.exe` c5e38da9fba37556407f3f19bd2b555432c8e77fe4a2370069e904b9c3ccf088, plus
  `cua_driver_sdk.dll`, `cua_driver_node_runtime.node`, `cua_driver_abi.h`. PEs are Authenticode-signed, subject
  "Cua AI, Inc." (Trusted Signing, short-lived certs: the subject is the stable identity). Not yet verified on Windows
  (W-R1).
- Telemetry: `DO_NOT_TRACK` (non-empty, not 0/false) wins over everything; next `CUA_DRIVER_RS_TELEMETRY_ENABLED`
  (0/false/no/off = off); default ON. Update check: env `CUA_DRIVER_RS_UPDATE_CHECK=false` wins over a persisted config.
  Persisted config lives under the user profile (`~/.cua-driver/config.json`). The upstream line claims are from r1's
  reading and are re-proven on the packaged runtime by W-R2/W-R10, not trusted.
- Transport: `serve --embedded --socket \\.\pipe\<name>`; pipe DACL = current user SID + Low label; accepted clients are
  checked against the SID; `first_pipe_instance`, so a taken name fails the start.
- `cua-driver-uia.exe` is `uiAccess="true"`; Windows grants that only under `\Program Files\`; Murage installs per user
  (nsis current-user), so it could never get UIAccess. Without it the driver runs at medium integrity and UIPI blocks
  input to elevated windows and `consent.exe`; the UAC secure desktop is unreachable.
- The driver does not refuse input while the input desktop is the lock screen; background (PostMessage/UIA) delivery
  can reach windows behind the lock. Murage must gate (D10).
- Screenshots: `get_window_state` defaults to a 1568 px long edge on Windows; `get_desktop_state` and `zoom` return
  native size unless asked; `screenshot_scale` maps coordinates back.
- Murage at c3cf3c3cf5:
  - `electron/main.mjs` starts CUA only on darwin/linux; win32 reports `unsupported-platform`. The lock tracker is
    `createLockState` + `createLockReader` (main.mjs 465); it starts `unknown` (= locked) and only changes on an event
    or `refresh()` (lock-state.mjs header: no timers). Main -> harness messages go over `serverProc.postMessage`
    (e.g. `murage:power`, received at index.ts 2049); `setCuaStateListener` (main.mjs 5319) is in-process
    cua.mjs -> main only and does NOT reach the harness.
  - `shouldMountLocalComputer({requested,hostPlatform,providerSupportsLocal})` (local-routing.ts 1-15): local only on
    darwin/linux, Auto only on darwin, false when `!providerSupportsLocal`.
  - Renderer `src/lib/local-computer.ts`: `localComputerDisabledReason` returns the blanket `WINDOWS_COMPUTER_TEXT` on
    win32; `autoSelectsLocalComputer` is `platform !== "linux" && ...` (would show Auto as local on win32 once the
    driver is selectable); `autoMountsThisComputer` local is darwin/linux only (so the warning/sweep skip win32).
  - `server/local-computer.ts` `legacyPlatform` keeps win32; `decodeLegacyDescriptor` accepts a win32 `embedded`
    descriptor naming any `mcpCommand`, no env check. The Linux decoder pins `0.55.0`/`0.9.0` (180/188) and requires
    both env keys `"false"` (205-212).
  - Broker (`host-computer-broker.ts`): spawns with `{...process.env, ...spec.env}` (89-90, 140-141), so spec keys win
    but every other inherited key passes. A started `tools/call` that never gets a reply keeps the exclusive claim
    `active` (107, 182); every later call answers "Another computer action is in progress" (79). Nothing clears it.
    Reply bytes are charged to `currentUpstreamAccounting("collection")` (18-24), which refuses the turn over
    `UPSTREAM_COLLECTION_MAX` 8 MiB (upstream-reader.ts 29). The transport line limit for this reader is
    `MAX_RESPONSE_BYTES` 16 MiB (headless-browser-proxy.ts 24), not the 8 MiB `mcp-bridge` default r1 cited.
  - Host route (index.ts 31273-31345): `authorized()` is checked at entry (31282), after the one-time consent wait (31302),
    after the per-action card `askHostAction` (31323), every 100 ms while the call runs (31331), and by the broker
    right before the action is sent (broker 167).
  - Warm pool: a turn with `integrations.localComputer` (or `computer`, `browser`) is never `poolable`
    (core.ts 6702-6704), on every platform.
  - Release: the Windows job runs on `windows-latest` (release.yml 824-827) and signs there (`forceCodeSigning`).
    r1 wrongly said ubuntu cross-build.
- Read for r3 (c3cf3c3cf5 unless named):
  - Route answers that seal the mount: `host-computer-proxy.ts` treats any status other than 200/409 as transport loss
    (`throw` at 64, `proxyTransportLost("hostComputer")` at 69, caps-opus line numbers), so the route's 403 at entry
    (index.ts 31282) and a 500 from an unexpected broker error (the route's `throw error`, 31343) both end the computer
    tool for the rest of the turn. Every win32 refusal on this path is therefore a 200 tool error or a 409 with a code.
  - Broker child exit mid-action: `startHeadlessEngine` rejects every pending request when the MCP child exits
    (headless-browser-proxy.ts 137); `onSession` then sees `actionStarted && !actionReplied` and keeps `active`
    (broker `finally`), with no withdrawal and so no 10 s grace kill. Nothing clears the claim while the daemon lives.
  - Reader overflow: `createLineSplitter(..., MAX_RESPONSE_BYTES 16 MiB)` (headless-browser-proxy.ts 141-150) fails on
    the size alone, possibly before the line's end or id was seen.
  - Quit/update barrier: `cleanupDesktopForExit` awaits `stopCua()` under `CUA_STOP_TIMEOUT_MS` 2500 (main.mjs 6079,
    6205); a rejected stage keeps `cuaCleanedUp` false and the updater path (`prepareNormal` -> `prepareUpdaterRestart`
    -> `cleanup`, main.mjs 839-849) releases the pending install and reports `BACKUP_UPGRADE_CLEANUP_FAILED`; the
    installer runs only after `prepareBackedUpInstall` resolves (preupgrade-continuation.mjs 7). "Deadlines report
    incomplete cleanup; they never authorize releasing a live installation writer" (main.mjs 6074-6077).
  - Caps (caps-opus 22039551ff): `OWNER_ITEM_MAX` 64 MiB, `OVERSIZE_LINE`, `oversizeAnswer`, `OWNER_TURN_HEADER`
    (ledger-refusal-line.ts); `releaseProxyFrame` passes owner frames to 64 MiB and answers a bigger result with the
    fixed error and the same id (proxy-turn-release.ts 201-215); `ReleaseBudget.ownerKept` degrades crossings
    (release-budget.ts 78-105). Still open there: `host-computer-proxy.ts` `post` 16 MiB (CAPS-INVENTORY B13, marked
    BUILD, unchanged at 22039551ff) and the broker reader 16 MiB (B12 names the agent-browser line; the same
    `MAX_RESPONSE_BYTES` serves the host broker).

## 2. Decisions (fail-closed choices)

- D1 One release, one pin set. Same 0.55.0 release and `checksums.txt` sha as cua-upgrade. Windows pins live in a NEW
  file `scripts/cua-driver-0.55.0-windows-provenance.json`. W-P3 fails if its version differs from the cua-upgrade
  provenance version or `package.json`. A pin bump moves all three (C1).
- D2 Stage two files only: `cua-driver.exe` and `cua-cursor-theme.exe` into `resources\cua-win32-x64\`, each its own
  `extraResources` entry whose `from` is one `.exe` file (never a folder: with `forceCodeSigning` a folder copy is
  re-signed with Murage's certificate and breaks the pin; pattern = the signal-runtime `java.exe` entries). Never
  stage `cua-driver-uia.exe`, the dll, the `.node` or the header.
- D3 Supervised daemon. Electron main spawns
  `cua-driver.exe serve --embedded --socket \\.\pipe\murage-cua-<pid>-<generation12> --pid-file <runtimeDir>\driver.pid --permission-mode standard`
  with `CUA_DRIVER_PARENT_LIVENESS_STDIN=1` and `windowsHide`. The harness opens per-turn MCP sessions with
  `mcp --embedded --socket <pipe>` through the broker.
- D4 Spawn env, exact and scrubbed (daemon, MCP child; the cursor helper inherits the daemon's). Base = the parent
  env with every key matching `/^CUA_/i` and `DO_NOT_TRACK` removed; then set exactly `CUA_DRIVER_EMBEDDED=1`,
  `CUA_DRIVER_HOST_BUNDLE_ID=com.murage.app`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`,
  `CUA_DRIVER_RS_UPDATE_CHECK=false`, `DO_NOT_TRACK=1`. Electron does the scrub for the daemon. For the MCP child the
  broker's merge already lets spec keys win; the scrub of other inherited `CUA_*` keys is C5 (broker owner, all
  platforms). The OFF value is the literal `"false"` (Linux value); if r4 settles on a shared OFF constant for Mac,
  Windows imports it (C2).
- D5 Strict win32 descriptor; the legacy path dies. `legacyPlatform()` returns darwin only, and win32 never falls back
  to the legacy decoder. New `decodeWindowsDescriptor`, exact keys: mode `windows-supervised`, platform `win32`,
  `schemaVersion 1`, status `ready`, `generation`, `driver{path,version,source:"bundled",sha256,fileIdentity}`,
  `daemon{pipe,pid,contractVersion,toolsListSchemaVersion:"1",capabilityVersion:"1",mcpProtocolVersion:"2025-06-18"}`,
  `mcp{command==driver.path,args==["mcp","--embedded","--socket",pipe],env==D4 set exactly}`. `version` and
  `contractVersion` compare against the exported constants (C1; until then literals `0.55.0`/`0.9.0`). `driver.path`
  must equal `<resourcesPath>\cua-win32-x64\cua-driver.exe`; `driver.sha256` must equal the server's OWN pinned
  constant (imported from the windows provenance JSON, never trusted from the descriptor). Pipe must match
  `^\\\\\.\\pipe\\murage-cua-\d+-[0-9a-f]{12}$`. Anything else = null (unavailable).
- D6 Integrity at daemon start AND at every MCP session spawn (closes ASTRA H4).
  (a) Electron, before each daemon spawn (r5, ASTRA r4 "daemon hashing path-racy"): both staged exes go through the
  SAME fd-bound check as (b), one shared function `verifyExeIdentity(path, pinSha256, fs)` in
  `shared/cua-driver-identity.mjs` (open once, `fstat` before and after hashing through the fd, path `stat` equal to
  the fd identity right before spawn, bigint). A hash by path (`readFile(path)`) is not allowed anywhere. On win32 `verifyExeIdentity` opens
  the file without write or delete sharing (`UV_FS_O_EXLOCK`) for the duration of the hash, so an in-place write
  during the hash is refused by the OS rather than left to NTFS timestamp updates; the fd is closed before spawn
  (CreateProcess needs to open the file), and the path `stat` compare covers a replace after the close. W-R3 runs
  one W-S1b / W-S3b in-place cell on real NTFS (a second handle's write attempt fails while the hash runs). Mismatch of
  hash or identity on either exe -> `driver-integrity`, spawn 0.
  (b) Harness, before the broker starts a NEW MCP child for a win32 descriptor (once per bot turn that uses the
  computer, about 60 ms for 33 MB): the identity is bound to the bytes actually hashed (r4, ASTRA r3 H4). Open
  `driver.path` once read-only (`fd`); `I0 = fstat(fd, {bigint:true})` (`dev`,`ino`,`size`,`mtimeNs`,`ctimeNs`; bigint
  because the NTFS file index does not fit a double); hash by reading from `fd` only (never re-opening the path);
  `I1 = fstat(fd)` after the last read must equal `I0` (catches an in-place write during the hash); close `fd`; right
  before spawn `stat(driver.path, {bigint:true})` must equal `I0` (catches a rename/replace during or after the hash:
  the path now names a different file object than the one hashed). Hash != pin, or any identity mismatch ->
  0 spawns, the call answers the tool error "This computer's driver failed its integrity check, so nothing was
  performed. The owner can reinstall Murage." and the harness tells Electron (`murage:cua-integrity` message), which
  moves the card to `driver-integrity` and stops the daemon. Implemented as a `verifySpawn(spec)` hook the Windows
  descriptor attaches to the spec and the broker awaits inside `acquire().ready` and the one-off path before
  `this.start` (C6, broker owner). Residual: a same-user process racing a rename between the stat and CreateProcess is
  the same-user trust boundary every platform has (Parked P-6).
- D7 Consent: Linux parity, both callers (closes ASTRA H7). A bot reaches this PC only with the app Local control
  switch on (default OFF) AND the bot explicitly on "This computer". Auto never mounts the host on win32.
  Server: `shouldMountLocalComputer` local branch adds win32 (still false when `!providerSupportsLocal`); Auto stays
  darwin-only; `hostConsentState` stays `not-needed` on win32 (explicit choice). Renderer, the same rules in the same
  release: `autoSelectsLocalComputer` becomes `platform === "darwin" && ...` (Auto is never shown as local on win32 or
  linux); `autoMountsThisComputer` local adds win32 (so the existing switch-off sweep and "stop touching my computer"
  copy cover Windows); `localComputerDisabledReason` on win32 returns the blanket text only when the driver is
  unavailable for a platform reason, and otherwise the card reason (D8/D9/section 4 codes, copy table W-K1). One
  parity test pins each server predicate to its renderer twin on win32 (W-C1/W-C3).
- D8 Elevation probe, positive parse only (closes ASTRA M2, FABLE M5). Electron runs
  `%SystemRoot%\System32\whoami.exe /groups /fo csv /nh` (absolute path, `windowsHide`, 5 s timeout). Allowed ONLY when
  the output parses as CSV and has exactly one row whose SID is `S-1-16-8192` (Medium) or `S-1-16-8448` (Medium Plus).
  A High (`S-1-16-12288`) or System (`S-1-16-16384`) row -> `windows-elevated`. Nonzero exit, timeout, spawn error,
  unparsable output, no mandatory-label row, two label rows, or any other label (incl. Low) -> `windows-integrity-unknown`.
  Spawn 0 in every refused case. Copy: `windows-elevated` = "Murage is running as administrator, so Local control is
  off. Start Murage normally, not with Run as administrator. If this Windows account always runs apps as
  administrator (UAC turned off, or the built-in Administrator account), Local control can't be used on it."
  `windows-integrity-unknown` = "Murage couldn't confirm it is running without administrator rights, so Local control
  is off. Restart Murage to try again."
- D9 Windows on Arm = off: `app.runningUnderARM64Translation` true -> `windows-arm64-unsupported`, spawn 0. Copy: "Local
  control isn't available on Windows on Arm yet."
- D10 Locked or unknown = refuse, at every point the action could still start (closes FABLE H1/H2, ASTRA H2).
  Scope: the win32 descriptor only; darwin/linux routes are unchanged (FABLE M2).
  (a) Channel: Electron main sends `{type:"murage:host-desktop", state:"locked"|"active"|"unknown"}` over
  `serverProc.postMessage` (the private utility-process port beside `murage:power`; only main holds it, so it is the
  authenticated channel). Sent on every `lock.onChange`, and on every server process start, right after main calls
  `lock.refresh()` (so a fresh harness and a fresh boot both get a real reading, never a stale one), and again when the
  harness reports it is listening: right after it registers its handler the harness posts
  `{type:"murage:host-desktop-ready"}` (same pattern as `murage:sentinel-io-ready`, main.mjs 2800), and main answers
  with `refresh()` + the current state (FABLE r2 M5), so a first post sent before the handler existed is repeated.
  Harness -> main messages (`murage:host-desktop-ready`, `murage:cua-stuck`, `murage:cua-integrity`) go over
  `utilityParentPort.postMessage` (index.ts 1967) and are handled in main's existing per-process `proc.on("message")`
  switch (main.mjs 2800-2870), which calls into `cua-windows-runtime.cjs` (FABLE r2 M1). Main reads
  `lock.state()` (not the boolean `onChange` argument) and maps `unlocked` -> `active`, `locked` -> `locked`, anything
  else -> `unknown`; `unknown` is never mapped to active.
  (b) Harness state: `hostDesktop` starts `unknown` in every harness process (the harness exits with main, so a new
  harness always starts unknown; there is no disconnect event to rely on). Only `active` permits an action; `locked` and `unknown` refuse.
  (c) Gate: `hostDesktopOk(method)` = `method !== "tools/call" || hostDesktopActive()` (true on non-win32
  descriptors) is a term of the route's `authorized()`, so for `tools/call` it is re-checked at entry, after the
  consent wait, after the per-action card, every 100 ms while the call runs, and by the broker's `allowed()` after the
  MCP child's `initialize` settles and right before the action is sent (broker `onSession`/one-off `allowed()` after
  `await item.ready`). `tools/list` is never gated by the lock (ASTRA r2 M1). Wherever `authorized()` fails and the
  cause is the lock, the route answers 409 `{code:"host-locked", sent}`, never the generic 403 (a 403 seals the mount
  for the turn, section 1). When `sent` is true the route also sets the existing withdrawn-action turn note
  (`desktopActionWithdrawn`, set today only for code `cancelled`), so the turn-end text still warns that part of the
  action may have landed (FABLE r2 M3). `host-computer-proxy.ts` maps it to
  the tool error "This PC is locked. Computer actions resume when the owner unlocks it; nothing was performed." or,
  when `sent` (the action was already inside the driver and was withdrawn), "This PC was locked while this action ran;
  it was cancelled, but part of it may already have taken effect. Check the screen after the owner unlocks it."
  `tools/list` still answers. The turn is never stopped or held.
- D11 UAC: refused by construction (D2, D8, OS secure desktop + UIPI), plus one sentence in the win32 host-computer
  instructions: "If Windows shows an administrator (UAC) prompt, you cannot answer it: tell the owner and wait."
- D12 Omitted-size default, never a cap. For the win32 descriptor only, the route fills `max_image_dimension: 1568` on
  `get_window_state`, `get_desktop_state` and `zoom` when the call has neither `max_image_dimension` nor
  `max_dimension`. An explicit value of either key (incl. 0 = native) passes unchanged; `set_config` untouched. The
  fill-in applies to a tool only if the real 0.55.0 `tools/list` inputSchema of that tool declares
  `max_image_dimension`. The list is computed at load from a recorded schema file
  `server/testing/cua-0.55.0-win-tools-list.json` captured by W-R8 (never hard-coded); a tool lacking the property is
  not filled, not guessed (ASTRA r2 M4). D12 is a
  convenience; P6 rests on section 6, not on D12.
- D13 Crash, disable and Retry retire the old generation's claim (closes ASTRA H3). See section 4b.
- D14 Quit/update stop is one barrier and never installs over a live driver (closes ASTRA r2 H4, FABLE M7). win32 stop
  = withdraw G (D15), then `taskkill /PID <exact pid> /T /F`, then await the child's `exit` event, bounded by
  `WIN_CUA_STOP_MS` 5000. There is no second, shorter barrier around it: on win32 the existing "computer-use
  startup/cleanup" stage of `cleanupDesktopForExit` is ONE call, `cuaCleanupStage({stop: stopCua, ms:
  cuaStopStageMs("win32")})` from `cua-windows-runtime.cjs` (6000 = `WIN_CUA_STOP_MS + 1000`), and it does not await
  `cuaReady` first (r4, ASTRA r3 M2: a 10 s handshake could make a first `cuaReady` await reject before any stop ran).
  The runtime's `stop()` handles a pending start itself: while `starting` it posts `withdrawn:G`, kills the starting
  child (D15) and treats a handshake that completes afterwards as rejected (G is withdrawn). darwin/linux keep both
  existing awaits at 2500, unchanged. A driver that exits at 4 s passes. On timeout the stage rejects through the existing path: `cuaCleanedUp` stays false, the descriptor
  stays withdrawn, the pid and ownership are retained, the card shows `driver-stuck`, the updater releases the pending
  install (`BACKUP_UPGRADE_CLEANUP_FAILED`, existing owner notice, retryable: the next Install or Quit stops the
  retained pid again), and the installer is invoked 0 times. Quit on timeout follows the existing rule (cleanup reported
  incomplete; the person may retry Quit or force-quit through the OS). r2's "quits anyway" is withdrawn. On disable
  or a `cua-stuck` restart a timeout ends in `unavailable:driver-stuck` (4a/4b, R17c).
- D15 Disable fences admission before it stops anything (closes ASTRA r2 H2). Every stop of G (disable, Retry over a
  live G, `cua-stuck`, integrity, quit, update) runs in this order in `cua-windows-runtime.cjs`: (1) post
  `{type:"murage:cua-generation", withdrawn:G}` and delete the descriptor file; (2) taskkill; (3) on `exit`, post
  `{retired:G, exitConfirmed:true}`. On `withdrawn:G` the harness adds G to `withdrawnGenerations`; `generationOk()`
  (the current descriptor names G and G is not withdrawn) is a term of `authorized()`, so a new `tools/call` on G is
  refused with 409 `{code:"host-off", cause}`, worded by cause: disable "Local control was switched off on this PC;
  nothing was performed."; restart (`cua-stuck`, Retry) "Computer control is restarting on this PC; nothing was
  performed. Try again in a moment."; integrity: the D6 sentence; quit/update "Murage is closing or updating; nothing
  was performed." The `cause` rides on the `withdrawn:G` message. A
  call in flight is withdrawn by the 100 ms poll (answered `cancelled` with its `sent` flag). The claim of a withdrawn
  generation is kept until `retired:G, exitConfirmed:true` (4b): a live daemon might still type, so no new action on
  any generation starts until G's exit is confirmed. If taskkill fails or `exit` never comes, G stays withdrawn
  forever in that harness, the card shows `driver-stuck`, and a re-enable does not spawn while the old pid lives.
  Disable during `starting` (no descriptor yet) kills the child and posts `withdrawn:G` all the same; a descriptor
  written late by a racing handshake is rejected because the harness already holds G as withdrawn. The message
  shapes live in one shared module `shared/cua-host-messages.mjs` imported by both main and the harness.
  Main is the authority, never the descriptor file (r4, ASTRA r3 H2). The harness admits a win32 generation only
  when main has named it live in THIS harness process: `generationOk()` = the current descriptor names G AND
  `liveGeneration === G` AND G is not in `withdrawnGenerations`. Every harness process starts with `liveGeneration =
  null`, so a descriptor that survived on disk (its deletion failed, and taskkill failed too) admits nothing in a
  replacement harness. Main sends `{type:"murage:cua-generation", live:G|null}` on every `ready(G)` and every stop
  (`live:null` before `withdrawn:G`), and in answer to every `murage:host-desktop-ready` (the same re-send hook as
  D10a). From the first step of any stop of G main is `stopping(G)` and answers `live:null`; in `driver-stuck`,
  `starting`, `checking` or any `unavailable:*` it answers `live:null`.
  r5: which harness may hear `live:G` is D20 (a generation is live in ONE harness process only), and the leftover
  process at app start is D19 (identity = pid AND process start time). Deleting the descriptor stays step (1) of D15,
  but nothing depends on it succeeding.
- D16 MCP child loss is unconfirmed, and goes through the confirmed path (closes ASTRA r2 H3). (a) When a per-turn MCP
  child exits, errors or its reader fails while a `tools/call` has started and has no reply, the broker answers that
  call 409 `{code:"driver-lost", sent:true}` ("This computer's driver connection broke while this action ran. It may
  have partly happened; check the screen before continuing.") and keeps the claim; the harness posts
  `murage:cua-stuck {generation:G}` at once (no 10 s wait: the child is already gone), and Electron runs the D15 stop
  and a new `checking`, so the claim clears only on `retired:G, exitConfirmed:true`. A 409 with a code, never a 500,
  so the mount is not sealed and the next action, after restart, works. (b) Reader overflow (a line over the 64 MiB
  ceiling, section 6) releases the claim only with proof the oversized line was the matching reply: the splitter kept
  discarding until the line's terminating newline (complete), its first 4 KiB match
  `^\{"jsonrpc":"2\.0","id":<the one pending request id>,"result":` (attributable; a session has at most one request
  in flight), and nothing else is pending on that child. With proof: that call gets the oversize tool error (section
  6), the session is closed, the claim released. Without proof (no newline before child exit, id not in the prefix,
  an `error` or a notification shape): the call answers `driver-lost` and recovery is (a). W-R8 records the real
  0.55.0 reply byte order; if `id` does not precede `result`, every overflow takes (a), which is slower but never
  wrong.
  (c) Overflow is bounded in time (r4, ASTRA r3 H3). The moment the splitter crosses the ceiling it starts
  `OVERFLOW_DISCARD_MS` = 10 000 (injectable clock; a 64 MiB line crosses a local pipe in well under 1 s). If the
  terminating newline has not arrived when it fires, the reader stops discarding, rejects the pending request with
  `{code:"frame-too-large", complete:false}` and fails the session; the broker takes the no-proof path: that one call
  answers 409 `{code:"driver-lost", cause:"oversize", sent:true}`, the claim is kept, `onUnconfirmedLoss` posts
  `murage:cua-stuck {G}`, and the claim clears only on `retired:G, exitConfirmed:true` after the D15 restart. The
  call never stays pending, and the turn goes on. Copy for `cause:"oversize"` (FABLE r3 M3, worded by cause): "This
  computer's reply was too large to pass on (over 64 MiB), so its driver is being restarted. The action may have
  partly happened; check the screen, then ask again with a smaller max_image_dimension."

- D17 Taking consent away reaches every thread, and Disable never waits on anything (r5, ASTRA r4 A1).
  Today (read at 1ed75a3b2e): the host route's `authorized()` (index.ts 31444-31448) checks the grant captured in
  `hostComputerThreads` when the turn was bound and never re-reads the bot's setting; the bot-settings handler
  (index.ts 36366-36381) stops only the bot's primary thread (`existingBot.threadId`) when "This computer" is taken
  away, so a second chat or a routine of that bot keeps a live grant. The settings card
  (`src/components/LinuxLocalControl.tsx` 42-47) awaits `POST /api/local-computer/interrupt` BEFORE it asks Electron to
  Disable, so a failed or hanging sweep skips Disable.
  (a) One fence, in the route: `selectionOk()` = `botUsesHostComputer(store.bot(entry.botId)?.computer)` read from
  the store at every evaluation (never from the grant, never cached). It is a term of `authorized()`, so it is
  checked at entry, after the card, every 100 ms while a call runs, and by the broker's `allowed()`. It applies to
  every thread because it keys on the bot, not the thread, and to every way the setting can change (settings
  request, bot deleted, import) because it reads the store. All platforms (on darwin a bot on Auto still passes, as
  today; on linux and win32 only "This computer" passes).
  (b) Answer: 409 `{code:"host-off", cause:"bot-off", sent}`, never 403 (a 403 seals the mount, section 1). Tool
  text: "This bot is no longer set to use this computer; nothing was performed." or, when `sent`, "This bot was
  taken off this computer while this action ran; it was cancelled, but part of it may already have taken effect."
  with the existing withdrawn-action note. `tools/list` gets the same 409. The settings handler's existing interrupt of the bot's primary thread is kept
  (index.ts 36366-36381); the fence is what covers every other thread. If the owner sets the bot back to "This
  computer" while such a non-interrupted turn still runs, the term is true again and that turn's next call works (the owner's newest choice
  wins both ways).
  (c) Disable order on the card (all platforms that show it): for `disable`, the card calls
  `window.muragebox.localControl.disable()` FIRST and always; the interrupt sweep is sent after it, and neither waits
  for the other's result. A sweep that fails, or never answers, is shown as a one-line warning and changes nothing
  about Disable. `retry` keeps today's order (it revokes nothing).
  (d) Disable in main does not depend on the harness or on the setting being saved: the handler posts `live:null`
  and `withdrawn:G` and starts the D15 stop first, then saves the preference. If saving fails the stop still
  completes and the handler rejects with "Local control was stopped, but Murage couldn't save the setting, so it may
  turn on again when Murage restarts. Switch it off again." (truthful; shown on the card).
- D18 The start epoch: nothing spawns after a stop, from any await point (r5, FABLE r4 H5, ASTRA r4 A3).
  The runtime holds one integer `epoch`. Every stop (disable, quit, update, Retry, integrity, `cua-stuck`, harness
  rotation D20) increments it before anything else. `checking` records `e = epoch` on entry. After EVERY await in
  `checking` (leftover stop D19, arm64 read, elevation probe, each `verifyExeIdentity`) the continuation returns if
  `epoch !== e`. The spawn itself is `spawnIfCurrent(e)`: the compare and the `spawn` call are in one synchronous
  block with no await between them, and it is the only place a driver process is created (the builder's SITES.md
  carries the grep showing one `spawn(` of the driver in the runtime). A stop during `checking`
  also kills the probe child by its exact pid and closes the hashing fd, so the pending await ends at once.
  Join: `stop()` returns a promise that resolves only after the pending check's continuation has returned
  (`checkSettled`), as well as after any child's confirmed exit. So the win32 `cuaCleanupStage` (D14) cannot resolve,
  and the installer cannot be admitted, while a check is still pending. If the join does not finish inside the stage
  bound the stage rejects through the existing path (installer 0 times, retryable notice). Retry during `checking`
  starts a new check under the new epoch; the old one returns without spawning, so there is never a second daemon.
  Counted unit: driver processes spawned after the stop = 0. Trigger rows: W-Q4.
- D19 A leftover or adopted process is identified by pid AND start time, and its death is observed (r5, ASTRA r4
  A5, FABLE r4 H5). Right after each spawn returns, the runtime writes `<runtimeDir>\driver.owner.json`
  `{pid, start, generation}` where `start` is the process creation time read with the existing native
  `processStart(pid)` (FILETIME decimal string; `native/engine-exclusion/exclusion.c` `process_start`, validated by
  `validProcessStart` as `electron/data-dir-lease.mjs` does). The record is removed after a confirmed exit.
  App start, inside `checking` and before any spawn: no record -> nothing is adopted and nothing is killed (a
  `driver.pid` alone is not proof; a driver without a record has lost its parent and exits by
  `CUA_DRIVER_PARENT_LIVENESS_STDIN`). Record present: `now = processStart(record.pid)`.
  `processStart` returns null both when the process is gone and when it could not be read (`OpenProcess` refused,
  native addon missing; exclusion.c 2184-2200), so null alone is UNKNOWN, never "gone" (r5 self-review; the same
  reading as data-dir-lease.mjs 158-160). "Gone" is proven only positively: `gone(pid)` = `now` is a valid start
  different from the record's, OR `%SystemRoot%\System32\tasklist.exe /FI "PID eq <pid>" /FO CSV /NH` (absolute
  path, `windowsHide`, 5 s) exits 0 and its output parses as zero process rows (positive parse, as D8; any other
  output, a timeout or a spawn error is UNKNOWN).
  Record present and `gone(pid)` with no matching start -> delete the record, nothing is killed (covers the reused
  pid: taskkill is NOT called for a process whose start differs). `now === record.start` -> it is our driver. Identity and
  termination are bound to ONE process handle (r5 precheck pass 3: a check by pid followed by a kill by pid can hit a
  pid reused in between): the Windows builder adds `terminateIfStart(pid, start)` to the same native addon, which
  opens the process once, reads the creation time from THAT handle, calls `TerminateProcess` on that handle only if
  it equals `start`, and returns `terminated`, `mismatch` or `unknown`. `taskkill` by pid is never used on an adopted
  process (it stays for an owned child, whose `ChildProcess` holds the handle). `mismatch` -> not ours, nothing
  killed, record deleted; `unknown` -> `driver-stuck`. After `terminated`, poll every 100 ms; the exit is confirmed only when `gone(pid)` (taskkill's own exit
  code confirms nothing: an adopted process has no `exit` event in this app instance). UNKNOWN at adoption, or exit
  not confirmed inside `WIN_CUA_STOP_MS` -> `unavailable:driver-stuck`, spawn 0, record kept (fail closed: no second
  daemon). The same rule confirms a retained pid on re-enable (D15) and Retry. An owned child is still confirmed by
  its `exit` event.
- D20 One harness per generation (r5, ASTRA r4 A2). Today's r4 text let a replacement harness hear `live:G` while
  the daemon was still `ready(G)`; the replaced harness may have sent a click that the daemon is still performing,
  and the new broker starts with no claim, so a second action could start beside it. Rule: when main names G live it
  records the harness process it told (`liveHarness`, the utility-process object). `murage:host-desktop-ready` from
  that same process is answered `live:G` again (idempotent; its broker still holds its claims). The harness process
  exiting, or `-ready` arriving from any other process, while main is `ready(G)` or `starting(G)`, is a stop of G
  with cause restart (main's `proc.on("message")` passes the sending process object to `onHarnessMessage(message,
  proc)`; W-K5 (vii)/(viii) go through that routing) (D15 order, D18 epoch) and a new `checking`: the answer is `live:null`, the new harness refuses
  with the restart sentence, and `live:G+1` is sent only after G's exit is confirmed. Cost: a harness crash restarts
  the driver (a few seconds); nothing is ever performed twice or side by side.
  The fence itself (FABLE r4 H3): `generationOk()` is as D15 states; W-K5 (v) tests it with the desktop `active` and
  every other term true, so only the missing `live` message can be what refuses.
- D16 r5 note (FABLE r4, carried Medium): every no-proof overflow answer carries `cause:"oversize"` and the oversize
  copy of D16(c), not only the timer path.

## 3. Requirements and witnesses

Every witness is RED-capable: the named mutant turns it RED at its targeted assertion. Each assertion a mutant targets
is its own `it()` / own `assert` line, placed after the setup the mutant does not touch (MUTANT RECEIPTS rule).

| # | Requirement (promise) | Witness (test file -> assertion) | Mutant -> RED at |
|---|---|---|---|
| R1 | P2 staged zip is the published one | W-P1 `scripts/cua-windows-release.test.mjs`: `prepare-cua-windows.mjs --offline <zip>` rejects a zip whose sha256 != pinned; pinned == the checksums.txt line | M-P1 skip the zip-sha compare |
| R2 | P2 only the 2 members, hash-checked | W-P2 same file: real-shaped fixture zip (with uia exe, dll, node, h) -> staged dir lists exactly 2 names; 1-byte-changed `cua-driver.exe` -> throws | M-P2 stage `*.exe`; M-P2b skip member hash |
| R3 | D1 one version | W-P3: windows provenance version == cua-upgrade provenance version == package.json | M-P3 windows JSON 0.54.0 |
| R4a | P2 no folder copy (lane-receiptable) | W-P5 `scripts/cua-windows-release.test.mjs`: parse `electron-builder.yml` win `extraResources`: every entry whose `to` starts `cua-win32-x64` has a `from` ending `.exe` naming one file; no directory entry; exactly the 2 names | M-P5 replace with the folder entry |
| R4b | P2 packaged bytes unchanged | W-P4 `scripts/verify-windows-package.mjs`, release.yml Windows job (windows-latest) step after electron-builder: member sha in `win-unpacked` == pinned | release-only: M-P4 folder copy (needs Murage signing; receipted on the first signed CI run, named as such) |
| R4c | P7 packaged app launches: the shared message module is packaged (r4, ASTRA r3 H5) | W-PK1 the EXISTING gate test `scripts/check-packaged-shared-imports.test.mjs` (CI step "Every module the packaged main process imports is packaged", ci.yml 128-130): `missingFromPackage()` is empty with `electron/cua-windows-runtime.cjs` and `electron/main.mjs` importing `../shared/cua-host-messages.mjs` by a literal specifier (no computed path, so the scanner sees it); the builder adds `- shared/cua-host-messages.mjs` to the `files:` list of `electron-builder.yml` beside the other `shared/*.mjs` lines | M-PK1 delete the `shared/cua-host-messages.mjs` line from `electron-builder.yml` (RED at `scripts/check-packaged-shared-imports.test.mjs:42`, the `missingFromPackage()` `toEqual([])` assertion, naming the module) |
| R5 | P2 integrity at daemon start, fd-bound (r5, ASTRA r4 A4) | W-S1 `electron/cua-windows-runtime.test.mjs`, through the runtime's real enable entry: 1 changed byte in either staged exe -> `driver-integrity`, spawn 0. W-S1b same file, table {`cua-driver.exe`, `cua-cursor-theme.exe`} x {rename a same-size other file over the path after the first read through the fd; write one byte in place through the path after the first read}, injected `fs` as in W-S3b, one `it` per cell -> `driver-integrity` and spawn 0. Base RED (r4 design, hash by path): the rename cells spawn 1 | M-S1 skip hash (RED at W-S1 spawn 0); M-S1c REVERT: daemon start hashes by path with no fd identity (RED at the driver rename `it`); M-S1d only `cua-driver.exe` goes through `verifyExeIdentity`, the helper by path (RED at the helper rename `it`); M-S1e NOOP: `verifyExeIdentity` returns ok without reading (RED at W-S1) |
| R5b | P2 integrity at each MCP session spawn | W-S3 `server/host-computer-win-gate.test.ts`: descriptor ready (it carries the pin, so D5 accepts it), then the staged exe is replaced with a same-size other file -> `tools/call` answers the D6 integrity error, start fn called 0 times, `murage:cua-integrity` posted. W-S3b same file (r4, ASTRA r3 H4): `verifySpawn` runs with an injected `fs` whose `read` on `fd`, after the first chunk, atomically renames a same-size other file over `driver.path` (the original bytes keep being hashed through `fd`) -> integrity error, start fn called 0 times (own `it`); and a second cell writes one byte in place through the path after the first chunk -> same (own `it`) | M-S3 skip `verifySpawn` (RED at W-S3 start 0); M-S3c the r3 shape: every identity read by path `stat` (after hashing and before spawn), no `fstat` at all (RED at W-S3b rename `it` start 0: the hash of the original matches the pin and both path stats see the replacement); M-S3d no `I1` re-check AND the pre-spawn compare limited to `dev`,`ino`,`size` (RED at W-S3b in-place `it`; with either check alone present the other catches it, self-review r4) |
| R6c | P3 cursor helper has no network path of its own (r4, ASTRA r3 M3) | W-P6 `scripts/cua-windows-release.test.mjs`: `prepare-cua-windows.mjs` parses the PE import table (and delay-load table) of the staged `cua-cursor-theme.exe` and fails staging if it names any of `ws2_32.dll`, `winhttp.dll`, `wininet.dll`, `urlmon.dll`, `dnsapi.dll`, `iphlpapi.dll`; the pinned 0.55.0 result is recorded in the windows provenance JSON; cells: the real-shaped fixture PE without them stages, a fixture PE importing `winhttp.dll` throws | M-P6 import scan skipped (RED at the winhttp `it`) |
| R6 | P3 spawn env exact + scrubbed | W-S2 `electron/cua-windows-runtime.test.mjs`: parent env has `CUA_DRIVER_RS_TELEMETRY_ENABLED=true`, `DO_NOT_TRACK=0`, `CUA_DRIVER_FOO=1` -> captured daemon env has the D4 values and no other `CUA_*` key | M-S2 drop `DO_NOT_TRACK`; M-S2b no scrub |
| R6b | P3 MCP child env under hostile inherit | W-S4 `server/host-computer-win-gate.test.ts`: harness `process.env` with the same hostile keys -> env captured by the broker start fn has D4 values (own `it`) and no other `CUA_*` key (own `it`, needs C5) | M-S4 merge order `{...spec.env,...process.env}` (RED at the D4-values `it`); M-S4b broker skips the C5 scrub (RED at the no-other-`CUA_*` `it`; ASTRA r2 M2) |
| R7 | P3/P2 validator rejects | W-V1 `server/local-computer.test.ts` `describe("win32 descriptor")`: valid decodes; each of {no TELEMETRY, TELEMETRY "true", no UPDATE_CHECK, UPDATE_CHECK "1", extra key, command != path, path outside resources, bad pipe, version 0.54.0, sha256 != pinned} -> null, one `it` each | M-V1 no TELEMETRY check; M-V2 no UPDATE_CHECK check; M-V4 (r4: r3's M-S3b, moved here because D5 rejects a forged hash before `verifySpawn` runs, ASTRA r3 H4) decoder trusts `driver.sha256` instead of comparing it to `pin` (RED at the sha256 != pinned `it`) |
| R8 | P2 legacy win32 dead | W-V2 same file: legacy `{mode:"embedded",mcpCommand:"C:\\any.exe",...}` -> `decodeLegacyDescriptor(raw,"win32")` null AND `readCuaConnection({platform:"win32"})` null (base: decodes) | M-V3 legacyPlatform keeps win32; M-V3b fallback to legacy |
| R9 | P1 server routing | W-C1 `server/local-routing.test.ts`, all with `providerSupportsLocal:true` unless named: Auto win32 false; local win32 true; local win32 with `providerSupportsLocal:false` false; `botUsesHostComputer("local","win32")` true; `hostConsentState` "not-needed" | M-C1 Auto true on win32; M-C1b win32 local branch ignores `providerSupportsLocal` (RED at the `providerSupportsLocal:false` cell; ASTRA r3 M4) |
| R9b | P1 renderer never shows Auto as local, warning/sweep cover win32 | W-C3 `src/lib/local-computer.test.ts`: `autoSelectsLocalComputer({platform:"win32",computer:undefined,capabilitiesReady:true,localSelectable:true})` false; `autoMountsThisComputer` local win32 true; parity loop: for each (computer, platform) in {undefined,local,cloud,off}x{darwin,linux,win32} renderer `autoMountsThisComputer` == server `shouldMountLocalComputer` | M-C3 keep `platform !== "linux"`; M-C3b local branch without win32 |
| R10 | P1 switch default OFF | W-C2 `electron/cua-windows-runtime.test.mjs`: fresh userData -> spawn 0, `enabled:false`; enable -> daemon spawn 1 (P3 boundary: the daemon needs the app switch only) | M-C2 default true |
| R10b | P1/P3 the two-switch boundary at the real turn entry (r5, FABLE r4 H4) | W-C4 `server/host-computer-owner-path.test.ts` (section 6a rig: booted production server, Local control on with a ready descriptor of the host's own platform, every bot on Auto). Entry: the owner send route, then `startTurnAdmitting` (index.ts 16296) and its computer blocks (17567, 17591, 17680, 17789). (a) the fake engine reports the MCP servers it was started with: no host-computer server (own `it`); (b) the broker start count is 0 and the fake driver has 0 frames after the turn's reply arrived (own `it`); (c) control: the owner sets that bot to "This computer" through `PATCH /api/bots/:id`, next turn -> the host server is mounted, 1 session, 1 call reaches the fake driver (own `it`). Runs on CI with the linux descriptor and on W-R3 with the win32 one. Base RED for the win32 branch: on 1ed75a3b2e a win32 bot on "This computer" gets no mount, so (c) fails | M-C4 REVERT of the routing rule on the platform under test: the Auto fallback block at 17789 mounts the host when `wants` is undefined (RED at (a)); M-C1 reused, `shouldMountLocalComputer` Auto true on that platform (RED at (a) and (b)); M-C4n NOOP: explicit "This computer" mounts nothing (RED at (c)). Withdrawn in r5: M-C4b (it dereferenced the missing entry at index.ts 31455 before its assertion) and static W-C4s / M-C4s |
| R11 | P4 elevation, positive parse | W-E1 same file, one `it` each: High row -> `windows-elevated`; System row -> same; exit 0 with garbage -> `windows-integrity-unknown`; exit 0 CSV with no label row -> same; Low row -> same; exit 1 -> same; probe timeout (fake clock past 5 s) -> same; spawn error (ENOENT) -> same; two label rows (Medium + High) -> same (FABLE r3 M5); Medium row -> proceeds; Medium Plus row -> proceeds; spawn 0 in all refused cells | M-E1 ignore probe; M-E2 "no High/System row" = allowed; M-E3 timeout treated as Medium (RED at the timeout `it`); M-E4 first label row wins (RED at the two-row `it`) |
| R12 | P7 Arm refused | W-A1: `runningUnderARM64Translation` -> `windows-arm64-unsupported`, spawn 0 | M-A1 drop check |
| R13 | P5 lock at arrival | W-L1 `server/host-computer-win-gate.test.ts` (real route + broker, fake driver via `process.execPath`; lock state delivered by calling the harness's REAL registered message handler with the message built by `shared/cua-host-messages.mjs`): win32 descriptor; `locked`, and separately never pushed (`unknown`) -> `tools/call click` returns the D10 tool error with HTTP 409 (not 403), fake driver 0 calls, the turn reply is delivered, the proxy mount is not sealed (a later `tools/list` on the same proxy answers); `tools/list` while locked -> answers (own `it`); `active` -> 1 call; darwin and linux descriptors with no push -> 1 call (unchanged) | M-L1 no gate; M-L2 unknown = active; M-L3 gate on all platforms; M-L8 gate also on `tools/list` (RED at the locked-list `it`); M-L9 lock refusal answered 403 (RED at the 409 / not-sealed `it`) |
| R13b | P5 lock during a wait | W-L1 cells: (i) per-action card (`askHostAction`) pending, then `locked` pushed, then Allow -> fake driver 0 calls, D10 error; (ii) not on win32: the one-time consent wait is unreachable there (`hostConsentState` is `not-needed` when Auto does not mount the host, host-computer-consent.ts 48), and a cell asserts that on win32 no consent card is ever opened; (iii) action inside the fake driver (it holds its reply), `locked` pushed -> withdrawn within 300 ms, `host-locked` with `sent:true` text AND the withdrawn-action turn note set; (iv) the fake driver holds its MCP `initialize` reply open, `locked` is pushed before it answers, then it answers -> 0 `tools/call` frames reach the fake driver (ASTRA r2 M1), and (r4, ASTRA r3 M1, each its own `it`) the proxy-facing answer is HTTP 409 with body `code:"host-locked"`, `sent:false`, and the tool error text the model sees is exactly the D10 not-sent sentence | M-L4 gate checked only at arrival (RED at i); M-L10 drop the 100 ms poll's gate term (RED at iii); M-L11 drop the broker `allowed()` after `await item.ready` (RED at iv frames); M-L12 note not set for `host-locked` (RED at iii note); M-L15 the broker's late `allowed()` refusal keeps today's generic 409 (no `host-locked` mapping; RED at iv code `it`); M-L16 late refusal reports `sent:true` (RED at iv `sent` `it`) |
| R13c | P5 channel from main | W-L2 `electron/cua-windows-runtime.test.mjs`, driving the REAL main-side wiring function `wireHostDesktop({lock, port})` that main.mjs calls (fake lock tracker + recording port): change -> message with the state; new server process -> `refresh()` called, then current state sent; `murage:host-desktop-ready` from the harness -> `refresh()` + state re-sent; tracker `unknown` -> message `unknown`. W-L3 static: main.mjs calls `wireHostDesktop` for every server process it starts (parse check, own `it`) | M-L5 no re-send on server start; M-L6 unknown sent as active; M-L13 no re-send on ready; M-L14 main.mjs does not subscribe (call removed; RED at W-L3) |
| R13d | P5 fresh harness | W-L1 cell: a new harness instance (state reset as on process start, after an earlier instance saw `active`) -> next call refused with D10 until a push | M-L7 initial state `active` |
| R14a | P6 no cap ends, seals or cuts an owner turn on this path, at any site, on any engine (r5, FABLE r4 H1/H2, ASTRA r4 A6; replaces the r4 loopback rig) | W-B1 `server/host-computer-owner-path.test.ts`: the booted production server and the table of section 6a, one row per SITES site S1-S34 (r6) and per engine E1-E5. No door, header, `withUpstreamOwner` or writer is rebuilt by the test. Every cell asserts at the engine's own boundary: bytes equal, next action works, the turn's reply delivered, no refusal row, no stop line | section 6a: one mutant per applicable SITES row (M-S01..M-S24, M-S26, and r6 M-S18x, M-S29/M-S29n/M-S29d, M-S30a/b, M-S31a/b, M-S32/M-S32d, M-S33/M-S33n, M-S35/M-S35d, M-S37/M-S37d; none for S9, S22, S25 (r6), S27, S28, S34), each with the cell that reaches it; plus REVERT per engine row (that engine's base cap restored), NOOP (the hop forwards nothing: RED at bytes-equal), DROP (the reply replaced by the oversize error although under the ceiling: RED at bytes-equal) |
| R14b | P6 one reply over the ceiling fails one call only; claim released only with proof; one overflow state (r5, ASTRA r4 A7) | W-B3 same file, same booted server, so the real `withUpstreamOwner` accounting is on the path. (i) a complete 65 MiB result line with the pending id first -> that call returns the oversize tool error ("This screenshot was too large to pass on (over 64 MiB). Ask again with a smaller max_image_dimension."), the next `get_window_state` reaches the fake driver (new session, no "Another computer action is in progress"), mount not sealed, no stop line, the turn's reply delivered; (ii) the fake driver writes 65 MiB with no newline and exits -> `driver-lost` cause `oversize`, claim kept, `murage:cua-stuck {G}` posted; (iii) a complete 65 MiB line whose prefix carries another id -> same as (ii); (iv) 65 MiB, no newline, stdout held open, driver alive -> after the reader's overflow state is seen (a probe on the reader state, checked before any clock move) the fake clock advances 10 001 ms and the call has settled (a `settled` flag checked by `expect`) with 409 `driver-lost`, `cause:"oversize"` and its copy (own `it`), claim kept and `cua-stuck {G}` posted (own `it`), and after the confirmed restart the next call reaches G+1 (own `it`). The clock and the state probe are read through the test-only control port the booted fixture already gives its child (never a product switch). Base RED: on caps-opus 22039551ff cell (i) fails, the accounting cut kills the session and the call answers the generic failure, not the oversize error | M-B3 overflow keeps the claim even with proof (RED at i next-call); M-B3b overflow rethrown to the turn (RED at i no-stop-line); M-B3c claim released without proof (RED at ii claim-kept); M-B3d no `OVERFLOW_DISCARD_MS` bound (RED at iv settled); M-B3e the bound releases the claim (RED at iv claim-kept); M-B3f REVERT: the accounting cut fails the session and kills the child, as at 22039551ff (RED at i oversize-error `it` and at iv state probe); M-B3g overflow chunks are charged again after the cut (RED at i: the turn's budget note shows more than one crossing); M-B3h the accounting cut is cumulative across replies (RED at W-B1 (ii) 7th reply bytes-equal) |
| R15 | D12 default | W-B2 same file, one `it` each, fill list computed from the recorded schema `server/testing/cua-0.55.0-win-tools-list.json`: win32 `get_window_state`, `get_desktop_state`, `zoom` with no size -> fake receives `max_image_dimension:1568` for each tool whose recorded schema declares it; a fixture schema copy where `zoom` lacks the property -> `zoom` gets no fill (ineligible cell); explicit `max_image_dimension:0` -> 0; explicit `max_dimension:800` -> passed unchanged, no `max_image_dimension` added; darwin/linux unchanged | M-B2 fill off; M-B2b overrides explicit 0; M-B2c ignores the `max_dimension` alias; M-B2d fill list hard-coded, schema ignored (RED at the ineligible cell; ASTRA r2 M4) |
| R16 | D11 UAC sentence | W-U1 `server/local-computer.test.ts`: win32 instructions contain it; darwin/linux do not | M-U1 remove |
| R17 | D13/D15 crash, disable, Retry, through the real wiring | W-K2 `server/host-computer-win-gate.test.ts`, with `electron/cua-windows-runtime.cjs` loaded in the same process (injected fake spawn/taskkill/clock, its port wired to the harness's REAL message handler, so no message is hand-made): fake driver takes a `click` and never replies; (a) the fake daemon child does not exit -> runtime posts `withdrawn:G` only, the next call (any generation) is refused, claim held, no `retired`; (b) the fake child exits -> the runtime's own `retired:G, exitConfirmed:true` + the new G+1 descriptor -> the stuck call answers `driver-exited`, the next call on G+1 reaches the new fake driver; a call on stale G is refused | M-K2 no release on confirmed exit (RED at b); M-K2b release without `exitConfirmed` (RED at a); M-K2c runtime posts `retired` before exit (RED at a) |
| R17b | D13 withdrawn/unanswered action never kills the feature | W-K3 same file, same in-process runtime: an action withdrawn by lock (R13b iii) or Stop whose fake driver never replies -> after the 10 s grace kill (fake clock) the harness posts `murage:cua-stuck {generation:G}`; the runtime restarts (D15 order), and the first call after unlock reaches the G+1 driver. A `cua-stuck {G}` arriving after G is already retired is ignored: G+1 keeps running and its in-flight call completes (own `it`; FABLE r2 M2) | M-K3 no `cua-stuck` post (RED at the after-unlock call); M-K3b stale `cua-stuck` restarts G+1 (RED at the ignored `it`) |
| R17d | D15 disable fences admission; D19 leftover identity; D20 one harness per generation | W-K5 `server/host-computer-win-gate.test.ts`, the in-process runtime wired to the harness's real handler and to the real main-side `onHarnessMessage`: (i) owner disables while a `click` waits on the per-action card -> Allow -> fake driver 0 calls, `host-off` answer; (ii) disable while an action is inside the driver and taskkill FAILS -> the in-flight call is withdrawn within 300 ms, a new call is refused `host-off`, the descriptor is gone, claim held, card `driver-stuck`; (iii) disable during `starting` -> 0 calls admitted, a late descriptor for that G is rejected; (iv) taskkill NEVER settles -> while it hangs, a new call is refused `host-off` and the in-flight call is withdrawn within 300 ms; (v) (r5, FABLE r4 H3) descriptor deletion FAILS and taskkill FAILS, G's fake daemon stays alive, then the harness is REPLACED (fresh state exactly as on process start) and reads the surviving ready descriptor for G. The new harness's `-ready` post is held on the test port (main is slow); the fake lock tracker reports unlocked, so the real `wireHostDesktop` pushes `active`; the bot is on "This computer" and the card is set to allow. Setup assert, own line: the harness's `hostDesktop` is `active`. Then a `tools/call` answers 409 with code `host-off` and the fake driver gets 0 frames (first `it`; the only false term is `liveGeneration`). Control `it`: the same construction on a runtime in `ready(G)` whose first harness this is -> `-ready` answered `live:G`, the call reaches the driver. Second `it`: the held `-ready` is released, the runtime (`driver-stuck`) answers `live:null`, a call is still refused, 0 frames; (v-b) same with taskkill HANGING (`stopping(G)`) -> `live:null`, refused; (vi) leftover process at app start (D19), injected `processStart` and taskkill: (vi-a) the record's pid and start match a live fake -> `terminateIfStart(pid, start)` called once with the recorded start and taskkill 0 times, exit confirmed by `gone(pid)` (D19), only then spawn 1; (vi-b) the pid is alive with ANOTHER start time (reused) -> nothing terminated (the fake native returns `mismatch`; taskkill 0 times), record deleted, spawn 1; (vi-b2) the pid is reused BETWEEN the first read and the kill (the fake changes the start after `processStart` answered) -> `terminateIfStart` returns `mismatch`, the foreign process is alive, record deleted (own `it`); (vi-c) `terminateIfStart` returns `terminated` but `processStart` keeps the same start for 5 s -> `driver-stuck`, spawn 0; (vi-d) a `driver.pid` with no owner record -> taskkill 0 times; (vi-e) `processStart` returns null and `tasklist` is unreadable (addon missing / probe fails) for a recorded pid -> `driver-stuck`, spawn 0, record kept (own `it`); and in (vi-a) with `processStart` null after `terminateIfStart` the exit counts only once the `tasklist` parse shows no row; (vii) (r5, ASTRA r4 A2) runtime `ready(G)`, the first harness has a `click` inside the fake driver with no reply (its broker holds the claim), then the harness is replaced: the new harness posts `-ready` through the real routing -> answered `live:null`, taskkill called on G's pid, and a `tools/call` on the new harness is refused with the restart sentence while G's fake driver receives 0 further frames (own `it`); (vii-b) G's fake exits -> G+1 spawns, `live:G+1` is sent, the next call reaches G+1's driver (own `it`); (viii) the SAME harness process posts `-ready` twice in `ready(G)` -> `live:G` both times, taskkill 0 times (own `it`). Base RED (r4 design): (vii) second action reaches G's driver; (vi-b) kills a foreign process | M-K5 withdraw posted only after taskkill settles (RED at iv new-call refused); M-K5c withdraw posted only on `exit` (RED at iv and at W-Q1's withdraw-before-taskkill assertion); M-K5b `generationOk` not a term of `authorized()` (RED at i); M-K7 a fresh harness defaults `liveGeneration` to the descriptor's generation (RED at v first `it`, 0 frames: desktop is active, so the call reaches the driver); M-K7b the runtime answers `-ready` with `live:G` while `driver-stuck` (RED at v second `it`); M-K7d `stopping(G)` answers `live:G` (RED at v-b); M-K7c no leftover check at start (RED at vi-a `terminateIfStart` once); M-K7h REVERT of r4: leftover identity = pid and image path only (RED at vi-b taskkill 0); M-K7i adopted stop confirmed by the terminate call's own result (RED at vi-c spawn 0); M-K7l the adopted process is killed by pid (`taskkill /PID`) after a separate identity read (RED at vi-b2 foreign process alive); M-K7j a bare `driver.pid` is adopted (RED at vi-d); M-K7k a null `processStart` is read as gone (RED at vi-e spawn 0); M-K7f REVERT of r4: a different harness process is answered `live:G` in `ready(G)` (RED at vii 0 further frames); M-K7g every `-ready` rotates, same process included (RED at viii taskkill 0); M-K7e `-ready` not routed to the runtime (RED at vii-b reaches-driver) |
| R17g | C4 broker withdraw is its own fence, not only the route's (ASTRA r3 M4) | W-K8 `server/host-computer-broker.test.ts` (broker owner, linux descriptor; mirrored win32 cell in the win gate file, Windows builder): broker called directly with `allowed()` always true (the route gate intact but not the thing tested): `withdrawGeneration(G)` then a call on G -> refused `host-off`, start fn 0 (own `it`); a G claim held by an unanswered action stays `active` after `withdrawGeneration(G)` and clears only on `retireGeneration(G,{exitConfirmed:true})` (own `it`) | M-C4a `withdrawGeneration` a no-op (RED at the refused `it`); M-C4b `withdrawGeneration` clears the claim (RED at the claim `it`) |
| R17e | D16 child loss mid-action | W-K6 same file: the fake MCP child exits after taking a `click` while the fake daemon stays alive -> that call answers `driver-lost` 409 (not 500; mount not sealed), claim kept, `murage:cua-stuck {G}` posted within 100 ms; the runtime restarts and the next call reaches G+1 | M-K6 child loss releases the claim (RED at claim-kept); M-K6b no `cua-stuck` post on child loss (RED at the post assertion) |
| R17f | Electron half of harness messages | W-K4 `electron/cua-windows-runtime.test.mjs`, through the real `onHarnessMessage` that main's `proc.on("message")` switch calls: `murage:cua-stuck {G}` -> D15 stop of G then a new `checking` with G+1; `murage:cua-integrity` -> card `driver-integrity` and D15 stop, no respawn; stale `cua-stuck {G-1}` -> no stop. W-L3 static also asserts main.mjs routes all three harness types (`murage:cua-stuck`, `murage:cua-integrity`, `murage:host-desktop-ready`) to `onHarnessMessage`, which answers `-ready` with both the host-desktop state (`wireHostDesktop`) and `live` (FABLE r2 M1; self-review r4) | M-K4 no `cua-stuck` handler (RED at the restart `it`); M-K4b no `cua-integrity` handler (RED at its `it`) |
| R17c | D14 stop that never exits | W-Q2 `electron/cua-windows-runtime.test.mjs`: stop where the fake child never emits `exit` within 5 s -> state `unavailable:driver-stuck`, no `retired` post, a re-enable does not spawn while the old pid is alive; the card copy is the `driver-stuck` sentence | M-Q2 re-enable spawns G+1 over a live G |
| R18 | P7 card names every reason | W-K1 `src/lib/local-computer.test.ts`: win32 reasons `windows-elevated`, `windows-integrity-unknown`, `windows-arm64-unsupported`, `driver-integrity`, `start-failed`, `driver-exited`, `driver-stuck` each map to their sentence; an unknown code maps to a non-empty generic sentence | M-K1 drop one mapping (RED at its cell) |
| R19 | warm-active-only: no Windows warm engine | W-W1 `server/host-computer-win-gate.test.ts`: (a) the real win32 mount builds the turn options, and the REAL `poolable` predicate (core.ts) returns false for them (own `it`); (b) two-bot expiry: bot A ran a win32 computer turn, bot B keeps sending turns every 2 min under a fake clock -> A has no warm engine after A's 15-minute lease (none is created at all for A's computer turn), B's activity never extends A | M-W1 win32 mount without `localComputer` (RED at a); M-W1b test-time mutant of core.ts 6704 that drops the `localComputer` exclusion (RED at a and b; receipt only, core.ts is not edited by this design; ASTRA r2 M3) |
| R20 | D14 one stop barrier, never install over a live driver | W-Q1 `electron/cua-windows-runtime.test.mjs` (fake clock): stop -> `withdrawn:G` posted before taskkill, taskkill on the exact pid, the stop promise settles only after the fake child's `exit`; no exit -> rejects at 5 s with `cua-stop-timeout`; (FABLE r3 M1, own `it`) the harness is already gone at quit: `port.postMessage` throws and a second cell where it never returns -> taskkill is still called on the exact pid within 50 ms and the stop settles on `exit` (the withdraw post is fire-and-forget and wrapped, never awaited). W-Q3 same file, the real `prepareBackedUpInstall` + `prepareUpdaterRestart` with `cleanup` = the real win32 stage built by `cuaCleanupStage({stop, ms: cuaStopStageMs("win32")})` and a spy installer that runs only when `beforeInstall` resolves: (i) child exits at 4 s -> installer invoked once, after `exit`; (ii) child never exits -> prepare rejects with the cleanup failure, installer invoked 0 times, pid retained, state `driver-stuck`; (iii) (r4, ASTRA r3 M2) update while `starting` (handshake pending, the fake never answers) -> at t=0 `withdrawn:G` posted and taskkill called on the starting child; child exits at 1 s -> installer invoked once, after `exit`, and no descriptor for G is ever admitted (own `it`); (iv) late readiness: the handshake answers at 2 s, after the withdrawal -> the runtime does not enter `ready(G)` and posts no `live:G`, installer once after `exit` (own `it`); (v) starting child never exits -> rejects by 6 s (the stop itself rejects at 5 s, W-Q1), installer 0, pid retained, `driver-stuck` (own `it`). W-L3 static (main.mjs parse, own `it`): on win32 the computer-use stage of `cleanupDesktopForExit` is the single `cuaCleanupStage({stop: stopCua, ms: cuaStopStageMs("win32")})` call (no separate `cuaReady` await, no `CUA_STOP_TIMEOUT_MS`), and the darwin/linux branch keeps its two 2500 awaits | M-Q1 fire-and-forget kill (RED at W-Q1); M-Q1b the withdraw post awaited before taskkill (RED at W-Q1 never-returns `it`); M-Q3 `cuaStopStageMs("win32")` returns 2500 (RED at W-Q3 i); M-Q3b timeout treated as cleaned up (RED at W-Q3 ii installer 0); M-Q3c main.mjs calls `stopCua()` under `CUA_STOP_TIMEOUT_MS` on win32 instead of `cuaCleanupStage` (RED at W-L3); M-Q3d the stage awaits the pending start before stopping (r3 shape; RED at iii taskkill-at-t0); M-Q3e a handshake after withdrawal enters `ready(G)` (RED at iv) |
| R10c | P1 taking a bot off this computer reaches every thread of that bot (r5, ASTRA r4 A1; D17 a-b) | W-C5 same file, booted server. Reachable state (r5 precheck pass 3): production admission gives a bot's screen to ONE thread at a time (`admissionComputerClaims`, index.ts 17591), so two live host mounts of one bot cannot exist and the witness does not ask for them. Setup: a bot on "This computer"; its SECOND thread (a second chat; a second row uses a routine run) has the running owner turn that holds the screen claim and the host grant, bound through the real turn entry; the primary thread has no running turn (a second row: the primary has a turn queued behind the screen claim). Two separate rows (r6, ASTRA 3014: the proxy answers one call at a time, host-computer-proxy.ts 73/87, so a call sent behind a held one cannot reach the driver on any sha and could not show the missing fence). Row A (cell a): the second thread's fake engine has a `click` inside the fake driver (reply held). Row B (cells b, d): the second thread's fake engine sends one `click` that the fake driver ANSWERS (setup assert, own line: the engine got that reply and the fake driver's held counter is 0, so the proxy queue is empty), and the engine then waits for the test's go signal with its turn still running. In both rows the owner sends `PATCH /api/bots/:id` with `computer` Auto; the settings handler interrupts only the primary thread (index.ts 36366-36381), so the second thread's turn keeps running. Then: (a) row A: the held click is withdrawn within 300 ms and answers the `sent` sentence (own `it`); (b) row B, on the go signal: a new `tools/call` on the second thread answers 409 `host-off` cause `bot-off` and the fake driver gets 0 new frames (own `it`); (c) in the queued-primary row the primary's turn then starts with no host-computer server mounted (own `it`); (d) the second thread's mount is not sealed: after `PATCH` back to "This computer" that same turn's next call reaches the driver (own `it`). Trigger rows on cell (b), one `it` each: computer set to Auto, to cloud, to off. Platform (r6 precheck pass 1): the rows run on the CI host's own supported platform (linux) with Local control on and the bot's consent on "This computer" at bind time, so on the base the only check is the bind-time grant (index.ts 31442-31448) and nothing else can refuse the click. Bot deletion is NOT a row: the delete route refuses while a turn of the bot is active, and with no active turn `revokeInternalBot` (index.ts 3758) already drops every grant; stated, not witnessed here. Base RED: on 1ed75a3b2e, and on ba39e92f83's tree (index.ts unchanged there), cell (b) row B fails: with nothing held, the second thread's new click reaches the fake driver (grant still in `hostComputerThreads`, no re-read of the setting; RED at "0 new frames") | M-C5a REVERT: `selectionOk` not a term of `authorized()` (RED at (b) 0 frames); M-C5b the term reads the bot captured at bind time (RED at (b)); M-C5c the 100 ms poll omits the term (RED at (a)); M-C5d the refusal is the 403 (RED at (d): the proxy seals the mount); M-C5e NOOP of the reverse: term always false (RED at (d)) |
| R10d | P1 Disable always happens (r5, ASTRA r4 A1; D17 c-d) | W-C6 `src/components/LinuxLocalControl.test.tsx`, the real card component with a recording `window.muragebox.localControl` and a fake `fetch`; rows {sweep answers 500, sweep network error, sweep never answers} x action disable: `localControl.disable` called exactly once (own `it` per row) and called before the sweep request is issued (order `it`). Base RED: on 1ed75a3b2e the 500 row has 0 `disable` calls (the awaited `api()` throws first). W-C7 `electron/cua-windows-runtime.test.mjs`, the real Disable handler: the preference write throws -> `live:null` then `withdrawn:G` are still posted and taskkill is called on the exact pid (own `it`), and the handler rejects with the D17(d) sentence (own `it`) | M-C6a REVERT: sweep awaited before Disable (RED at the 500 row call count); M-C6b NOOP: the disable action never calls `localControl.disable` (RED at every row); M-C6c Disable waits for the sweep result (RED at the never-answers row); M-C7 the handler saves the preference first and returns on a save error (RED at the withdrawn `it`) |
| R20b | D18 nothing spawns after a stop, from any await point; update joins the pending check (r5, FABLE r4 H5, ASTRA r4 A3) | W-Q4 `electron/cua-windows-runtime.test.mjs`, entries: the runtime's real enable entry, its real stop/disable/Retry entries, and for update the real `prepareBackedUpInstall` + `prepareUpdaterRestart` with `cleanup` = the real `cuaCleanupStage({stop, ms: cuaStopStageMs("win32")})` and a spy installer. Table of held await points {leftover stop pending (D19), arm64 read pending (r6, ASTRA 3014), elevation probe pending, `verifyExeIdentity` of `cua-driver.exe` pending, of `cua-cursor-theme.exe` pending} x triggers {disable, quit, update, Retry}, one `it` per cell, in D18's await order (the builder's SITES.md lists every `await` in `checking` by line; an await with no row is a build blocker). (r6) "No later step" `it` per cell: after the release, no step of `checking` that comes after the held await starts for the old epoch (call counts of the later fakes = 0: the next probe, the next `verifyExeIdentity` open, the arm64 read). This is the assertion only a post-await compare can fail; spawn 0 alone cannot, because `spawnIfCurrent(e)` also stops the spawn. In each cell the fake holds that await, the trigger fires, then the fake releases with an ALLOWING result (Medium row, hash equal): spawn count stays 0 for disable/quit/update and is exactly 1, of the new epoch, for Retry (own `it`); no descriptor and no `live` for the old attempt (own `it`). Update rows also: the spy installer is invoked only after the held check has returned (order `it`: with the probe still held and the fake clock at 3 s the installer count is 0), and with the check held past the stage bound the prepare rejects and the installer count is 0 (own `it`). Also: the probe child's exact pid gets a kill on stop (own `it`). Platform rows and the base (r5 pass 2 and 3, ASTRA precheck): the disable and Retry rows also run over the two runtimes that exist on 1ed75a3b2e and have an await before their driver spawn (class sweep: `electron/cua-linux-runtime.cjs` `await inspect` at 661 before the spawn, entries `enable`/`disable`/`retry`/`shutdown` at 878-892; `electron/cua.mjs` darwin `startCua` 266, `stopCua` 352), through those modules and entries unchanged. The quit and update rows for linux and darwin are NOT part of this witness: on 1ed75a3b2e the production stage already joins a pending start (`cleanupDesktopForExit` awaits `cuaReady` and then `stopCua()`, main.mjs 6204-6205, called from the updater's `cleanup` at 848), that wiring is not replaced or re-built by any test, and it stays as it is on those platforms (D14). No base RED is claimed for any linux or darwin row: the builder records each disable/Retry row as it finds it (a late spawn = a finding for the runtime's owner, the cua-upgrade lane; no late spawn = SITES row COMPLIANT with the fencing line), and a row green on the base is a pin, not a witness of this change. The win32 rows cannot be RED on 1ed75a3b2e by behaviour: no win32 runtime exists there (main reports `unsupported-platform`), and this design claims no base RED for them. Their pre-fix sha is DECLARED instead (PROCFIX P4 "declared pre-fix sha"): the builder first pushes a WIP checkpoint with `cua-windows-runtime.cjs` in the r4 D14 shape (`stop()` handles `starting` only; no epoch, no join), runs the identical W-Q4 file there, and receipts the spawn-0 and installer-order assertions RED at that sha before building D18. The same rule holds for every witness of code that does not exist on 1ed75a3b2e (W-K5 vi/vii, W-S1b, W-C7): RED at the declared r4-shape checkpoint, never a claimed RED on a base that lacks the module | M-Q4a REVERT: no epoch compare at all, neither after the awaits nor in `spawnIfCurrent` (RED at every cell's spawn 0); M-Q4b (r6) the compare after `verifyExeIdentity(cua-driver.exe)` removed, `spawnIfCurrent` kept (RED at that row's "no later step" `it`: the cursor-theme hash starts; spawn 0 stays green by design); M-Q4f (r6) the compare after the arm64 read removed (RED at the arm64 row's "no later step" `it`); the compare inside `spawnIfCurrent` alone is a second guard for an await added later and has no mutant of its own (removing it alone is masked by the post-await compares; stated, not receipted); likewise the compare after the LAST await (`verifyExeIdentity(cua-cursor-theme.exe)`) has no later step, so `spawnIfCurrent` masks it and it carries no mutant (stated, not receipted); M-Q4c the stage resolves without joining the check (RED at the update order `it`); M-Q4d NOOP: a stop in `checking` does not bump the epoch (RED at spawn 0); M-Q4e DROP: Retry re-uses the old epoch (RED at the Retry rows: 2 spawns) |
| R21 | P2-P5 on real Windows | WINRUN section 7 | per row |

Receipts: `receipts.tsv` columns mutant, targeted file:line, observed error class, observed file:line, log path, from
real runner output; the machine check (every row AssertionError and observed == targeted) is pasted in the FIXR line.
New test files go into `ci/gate-tests.txt`. `server/host-computer-win-gate.test.ts` reads no `data_version`; any
memory check uses only the PRAGMA statement (DATA_VERSION rule).

## 4. State machines (Electron main, win32; one terminal path)

4a. Daemon. `off` (preference false) -> enable -> `checking` [arm64 -> `unavailable:windows-arm64-unsupported`]
[probe -> `windows-elevated` | `windows-integrity-unknown`] [hash mismatch -> `driver-integrity`] -> `starting`
(spawn, generation G) -> handshake within 10 s -> `ready(G)`; else `unavailable:start-failed`, child stopped (D14).
`ready(G)` -> child `exit` -> `unavailable:driver-exited`: main posts `murage:cua-generation {retired:G,
exitConfirmed:true}` (the `exit` event is the confirmation that the process, and so any input it could still send, is
gone), rewrites the descriptor without G. The card offers Retry; no automatic respawn loop. Retry = a new `checking`
with a new G. Harness integrity failure (D6b) -> `unavailable:driver-integrity` + stop. Harness `murage:cua-stuck {G}` -> stop G
(D14) -> `checking` with a new G. Stop with no `exit` in 5 s -> `unavailable:driver-stuck` (no spawn while that pid
lives). Lock/unlock never changes
state (D10). Every stop (disable, Retry, `cua-stuck`, integrity, quit, update) is the D15 order: `withdrawn:G` +
descriptor deleted first, then taskkill, then `retired:G, exitConfirmed:true` only after `exit`, then the pid-file and the D19 owner record removed.
A `cua-stuck {G}` or `cua-integrity {G}` naming a generation other than the live one is ignored.
r4: `ready(G)` posts `live:G`; every stop posts `live:null` before `withdrawn:G`; every `murage:host-desktop-ready`
is answered with the current `live` (G only in `ready(G)`). App start (r5, D19): a leftover process is adopted and stopped only through its owner record (pid AND start
time; a bare `driver.pid` is never adopted), the leftover descriptor deleted, then `off`/`checking` as the preference says. The quit/update stage on win32 is the one
`cuaCleanupStage` call (D14), which handles `starting` itself.

r5: `checking` and `starting` run under the start epoch (D18): every stop bumps it, a check that resumes under an old
epoch returns without spawning, and a stop in `checking` joins the check before it resolves. `ready(G)` is bound to
one harness process (D20): the harness exiting, or a different harness posting `-ready`, is a stop of G with cause
restart and a new `checking`. App start adopts a leftover process only by pid AND start time (D19).

4b. Broker claim fence (D13; implemented by C4, the broker owner). Each claim records the descriptor generation it
was admitted under. On `retired:G, exitConfirmed:true` the harness: (1) closes every session whose fingerprint names
G's pipe; (2) answers every call still waiting on G with "This computer's driver stopped while this action ran. It
may have partly happened; check the screen before continuing." (`code:"driver-exited"`); (3) clears `active` if it is
a G claim. A G claim is never cleared without `exitConfirmed` (a live daemon might still type). A call naming a
retired generation is refused before dispatch. The route's `entry.connection` is re-read from the current descriptor
per call on win32, so an open turn never keeps a retired pipe.
Live-daemon paths that would leave a claim forever (closes self-review N2, ASTRA r2 H3): (1) a line over the 64 MiB
ceiling releases the claim only with the D16(b) proof (complete, attributable, sole pending); without it, path (4)
(C7); (2) an action
whose reply never comes after a withdrawal (lock, Stop, revoked turn) hits the reader's 10 s grace kill: the harness
then posts `murage:cua-stuck {generation:G}` and Electron restarts the daemon (stop G with D14, then `checking` with a
new G; `retired:G, exitConfirmed:true` is posted after `exit`), so the claim clears by the confirmed path and the next
call works; (3) a stop that does not see `exit` within 5 s ends in `unavailable:driver-stuck` with no respawn while
that pid lives. Copy: "Computer control's driver didn't stop when asked. Restart Murage to use Local control again."
Re-enable re-checks the pid first; (4) the per-turn MCP child exits or its reader fails with an action started and
unanswered (daemon alive): `driver-lost` answer, claim kept, immediate `murage:cua-stuck {G}`, confirmed restart
(D16a, C8). No path leaves the card at `ready` with a dead claim, and no path answers a 403 or 500 that seals the
mount (section 1).

4c. Warm pool (ASTRA H5). The daemon is one per app and exists only while Local control is on; it is not a bot engine
and not in the pool. Per-turn MCP sessions are broker sessions keyed [bot, thread, generation, revision] that retire
with the turn (sweep 2 s) or after 5 min idle; they are never shared across bots. A turn that mounts the host computer
is never `poolable` (core.ts 6702-6704), so no bot engine is kept warm because of Windows computer use, and bot B's
turns can never keep bot A's engine alive through this path. W-W1 pins the win32 mount to that exclusion. Pool rules
for other turns stay WARM-1021-DRIVER's (MAIN-RULING warm-active-only); this design adds no pool member and changes no
eviction.

## 5. Files the builder touches

New: `shared/cua-host-messages.mjs` (message builders/parsers for `murage:host-desktop`, `-ready`,
`murage:cua-generation` withdrawn/retired, `murage:cua-stuck`, `murage:cua-integrity`; imported by main, the runtime and
the harness), `server/testing/cua-0.55.0-win-tools-list.json` (W-R8 capture), `scripts/prepare-cua-windows.mjs`, `scripts/cua-driver-0.55.0-windows-provenance.json`,
`scripts/cua-windows-release.test.mjs`, `scripts/verify-windows-package.mjs`, `electron/cua-windows-runtime.cjs`,
`electron/cua-windows-runtime.test.mjs`, `server/host-computer-win-gate.test.ts`.
New in r4: `server/host-computer-route.ts` (the host route body moved out of index.ts unchanged except for the D10/D15
terms, exported `handleHostComputerRoute(req, res, deps)`; index.ts's `/api/internal/host-computer` branch only calls
it, so W-L1/W-K* run the production route in-process; W-B1, W-B3, W-C4 and W-C5 use the booted server instead (r5, section 6a); mechanical move, Windows builder).
Edited in r6 (FABLE 3010 M3): `native/engine-exclusion/exclusion.c` and its JS binding gain the win32-only
`terminateIfStart(pid, start)` (D19: one handle opened by pid, its start time compared to `start` on that handle, then
`TerminateProcess` on the same handle; `terminated` / `mismatch` / `unknown`); existing exports unchanged; built by the
existing native step of the Windows package (W-PK1 gate).
New in r5: `shared/cua-driver-identity.mjs` (`verifyExeIdentity`, used by D6 (a) and (b); added to the
`electron-builder.yml` `files:` list beside `shared/cua-host-messages.mjs`, under the same W-PK1 gate),
`<runtimeDir>\driver.owner.json` (runtime data, D19), `server/host-computer-owner-path.test.ts` (W-B1, W-B3, W-C4,
W-C5: the booted-server witnesses, section 6a), `src/components/LinuxLocalControl.test.tsx` (W-C6). The r4 extraction
`hostComputerMountForTurn` and the statics W-C4s / W-B1s are withdrawn (r5: a source-text check is not a witness).
Edited: `electron/cua.mjs` (win32 branch), `electron/main.mjs` (start on win32; `murage:host-desktop` push with
`lock.refresh()` on server start; `murage:cua-generation`; D14 stop wait), `electron/capabilities.cjs` (win32 status),
`electron-builder.yml` (`files:` gains `- shared/cua-host-messages.mjs` beside the other `shared/*.mjs` lines, R4c;
win `extraResources`: two per-file entries, `from: dist-native/cua-win32-x64/cua-driver.exe`
and `.../cua-cursor-theme.exe`, `to: cua-win32-x64/<same name>`; never the folder), `.github/workflows/release.yml`
(Windows x64 job on windows-latest: prepare before electron-builder, `verify-windows-package.mjs` after),
`server/local-computer.ts` (D5), `server/local-routing.ts` (D7), `server/index.ts` (D10/D15 gate terms +
`host-locked` / `host-off` / `driver-exited` / `driver-lost` answers + the message handler and `-ready` post + D12, at
the host route; the handler is an exported named function so W-L1/W-K2 call the registered one),
`electron/main.mjs` also: on win32 the `cleanupDesktopForExit` computer-use stage is the single
`cuaCleanupStage({stop: stopCua, ms: cuaStopStageMs("win32")})` call (D14; darwin/linux unchanged),
`proc.on("message")` routes the three harness types to `onHarnessMessage`,
`server/drivers/host-computer-proxy.ts` (map `host-locked`, `host-off`, `driver-exited`, `driver-lost`;
the 64 MiB `post` limit and one-call cut are M1/B13, the caps owner's hunk), `src/lib/local-computer.ts` (D7, W-K1
copy), `src/components/LinuxLocalControl.tsx` (win32 copy), `docs/computer-use-integration.md`,
`third_party/cua-driver/README.md` (C3). Broker/reader changes are C4-C7, made by the broker owner.
`electron/cua-windows-runtime.cjs` takes `{spawn, taskkill, port, lock, clock, fs}` by injection and requires no
`electron` module, so W-K2/W-K3/W-K5/W-K6 load it inside the server test process with its port wired to the harness's
real handler (ASTRA r2 H2: no hand-made retirement message in any witness).
Test seam for the win-gate witnesses (self-review N4): `decodeWindowsDescriptor(raw, {resourcesPath, pin})` takes the
resources path and the pinned `{sha256}` as parameters; production passes Electron's resourcesPath and the constant
imported from the provenance JSON; the tests stage a small fake driver script as `<tmp>\cua-win32-x64\cua-driver.exe`
(spawned through `process.execPath`) and pass its own sha256 as `pin`. The pin is never read from the descriptor. A
descriptor whose `driver.sha256` differs from `pin` is rejected by D5 before any spawn hook runs, so that rule is
witnessed in W-V1 (M-V4), and W-S3/W-S3b keep a valid descriptor and change only the file (r4, ASTRA r3 H4).
`verifySpawn` takes `fs` by injection (`open`, `read`, `fstat`, `stat`, `close`) so W-S3b can replace the file between
two reads of the same `fd`.

## 6. Owner-turn size caps on this path (MAIN-RULING local-memory-budget; cause22 caps; closes ASTRA H1 and r2 H1)

Rule (CAPS-INVENTORY, owner turn = `ReleaseBudget.ownerKept`, told to proxy children by `OWNER_TURN_HEADER`): no cap
ends, refuses, seals or delays an owner turn, and no cap seals the computer tool for the rest of the turn. One
ceiling, 64 MiB (`OWNER_ITEM_MAX`), for one item. Under it the reply passes whole; over it that one call gets a
truthful tool error and the next call works. Non-owner turns keep today's caps unchanged (the CAPS-INVENTORY rule;
not widened here; the 1568 default keeps a typical shot at 2-4 MB).

A screenshot reply crosses these hops on the production path (r4: r3 stopped at H-f and missed the mount relay and
the trusted ingress, ASTRA r3 H1; the H-g..H-k rows reuse cause22 CAPS-INVENTORY A5-A7, A12, A14 and caps-opus
C12/C13/C22). Each hop's owner-turn behaviour, and who owns it:

| hop | file (anchor) | today | owner turn (required) | owner of the side |
|---|---|---|---|---|
| H-a driver -> broker reader | `headless-browser-proxy.ts` `MAX_RESPONSE_BYTES` 16 MiB (25, splitter 141-150) | reject, claim kept | PASS to 64 MiB; over it: D16(b) | cause22 caps (B12 extended to the host broker reader; M1(c)) |
| H-b broker collection charge | `upstream-reader.ts` collection 8 MiB (A3) | refuse turn | PASS to 64 MiB (done at c187b11166) | cause22 caps (A3) |
| H-c route HTTP answer | `consuming-turn-response.ts` 187 `reserveRelease({bytes})` into the turn's `ReleaseBudget` | refuse/seal over 64 MiB/turn | crossing degrades and is recorded (A2, done at c76dbfa42f); one cost above a whole window renews it (A1) | cause22 caps (A1, A2) |
| H-d proxy `post` | `host-computer-proxy.ts` 19 16 MiB; any failure -> `proxyTransportLost` (69) | mount sealed | PASS to 64 MiB; over it that call answers the oversize error, never `proxyTransportLost` | cause22 caps (B13; open at 22039551ff, M1(a)) |
| H-e model-facing frame | `proxy-turn-release.ts` `releaseProxyFrame` 8 MiB (169 at c3cf3c3cf5) | mount sealed | PASS to 64 MiB; a bigger result answered with the fixed error, same id (B1, done at 22039551ff, 201-215) | cause22 caps (B1) |
| H-f release door body | `index.ts` release door `readBody(req, proxyReleaseAuthority.bodyCap(claim))` (A11) | seal + 409 | 2 x 64 MiB + 4 KiB (`bodyCap` = `OWNER_ENVELOPE_MAX`, built at 22039551ff) | cause22 caps (A11) |
| H-g ingress `issue` (verdict) | `consuming-turn-ingress.ts` `decodeProxyFrame(frame.frame, frameMaxFor(binding))` (A5) | reject -> seal | PASS to `OWNER_FRAME_MAX` (built at 22039551ff) | cause22 caps (A5, C12) |
| H-h relay stdio line (mount child -> server) | `cli-mount-relay.ts` `lineMax` (A12, 2 MiB `CHAT_MCP_FRAME_CAP_BYTES` at c3cf3c3cf5 172) | `MEMORY_CONTEXT_REVOKED` -> `ingress.seal` | enveloped owner line to `OWNER_ENVELOPE_MAX` (built at 22039551ff, 250-253) | cause22 caps (A12, C13) |
| H-i relay held output (reply behind a pending check) | `cli-mount-relay.ts` held chunks (A14, 256 chunks) | seal | bounded by bytes, `OWNER_ENVELOPE_MAX` (built at 22039551ff, 199-201) | cause22 caps (A14, C22) |
| H-j mount `accept` envelope | `mcp-mounts.ts` `decodeReleaseEnvelope(line, ingress.ownerKept)` (A7) | throw -> seal | 2 x 64 MiB + 4 KiB (built at 22039551ff) | cause22 caps (A7, C12) |
| H-k ingress `deliver` | `consuming-turn-ingress.ts` deliver frame (A6) | reject -> seal | PASS to `OWNER_FRAME_MAX` | cause22 caps (A6) |
| H-l engine socket drain | `cli-mount-relay.ts` mount write `socket.writableNeedDrain` -> `throw MEMORY_CONTEXT_REVOKED` (A15; 484 at 22039551ff, NOT built) | seal (turn) | WAIT: the write is taken and the mount child's stdout is paused until the socket drains; never throw on need-drain | cause22 caps (A15; open, M1(e)) |

Also on this path (self-review r4; one row each, owner cause22 caps): H-e2 the proxy's release queue and frame-invalid
size check (C2/C3, `proxy-turn-release.ts`); H-e3 `reserveProxyUpstream` from `releaseProxyFrame`'s verdict and
envelope steps (proxy-turn-release.ts 150, 157) reaching the door's `reserveUpstream` (A8, consuming-turn-ingress
293-306: one charge capped at 8 MiB on a non-owner turn); H-e4 the proxy's read of the verdict answer (C4,
proxy-turn-release.ts 152); H-g2 the door's own `decodeProxyFrame` in `answer` (consuming-turn-ingress 344); H-h2 the
relay's per-chunk `ingress.upstream` charge (A9). Not on this path: `collectProxyUpstream` (the proxy reads the
route answer with its own `post`, H-d). Line numbers are at 22039551ff; the builder's CHECKLIST maps every row to its
line at the build base, and a row whose code is gone from the path there is recorded with the grep that shows it.

Contract M1 (owner: cause22 caps lanes, cause22-caps-fable / cause22-caps-opus; consumer: Windows builder,
build-1022-cua-windows, MAIN until seated), r4 terms: (a) build CAPS-INVENTORY B13 for `host-computer-proxy.ts`: owner-turn `post` limit
`OWNER_ENVELOPE_MAX`, and a body over it answers that one call with the oversize error, never `proxyTransportLost`;
(b) A1, A2, A3, A11, B1 as in CAPS-INVENTORY (no change asked); (c) the host broker's reader uses the owner ceiling
on an owner turn (B12 names the agent-browser line only; the same `MAX_RESPONSE_BYTES` serves the host broker). The
broker's claim handling on overflow is C7 (cua-upgrade), not M1. The win32 copy of the oversize line ("This
screenshot was too large to pass on (over 64 MiB). Ask again with a smaller max_image_dimension.") is set by the
win32 route mapping (Windows builder); every other platform keeps `OVERSIZE_LINE`.
(d) (r4) H-f..H-k as built at caps-opus 22039551ff (A5-A7, A11, A12, A14 / C12, C13, C22) reach the builder's base
unchanged; the caps lanes keep their own witnesses (WC1, WC2) and the Windows builder's W-B1 consumes them on the
host path. (e) (r4 self-review High) build A15: on an owner turn a relay write to an engine socket that needs drain
is taken and the mount child's stdout is paused until `drain`; it never throws `MEMORY_CONTEXT_REVOKED` (open at
22039551ff, cli-mount-relay.ts 484). Same ship gate as (a)/(c).
### 6a. r5: every site, every engine, on the unmodified production server (FABLE r4 H1/H2, ASTRA r4 A6; MAIN-RULING cause22-one-rule)

Invariant I-1: no cap ends, seals, revokes or interrupts an owner turn at any site on this path; an oversized or
over-count item fails or trims THAT ONE item with a clear tool error and the turn continues. Counted unit: one reply
item (the driver's reply line) for the reply direction, one request line for the request direction, one frame for the
count sites. Ceiling for one item: `OWNER_ITEM_MAX` 64 MiB.

Class sweep (PROCFIX P1). Grep, run at 1ed75a3b2e (tree = dev/1022 dd2b64641f) and again at caps-opus 22039551ff:
`git grep -n -E 'MEMORY_CONTEXT_REVOKED|writableNeedDrain|MAX_FRAMES|FRAME_CAP_BYTES|MAX_FRAME_BYTES|MAX_RESPONSE_BYTES|size >= 4096|length < 256|64 \* 1024\)|16 \* 1024 \* 1024|maxBytes = ' -- server/drivers/cli-mount-relay.ts server/drivers/host-computer-proxy.ts server/drivers/headless-browser-proxy.ts server/drivers/pi-mcp-extension.ts server/drivers/chat-mcp-client.ts server/drivers/mcp-mounts.ts server/consuming-turn-ingress.ts server/proxy-turn-release.ts server/read-body.ts`
(r6, ASTRA 3014 / OPUS 3011) The r5 grep returned consuming-turn-ingress.ts 107 without a row, and it did not
search the engine-side result and turn limits at all. r6 class sweep, run at ba39e92f83 (tree = dev/1022 170af31c3c):
`git grep -n -E 'MEMORY_CONTEXT_REVOKED|writableNeedDrain|MAX_FRAMES|FRAME_CAP_BYTES|MAX_FRAME_BYTES|MAX_RESPONSE_BYTES|size >= 4096|length < 256|64 \* 1024\)|16 \* 1024 \* 1024|maxBytes = |TOOL_OUTPUT_MAX_(BYTES|LINES)|truncateToolText|TOOL_RESULT_MAX_BYTES|capUtf8\(|MAX_TURN_TOOL_CALLS|MAX_CHAT_ROUNDS|stoppedAfter\(' -- server/drivers/cli-mount-relay.ts server/drivers/host-computer-proxy.ts server/drivers/headless-browser-proxy.ts server/drivers/pi-mcp-extension.ts server/drivers/pi.ts server/drivers/chat-mcp-client.ts server/drivers/openai-chat.ts server/drivers/openai-chat-tools.ts server/drivers/mcp-mounts.ts server/consuming-turn-ingress.ts server/proxy-turn-release.ts server/read-body.ts`
New sites it returns (r6 rows): consuming-turn-ingress.ts 107 (S29); pi-mcp-extension.ts 108-109, 348, 570-586 (S30);
openai-chat.ts 1730 (S31), 1590 (S32), 1398/1401/1623 (S33), openai-chat-protocol.ts 13/53 with openai-chat.ts 1015 (S35, precheck pass 2: grep `MAX_REPLY_TOOL_CALLS` over `server/drivers/openai-chat-protocol.ts` added to the sweep), 1292 and 1727 and 143 (S34, not on path);
openai-chat-tools.ts 12, 13, 22, 23, 26, 111 (the constants and helpers of S30-S34). Also returned and NOT on this
path (S34): pi.ts 1354 and openai-chat.ts 416, 883, 914, 1058, 1098, 1183 (r7: 1083/1093 moved to S38, ASTRA on f94aa558dd) (provider-reply caps on the
model's own HTTP reply and revocation rethrows; no computer reply crosses them). Pi's turn has no step or tool-call
count in Murage's code. claude, codex and acp have no step or result limit in Murage's code
on this path (their result reaches the CLI whole through the shim, E1-E3).
Every site it returns on this path is a row. Line numbers are at 1ed75a3b2e, with the 22039551ff line after a slash
where the caps lane moved it. The builder re-runs the grep at the build base and records it in SITES.md; a site the
grep returns that has no row here is a build blocker, not a judgement call.

| S | site | on an owner turn today | required | owner | cell | mutant (alone) -> RED at |
|---|---|---|---|---|---|---|
| S1 | H-a broker reader `MAX_RESPONSE_BYTES` (headless-browser-proxy.ts 24) | reject at 16 MiB | pass to the ceiling; over it C7 | cause22 caps M1(c) | i | M-S01 16 MiB kept -> i bytes-equal |
| S2 | H-b collection charge (upstream-reader.ts 29) | refuse turn at 8 MiB | pass | cause22 caps A3 | i | M-S02 refuse kept -> i |
| S3 | H-c route answer into the release budget (consuming-turn-response.ts 187); (r6 precheck pass 3) ALL its counters, including `attempts` 4 096 a turn (release-budget.ts 5, check 28), which every forwarded request and reply charges | seal over 64 MiB a turn, or on the 4 097th release attempt | degrade, recorded | cause22 caps A1/A2 | ii | M-S03 `check()` restored to c3cf3c3cf5 -> ii 7th reply |
| S4 | H-d proxy `post` (host-computer-proxy.ts 19) | `proxyTransportLost` at 16 MiB | pass; over it one-call error | cause22 caps M1(a) | i | M-S04 16 MiB kept -> i |
| S5 | H-e `releaseProxyFrame` (proxy-turn-release.ts) | seal at 8 MiB | pass | cause22 caps B1 | i | M-S05 8 MiB kept -> i |
| S6 | H-e2 proxy frame-invalid size check | seal | pass | cause22 caps C2/C3 | i | M-S06 8 MiB on owner -> i |
| S7 | H-e3 door `reserveUpstream` per call | refuse at 8 MiB | pass | cause22 caps A8 | i | M-S07 8 MiB on owner -> i |
| S8 | H-e4 proxy read of the verdict answer | fail at 16 MiB | pass | cause22 caps C4 | i | M-S08 16 MiB on owner -> i |
| S9 | H-i relay held output (cli-mount-relay.ts 159 / 199-203): counts output that arrives AFTER a held reply | seal at 256 chunks | NOT-APPLICABLE on the host mount: nothing can arrive after a held host reply (reason below). The caps lane's own bound (A14) stays theirs, witnessed by their WC2 | cause22 caps A14 | iii is a pin only | none: M-S09 and r4's M-B1h are deleted (unreachable; recorded, not receipted) |
| S10 | H-f release door body (`bodyCap`) | 409 + seal | owner envelope size | cause22 caps A11 | i | M-S10 `bodyCap` 16 MiB + 1 KiB on owner -> i |
| S11 | H-g ingress `issue` decode | reject -> seal | pass | cause22 caps A5 | i | M-S11 `UPSTREAM_COLLECTION_MAX` -> i |
| S12 | H-h2 relay `ingress.upstream` charge (cli-mount-relay.ts / 196) | refuse | pass | cause22 caps A9 | i | M-S12 the turn's CUMULATIVE upstream charge is refused past 8 MiB on owner (r4's per-charge 8 MiB mutant could not trigger: one charge is one pipe chunk, about 64 KiB) -> i |
| S13 | H-g2 door `answer` decode | reject | pass | cause22 caps | i | M-S13 8 MiB -> i |
| S14 | H-h relay line cap (cli-mount-relay.ts 171 / 250-253) | seal at 2 MiB | owner envelope size | cause22 caps A12 | i | M-S14 2 MiB on owner -> i |
| S15 | H-j mount `accept` envelope (mcp-mounts.ts) | throw -> seal | pass | cause22 caps A7 | i | M-S15 non-owner decode -> i |
| S16 | H-k ingress `deliver` | reject -> seal | pass | cause22 caps A6 | i | M-S16 8 MiB on owner -> i |
| S17 | H-l engine socket needs drain (cli-mount-relay.ts 403 / 484) | throw -> seal | wait for `drain`, never throw | cause22 caps M1(e) | iv | M-S17 throw kept -> iv second reply |
| S18 | relay frame count `CHAT_MCP_MAX_FRAMES` 10 000 (cli-mount-relay.ts 176 / 240) | throw -> seal on the 10 001st line of a turn | (r6, MAIN-RULING cause22-OPEN-2) each frame past the count fails as ONE item: a reply past it becomes its call's error with the line naming the count, excess frames are not delivered; turn, child and mount live. Built by cause22-main-b (76c075fd86 R3; caps-opus-r4 SITES OPEN-2 / Q2); this design adds only the host-path cell | cause22 caps M1(f) | v (E1) | M-S18 REVERT seal kept on owner -> v "click answered by its id"; M-S18x the excess reply delivered (OPEN-2 non-compliant, main-a's earlier shape) -> v "reply past the count is the count line" |
| S19 | relay write to the mount child's stdin that needs drain (cli-mount-relay.ts 121 / 161) | throw -> seal | queue the request and write on `drain` | cause22 caps M1(g) | vii | M-S19 REVERT throw kept -> vii every reply |
| S20 | relay engine-input frame over 2 MiB (cli-mount-relay.ts 512-513 / 604-606) | `seal()` | that one request is answered with the input-too-large error by its id; mount stays | cause22 caps M1(h) | vi-b | M-S20 REVERT seal kept -> vi-b next click |
| S21 | host proxy request line over 64 KiB (host-computer-proxy.ts 88) | splitter fails, proxy exits, mount lost | that one call answers `isError` "This computer action's input was too large to send (over 64 KiB). Send it in smaller parts."; the proxy keeps serving | cause22 caps M1(h) (their OPEN-1 names this line) | vi-a | M-S21 REVERT -> vi-a next click |
| S22 | host route request body, `readBody` default 1 MB (index.ts 31450, read-body.ts 12) | 4xx -> proxy seals | NOT-APPLICABLE while S21 (64 KiB) is the smaller limit: no body over 1 MB can reach it. If M1(h) raises S21, the route reads with the same limit and answers 409 `{code:"request-too-large"}` | Windows builder (route) | vi-a asserts the route was not reached | none (unreachable; recorded, not receipted) |
| S23 | Pi client `MCP_MAX_FRAME_BYTES` 32 MiB (pi-mcp-extension.ts 181-182, 214-215) | `closeWithError`: session killed, every pending call failed | read to the owner frame size; over it that one call fails by id, session stays | cause22 caps M1(i) | i-b on E4 | M-S23 REVERT 32 MiB kept -> i-b bytes-equal on E4 |
| S24 | OpenAI-chat client frame cap `CHAT_MCP_FRAME_CAP_BYTES` 2 MiB (chat-mcp-client.ts 30, reader) | connection closed | read to the owner frame size; over it one-call error | cause22 caps M1(i) (A30) | i on E5 | M-S24 REVERT -> i text-equal on E5 |
| S25 | OpenAI-chat client frame count (chat-mcp-client.ts 478) | `close()` | (r6, ASTRA 3014) NOT-APPLICABLE on the host mount: the client is opened per turn (openai-chat.ts 1386), the host proxy writes exactly one line per engine request and no notification or server request (host-computer-proxy.ts 51-58; pinned by cell (v)'s own `it`), and the tool loop sends at most `MAX_TURN_TOOL_CALLS` (200) calls plus `initialize` and `tools/list`, so a turn's frame count stays under 210 and never reaches 10 000. The generic site is cause22's (cause22-main-b 9cca2b67d5 chat-mcp-client.ts 537-538, owner-turn branch under OPEN-2) | cause22 caps M1(f) | none on E5 | none: M-S25 deleted (unreachable on this mount; recorded, not receipted) |
| S26 | OpenAI-chat image blocks (chat-mcp-client.ts 513, openai-chat.ts 1726) | image dropped, `SCREENSHOT_NOT_SHOWN` line added | KEPT: declared boundary of P6 for this engine family (not a cap); the text parts arrive whole, the turn continues | openai-chat driver owner; no change asked | i on E5 | M-S26 the fixed line is not added when an image was dropped (the bot is not told) -> i notice `it` |
| S27 | relay waiting queue 256 (cli-mount-relay.ts 117) | `refuseCall`: that one call gets "still checking remembered context" | COMPLIANT as is (one call, clear error, turn continues); no change asked | cause22 caps | none | none |
| S28 | ingress server-request count 4096 (consuming-turn-ingress.ts 137) | reject | NOT-APPLICABLE: the host proxy issues no server-to-client request (it answers `initialize`, `ping`, `tools/*` only, host-computer-proxy.ts 51-58) | cause22 caps | none | none |
| S29 | (r6, OPUS 3011, ASTRA 3014, FABLE 3010 M1) ingress ENGINE-request count: `requests.size >= 4096 \|\| requests.has(id)) reject()` (consuming-turn-ingress.ts 107), on the E1-E3 path through `cli-mount-relay.ts` 122 `ingress.request` | the 4097th call in flight rejects -> seal: the computer tool is gone for the rest of the turn | that one call is answered by its id with the fixed line (`TOO_MANY_CALLS_LINE`, owner-turn-caps.ts at cause22-main-b: "Too many tool calls are waiting at once. Try this one again in a moment."); a duplicate id still rejects (protocol violation, not a cap); non-owner turns unchanged. Built by cause22-main-b (e1767b8540 consuming-turn-ingress.ts 162; its row R7 "the 4097th call in flight is answered with a fixed line instead of sealing the mount"); caps-sol A10 is the same row. Not duplicated here | cause22 caps M1(l) | vii-c (E1) | M-S29 REVERT reject kept on owner -> vii-c "4097th answered by its id"; M-S29n NOOP the 4097th is dropped unanswered -> same `it`; M-S29d DROP the cap counts answered calls too (an answered id never leaves `requests`) -> vii-c "next click after release reaches the driver" |
| S30 | (r6, ASTRA 3014) Pi result text `truncateToolText`: 50 KiB / 2 000 lines (pi-mcp-extension.ts 108-109, applied at 348, body 570-586) | the text part is cut with "[MCP output truncated: 50KB limit. ...]"; picture parts (348 `images`) pass untouched; the turn goes on | COMPLIANT as is under cause22-one-rule (one item trimmed, the marker names the limit, turn continues); classified so by cause22-caps-opus-r4 SITES.md line 44 ("Cut, not end"). No change asked | Pi driver owner (cause22 classification) | i-t (E4) | M-S30a the marker is not appended (silent cut) -> i-t marker `it`; M-S30b the picture is also cut to the text limit -> i-t picture bytes-equal |
| S31 | (r6, ASTRA 3014) OpenAI-chat tool result `capUtf8(text, TOOL_RESULT_MAX_BYTES)` 50 KiB (openai-chat.ts 1730; note "[cut: the rest was too long]", openai-chat-tools.ts 111) | text cut with the note; the turn goes on | COMPLIANT as a trim (cause22-caps-opus-r4 SITES.md line 44). cause22-one-rule asks a trimmed result to NAME the cap and today's note does not: M1 (k) asks the note to say "over 50 KiB". The witness asserts the marker and the length now, and "50 KiB" in the note once (k) lands (cell i-u) | cause22 caps M1(k) | i-u (E5) | M-S31a the note is not appended -> i-u marker `it`; M-S31b the cut drops the whole text (empty result) -> i-u "first 50 KiB equal" |
| S32 | (r6, ASTRA 3014) OpenAI-chat tool-call count `seenCalls.size + calls.length > MAX_TURN_TOOL_CALLS` (200) -> `fail(stoppedAfter("200 tool calls"))` (openai-chat.ts 1590) | the whole batch is refused and the turn FAILS with the stop text | (precheck pass 1, cause22-OPEN-2: a count that ends an owner turn) the calls up to 200 run; each call past 200 gets a tool message naming the limit and is not run; the next round offers no tools; the turn ends with the model's reply. Not built by any cause22 row yet: new term | cause22 caps M1(m) | ix row B (E5) | M-S32 REVERT stop kept -> ix B "200 reach the driver"; M-S32d DROP the over-count call gets no tool message -> ix B "201st gets a tool message naming the limit" |
| S33 | (r6, ASTRA 3014) OpenAI-chat round count `MAX_CHAT_ROUNDS` (64): loop bound (openai-chat.ts 1398), last-round flag (1401), `fail(stoppedAfter("64 steps"))` (1623) | after 64 rounds of tool calls the turn FAILS with the stop text | the 64th (last) round's request offers no tools and says the limit was reached; the turn ends with the model's reply; the budget itself (64) is unchanged | cause22 caps M1(m) | ix row A (E5) | M-S33 REVERT stop kept -> ix A "ends with done"; M-S33n NOOP the last round still offers tools -> ix A "64th request offers no tools" |
| S35 | (r6, precheck pass 2) OpenAI-chat tool calls in ONE model reply: `index >= MAX_REPLY_TOOL_CALLS` (32) throws (openai-chat-protocol.ts 13, 53) -> `failure("The model server sent a tool call Murage could not read, so nothing ran.")` (openai-chat.ts 1015) | the turn FAILS, nothing of the reply runs | (cause22-OPEN-2: a count that ends an owner turn) the first 32 calls are kept and run; each call past 32 in that reply gets a tool message naming the 32-per-reply limit and is not run; the turn continues. Malformed calls (bad id, bad type) still fail as today: that is a protocol error, not a count | cause22 caps M1(m) | ix row C (E5) | M-S35 REVERT throw kept -> ix C "32 reach the driver"; M-S35d DROP the calls past 32 get no tool message -> ix C "33rd gets a tool message" |
| S38 | (r7, ASTRA BLOCK on f94aa558dd; MAIN 3104/3105) OpenAI-chat 32 MiB limit on a model reply that carries tool calls (openai-chat.ts 1083, 1093) | the turn FAILS | under MAIN-RULING cause22-no-transport-caps: DELETED, and a large real tool-call reply completes the turn | cause22-eng GROUP B (MAIN 3104, 1.0.21); cited here, not duplicated | cause22-eng's own witness | cause22-eng's own mutants |
| S37 | (r6, precheck pass 3) OpenAI-chat tool-call ARGUMENT size in one reply: `argumentChars + extraContentChars > MAX_ARGUMENT_CHARS` (256 000) or a name over 64 chars throws (openai-chat-protocol.ts 14, 81) -> the turn fails (openai-chat.ts 1015) | the turn FAILS, nothing of the reply runs | (cause22-one-rule: an oversized item fails alone) the call whose arguments cross the limit gets a tool message naming the limit and is not run; the other calls of the reply run; the turn continues. The 64-char name check stays a protocol error | cause22 caps M1(m) | ix row D (E5) | M-S37 REVERT throw kept -> ix D "the small click reaches the driver"; M-S37d DROP the oversized call gets no tool message -> ix D "oversized call gets a tool message" |
| S34 | (r6) OpenAI-chat sites the grep returns that are NOT on the model-facing path: 1292 and 143 (`NATIVE_TOOL_RESULT_MAX_BYTES` 4 KiB, the native-log record view and its floor; the provider request is not built from it), 1727 (the web-read branch, tools `web_read`/`browser_read`/`agent_browser_read` only; never a computer tool); pi.ts 1354 and openai-chat.ts 416, 883, 914, 1058, 1098, 1183 (r7: 1083/1093 moved to S38, ASTRA on f94aa558dd) (the model's own reply stream and revocation rethrows, not a tool result) | log record cut; web read refused | NOT-APPLICABLE (reasons in the site column) | openai-chat driver owner | none | none |

Held output (S9), the production order (FABLE r4 H2; r5 pass 2, ASTRA precheck). The relay's held limit counts
child output that arrives AFTER a reply was deferred (`#held`, cli-mount-relay.ts 159). On the host mount no such
output exists: EVERY line the host proxy writes, reply or not, goes through `createMcpCatalogWriter(env, stdout,
"hostComputer")` (host-computer-proxy.ts 31), whose `write` is `releaseProxyFrame` for a release role
(mcp-listed.ts 233) and whose `outTail` (mcp-listed.ts 237-240) starts the next line only after the previous one's
release has resolved; the release waits for the relay's ack, and the relay acks only after it accepted the line. The
proxy also answers one request at a time (`queue`, host-computer-proxy.ts 87; `await req.respond`, 73). So while a
reply is held, the child's stdout is silent, the 256-chunk count stays at 0, and neither r4's cell (iii) nor any
mutant of that limit can turn RED on this path. S9 is therefore NOT-APPLICABLE and carries no mutant. Cell (iii)
stays only as a pin of the deferral itself (one 20 MiB reply deferred whole and then delivered), and no hop mutant is
claimed against it. A builder who finds a line that bypasses `outTail` at the build base reopens S9 with that line.

Engines (every adapter whose `capabilities.localComputerMcp` is true; grep `localComputerMcp` in `server/drivers`):

| E | engine | how the reply reaches the model | boundary the witness reads |
|---|---|---|---|
| E1 | claude (claude.ts 7279) | `CliMountRelay` + `cli-mount-shim` | what the fake CLI's MCP client received from the shim |
| E2 | codex (codex.ts 3368) | same relay and shim | same |
| E3 | acp (acp/core.ts 8339) | same relay and shim | same |
| E4 | pi (pi.ts 1941) | the real `pi-mcp-extension.ts` client | the tool result that client hands to the fake pi |
| E5 | openai-chat (openai-chat.ts 1779) | the real `chat-mcp-client.ts`, then the provider request | the tool message in the request body the fake provider received: text parts equal, plus the fixed not-shown line |

W-B1e (own `it`): the table's engine list equals the set of registered adapters with `localComputerMcp` true, so a
new engine without a row fails. The builder's SITES.md marks, per engine, which S rows are on that engine's path.

W-B1 rig r5 (replaces the r4 loopback rig; closes ASTRA r4 A6 and FABLE r4 H2 "harness valid on the base").
The server under test is the unmodified production harness (`server/index.ts`) booted as the repository's isolated
fixture does it (`scripts/control-murage.ts launch`: own data dir, own ports, fake engines only). The owner's turn is
sent through the real send route. The engine is a fake CLI per kind (`server/testing/fake-claude-cli.ts` for E1; the
existing fake of each other kind, or the smallest fake that speaks that engine's wire protocol), scripted to call the
host tool and to write, per reply, the byte length and sha256 of what its MCP client received. The driver is a fake
`cua-driver` started by the real broker from a descriptor of the host's own platform (linux on CI, win32 on W-R3).
Everything between the two fakes is production code in its production wiring: route, `withUpstreamOwner`,
`consumingHttpWriter`, the release door and its owner header, proxy child, relay, shim or client. The test imports no
product module except constants for sizes, so the same file runs on the base sha unchanged (PROCFIX P4).
Cells (each assertion its own `it`, read from the fake engine's record under a 60 s deadline checked by `expect`):
Fixed lines (r6 precheck pass 3): the test holds every fixed line it expects (`TOO_MANY_CALLS_LINE`, the frame-count
line, the oversize and limit lines) as its own literal, so it loads on a base where the export does not exist yet; one
tip-only `it` asserts each literal equals the product's export.
Reply shape (r6, ASTRA 3014): unless a cell says otherwise, a fake reply of N MiB is one picture part of N MiB less
8 KiB plus one text part of exactly 8 KiB (under both the 50 KiB and the 2 000-line trims of S30/S31), so "bytes equal"
means: E1-E3 the whole reply; E4 the picture's bytes and the text, each equal; E5 the text equal plus exactly one
`SCREENSHOT_NOT_SHOWN` line (imported constant), since that engine family drops pictures (S26). No cell expects text
equality past a declared trim.
(i) one 20 MiB `get_window_state` reply: bytes equal; the next `click` reaches the fake driver; the turn's reply is
delivered with no refusal row and no stop line.
(i-b) near the ceiling: the largest reply every hop's own owner limit passes, computed from the exported constants
(never a hand number): same three assertions. A 32 MiB or 16 MiB cap left anywhere fails here.
(ii) seven 10 MiB replies in one turn: all equal, the 8th call works.
(iii) pin, no mutant: one 20 MiB reply that meets a pending context check (the 1.0.20 deferral), then the check
settles: bytes equal. Written only if the check can be held on the booted server without a product switch.
(iv) the fake engine sends two calls, stops reading its socket, both 20 MiB replies arrive, it reads again: both equal.
(v) (r6, MAIN-RULING cause22-OPEN-2) E1 only: 10 001 small `tools/list` exchanges in one turn, then a `click`. Own
`it` each: every reply up to the 10 000th mount frame arrives whole; each reply past it, and the `click`'s, is that
call's error carrying the count line (the relay's exported constant, whatever its final wording at the caps tip);
(r6 precheck pass 1) the child and transport live, shown directly and not by an answer the relay itself can write:
the `click` and a second `click` sent after its count-line answer BOTH reach the fake driver (its frame count rises by
2; the proxy is serial, host-computer-proxy.ts 87, so the second can reach the driver only after the proxy's over-count
reply was released and acked); the proxy child's pid recorded at the turn's first call is still alive; the server log
has no seal line for the mount; the turn's reply is delivered with no refusal row and no stop line. Pin `it` for S25/S28 (no mutant): the number of lines the fake engine received from the
host mount equals the number of requests it sent (the proxy writes no unsolicited frame).
Base RED (r6 precheck pass 3): on ba39e92f83's tree the turn's release budget (S3: 4 096 attempts a turn, charged by
every forwarded request and reply) seals long before frame 10 001, so the cell is RED there by S3, not by S18. S18's own
RED is receipted at a DECLARED pre-fix checkpoint (PROCFIX P4): the builder's base with the caps branch merged (S3
degrades on an owner turn, cause22 A1/A2) and only the S18 fix reverted (M-S18), where the relay throws at frame
10 001 and seals (RED at "answered by its id"); the receipt counts only with the server log's seal cause at the relay
count. Arrival assert, own line: the fake engine received 10 000 frames before the count line.
(vi-a) `type_text` with 1 MiB of text: that call gets the input-too-large error, the next `click` works.
(vi-b) a 3 MiB request line: same.
(vii) the fake engine writes 4096 requests of 1 KiB in one socket write (4 MiB, far above the child's stdin pipe
buffer, so the relay meets `writableNeedDrain`): all answered. Setup assert, own line: the relay reported need-drain
at least once (its existing debug counter); if that cannot be made to hold on the booted server, S19 is consumed from
the caps lane's relay row and M-S19 is not receipted here (stated in SITES.md).
(vii-c) (r6, S29; OPUS 3011) E1 only: the fake driver holds its reply to the first `click` (released by the test's
control message); the fake engine then writes 4 096 further `click` requests (distinct ids, about 100 bytes each),
paced in groups of 32 with 5 ms between groups so the relay's write to the proxy's stdin never needs drain (the proxy
reads stdin continuously into its queue, host-computer-proxy.ts 76-89). With the proxy answering one request at a time
(87), the held one plus 4 095 further are in flight at the ingress when the 4 096th further request (the 4 097th in
flight) arrives. Own `it` each: that last id, and only it, is answered by its id with `TOO_MANY_CALLS_LINE` (imported)
within 5 s while the first is still held; after release the held call and the 4 095 others are answered by the driver
in order, and one more `click` reaches the driver (frame count of the fake driver = 4 097); the mount is not sealed
and the turn's reply is delivered with no refusal row and no stop line. Setup asserts, own lines: the first `click` is
still held when the last is written (the fake driver's held counter is 1); the relay logged no need-drain seal in the
cell. (r7, ASTRA BLOCK on f94aa558dd, MAIN 3105: the rule below rejected S29's own mutant receipts, because on the
host path the release budget S3 or need-drain S19 seals first in every run, so no run could ever be "a receipt" for S29.
WITHDRAWN: under MAIN-RULING cause22-no-transport-caps the 4 096 count is deleted by its owner (cause22-main-b, row R7),
and this design claims no S29 receipt of its own; cell (vii-c) becomes a pin consumed from cause22-main-b's witness.)
Receipt rule (base and mutants), withdrawn in r7 and kept for the record only: a RED counted for S29 only when the server log's seal cause was the ingress
reject of `ingress.request` and not `MEMORY_CONTEXT_REVOKED` from need-drain (S19) or from the release budget (S3);
otherwise the run is not a receipt. (r6 precheck pass 3) On ba39e92f83's tree the release budget's 4 096 attempts (S3)
are spent by the initialization and the forwarded requests before the 4 097th id arrives, so the cell is RED there by
S3; S29's own RED is receipted at the declared pre-fix checkpoint (caps branch merged, only the S29 fix reverted:
M-S29), with this seal-cause rule. Cell (vii) stays at
4 096 for the drain site S19 and is not raised past S29 (FABLE 3010 M1).
(i-t) (r6, S30) E4 only: one reply of a 20 MiB picture plus a 60 KiB text of 100-byte lines (614 lines: only the byte
limit applies). Own `it` each: the picture's
bytes equal; the text Pi hands the model is the first 50 KiB (UTF-8 boundary) followed by the marker naming "50KB
limit"; the next `click` reaches the driver; the turn's reply delivered. A second row: 2 500 lines of 10 bytes: the
first 2 000 lines plus the marker naming "2000-line limit". No base RED is claimed for the trim assertions (S30 is
compliant and unchanged; a pin per cause22-OPEN-2's "needs a witness row, not a change"); the picture assertion is RED
on ba39e92f83's tree at the FIRST hop that cuts it, S2 (the broker's 8 MiB collection charge, upstream-reader.ts 29,
before the broker reader's 16 MiB S1 and the proxy's 16 MiB S4; r6 precheck pass 3). The same holds for the 20 MiB
picture of cell (i) on every engine.
(i-u) (r6, S31; precheck pass 2) E5 only, a reply UNDER every transport cap so the trim itself is what the cell
observes on the base: a 1 MiB picture (about 1.4 MiB as base64, under the client's 2 MiB frame cap S24 and the
proxy's 16 MiB `post` S4) plus a 60 KiB text of 100-byte lines. Own `it` each: the tool message's result text in the
fake provider's request body is the reply's text cut at `TOOL_RESULT_MAX_BYTES` on a UTF-8 boundary (capUtf8 keeps
50 KiB then appends its note, openai-chat-tools.ts 111-117; nothing is reserved for it), followed by the cut note;
the note names the limit ("50 KiB", M1 (k)); `SCREENSHOT_NOT_SHOWN` is present after the note (M1 (k)); the next
`click` reaches the driver; the turn's reply delivered. The two M1 (k) `it`s are real, RED until (k) lands, and part
of the ship gate. Base RED on ba39e92f83's tree, by the behaviour itself: today's note has no "50 KiB" (RED at the note
`it`) and the not-shown line is added before the cut (openai-chat.ts 1726, 1730) and cut away (RED at the notice
`it`). The 20 MiB picture on E5 stays in cell (i) (base RED there at S2, the first hop).
(ix) (r6, S32/S33, precheck pass 1: in scope of cause22-OPEN-2, M1 (m)) E5 only. Row A: the fake provider answers
every request that offers tools with one `click` call, and a request that offers no tools with the text "done".
Own `it` each: 63 clicks reach the fake driver; the 64th (last allowed) request body offers no tools (and says the
step limit was reached, naming 64); the turn ends with "done" as the bot's reply, no failure text from `stoppedAfter`,
no refusal row, no stop line; the mount was never sealed. Row B (precheck pass 2: one reply carries at most 32 calls,
S35, so the 200 count is reached the way the existing `openai-chat-tools.test.ts` 8b does): six responses of 32
`click` calls, then one of 9: own `it` each: 200 reach the fake driver, the 201st (the 9th of the last batch) gets a
tool message naming the 200-call limit and does not reach the driver, the next request offers no tools, and the turn
ends with "done". Row C (S35): one response with 33 `click` calls: own `it` each: 32 reach the fake driver, the 33rd
gets a tool message naming the 32-per-reply limit, the turn continues and ends with "done". Base RED on ba39e92f83's
tree: row A ends with `stoppedAfter("64 steps")` after 64 clicks and no "done" (RED at "ends with done"); row B runs
192 and fails the turn on the 9-call batch (RED at "200 reach the driver"); row C fails the turn with "The model
server sent a tool call Murage could not read" before any call runs (openai-chat-protocol.ts 53, openai-chat.ts 1015;
RED at "32 reach the driver"). Row D (S37): one response with a `type_text` call whose arguments are 300 000 characters
and a small `click`: own `it` each: the click reaches the fake driver, the `type_text` call gets a tool message naming
the argument limit and does not reach the driver, the turn ends with "done". Base RED on ba39e92f83's tree: the turn
fails with "could not read" before any call runs (RED at "the small click reaches the driver").
(viii) follow-up turn: after (i-b), a new owner turn on the same thread: a 20 MiB reply, bytes equal.
E1 runs every cell except (i-t), (i-u), (ix); E2 and E3 run (i), (i-b), (iv), (viii) (r6: (v) and (vii-c) are E1
only: the count sites S18/S29 are the shared relay and ingress, the same code for E2/E3, and a second engine adds no
path); E4 runs (i), (i-b), (i-t), (vi-a), (viii); E5 runs (i), (i-b), (i-u), (vi-a), (viii), (ix) at its own boundary
(S21 is the shared proxy; S19/S20 are relay sites, not on E4/E5; (v) is not run on E4/E5: S25 is NOT-APPLICABLE and
the Pi client has no frame count; (vii-c) is not run on E5: the OpenAI-chat loop awaits each call, openai-chat.ts
1597-1604, so at most one is in flight; on E4 the builder records in SITES.md whether Pi's client can hold 4 097 calls
in flight, and if it can, (vii-c) runs on E4 too).
Null mutants (PROCFIX P3) per engine row: REVERT (that engine's base limit restored), NOOP (the hop forwards
nothing), DROP (an under-ceiling reply replaced by the oversize error); each RED at the bytes-equal `it`.
Base RED by behaviour: on dev/1022 (1ed75a3b2e's tree) cell (i) fails on E1 at S14 (the 2 MiB relay line seals the
mount: the fake engine never gets the reply); on caps-opus 22039551ff cell (i) fails at S1/S4 (16 MiB), (i-b) fails
on E4 at S23, and (v) fails at S18. (r6) On ba39e92f83's tree (= dev/1022 170af31c3c): (v) and (vii-c) fail at S3 (release attempts),
and their S18/S29 REDs are at the declared pre-fix checkpoint, as stated in each cell; (i-t), (i-t) claims no trim RED (S30 compliant, a pin); (i-u) is RED at its note `it` and (ix) at "ends with done" / "200
reach the driver", as stated in each cell.

Contract M1, r5 terms (owner: cause22 caps lanes; consumer: Windows builder; all under MAIN-RULING cause22-one-rule,
which already puts these hops in the caps lanes' scope): (f) S18, S25: no frame-count limit ends an owner turn;
(g) S19: a relay write to a mount child's stdin that needs drain is queued and written on `drain`; (h) S20, S21:
an over-limit request line is answered for that one call by its id, the mount and the proxy stay; (i) S23, S24: the
engine-side clients read an owner turn's line to the owner frame size and fail one call by id above it; (j) the host
broker reader has one overflow state (C7 r5). Same ship gate as (a)-(e).
r6 terms (same owner and consumer; each cites the cause22 row that already builds it, nothing duplicated): (f) r6
restated per MAIN-RULING cause22-OPEN-2: each frame past `CHAT_MCP_MAX_FRAMES` on an owner turn fails as one item
(its call's error names the count; excess frames are not delivered), never a seal and never delivery; built at
cause22-main-b 9cca2b67d5 (row R3) and caps-opus-r4 (row Q2); S25 on the host mount needs nothing (NOT-APPLICABLE).
(k) the OpenAI-chat result cut note (openai-chat-tools.ts 111, used at openai-chat.ts 1730) names the limit ("over 50
KiB"), so the trim meets cause22-one-rule's "naming the cap"; the trim itself stays; and `SCREENSHOT_NOT_SHOWN` is
appended AFTER the cut (today openai-chat.ts 1726 adds it before 1730, so a text over 50 KiB loses the notice and the
bot is not told the picture was dropped, against P6/S26). No cause22 row builds this yet: it
is a NEW term, filed as a CONTRACT-REQ line on the board with this round. (l) S29: the 4 097th engine request in flight
on an owner turn is answered by its id with `TOO_MANY_CALLS_LINE`; built at cause22-main-b e1767b8540
(consuming-turn-ingress.ts 162, row R7). Ship gate unchanged: (f) and (l) are in the caps branch the builder merges
first; (k) gates the note and notice assertions of cell (i-u), real `it`s that stay RED until it lands (fail closed: the
Windows build adds no trim of its own meanwhile). (r6 precheck pass 1) (k) is a real `it` in cell (i-u), RED until it
lands, and part of the ship gate. (m) S32/S33 under cause22-OPEN-2: on an owner turn the OpenAI-chat step budget never
fails the turn: each tool call past `MAX_TURN_TOOL_CALLS` gets a tool message naming the limit and is not run, the
last allowed round (and the round after an over-count batch) offers no tools and tells the model the limit was
reached, and the turn ends with the model's reply; (precheck pass 2, S35) calls past `MAX_REPLY_TOOL_CALLS` (32) in one reply each get a tool message naming that limit and are not run, the first 32 run and the turn continues; (precheck pass 3, S37) a call whose arguments cross `MAX_ARGUMENT_CHARS` gets a tool message naming that limit and is not run, the rest of the reply runs; the counts themselves are unchanged. New term (no cause22 row
yet), CONTRACT-REQ on the board; ship gate as (a)-(l). If MAIN rules the step budget out of OPEN-2's scope, (m) and
cell (ix) are withdrawn by that ruling, not by this lane.
Witness: W-B1 for every site and engine (R14a), W-B3 for the ceiling (R14b).
Ship gate: Windows-enabled code is not merged until W-B1 (every site and engine row) and W-B3 are GREEN on the builder's base, which
needs the cause22 caps branch (with M1 (a)-(j)) merged first. Fail closed: no Windows-local cap is added meanwhile.

## 7. Real Windows run plan (WINRUN-REQ, MAIN relays; boxes named neutrally)

WIN-I = installer-capable x64 box, interactive logon via scheduled task `LogonType=Interactive` (SSH is Session 0).
WIN-X = extract-only x64 box (no input-driving tests unless its owner is present and agrees).

| id | box | what | GREEN | RED-capable by | blocks ship |
|---|---|---|---|---|---|
| W-R1 | WIN-X | `Get-AuthenticodeSignature` on both staged exes | Valid, subject `CN=Cua AI, Inc.` | 1-byte-patched copy -> HashMismatch | yes |
| W-R2 | WIN-X | `cua-driver.exe doctor` under D4 env; control with only `DO_NOT_TRACK` dropped | telemetry disabled (source `do_not_track`), update off; control: disabled, source `environment` | the control shows the reading follows env; never run without the off switches | yes |
| W-R3 | WIN-X | unit shards: `electron/cua-windows-runtime.test.mjs`, `server/local-computer.test.ts`, `server/host-computer-win-gate.test.ts`, `server/host-computer-broker.test.ts`, and (r5) `server/host-computer-owner-path.test.ts` with the win32 descriptor (W-B1 every engine row, W-B3, W-C4, W-C5) | all pass on Windows Node | per unit mutant; the win32-branch mutants M-C1 and M-C4 are receipted here (they are `process.platform` branches) | yes |
| W-R4 | WIN-I | packaged app: (i) Local control off -> bot on This computer gets the off notice, Notepad untouched; (ii) on + bot explicitly on This computer -> opens Notepad, types a token, reads it back (also the backstop for the first `murage:host-desktop` post: it cannot pass if the state never reaches `active`; FABLE r2 M5); (iii) a bot on Auto: UI shows cloud/off, never "this computer", no driver call; daemon at Medium IL | all three | (i) and (iii) are the negative cells; their mutants are the unit mutants M-C1/M-C2/M-C3 (no mutant package for consent, section M-answers) | yes |
| W-R5 | WIN-I | elevated Notepad (RunLevel Highest); bot types into it | no text lands; result not "confirmed" | mutant build without D8, Murage elevated -> text lands | yes |
| W-R6 | WIN-I | lock (`LockWorkStation`) then bot types; and lock while a per-action card is pending, then Allow from the phone | D10 error both times, turn completes, Notepad unchanged after re-logon | mutant build without D10 -> text appears | yes |
| W-R7 | WIN-I | 3840x2160 at 150 %: bot clicks a known button from a default (1568) screenshot | click lands, reply delivered, no stop line | control: the same coordinates sent as native-space (deliberately wrong space) miss the button | no (ship note) |
| W-R8 | WIN-X | real `tools/list` via `cua-driver.exe mcp` stdio under D4 env (no input), raw stdout saved | (a) inputSchema of `get_window_state`, `get_desktop_state`, `zoom` saved as `server/testing/cua-0.55.0-win-tools-list.json` (the D12 list source); (b) the raw reply line's key order: `id` before `result` or not (D16b proof applies only if before) | (a) W-B2's ineligible cell + M-B2d; (b) W-B3 (iii) | yes |
| W-R9 | WIN-I | update install (older build -> this build) with Local control on and the daemon running; second cell on a test build whose taskkill step is a no-op, so the real daemon stays alive past the 6 s stage | normal: installer completes, new daemon starts, no in-use failure; stuck cell: no installer process starts (process-creation audit 4688 shows none), the owner sees the retryable update notice, card `driver-stuck` | mutant build with fire-and-forget kill (M-Q1); stuck cell is itself the negative | yes |
| W-R10 | WIN-I | no-telemetry, packaged: Windows Firewall outbound block rules for `cua-driver.exe` and `cua-cursor-theme.exe` with WFP audit (5157) and process-creation audit (4688, command line on); parent env has `CUA_DRIVER_RS_TELEMETRY_ENABLED=true`, `DO_NOT_TRACK=0`; `~/.cua-driver/config.json` sets telemetry and update check on; run W-R4 (ii) with the agent cursor on, so the cursor helper is used | (a) 4688 shows all three roles started (daemon `serve`, per-turn `mcp`, `cua-cursor-theme.exe`); missing any role = RED, not GREEN; (b) 0 5157 events for both images; (c) r4: the provenance JSON's recorded W-P6 import scan for the pinned `cua-cursor-theme.exe` names no network library | per role: the mutant build without D4 shows 5157 attempts for each image that has a network path; if `cua-cursor-theme.exe` makes no attempt even under the mutant, the row records that (its control cannot go RED) and its proof rests on (a) + W-S2 env inheritance (ASTRA r2 M2) | yes |
| W-R11 | WIN-I | (r5, D19) leftover driver: a test build whose daemon ignores parent liveness; end Murage with `taskkill /F` on Murage's own pid only, confirm the driver pid is still alive, start Murage | before the new daemon's 4688 event, the old pid is gone, proven positively (r6 precheck pass 1; same reading as D19): the test script calls the shipped addon's `processStart(pid)` and gets a valid start different from the one in `driver.owner.json`, or `Get-Process -Id <pid>` fails with the no-such-process error (`ObjectNotFound`) AND the 4689 (process exit) event for that pid and start is in the Security log; an access-denied or any other error is UNKNOWN and fails the cell; exactly one `cua-driver.exe serve` runs afterwards | (r6, ASTRA 3014: r5's mutant targeted the `taskkill` path D19 removed) mutant build M-K7m: the native `terminateIfStart` returns `terminated` without terminating AND the adopted stop is confirmed by that report instead of `gone(pid)` (M-K7i) -> two `serve` processes. (NOOP alone, with `gone(pid)` kept, leaves the card on `driver-stuck` and starts no second daemon, which is the correct fail-closed outcome and is asserted by unit cell vi-c, not here); the reused-pid cell (vi-b) cannot be forced on a real box and is unit-only, stated as such | yes |

"blocks ship" = MAIN does not merge Windows-enabled code to a release branch while that row is missing or RED.
Evidence: `shared-base/<sha>/win/`. The builder writes the WINRUN-REQ with bundle and sha. r1's pre-build probe
request (`_small/WINRUN-REQ/design-1022-cua-windows.txt`, W-R1/W-R2 only) stands.

## 8. Out of scope

Native Windows arm64 build, UIAccess / `\Program Files\` install, Auto on Windows, an input-desktop probe, Windows
standalone `CuaDriver` attach, the Local VM, and Mac/Linux omitted-size default.

## 9. CONTRACT-REQ to the cua-upgrade lane (owner side: cua-upgrade-r4 and successors; consumer side: Windows builder, build-1022-cua-windows, MAIN until seated)

- C1 Export `CUA_DRIVER_VERSION="0.55.0"`, `CUA_CONTRACT_VERSION="0.9.0"` from `server/local-computer.ts`; the win32
  decoder imports them. Until then the Windows builder duplicates the literals and W-P3 catches drift.
- C2 (r4's Mac env task) When r4 makes the darwin descriptor require both OFF keys, export the accepted OFF values;
  Windows accepts only `"false"` either way.
- C3 SBOM/THIRD_PARTY: confirm the 0.55.0 SBOM covers the Windows exes (same source commit) or add a Windows row.
- C4 Broker claim fence (D13/D15/4b): claims record a generation; `withdrawGeneration(G)` refuses new G calls and keeps
  G's claim; `retireGeneration(G, {exitConfirmed:true})` closes G's sessions, answers G's waiting calls
  `driver-exited`, clears a G claim; never without `exitConfirmed`. All platforms (Linux has the same stuck-claim
  shape); the broker owner owns the linux/darwin cells in `server/host-computer-broker.test.ts`, including W-K8 (r4:
  withdraw is the broker's own fence, tested with `allowed()` always true; M-C4a/M-C4b).
- C5 Broker env scrub: before merging `spec.env`, drop inherited keys matching `/^CUA_/i` and `DO_NOT_TRACK`.
  All platforms.
- C6 Broker `verifySpawn(spec)` hook awaited before `this.start` in both the session and the one-off path; a throw
  answers that call 409 `{code:"driver-integrity"}` with its message (never a 500, which would seal the mount) and
  spawns nothing.
- C7 (r3 terms, replaces r2's "any overflow is a reply") Reader/broker overflow: the splitter keeps discarding an
  over-ceiling line until its newline and keeps its first 4 KiB; `startHeadlessEngine` rejects the pending request with
  `{code:"frame-too-large", complete, prefix}`. The broker releases the claim only on the D16(b) proof (complete,
  `"id":<pending id>,"result":` in the prefix, sole pending); otherwise it handles it as C8. All platforms; the broker
  owner owns the linux/darwin regression cells (proof and no-proof), the Windows builder the win32 cells (W-B3).
  r4 adds: the discard is bounded by `OVERFLOW_DISCARD_MS` 10 000 from the moment the ceiling is crossed (injectable
  clock); on expiry the reader rejects the pending request `{code:"frame-too-large", complete:false}` and fails the
  session, which the broker handles as C8 with `cause:"oversize"` (D16c). The broker owner owns the linux/darwin
  cell (child alive, no newline, call settles after the bound; M-B3d), the Windows builder W-B3 (iv).
  r5 adds (ASTRA r4 "owner accounting preempts W-B3"): at caps-opus 22039551ff the reader charges each chunk
  (`accountUpstream`, headless-browser-proxy.ts 156-157) BEFORE the splitter sees it, and the owner accounting throws
  its own 64 MiB cut (`UPSTREAM_OVERSIZE_CODE`, `server/memory/upstream-reader.ts` 37-41 at 22039551ff; the file is not in the 1ed75a3b2e tree); the reader's catch then fails the session
  and kills the child, so the splitter's overflow state is never reached on an owner turn. Required: ONE overflow
  state. Whichever detects the crossing first (the splitter's line ceiling or the accounting cut) puts the reader in
  `overflow`; the accounting cut is caught there and is not a failure; in `overflow` chunks go to the splitter's
  discard only and are not charged again; the state ends by the newline (proof rule) or by `OVERFLOW_DISCARD_MS`.
  Only ONE LINE over the ceiling may enter `overflow` (r5 self-review): at 22039551ff the accounting total is
  cumulative for the whole MCP child and its cut stays on once thrown (`if (this.cut) throw this.cut`), so seven
  10 MiB replies of one turn would trip it on the 7th. Required: on an owner turn the host reader's accounting is per
  item (reset at each newline); a cumulative total never cuts, discards or fails anything (the turn total is S3's
  recorded degrade). Witness: W-B1 (ii) 7th reply bytes-equal and 8th call works; mutant M-B3h (the cumulative cut
  enters overflow) is RED there.
  The reader side is M1(j) (cause22 caps); the claim side stays C7 (broker owner).
- C8 Unconfirmed child loss (D16a): when the MCP child exits or its reader fails with a started, unanswered
  `tools/call`, the broker rejects that call `{status:409, code:"driver-lost", sent:true}` (r4: plus
  `cause:"oversize"` when it came from the C7 bound) (never a plain Error that
  becomes a 500), keeps the claim, and calls an `onUnconfirmedLoss(spec)` hook the descriptor attaches (win32: post
  `murage:cua-stuck {G}`; darwin/linux: today's behaviour plus the 409 code, owner's choice of recovery, named in
  their own cells).
Until C4-C8 land on the builder's base, W-K2, W-K3, W-K5, W-K6, W-K8, W-B3 (incl. iv), W-S3/W-S3b and the C5 half of W-S4 are RED and the ship
gate holds (fail closed; the Windows builder does not edit the broker itself).

Requests parked (not Windows acceptance): C4-old "omitted-size default on darwin/linux" (now section 8).

## 10. Ownership

Windows builder side: builder lane family `build-1022-cua-windows` (branch `fix/1022-cua-windows`), seated by MAIN;
MAIN is the owner of this side until that lane is seated (r4, ASTRA r3 M4). It is the consumer side of C1-C8, M1
(a)-(d) and the WINRUN rows, and owns `server/host-computer-route.ts`, the win32 cells and the W-B1 rig. Named sides: C1-C8 owner = cua-upgrade lane (broker + pins; all-platform broker regression cells); M1 owner =
cause22 caps lanes (hops H-a..H-l and r5 sites S18-S25, sections 6 and 6a, M1 (a)-(j)); lock tracker = S4a; warm pool = WARM-1021-DRIVER; WINRUN relay = MAIN.

## R. Review map (round 1 -> r2)

| finding | closed by |
|---|---|
| ASTRA H1 memory cap can withhold a reply; 8 MiB is the wrong limit | P6, section 6 + contract M1 (collection max AND per-turn 64 MiB release budget), R14a (W-B1 12 MiB, 70 MiB/turn), R14b + C7 (W-B3 17 MiB, claim released), section 1 limit corrected to 16 MiB. SUPERSEDED in r3: section 6 (64 MiB ceiling), R14a 20 MiB cell, R14b/C7 proof rule |
| ASTRA H2 stale lock gate; channel; disconnect | D10 (a)-(c), R13b/R13c/R13d, M-L4..M-L7 |
| ASTRA H3 no broker retirement after daemon death | D13, 4a/4b, C4, R17 (W-K2 incl. unconfirmed cell); live-daemon stuck paths: C7, `cua-stuck` restart, `driver-stuck` (R17b, R17c) |
| ASTRA H4 per-call spawn unchecked | D6(b), D5 sha from server constant, C6, R5b (W-S3, M-S3b) |
| ASTRA H5 warm eligibility unowned | 0a warm owner, 4c (core.ts 6704 exclusion), R19 (W-W1) |
| ASTRA H6 telemetry witnesses miss packaged runtime | D4 scrub, C5, R6/R6b hostile env, W-R10 firewall-audited packaged run (RED without sending) |
| ASTRA H7 renderer callers | D7 renderer predicates, R9b (W-C3 parity loop), W-R4 (iii) |
| ASTRA M1 weak witnesses | W-C1 `providerSupportsLocal`; W-B2 zoom + `max_dimension`; W-R7 wrong-space control; W-B1 asserts the next click |
| ASTRA M2 elevation fail-open | D8 positive parse, R11 cells, `windows-integrity-unknown` |
| ASTRA M3 structure / release gates / ubuntu anchor | Purpose first; NO-OWNER carried into C1-C6, M1, WINRUN; "blocks ship" column; windows-latest (section 1) |
| FABLE H1 lock only at arrival | D10(c) term of `authorized()`, R13b (card pending, consent, in-flight) |
| FABLE H2 Electron half / channel | D10(a) `murage:host-desktop` over `serverProc.postMessage` + refresh on server start, R13c (W-L2) |
| FABLE M1 section 5 folder copy; M-P4 unreceiptable | section 5 per-file text; R4a static W-P5; R4b named release-only |
| FABLE M2 D10 scope | D10 "win32 only", W-L1 darwin/linux cells, M-L3 |
| FABLE M3 zoom schema | D12 schema rule, W-R8 |
| FABLE M4 card copy witness | R18 (W-K1) |
| FABLE M5 elevated copy | D8 copy |
| FABLE M6 ownership | 0a lock tracker (S4a/S3B) and route/proxy merge with cua-upgrade |
| FABLE M7 quit/update | D14, R20, W-R9 |
| pins vs cua-upgrade-r4 | 0a/Base: c3cf3c3cf5, 0.55.0/0.9.0, same checksums.txt; C1/C2 |

## R3. Review map (round 2 -> r3)

| finding | closed by | witness that goes RED |
|---|---|---|
| ASTRA r2 H1 HTTP writer and MCP writer still cap a screenshot | section 6 rewritten on the cause22 caps rule: six hops H-a..H-f, one 64 MiB ceiling, M1(a) B13 `post`, M1(c) broker reader; HTTP writer = A1/A2 degrade, MCP writer = B1 | W-B1 through the real proxy child, release door and `releaseProxyFrame`; M-B1a..e one per hop (R14a) |
| ASTRA r2 H2 no admission fence while G stops; W-K2 hand-made messages | D15 withdraw-first order, `generationOk()` term, claim kept until confirmed exit, `shared/cua-host-messages.mjs`; runtime loaded in-process with the harness's real handler | W-K5 (i)-(iv) incl. hanging taskkill, M-K5/M-K5b/M-K5c; W-K2 rewritten, M-K2c (R17, R17d) |
| ASTRA r2 H3 child exit mid-click wedges the claim; C7 releases without proof | D16(a) `driver-lost` 409 + immediate `cua-stuck` + confirmed restart (C8); D16(b) proof rule (C7 r3 terms); W-R8(b) records the real byte order | W-K6, M-K6/M-K6b (R17e); W-B3 (ii)/(iii), M-B3c (R14b) |
| ASTRA r2 H4 5 s stop inside the 2.5 s barrier; timeout installs | D14 one barrier: win32 stage 6 s from `cuaStopStageMs`; timeout keeps ownership, installer 0 times, existing retryable notice; "quits anyway" withdrawn | W-Q3 real `prepareBackedUpInstall`/`prepareUpdaterRestart`, M-Q3/M-Q3b; W-L3 main.mjs both awaits, M-Q3c (R20); W-R9 stuck cell |
| ASTRA r2 M1 lock witnesses; tools/list gate | D10(c) `hostDesktopOk(method)`; 409 never 403 | W-L1 locked-list `it` (M-L8), initialize-held cell iv (M-L11), poll (M-L10), 409 (M-L9); W-L2/W-L3 real `wireHostDesktop` + main.mjs subscription (M-L13/M-L14) |
| ASTRA r2 M2 W-R10 helper may never start; C5 mutant | W-R10 4688 role check (missing role = RED), per-role control | M-S4b (R6b) |
| ASTRA r2 M3 W-W1 only checks the flag | W-W1 real `poolable` + two-bot expiry | M-W1b core.ts exclusion mutant (receipt only) |
| ASTRA r2 M4 Sigstore and schema mutants | schema: D12 recorded schema file, W-B2 ineligible cell, M-B2d. Sigstore: answered in writing below | M-B2d |
| ASTRA r2 M5 owners of C7 / M1 downstream | 0a, section 6 table owner column, section 9 C7/C8, section 10 | n/a (ownership) |
| FABLE r2 M1 Electron half of cua-stuck/cua-integrity; channel | D10(a) channel named (`utilityParentPort` -> `proc.on("message")` -> `onHarnessMessage`) | W-K4, M-K4/M-K4b (R17f) |
| FABLE r2 M2 stale cua-stuck | 4a ignore rule | W-K3 ignored `it`, M-K3b |
| FABLE r2 M3 withdrawn note on lock | D10(c) note on `host-locked` with `sent` | W-L1 iii note, M-L12 |
| FABLE r2 M4 C1-C6 lists | section 10 now C1-C8 | n/a |
| FABLE r2 M5 first post vs listen | `murage:host-desktop-ready` re-send; W-R4(ii) named as backstop | M-L13 |

### Written answers to the Mediums that take no witness change

- ASTRA r2 M4 Sigstore: Sigstore is a pin-time proof, not a build step. It was verified when the 0.55.0 pin was made
  (section 1: SAN, issuer, 1-byte mutant fails), and the build then accepts only the zip whose sha256 equals the
  `checksums.txt` line of that signed release. Bytes that pass the sha check are exactly the bytes whose signature
  was verified, so a build-time Sigstore verifier would add a new dependency and network trust root (scope) and
  could not reject anything the sha pin accepts. A pin bump re-runs the verification by hand and records SAN,
  issuer and bundle sha256 in `scripts/cua-driver-0.55.0-windows-provenance.json`; W-P3 already fails a bump that
  moves the version without moving the pin. No invalid-signature cell is added. Parked P-7 if Sean wants an
  automated pin-bump verifier.
- ASTRA r2 M4 packaged consent mutants: W-R4 (i)/(iii) are the packaged negative cells. Their regressions are
  receipted at unit level (M-C1, M-C2, M-C3/M-C3b on the same predicates the package runs). A separate mutant package
  per consent rule would cost a signed Windows build each, for no path the unit mutants miss.
- ASTRA r2 M5 Windows builder: still OPEN NO-OWNER in r3 (superseded in r4: owner named, section 10).

## R4. Review map (round 3 -> r4)

| finding | closed by | witness that goes RED |
|---|---|---|
| ASTRA r3 H1 W-B1 stops before the production engine relay (2 MiB relay line, fixture 16 MiB caps) | section 6 hops H-g..H-k (ingress issue, relay line, relay held output, mount accept, ingress deliver) from CAPS-INVENTORY A5-A7, A12, A14 / caps-opus C12, C13, C22; M1(d); W-B1 rig: real `CliMountRelay` + real spawn of the real proxy child, door = the two index.ts calls, real route via `handleHostComputerRoute`, engine socket read as `cli-mount-shim` connects; `bound-proxy-fixture.ts` not used | W-B1 (i)-(iv), one mutant per hop: M-B1e, a, b, c, d, q, k, n, f, i, o, g, p, h, j, l, m; W-B1s static, M-B1fs (R14a) |
| ASTRA r3 H2 withdrawal lost on harness restart; surviving descriptor re-admits G | D15 r4: main is the authority, `liveGeneration` starts null in every harness, `live:G` only from `ready(G)`, re-sent on `-ready`; startup leftover-pid stop; descriptor deletion no longer load-bearing | W-K5 (v) harness replaced after failed delete + failed kill, M-K7/M-K7b; (vi) leftover pid, M-K7c (R17d) |
| ASTRA r3 H3 overflow with a live child and no newline pends forever | D16(c) `OVERFLOW_DISCARD_MS` 10 s bound -> C8 path `driver-lost cause:"oversize"`, claim kept until confirmed exit; C7 r4 | W-B3 (iv) with a `settled` flag on a fake clock, M-B3d/M-B3e (R14b) |
| ASTRA r3 H4 identity check can stat another file than the one hashed; M-S3b setup unreachable | D6(b) r4: open once, `fstat(fd)` before and after hashing through the fd, path `stat` before spawn must equal the fd's identity, bigint; M-S3b moved to W-V1 as M-V4 | W-S3b rename-during-hash and in-place-write cells, M-S3c/M-S3d (R5b); M-V4 (R7) |
| ASTRA r3 H5 `shared/cua-host-messages.mjs` not in the packaging allowlist | section 5: `files:` line; literal import specifiers | existing gate test `scripts/check-packaged-shared-imports.test.mjs:42`, M-PK1 (R4c) |
| ASTRA r3 H6 P3 says two switches; W-C2/4a start on one | P3 r4 boundary: daemon on the app switch alone, sessions and actions only on both | W-C4 (a)-(c) on the real turn-mount builder, route and broker with every bot on Auto, M-C4/M-C4b (R10b) |
| ASTRA r3 M1 lock-after-init cell asserts dispatch only | W-L1 (iv) also asserts 409, `host-locked`, `sent:false`, exact text | M-L15, M-L16 (R13b) |
| ASTRA r3 M2 update while startup is pending | D14 r4: win32 stage is one `cuaCleanupStage` call; `stop()` handles `starting`; late handshake rejected | W-Q3 (iii)-(v), M-Q3d/M-Q3e; W-L3 static, M-Q3c (R20) |
| ASTRA r3 M3 cursor-helper telemetry evidence | written answer below + W-P6 PE import scan at staging, recorded per pin; W-R10 (c) | M-P6 (R6c) |
| ASTRA r3 M4 mutant gaps and ownership | M-C1b; one mutant per hop (17 hop rows, 17 runtime mutants + 1 static); W-K8 broker-own withdraw cell; owners named (0a, 9, 10) | M-C1b (R9), M-C4a/M-C4b (R17g) |
| FABLE r3 M1 withdraw post must never block taskkill at quit | D15 post fire-and-forget and wrapped | W-Q1 harness-gone cells, M-Q1b (R20) |
| FABLE r3 M2 W-Q3 tests `cuaCleanupStage` but main.mjs only passes ms | main.mjs calls `cuaCleanupStage` itself on win32 (D14) | W-L3 static, M-Q3c (R20) |
| FABLE r3 M3 over-ceiling reply read as driver-lost has no hint | D16(c) `cause:"oversize"` copy | W-B3 (iv) copy `it` (R14b) |
| FABLE r3 M4 fresh start ignores the leftover pid-file | D15 r4 startup step | W-K5 (vi), M-K7c (R17d) |
| FABLE r3 M5 W-E1 lacks timeout/spawn-error/two-label cells | R11 cells added | M-E3, M-E4 (R11) |

Self-review (Opus, read-only, r4): BLOCK 1H, fixed: engine-socket drain (A15) still threw and sealed the turn
behind a slow engine read -> hop H-l, M1(e), W-B1(iv), M-B1m. Mediums fixed: W-C4 retargeted to the real Auto
branch through an extracted `hostComputerMountForTurn`; M-S3c/M-S3d made independently RED; `stopping(G)` answers
`live:null` (W-K5 v-b) and a positive re-arm cell (W-K5 vii, `-ready` routed to the runtime); A8 and the other
proxy/door/relay checks given hop rows and mutants; rig uses the production `spawnMount`; W-B1(iii) defers a small
reply first; reads bounded by a deadline; section 5 states the single `cuaCleanupStage` call; W-Q3(v) "by 6 s".

### Written answers to the r3 Mediums

- ASTRA r3 M1: answered by witness (W-L1 iv code/`sent`/text `it`s and M-L15/M-L16). The broker's late refusal is
  mapped by the route to `host-locked` whenever the failing `authorized()` term is the lock term.
- ASTRA r3 M2: the r3 stage awaited `cuaReady` (up to the 10 s handshake) before `stopCua()`, so a 6 s bound could
  fire before any stop. r4 removes that await on win32: one `cuaCleanupStage` call whose `stop()` withdraws and kills
  a starting child at once; a late handshake cannot make G live. Withdrawal and retained-pid retry are witnessed for
  this branch (W-Q3 iii-v). darwin/linux unchanged.
- ASTRA r3 M3: `cua-cursor-theme.exe` is started by the daemon with the daemon's environment block (CreateProcess
  inherits it unless one is passed), and the daemon's block is the W-S2-checked D4 set. Reading another process's
  environment on Windows needs a debugger-class tool, so r4 does not claim an effective-environment capture. Instead
  it substantiates the absence of a network path: W-P6 fails staging if the helper's PE import or delay-load table
  names any network library (RED-capable on a fixture PE), the pinned result is recorded in the provenance JSON, and
  W-R10 (b) still needs 0 WFP 5157 events for the helper image under a hostile parent env and config. A helper
  reaching the network without importing a network library (manual LoadLibrary) is not a path the pinned binary
  shows; if a future pin's scan lists a network library, W-P6 fails that pin bump and the env question reopens.
- ASTRA r3 M4: M-C1b added; W-B1 now has one runtime mutant per hop for all 17 hop rows (plus the static door mutant);
  W-K8 tests `withdrawGeneration` with the route gate held always-true, so removing it alone goes RED. Windows
  builder owner: `build-1022-cua-windows`, MAIN until seated. Relay/ingress hops: cause22 caps lanes (M1 d).
- FABLE r3 M1-M5: closed by witness (table above).

## R6. Review map (r5 ba39e92f83 -> r6; delta only)

| finding on ba39e92f83 | closed by |
|---|---|
| OPUS 3011 High (= FABLE 3010 M1, ASTRA 3014 part 1): `consuming-turn-ingress.ts` 107 engine-request count has no row; (vii) stays on 4096 | S29 + cell (vii-c) (4 097 in flight behind a held first call) + M1 (l) citing cause22-main-b R7; M-S29/M-S29n/M-S29d; (vii) kept at 4 096 for S19 |
| ASTRA 3014 High part 1: Pi and OpenAI-chat result truncation and turn stops missing from the sweep | r6 grep in section 6a; S30, S31 (COMPLIANT trims, cited to cause22-caps-opus-r4 SITES line 44; M1 (k) for the cap name), S32/S33 (in cause22-OPEN-2 scope: M1 (m), cell ix rows A/B with base RED), S34 (not on path); P6 names the boundaries; reply shape fixes E4/E5 "bytes equal" |
| ASTRA 3014 High part 2: E5 cell (v) cannot reach M-S25 | S25 NOT-APPLICABLE on the host mount with the reason, M-S25 deleted; (v) E1 only and rewritten per cause22-OPEN-2 (over-count reply fails as one item), M-S18x added; S25/S28 pin `it` |
| ASTRA 3014 High 2: W-C5 (b) base RED stalls behind the held click | W-C5 rows A (held, cell a) and B (settled, cells b and d) |
| ASTRA 3014 High 3: W-Q4 omits the arm64 read; M-Q4b masked | arm64 row; "no later step" `it` per cell; M-Q4a now removes every compare; M-Q4b and new M-Q4f RED at "no later step" |
| ASTRA 3014 High 4: W-R11 mutant on the removed `taskkill` path | W-R11 mutant M-K7m on `terminateIfStart` + report-confirmed stop |
| FABLE 3010 M2 stale taskkill wording | M-K7c and cell vi-a text say `terminateIfStart` |
| FABLE 3010 M3 exclusion.c not in section 5; no CONTRACT-REQ for M1 (f)-(j) | section 5 "Edited in r6" and section 0a; CONTRACT-REQ line for M1 (f)-(m) filed on the board with this round |
| MAIN 3018 with ASTRA 3017 (r4 race entry e98440eaa7, retired; r6 carries it; the document check keys on row I-20 only): reused-pid kill, failed query read as death | closed by D19 as written in r5 (pid + start time, one-handle `terminateIfStart`, null = UNKNOWN, positive `gone(pid)`), mapped as I-20; W-R11's death proof made positive in r6 |
| r6 precheck pass 3 (Astra on 58fec2ed70; folded after the pass cap, not re-checked by Astra): (v)/(vii-c) base turn's release budget (4 096 attempts) seals first, imported lines absent on base; (i-t) first cutting hop is S2 not S4; parser argument-size cap missing | S3 names the attempts counter; (v)/(vii-c) base RED attributed to S3, the S18/S29 REDs at a declared pre-fix checkpoint (caps merged, only that fix reverted) with seal-cause rule and arrival assert; fixed lines held as test literals with a tip-only equality `it`; (i-t)/(i) base RED at S2; S37 + row D, M1 (m) extended |
| r6 precheck pass 2 (Astra on dc1da9ac20): (i-u) cannot reach its note on the base behind S4/S24, `.todo` wording left in M1; (ix) row B stops at the 32-per-reply parser cap, which is itself an owner-turn count site | (i-u) reply under every transport cap (1 MiB picture), base RED at the note and notice `it`s; M1 wording fixed; S35 + row C, row B as six 32-call replies + 9; M1 (m) covers S35 |
| r6 Opus self-review on d89385be79 (H1 off by one, H2 step budget vs OPEN-2 and board lines not filed, H3 M-S33b unreachable; Mediums 2-7) | H1-H3 closed with the pass-1 fold below (4 096 further; M1 (m); M-S32/M-S32d/M-S33/M-S33n); CONTRACT-REQ filed on the board before PUSHED; grep hits added to S34; last W-Q4 compare stated; W-R11 cites vi-c; P6 frame-count wording; notice after the cut in M1 (k); (i-t) 100-byte lines |
| r6 precheck pass 1 (Astra on d89385be79): (v) liveness by a relay-writable answer; (vii-c) off by one and need-drain could seal first; (i-u) S4 preempts S24 and `.todo`; (ix) pins and a surviving M-S33b, step budget in OPEN-2 scope; W-R11 accepts any `Get-Process` failure | (v) two clicks past the count reach the driver + proxy pid alive; (vii-c) 4 096 further, paced, seal-cause receipt rule; (i-u) base RED attributed to S4 and the note `it` real; (ix) rows A/B under M1 (m) with base RED, M-S33b removed; W-R11 death proven by a valid different start or a positive no-such-process |
| FABLE 3010 M4 no CHECKLIST.md | unchanged: section 0b/0c and the review maps are the design's checklist; CHECKLIST.md with entry file:line per witness is the builder's (PROCFIX P2) |

## R5. Review map (r4 1ed75a3b2e -> r5)

| finding (board line) | closed by | witness that goes RED |
|---|---|---|
| FABLE H1 (2958) owner-turn seal sites omitted: relay 121/176, Pi 32 MiB, OpenAI-chat | P6 reworded; section 6a SITES S1-S28 with the class grep; engines E1-E5; M1 (f)-(j) | W-B1 cells (i-b), (v), (vi), (vii), (viii) on every engine row; M-S18, M-S19, M-S20, M-S21, M-S23, M-S24, M-S25, M-S26 |
| FABLE H2 (2958) W-B1(iii) / M-B1h unreachable; base-RED claim needs a rig valid on the base | section 6a "held output" (production order recorded), S9 NOT-APPLICABLE (all proxy output is serialised behind the ack), M-B1h deleted, M-B1p reworked as M-S12; rig r5 imports no product module | none for S9 (unreachable, stated); M-S12 at (i); W-B1 runs on the base unchanged |
| FABLE H3 (2958) M-K7 green with the lock still unknown | D20 last paragraph; W-K5 (v) with desktop `active`, setup assert and control cell | M-K7 at (v) first `it` |
| FABLE H4 (2958) W-C4 on an extracted predicate; M-C4b dereference | R10b at the real turn entry on the booted server; M-C4b, W-C4s and `hostComputerMountForTurn` withdrawn | W-C4 (a)-(c); M-C4, M-C1, M-C4n |
| FABLE H5 (2958) no cancel/join in pre-spawn `checking`; adopted pid death unproven | D18 start epoch + join; D19 identity poll; W-R11 | W-Q4 table, M-Q4a..e; W-K5 (vi-c), M-K7i |
| ASTRA A1 (2963) consent revocation misses sibling threads and a failed Disable | D17 (a)-(d) | W-C5, M-C5a..e; W-C6, M-C6a..c; W-C7, M-C7 |
| ASTRA A2 (2963) harness re-arm loses an in-flight claim | D20 one harness per generation | W-K5 (vii), (vii-b), (viii); M-K7f, M-K7g |
| ASTRA A3 (2963) update misses pre-spawn checking | D18 (join before the installer is admitted) | W-Q4 update rows, M-Q4a, M-Q4c |
| ASTRA A4 (2963) daemon hashing path-racy | D6 (a) r5: `verifyExeIdentity` for both exes | W-S1b, M-S1c, M-S1d |
| ASTRA A5 (2963) orphan cleanup trusts a reusable pid | D19 pid + start time record | W-K5 (vi-a..d), M-K7h, M-K7j; W-R11 |
| ASTRA A6 (2963) W-B1 bypasses production wiring; unreachable mutant targets | rig r5 = booted production server; every mutant row names the cell that reaches it | W-B1, M-S01..M-S26 |
| ASTRA A7 (2963) owner accounting preempts W-B3 | C7 r5 one overflow state, M1(j); W-B3 under the real accounting | W-B3 (i), (iv); M-B3f, M-B3g |

Carried Medium answered: FABLE r4 note on the oversize copy for every no-proof overflow -> D16 r5 note.

## GAP-CHECK r6 (one adversarial pass, GAP-CHECK-BAR)

Fixed in r6:
- F45 (c) The owner, on a bot running a busy engine, has many computer calls queued at once; the 4 097th seals the
  mount and the computer tool is gone for the rest of the turn (breaks P6, cause22-one-rule) -> S29, cell (vii-c).
- F46 (c) The owner, on a Pi or OpenAI-chat bot, asks for a window with a very large accessibility tree; the text is
  cut at 50 KiB and, on OpenAI-chat, the note does not say which limit (cause22-one-rule asks the trim to name the cap)
  -> S30, S31, M1 (k), cells (i-t), (i-u).
- F47 (c) The owner asks an OpenAI-chat bot for a long task on the PC; at round 64 the turn fails with "Stopped after
  64 steps" and no answer (a count ends the owner turn, cause22-OPEN-2) -> S32/S33, M1 (m), cell (ix): the budget stays,
  the last round asks the model to answer, the turn ends with its reply.
Parked: none.
Rejected: none.

## GAP-CHECK r5 (one adversarial pass, GAP-CHECK-BAR)

Fixed in r5:
- F41 (d) The owner sets a bot from "This computer" to Auto while that bot's routine runs in a second thread; the
  routine keeps clicking on the PC (breaks P1) -> D17 (a)-(b), W-C5.
- F42 (d) The owner presses Disable while the harness is not answering; the card waits on the sweep, Disable never
  runs and bots keep the PC (breaks P1) -> D17 (c)-(d), W-C6, W-C7.
- F43 (d) The harness crashes mid-click; the new harness is told the same driver is live and starts a second action
  beside the first (breaks P5/P1: acting without one owner-approved action at a time) -> D20, W-K5 (vii).
- F44 (b) The owner clicks Install update one second after switching Local control on; the elevation probe is still
  running, the stop returns, the installer starts and the driver then spawns under it (breaks D14's promise never to
  install over a live driver) -> D18, W-Q4.
- F45 (d) Murage crashed; Windows gave the old driver's pid to another program; at next start Murage kills that
  program (harm to the owner's work) -> D19, W-K5 (vi-b).
- F46 (d) A same-user process swaps `cua-driver.exe` while Electron hashes it at daemon start (breaks P2) -> D6 (a)
  r5, W-S1b.
- F47 (c ruling) A long owner turn passes 10 000 tool frames, or the owner's bot runs on Pi and takes a 40 MiB
  screenshot, or pastes 1 MiB of text: the computer tool dies for the rest of the turn (breaks P6 and
  cause22-one-rule) -> section 6a S18-S25, M1 (f)-(i), W-B1 (i-b), (v), (vi).
- F48 (b) A 65 MiB driver reply on an owner turn kills the session at the accounting cut and reports a generic
  failure instead of the one-call oversize error (breaks P6 "fails that one action with a plain tool error") -> C7 r5,
  W-B3 (i), M-B3f.
- F49 (a) P6 promised every screenshot passes whole, while the OpenAI-chat family cannot be given a picture in a
  tool result; the promise and the product disagreed -> P6 reworded, S26 kept and witnessed.

Parked in r5 (for Sean): P-10 raising the 64 KiB limit on one typed/pasted input (S21 stays a one-call error; a
larger limit is the caps owner's call). P-11 a saved-setting failure on Disable can let Local control come back on at
the next start; r5 tells the owner at once (D17 d) but does not add a second store. P-1..P-9 stand.

## GAP-CHECK r4 (one adversarial pass, GAP-CHECK-BAR)

Fixed in r4:
- F33 (c ruling) The owner's 20 MiB screenshot passes broker, route and proxy, then the mount relay's 2 MiB line cap
  seals the computer mount for the rest of the turn (breaks P6) -> section 6 H-g..H-k, M1(d), W-B1 production rig.
- F34 (d) Owner switches Local control off; descriptor deletion and taskkill both fail; the harness restarts and the
  surviving descriptor lets a bot click on a PC the owner turned off (breaks P1) -> D15 r4 main authority, W-K5(v).
- F35 (b) A driver bug writes an endless screenshot line without a newline; the click never answers and computer use
  hangs with the card at ready (breaks P7) -> D16(c), C7 r4, W-B3(iv).
- F36 (d) A same-user process swaps `cua-driver.exe` while the harness hashes it; the hash of the old bytes passes and
  the new bytes run (breaks P2) -> D6(b) fd-bound identity, W-S3b.
- F37 (b) The packaged app imports `shared/cua-host-messages.mjs` that is not packaged; Murage dies at launch before any
  card (breaks P7) -> R4c, M-PK1.
- F38 (a) P3 and the startup witness disagree on whether a start needs both switches; a builder could ship either ->
  P3 r4 boundary, W-C4.
- F39 (b) Update clicked during a slow driver start: the stage times out before any stop and the retry path is
  unverified -> D14 r4 single `cuaCleanupStage`, W-Q3(iii)-(v).
- F40 (b) Murage restarts after a crash with the old driver still alive; the new start collides on the pipe or runs two
  drivers -> D15 r4 leftover-pid stop, W-K5(vi).

Parked in r4 (for Sean): none new. P-1..P-9 stand. The final path-stat-to-CreateProcess window after D6(b) stays P-6.

## GAP-CHECK r1-r3 (kept)

Fixed (r1 F1-F13 stay fixed; r2 additions):
- F14 (b) Daemon crashes mid-click; the claim never clears; every Retry says "another action in progress" (breaks P7)
  -> D13/C4/R17.
- F15 (d) Owner locks the PC while an Allow card is pending and taps Allow on the phone; the click runs behind the
  lock (breaks P5) -> D10(c)/R13b.
- F16 (b) Harness restarts while the owner sits at an unlocked PC; without a re-send every action says "locked"
  forever (breaks the purpose) -> D10(a) refresh + re-send/R13c.
- F17 (c ruling) A 4K desktop shot of 12 MiB is refused by the 8 MiB collection budget on an owner turn -> section 6
  M1/R14a.
- F18 (d) A same-user process swaps `cua-driver.exe` after the daemon started; the next turn's MCP child runs it
  (breaks P2) -> D6(b)/R5b.
- F19 (c no-telemetry) The owner's shell exports `CUA_DRIVER_RS_TELEMETRY_ENABLED=true` and Murage inherits it -> D4
  scrub/C5/R6b/W-R10.
- F20 (a) Renderer shows a win32 bot on Auto as "this computer" while the server mounts nothing; or the off-switch
  sweep skips Windows -> D7/R9b.
- F21 (d) `whoami` prints an unexpected format (localized or truncated) and the old SID-exclusion check lets an
  elevated Murage drive the PC -> D8 positive parse/R11.
- F22 (b) Update install while the daemon still maps `cua-driver.exe`; the installer fails on the in-use file ->
  D14/R20/W-R9.
- F24 (c ruling) A long owner turn takes seven 10 MiB screenshots; the 64 MiB per-turn release budget seals and stops
  the turn -> section 6 M1(b)/W-B1(ii).
- F25 (b) A 17 MiB frame, or a withdrawn action the driver never answers, keeps the broker claim while the daemon
  lives; computer use is dead with the card still `ready` -> C7, `cua-stuck` restart, `driver-stuck` state
  (R14b, R17b, R17c).
- F23 (e) Lock tracker starts `unknown` and has no timer; at boot with no lock event Windows computer use would stay
  refused -> `lock.refresh()` before every push on server start (D10a).

Fixed in r3 (one pass, all kinds and scenarios from the r2 reviews, re-checked against code):
- F26 (c ruling) A 20 MiB 4K screenshot on the owner's turn passes the broker but is sealed at the proxy `post`
  (16 MiB) or the model-facing frame (8 MiB); the computer tool dies for the rest of the turn -> section 6 H-d/H-e,
  M1(a), W-B1(i).
- F27 (d) Owner switches Local control off while a click waits on a card; taskkill fails; Allow from the phone runs
  the click on a PC the owner just turned off -> D15, W-K5.
- F28 (b) The per-turn MCP child crashes mid-click while the daemon lives; every later action says "Another computer
  action is in progress" with the card at ready (breaks P7) -> D16(a), C8, W-K6.
- F29 (d) A 70 MiB line overflows before its id is read; r2 released the claim while the driver might still be
  acting -> D16(b) proof, C7 r3, W-B3(ii)/(iii).
- F30 (b/d) Update while the driver takes 4 s to exit: the 2.5 s barrier aborts the update, or a timeout treated as
  done installs over a live driver -> D14 one 6 s barrier, installer 0 on timeout, W-Q3, W-R9 stuck cell.
- F31 (b) Owner locks the PC while the MCP child is still in `initialize`; the action is sent after init -> D10(c)
  broker check after ready, W-L1(iv).
- F32 (a) A lock refusal answered 403 seals the computer mount; after unlock the bot can't act until a new turn
  (breaks P5 "the turn still runs") -> D10(c) 409 only, M-L9; same for integrity (C6) and child loss (C8).

Self-review (Opus, read-only, r3): BLOCK 3H, all fixed in this revision: #1 M-B1b could stay GREEN (window renewal
after an accepted release) -> M-B1b restores the whole c3cf3c3cf5 `check()`; #2 M-K5 could stay GREEN with an
instantly failing taskkill -> W-K5(iv) hanging taskkill + M-K5c; #3 nothing pinned main.mjs's stage deadline -> W-L3
static on both awaits + M-Q3c, D14 names both awaits; minors: r1 map row marked superseded, `host-off` worded by cause.

Parked (for Sean):
- P-1 Native Windows arm64 build (new target: scope).
- P-2 `\Program Files\` + UIAccess (installer change; weakens P4).
- P-3 Auto on Windows reaching the host (would need platform-aware consent card).
- P-4 RDP-disconnected session with no lock event (rare; driver errors honestly).
- P-5 Runtime Authenticode (pinned sha256 at both spawns is stronger; W-R1 per pin bump).
- P-6 Same-user process racing a rename between stat and spawn, or using the Low-label pipe (same-user trust
  boundary on every platform).
- P-7 Automated Sigstore verifier for pin bumps (new dependency and trust root; the sha pin already binds the
  verified bytes).
- P-8 (carried from FABLE r2) A PC that auto-locks refuses all computer actions while the owner is away (P5 as
  written; product decision).
- P-9 Non-owner turns on this path keep today's caps (CAPS-INVENTORY scope; widening it is the caps owner's and
  Sean's call).

Self-review (Opus, read-only, r2): BLOCK 2H 3M, all fixed in this revision: N1 per-turn 64 MiB release budget ->
section 6 M1(b), W-B1(ii); N2 claim stuck while the daemon lives -> C7, `cua-stuck`, `driver-stuck`, R17b/R17c;
N3 M-K2b unRED-able -> W-K2(a); N4 test seam -> section 5; N5 consent cell unreachable on win32 -> R13b(ii) rewritten;
minors: `lock.state()` mapping, no disconnect event (R13d rewritten), route line refs.
