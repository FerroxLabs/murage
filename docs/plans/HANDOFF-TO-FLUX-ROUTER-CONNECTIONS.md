# Handoff: Flux Connections — front Composio's broker on the Flux key

From: Murage (Ferrox Labs desktop app)
To:   flux-router
Date: 2026-09-04
Repo: ~/dev/flux-router

One request, and a status correction on a previous one. Everything below was
read out of the Murage repository with file and line cited, so you can check the
reading before acting on it.

---

## STATUS CORRECTION on the previous handoff, so nobody builds on a stale note

`GET /v1/models` was probed live on 2026-09-03 with a real key. It returns 105
rows whose keys are exactly:

    created, id, max_input_tokens, max_output_tokens, object, owned_by

No `capability`, no `display_name`, no `list_price_microcents`, no
`entitlement`. Request 1 of the previous handoff reads as "built, route wiring
left" on your side and that is still where it is. Murage's image tool remains
blocked on it and has NOT been built against a guess.

Two smaller things from the same probe:

- **`flux-image-together-flux` is still advertised in `/v1/models`.** Your own
  correction said Together retired FLUX.1-schnell and that arm has been failing
  since 2026-07-17. A dead arm in the discovery response is worse than a dead
  arm alone, because the discovery-driven picker Request 1 enables would list it
  on your authority. Not probeable from here (see next point), so this is
  "advertised", not "confirmed still broken".
- **Image generation answers `402 premium_locked`** on the workspace key Murage
  develops against: `{"error":{"message":"image generation requires a paid
  plan","code":"premium_locked"}}`. That is correct behaviour and it is useful
  to know it is reachable — but it means Murage cannot smoke-test any image arm
  end to end until that account is on a paid plan.

---

## THE REQUEST — expose the connector broker as a Flux surface

### What Murage needs

An endpoint Flux owns that fronts Composio's API, authenticated with the
customer's Flux key, metered and billed the way every other Flux capability is.
Murage points one environment variable at it and nothing else changes.

### Why this is small on Murage's side, and why that is the point

`activeBroker()` (`server/composio.ts:195`) is already the single choke point,
and `brokerRequest` takes `cfg` and resolves through it rather than reading the
broker itself, **so no caller can route around it**. It resolves a URL and a
token from `MURAGE_COMPOSIO_BROKER_URL` / `MURAGE_COMPOSIO_BROKER_TOKEN`
(`server/composio.ts:190-193`), and a user's own pasted Composio key already
wins over the broker entirely (`:220`).

So on Murage's side this is configuration, not a rebuild. That is deliberate:
the choke point was built this way so the broker behind it could change without
touching a single caller.

### Why it belongs at Flux rather than staying where it is

The managed broker is **already the default for every user who configures
nothing**, which the code says in its own words at `server/composio.ts:203`:

> The managed broker remains the default for everyone who configures nothing,
> which is nearly everyone.

That traffic currently runs on a Ferrox account with no per-customer metering,
no entitlement check and no billing path. Flux already has all three. Moving it
does not add a capability, it puts an existing one on the rails the rest of the
product already runs on.

### The one piece of real work: the OAuth callback

**The OAuth callback flow is stateful and will not survive a naive
pass-through.** Composio's connect flow redirects the end user to the provider,
and the provider redirects back to a callback URL that must reach the same
Composio project that initiated it, carrying state that ties the callback to
the pending connection request. A proxy that forwards requests but does not
preserve that binding will complete the browser flow and then fail to attach
the connection, which presents to the user as "I authorised Gmail and nothing
happened" — the worst possible failure for this feature.

Scope that before calling this cheap. Everything else is a forwarded HTTP call.

### What Murage will do with per-user identity — you need this to meter it

Composio's API is keyed on an end-user id, and Murage already mints one per
person rather than sharing a single identity:

- `server/composio.ts:520` — `const userId = priorUserId ?? \`murage_${randomUUID()}\``
- `:510`/`:517` — read back off the session as `config.user_id` and carried
  forward, so a returning user keeps their identity
- `:809`/`:831` — every session resolves `session.config?.user_id`
- `:816` — `listConnectedAccounts(apiKey, userId, [])` is scoped to it

That id is stable per Murage user, so it is available to hang metering off if
you want per-seat accounting rather than per-key.

### Explicitly NOT the request

**Do not reimplement Composio inside Flux.** OAuth lifecycle across 250+ apps is
a product with a permanent maintenance treadmill, not a routing layer. Flux
fronts Composio; Flux does not become it. If the shape of this request ever
starts to look like the latter, the answer is to stop rather than to continue.

---

## What Murage needs back, concretely

1. A base URL and a token format for `MURAGE_COMPOSIO_BROKER_URL` /
   `MURAGE_COMPOSIO_BROKER_TOKEN`. Note Murage validates the token against a
   `managedBrokerToken` regex (`server/composio.ts:181`) and throws "The
   connected-apps service token is invalid" on a mismatch, so tell us the shape
   before we point at it.
2. A statement on how the OAuth callback is handled, since that is the half
   that can silently half-work.
3. Whether entitlement failures arrive as `402 premium_locked` like the rest of
   the surface, so Murage can reuse the vocabulary it already has rather than
   inventing a second one for connectors.

The previous handoff got three of four items resolved without debate because it
cited file:line rather than describing a wish. Same intent here.
