# O12 Cloud relay seal residual: CAUSE (relayseal-1021-wf1121, 2026-11-20)

Owners: relayseal-1021-wf1121 owns this analysis (read-only for product code). The hub server lane MAIN seats for 1.0.21 owns the
fix in `server/cloud-home/vps-mcp-relay.ts`, the Cloud-home server end of the VPS relay. revkill-1020 owns the parts the fix reuses
unchanged: `deferringPendingFence`, `waitPending`/`awaitExactPendingCheck`, ingress `deliver`/`drop`. MAIN owns the Layer-0 ruling
below. MurageCloud owns no code here (see HANDOFF-MURAGECLOUD.md: for information only).

Base: hub `dev/1021` ce13438869baecb709e495f572bff879c940e740 (`dev/1019-int-train5` is an ancestor). All line numbers below are at that sha.

## 1. The residual, named exactly
This is revkill-1020-n2 Fable residual **(b) CLOUD** (int-1020q-late-n4/QUESTIONS-FOR-MAIN.md:1109). The same residual appears as
revkill2-1020-n2 "Cloud relay seal out of scope (1.0.21)" (:1150) and revkill-n2's FOLLOW-UP (:1108).

On a Cloud home, an engine call to the own-server (VPS) computer, or the VPS reply to it, can meet held context that is still
`checking:pending`. That is a revoke walk not yet finished, not a proven revoke. The Cloud relay treats it as a refusal. The turn
gets a ledger refusal (`checking:not-built`), the relay socket closes 1008 with "I stopped this turn because some of its context is
no longer available.", and the docker child is killed. On the desktop, revkill-n2 (request) and revkill2-n2 (reply) made the same
event wait and retry.

**Correction for the record:** revkill-n2's FOLLOW-UP (:1108) says "fails closed, no turn refusal". That is wrong. Fable's (b) is
right: the turn IS refused. Witness W1 on base shows `refusals` = 1 (red.log: "expected 1 to be +0").

## 2. Which side owns it
It is the **Cloud-home server end** (`server/cloud-home/vps-mcp-relay.ts`). That code is in the hub repo and builds into the Murage
server that a Cloud home runs. The turn-side client `server/cloud-home/vps-relay-mcp.ts` is not at fault: it only pipes lines over
the WebSocket. Nothing in MurageCloud's own trees (control plane, site) is involved. So the fix lands in the hub through a desktop or
hub lane, not through MurageCloud.

## 3. Cause, file:line (dev/1021 ce13438869)
Request leg (engine -> VPS):
1. `vps-mcp-relay.ts:161`: `fence.request(text, ...)` calls `consuming-turn-ingress.ts:95-120` `request`. That call runs
   `emitConsumingTurnResponse` under `deferringPendingFence` (:114).
2. `consuming-turn-response.ts:180-181`: `proposeTurnParents(turn, [])` still proposes the HELD parents as prospective refs
   (`lineage-write.ts:750`). `send-fence.ts:136` (A-5 owner continuation) is therefore skipped. Under the deferral counter,
   `send-fence.ts:140` throws `MEMORY_CONTEXT_PENDING` and nothing is refused yet. The ingress passes it through unsealed
   (`consuming-turn-ingress.ts:67`, `:118`).
3. **`vps-mcp-relay.ts:162`**: `catch { end(); }` is generic and has no `isPendingFenceDeferral` branch.
4. `vps-mcp-relay.ts:129`: `end()` calls `fence.lost()` then `admission.downstream.seal()`. `fence.lost` (:68) is `ingress.seal()`,
   whose default is `memoryRefusal = true` (`consuming-turn-ingress.ts:52-59`). That calls
   `binding.onLedgerRefused({ state: "checking", reason: "not-built" })`, so **the turn is refused**. The real verdict was
   checking:pending, so the refusal also carries the wrong cause. Then :134 runs `ws.close(1008, LEDGER_REFUSAL_LINE)`.

Reply leg (VPS -> engine):
1. `vps-mcp-relay.ts:148` -> :64-67 `fence.response`: `ingress.issue` (`consuming-turn-ingress.ts:144-145`, check-only fence with the
   held parents as prospective) then `ingress.deliver`. Neither runs under `deferringPendingFence`. With no hook, `send-fence.ts:141`
   calls `retainedRefusal` -> `refuseRetainedTurn`, so **the turn is refused directly**. Then `vps-mcp-relay.ts:149` `catch { end(); }`
   seals as above.
2. Owner turns are not spared on either leg. The prospective proposal (step 2 of the request leg) skips the A-5 continuation.

### Layer 0: why this is LATENT on dev/1021 today (MAIN to rule; not part of this fix)
The pending path above cannot run in production at this sha, for two independent reasons:
- `server/index.ts:17363-17371`: a Cloud home mounts the own-server computer as `integrations.localComputer = vpsRelayMcp`.
  `drivers/mcp-mounts.ts:26-35` then turns it into `servers.computer`, and `cli-mount-relay.ts:280` `allocateMounts` calls
  `mountAdmission.mount`. **`drivers/mcp-mounts.ts:137`** runs `refuseEngineOwnTurn` for role `vpsRelayMcp` (ENGINE_OWN_REFUSAL).
  So on dev/1021, a Cloud-home bot with an own-server computer has **every turn refused at mount admission**, before the engine
  starts (by reading; not run). The engine-own refusal makes a rebuilt turn end at once.
