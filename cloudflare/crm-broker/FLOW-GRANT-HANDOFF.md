# HighLevel broker seats 1a/1b/1c integration contract

Base: `5daadeac8ebbdc4100d9b9f2805c5e4135262c5a`. Frozen S0 merged at
`e661efe6f9`; `src/contracts.ts` remains byte-identical to `d82ca6ffe5`.
Accepted authority: MAIN runtime-principal/storage r1 plus the Astra-AGREED
`HL-C1-CONTRACT-r2-DELTA.md`. The three daemon review-fix commits are retained.
This document supersedes the earlier global-authority and handler instructions.

The seat-owned contracts are now:

```ts
// runtime-auth.ts
interface VerifiedRuntimeRequest {
  readonly binding: RuntimeBinding;
  readonly body: Uint8Array; // exactly the bytes authenticated by the HMAC
}
interface RequestRuntimeVerifier extends RuntimeRequestVerifier {
  verifyRequest(request: Request, route: BrokerRoute): Promise<VerifiedRuntimeRequest | null>;
}
// grant.ts
interface GrantRouteDeps {
  grants: GrantStore; verifier: RequestRuntimeVerifier;
  origin: string; stagingOrigin?: string;
}
function leaseRoute(req: Request, d: GrantRouteDeps): Promise<Response>;
function disconnectRoute(req: Request, d: GrantRouteDeps): Promise<Response>;
// route.ts
function homeRouteTag(master: Uint8Array, homeId: string): Promise<string>;
function routeHomeId(req: Request): Promise<string | null>;
function callbackRouteTag(state: string): string | null;
function homeAuthority(storage: BrokerStorage, deps: GrantDeps): HomeAuthority;
// flow.ts: additive FlowDeps inputs
// verifier: RequestRuntimeVerifier; routeMaster: Uint8Array (32-byte master)
// ipAdmission?(ipHash: string, now: number): Promise<boolean>
// locationFetch?: typeof fetch (defaults to Worker fetch)
// FlowStore.admit(rec, now) retains only home generation/open-flow admission.
```

S-INT assembly requirements:

1. Use **one DO per home, never global and never per grant**. Resolve the
   unauthenticated home locator with `routeHomeId`, derive its DO name using
   `homeRouteTag(master, homeId)`, and route callbacks using `callbackRouteTag`.
   State is base64url of the opaque 16-byte HMAC tag plus 32 random bytes (64
   characters). The full state derives the lookup key. Routing grants no authority;
   all runtime/binding/capability checks execute inside the chosen DO. An altered
   tag reaches a storage where the lookup misses. No home ID is exposed in state.
2. Dispatch `beginFlow`, `callbackFlow`, `previewFlow`, `completeFlow`, `leaseRoute`
   and `disconnectRoute`. Signed handlers consume `verified.body` without a second
   request read. Legacy `verify(envelope, route)` always fails closed. Grant routes
   compare all four binding IDs before store access, require a 43-character
   base64url grant capability, and map closed codes to 400/401/404/409/410/429/503.
   Every response has no-store and no-referrer headers. S-INT only dispatches.
3. Supply fixed clientId, origin, optional exact HTTPS staging origin, master
   sealer, raw 32-byte routeMaster, random backed by crypto.getRandomValues, and
   bounded exchangeOAuth closure. Production
   redirect is `https://connect.murage.ai/v1/crm/callback`. No request-derived
   origins or Company/Cloud enrollment. Desktop IDs must be canonical and owner
   must be `owner`. Runtime key material and refresh tokens stay at the broker.
4. Build `homeAuthority(storage, deps)` **once in the per-home DO constructor**
   and reuse its flows/enrollments/grants/verifier on every fetch. It caches by
   stable storage object, preserving the serial lease chain across provider await.
   Every store shares this same home transaction authority. Durable refresh intent
   prevents resending an uncertain refresh after restart. Schedule both grant
   `alarm` and `sweepFlowStore` repeatedly; their fixed-size pages and durable
   indexes resume cleanup. Home generations invalidate old flows/grants immediately.
5. Back mandatory unsigned `ipAdmission` with a separate tiny global admission DO:
   only `ip:<hash>:<hour>` counters, 60/hour, hourly sweep, no secrets or home
   authority. Missing/throwing/false hook returns 429; authenticated begin bypasses
   it. The home store enforces at most three open flows per principal. Preview
   admits at most one per second per flow. Namespace/config/deployment are S-INT.
