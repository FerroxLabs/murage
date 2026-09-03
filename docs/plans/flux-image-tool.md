# Image generation on the Flux key: spec

Status: SPEC, not built. Written 2026-09-03 against flux-router at ~/dev/flux.

## The problem this exists to avoid

`flux-image` is a BILLING TIER name, not a routable alias. Sent as a model it is
absent from `_IMAGE_ALIAS_TO_PROVIDER` (capability_image.py:89-111), so
`resolve_capability_provider` falls to the Standard canonical, which is always
Together FLUX.1-schnell, the cheapest arm. It returns 200 and warns nobody.
Wayland ships that id today and has been silently generating bottom-tier images
while believing the router picks a good arm per request.

Every decision below is downstream of one rule: **never send a name the router
might not resolve, and never accept a silent substitution.**

## D1. The model list is DISCOVERED, not hardcoded. Load bearing.

Two aliases the owner wants do not exist yet: `gpt-image-2` is being added now,
and `nano-banana-2` is to be the default. Hardcoding either means Murage ships
broken until Flux catches up, or worse, ships a name that silently degrades.

So Murage asks Flux what exists, at catalog-refresh time, on the user's own key.
`GET /v1/models` already exists and is authenticated.

**ACTION ON THE FLUX SIDE, and this is the cheap half of the whole feature:**
`/v1/models` must advertise the image aliases, with a capability marker and a
list price. Then `nano-banana-2` and `gpt-image-2` appear in Murage the moment
they ship, with no Murage release and no code change. Without it, every new arm
needs a Murage build, which is the treadmill this design exists to avoid.

Fallback when discovery fails (offline, older router, 401): a small static seed
of the aliases known good today, marked as a seed in the UI. Never a bare tier.

## D2. The default is a PREFERENCE that resolves, and never substitutes silently

Configured default: `nano-banana-2` per the owner.

It does not exist yet. So the default is stored as a preference and resolved
against the discovered list at use time:
- available    -> use it
- unavailable  -> use the declared next-best AND say so in Settings, naming both
                  what was asked for and what is being used

Silent substitution is the `flux-image` bug wearing a different hat. The user
must be able to see that their chosen model is not the one running.

Declared order when the preference is unavailable, best quality first:
`nano-banana-2`, `gpt-image-2`, `nano-banana-pro-2k`, `gpt-image-high`,
`nano-banana`, `gpt-image-med`, `together-flux`. Revisit when 2-series lands.

## D3. Explicit aliases only, always

The tool resolves to a concrete `flux-image-*` alias before dispatch. A tier
name is never sent. A named alias with no live priced arm makes the router
answer 400, which is the fail-loud behaviour we want, so 400 must NOT be in any
fallback set.

## D4. A tool on the existing integration surface, not an MCP server per engine

Composio already established the pattern: three meta-tools on one connection,
mounted per bot, gated on `adapter.capabilities.composioMcp === true`. A second
install mechanism means two auth paths, two lifecycles, N extra processes and
two things that break separately.

`generate_image(prompt, model?, size?, n?)`. Mounts where Composio mounts.
Ceiling is the same as Composio's: MCP-capable engines only. Say so plainly
rather than promising "every agent".

`size` is a per-call passthrough (`images_route.py:146`), so social formats work:
square, portrait, story, banner, subject to the provider accepting them.

## D5. Cost is visible in Settings, per model, before choosing

From `config/capability-pricing.yaml`, list price per image:

  together-flux        cheapest tier
  gpt-image-med        $0.05
  nano-banana          $0.06
  gpt-image-high       $0.20
  nano-banana-pro-2k   $0.20
  gpt-image-high-xl    $0.30
  nano-banana-pro-4k   $0.36
  gpt-image-2          TBD, arm being added
  nano-banana-2        TBD, arm being added

Prices come from discovery where D1 lands, from this table until then. A price
shown from the static seed is labelled as such: a stale price is worse than no
price.

## D6. A spend guard, and build it now rather than after a surprising bill

Avatars are one-off per bot. A social-media agent generating variants in a loop
at $0.36 an image is a different risk class. Minimum: a per-turn image cap, and
the resolved arm plus price recorded per call so spend is attributable after the
fact. Wayland recorded a bare model id and permanently lost the ability to
attribute usage, which forced it to degrade a shipped feature. Record
`(alias, arm, price)`, not just the name.

## D7. Entitlement is a first-class state, not an error string

Flux image is paid-and-cleared only: a free or uncleared account gets 402
`premium_locked`. That is not a failure of the key, and the UI must not tell
someone their key is wrong when their plan is the issue. Carry it as a reason
value, the way `server/voice/flux-voice.ts` carries `premium`.

## What is NOT in scope

Model management UI, per-bot image model overrides, cost dashboards, budgets,
automatic cost optimisation, streaming. All deferred deliberately.
