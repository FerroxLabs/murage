# O12 / SCOPE row 80 relayseal: DESIGN r4 = r3 refreshed against dev/1022 (rvd-1022-row80-relayseal, 2026-11-23)
Owners: this refresh = rvd-1022-row80-relayseal (design only, no code). Turn preparation, the omission and witness file `server/cloud-home/own-server-omitted-1021.test.ts` = O12 (bld-O12-1021, merged). Both production admission barriers (`mcp-mounts.ts:137`, production `admit`) = MAIN. Relay files (`vps-mcp-relay.ts`, `vps-relay-mcp.ts`) and the activation contract (§7 of r3) = the future activation lane MAIN seats (none today). The outer release leg (VPS relay proxy to proxy release authority) = **OPEN NO-OWNER** (unchanged since r2).
Anchor: dev/1022 6d4b5932a8 (1.0.1022 train). Base design: `DESIGN-r3.md` a14b1bb3f3 (copied into this tree unchanged). Cause: `CAUSE.md` (r1, unchanged).

## 0. What this refresh is
r3 is not open. Both reviewers agreed it, and its build has shipped into the train:
- Astra AGREE on r3b ce84a64808 (`conv-O12-r3/ASTRA-R3-2.txt`). a14b1bb3f3 differs only by Parked P-6 and one table cell.
- Fable AGREE on a14b1bb3f3, 0 Critical / 0 High, 5 Mediums to build (`fchk-O12-r3/FABLE-R3.txt`). The verdict is recorded as `READY-TO-BUILD O12` in `_small/DESIGNS-1021-AGREED.txt:5`.
- Build O12 73c7fb77e7 (FABLE + OPUS AGREE, board n4:511/531), then 9912f0a428 (REGRESSOR row 37 fix, FABLE + OPUS AGREE, n4:1122/1124), went into COMBINE TIP b45d0259e6 (n4:1171). Both shas are **ancestors of dev/1022 6d4b5932a8** (`git merge-base --is-ancestor`).
- The RECON row says "0 verdicts on r2/r3" because the verdicts were filed under the name `O12`, not `relayseal`. They are in the dirs listed above and in frev-O12-r2 / arev2-dsg-O12-r2 for r2.

This refresh therefore changes **no mechanism, promise, witness or parked item**. It re-anchors every r3 claim on dev/1022, confirms that nothing merged since the r3 review anchor (dev/1021 068a595c9a) reopens the residual, records how the Fable r3 Mediums closed, and restates what is still open. Review scope = this file only.

## 1. PURPOSE (unchanged from r3)
On a Cloud home, a bot whose computer is its own server (VPS) never has its turn refused because of that computer: not at mount, not at relay admission, and not because held context is still `checking:pending`. A proven revoke still refuses exactly as today, and nothing unchecked reaches the engine or the server.

## 2. USER PROMISES (unchanged from r3 §2)
P1 the turn runs without a computer and the bot is told; P2 one plain owner line, at least once and normally once per bot; P3 nothing touches the own server on that turn; P4 a proven revoke refuses as on any turn; P5 desktop and Cloud routines (`runOn:"cloud"`) are unchanged and there is no new prompt or card.

## 3. Re-anchor table: r3 claim → dev/1022 6d4b5932a8
| r3 claim | r3 cite (068a595c9a) | dev/1022 site | holds |
|---|---|---|---|
| §4.1 one decision before claims: `ownServerOmitted` term, `wants = "off"` | index.ts:17241-17245 | `server/index.ts:17618-17624` (in `startTurnAdmitting`, `:16351`, the single prep every turn route enters via `startTurn` `:16349`) | yes, built |
| `cloudBackend` is `"box"` for `runOn:"cloud"` | :17234 | `server/index.ts:17611` | yes |
| owner line: append first, then flag; throw caught | §4.3 | `server/index.ts:17625-17630`; copy `server/cloud-home/copy.ts:216` (Fable M10 wording) | yes |
| flag reset on backend/computer change | :35984-35985 | `server/index.ts:36459-36462`; field `server/store.ts:1202` next to `localControlOffNoted` `:1201` | yes |
| VPS branch (the only `activeVpsThreads.set`, `vpsRelayBindings.set`, relay `integrations.localComputer`) entered only for `wants` cloud/undefined | :17358, :17362, :17374, :17375 | `server/index.ts:17743` (guard), `:17747`, `:17759`, `:17760-17763`; grep of dev/1022: `vpsRelayBindings.set` and `SPAWNED_PROXIES.vpsRelayMcp` in `index.ts` each have exactly 1 site, both inside `:17743` | yes |
| Auto host fallback cannot take over (needs `wants === undefined`) | n/a | `server/index.ts:17838-17841` (`wants` is `"off"` after §4.1) | yes |
| bot told via `COMPUTER_UNAVAILABLE` | :18057, bot-shapes.ts:316,339 | `server/index.ts:18451`; `server/bot-shapes.ts:321,344` | yes |
| backstop 1: mount refusal for role `vpsRelayMcp` | mcp-mounts.ts:137 | `server/drivers/mcp-mounts.ts:137` (line unchanged; file changed after 6d4b5932a8 by revkill3 `drop()` returning the answered call id, no admission or refusal change) | yes |
| backstop 2: production `admit` returns undefined and writes one ledger refusal (Parked P-3) | index.ts:40750-40757 | `server/index.ts:41279-41286` | yes, text identical |
| relay reachability needs `admit` ≠ undefined and `boundContainer` non-null | vps-mcp-relay.ts:84, :101-102 | `server/cloud-home/vps-mcp-relay.ts:101` (+ `:122`, `:137` reuse); file byte-unchanged | yes |
| relay, ingress, fence-pending, proxy release, bridge: byte-unchanged | §3 | `vps-mcp-relay.ts`, `vps-relay-mcp.ts`, `consuming-turn-ingress.ts`, `fence-pending.ts`, `mcp-bridge.ts`, `proxy-turn-release.ts`: `git diff --quiet 068a595c9a..dev/1022` = unchanged for these 6; `drivers/mcp-mounts.ts` was unchanged to 6d4b5932a8 and differs at 0ab18070cb only by revkill3 `drop()`/`replyId` (24+/12-), refusal at :137 intact | yes |
| witnesses O1-O6, B1, B2 in the real-server suite | §5 | `server/cloud-home/own-server-omitted-1021.test.ts` (owner header `:33`), listed `ci/gate-tests.txt:998` linux (REGRESSOR row 37 fix) | yes, merged |

