# Murage for Chrome: store listing for 1.0.0

Status: prepared text, not submitted. Nothing is uploaded from a build session. The production extension ID and public key do not exist yet (decision D5: Sean is setting up the publisher). Wherever one is needed this file says `<<PRODUCTION-ID>>` or `<<PUBLIC-KEY>>`, and `release.json` keeps its placeholders until they arrive. Edge Add-ons is a separate later item, named "Murage for Edge". Nothing here asserts store approval.

Name: **Murage for Chrome**. The word "in" is never used in the name. Chrome Web Store branding allows "for Chrome"; a name that starts with "Chrome" is not allowed.

Version for submission: **1.0.0** (decision D9). `manifest.json` still says 0.1.0 and `minimum_chrome_version` 151; the manifest bump and the `"incognito": "not_allowed"` key belong to lane EXT0, not to this file. The listing text below is checked line by line in the claims matrix (section 7). A sentence marked `[ships with ...]` is kept only if that lane merges and its test is green in the final pass; otherwise the sentence is removed, not softened.

Copy rules this file follows: no em dashes, none of the banned words from the house copy rules, no cost talk, no claim of continuous or self-improving operation, and limits are described as strengths of an honest design, not as breakage.

## 1. Summary

Summary (126 characters, limit 132):
Let your Murage bots work in the browser tabs you choose, with approvals, hand-backs for human-only steps, and Pause and Stop.

## 2. Detailed description

```
Murage for Chrome lets the bots in your Murage desktop app work in your own Chrome, signed in as you, in the tabs you choose, while you stay in charge.

How it works
- Ask a bot in Murage to use your browser. It offers a one-time setup. Setting up is optional, and your request stays in the conversation if you say no.
- Share a tab from the side panel. A bot only works in tabs you share. Moving a tab into the Murage tab group does not share it, and one bot cannot use another bot's tabs.
- Three levels of care. Reading, scrolling and opening pages on a site you allowed need no question. The first time a task needs to click or type on a site, Murage asks once for that task. Sending, submitting, posting, deleting and buying ask you each time.
- Downloads a bot starts are blocked.
- Things only a person can do stay with you. Agreeing to terms, privacy policies or cookie choices, proving you are human, and entering passwords, codes, card or ID details are handed to you with a "Your turn" card. The bot waits for you, and carries on after you press Continue. [ships with C2 and PNL-2]
- Banking, payment, health and government sites ask before every click or typing step. Password managers and similar sites are handed to you entirely.
- Full permissive is a setting you turn on per bot in the Murage app on your computer, with a typed confirmation. It is off by default and a phone cannot turn it on. It removes the question for ordinary steps. A send or delete still goes ahead only when the intent check and the action check both allow it, and Your turn steps always come to you.
- An action check looks at steps that change things before they run, against what you asked for, and can only make Murage ask more, never less. It runs on Flux, a Ferrox Labs service, when Flux is live, otherwise on the bot's own engine. If neither can run, Murage asks at each step. [ships with DESK, per D3]
- You can see when a bot is driving: a named Murage tab group, a Murage-styled cue at the page edge, the bot's own pointer with its name, and a small bar with Pause and Stop.
- Pause or Stop at any time, from the page, the side panel, the Murage app or your phone. Stop ends the task; start a new one any time. Stop takes effect in your browser even if Murage is closed.
- Typing, clicking or scrolling in a page a bot is using pauses the bot. An activity log in Murage shows what each bot did and where, never what you typed.
- Murage for Chrome does not run in Incognito windows. [ships with EXT0 and X1]

What you need
- The Murage desktop app, installed and running on the same computer. The extension talks only to that app, through a local helper Murage registers when you choose Set up. There is no web service in between.
- Chrome 151 or later.
- [PENDING VM PROOF] Add "It also works in Microsoft Edge and Brave." only after both are proved. Add "Qualified on Mac (Apple Silicon) and Windows (x64)." only after the Windows proof passes. Until then the listing makes no platform claim beyond Chrome 151 or later.

What it does not do
- It has no tool to read your passwords or cookies. Pages that ask for passwords or payment details are handed back to you.
- It does not control tabs you have not shared.
- It does not hide that it is working. Chrome shows its own "started debugging this browser" bar while a bot drives a tab, and a website can tell that the Murage page cue is present.
- Some websites limit automated use, and some content cannot be seen by the bot (see Limits).

Your data
Text, screenshots and addresses from the tabs you share go to Murage on your computer, and from there into the bot's conversation and the AI model provider you chose in Murage. The action check sends a short description of the step to Flux, a Ferrox Labs service, or to the bot's own engine. Nothing is sold. See the privacy policy.
```

