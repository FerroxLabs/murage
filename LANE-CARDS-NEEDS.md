# LANE-CARDS-NEEDS

What the first-run CARDS lane needs from the other lanes. Nothing here is a
change I have made: every file named under "who owns it" is outside my
ownership list and untouched by me.

## Files this lane added or changed

Changed (one dispatch branch only):

- `src/components/ChatView.tsx` — two imports, and four lines in the
  `case "options"` sub-dispatch, immediately after the `readIntakeCard`
  branch and before the question and approval branches.

Added:

- `src/lib/first-run-copy.ts` + `.test.ts` — every user-visible string, and
  the gate that holds it to the copy rules.
- `src/lib/connect-app.ts` + `.test.ts` — connect one named app.
- `src/lib/flux-key-paste.ts` + `.test.ts` — save a key the secure way, and
  detect one pasted into the composer.
- `src/lib/first-run-phone.ts` + `.test.ts` — which phone card is honest on
  this machine. Named `first-run-*` to sit beside `first-run-copy.ts`; it is
  the FirstRun-prefixed lib file the brief allows, in lib spelling.
- `src/components/FirstRunCard.tsx` + `.test.ts` — the dispatch.
- `src/components/FirstRunChrome.tsx` — shared classes, the `/api/setup`
  read, and the setup POST helpers.
- `src/components/FirstRunHelloCard.tsx`, `FirstRunFluxCard.tsx`,
  `FirstRunAppsCard.tsx`, `FirstRunBriefCard.tsx`, `FirstRunNextCard.tsx`,
  `FirstRunPhoneCard.tsx`.

## 1. A Flux key pasted into the chat box (Composer lane)

The most important one. `src/lib/flux-key-paste.ts` exports the pure
detector, tested hard against real key shapes and against sentences about
keys:

```ts
const found = detectFluxKeyInComposer(text);
// found: { key, rest } | null
```

**Composer must call it before a send.** On a hit: do not put `key` in the
message, do not send it, save it with `saveFluxKey(key, { status: await
readFluxStatus(api), bridge: fluxBridge(), request: api, desktop })`, and
leave `rest` in the box so the person keeps their sentence. A key that
reaches send is a key in the transcript, on disk, and in the next prompt a
model reads. I cannot do this myself: `src/components/Composer.tsx` is not
mine.

## 2. The cards themselves (server lane)

I render `card.setup` and nothing else. I need the server to append these as
bot messages in the Chief's thread, `kind: "options"`, with
`card.setup = { step, variant, key }` and `key = setupCardKey(step, variant)`,
one per key forever.

Note the steps I assume, because `SETUP_STEPS` has no phone or closing step:

| variant | step I read it on |
| --- | --- |
| `welcome` | `hello` |
| `found` / `bare` | `agents` |
| `key` / `no-key` | `flux` |
| `apps` | `apps` |
| `brief` / `brief-ran` | `brief` |
| `more-routines` / `next` | `routines` |
| `phone` / `phone-needs-tailscale` | `routines` |

If the server picks different steps for `next` and the two phone cards, tell
me and I will follow; the card renders from the variant, but `setupCardSchema`
validates the step, so a step outside the enum makes the card vanish.

## 3. The phone variant is the renderer's decision, not the server's

`shared/setup.ts` says why, beside `SetupPhoneReading`: Tailscale is found by
the Electron main process and the server cannot see it. So send whichever of
`phone` / `phone-needs-tailscale` you like. `FirstRunPhoneCard` probes
`window.muragebox.companion.refreshTailscale()` itself and renders the
variant that machine can actually support. It will never draw a QR code on a
machine with no tailnet address, whatever the card says.

## 4. `/api/setup/routine` (routine lane)

I code against the agreed contract and nothing else:

```
POST /api/setup/routine
{ template: "brief" | "triage" | "watch", time?: "HH:MM", weekdaysOnly?: boolean, subject?: string }
→ { ...setup view..., routineId, runId? }
```

Two small asks on top of it:

- **The brief step's `detail`.** The `brief-ran` card says what time the
  brief will arrive from tomorrow. It reads a `HH:MM` out of the brief
  step's `detail` when there is one and falls back to 07:00. If the time is
  easier to reach some other way, say where and I will read that instead. A
  card that states a time the routine does not hold is worse than one that
  states none.
- **The brief's first run must land in the thread right after the
  `brief-ran` card.** My copy says "It is just below". If the run output
  arrives somewhere else, or arrives as text on the card, tell me and I will
  reword and render it.

## 5. The old email gate (App.tsx / Onboarding lane)

The hello card performs the same signup `src/components/Onboarding.tsx:64-95`
does (PUT `/api/config`, confirm the profile really came back, `identifyEmail`,
POST `/api/subscribe`) and then calls `setEmailGateDone("submitted")`, or
`("skipped")` on Skip. Whoever owns `src/App.tsx` needs to make sure the old
welcome gate and the onboarding modal cannot also appear: two surfaces asking
for the same name and email is the stacked-onboarding bug this release is
undoing.

## 6. A setup view in the store would be better than my read

`FirstRunChrome.tsx` reads `GET /api/setup` directly, memoized at module
scope for four seconds, because several cards mount in the same frame and
each needs the same view (the `found` card needs `view.agents`). If the
store gains the setup view for the checklist panel, tell me and I will read
it from there and delete the fetch.

## 7. Not a request, just so nobody chases it

`npx tsc --noEmit` currently reports 28 errors, all in
`src/components/SetupChecklist.tsx`, `SetupChecklist.test.ts` and
`SetupPanel.tsx`. None are in this lane's files, and this lane introduced
none.
