<!-- Copyright 2026 Ferrox Labs / SPDX-License-Identifier: AGPL-3.0-or-later -->
# S4c delivery handoff

`electron/linux-notify.mjs` exports `createLinuxBanners` and `loadSessionBus`.
`electron/native-banner-pick.mjs` exports `pickNativeBanner({platform, mac, linux})`.
The adapter implements the existing `nativeBanner` interface and returns `mb:` ids.
No delivery module or `main.mjs` was changed.

## Connection in main

In `initializeAttentionActions()` in `electron/main.mjs`, the delivery builder must
create the Linux adapter with `createLinuxBanners({loadBus: loadSessionBus, mint,
act, open, log})`, then pass
`nativeBanner: pickNativeBanner({platform: process.platform, mac, linux})` to
`createAttentionMain`. `mac` is the configured Mac adapter, or null if unavailable.

The required `mint({entry, surface, surfaceId, digest})` adapter must call
`attentionActions.mint` with the entry's home, epoch, threadId, messageId,
requestId, digest, surface and surfaceId, plus the transport and identity captured
for the display read. `act(token, action, text)` must call
`attentionActions.act(token, action, text)` without an attention-window context.
`open(target, home)` must use the existing approval Open callback for that home;
its first argument has the same botId/threadId/messageId fields as Mac banners.
The optional `mute(target, home)` callback receives that same context.
Pass `language: () => desktopStepUpLanguage(...)` using main's existing desktop
language reader. Without this optional callback the labels use English.
Call `close(ids)` when a card settles or its surface is withdrawn, and `dispose()`
on shutdown. Fallback remains the existing Open-only path whenever `show` returns null.

The current `createAttentionMain` reads the card using `transportFor(entry.home)`
but passes only `{entry, record, actionsOn, plain}` to `nativeBanner.show`.
Neither the captured transport nor its identity reaches the mint callback.
`initializeAttentionActions` currently has no banner mint adapter. Looking up a
new transport at mint time could bind an old display to a replacement server or
Cloud session. Carrying that snapshot belongs to the delivery builder's protected
show path; S4c stops at the factory and picker under the slice's seam allowance.

## Verification and remaining integration

The four new Node test files use isolated EventEmitter buses and injected
effects. The wiring test exercises the existing `createAttentionMain` seam,
including settle withdrawal, fallback, and Open routing by home; it does not
claim that production main is wired.

The integrator still needs the pinned `dbus-next` dependency and audit, production
wiring, and real GNOME X11, GNOME Wayland and KDE Wayland evidence. No package,
lockfile, live application, server or conversation data was changed. The runtime
loader adds `notificationVariant(signature, value)` to the returned session bus
to construct the library's typed hints without loading the package in unit tests.

The three button labels are registered under `nativeBanner.*` in all eight
renderer catalogues, with SHA-256 English source hashes in `source-hashes.json`.
`native-banner-labels.mjs` carries the small packaged snapshot, checked against
those catalogues by its Node test; notification titles and bodies remain the
server's display text. No new banner prose was added.
