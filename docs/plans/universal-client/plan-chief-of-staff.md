# Chief of Staff hierarchy — plan

Murage. Two tiers: one workspace Chief of Staff (Ember), per-team leads under her.
Plan only. No code written. Every claim below is either cited to `file:line` or proven by a run
recorded in **§1** / **Appendix A**.

---

## 0. Executive summary

Three findings decide the shape of this work.

1. **The load-bearing claim is TRUE.** A room turn gets the agents integration at hop 0.
   Proven live, not read: `MURAGE_TURN_DEPTH=0` in the injected MCP env. `MAX_COMMS_DEPTH`
   never has to move.
2. **Both blocking bugs are real and reproduce.** `ask_bot` from a room returns the literal
   string `source thread does not belong to sender`; `store.botByThread(roomThreadId)` is
   `null`, which is why a room-launched delegation's result is dropped.
3. **The two-hop model does not work even after fixing both bugs.** `delegate_bot` always
   targets the *bot's 1:1 thread* (`server/index.ts:2196`) and runs it at `commsDepth 1`
   (`server/delegations.ts:31-36`), which gets **no** agents tools (`server/index.ts:2832`).
   So Ember → Lead works; Lead → their team never starts. Sean's org needs a delegation that
   lands in a **room**, because only a room turn resets hop to 0. That is a new mechanism, and
   it is the one that reopens the cycle problem (§6).

Consequence for sequencing: steps 0–5 are safe, small, and independently valuable. Step 6 is the
one that actually completes Sean's picture, and it is deliberately last because it is the only
step that can burn tokens without bound if it is wrong.

---

## 1. VERIFICATION — does a room turn get agents tools at hop 0?

**Yes. Proven by running it, twice over, at two levels.**

### Where `hop` comes from

`runGroupMemberTurn(groupId, threadId, botId, hop, …)` — `server/index.ts:3405`.
Four call sites, all read:

| call site | `hop` passed | what it is |
|---|---|---|
| `server/index.ts:4178` | **`0`** — literal | the top-level room dispatch, from `startGroupTurn` |
| `server/index.ts:3850` | `hop + 1` | mention-chaining inside a room, capped by `MAX_GROUP_HOPS = 1` (`:3355`) |
| `server/index.ts:3892` | `run.turnCount === 1 ? 0 : 1` | goal runs — only turn 1 gets tools |
| `server/index.ts:4626`, `:4725` | `0` | connector / secret resume of a room turn |

`hop` is **not inherited from anything**. A user message into a room always enters at 0.
Then `server/index.ts:3464`:

```
if (hop < MAX_COMMS_DEPTH && instance.adapter.capabilities.agentsMcp === true) {
  integrations.agents = agentsIntegration(bot.id, threadId, hop, skillAuthoring);
}
```

`0 < 1` → true.

### The run

`scratchpad/room-hop-proof.mjs` boots the real harness (same rig as `server/comms.test.ts`:
spawned `server/index.ts`, temp `HOME`, fake ACP CLI in `ask-peer` mode), creates a room with
two bots, and posts a human message to `POST /api/groups/:id/messages`.

`FAKE_ACP_DUMP` captured what the room turn's provider was actually handed at `session/new`:

```json
[{ "name": "agents",
   "args": [".../server/drivers/agents-proxy.ts"],
   "env": [ … { "name": "MURAGE_THREAD_ID", "value": "b9141900-…" },   // the ROOM thread
                { "name": "MURAGE_TURN_DEPTH", "value": "0" } ] }]     // hop 0
```

**The agents MCP server is mounted, on the room thread, at depth 0.** Claim verified.
`MAX_COMMS_DEPTH` stays at 1.

### The same run also proved bug (a)

The room bot's reply was, verbatim:

```
[bot/text] from=Asker :: peer says: source thread does not belong to sender
```

That is the 403 body at `server/index.ts:5292`, round-tripped through the proxy into the model's
own answer. The peer never ran — the Helper's thread contains only its seeded greeting. So today
the tools are mounted in a room and every one of them that matters is refused.

### Caveat that changes the design

