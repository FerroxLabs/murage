# LANE-CHANNELS-UI-NEEDS

Requests for files this lane does not own. Nothing here is blocking: every
item has a working stand-in inside the lane's own files.

## 1. `src/lib/sidebar-layout.ts` — move `PROJECTS_SECTION_ID` here

Unfiled projects now get their own sidebar heading. The id and its label
live in `src/components/Sidebar.tsx` (`PROJECTS_SECTION_ID`,
`sectionLabel`) because `sidebar-layout.ts` is outside this lane.

They belong beside `PINNED_SECTION_ID` / `CHANNELS_SECTION_ID` and inside
`sidebarSectionLabel`, so every consumer of that module agrees on the
heading. When that move happens, delete `sectionLabel` from Sidebar.tsx and
go back to calling `sidebarSectionLabel(id)` directly.

Consider also splitting `partitionSidebarGroups` to return
`unsectionedProjects` / `unsectionedChannels`; Sidebar.tsx filters
`unsectionedRooms` by `channelProject` itself today, and
`src/lib/sidebar-layout.test.ts` would be the natural place to test it.

## 2. `src/components/Sidebar.test.ts` — one existing assertion was relaxed

`NewRoomPanel` now makes both a channel and a project, so its name field is
labelled `aria-label={project ? "Project name" : "Channel name"}` and the
literal `aria-label="Channel name"` no longer appears. The test in
"names the New Channel popup as a dialog, and its name field" was changed to
assert both label strings exist instead. Two new cases were added in the same
file (the "+" menu's two named choices, and the channel row's touch-reachable
More-actions control). If another lane owns this file, that is the whole of
the change.

## 3. `src/components/ManageMembersPanel.tsx` — now has a second door

The channel header keeps its member faces, which still open
`ManageMembersPanel`. `ChannelDetailsPanel`'s Members section does the same
job inline, reusing `BotPickerList` and `nextMemberIds`. That is two paths to
one outcome. Nothing is broken by it, but if the faces are ever meant to open
the details panel on its Members section instead, that is a one-line change
in `GroupView.tsx` (`setDetailsSection("members")`) plus deleting
`ManageMembersPanel` and its trigger. Left alone here because the panel is
outside this lane and other callers may exist.

## 4. `server/` — nothing needed

The server contract landed complete. Everything this lane needed was there:
`PATCH /api/groups/:id` takes `hidden` and `channelProject`, `POST
/api/groups` takes `channelProject` and `setup.bulletin`, and both reply with
the whole group record. No server change was required and none was made.

One observation, not a request: `POST /api/groups` requires
`setup.defaultResponder` whenever `setup` is sent. The New Project panel
therefore sends `{ kind: "member", botId: <first picked bot> }` so a project
can be created with its instructions in one call. If a `setup` with only a
bulletin were allowed, that guess would go away.