## 3. Single purpose

Connect owner-selected browser tabs to the Murage desktop app so its bots can carry out owner-approved browser tasks, with visible presence and Pause and Stop controls.

## 4. Permission justifications (all 10 in the current manifest)

Paste each into the dashboard's per-permission field. The manifest has no `host_permissions`, content scripts, `scripting` or externally connectable origins. Do not present that as "no site access": the `debugger` permission reaches any tab the owner shares. `commands` is a manifest section, not a permission, so it adds no install warning.

| Permission | Justification | Code |
| --- | --- | --- |
| `debugger` | Murage bots work only in tabs the owner has shared. The extension attaches the debugger to those tabs to read the page (text, accessibility tree, screenshots), draw the Murage page cue and pointer, and perform the steps the owner has approved, such as opening a page, filling a field or clicking a button. It never attaches to tabs the owner has not shared, detaches after a short idle period and on Stop, and refuses any command outside a fixed list of page, DOM, accessibility, input and screenshot calls. Chrome's own debugging bar stays visible while it is attached. | `runtime.mjs:17-25` (fixed command list), `:406-418` (idle detach), `:800` (`detached` pauses) |
| `tabs` | Identify the tabs the owner shares, open tabs for a shared task, and check each tab's address before and after a step so an approval never carries over to a different page. Tab metadata is not itself authorization. | `runtime.mjs:270` (tab ownership), `:679` |
| `tabGroups` | Put the tabs a bot works in into one group named Murage, with a working, paused, stopped, done or your-turn marker in its title. Group membership never grants access by itself. | `tab-group.mjs`, `_locales/en/messages.json` `groupSuffix*` |
| `nativeMessaging` | Talk to the Murage desktop app on the same computer through its local helper. This is the only channel to Murage. The helper authenticates to the app and no network port is opened. | `service-worker.mjs`, `scripts/browser-extension-host-registration.mjs` |
| `storage` | Remember the browser profile identity, which tabs are shared with which bot, the owner's site choices and the Pause and Stop state, so Stop survives a browser restart. Page contents and screenshots are not stored by the extension. | `runtime.mjs:98-101` (save), `:747` (restore) |
| `sidePanel` | Show the controls: connection state, which bot has which tab, Share, Pause, Resume, Stop, the current task and its approvals, and Continue after a Your turn handover. | `sidepanel/view.mjs`, `service-worker.mjs:80` |
| `webNavigation` | Notice when a shared tab navigates or opens a new tab, so pending steps and page references for the old page are cancelled instead of being applied to the new page. | `service-worker.mjs:67,77`, `runtime.mjs:290` |
| `alarms` | Wake the extension every 30 seconds so it can reconnect after Murage restarts or updates, and apply a waiting extension update once no bot is driving. The alarm reads no page, tab or user data. | `service-worker.mjs:83-87` |
| `downloads` | Notice a download that a tab a bot is working in starts, and cancel it, so a page cannot save a file to the computer on a bot's behalf. A download the owner starts in a tab no bot is working in is left alone. The extension reads only the download's address, referrer and file name to decide, reports the file name (cut to 80 characters) and site to Murage so the bot can say what was blocked, and keeps no download history. | `runtime.mjs:133-176`, `:732`, `service-worker.mjs:68-73` |
| `idle` | Notice when the computer was locked and becomes active again, so a paused task stays paused and the connection to Murage is checked again. It reads no page content. | `service-worker.mjs:95-101` |
| (section) `commands` | A keyboard shortcut (default Alt+Shift+P) that pauses the bot that is driving. | `service-worker.mjs:102`, `manifest.json` |

The earlier draft also promised that a download "the bot asked for" is approved in Murage and saved in a per-bot folder. No such flow exists (`grep browser-downloads` finds no code), so that sentence is cut. A bot cannot download in 1.0.0.