- `server/index.ts:40743-40749`: production `admit` always returns `undefined` **and** calls
  `binding.onLedgerRefused(checking:not-built)`. That is a second refusal for any socket that still connects.

Both have been deliberate since 5be0eafbea (2026-11-10: "The nested external VPS wrapper currently cannot preserve the final supervisor
channel. Its mount is disabled"). The VPS computer on a Cloud home therefore fails closed for the WHOLE turn. It does not drop just the
mount, so it does not meet the 1.0.20 "no mount failure seals an owner turn" bar (mcpdegrade ruling). This is a separate question:
**FABLE-DESIGN / MAIN: should a disabled Cloud VPS mount be left out of the mount set with a one-line notice, instead of refusing the
turn?** The pending fix below matters the moment `admit` is wired for real. It should land first, or with that wiring, so the
wiring does not reintroduce the pre-revkill routine kill on Cloud.

## 4. Minimal fix (one file, server/cloud-home/vps-mcp-relay.ts; patch: designs/1021-relayseal/FIX-vps-mcp-relay.patch, +57/-6)
This mirrors the desktop RelayedMount (`cli-mount-relay.ts:115-200`) and reuses the revkill primitives. No fence, ledger or ingress
change.
- **Request leg:** the ws message handler calls `forward(text)`. When `fence.request` throws `isPendingFenceDeferral`, it does NOT
  call `end()`. That call waits on `fence.ingress.waitPending(error, () => ended)` (65 s bound). Later calls queue in order behind
  it (cap 256; overflow -> `end()`). Then it is offered once more through the full fence. A proven revoke refuses as before. Still
  pending -> only that call gets the fixed content-free JSON-RPC `-32000` error, and the socket and turn stay open.
- **Reply leg:** `fence.response` runs `issue` and `deliver` under `deferringPendingFence`. The sequence advances only when a permit
  is issued (`sequence + 1`, not `++sequence`); otherwise a deferred issue would fail the `sequence === issued + 1` check on retry
  and seal. A deferred deliver keeps its envelope for the one retry (revkill2 permit hold). `release(line)` holds that reply and
  later child lines in order (cap 256), waits, and retries once. Still pending -> `fence.drop()` (the permit is voided, nothing is
  released) and the call gets the `-32000` error.
- Every other error still calls `end()` exactly as before. Nothing unchecked is ever written to the WebSocket or the child: both
  writes stay inside the fence callbacks. The only bytes written outside them are the fixed error frame.

## 5. Witnesses (designs/1021-relayseal/vps-mcp-relay-pending-1021.test.ts.txt -> server/cloud-home/vps-mcp-relay-pending-1021.test.ts)
They use the real fence, deny reader, retained ledger, ingress and WebSocket upgrade (`createVpsMcpRelay` behind a loopback HTTP
server). Only the docker child is a stand-in. The turn is a routine (non-owner) `consumingFixture` with held line X, and
`f.f.job(1,50).pending("T",1)` opens a real pending window. Runs were remote (it-remote, `--network none`), vitest 4.1.12.

| id | what | base ce13438869 | fix | mutant |
|---|---|---|---|---|
| W1 | request leg: call meets checking:pending -> waits, reaches the VPS, refusals 0, socket open, reply delivered | **RED** (red.log: refusals 1; red2.log: not forwarded) | GREEN | M1 (request deferral branch -> `end()`): **RED** |
| W2 | reply leg: reply meets checking:pending -> held, delivered, refusals 0, socket open | **RED** (refusals 1 / not delivered) | GREEN | M2 (reply deferral branch -> `end()`): **RED** |
| G1 | proven revoke inside the pending window -> refusals 1, close 1008, call not forwarded | GREEN | GREEN | GREEN |
| G2 | reply after a proven revoke -> never released, refusals 1 | GREEN | GREEN | GREEN |

Existing suites on the fix: `vps-mcp-relay.test.ts` 17/17 and `vps-mcp-release.test.ts` 11/11 pass, so 32/32 in total. That
includes "kills and seals on socket/child closure", spawn failure, flip between frames, and stale generation.
Not run by this lane (the fix lane owes these): full typecheck, a paired cloud-home + consuming shard vs dev/1021, and listing the
test in ci/gate-tests.txt. The witness is kept as `.test.ts.txt` on this design branch so that it cannot turn CI red before the fix.

## 6. Open, not in the minimal fix
- O-a: `end()` on a plain transport loss (socket close, child exit) still records a **ledger** refusal (`ingress.seal()` with
  `memoryRefusal = true`) with cause `checking:not-built`. Existing tests pin that (`refusals` = 1). The desktop analogue
  (mcpdegrade-n2) turned native transport loss into `seal(false)`. Whether the Cloud relay should match is a MAIN ruling, because it
  changes the asserted fail-closed contract.
- O-b: 256-frame overflow while waiting ends the relay (fail-closed, same as desktop revkill2 Medium (b)).
- O-c: Layer 0 above (FABLE-DESIGN / MAIN).
