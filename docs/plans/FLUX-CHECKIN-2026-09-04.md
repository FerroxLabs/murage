# Check-in: Murage → flux-router, 2026-09-04

From: Murage (Ferrox Labs desktop app)
To:   flux-router
Prior: `HANDOFF-TO-FLUX-ROUTER.md` (image models), `HANDOFF-TO-FLUX-ROUTER-CONNECTIONS.md` (connectors)

Everything below was measured against the live service on 2026-09-03/04 with a
real key, not relayed from a previous note. Where a previous note was wrong, it
says so.

---

## CORRECTION, same day, after this document was sent

**Request 1 HAS rolled** and the section below headed "still not rolled" is
corrected in place. Sean Donahoe checked the live listing and caught it.

On the timing, since flux-router asked: they date the `capability` roll to
~18:10Z (ReplicaSet 17:49Z, re-attempted 18:01Z). Our original probe ran during
2026-09-03 Bangkok daytime, which is ahead of that roll; our re-probe ran
2026-09-04 03:52:18 GMT and sees the field. So this document was accurate when
measured and stale by morning. We are not claiming it was right — we sent it
after the roll, which is our error — but the "re-probed today, still dark"
reading flux-router inferred is not what happened. See the discriminator below.

**The discriminator result does not match either of their expected rows.**

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

## THE DISCRIMINATOR PROBE, run verbatim

flux-router sent a probe to identify which key we run and settle whether we had
simply probed early. Run unmodified, 2026-09-04 03:52 GMT:

    key prefix : sk-B0gKjPvHY_0xm...
    total rows : 105
    capability field present : True
    image by capability : 15
    image by name       : 15
    audio by name       : 3

Against their expected readings:

- **Not "13 by name, 0 by capability"** — the field is present for us, so we did
  not probe before the roll.
- **Not "image by name 0"** — we see the image rows, so it is not an allowlist
  that hides them.
- Their crucible key returns **13/13/3**. We return **15/15/3**. Same endpoint,
  different key, and ours sees **two more** image arms, not fewer. The printed
  prefix is above; note it is not the `sk-flux-...` shape their example assumed.

**And the 402 survives all of it.** Same key, same minute, plain `curl` straight
to `api.fluxrouter.ai` with no MCP gateway anywhere in the path:

    POST /v1/images/generations   flux-image-gpt2-low  -> 402 premium_locked
                                  cf-ray a35a0a6919057b6c-BKK
    POST /v1/audio/transcriptions flux-voice-fast      -> 402 premium_locked
                                  cf-ray a35a0a6bad767b50-BKK
    POST /v1/audio/transcriptions whisper-1            -> 401
    POST /v1/chat/completions     flux-fast            -> 200

Those two cf-ray ids are traceable on your side.

The `whisper-1 -> 401` control is the useful one: it fires exactly as
flux-router predicted, which means the key is valid and recognised and the 402
is a deliberate plan decision about this key, not an auth artefact and not a
gateway rewriting our request.

So the blocker is neither roll timing nor the path. It is that **this key is
entitled differently from the crucible key, and `/v1/models` does not say so** —
it reports `entitlement: "open"` on all fifteen image rows that then refuse the
call. On the crucible key the field happens to be correct, which is precisely
why the bug is invisible from that side.

## REQUEST 1 SHIPPED — and its `entitlement` field says the opposite of the API

`GET /v1/models`, re-probed 2026-09-04. 105 rows. Every row now carries all four
fields we asked for:

    capability, created, display_name, entitlement, id,
    list_price_microcents, max_input_tokens, max_output_tokens, object, owned_by

`capability` splits 87 chat / 15 image / 3 audio. `display_name` is populated
throughout. `list_price_microcents` is populated on every chat and image row
(null on the three audio rows — see below). **Thank you. This is the thing we
wanted most and it is here.**

Now the problem, and it is the reason we are writing again the same day.

**`entitlement` is `"open"` on all 105 rows. Not most — all of them.** Meanwhile,
on the same key, in the same minute:

    POST /v1/chat/completions   model=flux-fast            -> 200
    POST /v1/images/generations model=flux-image-gpt2-low  -> 402 premium_locked
    POST /v1/audio/transcriptions model=flux-voice         -> 402 premium_locked
    POST /v1/audio/transcriptions model=flux-voice-fast    -> 402 premium_locked

So the field exists, is well-formed, and carries no information. It reports
`open` for the fifteen image arms that refuse the call and for the three voice
arms that refuse the call, identically to the eighty-seven chat arms that serve
it.

**This matters more than the field being absent did.** Absent, we could not build
the picker. Present-and-wrong, we build the picker, it renders fifteen image
models as available, and every one of them 402s at the moment a user presses
the button — with the failure landing on us, in our UI, after we told them it
would work. A gate that always says yes is worse than no gate, because it is
load-bearing before anyone notices.

Two ways out, either is fine by us:

- Make `entitlement` reflect the calling key (`open` / `premium` / whatever the
  vocabulary is), so a picker can grey out what this key cannot call; or
- If it is not per-key by design, say so and we will treat it as a static
  catalogue property and gate on the 402 instead — but then it should not be
  named `entitlement`, because that is what every consumer will read it as.

The image tool stays unstarted until we know which. Not blocked on the field
existing any more — blocked on knowing whether it can be trusted.

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
your authority, and we would ship it. It is now advertised at 36000
microcents with `entitlement: "open"` — the listing states positively that this
key may call it. We still could not confirm whether it fails, because every
image call 402s before reaching the arm.

---

## THE 402 WALL — real, and invisible to the discovery response

Re-confirmed 2026-09-04, on the same key whose `/v1/models` reports every one
of these arms as `entitlement: "open"`:

    POST /v1/images/generations       -> 402 {"code":"premium_locked",
                                              "message":"image generation requires a paid plan"}
    POST /v1/audio/transcriptions     -> 402 {"code":"premium_locked",
                                              "message":"audio transcription requires a paid plan"}
                                         (all three arms: flux-voice,
                                          flux-voice-fast, flux-voice-accurate)
    with a bad bearer                 -> 401 {"message":"unauthorized"}

One smaller listing gap while you are in there: `list_price_microcents` is
`null` on all three audio rows (`flux-voice`, `flux-voice-fast`,
`flux-voice-accurate`) though it is populated on every chat and image row. We
meter dictation by billed seconds, so we need a per-second figure from
somewhere; right now it can only be hard-coded.

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

1. **Make `entitlement` mean something, or rename it.** It is `"open"` on all
   105 rows including the 18 that 402. This is now the one thing standing
   between us and building the image tool — a picker built on a field that
   always says yes ships a button that always fails.
2. **A key we can actually test media on** — image and voice both 402. Phone
   dictation is written, metered and error-mapped, and has never seen a real
   transcript.
3. **`list_price_microcents` on the three audio rows** — null today, and we
   bill dictation by the second.
4. **Drop `flux-image-together-flux` from `/v1/models`**, or revive it. It is
   currently advertised as open at 36000 microcents.
5. **Connectors**: base URL, token shape, and the callback story.

And with thanks: Request 1's four fields are live and the other three are
correct and useful. `capability` and `display_name` alone remove a whole class
of hard-coding from our side.

And the thing that is not an ask: Fuigo now ships as Murage's default engine, so
your default-model traffic is about to change shape.
