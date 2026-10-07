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
