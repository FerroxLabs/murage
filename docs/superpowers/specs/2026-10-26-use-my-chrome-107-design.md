# Use my Chrome goes through Murage for Chrome (1.0.7), r2

Reported by Sean on 1.0.6: "Use my Chrome (remote debugging)" locked the Profile picker, Chrome asked "Allow remote debugging?" over and over, the page stayed empty, and server.log said nothing.

## What the code does today (verified)

- **Picker lock.** `UnifiedBrowserPanel.tsx` disables the Profile `<select>` while `status.held`, and the PATCH refuses a browser change while held ("Return browser control before changing browsers"). `release` also requires the client's `generation` to equal the server's (`browser-control.ts human()`), and every stream drop bumps the generation (`connect` onDisconnect). So with a churning attach, Return to bot can be refused as "control changed", and the picker stays locked.
- **Empty page.** The panel's live view runs `agent-browser stream status`, which the engine serves without launching a browser (`actions.rs` skip-launch list, agent-browser 0.36.0). So for the owner's Chrome the panel shows "Live" with nothing behind it. Nothing in the panel ever attaches to Chrome.
- **Repeated Allow.** Chrome asks once per new DevTools connection. We open several: the engine daemon's (on the first bot call or address typed), then `BrowserDocumentGuard`'s own socket from `get cdp-url` (a second prompt, documented in 9716c6ac0). The engine's CLI re-sends a command after its 30 s read timeout (up to 5 times), the daemon's CDP commands time out at 30 s, and after any failure the panel's status poll starts a new attach after 3 s. Each new attempt is a new connection and a new prompt; an Allow clicked on a prompt whose connection already gave up connects nothing.
- **Silent.** A successful `stream status` logs nothing, and the attach failures are reported through the panel only.
- **Murage for Chrome is a separate choice.** "Use my browser" (`browserTransport: "extension"`) is the extension. Picking "Use my Chrome" never looks at it.

## Design

1. **One choice: "Use my Chrome".** The picker shows a single "Use my Chrome" option. Confirming sends `PATCH {useMyChrome: true, browserTransport: "auto"}`. The server picks the route:
   - Murage for Chrome has a connected Google Chrome profile (never Edge or Brave): extension transport, with that profile when there is exactly one.
   - Otherwise, remote debugging is on (DevToolsActivePort is there and Chrome listens): the remote-debugging route.
   - Otherwise: extension transport. Its panel says **"Install Murage for Chrome"**, links the store, and connects by itself once the extension pairs (its existing 2.5 s status check).
   The old `null`/`"extension"` values still work for older clients.
2. **Moving up to the extension by itself.** While a bot is on the remote-debugging route, the panel reads the extension status every 3 s. After a successful read that shows exactly one Chrome profile, while the bot is idle and not held, the panel switches the bot to the extension and says so once ("{bot} now works through Murage for Chrome..."). A failed read changes nothing. On the server, a move from remote debugging to the extension is refused while held or busy, and it closes the remote-debugging attach. Remote debugging stays one bot at a time. The extension already allowed several bots, each working only in tabs shared per task.
3. **Remote debugging asks once (r2: one shared connection).**
   - Murage holds ONE DevTools connection to the owner's Chrome per binding (`server/user-chrome-proxy.ts`). The engine and the page check connect to Murage on loopback, each with its own random path token, and never dial Chrome themselves. Their handshakes wait until Chrome answers a `Browser.getVersion`, which only happens after Allow (at most 110 s). Ids are rewritten per client. A session belongs to the client that opened it, and Chrome-level events go to the engine. When the engine exits (idle stop, restart), its sessions are detached and its auto-attach is switched off, so none of the owner's tabs waits on a debugger that left. The Chrome connection stays, so the next engine start asks nothing. Chrome asks again only after Chrome or Murage restarts, or after a Try again that follows a failed Allow.
   - The live view attaches once, through one engine command that needs the browser (`get url`), single-flight per relay. It also opens the page check's connection then, which shares the one approval. While it waits, the panel says **"Waiting for Chrome: click Allow in its remote debugging prompt."**
   - After a failed attach, status reads never start a new one. A new one comes only from the owner's **Try again** or the bot's next step (the bot needs the browser then, and the chat already says Chrome is asking).
   - The status probe (`userChromeTrouble`) is cached for 5 s. Engine failure reasons have every `ws://` address removed before they are logged.
