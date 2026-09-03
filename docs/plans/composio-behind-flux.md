# Composio behind Flux — the terms question, and why it is already live

Queue item 5. The handoff said this was "blocking, non-technical: read
Composio's ToS on proxying/reselling". I read it. The answer is not what the
question assumed, and the framing needs correcting before anyone builds.

## THE FINDING THAT CHANGES THE QUESTION

**Murage already serves many end users through one Composio account. Today. In
shipped code.**

`activeBroker()` (`server/composio.ts`, ~:195) is the single choke point, and
its own doc comment says so plainly:

> A workspace key WINS. Somebody who pasted their own Composio key did it on
> purpose... **The managed broker remains the default for everyone who
> configures nothing, which is nearly everyone.**

So the exposure is not something "rolling Composio into FluxRouter" would
create. It is the status quo. Pointing `MURAGE_COMPOSIO_BROKER_URL` at Flux
changes **who bills and meters the traffic**, not **whether one account fronts
many users**. That was always the actual terms question, and it is live right
now rather than pending a decision.

This makes the ToS read more urgent, not less — but it also means the Flux move
is not the thing gated on it. Two separable decisions:

1. *May one Ferrox Composio account front many end users at all?* — **live
   today, unresolved, applies to the shipped product.**
2. *Should the broker sit behind Flux so it inherits Flux's billing,
   entitlement and metering?* — cheap, config not code, and strictly an
   improvement on the status quo regardless of how (1) lands.

## THE TERMS QUESTION IS SETTLED — multi-tenancy IS the product

Sean's call, 2026-09-03: Composio's own backend is built end to end around
building an app for yourself, for others, and for your users. Serving your own
end users is the modelled use case, not a grey area at its edge.

**Our own integration corroborates it, which is the part worth writing down.**
Composio's API is keyed on an end-user id, and `server/composio.ts` already
uses it exactly that way:

- `:520` — `const userId = priorUserId ?? \`murage_${randomUUID()}\`` — Murage
  mints a distinct Composio user id **per person**.
- `:510`/`:517` — it is read back off the session as `config.user_id` and
  carried forward, so a returning user keeps their identity.
- `:809`/`:831` — every session resolves `session.config?.user_id`, and
  `:816` scopes `listConnectedAccounts(apiKey, userId, [])` to it.

An API whose primary key is "which of *your* users is this" is an API designed
to be fronted for many users on one account. That is a stronger and more
durable signal than any sentence on a marketing terms page, because it is what
the service is built to do.

So item (1) above is **CLEARED**, and item (2) — putting the broker behind
Flux so it inherits Flux's billing, entitlement and metering — is a plain
engineering task with no legal gate in front of it.

### What the public page said, kept only as a footnote

`https://composio.dev/terms`, read 2026-09-03. Section 4 "Restrictions on Use"
restricts none of this — no clause on reselling, sublicensing, third-party
access, service-bureau use, multi-tenancy, white-labelling, credential sharing
or competing services. Just the ordinary list: breaking the law, harming
minors, spam, impersonation, conduct that restricts others' use.

Section 3 read two contradictory ways across two automated passes and the Fair
Usage Policy it references carries no URL. Recorded so nobody re-runs the same
dead end: **the page is not the authority here, the product model is.**

## THE ENGINEERING, IF AND WHEN IT IS CLEARED

Unchanged from the handoff and still correct:

- **Do NOT reimplement Composio inside Flux.** OAuth lifecycle across 250+ apps
  is a product with a permanent maintenance treadmill, not a routing layer.
- The broker swap is config: `activeBroker()` already resolves a URL + token in
  one place and `brokerRequest` routes through it, so no caller can go around
  it. Flux already has entitlement, pricing and metering.
- **The OAuth callback flow is stateful and will not survive a naive proxy.**
  That is the one piece of real work, and it should be scoped before anyone
  calls this cheap.

## NEXT ACTION — Flux-side, not Murage-side

No legal gate remains. The Murage half is genuinely config: `activeBroker()` is
already the one choke point and a workspace key already wins over it, so
pointing `MURAGE_COMPOSIO_BROKER_URL` and `MURAGE_COMPOSIO_BROKER_TOKEN` at
Flux needs no new code here.

The work that is left is Flux's, and it is one thing, not a rewrite:

**Flux exposes the broker surface, and the OAuth callback survives it.** Flux
proxies the connector calls it already knows how to meter, and it must carry
the OAuth callback statefully — the callback is the piece that will not survive
a naive pass-through, and it is the whole of the real difficulty. Everything
else Flux already has: entitlement, pricing, metering, per-key accounting.

Ferrox owns both sides, so this is a scheduling question rather than a
negotiation. It should go over as a written request in the same shape as
`HANDOFF-TO-FLUX-ROUTER.md`, which got three of four items resolved without
debate by citing file:line rather than describing a wish.

Still true and still worth repeating: **do NOT reimplement Composio inside
Flux.** OAuth lifecycle across 250+ apps is a product with a permanent
maintenance treadmill. Flux fronts it; Flux does not become it.