## 5. Remote code

Recommended dashboard answer: "Yes, I am using remote code", with this justification. Do not answer "no" only because the package has no remote script tags.

> All of the extension's own JavaScript is bundled in the package; nothing is fetched from a server. Through the debugger permission, the extension relays Chrome DevTools Protocol commands (including page evaluation used to read page structure and perform approved steps) that the Murage desktop app on the same computer sends over native messaging. Those command strings come only from code packaged inside the Murage app: the bot can name a tool such as click or read, but cannot send its own script, and the extension refuses any command outside a fixed list. Commands apply only to tabs the owner has shared, pass the owner's site and step approvals in Murage, and stop immediately on Pause or Stop.

Proof: the bot-facing tool list has no evaluate tool (`server/browser-extension-engine.ts:17`); expressions are written by `server/browser-extension-executor.ts:121,148,158,161` and `server/browser-extension-page-scripts.ts`; the extension's fixed list is `runtime.mjs:17-25`; `scripts/browser-extension-runtime.test.mjs:46` ("rejects stale documents, cookie interfaces and alien execution contexts").

## 6. Data inventory

Every category of data the extension or its server side touches, where it comes from, where it goes, how long it stays, and the line that does it. "App" is the Murage desktop app on the owner's computer. The extension has no telemetry and no network access of its own (no `host_permissions`, `fetch` is not used by the extension; the only channel is native messaging).

| # | Category (dashboard term) | Source | Destination | Retention | Code |
| --- | --- | --- | --- | --- | --- |
| D1 | Web history: address and title of each shared tab, and of tabs a bot opens | The shared tab | App, over native messaging | Extension: in `chrome.storage.local` (address and origin only) until the extension is removed. App: `DATA_DIR/browser-extension/state.json`, until the connection or bot is removed, never backed up | `runtime.mjs:98-101`, `:121`; `server/data-dir-inventory.ts:166`; `server/installation-restore-preparation.ts:30` |
| D2 | Website content: page text, structure (accessibility tree), screenshots, when a bot reads a page | The shared tab, on a bot's read | App, then into the bot's conversation, then the AI model provider the owner chose | Conversation: on the owner's computer until the conversation is deleted. Provider: the provider's own terms. The extension stores none of it | `runtime.mjs:579-595` (screenshot, JPEG, masks), `server/browser-extension-service.ts:534-559` (`deliver`: probe, fence, hand to the bot), `server/browser-extension-snapshot.ts:70-103` (password and sensitive values withheld) |
| D3 | Personally identifiable info, authentication info, financial and payment info, personal communications, health: whatever appears in D2 text | Inside the page the owner shared | Same route as D2 | Same as D2 | Same lines as D2. `deliver()` has no field-level redaction; the dashboard answers are "yes" (D4) |
| D4 | User activity: that the owner typed, clicked, scrolled or touched a page a bot is using (never what was typed) | Trusted input events in the shared tab | App, as a "pause" signal | Not kept by the extension; the app records the pause in the activity log (D6) | `takeover.mjs:7-14` (events), `runtime.mjs:726,732` |
| D5 | Page notices: a blocked download's file name (80 characters) and site; text of a JavaScript dialog (500 characters) | The shared tab | App, then to the bot as a fenced note | Conversation retention (D2) | `runtime.mjs:146,168,732,733`, `server/browser-extension-service.ts:88` |
| D6 | Activity log: when, site, kind of action, the control's name (marked when it came from the page), level, who decided, outcome; for typing only the number of characters | App, per action | `DATA_DIR/browser-extension/activity/` | 30 days, at most 2,000 lines per log, 512 bytes per line, never backed up | `server/browser-extension-activity.ts:13-15`; tests `server/browser-extension-activity.test.ts:32,48,62,72,121` |
| D7 | Action check: the owner's words for the task (up to 4,000 characters), standing browser instructions (2,000), the step (kind, level, site, the control's name cut to 300 characters and marked as page-derived, the destination as address plus query-parameter names, typed-text length, and for a send up to 200 characters of the assistant's text; "hidden" for a sensitive field) | App | Flux (a Ferrox Labs service) when live, otherwise the bot's own engine. No screenshot, cookie, page text or bot reasoning | Flux retention: **needs the owner's confirmation** (the no-retain header is sent, `FLUX_NO_RETAIN_DEPLOYED` is still false, `server/browser-extension-check-availability.ts:5`). Own engine: that engine's terms | `server/browser-action-checker.ts:41,56-83`; `server/browser-action-checker-connection.ts:121` |
| D8 | Diagnostics: connection and error codes in the app's own logs | App | App log on the owner's computer | App log policy. Not sent to Ferrox Labs by the extension | `server/browser-extension-integration.ts`, `server/redact.ts`. Open item: the audit (SEC-006) found diagnostics are not run through the browser secret classifier; the OUT lane owns the fix, and this row is re-checked in the final pass |
| D9 | Extension state: profile identity, shared tabs per bot, site choices, Pause and Stop state | Extension | `chrome.storage.local`; mirrored in the app (`state.json`, `sites.json`) | Until the extension is removed (extension); until removed or revoked (app); never backed up | `runtime.mjs:98-101,747`; `server/data-dir-inventory.ts:166` |
| D10 | Location | Not collected | Not applicable | Not applicable | No geolocation call anywhere in the extension or `server/browser-*.ts`; `Emulation.*` is limited to device size and media (`runtime.mjs:24`). `grep -ri geolocation` finds nothing |

