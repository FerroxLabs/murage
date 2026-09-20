# LANE-SERVER-NEEDS

Requests from the server lane (guided first run) to lanes that own other files.
Nothing here was changed by this lane.

## 1. `server/desktop-authorization.test.ts` — add the new route

Owner: whoever owns that test.

`POST /api/setup/routine` is new. It is already covered by the desktop policy
(`server/desktop-policy.ts` matches `/^\/api\/setup(?:\/|$)/` for GET and POST)
and it also re-checks `requestSurface(...) !== "desktop"` and answers 404, the
same shape as the other routine writes. The enumerated list at the top of
`desktop-authorization.test.ts` should gain it next to the other three:

```ts
["POST", "/api/setup/answer"], ["POST", "/api/setup/skip"], ["POST", "/api/setup/reopen"],
["POST", "/api/setup/routine"],
```

## 2. `src/components/FluxRouterConnection.test.ts` — the named-busy sentence now exists

Owner: the renderer lane.

That test already anticipates the named form and writes it as:

```
Finish running work before changing Flux credentials. Mel is still finishing a task in Inbox triage.
```

The server now produces exactly that shape. The three it can emit are:

- nothing nameable (the app's own provider fence): the base sentence alone.
- one bot, no room: `<base> Mel is still working.`
- one bot working in a channel: `<base> Mel is still finishing a task in Inbox triage.`
- several: `<base> Mel, Ada and Rey are still working.` (capped at three names,
  then `and others`), so it always stays under the card's 400 character gate.

No change is needed unless that test wants the multi-bot form covered too.

## 3. Renderer: `GET /api/setup` now writes to the Chief's thread

Owner: the renderer / setup-UI lane.

Every read of `/api/setup` appends any first-run cards that are now owed into
the Chief's thread and patches `card.setup.settled` on the ones whose step has
finished. The cards are ordinary `kind: "options"` messages carrying
`card.setup` (`shared/setup-card.ts`). The renderer owns the real wording; the
`title` / `subtitle` the server writes are the plain fallback a transcript
exported without the renderer reads by.

So: the panel should not also create these cards, and it should expect the
thread to change as a side effect of polling the view.

## 4. Two observations on the frozen contract (`shared/setup.ts`), not requests

Flagging rather than asking, because the contract is frozen for 0.1.58 and
nothing here is blocking.

**a. `firstRun` goes false as soon as the first run works.**
`setupIsFirstRun` reads a saved profile name, a saved key, a connected app and
a routine as "this workspace has been used" — and the first run's own steps
create all four. So `view.firstRun` is the right gate on STARTING the
conversation and cannot be the gate on continuing it. `server/setup-conversation.ts`
therefore treats the flow as live when `view.firstRun` is true OR the opening
card (`hello:welcome`) is already in the thread. A restored or established
install has neither, so it is still shown nothing at all. This is documented at
the `conversationLive` function.

**b. The `agents` card cannot ride on `view.next`.**
`setupStepDone("agents")` is `live.agents.length >= 1`, which is true on nearly
every machine before anybody types anything, because Murage ships an engine. So
`nextSetupStep` skips straight past `agents` and the "you already had these" /
"there is one in the box" card would never be shown. The driver emits it as a
report once `hello` is done or skipped, the same way `brief-ran` is a report.
When there genuinely is no engine, `view.next` IS `agents` and the same card
key covers both, so nothing is said twice.