`hop` resets to 0 at every room boundary. That is what makes Sean's model possible **and** what
makes it unbounded (§6). It is a property to exploit carefully, not a safety property.

---

## 2. ROLE MODEL

### What exists

`chiefOfStaff` is one boolean on `BotRecord` (`server/store.ts:461`). `setChiefOfStaff(id, section?)`
(`server/store.ts:1318`) clears the flag only within the same section — the loop at `:1324` skips
every bot whose `sectionKey` differs. So it is already **one chief per section**, i.e. already a
per-team role.

Imports make one section per package: `packageSection = pkg.name` (`server/index.ts:6364`, deduped
at `:6367`), every created bot gets it (`:6385`), then `store.setChiefOfStaff(memberIds.get(pkg.chiefOfStaff)!)`
(`:6458`). Five packages → five sections → five chiefs. Confirmed.

Local catalog: **28 of 28** `library/assistants/*.json` carry `package.chiefOfStaff`
(`library/assistants/helm.json` → `"chiefOfStaff": "helm"`). The 59 `teams-library/teams/*.json`
use a *different* format (`format/version/team/schedule/wayland`) and carry none.
**I could not verify the "122 live catalog entries" figure** — 116 catalog files exist locally,
28 carry the field. See §9.

### Decision: a `chiefScope` field, plus one `canReach()` predicate

**Recommended.** Add to `BotRecord`:

```ts
/** Absent = this bot leads its own section (today's meaning, unchanged).
 *  "workspace" = the one Chief of Staff above the section leads. */
chiefScope?: "workspace";
```

Invariant: `chiefScope` is meaningful only when `chiefOfStaff === true`. One flag, one modifier —
never two booleans that can disagree.

Then replace seven copies of `sectionKey(a.section) === sectionKey(b.section)` with one predicate,
placed in `server/store.ts` beside `sectionKey` (`:528`) so `server/delegations.ts` can import it
without a new cycle — it already imports `sectionKey` from there.

```ts
const isWorkspaceChief = (b: BotRecord) => b.chiefOfStaff === true && b.chiefScope === "workspace";

/** Who a bot may see, name, ask, delegate to, and schedule.
 *  Strict SUPERSET of the old section rule — nothing that worked stops working. */
export function canReach(from: BotRecord, to: BotRecord): boolean {
  if (to.hidden || from.id === to.id) return false;
  if (sectionKey(from.section) === sectionKey(to.section)) return true;  // unchanged
  if (isWorkspaceChief(from) && to.chiefOfStaff === true) return true;   // Ember → leads
  if (from.chiefOfStaff === true && isWorkspaceChief(to)) return true;   // lead → Ember
  return false;
}
```

Exactly two new edges. A grunt still cannot reach Ember; Ember still cannot reach a grunt. That is
Sean's sentence — "she never talks to grunts" — expressed as a predicate rather than a convention.

### Why not the alternatives

- **A second boolean (`workspaceChief`)** — two independent booleans admit
  `workspaceChief && !chiefOfStaff`, a state with no meaning that every one of the seven gates
  would have to interpret separately. Rejected.
- **An explicit relation (`reportsTo: botId`)** — strictly more expressive, and genuinely better
  if the org ever goes three deep. But it needs a graph, cycle validation on every edit, a UI to
  draw it, and a migration that invents edges for 28 existing packages. It buys nothing for a
  two-tier org. Rejected **for now**; `canReach` is the seam that would absorb it later, because
  every gate would keep calling the same function.
- **Reusing `section` with a reserved value (e.g. `section: "__exec__"`)** — overloads a
  user-visible, user-editable, package-exported string with a privilege. One rename in the
  sidebar silently demotes the Chief. Rejected.

### Wire compatibility — the actual constraint

- `pkg.chiefOfStaff` is untouched. `server/bot-package.ts:77` (`chiefOfStaff: key.optional()`),
  `:179-180` (validation), `:255` (the Markdown export) all stay byte-identical.
- An imported package sets `chiefOfStaff` and **never** `chiefScope`, so no downloaded package can
  seize the workspace tier. That is the security property; it comes for free from putting the new
  field outside the wire format.
