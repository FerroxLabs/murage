# Image generation on the Flux key: spec

Status: SPEC, not built. Written 2026-09-03 against flux-router at ~/dev/flux.
REVISED 2026-09-03 after flux-router's reply
(~/dev/flux-router-evidence/REPLY-TO-MURAGE-2026-09-03.md). Three of our four
requests came back already-fixed. The revisions below are theirs, not ours.

## The problem this exists to avoid

We reported that `flux-image` was a billing tier name that fell through to the
cheapest arm and answered 200. The mechanism was right and **the consequence was
worse**: Together retired FLUX.1-schnell, so from **2026-07-17** that route was
not quietly downgrading, it was returning 502. Six weeks dead, not cheap.

Fixed on their side: `flux-image` is now an explicit alias resolving to
`nano-banana-2` -> `gemini-3.1-flash-image`. The genuine tier names
(`flux-fast`, `flux-standard`, `flux-reasoning`, `flux-auto`) are excluded from
the image capability set and can never appear in our picker as image models.

The rule this spec was built on still stands and is now cheap to keep: send a
resolved alias, never a tier, and never accept a silent substitution.

Every decision below is downstream of one rule: **never send a name the router
might not resolve, and never accept a silent substitution.**

## D1. The model list is DISCOVERED, not hardcoded. Load bearing.

Two aliases the owner wants do not exist yet: `gpt-image-2` is being added now,
and `nano-banana-2` is to be the default. Hardcoding either means Murage ships
broken until Flux catches up, or worse, ships a name that silently degrades.

So Murage asks Flux what exists, at catalog-refresh time, on the user's own key.
`GET /v1/models` already exists and is authenticated.

**DONE ON THE FLUX SIDE.** Built, not yet rolled. Every row now carries
`capability` (chat | image | audio), `display_name`, `list_price_microcents` and
`entitlement` (open | paid_cleared | premium_locked), derived from the same
dispatch map and pricing config the request path uses so it cannot drift.

Two of their design notes change what we build:

- **`entitlement` fails OPEN.** A wrongly-greyed-out model is a worse lie than an
  optimistic one the route then refuses with a clear 402. So we may use it to
  ORDER and to warn, but we must not hard-disable on it, and 402 must stay a
  first-class handled state (D7) rather than something the marker prevents.
- **`max_input_tokens` / `max_output_tokens` are deliberately absent** on image
  and audio rows. LiteLLM stamps a meaningless 4096 default there. Do not size
  anything against those fields.

Drop the static seed and the unverified-price labelling once they confirm the
roll. Until then the seed stands, minus the retired arm (see D2).

## D2. The default is a PREFERENCE that resolves, and never substitutes silently

Configured default: **`flux-image-nano-banana-2`**, which is Google's
`gemini-3.1-flash-image`. It EXISTS TODAY and resolves, so the default is live
rather than aspirational.

The preference-resolves-at-use-time machinery still stands, because two arms are
withheld and one was retired mid-flight. That is precisely the class of event it
exists for:
- available    -> use it
- unavailable  -> use the declared next-best AND say so in Settings, naming both
                  what was asked for and what is being used

Silent substitution is the `flux-image` bug wearing a different hat. The user
must be able to see that their chosen model is not the one running.

Declared order when the preference is unavailable, best first:

  flux-image-nano-banana-2      DEFAULT, live
  flux-image-gpt2               granted
  flux-image-nano-banana-pro-2k
  flux-image-gpt2-low           granted
  flux-image-gpt-high
  flux-image-nano-banana
  flux-image-gpt-med

**NEVER OFFER, and this is load bearing:**
- `flux-image-gpt2-high` and `flux-image-gpt2-xl` are WIRED, PRICED AND
  WITHHELD. Measured 164.7s at high against a ~100s Cloudflare edge cap, so they
  would 524 for every caller. Streaming unblocks them; flux-router will tell us
  when they open. Building a picker entry against either ships a row that always
  fails.
