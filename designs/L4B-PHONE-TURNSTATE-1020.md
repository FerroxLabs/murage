# L4B-PHONE-TURNSTATE (1.0.20): a paired phone reads its help question's turn state

Source: Astra r4 Medium on UX-L4B server (FIX-LEDGER 11-04, follow-up). Base cdba56677.

## Current path (why a paired phone gets 403)
- Harness route `GET /api/bots/:id/turn-state` (server/index.ts:29505-29517) refuses unless `mayApprove(req, url)`
  (server/index.ts:21830-21832): the desktop surface, or `ownerActs(headers)` (server/companion-authority.ts:33-35), which off a
  Cloud home is a timing-safe match of `x-murage-companion-token` against this launch's secret.
- Both companion doors allow the path (companion/src/routes.ts:315 device list, :573 browser list), so the request is forwarded,
  but neither door adds the launch proof: `launchProofHeaders` (routes.ts:174-180) adds it only for OWNER_VOICE_ROUTES
  (routes.ts:116-121) and OWNER_DECISION_ROUTES (routes.ts:134-167); `deviceProofHeaders` (routes.ts:250-255) adds DEVICE_OWNER_READS;
  `browserProofHeaders` (routes.ts:241-246) adds OWNER_BROWSER_ONLY_ROUTES. turn-state is in none, so it arrives with only
  `x-murage-door-token` (not owner proof, routes.ts:198-207) and the harness answers 403 TURN_STATE_NEEDS_OWNER.
- Client (src/components/help/HelpAsk.tsx:151-160, designs/UX-L4B-CLIENT-TURNSTATE-1019.md line 45) reads 403 as `unknown`:
  never Done, "Open in chat" at 10 min.

## Chosen proof mechanism (no new trust path)
Add one line to OWNER_DECISION_ROUTES: `{ method: "GET", path: /^\/api\/bots\/[\w-]+\/turn-state$/ }`. That is the existing list
both doors already use to vouch for owner-only harness routes (terms accept, task-allow Undo/Clear, routine run, project reads).
The value forwarded is the door's own launch secret, never the client's (`forwardHeaders` is an allowlist); the harness check stays
`mayApprove` unchanged. Every caller that will now pass `mayApprove` on turn-state already passes it on `POST .../respond` (card
yes, OWNER_VOICE_ROUTES), a strictly stronger power, through the same door and the same header. Both doors: the browser door's help
panel has the same 403, and its signed-in owner session already gets this proof for card answers and terms. GET only; no other
method or path is added. No harness change.

## What still gets 403 / never a state
- An unpaired, revoked or signed-out device: refused at the door before forwarding (denyReason `!authenticated` -> 401,
  routes.ts:763-770; a revoked device fails `authenticate`), so the harness never sees it.
- A door started without a usable launch secret: no proof header -> harness 403 (unchanged).
- A bare loopback caller (a script, a bot's shell under Full access): no proof -> route gate 404 or mayApprove 403 (unchanged).
- Hidden bots: the route gate answers a non-desktop caller like an unknown bot (server/route-policy.ts:393 conversationSubject).
- Another bot's thread: `requestedDirectBot` (server/index.ts:2804-2808) 404s a threadId that is not this bot's; a send row is used
  only when `found.kind === "bot" && found.ownerId === botId` (index.ts:15237-15238); the reply is `{state, endedAt?}` only, never a
  turn id or text. The 403-as-unknown client rule stays as it is.

## Tests (fail on base, pass on head)
1. companion/test/turn-state-door.test.ts: through BOTH doors against a stand-in harness that answers like index.ts (200 with a real
   state only beside the launch proof, else 403): a paired device / signed-in browser gets `{state:"running"}` (base: 403); the query
   string reaches the harness unchanged; no launch secret -> 403; an unknown or revoked bearer / no session -> 401 and the harness is
   never called; POST to the same path gets no proof; `deviceProofHeaders`/`browserProofHeaders`/`launchProofHeaders` add proof for
   GET turn-state only.
2. server/turn-state-phone-proof.test.ts (verification server, launch secret set like sidebar-order-api.test.ts): with the phone's
   proof the route answers 200 `{state:"unknown"}` for an unknown send (not 403); door token only -> 403; no proof -> 403/404; bot B
   with bot A's threadId -> 404 (no state); body keys are a subset of {state, endedAt}.
Both registered in ci/gate-tests.txt.

## Reviews (design ac826d4d0)
Astra AGREE, GrokBuild AGREE, no Critical/High. Taken in: a door with no launch secret sends no door token either, so the harness
gate answers 404 (not 403): tests accept 403 or 404. Astra M1: the real queued/running/ended states through the phone proof, a
hidden bot and a cross-bot send are now checked in server/ux-l4b-isolation-api.test.ts and server/turn-state-phone-proof.test.ts.
