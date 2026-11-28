# M6 settings from chat: wiring notes (MAIN-RULING 2091: M6 sends notes, each owner edits its own files)

**Owners (each side, first).**
- **M6 side (sender):** lane bld1023-settings-chat, branch `fix/1023-settings-chat`. Owns `shared/settings-chat.ts` (C-M1), `shared/settings-chat-catalog.generated.json`, `server/settings-chat/*`, `src/lib/settings-chat.ts`, `src/lib/settings-search-focus.ts`, `src/components/chat/SettingCard.tsx`.
- **core (receiver):** `server/index.ts`, `server/route-policy.ts`, `server/browser-owner-policy.ts`, `server/outside-own.ts`, `server/consuming-sink-inventory.ts`, `server/added-table-lifecycle.ts`, J0 writer table. 1.0.23 owner: **OPEN NO-OWNER** (v10 core lane closed).
- **tools (receiver):** `server/drivers/agents-proxy.ts`. 1.0.23 owner: **OPEN NO-OWNER**.
- **shell (receiver):** the chat message renderer (`settingCard` part). 1.0.23 owner: **OPEN NO-OWNER**.
- **find (receiver):** J1 "Changed recently" label line. 1.0.23 owner: **OPEN NO-OWNER**.
- **page owners (receivers):** each page that exports a `ChatControl` (botpages for `BotModelChatControl`).

Nothing below is applied on this branch. Until it is, the shipped catalog has no inline id (W9b) and no route is reachable.

## core: server/index.ts
1. Construct once after the store opens:
   `const settingsChat = createSettingsChat({ cards: openCardStore(database(), transaction), catalog: shippedCatalogInputs({ inventory: <F1>, journalWriters: Object.keys(JOURNAL_WRITERS), expectRoutes: <SV0 registry>, atomic: <W4b passes>, chatControls: <page exports>, storeBuild: <X1>, routeExists: (m, p) => Boolean(routePolicy(m, p)) }), bot: id => store.bot(id), journal: { lookup: id => journal.lookup(id) }, activeGeneration: id => internalCapabilities.activeGeneration(id), turnOrigin, threadPlace, busy, postText, postCard, dispatchWriter })`.
   - Generations are strings end to end: `internalClaim.generation` and `activeGeneration()` pass straight through; M6 stores them as TEXT and never converts them (Astra 1fbb27906d, witness W17c).
   - `turnOrigin(threadId, generation)`: `ownerText` = `ownerTurnText(...)` returned text and the trigger is `role: "user"` with `isOwnerOrigin(origin)`; `ownerVoice` = owner trigger with no text; `noLimitsOrigin` = `decisionNoLimitsOrigin(decisionProvenance.get(generation))`; `depth` = `internalClaim.depth`; `internalEvent` = `Boolean(internalClaim.internalEventId)`.
   - `threadPlace`: `owner` only for the bot's direct thread or one of its task threads; channel threads (Telegram, Slack, Discord, WhatsApp) `channel`; group and room threads `group`.
   - `busy(bot, target)`: the bot writer's busy check for `bot` (the `:5890` 409 predicate), `directThreadBusy(bot.id, task.threadId)` for `task`.
   - `dispatchWriter({method, path, body, expect, changeId})`: **re-enter the writer's own HTTP handler** with the card request's headers (same surface, ownerActs, cloud identity), the writer body plus `expect` and `changeId`, so every in-handler gate runs (browserStandingRefusal, the `Choose a thread` 409, the task writer's desktop 404 and busy 409, draftOnlySettingsLift, field allow-list, revokeInternalBot). Map SV0's stale-expect 409 to `{status: 409, stale: true, live}`; any other answer to `{status, error}`. The J0 row must carry `actor {kind: "owner"}`, `writer: "chat-card"`, the card's `changeId`.
2. Inside the `/api/internal` block, after `requireActiveInternal()` and the generation compare: `const sc = await settingsChat.internalRoute({ method, path, readBody: max => readBody(req, max) }, { threadId: internalClaim.threadId, botId: internalClaim.botId, generation: internalClaim.generation }); if (sc) return json(res, sc.status, sc.body);`
3. Card routes (outside the internal block): `const card = await settingsChat.cardRoute({ method, path, readBody: max => readBody(req, max) }, { mayApprove: mayApprove(req, url), caller }); if (card) return json(res, card.status, card.body);` where `caller` is `{kind: "local", route: <RouteCaller>, surface: requestSurface(req.headers, url.searchParams)}` locally, or on a Cloud home `{kind: "cloud", scope: ownerBrowserScope(cloudIdentity(req.headers)) ?? <device scope>, surface}`. Never forward the card request's step-up proof (Opus r2 M1).
4. `server/added-table-lifecycle.ts`: register `settings_chat_cards` (DDL in `server/settings-chat/cards.ts`).

## core: route-policy / browser-owner-policy / outside-own / consuming-sink-inventory
- `server/route-policy.ts`: `GET /api/settings-chat/cards/:id` and `POST /api/settings-chat/cards/:id/(apply|dismiss)`, `class: "companion"`, `cloudWrite: "ordinary"`. `POST /api/internal/settings-chat/(find|show)` falls under the `/api/internal` entry (class `internal`).
- `server/browser-owner-policy.ts` `BROWSER_OWNER_RULES`: the card paths, `plain` (the inner gate decides per field).
- `server/outside-own.ts`: both internal paths map to tool name `murage_settings`.
- `server/consuming-sink-inventory.ts` `INTERNAL_HTTP_ROUTES`: both internal paths (Opus r2 L1; `registeredInternalRoute` denies unregistered paths).
- J0 writer table: one row `chat-card` (source `settings-chat`, value mode per the writer). No C12 field.

## tools: server/drivers/agents-proxy.ts
One `TOOLS` entry `murage_settings`: `{action: "find" | "show", query?, settingRef?, reason?}`, `additionalProperties: false`, no thread, bot, origin or value argument. The handler only forwards `find {query}` or `show {settingRef, reason}` to `/api/internal/settings-chat/{find,show}` with the turn's capability. Tool copy: "Find a Murage setting, or show the owner the setting's own control in this chat so they can change it themselves. You cannot change settings. Use find first; show only when the owner asked to change something or agreed to see it."

## shell: message renderer
One case for a `settingCard` part `{cardId}`: fetch `GET /api/settings-chat/cards/:id` and render `<SettingCard view botName openAddress={href => openSettingsAddress(parseSettingsAddress(href)!, ctx, dispatch)} />`. Refetch on turn-state change (busy) and after a tap.

## find: J1 label
A J0 row with `writer === "chat-card"` reads "You, from chat with <bot name>" via `cards.cardByChangeId(row.changeId)?.botId`; when it returns nothing, "You, from chat". Never take the bot from the row's `bot` field.

## page owners
Export the page's own control as a `ChatControl` and register it in `CHAT_CONTROLS` (`src/components/chat/SettingCard.tsx`); add its name to the catalog's `chatControls` input. A page with no export stays `open`.

## Finish gate (integration branch)
`bot.model` turns inline per writer target only when F1 (inventory record `immediate`), J0 (`chat-card` row), SV0 (`expect` on that writer), the page `ChatControl`, and **W4b** (kill between setting write and J0 row: both or neither) all hold. The task target stays `open` until its own writer passes (Fable r2 M1).
