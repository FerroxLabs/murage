# Use my Chrome 1.0.7: the bot works in tabs of its own (v3)

Branch fix/107-owner-chrome-tab-scope, base fix/107-use-my-chrome 1f556fa95. v1 (scope the page check, engine still sees every tab) got Grok REVISE: browser-level target info and the enable event streams reach the engine for owner tabs that never join the scope. v2 removes owner tabs from the engine's view instead. v3 (after v2 REVISE): every paused non-bot target is resumed, and a closed bot tab refuses once.

## What the owner meets today
On the remote-debugging route, `BrowserDocumentGuard.protected()` attaches to every page in the owner's Chrome and refuses with more than 20. Real Chrome 156 with 25 owner tabs: the first step fails, the bot is told "The owner's Chrome did not let Murage connect" (Chrome had allowed it), the disarm fails too, and every later call is locked as a sensitive page. Probe (10 tabs): the engine attaches to every owner tab, enables Page, Runtime and Network events on each, then works in its own `Target.createTarget` tab. `tab_switch` reaches owner tabs with `Page.bringToFront`.

## Change: the proxy shows the engine only the bot's tabs (server/user-chrome-proxy.ts)
1. **Bot tabs.** A page is a bot tab when the engine's `Target.createTarget` answers with it, or when Chrome reports a new page whose `openerId` is a bot tab (a popup the bot's page opened). Nothing else joins. The set is kept across engine restarts and cleared when Chrome's connection closes. A bot tab leaves the set when Chrome destroys it.
2. **Browser-level messages to the engine** (no sessionId):
   - The `Target.getTargets` answer lists bot tabs only.
   - Any event naming a target (`params.targetId` or `params.targetInfo.targetId`: targetCreated, targetInfoChanged, targetDestroyed, targetCrashed, attachedToTarget, detachedFromTarget) is delivered only for a bot tab.
   - An auto-attach to ANY target that is not a bot tab (a page, a service worker, any type Chrome paused for the engine) is answered by the proxy: `Runtime.runIfWaitingForDebugger`, then `Target.detachFromTarget`. Held auto-attaches get the same when the createTarget answers (success or error) and when the engine disconnects. Nothing of the owner's waits on a debugger.
   - Chrome announces a created page before it answers `createTarget`. While an engine `createTarget` is in flight, events for unknown pages are held. On the answer, the new tab's events are delivered and the rest follow rule 1 or are dropped.
3. **Engine commands.** A command whose `params.targetId` names a target that is not a bot tab (attachToTarget, activateTarget, closeTarget, getTargetInfo and the rest) is answered with Chrome's own "No target with given id found" and never sent. `Target.attachToBrowserTarget` is refused, so no session sees the unfiltered list. Session commands need no filter, because the engine can attach only to bot tabs, and child sessions belong to their page.
4. **The page check** gets `scope: () => proxy.botTargets()` (spec field `guardScope` beside `guardCdpUrl`, remote-debugging route only). It checks and arms the scoped pages only, with the 20 cap on them. The proxy also counts bot tabs that closed (`botScope().closed`). If that count moved since the check last looked, or a scoped tab is missing from Chrome's list, the check refuses once: a closed tab may hold what the step read, as today's zero-pages refusal. An empty set with no closed tab answers false (nothing opened or read yet), so the first step can start. Own-browser and cloud routes are unchanged.
5. **Plain words** (server/index.ts ownChrome catch): Allow or remote-debugging-off wording only while the proxy is not "allowed"; otherwise the generic not-answering path. (Grok r1 CONFIRMED this cannot hide a real Allow or off state.)
6. **Copy** (MyChromeConsent): "Chrome asks you once to Allow it, {bot} then works in tabs it opens, your own tabs stay yours, and one bot at a time can use it." This matches the first line ("in a tab of its own") and the extension route, where the owner shares tabs.

## Parity notes (v1 r1 Medium)
- A bot tab is first armed at the step after it opens, as today for any new tab. Owner tabs are no longer reachable, so v1's named decision is gone.
- A bot tab that closes during a step refuses that step once (it cannot be checked). Today a closed tab among others is skipped, and zero pages refuses, so this is stricter than today. A tab_close step reports a refusal, and the next step goes on.
- Cookies and storage of the profile are shared by the bot's tabs by design ("signed in as you"). That is unchanged.

## Tests
- Proxy unit (fake Chrome WebSocket): getTargets lists only bot tabs; owner-tab events are dropped; an auto-attach to an owner tab is resumed and detached, never delivered; attachToTarget, activateTarget and closeTarget on an owner tab are refused unsent; attachToBrowserTarget is refused; createTarget events held then delivered; a popup from a bot tab joins; a destroyed bot tab leaves; the set survives an engine reconnect and clears on Chrome close; guard traffic is unfiltered.
- Guard unit: with `scope`, only scoped pages are attached; empty scope with nothing closed answers false; a closed or unlisted bot tab refuses once; more than 20 scoped pages throw.
- Index mapping: an error while allowed is not worded as Allow.
- Real Chrome (chromereal, opt-in): 25 owner tabs, one with a password field. One Allow. The bot opens and reads its own tab; tab_list shows only its tabs; a switch to an owner tab fails; the owner's tabs are untouched.
