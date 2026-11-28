# Side panel status contract, version 1

The panel (`sidepanel/`) draws from one status object. The runtime (`runtime.mjs`, owned by lane X1) produces it.
Anything the panel does not find, it leaves out; it never invents state.

## Request and push

- Pull: the panel sends `{ action: 'status', bindingId? }` to the service worker; the reply is `{ result: Status }` or `{ error: code }`.
- Push: on every change the runtime sends `{ type: 'murage.panel.status', version: 1, status: Status }` with `chrome.runtime.sendMessage`.
  The panel accepts it only from this extension's own id. While pushes arrive the panel does not poll; it polls every 2 s only after 30 s without one.
- The panel treats three failed pulls in a row as "Murage is not connected" and shows the setup card. One or two failures keep the last view.
- A `Status.version` above 1 still renders, with the "update Murage for Chrome" note.

## Status

| Field | Type | Meaning |
|---|---|---|
| `version` | number | contract version, 1 |
| `connected` | boolean | the desktop app is reachable |
| `profileId` | string | the Chrome profile label shown in the footer |
| `bindings` | Binding[] | every bot with a task in this profile, newest last |
| `recovery` | `{ code }`? | `update_required`, `storage_unavailable` or `reshare_required`: the panel shows one sentence with the next step |
| `persistenceFailed` | boolean? | Chrome could not save the last change; the panel says so and the owner can try again |

## Binding

| Field | Type | Meaning |
|---|---|---|
| `bindingId`, `botName` | string | identity; `botName` is shown as text only |
| `botColor` | `#rrggbb`? | optional avatar colour |
| `botAvatarId` | string? | the id (16 hex characters) of the bot's picture, when it has one (app 1.0.18+, extension 1.0.1+). The status carries the id only, never the bytes. The panel asks for the bytes once per id with the action `avatar` (`{ action: 'avatar', bindingId }` returns `{ botAvatarId, botAvatar }`, where `botAvatar` is a base64 `data:image/webp`, `png` or `jpeg` URL of at most 16384 characters, or `{}`), and draws it as an `<img>` in the avatar circle. Absent, or anything else, shows the letter. GIF pictures show the letter |
| `conversation` | string? | conversation name for the bot line |
| `state` | `active` / `paused` / `stopped` | `stopped` bindings are not offered in the switcher |
| `pausedReason` | `'handoff'`? | with `state: 'paused'`, the bot handed the page to the owner (Your turn) |
| `handoff` | string? | the one-sentence next human action; a plain default is shown when absent |
| `canContinue` | boolean? | Continue is offered in the handoff state only when true and listed in `panelActions` |
| `ready` | boolean | the bot is connected and driving |
| `phase` | `starting` / `connecting` / `reading` / `waiting`? | what an active bot is doing, shown as "Starting your bot", "Connecting browser tools", "Reading this page", "Waiting for you". Only reported phases are shown; an active bot that is not `ready` shows "Connecting browser tools". There is no percentage and the panel never draws one |
| `mode` | `step` / `task` / `full` | approval mode |
| `tabs` | `{ tabId: number, origin: string }[]` | tabs this binding owns; the panel follows the binding that owns the active tab |
| `grants` | `{ origin, label? }[]` | task access |
| `activity` | `{ time?, text }[]` | recent activity, plain text |
| `sites` | `{ origin, category: 'always' / 'never' / 'asks' }[]` | site decisions |
| `updateWaiting`, `versionNote` | boolean, `'oldApp'` / `'oldExtension'` | update notes |
| `panelActions` | string[] | owner actions the runtime handles beyond stop, pause, resume, share, unshare, reconnect: `continue`, `endtask`, `revoke`, `revoke-site`, `setMode`, `turnoff`, `newtask` (Start a new task, shown on a stopped bot) |

## Rules for the runtime side (X1)

1. Handoff is `state: 'paused'` plus `pausedReason: 'handoff'`. The older shape (`state: 'active'` with a `handoff` string) still renders the same.
2. A push carries the whole status, never a diff, so the panel can draw from any single message.
3. Every string the panel shows from the page or the bot (origins, activity, names, the handoff line) is text only and is never trusted as markup.
4. Panel actions arrive as `{ action, bindingId, ...extra }`; the panel only sends actions the binding lists in `panelActions` (or the base set above).
5. Owner actions answer with `{ error: code }`; the panel words these codes: `host_offline`, `site_denied`, `human_handover`, `binding_inactive`, `tab_owned`, `unknown_binding`, `binding_stopped`, `handoff_use_continue`, `not_handoff`, `incognito_denied`, `persistence_failed`, `update_required`, `storage_unavailable`. Any other code shows a general sentence.
6. One action runs at a time. While it is pending the panel turns its action buttons off and shows "Working on it"; a second press sends nothing. Stop and Pause are the exception: they stay available and always go through.
7. `setMode` only tightens (the panel never offers a looser mode, and never `full`); `turnoff` leaves Full permissive. Both appear only when listed in `panelActions`.

Avatar pictures are memory only: the letter shows after a browser restart until the app binds again. GIF remains letter only.

## The per-bot OK (journey 1024, section 3)

Owners: extension side (this file, `runtime.mjs`, `view.mjs`) = lane q1024-journeyind; app side (the stored `chrome` field, the
notice handler in `server/browser-extension-integration.ts`) = lane q1024-journeybuild.

- The app may send `panel.grant: 'on' | 'off'` with a bind or a status, and `panel.grantBot`, an opaque key that is the same for
  every binding of one bot (letters, digits, `_`, `-`, at most 64). Without `grantBot` the extension keys the bot by its name.
- A binding's panel view carries `grant`, and lists the action `grantoff` while the binding is live and the grant is `on`.
- `grantoff` only tightens, and it is for the bot, not for one binding. The runtime stops every live binding of that bot at once
  (connected or not), records the Off durably under a new id, and emits the notice `{ kind: 'owner_grant_off', offId }` on each
  binding it stopped when the app is connected. From then on:
  - every summary of those bindings carries `grant: 'off'` and `grantOffId`;
  - every bind for that bot is refused with `grant_off`, and the refusal's `message` is the Off's id, whatever `panel.grant` says.
- The Off is lifted only by a bind that carries `panel.grant: 'on'` and `panel.grantAck: <that id>`: the app has seen this Off and
  the owner has since given a new OK in the desktop app. The stopped bindings stay stopped; a new OK is a new binding.
- There is no panel action that gives the OK. `granton` is refused with `desktop_required`.
- An Off the app reports (`panel.grant: 'off'` on a bind or a status) stops every live binding of that bot here too; such a bind is
  refused with `grant_off`, nothing is bound and no tab is opened. It leaves no durable record here: the app is the authority.
  This holds whichever binding id carries it: a bind for a new id, or a bind or status on a stopped one, stops the bot's other
  live bindings as well.
- An Off is never dropped to make room. With more than 256 Offs standing in one browser profile, a bind for a new binding id is
  refused with `grant_full` (for every bot) until binds that name their Off (`grantAck`) bring the count back to 256 or fewer.
- All tabs of one bot in one window sit in one tab group, also when two binds of that bot overlap (the second waits for the first).
- App side MUST (owner q1024-journeybuild): send `panel.grantBot` on every bind and every status that carries `panel.grant`. The
  extension matches a bot by that key exactly; a message without it is matched by the bot's name only, so an Off sent without
  the key does not reach bindings that were bound with one (and the other way round).
- App side MUST: report an Off on a bind, or on a status of a binding the extension still knows (working, paused or stopped). A
  status for a binding id that was already retired is answered `unknown_binding` and stops nothing.