Not collected, not stored, not sent: cookies, saved passwords, form values of sensitive fields, request headers, response bodies, console output (`scripts/browser-extension-runtime.test.mjs:166` "only emits scoped CDP metadata without headers, response bodies or console content"), and any data from tabs that are not shared.

## 7. Claims matrix

Every sentence and caption in the listing, with the behaviour that ships at `b569630c` plus the test that proves it. Status: **PROVED** (behaviour and test exist at `b569630c`), **LANE** (the behaviour or its proof arrives with the named lane; the sentence stays in the draft only until the final pass confirms it), **CUT** (does not ship; removed). T51 means the real-Chrome qualification pass.

| # | Claim | Shipped behaviour | Proving test | Status |
| --- | --- | --- | --- | --- |
| C01 | Bots work in your own Chrome, signed in as you, in tabs you choose | Debugger attaches only to explicitly owned tabs | `scripts/browser-extension-runtime.test.mjs:43,45` | PROVED |
| C02 | Setup is optional, and your request stays in the conversation if you say no | Setup card with Not now; decline continues the transcript | `server/browser-extension-setup.test.ts:9,47`; `src/components/BrowserSetupCard.test.ts:11` | PROVED |
| C03 | Moving a tab into the Murage group does not share it | Share is explicit; group membership grants nothing | `scripts/browser-extension-runtime.test.mjs:44`; `sidepanel/view.mjs` hint `spShareHint` | PROVED |
| C04 | One bot cannot use another bot's tabs | A tab is owned by one binding | `runtime.mjs:270`; `scripts/browser-extension-runtime.test.mjs:43`; `scripts/browser-extension-lifecycle.test.mjs` ("unbind frees the tab owner so another binding can share the tab") | PROVED |
| C05 | Reading, scrolling and opening on an allowed site need no question | L1 is free in every mode | `server/browser-levels.test.ts:329,333` | PROVED |
| C06 | First click or typing on a site asks once for the task | Task mode: first L2 is a card, then silent | `server/browser-levels.test.ts:347,351`; `server/browser-extension-modes.test.ts:119` | PROVED |
| C07 | Sending, submitting, posting, deleting and buying ask you each time | L3 is a card per action in Ask each step and Ask once per task. In Full permissive it passes only when intent and checker both allow | `server/browser-levels.test.ts:343,363`; `server/browser-extension-modes.test.ts:93`. Pending D1: delete and similar may move to always-ask | PROVED (wording scoped to the two default modes plus the Full sentence) |
| C08 | "Downloading" asks each time | Cut. Downloads a bot starts are cancelled, so there is nothing to approve | n/a | CUT (replaced by C09, per D6) |
| C09 | Downloads a bot starts are blocked | `Page.downloadWillBegin` on an attached tab and `downloads.onDeterminingFilename` cancel and erase the item | `scripts/browser-extension-chromereal.test.mjs:96-113,198-203`. Not claimed: blocking a download started in a tab no bot is working in; that is left alone (`:108`). Real-Chrome proof owed to T51 | PROVED (unit), T51 for Chrome |
| C10 | Terms, privacy and cookie choices, human checks, passwords, codes, card and ID entry are handed to you | The hard floor classifier pauses the binding with reason `handoff` and sends no input | `server/browser-extension-floor-flow.test.ts:69,85,234,246`; `server/browser-levels.test.ts:246,278` | PROVED |
| C11 | The bot waits for you | Binding paused with `pausedReason: handoff`; tool text tells the bot to end its turn | `server/browser-extension-floor-flow.test.ts:105,234,283` | PROVED |
| C12 | ...and carries on after you press Continue | The Continue button renders only when the runtime lists a `continue` action; no server code serves it at `b569630c` (`owner_continue` is emitted at `runtime.mjs:726` and read nowhere). The owner Resume path exists | `sidepanel/sidepanel.node-test.mjs:99`; `src/components/BrowserCards.test.ts:144-167` (render only) | LANE (C2 and PNL-2, per D6; cut if T51 does not prove it) |
| C13 | Banking, payment, health, government sites ask before every click or typing step | `askEveryStep` category: a card for L2 and L3 in every mode, grants notwithstanding; reads stay free | `server/browser-levels.test.ts:333,385`; `server/browser-extension-modes.test.ts:119,124`; `shared/browser-site-categories.test.ts:170` | PROVED |
| C14 | Password managers and similar sites are handed to you entirely | `handover` and `neverDefault` categories refuse in every mode | `server/browser-extension-modes.test.ts:132,146,159`; `server/browser-levels.test.ts:394` | PROVED |
| C15 | Full permissive: per bot, in the app on the computer, typed confirmation, off by default, a phone cannot turn it on | Mode route is desktop class and needs the bot's typed name; default mode is task | `server/browser-extension-mode-api.test.ts:44,49,58,68,88,215` | PROVED |
| C16 | Full permissive: a send or delete goes ahead only when intent and action check both allow; Your turn still comes to you | `cardFor` mode full: intent must pass, L3 needs checker allow; floor ignores mode | `server/browser-levels.test.ts:369,374,313`; `server/browser-extension-modes.test.ts:93,102,108` | PROVED |
| C17 | An action check looks at steps that change things before they run | Checker runs for L2 and L3 and is ignored for L1 reads | `server/browser-levels.test.ts:410,420`; `server/browser-action-checker.test.ts` | PROVED (mechanism). Default availability is open: see C19 |
| C18 | The check can only make Murage ask more, never less | intent card or refuse, checker ask or block only tighten | `server/browser-levels.test.ts:289,299,410` | PROVED |
| C19 | It runs on Flux when live, otherwise on the bot's own engine; if neither can run, Murage asks at each step | At `b569630c`, with `check` set to flux and no-retain not deployed, the check is unavailable and the bot works in Ask each step. The automatic hand-over to the bot's own engine (D3) is not built | `server/browser-extension-mode-api.test.ts:254` (reports unavailable with a reason); `server/browser-action-checker-connection.test.ts:20,23,48,84` (fails closed) | LANE (DESK, per D3). Only the last clause ("asks at each step") is true today |
| C20 | A "second check on each step" | Cut. Replaced by C17 and C19 wording (D6) | n/a | CUT |
| C21 | A named Murage tab group, with a state marker | Group title `Murage`, `Murage · <bot>`, suffixes working, paused, stopped, your turn, done | `scripts/browser-extension-tab-group.test.mjs:8-13`; `scripts/browser-extension-locales.test.mjs` | PROVED |
| C22 | A Murage-styled cue at the page edge, and the bot's pointer with its name | Presence overlay: frame, glow, pointer with the bot's initial, name label | `scripts/browser-extension-presence.test.mjs:53,60,150,156` | PROVED |
| C23 | A small bar with Pause and Stop | Overlay pill with Pause and Stop, accepted only from the presence world | `scripts/browser-extension-presence.test.mjs:259,268` | PROVED |
| C24 | Pause or Stop from the page, the side panel, the app or your phone | Page pill; side panel buttons; app Browser panel; paired phone through the companion route | `scripts/browser-extension-presence.test.mjs:259,268`; `sidepanel/sidepanel.node-test.mjs:151`; `server/browser-extension-phone.test.ts:129`; `src/components/BrowserExtensionPanel.test.ts` | PROVED |
| C25 | Stop ends the task; start a new one any time | A stopped binding is never resumed; the extension reports `taskEnded`; Stop is persisted | `server/browser-extension-durable.test.ts:117`; `server/browser-extension-floor-flow.test.ts:297`; `extensions/murage-browser/sidepanel/sidepanel.node-test.mjs:21`. Start-again button is RES-003 (C2, X1, DESK, PNL) | PROVED for "ends the task"; LANE for any in-panel start-again control |
| C26 | "Stop stays in effect until you resume" | Cut. Resume after Stop is refused (`server/browser-extension-service.ts:293`) | n/a | CUT (D6) |
| C27 | Stop takes effect in your browser even if Murage is closed | Stop is applied locally and stored | `scripts/browser-extension-runtime.test.mjs:47,66` | PROVED |
| C28 | Typing, clicking or scrolling in a page a bot is using pauses the bot | Takeover observer on pointerdown, keydown, beforeinput, wheel, touchstart; unexpected trusted input latches pause | `scripts/browser-extension-runtime.test.mjs:180,237,244,249` | PROVED |
| C29 | The activity log shows what each bot did and where, never what you typed | Allow-listed fields, text length only | `server/browser-extension-activity.test.ts:24,32,48` | PROVED |
| C30 | Does not run in Incognito | No `incognito` key in the manifest and no runtime check at `b569630c` | None yet | LANE (EXT0 manifest, X1 runtime, per D7) |
| C31 | Extension talks only to the Murage app, through a local helper; no web service in between; no network port | Native messaging with `allowed_origins` for the item ID only; the helper authenticates to the app | `scripts/browser-extension-host-registration.node-test.mjs:10-11`; `server/browser-extension-native-acceptor.test.ts` | PROVED |
| C32 | Chrome 151 or later | `minimum_chrome_version` 151 | Enforced by Chrome; manifest `manifest.json:5` | PROVED |
| C33 | No tool to read your passwords or cookies; password values are withheld | Fixed command list has no cookie or storage calls; password and sensitive values are replaced with a hidden marker in page reads | `scripts/browser-extension-runtime.test.mjs:46`; `server/browser-extension-snapshot.test.ts:58` | PROVED. Wording is "no tool to read", not "cannot see": a password can still appear as page text |
| C34 | Screenshots cover password and card fields and frames the extension cannot check | Capture mode draws opaque boxes; frames from other sites are masked or the capture is refused | `scripts/browser-extension-presence.test.mjs:65,320`; `scripts/browser-extension-runtime.test.mjs:271` | PROVED for open shadow roots and normal frames; not claimed for closed shadow roots, canvas or images (see Limits) |
| C35 | Nothing is sold; no telemetry | The extension has no network access and no analytics code | `grep -n "fetch\|XMLHttpRequest\|sendBeacon" extensions/murage-browser/*.mjs` finds no network call | PROVED by code reading; the final pass re-runs the grep on the built package |
| C36 | Text, screenshots and addresses go to Murage, then the model provider the owner chose | `deliver()` hands page text to the bot with no field-level redaction | `server/browser-extension-service.ts:534-559`; `server/browser-extension-engine-read.test.ts` | PROVED (it is a disclosure, not a promise to withhold) |
| C37 | Screenshots in the store gallery | See `store-assets/README.md`. Shots of Continue, the side panel and the page cue wait for C2, PNL-2 and the T30A pick | n/a | LANE (T51 captures) |