4. **The picker never locks.** It is disabled only while a change is being sent or a turn is running. While a turn runs it says why: "Stop {bot}'s turn to change its browser." Picking another browser while you hold control returns control first, then switches. **Return to bot** is checked against a new control epoch, not the stream generation. The epoch moves on take, release, reclaim, navigate and reopen, but not when the live view reconnects, so a reconnect no longer refuses the hand-back. A take or navigate since the panel's read still refuses it. The same owner, held, and no bot step in flight are all still required. Older clients keep the generation check.
5. **Logging.** Every attach logs one line: `[browser] user-chrome attach start|waiting-allow|connected|failed (<ms>, <reason code>)`, plus the route the server picked (`extension|remote-debugging|install`). No URLs, tab titles or page content are logged. The endpoint is reduced to "port present".

## Out of scope

The extension's own pairing flow is unchanged. Known and reported separately: on the remote-debugging route, the page check takes stock of every open tab of the owner's, and it refuses with more than 20 tabs (`browser-document-guard.ts`).

## Tests (Hetzner, vitest)

Route choice for each of the three states. `release` with a stale generation by the holding owner works, and by another owner is refused. The picker is enabled while held, and choosing a browser releases and then patches. One attach in flight. No timer retry after a failure. The probe cache. The log line shapes. Both typechecks.

## r3 (after Grok r2 REVISE, 2026-10-26)

Grok r2 found one High: a remote-debugging bind already past its checks could publish a new connection to the owner's Chrome after a transport switch had forgotten the old one. The r3 rule is that a connection to the owner's Chrome is published only by a bind that is still current when it publishes.

- Binds run one at a time per bot (`UserChromeBinds.run`, server/user-chrome.ts). Concurrent callers share the bind already running.
- Every forget moves the bot to a new generation and withdraws what is published, synchronously, before its first await: the binding memo and the proxy. Forgets for one bot are serialized, and a new bind waits for one still closing.
- A bind re-checks after every await (engine status, proxy start, binary check) that its generation is current, that the record still says remote debugging, and that no other bot holds it. It publishes the proxy, the controller registration and the memo with no await in between. A stale bind closes its own proxy and answers 409 "Your Chrome connection changed while it was starting. Try again." The proxy dials Chrome only when a client connects, so a stale bind never caused a prompt.
- PATCH forgets again after `patchBot` whenever the bot left remote debugging. That closes a bind started between the first forget and the record change.
- Copy (Grok r2 Medium): the consent dialog says that without Murage for Chrome, remote debugging is used, Chrome asks once to Allow, the bot can reach open tabs, and one bot at a time can use it.
- Fable r1 Mediums: (1) the bot's successful step clears a failed live view (`noteChromeConnected`), so the view reconnects with no new prompt; (2) "Waiting for Chrome" shows only while the proxy is not yet allowed.

## r3 test round (2026-10-26, runner umc107-chrome)

- **Chrome restart rebinds.** `UserChromeBinds.run` now records a run before the bind starts. Before, a bind that found Chrome restarted cleared the run slot (through forget) before the slot was written, then waited on its own run, and the turn never started. A unit test covers a bind that forgets and binds again at once.
- **The bot hears the current state.** The bot's refusal after a failed step probes Chrome fresh. The 5 s cache stays for the panel's 1 s poll, so the bot no longer says "turn remote debugging on" just after the owner turned it on.
- **"Waiting for Chrome" covers the bot's own step.** The proxy says when Chrome is showing its prompt (`state === "waiting"`), so the panel shows it while a bot's step waits for Allow, not only while the live view connects.
- **The engine dials Murage, not Chrome.** `AGENT_BROWSER_CDP` is the proxy's loopback URL with its own token. The fixture test now proves the upstream dial through a fake Chrome WebSocket.
- **Real Google Chrome 156 proof** (`server/use-my-chrome-chromereal.test.ts`, opt-in): Chrome shows "Allow remote debugging?" for every new DevTools connection and holds the handshake until Allow. With the one shared connection, one Allow covers a whole session: many steps, the live view, take and return of control, and a second turn. The panel answers in under 5 ms while Chrome asks. The picker's switches work once control is returned. Evidence is in reports-107/use-my-chrome/real-chrome-r3/.
- **The extension route is reachable.** Murage for Chrome's hello names the browser "chromium" in every browser (`extensions/murage-browser/runtime.mjs`), so the r1 filter (`browser === "chrome"`) never saw a paired profile, and "auto" could not pick the extension. Both copies of `pairedExtensionProfile` (server and panel) now count "chromium" as Chrome and still leave out a profile that names Edge or Brave. The owner's Connect registers the helper for Google Chrome. Proven in real Chrome 156: the extension is loaded through chrome://extensions (branded Chrome ignores `--load-extension`), Connect registers the helper, "auto" picks the extension, the owner allows the site card, and the bot opens and reads the page with no Allow prompt.
