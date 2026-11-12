<!-- Copyright 2026 Ferrox Labs
     SPDX-License-Identifier: AGPL-3.0-or-later -->
# S8 integration handoff

`electron/pill-window.mjs` exports `createPillWindow` and `createPillSurface`.
No changes were made to attention-main, main, the router, the presence guard,
or the delivery protocol.

## Delivery seam

- Construct the window on Mac with the injected Electron objects, the IPC gate,
  its exact `loadUrlFor("pill")`, presence snapshot, and native top inset adapter.
  Give it `powerMonitor` for suspend/resume. Display rectangles, including
  `auxiliaryTopLeftArea` and `auxiliaryTopRightArea`, use Electron display DIP
  coordinates. Native adapters must convert their coordinate system first.
- Construct the existing attention host with `readItems("pill")` routed to
  `pillWindow.readItems()` and `surfaceFor("pill")` returning `"pill"`.
  Pass `pillFocus: pillWindow.pillFocus` and `pillExpand: pillWindow.pillExpand`.
  Other surface kinds keep their existing host data source.
- Construct `createPillSurface({ pillWindow, host, mapItem })`. `mapItem(entry)`
  reads the authoritative card through the entry's captured home and transport,
  then returns a main-only host record. Include explicit `previews`, `kind`,
  optional `createdAt`, and the normal host identity/display/authority fields.
  Receipts use `receiptText` already filtered for previews. Do not use offer text.
  The surface supplies `itemId`; direct window callers supply it themselves.
- Forward router `surfaces.show("pill", entry)` and
  `surfaces.show("receipt-pill", entry)` to `surface.show(rung, entry)`.
  It resolves to an array of `pill:` ids, or null. Null means the caller must
  retain its hold or choose its fallback. The window does not replay held work.
- Forward `surfaces.close(ids, entry)` for these ids to `surface.close(ids, entry)`
  with the same router entry. Settlements use this path. The action refusal
  handler can also call `pillWindow.settle(actionEntry.itemId)` while opening
  the target in Murage through the existing refusal path.
- Presence/privacy/home withdrawal calls `pillWindow.hideAll()` before any
  subsequent delivery. The surface invalidates host tokens synchronously on
  stack changes and window teardown. `surface.dispose()` hides and detaches;
  `pillWindow.destroy()` destroys the window and removes OS listeners.

## Reply and expansion

Reply opens the card in Murage by default. Enable `replyTyping: true` on both
the host and window only when S0 establishes typing on a nonactivating panel.
Reply then consumes a window-bound Open capability that calls `pillFocus()`
once. A refusal falls back to opening the card. The text submission still uses
`act(token, "reply", text)`. Allow and Deny never activate the panel.
Expansion uses another one-use Open capability, resizes the same window and
pushes fresh items. No IPC gate channel or preload change is required.

## Verification and remaining integration checks

The permitted Node suites are `electron/pill-window.node-test.mjs` and
`electron/pill-guards.node-test.mjs`. They use isolated injected fakes and no
running app or user data. The renderer suites are `src/pill/Pill.test.tsx` and
`src/pill/pill-guards.test.ts`; the existing attention panel Node guard also
includes `src/pill`.

The integrator must run Vitest, TypeScript and the Vite build. Real Mac notch
and external-display checks, frontmost application checks, Reply evidence,
and the cold-idle, post-hide and pill-burst CPU gates are not proven here.
The nine new `pill.*` keys have all eight translations and seven sets of
English source hashes. The independent copy-review ledger still needs review;
no reviewer identity or approval was fabricated.