- **`chiefScope` is deliberately NOT added to `server/package-export.ts:137-138`.** Exporting it
  would let a package the user downloads install a bot that outranks their own Ember. Stated
  explicitly so a future reviewer does not "fix" the asymmetry.
- Migration: `server/store.ts:671-683` already de-dupes chiefs per section at load. Add a parallel
  pass — if more than one bot carries `chiefScope: "workspace"`, keep the first and clear the rest.
  Same shape, same file, same `botsMigrated` flag.

---

## 3. THE SEVEN GATES

Every one becomes a call to `canReach`. Listed with its current predicate and its replacement.

| # | Site | Today | New |
|---|---|---|---|
| 1 | `server/chief-of-staff.ts:36-38` | `sectionKey(bot.section) === chiefSection` filters the prompt roster | `canReach(chief, bot)`; for a workspace chief, group the result by section and label leads (§5) |
| 2 | `server/index.ts:2825-2829` | `sectionPeers` = same-section, used to resolve `@mentions` in the 1:1 composer (`:2842`) | `store.bots.filter(b => canReach(bot, b))` |
| 3 | `server/index.ts:5097-5103` | `GET /api/internal/agents` (= `list_bots`) filters to sender's section | `canReach(sender, b)`; **also add `section` and `chiefOfStaff` to each row** (`:5104-5111`) so a workspace chief can tell a lead from a peer and a team from a team |
| 4 | `server/index.ts:5288` | `ask_bot` 403 `"that bot belongs to a different section"` | `if (!canReach(from, target)) 403 "that bot is not on your roster"` |
| 5 | `server/index.ts:5444` | `delegate_bot`, identical string | same |
| 6 | `server/index.ts:3210` | routine `validateTarget` re-authorizes at **confirm** time, not proposal time | `canReach(proposer, targetBot)`; message → `"@X is not on your roster, so this routine cannot be scheduled for it"`. Keep the live-record lookup — the card can sit open for days |
| 7 | `server/delegations.ts:553` `dropIfSectionsChanged` | `sectionKey(sender) === sectionKey(target)` at the final dispatch edge | rename `dropIfUnreachable`, predicate `!canReach(sender, target)`, chip → `"…are no longer on the same roster"` |

Because `canReach` is a strict superset of the old rule, **steps 1 and 3 are behaviourally
inert until a workspace chief exists.** That is the argument for landing them early and alone.

### `create_bot`'s section — the flagged unknown, now verified

`server/index.ts:5519`: `section: chief.section`. Verbatim inheritance, `undefined` included.

Ember has `section: null` today, so `sectionKey` is `""` — the same bucket every unsectioned bot
lands in. Two consequences, both wrong for a workspace chief:

1. Bots she creates join **her own** General bucket, not a team.
2. She is the `chiefOfStaff` of that bucket, so she becomes the direct manager of the grunts she
   just created — the exact thing Sean says is not her department.

**Fix.** `create_bot` gains an optional `section` argument:

- A **section** chief: argument ignored (or refused if it names another section). Unchanged behaviour.
- A **workspace** chief: `section` is **required**. Refuse with
  `"name the team this specialist joins — create_bot cannot add bots to your own roster"`.
  Refuse a section that has no `chiefOfStaff`, with
  `"the <X> team has no lead yet — create the lead first"`. The new bot inherits that section, so
  the section's own lead becomes its manager, not Ember.