Claims cut or changed from the 0.1.62 draft: C08 (downloading asks each time), C20 ("a second check on each step"), C26 ("Stop stays in effect until you resume"), the downloads justification about bot-requested downloads and a per-bot folder, "It does not read your passwords or cookies" (now "no tool to read", C33), "Banking ... ask at every step" (now "before every click or typing step", reads are free), "Full permissive is an owner-only setting" (now says where and how, C15), "Typing or clicking ... pauses" (now includes scrolling, C28), and the Cancel-on-debugging-bar sentence (it pauses the bot; it does not remove the extension).

## 8. Privacy practices answers

Per decision D4 (Sean). The code agrees with every answer.

| Dashboard item | Answer | Why, in one line |
| --- | --- | --- |
| Personally identifiable information | **Yes** | Page text of a shared tab goes to the app and the model provider, and `deliver()` does not redact fields (D3) |
| Health information | **Yes** | Same route (D3) |
| Financial and payment information | **Yes** | Same route (D3) |
| Authentication information | **Yes** | Same route. Password values are withheld, but other secrets can be page text (D3, C33) |
| Personal communications | **Yes** | Same route (D3) |
| Location | **No** | No geolocation call and no use of IP address for location (D10) |
| Web history | Yes | D1 |
| User activity | Yes | D4 |
| Website content | Yes | D2 |

