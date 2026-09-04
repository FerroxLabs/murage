# Check-in: Murage → flux-router, 2026-09-04

From: Murage (Ferrox Labs desktop app)
To:   flux-router
Prior: `HANDOFF-TO-FLUX-ROUTER.md` (image models), `HANDOFF-TO-FLUX-ROUTER-CONNECTIONS.md` (connectors)

Everything below was measured against the live service on 2026-09-03/04 with a
real key, not relayed from a previous note. Where a previous note was wrong, it
says so.

---

## THE HEADLINE, and it is not a request

**Murage now ships Fuigo as its default engine, and Fuigo is a native FluxRouter
client.** As of this session a brand-new bot in Murage is created with
`instanceId: "fuigo"`, `model: "flux-auto"` — verified by booting the harness and
asking it, not by a unit test.

That means every Murage install with a Flux key now sends its default traffic to
you, with no configuration step in between. Murage bundles the 165MB Fuigo binary
so this works on a machine with no CLIs installed at all.

You may want to plan capacity around that rather than hear about it from a graph.
`flux-auto` is the model id it will arrive as.

---

## BLOCKING US: Request 1 has still not rolled

`GET /v1/models`, probed 2026-09-04. 105 rows. The keys on every row are exactly:

    created, id, max_input_tokens, max_output_tokens, object, owned_by

No `capability`. No `display_name`. No `list_price_microcents`. No `entitlement`.

Your last reply reported Request 1 as "built, route wiring left". It is still
there. **Murage's image-generation tool is specced, reviewed and unstarted
because of it** — we are deliberately not building against a guess, since the
whole point of the request was that a picker and a price should not require a
Murage release per arm you ship.

This is the single thing we want most.

---

## THREE CORRECTIONS TO THE ARM LIST

Measured from the same probe.

**1. `gpt-image-2` HAS rolled — good.** `flux-image-gpt2` and `flux-image-gpt2-low`
are both live. `flux-image-gpt2-high` and `-gpt2-xl` are correctly absent, which
matches your 164.7s-vs-100s-edge-cap measurement. No action.

**2. `flux-image-nano-banana-pro-2k` does not exist.** Our spec's price table
named it, taken from an earlier note. The live arms are `flux-image-nano-banana-pro`
and `flux-image-nano-banana-pro-4k`. Our table was wrong and has been corrected;
flagging it in case the same name is in a doc on your side.

**3. `flux-image-together-flux` is STILL ADVERTISED in `/v1/models`.** Your own
correction to us said Together retired FLUX.1-schnell and that arm has been
failing since 2026-07-17. A dead arm in the discovery response is worse than a
dead arm alone: the discovery-driven picker Request 1 enables would list it on
your authority, and we would ship it. We could not confirm it still fails — see
the next section for why.

---

## THE ENTITLEMENT GATE IS LIVE, AND IT BLOCKS OUR TESTING

Our workspace key is `premium_locked` for both media capabilities:

    POST /v1/images/generations       -> 402 {"code":"premium_locked",
                                              "message":"image generation requires a paid plan"}
    POST /v1/audio/transcriptions     -> 402 {"code":"premium_locked",
                                              "message":"audio transcription requires a paid plan"}
                                         (all three arms: flux-voice,
                                          flux-voice-fast, flux-voice-accurate)
    with a bad bearer                 -> 401 {"message":"unauthorized"}

The 401/402 split is clean and we handle it properly — Murage's copy says the key
is fine and the plan is not, rather than sending someone to re-paste a working
credential. No complaint about the behaviour.

**The consequence is worth stating plainly: Murage has built phone dictation and
has never once seen a real transcript come back.** The route, the recorder, the
metering and the error mapping are all done and tested against stubs. It ships
unproven end to end. If you can lift the gate on one key for a window, or point
us at a test key, we can close that.

---

## WHAT WE DID WITH YOUR VOICE ARMS

Sean's instruction was "use Groq as the default, it's fast cheap and accurate".
We read `audio_pricing.py` and `audio_route.py` rather than guess, and found the
instruction was already satisfied by construction: **all three arms are Groq**
(`_AUDIO_CANDIDATES = ["whisper-large-v3", "whisper-large-v3-turbo"]`, dispatched
as `groq/{arm}`).

So we pinned **`flux-voice-fast`** rather than the `flux-voice` auto-picker. Two
reasons, and the second may interest you:

- It is deterministic, which a push-to-talk UI wants.
- **It removes a container trap.** The auto-picker chooses on a duration probe
  with a 10s knee, and mutagen cannot read a Matroska header — so a webm clip has
  unknown duration and always falls to the accuracy arm. We measured both target
  browsers: **neither Chromium nor Safari 26.3 will record ogg.** Every phone
  clip you receive from a browser is webm. Whatever your auto-picker's intent,
  in practice browser clips take the expensive arm. Pinning sidesteps it for us;
  you may want to know it is happening for everyone else.

---

## CONNECTORS — cleared on our side, waiting on yours

`HANDOFF-TO-FLUX-ROUTER-CONNECTIONS.md` has the detail. Status changes since:

- **The terms question is CLOSED.** Composio's API is keyed on an end-user id and
  Murage already mints one per person; multi-tenancy is the modelled use case, not
  a grey area. No legal gate remains.
- **Murage's half is config, not code.** `activeBroker()` (`server/composio.ts:195`)
  is already the single choke point and `brokerRequest` resolves through it, so
  pointing `MURAGE_COMPOSIO_BROKER_URL` at Flux touches no caller.
- Still the one hard part: **the OAuth callback is stateful and will not survive a
  naive pass-through.** Scope that before calling it cheap.

What we need back: a base URL and token shape (we validate against a regex and
throw on mismatch), a statement on callback handling, and confirmation that
entitlement failures arrive as `402 premium_locked` so we reuse the vocabulary we
already have.

---

## ONE TRANSIENT, LOGGED NOT ESCALATED

Mid-session, Fuigo's session-title generation got
`fluxrouter.ai | 502: Bad gateway` on `model_id=flux-fast`. It logged to stderr
and the turn completed fine. Noting it as upstream noise rather than a report —
one occurrence, not reproduced.

---

## SUMMARY OF ASKS, in the order they matter to us

1. **Roll Request 1** (`capability` / `display_name` / `list_price_microcents` /
   `entitlement` on `/v1/models`). Unblocks the image tool entirely.
2. **Drop `flux-image-together-flux` from `/v1/models`**, or revive it.
3. **A key we can actually test media on** — image and voice are both built or
   specced against a 402 wall.
4. **Connectors**: base URL, token shape, and the callback story.

And the thing that is not an ask: Fuigo now ships as Murage's default engine, so
your default-model traffic is about to change shape.