Touches `server/drivers/agents-proxy.ts` (`create_bot`'s input schema) and `server/index.ts:5501-5535`.
The proxy's tool schema is this fork's own surface, not the published package format — no contract
break.

Note the duplicate check at `:5511-5518` already scopes to `sectionKey(chief.section)`; it must
scope to the *target* section instead.

Note also that `create_bot` **already uses `connectorThread`** (`server/index.ts:5483`) and so
already works from a room. It is the precedent for §4(a), not an exception to it.

---

## 4. THE TWO BUGS

### (a) `ask_bot` / `delegate_bot` 403 from inside a room

**Proven live** (§1): the model's own reply was `peer says: source thread does not belong to sender`.

`server/index.ts:5292` and `:5448`:

```ts
if (!store.taskByThread(from.id, fromThreadId)) {
  return json(res, 403, { error: "source thread does not belong to sender" });
}
```

`taskByThread` (`server/store.ts:1470`) only knows a **bot's** tasks. A room thread belongs to a
group, so it can never match.

**Fix — use the helper five sibling tools already use.** `connectorThread`
(`server/index.ts:4266-4273`) tries `taskByThread` first, then `groupByThread` + membership:

```ts
const origin = connectorThread(from.id, fromThreadId);
if (!origin) return json(res, 403, { error: "source conversation does not belong to sender" });
```

Already the pattern in `create_bot` (`:5483`), `request_credential` (`:5546`),
`routineProposalPersistence` (`:4278`), `skillProposalPersistence` (`:4300`).
`ask_bot` and `delegate_bot` are the two outliers, and they are the two that matter.

Downstream, `fromThreadId` is used as the delegation queue key, the source of the visibility
chips, and `delegationWatch.sourceThreadId`. `store.appendMessage(threadId, …)` is thread-keyed
and group-agnostic, so the chips work unchanged. The one place that breaks is (b).

### (b) The result is silently dropped

**Proven** (`scratchpad/store-lookup-proof.ts`, real `Store` against a temp `MURAGE_DATA_DIR`):

```
room.threadId       = 2abaa7cc-…
botByThread(room)   = null          ← the lookup at server/index.ts:2126
groupByThread(room) = b77692ff-…    ← resolves fine
taskByThread(a,room)= undefined
botByThread(a.thread) = Ember       ← works for a 1:1 thread
```

`server/index.ts:2126`: `const source = watched.sourceThreadId ? store.botByThread(...) : undefined;`
→ `null` → the whole `if (source && watched.sourceThreadId)` block at `:2127-2149` is skipped.
No reply appended to the room, no `markTaskContextExternallyUpdated`. The delegation completes and
its answer evaporates.

Nuance worth keeping: the **receipt is still written**, at `:2117-2125`, *before* the source
lookup. So `check_delegation` / `wait_delegation` still return the result. Only the *push* into
the conversation is lost. Do not "fix" the receipt.

**Fix — branch on thread kind:**

```ts
const sourceBot   = watched.sourceThreadId ? store.botByThread(watched.sourceThreadId) : null;
const sourceGroup = !sourceBot && watched.sourceThreadId
  ? store.groupByThread(watched.sourceThreadId) : undefined;
if ((sourceBot || sourceGroup) && watched.sourceThreadId) {
  … existing appendMessage, unchanged …
  if (sourceBot) markTaskContextExternallyUpdated(sourceBot, watched.sourceThreadId);
  else store.patchGroup(sourceGroup!.id, { unread: true });
}
```

**On the externally-updated marker: the group branch must NOT have one.**
`markTaskContextExternallyUpdated` (`server/index.ts:2087-2097`) exists to invalidate a *resumed
provider session* — it clears `task.resumeCursors` and stamps `lastInstanceId` so `buildTurnContext`
(`:2555-2571`) replays instead of resuming. A room turn has no such session: `sendTurn` in the room
path (`server/index.ts:3708-3714`) passes only `{threadId, text, system, cwd, integrations,
…memberTurnSelection}` — **no `resume`, no cursor** — and rebuilds its prompt from
`serializeRoomContext(threadId, userName)` (`:3600`) every single turn. The next room turn sees the
appended reply because it re-reads the transcript. Inventing a group marker would add a field with
no consumer. `unread: true` (what the room path itself sets at `:3638`) is the whole job.

### Two sibling defects of the same class, in `runDelegatedTurn`

Not in the brief; same root cause, same file, will bite the moment (a) lands:

- `server/index.ts:2222` — `reportStartFailure` does `const source = store.botByThread(sourceThreadId); if (!source) return;`. A room-sourced delegation that fails to *start* is silent too.
- `server/index.ts:2233` — `unattended: isUnattended(store.botByThread(sourceThreadId)?.id)`. A room-sourced delegation is always treated as attended, whatever the room's owner is set to.

Both take the same `sourceBot ?? sourceGroup` branch.

### One thing I checked and it is NOT broken

I suspected a third defect at `server/index.ts:2274` (`store.botByThread(event.threadId)` is null
for a room, so a bot settling a *room* turn would never release delegations queued against it).
**Wrong.** The room path calls `retryDelegationsWaitingOn(bot.id)` explicitly at
`server/index.ts:3642`, `:3773`, `:3801`, `:3820`. No fix needed. Recorded so nobody re-files it.

### Tests

`server/comms.test.ts` is 60.7 KB, 25 `it(` blocks, and **zero** occurrences of `api/groups` —
verified by grep. Not one test puts a group thread and peer comms in the same scenario. New cases,
in that file's existing e2e `describe` (it already boots the real harness with the fake ACP fleet,
so a room is three extra API calls):

