<!-- Copyright 2026 Ferrox Labs
     SPDX-License-Identifier: AGPL-3.0-or-later -->
# S9 integration seam

`electron/float-windows.mjs` exports `createFloatWindows` and
`createFloatSurface`. The delivery files and `main.mjs` are unchanged.

1. Construct `createFloatWindows(deps)` when either floating surface is on.
   Its constructor creates no window. Call and await `sync()` to apply the
   current preferences and presence. Reuse the same manager on subsequent
   preference, roster and presence changes; call `destroy()` on shutdown or a
   home/session replacement, then construct a new one for the new home.
2. Supply `prefs()` with the complete notify-surfaces value, `capabilities()`
   with the result of `notifyCapabilities`, and `presence()` with explicit
   boolean `fullscreen`, `sharing` and `locked` fields. Unknown presence hides
   both surfaces. No presence polling is added by S9.
3. Supply `botStates()` as the current home's roster:
   `[{ botId, name, state, hidden?, visible? }]`. Normalize state to `idle`,
   `working` or `needs-you`. Exclude archived and sidebar-hidden bots or mark
   them `hidden:true` / `visible:false`. This data stays in main. Main watcher
   `bot` frames call `setBotState(botId, state)`; roster additions/removals call
   `sync()`. Identical state values do not push. The first sync captures the
   initial state; subsequent state transitions must use `setBotState`.
4. Pass the SAME exact `loadUrlFor(kind)` to the manager and the IPC gate's
   `urlFor`. Map bubble to `dist/src/float/bubble.html`, dock to
   `dist/src/float/dock.html` (or their own development build files). Do not
   append a query or fragment. Both HTML files use `src/float/main.tsx`.
5. Pass `floatWindows` into `createAttentionWindowHost`. Its `readItems(kind)`
   must return the current home's attention records, oldest first, with main-only `botId`
   fields and the current previews flag. Map `surfaceFor("bubble")` and
   `surfaceFor("dock")` to their same-named outside surfaces. The host filters
   the roster and cards, creates opaque bot keys and window-bound tokens, and
   strips identities before returning anything to the renderer.
6. Install the host through `attentionIpc.install(ipcMain, host)`. New gated
   controls are `hideForAnHour(info)` and `setExpanded(info, boolean)`, for
   bubble and dock only. No renderer-supplied kind, bot id or window id is
   accepted. Make `attentionIpc.unregister(id)` also call
   `host.invalidateWindow(id)` as required by the existing tray substrate.
   Privacy hides, preference changes and removals destroy and unregister
   windows immediately. The hour timer restores only the requested kind.
7. The host's existing `sendToPinned(text, info)` effect must resolve the
   current home's pinned bot's direct thread and use the existing composer
   send route. The existing `openTarget(target)` effect also needs to handle
   `{kind:"bot", botId}` for a dock bot with no waiting card, scoped to the
   current home. It receives this target only from a consumed Open token.
8. The existing router has a bubble rung. Construct
   `createFloatSurface({ floatWindows, host })`, delegate that rung to
   `surface.show(entry)`, and delegate retirement to `surface.close()`.
   `show` returns `float:bubble:<webContentsId>` only for an existing visible
   bubble whose pin matches `entry.frame.botId`; otherwise null. It updates
   the dot through `setBotState`. `close` invalidates the bubble's host tokens
   with `invalidateWindow(id, {retainBotKeys:true})`, retaining inert avatar keys;
   watcher state remains the dot's authority. Dock has no router rung.

Windows start nonfocusable and use `showInactive()`. An explicit expansion
temporarily enables focus for quick chat or the shared card's Reply field;
collapse restores nonfocusability. The renderer reads fresh cards on a bot
click even if one request replaced another without a bot state transition.
Avatars are still initials, with no image requests or animation.

Verification performed with injected fakes only:

```
node --test --experimental-test-isolation=none electron/float-windows.node-test.mjs electron/float-contract.node-test.mjs
node --check electron/float-windows.mjs
node --check electron/attention-window-host.mjs
node --check electron/attention-ipc.mjs
node --check electron/attention-window-preload.cjs
```

`src/float/FloatPanel.test.tsx`, `src/float/float-guard.test.ts` and
`src/components/PinToEdgeMenuItem.test.tsx` are included by Vite's test config
but have not been run in this dependency-less worktree. The eight catalogues
have matching `float.*` keys; seven translated source-hash maps were updated.
The integrator must run Vitest, TypeScript, Vite, the existing attention
regressions and the copy review gates. Real-OS interaction, capture protection,
typing after expansion, and the `enabled-idle` / `dock-busy` CPU gates remain
for S0/S11. No live app, server or conversation verification was performed.
