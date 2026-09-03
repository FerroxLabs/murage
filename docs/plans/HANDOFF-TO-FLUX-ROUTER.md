# Handoff: what Murage needs from flux-router

From: Murage (Ferrox Labs desktop app)
To:   flux-router
Date: 2026-09-03
Repo: ~/dev/flux/flux-router

Murage is wiring image generation onto the customer's Flux key, exposed as a
tool every MCP-capable agent can call. Three requests below, in priority order.
Request 1 is the one that matters: without it every new image arm you ship
requires a Murage release, and with it none of them do.

Everything here was read out of this repository, with file and line cited, so
you can check my reading before acting on it.

---

## REQUEST 1 (highest value) — advertise image models on `GET /v1/models`

### What Murage needs

`GET /v1/models` should include the image aliases alongside the chat models,
each carrying enough information to render a picker and a price without a
second call.

Minimum per row:

    {
      "id": "flux-image-nano-banana-pro-4k",
      "object": "model",
      "capability": "image",          // <- the discriminator Murage filters on
      "display_name": "Nano Banana Pro 4K",
      "list_price_microcents": 360000, // <- per image, matching capability-pricing.yaml
      "entitlement": "paid_cleared"    // <- or "open"; see REQUEST 3
    }

`capability` is the load-bearing field. Murage cannot tell an image alias from a
chat model by name and must not guess from a prefix, because the prefix
convention is yours to change.

### Why this specifically

Two aliases Murage's own product decisions depend on do not exist yet:
`gpt-image-2` is being added as we speak, and `nano-banana-2` is intended as the
DEFAULT image model in Murage.

If Murage compiles a model list in, then on the day you ship either arm Murage
is either broken or wrong until we cut a release, and our default points at
something that does not resolve. If Murage discovers the list from you, both
appear the moment you ship, with no coordination and no Murage build.

This is the difference between a one-time integration and a permanent treadmill
between our two release cycles.

### What Murage does until this lands

Falls back to a static seed of the aliases known good today, and labels prices
shown from that seed as unverified in its own UI, because a stale price is worse
than no price. The seed will drift. That is the cost of not having this.

---

## REQUEST 2 — the two new arms, and their alias names

Murage's spec is written against these names. If you intend different ones, tell
us before you ship and we will follow yours; what matters is that they are
NAMED aliases in `_IMAGE_ALIAS_TO_PROVIDER` and not tier names.

- **`gpt-image-2`** — currently being added. `_OPENAI_IMAGE_MODEL` is pinned to
  `"gpt-image-1.5"` at `src/capability_image.py:71`, and `_GPT_IMAGE_ARMS`
  (`:78`) has med / high / high-xl. Murage's pre-Flux avatar path called
  `gpt-image-2` directly, so routing through Flux today is a QUALITY DOWNGRADE
  from 2 to 1.5. That is the reason this one matters to us.
- **`nano-banana-2`** — to be Murage's default image model.

Each needs the usual three: an entry in `_IMAGE_ALIAS_TO_PROVIDER`
(`src/capability_image.py:89-111`), an arm in the provider table, and a pricing
row in `config/capability-pricing.yaml` (the existing image rows are at :41-46).

Murage will send the `flux-image-*` namespaced form.

---

## REQUEST 3 — keep 402 distinguishable from 401

Already true today and we are relying on it, so this is a "please do not
regress" rather than a change.

`src/images_route.py:96-168` gates on `FLUX_CAP_IMAGE_ENABLED` and
`PLAN_BASED_ACCESS_ENABLED` (404 when off), then auth (401), then
`_capability_entitled("image_gen", ...)` (402 `premium_locked`).

Murage surfaces those as three different sentences, because "your key is wrong"
and "your plan does not include this" send a person to two different places. If
402 ever collapses into 401 we will tell paying customers their key is broken.

The `entitlement` field in REQUEST 1 lets Murage grey out an arm the account
cannot use BEFORE they pick it, rather than after a failed generation.

---

## BUG REPORT — `flux-image` silently serves the cheapest arm

Not a request, a defect, and it is live in another Ferrox product right now.

`flux-image` is a BILLING TIER name (`src/customer_pricing.py:117`,
`src/model_names.py:76`, consumed at `src/images_route.py:371`). It is NOT in
`_IMAGE_ALIAS_TO_PROVIDER` (`src/capability_image.py:89-111`).

So when a client sends `model: "flux-image"`:
`image_alias_to_arm` returns `None` -> `resolve_capability_provider` falls to
`IMAGE_CATEGORY_CANONICAL["Standard"]` = `together-flux`
(`src/capability_resolver.py:41`) -> FLUX.1-schnell, the cheapest arm.

**HTTP 200. No warning. No indication the caller did not get what they asked
for.**

Wayland sends exactly that id as its default image model
(`~/dev/wayland/app/src/.../imageModels.ts:121`) and has therefore been
generating bottom-tier images while its own comments say it expects Flux to pick
a strong arm per request.

Murage has worked around it by refusing to send tier names at all. Two options
on your side, either is fine and both beat the status quo:
1. reject a tier name with 400, the way a named-but-unpriced alias already
   fails, so it is loud; or
2. map the tiers to a defensible arm and document it, so it is at least honest.

The current behaviour is the worst of the three: it looks like it worked.

---

## Not asked for

Streaming image generation, per-request provider pinning beyond the existing
alias set, a `/v1/capabilities` endpoint (probed, 404, and REQUEST 1 makes it
unnecessary). TTS is separately noted as absent and Murage is not waiting on it:
ElevenLabs appears in this repo only as future-tense prose in
`docs/superpowers/specs/2026-06-14-metered-capabilities-design.md:192,207`.

## Contact point in Murage

The consuming spec is `docs/plans/flux-image-tool.md` in the murage repo. D1 in
that document is REQUEST 1 here, and it is marked as the blocking item.
