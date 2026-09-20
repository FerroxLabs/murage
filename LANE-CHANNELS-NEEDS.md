# Channels + projects, server lane: what I need from other lanes

Written by the server lane for channels-done-right and projects. I owned
`server/index.ts`, `server/store.ts`, `shared/project.ts`, `server/project-channel.ts`
and my own tests. Everything below is in a file I do not own, so I did not touch it.

## 1. Renderer lane: the archived channel needs somewhere to go

`GroupRecord.hidden` now exists and behaves exactly like a bot's `hidden`. The
server still sends archived channels to the desktop (they ride `publicGroupState`,
so every group frame already carries `hidden` and `channelProject` with no change
to the wire code). The renderer has to do three things:

- filter `group.hidden` out of the main channel list, the way archived bots are
  filtered today;
- give them the same Archived place archived bots have, so a person can find one
  again;
- archive with `PATCH /api/groups/:id { "hidden": true }` and restore with
  `{ "hidden": false }`. `409` means the channel is mid turn: stop the turn first.

Without the filter, archiving looks like it does nothing.

## 2. Renderer lane: the project block

- Wire shape and the allowed statuses: `shared/project.ts`
  (`ChannelProject`, `CHANNEL_PROJECT_STATUSES` = `active` | `paused` | `done`,
  `CHANNEL_PROJECT_STATUS_LABELS` for the words a person reads: In progress,
  On hold, Finished).
- Make an existing channel a project: `PATCH /api/groups/:id`
  `{ "channelProject": { "goal": "..." } }`. Ask for the goal and nothing else:
  the channel already has its chat, its bots, its instructions and its folder,
  and it keeps all of them.
- Change the status: `{ "channelProject": { "status": "paused" } }`.
- Stop being a project: `{ "channelProject": null }`. The channel lives on.
- Create a channel that is a project from the start: `POST /api/groups` with
  `channelProject: { goal }` alongside `name`, `memberIds` and `setup`. There is
  no second creation route and there should not be one.
- `startedAt`, `updatedAt` and `completedAt` are server owned. Sending one is a
  `400`, so do not round trip them back.

## 3. `server/sse-visibility.ts` (not mine): archived channels and the phone

`visibleToCompanion` returns `false` for a hidden BOT and for a DM group, but it
has no opinion about a hidden group, so an archived channel is still pushed to a
paired phone. I made the store side consistent (`Store.visibleThreadIds()` now
skips archived channels, the same line that already skips hidden bots), but I
could not edit `sse-visibility.ts`.

Requested change, in `visibleToCompanion`:

- `case "group"`: `return group ? group.dm !== true && group.hidden !== true : false;`
- `case "thread"`: the group branch likewise `group.dm !== true && group.hidden !== true`.

Reason: a channel the owner has filed away on the desktop should not keep
appearing on the phone. This is a surface filter, not a boundary, so it is the
safe direction.

## 4. Nothing else changes

A channel with neither flag is byte for byte what it was: no new keys, no
migration, no behaviour change. There are tests for exactly that in
`server/channel-archive.test.ts` and `server/channel-project-api.test.ts`.
