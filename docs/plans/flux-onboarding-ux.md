# Flux Router in Murage — the key, the moment, the copy

**Status:** plan for cross-audit. 2026-09-01
**Reality check:** ZERO Flux code exists in Murage today. `grep -i flux server src electron`
returns nothing. The surfaces are verified live (`flux-router-spec.md`); none of it is wired.

## Situation

Murage finds the agent CLIs already on your machine and runs them with your existing
logins. That works, and it is also the ceiling: the user pays five vendors, holds five
subscriptions, and still has to decide which model to point at which job.

Flux Router is Ferrox's own OpenAI-compatible router. One key, any supported model,
automatic tier selection. It is first-party, so it is also margin — which means it has to
EARN the pick, never be switched on for people.

Verified live against the real key: `/v1/chat/completions`, `/anthropic/v1/messages`,
`/v1/responses` and `/v1/models` all 200. 79 models. `/v1/images/generations` is down.

## The problem, stated honestly

The user's problem is NOT "I need an inference router." Nobody wakes up wanting one.

The real problem is **decision fatigue and quiet waste**. They have Claude, ChatGPT,
maybe Gemini. They do not know whether the expensive model was needed for the thing they
just asked. They suspect they are overpaying and they cannot prove it. Every model picker
in every app is a small tax on attention.

## Rory Sutherland: sell the reframe, not the plumbing

Sutherland's point is that the psychological problem is usually the real problem. Uber's
breakthrough was not faster cars — it was the map showing the car approaching, which
removed uncertainty. Same cars, transformed experience.

Applied here: **we are not selling cheaper inference. We are selling the end of choosing.**

- "Router" is plumbing language. It describes our side of the transaction.
- "One key. Every model. Always the right one." describes theirs.
- The tiers are not products, they are *intentions*: Auto (just handle it), Reasoning
  (think hard), Fast (I'm in a hurry), Standard (the everyday one).

A user who never opens the picker again has received the whole benefit. That is the goal
state, and it should be stated as the promise rather than buried as a side effect.

## Steve Krug: don't make me think

Krug's rules, applied literally:

1. **One field, one paste, no vocabulary.** Never say router, endpoint, base URL, surface,
   provider or tier on the entry screen. The user pastes a key. That is the whole task.
2. **Never explain what it is before showing what it does.** Proof first.
3. **Every question the screen provokes is a defect.** "Which models?" "Does this replace
   my Claude sub?" "What does it cost?" — answer those inline, in one line each, or the
   user stalls.
4. **Skip must be one click and unpunished.** No "are you sure", no dimmed guilt copy.
   The offer has to earn the yes; a coerced yes is worth less than a clean no.

## Where it goes — three surfaces

### 1. Onboarding, immediately AFTER the engine list

Step 1 already says "Your engines — here's what we found" and lists what is installed.
That screen is the exact moment the user is thinking about what powers their bots, and it
has just proved we found their stuff. The offer stands on that proof.

Ordering is load-bearing: the list first, then the offer. Reversed, it reads as a
paywall before value.

### 2. Settings → API keys

`ApiKeys.tsx` already carries Box, Composio, OpenCode and a VPS alias in a consistent
pattern. Flux is one more field of the same shape. This is where a user who skipped
onboarding goes, and where a key gets replaced.

### 3. The model picker

Flux tiers first with Auto leading, then the user's own models, then the pinned catalog.
Rows gated per engine on implemented surfaces — an ungated row that 400s is worse than
no row.

## The superpower moment

The feeling is not "I configured a router." It is **"I pasted one key and every bot on my
roster just got better."**

So the paste must be followed IMMEDIATELY by visible proof, not a success toast:

- Call `GET /v1/models` on paste. Show the real number: **"79 models unlocked."**
- Show the four tiers as one line, already selectable.
- Show which of their existing Embers can now use it.

That is the Sutherland move: the proof is the product. A spinner and a green tick
delivers the same function and none of the feeling.

## Copy

**Onboarding block, under the engine list:**

> ### One key. Every model. Always the right one.
> Flux Router picks the right model for each job automatically, so you stop paying
> frontier prices for work that didn't need it.
>
> `[ paste your Flux key ]`   **Connect**   ·   *I'll do this later*
>
> Don't have one? **Get a key →**

**On success (replacing a toast):**

> **79 models unlocked.**
> Flux Auto · Reasoning · Standard · Fast — plus every pinned model.
> Your Embers can use these now. Nothing else changed.

That last line matters: it answers "did this break my Claude subscription?" before it
is asked. Krug rule 3.

**Settings field label:** `Flux Router key` · placeholder `sk-flux-...`
**Helper:** `One key runs every engine. Your existing CLI logins keep working.`

**Picker row labels:** `Flux Auto — right model, right price` · `Flux Reasoning — thinks
harder` · `Flux Fast — answers quickest` · `Flux Standard — the everyday one`

## Security constraint, non-negotiable

**The key is never typed into a chat turn.** Transcripts persist and replay into context,
so a key pasted into a conversation is a key written to disk in cleartext and re-sent to a
model on every future turn. Conversation may PROMPT; a native field must CAPTURE.

Storage: `~/.murage/config.json` at 0600, same as Sendlane. Added to
`WORKSPACE_CREDENTIAL_ENV` so spawned agents cannot read it, and injected at the surface
layer via the `MURAGE_LOCAL_*` indirection `codexLocalProviderArgs` already uses — which
resolves the contradiction between "no agent sees the key" and "codex needs it at request
time" (Kimi finding C, `flux-router-integration.md`).

## Prerequisite that must land first

`OPENAI_BASE_URL`, `OPENAI_MODEL`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are
never stripped, and every spawn path spreads `...process.env` (`acp/core.ts:194`,
`codex.ts:102`, `claude.ts:80`). A user running cc-switch silently defeats or corrupts the
Flux surface. Strip first, route second.

## Scope call for tonight

- **Ships:** key field, onboarding block, the proof moment, settings entry, picker rows
  gated to implemented surfaces.
- **Does not ship:** the images surface (backend is down), Flux Voice, spend display.
