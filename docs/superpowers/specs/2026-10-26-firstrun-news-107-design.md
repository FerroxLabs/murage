# First-run news signup (1.0.7, feat/107-firstrun-news)

Sean 10-26: the Chief asks every install for a name and email in the first chat, single opt-in, a getting set up guide goes out at once. Asked once; skip never blocks setup.

## What exists (base int/107 784a527bd)
- The first chat is server-authored cards in the Chief's thread (server/setup-conversation.ts). Card one is `hello` (src/components/FirstRunHelloCard.tsx): name + optional email, Continue / Skip. It comes before detection, so it shows on a machine with NO engine yet. That makes it engine-independent: no model has to ask, parse or call a tool. The name is already passed to every engine as the owner name (`cfg.profile.name`, server/index.ts promptWithReply / transcriptText).
- The card saves the profile, calls `identifyEmail` (PostHog identify with the address), then POSTs the local server `/api/subscribe`, which posts once (3 tries, no queue) to `accounts.murage.ai/v1/announcements/subscribe` (server/sendlane.ts), packaged builds only.
- "Asked once" is the `hello` step latch (setup.json + a saved name); `murage-email-gate` in localStorage is the only record of subscribed/skipped.

## Change
1. Copy (src/lib/first-run-copy.ts, hello.welcome): Sean's wording, minus the confirm line, plus one guide line:
   heading "Before we dive in"; lead "What name and email should I use to keep you in the loop? You'll get new releases, insights, how-tos and tutorials so you get the most out of Murage. Your getting set up guide goes out as soon as you tell me." Skip button "Skip", with "Or just tap Skip." (the card has a Skip button; typed "skip" in the composer is not intercepted, see notes). No em dashes, no price, no Composio.
2. New server/news-signup.ts replaces server/sendlane.ts. One record, DATA_DIR/news-signup.json (0600, atomic, excluded from backups, since it can hold a pending address; the chat ask stays latched by the saved name):
   `{version:1, status:"asked"|"subscribed"|"skipped", at, delivery?:{state:"pending"|"sent"|"refused"|"expired", attempts, nextAt?, lastStatus?, email?, name?}}`.
   - `asked` is written when the hello card is first appended to the Chief thread. `skipped` when hello is skipped or answered with no email. `subscribed` when an address is given (hello or Settings). Never downgraded: subscribed is not turned into skipped.
   - email/name sit in `delivery` only while pending, and are deleted the moment it is sent, refused or expired. Nothing else is stored or sent: no device id, no install id, no analytics.
3. Delivery, from the server process (the harness under Electron main; never the renderer, no key in the app): POST `https://murage.ai/api/news/subscribe`, JSON `{email, name?, source:"app"}` (no honeypot `nickname`), 15 s timeout.
   - any 2xx = sent (202 `sent` or `subscribed` both fine). 400 and other 4xx (not 408/429) = refused, no retry. 429 = retry after Retry-After (1 min to 24 h) or backoff. 408, 5xx, 503, offline, timeout = retry with backoff 1 m, 5 m, 30 m, 2 h, 6 h, then 12 h, for 14 days, then expired. Retries are silent. A pending delivery resumes at server start.
   - Endpoint: a packaged desktop app posts to `https://murage.ai` and NOTHING else (no override is read there, Grok r1 Medium). `MURAGE_NEWS_URL` (exact https origin, or http loopback) applies to a dev run only. Dev runs and tests post nowhere. The old `sendlane.baseUrl` config key is dropped. Nothing about the post is logged.
4. Routes (desktop only, route-policy): `POST /api/subscribe` validates, records subscribed, queues, returns 200 `{ok:true}` at once (or `{ok:false, reason:"invalid-email"}`). `GET /api/news` returns `{status, at, onList}` only. `onList` is true only while the delivery is sent or still pending; a refused or expired delivery is not on the list, so Settings offers the form again (Grok r1 High). Setup skip/answer of hello records skipped server side.
5. Renderer: the hello card stops calling `identifyEmail` (Sean: no analytics with the address). Settings > About gains "Get Murage news": shows "You are on the list" when subscribed, else an email field (profile email prefilled) and an "Add me" button that posts the local `/api/subscribe`.

## Failure list
F1 offline at first run: queued, sent on a later retry or next start. F2 site 503/429: retried, never shown. F3 400 bad address: stopped, address deleted. F4 crash mid-post: record still pending, resent at start; the list is idempotent per address. F5 corrupt record: read as none (asks nothing new: the hello latch is separate), rewritten on next write. F6 restore onto a new machine: the record is not in the backup; the chat does not re-ask (hello is latched by the restored name); Settings offers the form; a send still pending on the old machine is not carried over. F7 tests: no live endpoint, injected fetch and base URL.

## Tests (vitest, Hetzner, both typechecks)
server/news-signup.test.ts (asked once, skip, never downgrade, 2xx sent + PII deleted, 400 refused, 429 Retry-After, 503 + offline backoff, restart resumes, disabled posts nothing, exact body), server/setup-api.test.ts (route + skip records), src/components/FirstRunHelloCard.test.ts (no identify, only local `/api/*` calls, copy).