Certifications: tick all three. No sale or transfer outside approved use (the model provider is the owner's choice and is part of the single purpose); no use unrelated to the single purpose; no use for creditworthiness or lending.

Privacy policy: the section in `docs/murage-for-chrome-privacy.md`, published on murage.ai before submission. The live page is `https://murage.ai/privacy-policy` (the shorter `/privacy` is not a route on the site). Support: `https://murage.ai/contact`.

## 9. Limits (stated plainly in the listing and the policy)

- Closed shadow roots: Chrome gives no handle into a web component whose shadow root is closed. The bot cannot target controls inside one, and screenshot masking of sensitive fields cannot reach a frame inside one. Murage refuses to act on a target inside one and covers every frame it cannot open with an opaque box in screenshots. Canvas and image content is not masked.
- The extension does not hide Chrome's "started debugging this browser" bar. Pressing Cancel on that bar pauses the bot at once (`runtime.mjs:800`, side panel text `spDebugNote`). Real-Chrome proof is owed to T51.
- A page can tell that the Murage page cue is on it, because the cue is an element on the page. The listing never claims the bot is invisible to websites.
- An accepted action cannot be undone by Stop. Stop prevents the next one.
- Automatic takeover detection cannot tell an identical human action that arrives during an automated one (`scripts/browser-extension-runtime.test.mjs:263`). Pause before typing anything private.
- Platforms: proved on Mac (Apple Silicon) with Chrome. Edge, Brave and Windows claims stay out until each has a recorded proof.
- Incognito: not allowed in 1.0.0 (D7), once EXT0 and X1 merge.

## 10. ID-dependent steps (blocked on D5)

None of these are done. Each waits for the production item ID and public key.

| Step | Placeholder | Where |
| --- | --- | --- |
| Fill `release.json` | `productionIds: ["<<PRODUCTION-ID>>"]`, `publicKey: "<<PUBLIC-KEY>>"` | `extensions/murage-browser/release.json` (still holds `REPLACE_WITH_...`; the release guard refuses it) |
| `parseReleaseConfig` passes | needs both values | `scripts/browser-extension-release-config.mjs` |
| Release-mode build on the build host yields a manifest `key` and helper `allowed_origins` matching the ID | needs both values | `scripts/prepare-browser-extension.mjs`, `scripts/browser-extension-host-registration.mjs` |
| `server/browser-extension-listing.test.ts` green on the real ID | `chromeWebStoreId` | `server/browser-extension-listing.ts` |
| Store URL in the app | `https://chromewebstore.google.com/detail/<<PRODUCTION-ID>>`, shown only when the `murage-for-chrome-listed` announcement flag is on | `server/browser-extension-listing.ts:41` |

Never upload from a build session. Owner steps for creating the publisher and the bootstrap draft are in `lanes/chromeplan/D5-PUBLISHER-STEPS.md`.

## 11. Remaining gates before the final submission

- Final claims pass against the built package after every feature lane: C12, C19, C30, C37 and any LANE row either turn PROVED or the sentence is removed.
- Opus copy and claims review of this file and `docs/murage-for-chrome-privacy.md`.
- Flux retention wording confirmed by the owner (D7 row in section 6).
- Privacy page on murage.ai updated and deployed before review (the reviewer compares policy with the privacy answers).
- Screenshots captured from the release build (T51). Shot list in `store-assets/README.md`.
- Reviewer download and a reviewer model account (see `lanes/chrome/CWS-SUBMISSION.md`).
- Windows, Edge and Brave proofs, or those claims stay out.
