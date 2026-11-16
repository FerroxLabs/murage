# Seat 1a: OAuth token adapter

Base: `5daadeac8ebbdc4100d9b9f2805c5e4135262c5a`. Source-only, no deployment.

`src/oauth.ts` exports `exchangeOAuth(config: OAuthConfig, grant: OAuthGrant,
options: OAuthOptions): Promise<OAuthResult>`. Code callers pass `{kind: "code",
code}`; private broker refresh callers pass `{kind: "refresh", refreshToken}`.
`options.fetch` is explicit; it must be the provider transport at integration.
`now` and a shorter `timeoutMs` support isolated fakes. Ten seconds is the
maximum combined request/body deadline; 64 KiB is the token response ceiling.
There is one physical exchange, with no automatic retry.

Success returns broker-private `OAuthCredentials`: accessToken, refreshToken,
expiresAt (Unix ms), locationId, optional companyId represented as null, userId,
immutable sorted actual scopes and scopeProvenance `oauth-token-response`.
These are not home lease payloads. Flow/grant owners must seal them before
persistence and project access-only leases. No caller may return the credential
object through a runtime/browser route. Errors contain only a fixed machine code:
`invalid_request`, `exchange_failed` or `reconnect_required`.

The published token schema is pinned to 2021-07-28:
https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/oauth/get-access-token/index.html
No token Version header is invented. CRM endpoint headers are unchanged.
The broker independently checks provider scopes against the qualified
`HIGHLEVEL_CRM_SCOPES` export, excluding `none` and `oauth.*`. Requested scopes,
PIT claims and previous broader scopes never substitute for actual response
scope. Missing/malformed scope on refresh requires reconnect.

The fixed token URL and form encoding, Location role, Bearer token type,
nonempty bounded tokens/identity and positive bounded lifetime are required.
The redirect currently admits only `https://connect.murage.ai/v1/crm/callback`,
the production origin named by the design. S0/MAIN must freeze the staging
origin and enrollment/storage contract before flow/grant integration. No
staging alias or endpoint override is guessed. Shared contracts, route index,
config and migration manifests remain S0/S-INT-owned.

Upstream references: `/work/fuigo-builds/orph/_ev/refs/upstream-openmaus-highlevel/`
`highlevel.ts` and `highlevel.test.ts`; exchange/form, timeout, fake rotation and
redaction cases adapted with tighter scope/location validation and custody.
Existing root NOTICE retains OpenMausBot Apache-2.0 attribution.

Owner-facing locale inventory: none in seat 1a. Error values are machine codes;
S-INT/Settings supplies localized reconnect copy. No server, owner flow,
production configuration or release completion is claimed by these unit tests.

Verification: `evidence/hl-c1-broker/it.sh`, network-none containers, sequential.
RED used a total-function adapter scaffold returning exchange_failed, so the
new behavior assertions failed without import/compiler errors. GREEN exercises
real parsing/form code with fake transport. Mutants restore the source after
each run; compiler/import failures do not count as kills.

Final evidence: `seat-1a-verification.json` records source/log hashes and exact
container commands. RED: 22 assertion failures / 23 cases. Final GREEN: 26/26;
three assertion-killed mutants; standalone broker and all three repository
typechecks pass. Run the portable mutant driver with
`node cloudflare/crm-broker/test/oauth-mutants.mjs` from the repository root.
Leak guard v2 reports zero added matches. Its whole-tree exit 1 has 582 inherited
matches outside this diff; this seat does not claim a whole-tree leak pass.

Seats 1b and 1c remain pending. The S0 draft at the time of this handoff is
uncommitted, and MAIN has not supplied the required enrollment/storage ruling.
The design explicitly gates flow on frozen enrollment and grants on the named
runtime-principal/storage contract. No provisional security/storage contract
has been substituted. The RED scaffold, implementation and GREEN handoff are
three ordered commits on the broker branch.

2026-11-11 continuation: seats 1b/1c have consumed frozen S0 d82ca6ffe5 and
MAIN's runtime-principal/storage contract. See FLOW-GRANT-HANDOFF.md and the
seat-1b/seat-1c evidence manifests for the newer payloads, mandatory shared
transaction authority and integration prerequisites. The old pending-seat
statements above describe seat 1a's historical handoff only. oauth.ts now permits
an explicitly configured HTTPS stagingOrigin callback as well as production;
unknown origins, paths, queries and non-HTTPS staging remain refused.