1. **`ask_bot` succeeds from a room.** Room of `ask-peer` Asker + happy Helper, human posts,
   Asker's room reply contains `Helper replied:` and Helper's actual text. *This is the exact test
   that fails today with `source thread does not belong to sender` — it is the regression lock for
   the reproduction in §1.*
2. **`delegate_bot` from a room delivers its result back into the room.** `delegate-peer` mode.
   Assert the room transcript gains `@Helper replied to the delegated task:` and the group is
   `unread`. Fails today by silence, which is why it must assert *presence*, not absence of error.
3. **The receipt survives regardless.** After (2), `check_delegation` returns `done` — pins the
   `:2117` ordering so a future refactor cannot move the receipt behind the source lookup.
4. **Room-sourced delegation start failure is visible.** `helperCrash` instance; assert a failure
   chip lands in the *room* (`server/index.ts:2222`).
5. **`canReach` unit table**, no server: same-section, cross-section, workspace-chief→lead,
   lead→workspace-chief, workspace-chief→grunt (**false**), grunt→workspace-chief (**false**),
   hidden target (**false**), self (**false**).
6. **Cross-section `ask_bot` still 403s** with a workspace chief present — the superset must not
   have opened a hole between two ordinary bots in different sections.
7. **`create_bot` from a workspace chief without `section` is refused**; with a section that has
   no lead, refused; with a valid section, the bot lands there and Ember is not its chief.
8. **Package import is unchanged.** Import two packages, assert two sections, two chiefs, and that
   neither carries `chiefScope`.

---

## 5. THE UX

### The gap that makes everything else pointless

**A room turn never builds a Chief of Staff prompt.** `chiefOfStaffSystemPrompt` has exactly one
caller: `server/index.ts:2847`, inside the **1:1** `startTurn` path. The room system prompt
(`server/index.ts:3571-3592`) has no such branch. What Ember is told in a room today is:

> `Reply as yourself, briefly and conversationally. To bring a teammate in, mention them like @Name — they'll see the conversation and respond.`

That sentence points at mention-chaining, which runs the teammate at `hop + 1`
(`server/index.ts:3850`) — no agents tools, no onward delegation. So even with the tools mounted
and both bugs fixed, Ember in the exec room is being actively instructed to use the one mechanism
that dead-ends.

**Fix (highest value line in this plan):** add the chief branch to the room system array at
`server/index.ts:3571`, mirroring `:2846-2853`:

```ts
bot.chiefOfStaff
  ? chiefOfStaffSystemPrompt(bot.id, store.bots, Boolean(integrations.agents), openMurageStatusSystemPrompt())
  : …existing "mention them like @Name" line…
```

### What Ember's prompt says

`server/chief-of-staff.ts` gains a workspace branch. Section chiefs keep today's text verbatim.
Workspace roster is grouped, not flat:

```
You are the Chief of Staff for this workspace. Your direct reports are the section leads below.
Assign work to a lead and let them run their own team — do not assign work to a lead's team members.

Section leads:
- Sales — @Rex (Head of Sales): owns pipeline and outbound (available); 6 specialists
- Content — @Nia (Editorial lead): owns the publishing calendar (working right now); 4 specialists
- Ops — no lead yet. Say so rather than working around it.
```