6. Home source commits bank and matching metadata before first lease (the ack).
   Re-check connection ID, epoch and credentialVersion before every use and after
   waits. Pending replacement preserves the active grant until its first lease;
   acknowledgement atomically retires the old grant. Disconnect erases enrollment,
   active/pending credentials and flow custody, advances generation and epoch, and
   fences late completion/refresh. Pending ack expires in 30 min; idle in 30 days;
   access lease lasts at most 5 min and ends before provider expiry minus 60 sec.
7. Register `test/*.test.ts` and `test/*.test.mjs` with native Node TS stripping.
   Run oauth/flow/grant/review/r2 mutant drivers serially, requiring AssertionError
   and exact source restoration. Never run mutants alongside a baseline test.
8. C1-source owns **T-OWNER-ROUTE**, **R4**, **R5/T-HOME-RECONCILE**. Prove actual
   bot/non-owner connect/confirm and phone escalation refusal in an isolated home
   fixture. On new-enrollment 409 conflict discard the candidate enrollment ID and
   mint another. On bank/metadata mismatch the bank is truth: one signed lease
   with its grant ID/capability, then stage+commit returned metadata; on refusal
   commit connection:null and show “HighLevel needs reconnecting.” Home ownership
   is outside seats 1a/1b/1c; these are required integration gates, not passes here.

Callback custody and copy (R2/L2):
- Begin generates a per-flow P-256 recipient; its private key is capability-sealed,
  while callback only needs the public key to encrypt. Provider state is never a
  claim capability. Preview opens this held blob through the capability and
  projects flowPreviewSchema; no name, scopes or plaintext heldPreview is stored.
- After a successful code exchange with locations.readonly, callback makes one
  GET to the fixed /locations/{locationId} endpoint, Version 2021-07-28, no retry,
  redirect:error, 10-second bound including response reads and a 64-KiB cap.
  The control-stripped 1–200-character name goes inside held custody. Any error,
  malformed/oversize response, missing scope or invalid name falls back to ID.
  locationFetch is an optional injected transport for fixtures; production uses
  fixed-origin Worker fetch. Expiry and home generation are checked again after
  this await. A late response cannot restore custody after disconnect/expiry.
- A crash after begun→called_back reservation but before held persistence leaves
  pending preview/flow_pending complete. The callback never exchanges again;
  expiry sweeps it. Location lookup cannot cause the code exchange to be retried.
- Unknown/expired callbacks return static HTML (404/410 respectively) with the
  inventoried “This link has expired. Go back to Murage and connect again.” copy.
  Ready/denied pages remain truthful; all three strings are in the locale inventory.

No entrypoint, wrangler config, migration, frozen-S0 hash or home files are edited
by this seat. S-INT records the explicit additive export/hash delta at integration
and publishes broker-locale-inventory.json. Sean owns separately authorized
Marketplace registration, namespace/secrets/DNS and deployment. No provisioned
resources, live accounts, billable I/O, Mac work or owner write proof is claimed.
Search remains locator-only; applied requires post-dispatch direct exact-ID/digest
proof. No recovery adapter is changed by these seats; F10's sole courses.import
unknown/no-resend exception remains with its assigned owners.

Round r2 evidence: `r2-verification.json` and regenerated seat-1b/1c manifests
record 95/95 tests, four green typechecks, 60 assertion-killed mutants, exact
source/log SHA256s, zero added leak-guard matches and cleanup. The isolated
Doctor fixture is startup smoke only. Prior seat and daemon RED evidence is
retained; no independent implementation-review PASS or owner workflow pass
is implied by the Astra contract AGREE.

Round r3 closes only review H1, H2 and M3. Begin now includes response_type=code;
the URL regression pins the endpoint and all five required parameters. Runtime
authentication samples time after body reading and signature verification. Its
single replay-marker transaction reads the marker, samples the current clock,
refuses an elapsed proposed deadline or live marker, then inserts the marker and
expiry index. Concurrent identical signed requests admit exactly one request.
The empty-body signature mutant runs only the valid-lease substitution route
regression and must produce 200 versus the expected 401 unauthorized.

Latest evidence: `r3-verification.json` supersedes source hashes affected by r3;
prior manifests remain historical. It records 101/101 tests, four green
typechecks, 63 assertion-killed mutants, the exact 60-second and >120-second
body-delay boundaries, expired replay deadlines, zero added leak-guard matches,
and isolated fake-engine Doctor smoke. Raw evidence remains under
`evidence/afix-hl-c1-broker-r3`. Frozen contracts and other-seat deferrals above
are unchanged. No additional owner-facing copy was introduced.