- `together-flux` / FLUX.1-schnell is RETIRED and answers 400. It was in this
  spec's first draft as the cheap floor. Removed.

Because arms appear and disappear, the picker renders the DISCOVERED list and
this order is only a preference resolver, never a hardcoded menu.

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

  nano-banana-2        $0.0806   DEFAULT (80640 microcents, per their reply)
  gpt-image-med        $0.05
  nano-banana          $0.06
  gpt-image-high       $0.20
  nano-banana-pro-2k   $0.20
  gpt-image-high-xl    $0.30
  nano-banana-pro-4k   $0.36
  gpt2 arms            from discovery once rolled
  together-flux        RETIRED, do not list

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

---

## LIVE VERIFICATION — 2026-09-03, probed against api.fluxrouter.ai

Everything below was measured, not relayed. Re-measure before building; the
whole point of this block is that the last relayed state was already stale.

### STILL BLOCKED. `/v1/models` has NOT rolled the discovery fields.

`GET /v1/models` returns 105 rows. The keys on every row are exactly:

    created, id, max_input_tokens, max_output_tokens, object, owned_by

No `capability`. No `display_name`. No `list_price_microcents`. No
`entitlement`. Flux reported Request 1 as "built, route wiring left" and that
is still where it is. **Do not start the discovery-driven build until these
fields appear** — the static seed plus unverified-price labelling is the
correct interim, exactly as specced above.

### The 15 image arms that ARE live

    flux-image                     flux-image-nano-banana
    flux-image-fast                flux-image-nano-banana-2      <- DEFAULT
    flux-image-flux                flux-image-nano-banana-pro
    flux-image-gpt                 flux-image-nano-banana-pro-4k
    flux-image-gpt-high            flux-image-pro
    flux-image-gpt-xl              flux-image-together-flux
    flux-image-gpt2                flux-image-lite
    flux-image-gpt2-low

Three corrections to the table earlier in this document:

1. **gpt-image-2 has rolled.** `flux-image-gpt2` and `flux-image-gpt2-low` are
   both live. The table above them was written when they were still in flight.
2. **`flux-image-nano-banana-pro-2k` does not exist.** The live arm is
   `flux-image-nano-banana-pro`, and there is a separate
   `flux-image-nano-banana-pro-4k`. The `-2k` name in the price table is wrong
   and would 400 for every caller.
3. **The two withheld arms are correctly absent.** No `flux-image-gpt2-high`,
   no `flux-image-gpt2-xl`. Their 164.7s-vs-100s-edge-cap measurement holds and
   the withholding is real, not just documented.

### REPORT BACK TO FLUX: a retired arm is still advertised

`flux-image-together-flux` **is still listed in `/v1/models`**, despite Flux's
own correction that Together retired FLUX.1-schnell and the arm has been
failing since 2026-07-17. A dead arm in the discovery response is worse than a
dead arm alone, because the discovery-driven build this spec describes would
list it in the picker on their own authority. This should go back to them.

Not probeable from here — see below — so this is "advertised", not "confirmed
still broken". Say it that way when reporting it.

### THE FEATURE IS PLAN-GATED, and that is the primary path, not an edge case

    POST /v1/images/generations  {"model":"flux-image-together-flux",...}
    -> HTTP 402
       {"error":{"message":"image generation requires a paid plan",
                 "code":"premium_locked"}}

On the workspace key this repo develops against. So:

- The `404 dark -> 401 auth -> 402 premium_locked` ladder is live and real.
- **Every image generation is 402 until the account is on a paid plan.** The UI
  cannot treat `premium_locked` as a rare branch. It is the first thing a new
  user hits, and the copy has to say the key is fine and the plan is not —
  the same distinction `server/voice/flux-voice.ts` already draws for the
  `premium` transcription reason. Reuse that vocabulary rather than inventing
  a second one.
- `entitlement` failing OPEN (order and warn, never hard-disable) remains
  correct and is now more important, not less: a wrongly-greyed model plus a
  plan gate would give two different lies about the same state.