Reuse the existing caps — `ROSTER_MAX_BOTS = 40`, `ROSTER_NAME_MAX/ROLE_MAX/ABOUT_MAX`
(`server/chief-of-staff.ts:17-20`). The comment there explains why they exist (imported personas
speak into a trusted prompt); grouping does not change that, so per-lead lines get the same
clipping and the section *count* is a number, never third-party text.

### How Sean builds it

1. **Promote a bot to lead.** Already exists — `src/components/SettingsPanel.tsx:440-470`, the
   Crown switch, subtitle `One for {sectionName}`. Unchanged.
2. **Promote to Chief of Staff.** A second row *inside* that card, rendered only when
   `bot.chiefOfStaff` is on: a two-way control `[ Section lead | Chief of Staff ]`, writing
   `chiefScope`. Disabled with a named reason when another bot already holds it
   (`"@Ember is the Chief of Staff — hand the role over from her profile"`), matching how the
   existing copy at `:466-468` names the current chief.
3. **Create the exec room.** A single action on the workspace chief's profile: `POST /api/groups`
   (`server/index.ts:6150`) with `memberIds = [chief, …every bot where chiefOfStaff]`,
   `name: "Exec"`, `setup.defaultResponder = {kind:"member", botId: chief}`. **No new endpoint** —
   the existing route already takes `memberIds`, `name`, and `setup`.
4. **Keep it in sync — by prompting, not silently.** When a new lead appears, show a chip in the
   exec room: `2 section leads are not in this room — add them`, wired to the existing
   `PATCH /api/groups/:id` `memberIds` (`server/index.ts:6632`, field handling at `:6665`).
   Auto-mutating a room's roster behind the user is worse than a chip.

### What he sees

- **Badge.** `src/components/ChatView.tsx:1101` renders `<Crown/> Chief of Staff` for any chief.
  Split it: `Chief of Staff` for `chiefScope === "workspace"`, `{Section} lead` otherwise —
  otherwise five bots wear the same crown and the hierarchy is invisible at a glance.
- **Org view.** `src/components/TeamMapPage.tsx` already draws sections with crowned chiefs above
  members (`:379-385`) and live handoff edges (`:393-408`). Add a `workspaceChief` field to
  `buildTeamMapSections`'s return (`src/lib/team-map.ts:44-56`) so `TeamMapPage` can hoist that one
  bot into a row **above** the section grid, with a connector down to each section's chief. The
  data is already there; only the layout is missing. Its empty state at `:404` —
  `"No bot-to-bot handoffs yet. Ask a Chief of Staff to delegate a task…"` — becomes true copy
  once §4 lands, and is a decent smoke check that it did.
- **Roster.** `list_bots` rows gain `section` and `chiefOfStaff` (§3, gate 3), so Ember's own view
  of the org matches the picture Sean is looking at.

---

## 6. SAFETY

### The mechanism Sean's model actually needs

Stated plainly because it contradicts the optimistic reading in the brief:

`delegate_bot` resolves its target as `store.bot(toBotId)?.threadId` (`server/index.ts:2196`) — the
bot's **1:1** thread — and runs it via `startTurn(toBotId, text, { commsDepth })` (`:2233`) where
`commsDepth = depth + 1 = 1` (`server/delegations.ts:31-36`). At `server/index.ts:2832`,
`1 < MAX_COMMS_DEPTH` is **false**, so the delegated bot gets no agents tools.

So: Ember (exec room, hop 0, tools) → `delegate_bot` → Lead runs 1:1 at depth 1, **toolless**.
The lead cannot reach their own team. Fixing §4(a) and §4(b) is necessary and not sufficient.

The missing verb is a delegation whose target is a **room**: `delegate_room(room_id, message)`,
dispatched through the room path so the lead's turn enters at hop 0
(`server/index.ts:4178`) and *does* get tools. Two hops of depth-1, exactly Sean's drawing.

### Is that cycle-free? **No.** It moves the problem.