**New dev/1022 code checked for a second path to the relay (none found):** `server/cloud-home/engine-render.ts:39` lists `vpsRelay: SPAWNED_PROXIES.vpsRelayMcp` in its proxy-source table. That table only renders stanzas for proxies the server already chose, so it adds no mount decision. The only change to `consuming-sink-inventory.ts` since 068a595c9a is one phone tool row. The `index.ts` diff since 068a595c9a adds no VPS lines except the O12 build itself (`:17618`, `:36460`).

## 4. Fable r3 Mediums (items 5-9): how the build closed them (`bld-O12-1021/DONE.md`)
- M5 O5a seam: fault injected at `Store.appendMessage` for the exact status row, in the test (DONE.md:15, row O5a; mutant M20 RED).
- M6 O3 across processes: the build tightened O3 in its final source (DONE.md:34), and Fable + Opus AGREE on 73c7fb77e7 (n4:511/531).
- M7 placement: the line belongs to the first eligible thread, including a routine or shared thread (DONE.md:13). The per-bot vs per-thread choice stays with Parked P-4 for MAIN.
- M8 flag reset: saving or deleting an own-server connection **keeps** the flag (DONE.md:13). Only a backend or computer change clears it (`index.ts:36459-36462`).
- M9 B2 labelling: B2 is labelled as the pin of Parked P-3 (DONE.md:13, :28).

## 5. Still open (unchanged, for MAIN or Sean; none blocks row 80 on dev/1022)
- P-1 activation of the own-server computer on Cloud (r3 §7, A1-A5). MAIN has posted no SCOPE SPLIT ruling for it.
- P-2 O-a: transport loss recorded as a memory refusal on the relay (only reachable after activation).
- P-3 production `admit` refuses its own turn for a hand-made claim (`index.ts:41284`), pinned by B2.
- P-4 copy: per-bot vs per-thread line. The setup screen line `ownServerTestOk` "Your Cloud can reach Docker on your server." is now `copy.ts:229`.
- P-5 desktop `ingress.drop()` with no permit (desktop residual).
- P-6 owner VPS management routes stay reachable on a Cloud home (owner actions, not turns).
- OPEN NO-OWNER: outer release leg (VPS relay proxy to proxy release authority), needed only on activation.
- Not a design item: bld-O12-1021 last.txt still lists Mac/Windows receipts as pending. The desktop VPS witness fails on both base and lane (inherited, its owner is the desktop VPS suite).

## 6. Row 80 state proposal
r3 needs no new mechanism. Row 80's code is in dev/1022, so RECON should move row 80 from DESIGN-NEEDED to **MERGED** (73c7fb77e7 / 9912f0a428). P-1 activation would become a new 1.0.23+ row, opened only by a MAIN/Sean scope ruling.

## 7. GAP-CHECK (one adversarial pass on dev/1022, GAP-CHECK-BAR)
Fixed
- none needed: no finding passed all three tests. The pass covered every trigger path that enters turn prep on a Cloud home (ordinary, Auto, explicit Cloud, routine via `startTurn` at `index.ts:20119` → `startTurnAdmitting`). For each, the only relay binding and relay mount sites stay behind `wants` cloud/undefined (`:17743`), which §4.1 forces to `"off"` first (`:17618-17624`). Restart: both maps are in memory (`:12805`, `:41275`) and empty at boot. Upgrade from or rollback to v1.0.20: one optional boolean, which an older build ignores; rolling back restores the `:137` refusal (fail closed). Rejected: re-open the relay wait-and-retry (r1/r2) on dev/1022. It is still unreachable behind two unchanged barriers, so the r3 "Rejected" reasoning holds.

Parked
- P-1..P-6 and the OPEN NO-OWNER leg, as in §5 (one line each there).