`hop` is not inherited across a room boundary — proven in §1. So exec room → Team A room →
Team A room delegates back to the exec room → Ember at hop 0 again → forever. `MAX_COMMS_DEPTH`
constrains nothing here, because it is re-satisfied at every hop. The depth cap that makes
`ask_bot`/`delegate_bot` safe today is exactly the thing `delegate_room` opts out of.

Three controls, in the order I would trust them:

1. **Visited-room set (primary).** Carry the set of group ids already touched by this chain;
   refuse `delegate_room` into a room already in it. This makes A→B→A **structurally impossible**
   regardless of depth. A depth cap bounds a cycle's *length*; only the visited set forbids one.
2. **`MAX_ROOM_CHAIN = 2` (secondary).** A **new** constant, deliberately separate from
   `MAX_COMMS_DEPTH` because it bounds a different thing — org depth, not tool recursion. A
   human-started room turn is `chainDepth 0`; a room turn started by `delegate_room` is
   `sender.chainDepth + 1`; refuse at `>= 2`. Two is exactly Sean's org (exec → team) and no more.
   Threaded through the existing `GroupTurnOrchestration` argument of `runGroupMemberTurn`
   (`server/index.ts:3420`) — the parameter already exists for goal runs, so this needs a field,
   not a new signature.
3. **Shape enforcement at dispatch (tertiary).** A `delegate_room` target must contain the sender's
   direct report and must not contain the sender. If that holds everywhere the graph is a tree by
   construction — but users edit rosters, so check it at dispatch and never assume it.

### Cost of a runaway

Chat-mode rooms have **no turn budget**. `GROUP_GOAL_MAX_TURNS = 13` (`server/group-goal-run.ts:5`)
caps goal runs only; a chat room is bounded solely by `MAX_GROUP_HOPS = 1` on mention-chaining
(`server/index.ts:3355`). The new risk is **breadth**, not recursion.

With Sean's shape — 5 leads, ~6 members each — one message that fans all the way down is
`1 + 5 + 5×6 = 36` provider turns. At a conservative ~15k tokens/turn that is **~540k tokens on one
human sentence**, and nothing in the current code stops it.

**Therefore: a chain turn budget, not a rate limit.** `MAX_CHAIN_TURNS`, default **24**, carried on
the chain (not per room) and decremented across every room in it. Surface the remainder in the
model's system line the way `server/group-goal-run.ts:132` already does
(`"This is team turn N of M; K turns remain"`) — a model told it has 3 turns left behaves; a model
that hits a silent wall retries.

A rate limit is the wrong tool: `bot.busy` (`server/index.ts:3444-3459`) already guarantees one
turn per bot across both engines, so concurrency is handled. Breadth is not.

### Blast radius

A workspace chief transitively reaches every bot (her leads, their teams). Two existing controls
should become defaults for this role rather than new machinery:

- **`approvePeerComms: true` by default when a bot is promoted to workspace scope.** The gate at
  `server/index.ts:5323` puts a human card in front of each peer turn (15-min timeout → deny). The
  switch to turn it off already exists in `SettingsPanel.tsx` — the point is that the default flips
  visibly at promotion time, not that it becomes unavailable.
- **`alwaysAllow` peer grants** (`peerAllowKey`, `server/store.ts:684-700`) let Sean permanently
  approve `Ember → Rex` without approving `Ember → everyone`. Already built; surface it in the
  approval card as "always allow this pair".

One more, cheap and worth it: `delegate_room` should be callable **only** by a bot with
`chiefOfStaff === true`. `create_bot` already gates that way (`server/index.ts:5487`). A grunt with
a room-delegation verb is the whole blast radius in one tool call.

---

## 7. SEQUENCE

Smallest useful first. Steps 0–3 are each independently shippable and independently valuable.

| # | Work | Files | Ships alone? |
|---|---|---|---|
| **0** | **Room-thread delivery.** Branch `sourceBot ?? sourceGroup` at `server/index.ts:2126`, `:2222`, `:2233`. Group branch sets `unread`, no context marker. Tests 2–4. | `server/index.ts`, `server/comms.test.ts` | **Yes.** A live defect today, independent of every concept below. Fix it first. |
| **1** | **`canReach`.** Add to `server/store.ts`, swap all seven gates. Behaviour-identical until a workspace chief exists. Test 5, 6. | `store.ts`, `index.ts` ×5, `chief-of-staff.ts`, `delegations.ts` | Yes — inert by construction. |
| **2** | **`chiefScope`.** Field, scope-aware `setChiefOfStaff`, PATCH validation, load-time de-dupe at `store.ts:671-683`, **not** exported. Test 8. | `store.ts`, `index.ts:7052/7095/7164` | Yes — a flag nothing reads yet. |
| **3** | **`connectorThread` on `ask_bot`/`delegate_bot`** (`:5292`, `:5448`). Test 1. With 0 done, a room chief can now delegate and see the answer. | `index.ts` | Yes. **First step Sean can feel.** |
| **4** | **Prompts.** Chief branch in the room system prompt (`index.ts:3571`); workspace branch + grouped roster in `chief-of-staff.ts`. `create_bot` section argument. Test 7. | `chief-of-staff.ts`, `index.ts`, `agents-proxy.ts` | Yes. |
| **5** | **UI.** Scope control, split badge, exec-room action, `TeamMapPage` hoist. | `SettingsPanel.tsx`, `ChatView.tsx`, `TeamMapPage.tsx`, `lib/team-map.ts` | Yes. **Stop here and review before 6.** |
| **6** | **`delegate_room` + chain budget + visited set.** New verb, `chainDepth` and visited set on `GroupTurnOrchestration`, `MAX_ROOM_CHAIN = 2`, `MAX_CHAIN_TURNS = 24`, chief-only gate. | `index.ts`, `delegations.ts`, `agents-proxy.ts`, `group-goal-run.ts` | Last, and only after 0–5 have proven the single hop in real use. |

Steps 1 and 2 are independent of each other and of 0 — parallelizable.
Step 6 depends on all of them and is roughly as much work as 0–5 combined.

---

## 8. What could not be determined

- **The "122 live catalog entries" figure.** Locally: 116 catalog files, **28** carry
  `package.chiefOfStaff`, all in `library/assistants/`. The 59 `teams-library/teams/*.json` use a
  different format and carry none. If 122 refers to a published remote catalog it is not in this
  tree, and the compatibility argument in §2 does not depend on the count — only on
  `pkg.chiefOfStaff` staying untouched, which it does.
- **Whether `delegate_room` should reuse the delegation ledger.** `queueDelegation` /
  `drainDelegations` (`server/delegations.ts`) assume a bot target throughout — receipts, busy
  retries, `dropIfUnreachable`. Reusing it for a room target is probably right (crash safety,
  receipts) but every function needs auditing for the bot assumption. Not costed here; it is the
  bulk of the risk in step 6.
- **`approvePeerComms` interaction with a chain.** Whether the approval card should appear once per
  chain or once per hop. Once per hop is safer and probably unbearable at depth 2. Needs Sean.
- **`MAX_CHAIN_TURNS = 24` is a guess**, calibrated to `1 + 5 + 5×6 = 36` being clearly too many and
  a single fan-out to 5 leads being clearly fine. Instrument before trusting it.

---

## Appendix A — how to re-run the proofs

Both scripts are read-only against a temp `HOME` / `MURAGE_DATA_DIR`. Neither touches
`murage-app` state.

```
# Proof 1 — agents tools at hop 0 in a room, and the live ask_bot 403.
cd /Volumes/Mando/WaylandBots/murage-app
node --experimental-strip-types \
  <scratchpad>/room-hop-proof.mjs
# expect: MURAGE_TURN_DEPTH "0" on the ROOM thread in the mcpServers dump,
#         and the reply "peer says: source thread does not belong to sender"

# Proof 2 — botByThread is null for a room thread.
MURAGE_DATA_DIR=$(mktemp -d) node --experimental-strip-types \
  <scratchpad>/store-lookup-proof.ts
# expect: botByThread(room) = null ; groupByThread(room) = <id>
```
