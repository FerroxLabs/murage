# VAULT-M7 part 1 (1.0.21): saved secrets, design r4 (scope cut)

STATUS: r4d (r4 + in-lane Astra rounds 1-3 fixes, CHANGES at sections 11.1-11.3; round 3 BLOCK 5 folded in and NOT re-reviewed by Astra, cap reached), convergence round 4. Supersedes r3 (`DESIGN-r3.md`, 6b2da5a794) in full; r1-r3 stay for history. Security row: no builder starts until Fable AND Astra AGREE and the rulings in QUESTIONS-r4 are recorded.

Owners (each side of each contract):
- Main-side Vault (`electron/vault/*`, new: the Vault file and its writer, the authority, the fetch executor and scrub, the armed marker): **VAULT-M7 builder lane** (seated by MAIN). Until seated: **OPEN NO-OWNER builder**.
- Server side (`server/vault/*`: index copy without values, op records, custom card, `vault_fetch` ingress, exposure gate, prompt names, Vault page routes) and the one field added to `server/internal-capabilities.ts` (`vaultGen`, D25): **VAULT-M7 builder lane**.
- `credentials.bin`, `electron/secure-credential-state.mjs` and every existing writer: **unchanged by r4**. The post-rename stale-`current` bug found in r2 (Fable r2 H1) moves to follow-up slice V4; until V4 is seated its owner is **MAIN** (OPEN NO-OWNER builder for V4).
- MCP key custody (`mcpServerSecrets`): **mcpskills-1021 lane (D3)**. r4 adds nothing to it.
- Follow-up slices V2 (chat holds), V3 (1Password), V4 (shared writer reconcile), V5 (My Cloud, receiver = **MurageCloud**): owners in 10.
- Scope rulings: **MAIN**. Policy acknowledgement (Q1): **product owner**.

Code truth: hub `dev/1021` at `068a595c9a8ee59d1a9c994f7484ecd97ab4c48e`; v1.0.20 = `183ec9be4b`.

"Card" means a bot's secure in-app request card (`src/components/SecretRequestCard.tsx`).

## Why r4 cuts scope

After three in-lane Astra rounds, seven of r3's nine open findings were the third appearance of the same clusters (r2 → conv r2 → conv r3). Each cluster came from a part of the design that has to agree with another part across a process boundary or a disk boundary. r4 removes those parts rather than adding guards:

| Recurring cluster (Astra conv3 #) | Root | r4 cut |
| --- | --- | --- |
| Lease vs narrowing, REPLACE, relink (#2, #5, #8) | the value left main in a *lease*; the server dispatched later, so every narrowing raced a lease in another process | **No leases.** Main makes the HTTPS request itself. Check, value read, dispatch, abort, narrowing and REPLACE all run on main's one event loop (4.4, D13) |
| Shared credential writer (#3, #9) | Vault ops shared `credentials.bin`'s writer, so Vault recovery had to reason about sign-in drafts and sibling saves | **Own file, own writer.** `userData/secrets/vault.bin`, written only by the Vault (D1, 5.3). The shared writer is untouched; its existing bug moves to V4 |
| Narrowing journal durability (#4) | a second durable file had to be written at the moment of a narrowing, and that write can fail | **No journal.** A marker is *armed at boot* while the disk accepts writes. A lost narrowing needs no further write to stay fail-closed (5.4) |
| Chat holds (#5) | an in-memory value with its own lifetime, display and fence | **Cut to V2.** A card either keeps the value in the Vault or grants a saved item |
| Duplicate POST after remount (#6) | identity built from engine-chosen request ids and proxy instances | **Identity from the call itself**, held by main (D23) |
| Redirect carrying the value (#7) | following redirects | **No redirect is ever followed** (4.4 step 5) |
| Full-access bearer after unpause (#1) | a turn claim had no notion of when it was issued relative to the pause | **Exposure generation in the claim** (D25) |

What part 1 still delivers: an owner saves an API key once (card or Vault page), pins the bots, the https sites and the slot, and those bots use it through `vault_fetch` with no further card. 1Password, chat-only holds and My Cloud follow as V3, V2 and V5 in the same 1.0.21 train (10).

## 0. PURPOSE and USER PROMISES

PURPOSE: the owner gives an API key or token once, on a bot's secure card or on Settings → Vault, and the bots the owner chose can use it later in web requests Murage makes for them to the sites the owner allowed. The value never reaches a model, a file other than the sealed Vault file, a log or another program.

USER PROMISES (each tested in 9; what Murage cannot enforce is in 1.1):
- **P1 Save once.** A saved value is used again, with no new card, when a bot it is granted to asks for it by name for a site the item allows.
- **P2 Only chosen bots, only chosen sites.** Murage sends an item only for a bot listed on it, only to an origin listed on it (exact scheme, host, port), only in the slot listed on it, and only for a turn that no other program could have impersonated (D25). A bot that is not listed gets a card for the owner to decide, never the value.
- **P3 Never in the model, a file, a log or another program.** No Vault value is ever in a prompt, a tool result, a transcript, an event, a log line, the server process (values go renderer → preload IPC → main, D28), any process's argv or environment, any child process, any file other than `vault.bin`, config.json, a backup, telemetry, feedback or a crash report. The response the bot sees has every pinned form of the value masked (F9). The pinned site receives the value: the owner's choice (R2).
- **P4 Honest "saved".** "Kept in the Vault" is shown only after a full durable write of `vault.bin` that contains the op. Before that the card says "Saving…", or "Not confirmed yet" after an ambiguous write. A save that failed says "Not kept: <reason>. Ask again." "Not kept" is said only when the file is known not to hold the op.
- **P5 Never silently weak, never silently lost.** The Vault is READY only where its file is sealed by the OS store (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet). Linux `basic_text`, headless servers and Cloud homes keep it LOCKED in part 1, with the reason. A Vault file that cannot be read is never replaced or emptied.
- **P6 Owner control.** The owner sees every item (name, bots, sites, slot kind, last used; never the value), changes bots and sites, replaces the value, deletes it. A revoke, site removal or delete takes effect at once for every request that has not started and aborts every request in flight that holds the item. If Murage closes before it could save that change, saved secrets stay paused after it reopens until the owner checks the Vault page and presses Resume.

(r3's P7 linked manager and P8 My Cloud move to V3 and V5 with their promises.)

## 1. Threat model

Assets: Vault values; each item's bots, sites and slot.

| Actor | Can | Must not be able to |
| --- | --- | --- |
| Owner (renderer, owner routes) | everything in P6 | read a value back (no route returns one) |
| A bot / model, incl. one steered by prompt injection | ask by name with a proposed site and slot; call `vault_fetch` for a granted item | get an item not granted to it; send it to a site or slot not pinned; receive a value in any result, error or prompt; reach any origin other than the pinned ones; make Murage follow a redirect |
| Another bot (not on the item) | everything a bot can | get the value or a signal about it (mask counts) through any Murage tool, card or route |
| Engine children, the server process | what they have today | receive a Vault value (the server never does: values go from the owner's desktop renderer straight to main, D28) |
| Disk thief / backup reader / old-version backup | read userData and backups | find a value (only `secrets/vault.bin`, sealed, excluded from every backup in 1.0.20 and 1.0.21, 7) |
| A pinned site | receive the value in the pinned slot | receive another item, or a value outside a request a granted bot made |

### 1.1 Residuals (Q1 asks the product owner for a NEW acknowledgement)
- **R1 Same OS user.** A program running as the owner's OS user (a Full-access bot's command, or other software) can, on Windows and Linux, ask the OS store for the key that seals `vault.bin` (as for `credentials.bin` today), and on Windows read Murage main's memory. Such a program can also read a turn's bearer file (`server/drivers/claude.ts:4930-4940`) and act as that bot on internal routes; D25 pauses the Vault while any bot can do that and voids every claim that existed during the pause. **Demoting a bot does not undo programs it already started while it had Full access**: such a program is "other software running as you". The Vault page says: "Bots with Full access run as you and could read Murage's saved keys, including these. Lowering a bot's access does not stop programs it already started. Give Full access only to bots you trust." `docs/terms-acceptance.md:13` covers only the terms record, so this is a new acknowledgement.
- **R2 The pinned site.** The site receives the value. A site that echoes it in a form outside F9, or a granted bot that sends its own context to that site, acts within the owner's grant. The card says: "<bot> will be able to send requests to <origin> with this. Only allow sites you trust with it."

Out of model: malware with debugger access to Electron main; a compromised OS keychain; a compromised CA for the pinned site.

## 2. What Murage has today (at 068a595c9a)

- `credentials.bin` and its serialized writer (`electron/secure-credential-state.mjs:65-83`), `writeFileDurable` (`electron/durable-write.mjs:18-27`). r4 reuses `writeFileDurable` and `safeStorage`, not the writer.
- Main ↔ server: `utilityProcess` with a private port (`electron/main.mjs:2769-2782`), exit at `:2874`. Precedent for main answering per request from sealed state: WhatsApp auth key (`:2796-2806`).
- Bot tools on the agents proxy: `request_credential` (`server/drivers/agents-proxy.ts:598-616`), proxy wait 250 s (`:864-875`), `capResult` (`:954-956`). Turn claims: `InternalCapabilityRegistry.mint` (`server/internal-capabilities.ts:92-104`) stores a frozen claim per random 48-hex bearer; `isActive` (`:139-145`) checks the thread's live generation.
- Ids: `newId = crypto.randomUUID()` (`server/contracts.ts:1105`); bot ids are never reused (W24 asserts a re-created bot gets a new id).
- Public-address checks: `isPublicAddress`, `validateHost` (`server/cloud-home/own-server.ts:203,213`).
- Backup inventory refuses unknown top-level names (`server/data-dir-inventory.ts:10-17`); `secrets` is already `excluded(CREDENTIAL)` in 1.0.20 and 1.0.21 (`:336`) and no code at 068a595c9a writes it.
- Full access per bot: `server/auto-approve.ts:471-473`.

## 3. Decisions (fail-closed, one line each)

| # | Decision | Why |
| --- | --- | --- |
| D1 | Values live only in `<profileDir>/secrets/vault.bin`, where `profileDir = dirname(CREDENTIALS_FILE)` (userData by default; `connection-profiles/<id>` after a same-machine restore, `electron/main.mjs:1744-1750`, `electron/restored-connections.mjs:19-20`), so a restored installation never sees or edits the original's Vault (Astra conv4 #5); both locations are already `excluded(CREDENTIAL)`. The file is safeStorage-sealed JSON `{v:1, rev, items, tombstones, receipts}`, written only by main's Vault writer (5.3). VAULT-M7 owns `secrets/`. Never `credentials.bin`, no per-call file; the writer's sealed temp `vault.bin.<pid>.tmp` is unlinked after a failed write and swept before READY (5.3, 5.4; Astra conv4 #8). | Own writer removes every shared-writer interaction (Astra conv3 #3, #9); `secrets/` is already excluded from backups by 1.0.20, so a downgrade keeps backups working (7). |
| D2 | **Main is the only Vault authority and the only process that holds values after a save.** The server holds an index without values pushed by main. | One authority. |
| D3 | All main ↔ server Vault traffic is request/reply on the private utility port, each message carrying the server's launch `epoch`. | As r3. |
| D4 | **The only delivery is `vault_fetch`, executed by main** (4.4): one HTTPS request to an origin pinned on the item, value in the pinned slot, response scrubbed in main. No lease, no command, file, env, ref or MCP binding. | Astra conv3 #2, #5, #8 by construction. |
| D5 | Unreadable or malformed `vault.bin` (decrypt or parse failure, `v` newer) = **BROKEN**: no Vault write at all, fetch refused, file bytes unchanged. Narrowings are applied in memory only. | P5. |
| D6 | Linux `basic_text`, headless, Cloud home: **LOCKED**, no opt-in. | P5. |
| D8 | No MCP binding in part 1 (Q3). | MCP launch paths write values to disk today. |
| D9 | New card kind `custom:<label>` with a required `use {origin, slot}`; choices KEEP and GRANT only (4.1). | No chat holds in this slice (V2). |
| D10 | Prompt names: only items usable by that bot, with origins; JSON-quoted, control characters stripped, ≤ 80 chars, ≤ 40 names, introduced as data. | As r3. |
| D11 | Scrub in main, streamed, before any cap, against the forms of **this call's value only** (F9). | No cross-item signal. |
| D13 | **Check and dispatch are one synchronous step on main's event loop** (4.4 step 3): the grant check, the value read, creating the request object and registering it in `inflight` happen with no `await` between them. Every narrowing, REPLACE mark, exposure change, Stop and turn end is also a synchronous main handler that consults and aborts `inflight`. | No interleaving exists for a race. |
| D14 | Values: one line, printable ASCII (0x20-0x7E), 8..4096 bytes. | Header and query slots; F9 needs ≥ 8; ASCII keeps byte and text matching equal. |
| D15 | Every write is a job on the Vault writer's own queue. A job persists `apply(op, effective)` where `effective = apply(overlay, doc)` (5.1). | One writer, deltas on the latest state. |
| D16 | A narrowing (REVOKE, REMOVE_ORIGIN, DELETE, REVOKE_BOT) enters `overlay` at once, before its job; `effective` excludes it from that moment. It leaves `overlay` only when a durable write containing it succeeds. | P6 at once; no journal. |
| D17 | Each committed op writes a receipt `{opId, kind, target}`; receipts stay until the server acknowledges the outcome (`vault-ack`); at 1024 unacknowledged receipts widenings are refused, narrowings never. | Server-restart outcomes (5.2 M4). |
| D18 | Build constant `VAULT_ENABLED` (`shared/vault-flags.ts`): false = LOCKED(disabled), no tool, no card, no names, `secrets/` untouched. | Rollback. |
| D19 | Bot deletion posts REVOKE_BOT before the delete commits. Bot ids are never reused, so a REVOKE_BOT lost to a crash leaves a grant no bot can present. | Simple and safe. |
| D20 | **No new approval prompt.** The owner's grant (bot + origin + slot) is the authority for `vault_fetch` at every level. | No limits rule. |
| D22 | Only main decides an op's outcome: KEPT or NOT_KEPT(reason). An op whose write is ambiguous stays UNCONFIRMED ("Not confirmed yet") until reconciliation proves it durable (KEPT) or absent (NOT_KEPT) (5.3). No timer makes an outcome. | One terminal path. |
| D23 | **Call identity** `invocationKey = H(botId, turnGen, "vault_fetch", canonical {name, url, method, headers, body, repeat})`. No request id, no proxy instance. Main holds a per-session map `invocationKey → RESERVED | DISPATCHED | DONE(result)`; an identical call in the same turn joins it (waits, or gets the stored result). `repeat` (integer 0..99, default 0, never sent) lets a bot deliberately repeat a call. | Astra conv3 #6, Fable r3 M8. |
| D24 | A custom card is raised only when the store is READY and the turn is not No limits; otherwise `request_credential` returns the reason. | As r3. |
| D25 | **Exposure gate (server).** `exposure.active` = any **execution context** that could read another turn's bearer file: every task projection's effective level and engine (`server/store.ts:6108-6114`: bot defaults, task overrides, copied No limits), plus every live turn, judged by the level and engine it started with, until the turn is retired. A context is exposed when its effective level is Full access or its engine/OS pair is not listed in `shared/vault-qualified-sandboxes.ts` (empty until W29b qualifies a pair). It is recomputed in the same synchronous block as every bot or task permission change, engine change, turn start and turn retirement (Astra conv4 #1). `exposure.gen` (integer) increments on **every** change of `active`, in the same synchronous block as the settings change. At **turn start** the thread's generation record captures `exposure.gen`, and `mint` copies it into every claim of that turn (`vaultGen`), so a pause that begins during turn setup also voids the turn (Astra conv4 Medium). `vault_fetch` ingress admits a claim only if `!exposure.active && claim.vaultGen === exposure.gen`. So a claim minted before or during a pause is refused for its whole life; only turns started after the pause ended can use the Vault. The change is posted to main (`vault-exposure {active, gen}`), which aborts every in-flight fetch when `active` becomes true. | Astra conv3 #1, Fable r3 M5: no clocks, no issue times. |
| D28 | **Values never pass through the server.** The card and the Vault page take the value in the desktop renderer and send it by preload IPC `vault:value {opId, valueToken, value}` straight to main. The server's owner route settles the card or page op **without the value** and returns `{opId, valueToken}` (32 random bytes, single use) to that renderer; it posts the op with `valueToken`'s hash to main. Main joins value and op by `opId` + token within 60 s, else NOT_KEPT(no-value). A card answered from a client without the desktop preload (phone, browser companion) offers no value field: "Save this on the desktop app." | Astra conv4b #6: P3 holds for the server. Precedent: model sign-in values go renderer → main (`electron/main.mjs:5193`). |
| D26 | **No redirect is ever followed.** A 3xx returns its status and a scrubbed same-origin `Location`; a cross-origin `Location` is reduced to its origin. | Astra conv3 #7 by construction. |
| D27 | **Armed marker** `<profileDir>/secrets/vault.open` (per connection profile, like the file). Its presence is checked **first** at boot, before any other Vault step. Present → `review = true` (a flag separate from the displayed state) until the owner presses Resume. A quit may unlink it only when `markerOwned` (this session created it at boot, or the owner pressed Resume) **and** `overlay` is empty, no write failed or is unconfirmed since the last success, and the boot sweep succeeded. Any boot failure, LOCKED state or open review keeps it (Astra conv4 #2, conv4b #1). | Astra conv3 #4: fail-closed after a lost narrowing without any write at failure time. |

(D7, D12, D21 of r3 are withdrawn with S6, 1Password and the shared-writer change.)

## 4. Flows

### 4.1 Save from a card
1. Bot calls `request_credential({credential_id: "custom:<label>", reason, use: {origin, slot}})`. `origin` = `https://host[:port]` (`validateHost`; DNS names and public IP literals; no path, no userinfo). `slot` ∈ `bearer` | `header:<Name>` (`^[A-Za-z][A-Za-z0-9-]{1,63}$`, not reserved, 4.4) | `basic:<user>` | `query:<param>` (`^[A-Za-z0-9_.-]{1,64}$`). `nameKey = vaultNameKey(label)` (NFKC, lowercase, runs of non-alnum → `-`, trimmed).
2. Store not READY or flag off → no card: `Secrets can't be saved here: <reason line>.` No limits turn → no card: `Save it in Settings → Vault and allow <bot> and <origin> there.`
3. A live item with that nameKey granted to this bot, listing `origin`, with this slot → no card: `"<name>" is saved for <origin>. Use vault_fetch with name "<name>".`
4. Otherwise a card. Header "**<bot> wrote this name and reason**", label, reason. Site line: "Murage will send it only to **<registrable domain>** (<full origin>), as <slot words>." (registrable domain emphasised, Fable r3 M6). The owner may edit the origin (validated again). Single-line password input. Choice "Keep in the Vault for <bot>". If a live item with that nameKey exists and its slot equals the requested slot, the card also offers GRANT: "Let <bot> use the saved '<name>'", stating the item's whole scope (every origin, slot, every granted bot); when the request adds an origin, a separate line: "**Adds a new site:** <origin>, for every bot on this item." A different slot → no GRANT; typing a value creates a new item `<label> (<bot name>)`. A card never replaces a value. The card records the item `generation` it displayed; GRANT carries it as `baseGeneration` (Astra conv4b #4).
5. Settlement: one store transaction does the CAS `OPEN → SETTLED(keep|grant)` on the card message and writes the op record `{settlementId, opId, kind, state: PENDING}`; second submit or submit after dismiss → 409. Only owner routes settle; in a group room the item goes to the asking bot only. After the commit the server returns `{opId, valueToken}` to the renderer and posts the op (no value) to main; the renderer sends the value to main by preload IPC (D28).
6. Ops: keep → `SAVE {item: {name, nameKey, value, bots:[bot], origins:[origin], slot}}`; grant → `GRANT {itemId, botId, origin?, baseGeneration}`.
7. Card outcome line: KEPT "Kept in the Vault for <bot>"; NOT_KEPT "Not kept: <reason>. Ask again." (SAVE) or "Not allowed: <reason>" (GRANT); before the outcome "Saving…".
8. Continuation (existing resume path), only after the outcome: KEPT → `Secret "<name>" is ready for <origin>. Use vault_fetch with name "<name>".`; NOT_KEPT → `The owner answered, but it could not be saved: <reason>. Ask again later.`; DISMISSED → `The owner declined.` Never a value.

### 4.2 Settings → Vault page
Items: name, bots, sites, slot kind, last used, "in use" while a request holds it. Actions: Add (name, value, sites, slot, bots), Replace value, Change bots, Change sites, Delete. Write-only value field; the value goes page → preload IPC → main (D28); the server route carries only metadata. Store line: READY; LOCKED(keyring | headless | cloud | disabled | store-unavailable | full-access | review | loading); BROKEN ("The Vault could not be opened. Nothing was changed."). `full-access` names the bots causing it. `review`: "Murage closed before it could confirm a change. Check who can use your saved secrets, then press Resume." with the Resume button. Unsaved narrowing: "Removed. Not saved yet; Murage keeps trying. If Murage closes first, saved secrets stay paused until you check them here." with Retry. Pending ops: "Saving…". R1 line. UX per `designs/MURAGE-UX-BAR.md`, strings via the inventory. While LOCKED(review) the owner can still edit and delete.

### 4.3 "Use a saved one"
Custom cards only (D8). Picking a saved item = GRANT (4.1 step 4).

### 4.4 `vault_fetch` (the only delivery, executed in main)
Tool on the agents proxy beside `request_credential`:
`vault_fetch({ name, url, method?: "GET"|"HEAD"|"POST"|"PUT"|"PATCH"|"DELETE", headers?: {[k]: string}, body?: string, timeout_s?: number, repeat?: integer })`. The description says: an identical call in the same turn returns the first call's result; set `repeat` to send it again.
- `url`: absolute `https:`, ≤ 8 KiB, no userinfo, no fragment; origin must equal one of the item's origins; for a `query:<param>` slot the URL must not contain `<param>`.
- `headers`: names `^[A-Za-z0-9-]{1,64}$`, values without CR/LF, ≤ 16 KiB. Reserved (refused): `authorization`, `proxy-*`, `cookie`, `host`, `content-length`, `transfer-encoding`, `connection`, `te`, `upgrade`, `expect`, `accept-encoding`, `range`, `if-range`, and the item's pinned header name.
- `body` ≤ 1 MiB text. `timeout_s` ≤ 60, default 30.

Steps:
1. **Ingress (server, one synchronous block):** `VAULT_ENABLED`; the bearer resolves to an active claim (`requireActiveInternal`, `server/index.ts:30578`); **exposure gate D25**; argument checks above; compute `invocationKey` (D23); post `vault-fetch {epoch, botId, threadId, turnGen, invocationKey, name, url, method, headers, body, timeout_s}` to main and await the reply (backstop 120 s → fixed string `Outcome unknown: Murage lost the reply. Check before repeating it.`; the proxy waits 250 s).
2. **Join (main, synchronous):** `invocationKey` in the session map → wait for it or return its stored result. Otherwise insert RESERVED.
3. **Check and dispatch (main, one synchronous step, D13):** epoch is the running child's; store READY; main's `exposure.active` false; `turnGen` not ended or Stopped (`deadTurns`); `name` resolves in `effective` to one item granted to `botId`, with `url`'s origin listed, not `replacing`; then read the value, build the request (value only in the pinned slot; model headers after the reserved check; `accept-encoding: identity` set by Murage), create the Node `https.request` object, register `inflight[reqId] = {itemId, botId, turnGen, epoch, abort}` and mark the key DISPATCHED. Any failure → fixed refusal string, key DONE with that refusal, nothing sent.
4. **Transport:** Node `https` (not Electron `net`, which applies the system proxy); certificate verification on; no proxy; a `lookup` hook that rejects any address where `isPublicAddress` is false, on every connection; keep-alive off.
5. **Redirects:** never followed (D26).
6. **Response:** status number only; `content-type` reduced to bare `type/subtype` matching `^[a-z0-9.+-]{1,64}/[a-z0-9.+-]{1,64}$`; `content-length` number; no other header except a scrubbed `Location` (D26). Body is text only if: the type is `text/*`, `application/json`, `application/xml`, `application/*+json`, `application/*+xml` or `application/x-www-form-urlencoded`; **and** `content-encoding` is absent or `identity`; **and** the charset is absent, `utf-8`, `us-ascii` or `iso-8859-1`. Text bytes go through the streaming matcher (F9) with carry-over, **then** are decoded, **then** capped at 256 KiB (end dropped with a marker). Because values are printable ASCII and the three charsets are ASCII-compatible, byte matching equals text matching (Fable r3 M1). A `206` or any `content-range` response is never text. Anything else returns only `{size, sha256}`. Every returned string (media type, `Location`) passes the matcher.
7. **Abort:** a narrowing or REPLACE on the item, `vault-exposure {active: true}`, `vault-turn-end {turnGen}` (Stop confirmed or turn end), server exit (E1), the timeout, or app quit → `abort()` (bytes already on the wire cannot be recalled; the result says "stopped").
8. **Result:** `{status, contentType, location?, body | {size, sha256}, masked: N, truncated?}`; `masked` counts this call's value only. Errors are fixed strings by class (DNS, TLS, refused address, timeout, reset, too large, stopped), never a library message. The key becomes DONE(result); `inflight` entry removed; reply to the server. Main updates `lastUsedAt` in the pushed index.
9. **Log:** server: bot, item name, origin, method, status, ms. Main: nothing per call. Never path, query, headers or body.

The map entries of a turn are dropped 10 minutes after `vault-turn-end`; a later call on that turn is refused at ingress anyway (claim inactive). The map is bounded at 4096 DONE entries of ended turns (oldest first); RESERVED and DISPATCHED entries are never evicted. Stored results of live turns are bounded at 8 MiB per turn (each ≤ 256 KiB + metadata); past that the oldest DONE result of that turn keeps only its status line, and a redelivery of it gets `Already sent in this turn (status <n>); the reply was too large to keep.` Never re-sent.

### 4.5 Bot deleted
Before `store.deleteBot` commits, post REVOKE_BOT(botId): enters `overlay`, aborts that bot's in-flight fetches, queued write. The delete does not wait for the write (D19).

### 4.6 Rollback
`VAULT_ENABLED=false` (D18): `secrets/` untouched, a fixed build finds every item.

## 5. Authority and state machine (main)

### 5.1 Data
- Durable: `<profileDir>/secrets/vault.bin` = `seal({v: 1, rev, items: {id: {name, nameKey, value, bots[], origins[], slot, generation, createdAt, updatedAt}}, tombstones: {id: {generation}}, receipts: [{opId, kind, target, at}]})`. `secrets/vault.open` (empty file, D27).
- Memory: `doc` (the last document a successful durable write produced, or the boot read), `overlay` (accepted narrowings not yet in `doc`, in order), `effective = apply(overlay, doc)`, `replacing` (item ids), `inflight`, the invocation map, `deadTurns`, `exposure` (from the server), `epoch`, store state, `writeFailedSinceLastOk` (bool), `uncertain` (null, or `{next, opIds}` while a write is ambiguous, 5.3), `replacePending` (itemId → opId).
- Server, no values: the pushed index (items without values, store state); op records; `lastUsedAt`.

Store states: `LOADING → READY | LOCKED(keyring | headless | cloud | disabled | store-unavailable | review) | BROKEN`. `LOCKED(full-access)` is shown when `exposure.active`. Only READY answers fetches; widenings are accepted in READY and LOCKED(review) (not while writes are held), and refused NOT_KEPT(store-unconfirmed) while `uncertain`; narrowings in every state (BROKEN: memory only).

### 5.2 Main handlers

| Id | Message / event | Guards | Effects | Reply |
| --- | --- | --- | --- | --- |
| M1 | `vault-op` widening (SAVE, REPLACE, GRANT, ADD_ORIGIN) | epoch live; READY or LOCKED(review); writes not held; unacked receipts < 1024; for SAVE/REPLACE the value joined by D28 and checked (D14) | REPLACE: if `replacePending` already holds the item → NOT_KEPT("A new value for this item is still saving") at once (Astra conv4 #6); else set `replacePending[item] = opId`, add the item to `replacing`, abort its in-flight fetches (synchronous). Append a job (M3). | result from M3 |
| M2 | `vault-op` narrowing (REVOKE, REMOVE_ORIGIN, DELETE, REVOKE_BOT) | well-formed; when `vault.bin` exists and no marker is armed on disk (boot failed before step 6), main first tries to arm it (5.4 step 6); if that fails the narrowing is still applied in memory (no fetch runs while LOCKED anyway) but its outcome is NOT_KEPT("Not removed: Murage cannot write to disk. Saved secrets stay paused until it can.") and the store stays LOCKED(store-unavailable) (Astra conv4c #1) | synchronously: append to `overlay`; abort in-flight fetches holding the target; push the index. Then append a job (M3) unless BROKEN or the boot sweep has not succeeded (writes are held until it does, 5.4 step 4; the narrowing stays in effect in memory and the marker stays armed) (Astra conv4b #5). | `vault-op-accepted {opId}`; outcome from M3 |
| M3 | job runs | widening: epoch still live, no tombstone ≥ the item's generation, `generation === baseGeneration` in `effective` (else NOT_KEPT(changed)) | `snap = overlay` (copy); widening: `next = apply(op, apply(snap, doc))`; narrowing: `next = apply(snap, doc)` (`snap` already contains the op, so it is applied exactly once; one generation increment per op); **every op that changes an item (widening or narrowing: bots, origins, value) bumps its `generation` exactly once**, so a card showing an older scope gets NOT_KEPT(changed) "This saved secret changed since the card was shown; ask again."; DELETE writes a tombstone and drops the value; append a receipt for the op **and for every narrowing in `snap`** (each keeps its own opId) (Astra conv4b #7); `rev+1`; durable write (5.3) | write ok: `doc = next`; drop `snap` from `overlay`; `writeFailedSinceLastOk = false`; KEPT. Otherwise per 5.3 (NOT_KEPT or UNCONFIRMED) for a widening and `writeFailedSinceLastOk = true`; **a narrowing is never made terminal by a failed write**: it stays in `overlay` (still in effect) with outcome PENDING ("Removed. Not saved yet"), and becomes KEPT when any later write that includes it succeeds (its receipt is written then, M3) (Astra conv4c #5) and its retry is the next job, the page Retry, or a 60 s retry job. REPLACE removes the item from `replacing` and `replacePending` only when its op is terminal (KEPT or NOT_KEPT); while UNCONFIRMED the item stays refused. |
| M4 | `vault-op-status {opIds}` (server boot; the server also re-asks for every narrowing it holds as PENDING) | a narrowing still in `overlay` answers PENDING; answers a verdict only when the store is READY or LOCKED(review) with the boot re-persist (5.4 step 5) done; otherwise (LOADING, store-unavailable, BROKEN, sweep or re-persist failed) every opId is UNCONFIRMED, never KEPT or NOT_KEPT (Astra conv4b #2) | queue job, so every earlier op has run | `outcomes[opId]` (UNCONFIRMED shows "Not confirmed yet"); else receipt in `doc` → KEPT (true because boot re-persists `doc` durably before READY, 5.4 step 5); else NOT_KEPT(restart) |
| M5 | `vault-hello {epoch, exposure: {active, gen}}` | epoch = running child's | store `exposure` (main treats `exposure.active` as true for an epoch until its hello arrives); queue job | `vault-index` |
| F1 | `vault-fetch` | 4.4 steps 2-3 | 4.4 | result |
| X1 | `vault-exposure {active, gen}` | gen > last seen | store it; `active` → abort every in-flight fetch | — |
| T1 | `vault-turn-end {turnGen}` | — | add to `deadTurns`; abort its fetches | — |
| L3 | `vault-ack {opIds}` | — | mark receipts acknowledged; pruned in the next job | — |
| E1 | server child exit | — | abort every fetch of that epoch; its queued widenings fail the epoch check → NOT_KEPT(epoch) | — |
| R1 | owner Resume (owner route → main) | `review` | `review = false`, `markerOwned = true` (the marker stays as this session's armed marker); READY unless another LOCKED reason holds | new state |
| Q1 | app quit | — | wait for the queue to drain (≤ 5 s); abort fetches; if `markerOwned`, `overlay` is empty, `!writeFailedSinceLastOk`, `uncertain` is null and the boot sweep succeeded, unlink `vault.open` and fsync `secrets/` | — |

Port order: main → server messages are FIFO, and server → main messages are FIFO. A fetch posted before an exposure change is dispatched and then aborted by X1; one posted after it is refused at ingress.

### 5.3 The Vault writer (own file, own queue)
One serialized queue in main. A write = `seal(next)` then `writeFileDurable(<profileDir>/secrets/vault.bin)` (temp `vault.bin.<pid>.tmp`, fsync, rename, then POSIX directory fsync or the Windows reopen-flush, `electron/durable-write.mjs:9-27`). When it throws:
0. Unlink the temp if it still exists (best effort; boot sweeps it otherwise, 5.4 step 4).
1. `disk = readBack()` (decrypt and parse the file as it is now).
2. `disk` equals `doc` (the file still holds the last durable document): NOT_KEPT, store stays READY (Fable r3 M2).
3. `disk` equals `next`: re-persist `next` with the full durable path. Ok → `doc = next`, KEPT. Throws → **UNCONFIRMED**: `uncertain = {next, opIds}`; the op is not usable (fetch checks `effective`, built on `doc`), the card says "Not confirmed yet" (Astra conv4 #3).
4. Read fails, or `disk` is neither `doc` nor `next`: **UNCONFIRMED** with `uncertain = {next, opIds}`, and **no further write of any kind** until reconciled (Astra conv4 #4).
Reconciliation (before every later job, on the page Retry, and by a 60 s retry job, never by a timer outcome): read back; equals `uncertain.next` → re-persist it durably → `doc = next`, ops KEPT; equals `doc` → ops NOT_KEPT, writes resume; unreadable after the app had read it this session, or any other document → **BROKEN** (D5: fetch refused, no write, bytes kept, page line). While `uncertain`: widenings NOT_KEPT(store-unconfirmed), narrowings enter `overlay` and wait, fetches answer from `effective` (which never includes the unconfirmed op).
A failure sets `writeFailedSinceLastOk`, so the marker stays armed at quit (D27). The next successful write persists `apply(overlay, doc)` plus its own op, so the file returns to exactly what main holds.

No other code writes `secrets/`. Nothing outside the Vault ever waits on this queue (Astra conv3 #9 by construction).

### 5.4 Boot (main)
1. Store state from the platform (D6) and `VAULT_ENABLED`. `profileDir = dirname(CREDENTIALS_FILE)`.
2. **Marker first (D27):** `secrets/vault.open` exists → `review = true`, `markerOwned = false`, one in-app notice "Saved secrets are paused. Check them in Settings → Vault." (Fable r3 M4). This is decided before any step below can fail.
3. Read `vault.bin`: confirmed absence (ENOENT on `secrets/` or the file) → empty `doc`, no directory is touched; decrypt/parse/schema failure → BROKEN (D5); ok → `doc`.
4. Sweep (only when `secrets/` exists): unlink every `secrets/vault.bin.*.tmp`, then fsync `secrets/`. Failure → LOCKED(store-unavailable) and **all Vault writes held** (narrowings stay in memory) until a retry of the sweep succeeds (Astra conv4 #8, conv4b #5).
5. Re-persist (only when `vault.bin` exists and is not BROKEN): write `doc` with the full durable path, so every receipt the boot read sees is durable and M4's KEPT-by-receipt is true (Astra conv4 #3); failure → LOCKED(store-unavailable) with Retry.
6. Marker arm (when `vault.bin` exists and `review` is false): create `vault.open` (`O_CREAT|O_EXCL`, fsync file, fsync `secrets/`), `markerOwned = true`; failure → LOCKED(store-unavailable).
7. READY, or LOCKED(review) while `review`.
8. Each server fork: `vault-hello` → index; `vault-op-status` for every non-terminal op record.

First write of each session (new Vault, a restored profile whose directories do not exist yet, `server/installation-restore-preparation.ts:246`, or a retry after a failed preparation): **preparation** = create each missing directory down to `secrets/`, then fsync (POSIX) **every directory on the chain** `secrets/`, `profileDir`, and each ancestor up to and including the userData root, whether this session created it or not, so a retry after a failed parent fsync, also after a restart, re-establishes the barrier (Astra conv4c #3); then the marker. `dirsDurable = true` only when all succeed. A preparation failure → NOT_KEPT(store-unavailable), nothing written. Once the document write starts, 5.3 alone decides (a rename followed by failed flushes is UNCONFIRMED, never NOT_KEPT) (Astra conv4c #2).

**Windows barriers (Astra conv4c #4).** Windows has no directory fsync (`server/atomic.ts:90`, `electron/durable-write.mjs:18-22`). On win32 every "fsync a directory" step above is skipped (NTFS journals directory entries, as the existing writer relies on); the marker is created with `O_CREAT|O_EXCL`, written and flushed with reopen + FlushFileBuffers; the sweep and the marker removal are plain unlinks. A Windows boot therefore never fails on a directory barrier.

Why the marker closes the lost-narrowing case: it is created while the disk takes writes (boot), so a later narrowing needs no write to stay fail-closed. If the narrowing's write fails (full disk, copy-on-write snapshot, keychain prompt) and Murage then crashes or quits, the marker is still there; quit removes it only when this session owns it and everything is saved. A review is latched: quitting from it, or from any failed boot, keeps the marker, so the next boot is in review again. A crash with nothing unsaved also leaves it: that costs one Resume press and is stated on the page.

**One terminal path:** every op ends KEPT or NOT_KEPT(reason) at the end of its own job (M3), after reconciliation of an UNCONFIRMED write (5.3), when a later write that includes a PENDING narrowing succeeds (M3), or by receipt after a restart (M4). PENDING and UNCONFIRMED are not terminal and are never shown as failure. No timer creates an outcome.
Invariants: **V1** "kept" only when a document containing the op completed a full durable write. **V2** no fetch is checked against anything wider than `effective`; a narrowed target is usable again only after a later widening on it is KEPT. **V3** `vault.bin` is never written while BROKEN. **V4** after an unsaved narrowing, no fetch runs after a restart until the owner presses Resume. **V6** an op is reported KEPT only from a durable write of this session or a receipt in a document re-persisted at boot; NOT_KEPT only when the file is known not to hold it. **V5** no Vault value is ever in the server process except while a save is forwarded.

## 6. Fences

- F1 No value in: logs, transcripts, events, tool results, prompts, server memory after forwarding, argv or environment of any process, any child, any file except `vault.bin`, config.json, backups, restore bundles, feedback/telemetry/crash payloads, renderer responses, op records.
- F2 Grant, origin, slot, `replacing`, store state, exposure, turn liveness: checked in main in the same synchronous step as dispatch (D13).
- F3 Delivery only through `vault_fetch`, only in the pinned slot, only to a pinned origin, only to public addresses, no redirects.
- F5 No binding (D8).
- F6 Durability: V1, V4 (5.3, 5.4).
- F7 Broken store: V3.
- F8 Weak storage: D6 LOCKED reaches card and page.
- F9 Scrub: matcher from **this call's value only** (for `basic:<user>` also `user:value`). Forms per value, exactly 13 (identical byte strings collapse): raw; JSON-string-escaped; `encodeURIComponent`; form-urlencoded; HTML-escaped; base64 standard at byte offsets 0, 1, 2 (stable core, padding removed); base64 URL-safe at offsets 0, 1, 2; hex lower; hex upper. One Aho-Corasick pass over the body bytes with carry-over of (longest form − 1) bytes, longest match first, each match → `[masked]`; then decode; then cap.
- F10 Epoch inside the queue (M3) and at dispatch.
- F13 Narrowing, REPLACE, exposure, Stop, turn end and server exit abort in-flight fetches.
- F15 Egress: pinned origin, `https`, public addresses, verified TLS, no system proxy, no redirects.
- F16 Exposure gate (D25).

## 7. Migration and compatibility

- From Murage today: nothing to migrate. `credentials.bin` is never read or written by the Vault.
- Inventory: `secrets` and `connection-profiles` stay `excluded(CREDENTIAL)` (already in 1.0.20 and 1.0.21); the `secrets` comment names VAULT-M7 as owner of `secrets/vault.bin`, `secrets/vault.open` and their temps.
- Downgrade to 1.0.20 and back: 1.0.20 ignores `secrets/`, its backups keep working (the name is classified) and exclude it; re-upgrade finds the items unchanged (W19).
- Restore: `secrets/` never travels in a backup; a restored computer starts with an empty Vault. Same-machine restore selects a fresh connection profile (`restored-connections.mjs`), and the Vault follows it, so the restored installation starts empty even though bot ids match, and the original's Vault is untouched.

## 8. Cloud vs desktop

| | Desktop (macOS, Windows, Linux with keyring) | Linux without keyring | Headless / container | Cloud home |
| --- | --- | --- | --- | --- |
| Store state | READY | LOCKED(keyring) | LOCKED(headless) | LOCKED(cloud) |
| `vault_fetch`, custom card | yes | no (reason line) | no (reason line) | no (reason line) |

My Cloud send is V5 (held until MurageCloud signs; r3 §8 contract carries over).

## 9. Witnesses (each RED first on the builder's base, GREEN after, plus the named mutant RED)

Real path rule: real routes, real proxy tool, real `InternalCapabilityRegistry`, real main Vault module in a real Electron main test harness (or driven through a real `MessageChannel` from a real utility-process fixture), real `writeFileDurable` with fault seams only at the OS boundary (write, fsync, rename, unlink, decrypt), a real local HTTPS fixture server (test-only CA), real Node `https`. Seams are barriers inside the real path (hold a write, pause before the request's socket connects), never a mock of the unit under test. Each sink in W3 has its own mutant. Public-address rows use an injectable resolver at the `lookup` boundary only.

| W | Promise/fence | Scenario | Mutant that must turn it RED |
| --- | --- | --- | --- |
| W1 | P1 | bot asks `custom:stripe key` for `https://api.fixture.test` in two turns: second gets "is saved", no card; `vault_fetch` reaches the fixture with `Authorization: Bearer <sentinel>` | lookup ignores saved items |
| W2a | P2/F2 | item granted to A; B asks the same name → card; B's `vault_fetch` → refused, fixture sees nothing | grant check removed |
| W2b | P2/F3/F15 | origin not on the item, `http:`, host resolving to 127.0.0.1 / 10.x / ::1 / link-local, `HTTPS_PROXY` set in main's env → refused or direct; fixture B never receives the sentinel | origin check removed; lookup hook removed; Electron `net` used |
| W2c | P2/D26 | model passes `Authorization`, the pinned header name, `accept-encoding`, `range`, or the pinned query param → refused; value only in the pinned slot; fixture answers 302 same-origin with the query value in `Location`, and 302 cross-origin → zero follow-up requests, `Location` scrubbed / reduced to origin | reserved check removed; same-origin redirect followed |
| W2d | 4.1 GRANT (Astra conv4b #4) | item with staging + production origins; B's card for staging → GRANT names both origins and the slot; a request adding an origin shows the separate "Adds a new site" line; a different slot → no GRANT; B's card open showing staging only, owner adds production on the page, then accepts the card → NOT_KEPT(changed), B gets nothing | single-origin disclosure; GRANT across slots; generation bumped only by narrowings |
| W3 | P3/F1 (Astra conv4b #6) | server ingress tap (every request body the server reads, `server/read-body.ts`) and server heap at the moment main receives the value → 0 sentinel; card answered from a browser client offers no value field; sentinel through card save, page add, `vault_fetch` (bearer, header, basic, query): native log, server log, store DB, op records, events, transcript, system prompt, config.json, feedback payload, error replies, every file under userData except `secrets/vault.bin`, workspaces, tmpdir (raw + base64 + hex) → 0; a heap snapshot of the server process after the save is forwarded and after 10 fetches → 0; `/proc/*/environ` and `/proc/*/cmdline` of the app tree → 0 (Linux; spawn-env capture on Windows/macOS) | omission removed from that sink (one per sink); value forwarded to the server in the fetch reply; value posted through the server owner route |
| W4 | P4 (Astra conv4c #2, #3, #4) | empty profile, first SAVE renames and both flushes fail → UNCONFIRMED until a successful flush, then KEPT; mkdir ok but a parent fsync fails → NOT_KEPT, retry (also after restart) fsyncs the whole chain before KEPT, then simulated loss of unsynced entries keeps the Vault; Windows row: normal boot READY with no directory fsync, marker flushed; writer write held; card "Saving…"; release → KEPT; continuation only after KEPT. Fresh profile, and a restored connection profile whose directory tree does not exist: boot is READY with an empty Vault, the first SAVE is KEPT; then a first SAVE with a seam that drops directory entries not covered by an fsync of their parent (simulated power loss) → either KEPT and the Vault and marker survive, or NOT_KEPT | KEPT on post; resume before outcome; one ancestor fsync omitted; boot fsyncs a missing `secrets/`; first-write failure always NOT_KEPT; retry fsyncs only new directories; directory fsync on win32 |
| W5 | M4 | server killed (exact pid) after settlement commit, before posting → NOT_KEPT(restart), card says so | boot status skipped |
| W6 | M4 | main wrote, server killed before the reply → new server: KEPT by receipt. Process-only restart row: SAVE renames, both durability steps fail (UNCONFIRMED), main killed before reconciling → next boot re-persists durably (2b) and then reports KEPT; with the boot re-persist failing, and separately with the boot decrypt failing → `vault-op-status` answers UNCONFIRMED ("Not confirmed yet"), never KEPT or NOT_KEPT | outcome from final item state; receipt-only recovery without the boot re-persist; missing receipt treated as absence while unreadable |
| W6b | 5.3 | throw after rename (directory fsync seam): readBack = next and re-persist ok → KEPT; throw before rename (readBack = doc) → NOT_KEPT, store stays READY, the next fetch succeeds; readBack = next and re-persist fails → UNCONFIRMED only ("Not confirmed yet"), widenings refused; reconcile with seams cleared → KEPT; readBack fails → UNCONFIRMED and the file bytes stay unchanged through a second SAVE attempt (refused); readBack later succeeds = doc → NOT_KEPT and writes resume; readBack later fails again → BROKEN, bytes unchanged | KEPT on readBack without re-persist; pause on ordinary failure; NOT_KEPT while the file may hold the op; writing from cached `doc` while uncertain |
| W6d | D1 | every Vault op with and without failed writes leaves `credentials.bin` bytes and mtime unchanged; a provider-key save concurrent with a held Vault write completes | Vault op written through `updateSecureCredentialDocument` |
| W6e | D22 | write held 40 s (keychain prompt), then released → KEPT, never NOT_KEPT; server re-forked meanwhile → its `vault-op-status` answers only after release, KEPT | status answered outside the queue; timer outcome |
| W6i | D5 (Astra conv3 #9) | `vault.bin` with `v: 2`; delete a bot; provider-key save completes; `vault.bin` bytes unchanged; fetch refused | narrowing job writes while BROKEN; Vault job on the shared queue |
| W7 | F10 | old-epoch SAVE queued behind a held job; child replaced; release → NOT_KEPT(epoch), file unchanged | epoch checked only at receipt |
| W8 | D15 | every narrowing increments the item generation exactly once; 100 mixed ops (SAVE, GRANT, REVOKE, DELETE) from 100 cards → all terminal; file = sequential application; every revoke holds | ops applied outside the queue |
| W8b | D15/D16 | GRANT on X with its write held; DELETE X accepted meanwhile; release → GRANT KEPT (its write was durable), DELETE stays in `overlay` and its own job then writes the deletion; fetch on X refused from the DELETE onward; final file has X deleted; a crash between the two writes → LOCKED(review) | widening `next` replaces `effective` (drops the overlay) |
| W8c | D17 | 1024 unacked receipts → SAVE refused with the reason, REVOKE applies; after `vault-ack` SAVE works | receipts pruned before ack; narrowing refused |
| W9 | P5/D5 | decrypt fails at boot → BROKEN; save and fetch refused; bytes unchanged. Mid-session: a write fails, readBack cannot decrypt, a second SAVE arrives → refused, bytes unchanged; reconcile still unreadable → BROKEN | BROKEN treated as empty; continuing from cache |
| W10 | D6/D24 | Linux `basic_text` with and without `MURAGE_ALLOW_PLAINTEXT_SECRETS=1` → LOCKED(keyring); no card | opt-in honoured |
| W11 | D6 | headless → LOCKED(headless), no card, config.json never holds a value | headless writes config.json |
| W12 | D24/D25 | No limits turn → no custom card, text points to Settings; that bot's Full access puts the store in LOCKED(full-access) and refuses every bot's fetch | card on No limits; fetch under exposure |
| W13 | F9 | fixture echoes a sentinel whose 13 forms are distinct (contains `"`, `&`, `<`, space, `/`; its base64 has `+` and `/`) once in each form → engine-side bytes hold 0 hits, `masked = 13`; forms split across two TCP chunks and across the 256 KiB cap boundary masked; same echo with `content-encoding: gzip`, with `charset=utf-16`, and as a 206 with `content-range` → `{size, sha256}` only | each form dropped (13 mutants); cap before scrub; no carry-over; gzip treated as text |
| W13b | F9 isolation | B's identical fixture call with and without A's item saved (A's value in the response) → B's results byte-equal | matcher from all items |
| W13c | F1 errors | TLS, DNS, refused address, timeout with a `query:` slot → fixed strings, no URL, no value | raw library error |
| W13d | 4.4 step 6 | sentinel in a `Content-Type` parameter, the reason phrase and a `Location` → 0 hits in result and log | raw header forwarding |
| W14 | F9 cost | 4 values (basic), 1 MiB response → the matcher's scan runs once over the body (call count = 1) | per-form loop |
| W15a | D13 | barrier after main registers the request, before its socket connects; owner REVOKEs the bot → request aborted, fixture sees no request | abort not wired to narrowing |
| W15c | F13/P6 | long fixture response; DELETE / REVOKE / REMOVE_ORIGIN / REVOKE_BOT rows → aborted; next call refused | no abort |
| W15d | D13 | Stop confirmed (`vault-turn-end`) before the fetch message reaches main → refused; mid-request → aborted | turn liveness checked only at ingress |
| W15f | D13 (Astra conv3 #2, conv4 #6) | REPLACE accepted with its write held; a fetch arrives → refused (`replacing`), fixture sees no old value; release → next fetch sends the new value; REPLACE whose write fails (readBack = doc) → old value usable again, card says not replaced; a second REPLACE submitted while the first is held → refused at once; the first then fails → the item is usable with the old value only after the first is terminal, and never while any REPLACE on it is pending | `replacing` mark removed; a per-item flag cleared by the first op while a second is pending |
| W16 | D16/V2 (Astra conv4b #7, conv4c #5) | DELETE whose write fails before rename → item refused at once, outcome PENDING ("Removed. Not saved yet"), never NOT_KEPT; server restart → still PENDING; a later SAVE of another item KEPT → the deletion is in that write; app killed before the DELETE's own job; restart → item gone and `vault-op-status` for the DELETE answers KEPT | widening write omits the overlay; only the SAVE's receipt written |
| W16i | D27 (Astra conv3 #4, conv4 #2, conv4b #1) | seam fails every write and rename after boot (full CoW volume), unlink still works; DELETE of a granted item; app killed, and separately a clean quit → next boot LOCKED(review), no fetch; then quit from review without Resume (unlink working) → the boot after that is still LOCKED(review); a boot whose sweep fails, then quit → still review next boot; a restored profile's quit never touches the original profile's marker; Resume → READY; a normal clean quit → next boot READY | marker created at narrowing time instead of at boot; marker removed at quit despite the overlay; marker removed on a quit from review; guard on displayed state instead of `markerOwned`; marker at a shared `userData` path |
| W16j | D27 (Astra conv4c #1) | marker creation fails at boot → LOCKED(store-unavailable), no fetch; DELETE then → outcome "Not removed" while arming still fails; crash, disk recovered, restart → the owner was told not removed and the page shows the item; with arming succeeding at the DELETE → normal path, a crash → LOCKED(review) | READY without a marker; narrowing reported removed with no armed marker |
| W16k | D1 (Astra conv4 #8, conv4b #5) | SAVE of an item, then an unrelated write killed after the temp is written and before rename; restart; DELETE the item → no file under `secrets/` other than `vault.bin` and `vault.open`, and no sealed file anywhere under `profileDir` decrypts to a document holding the sentinel. Unlink of the temp fails at boot (seam) while `vault.bin` is writable → DELETE in effect in memory, no disk write, outcome UNCONFIRMED; seam cleared → sweep, then DELETE KEPT | boot sweep omitted; writes allowed with a failed sweep |
| W19b | D1 (Astra conv4 #5) | same-machine restore (fresh connection profile) with matching bot ids → restored installation's Vault empty, no grant usable; delete there; undo the restore → the original item and grant intact | fixed `userData/secrets` path |
| W17 | F5/D8 | config.json with `vault:`-like strings, an MCP server naming an item → no value anywhere, no binding route | `resolveHeldEnv` consults the Vault |
| W18 | D10 | prompt lists only granted names with origins, quoted, ≤ 40, control chars stripped | quoting removed |
| W19 | 7 | released v1.0.20 on a profile with items: provider-key edit, backup succeeds and holds no file under `secrets/`; re-upgrade → `vault.bin` byte-equal, items usable | Vault file at an unclassified top-level name; Vault file at a classified backed-up name (positive control: the backup then holds it) |
| W22 | 4.1 | double submit → one settlement, second 409; dismiss then submit → 409; group room → only the asker granted | no CAS |
| W23 | 4.1 | card shows "<bot> wrote this"; value for an existing nameKey with another slot creates `<label> (<bot>)`; original unchanged; the card offers no chat-only choice | card performs REPLACE |
| W24 | 4.5/D19 | delete a bot with grants and a request in flight → aborted, grants gone; also with the write failing and a restart (LOCKED(review); after Resume the old grant names a bot id nobody has); re-created bot with the same name gets a new id and no grants | no REVOKE_BOT; id reuse |
| W25 | D14 | 7-byte, multi-line or non-ASCII value on card or page → refused with the reason | check removed |
| W26 | D18 | `VAULT_ENABLED=false` → no tool, card refuses, page LOCKED(disabled), `secrets/` bytes unchanged | flag ignored |
| W27 | D23 (Astra conv3 #6) | fixture accepts a POST; the server drops the reply to the proxy; the engine redelivers the identical call (a) with the same request id, (b) concurrently during dispatch, (c) after a proxy remount with a **new** request id; (d) while the first delivery waits in DNS lookup (barrier in the `lookup` hook); plus an order probe asserting the map entry is RESERVED before the request object is created; also the server re-forked between (the turn ends: refused at ingress) → fixture counts 1 request; (a)-(c) get the stored result; the same call with `repeat: 1` → fixture counts 2 | key with request id or instance id; reservation after dispatch |
| W28 | R1/R2 | card and page render the R1 (incl. the demotion sentence) and R2 lines | line removed |
| W29 | P3 (no new reader path) | two bots: A granted, B not, both at Auto on a qualified pair (positive control: A's fetch reaches the fixture); B's tools, workspace, processes' environments, every app-tree process's environ/cmdline, the data folder, native log → 0 sentinel | value placed in any env, argv, file or child |
| W29b | D25 | per engine/OS pair: a non-Full bot's real sandboxed command tries to read another turn's credential file; pairs that read it stay out of `vault-qualified-sandboxes.ts`. B at Full access copies A's bearer and calls `vault_fetch` as A → refused. Task-only rows: B's default stays Auto but one of B's tasks is set to Full access (and separately to an unqualified engine) → exposure active, A refused | admission by bearer alone with exposure active; exposure from bot defaults only |
| W29c | D25 (Astra conv3 #1, conv4 #1) | A's turn starts; B gets Full access (bot default; second row: task override only); B copies A's bearer; B loses Full access while B's elevated turn is still live → still active until that turn retires; after it retires the copied bearer (A's turn still live) → refused; a claim minted during the pause, and a claim minted after the pause for a turn whose setup began during it → refused; A's next turn → succeeds | admission compares `active` only, not `vaultGen`; exposure ends at demotion instead of turn retirement; `vaultGen` taken at mint instead of turn start |

The builder runs W29b first and attaches its table to Q1 (Fable r3 build condition A). Windows and macOS rows (W3 process rows, W6b seams, W16i, W29) go through WINRUN-REQ / the Mac relay.

## 10. Slices in the 1.0.21 train

This design is slice **V1** (S1 main Vault + writer + marker + fetch executor; S2 server ingress + exposure gate + card + page + bot delete). It ships alone and is fully safe alone. Each follow-up is its own design round (Fable + Astra) in the same train and may not weaken V1's fences:

| Slice | What moved | Owner | Entry condition |
| --- | --- | --- | --- |
| V2 chat holds ("Only for this chat", NOT_KEPT fallback) | r3 4.1 steps 6-9, M1b | VAULT-M7 builder | a hold is an `effective` entry in main, fenced by D13 like items; display only from the live index |
| V3 1Password | r3 4.5, D12, W20/W20b | VAULT-M7 builder | reads run inside main's fetch step; any `await` for the SDK is followed by a full re-check in one synchronous step before dispatch; relink is a synchronous main handler that aborts in-flight fetches |
| V4 shared writer reconcile (`credentials.bin`, existing Fable r2 H1 bug) | r3 5.3, D21, W6d/f/h | MAIN (no builder yet: OPEN NO-OWNER) | its own design; not a Vault dependency |
| V5 Also use on My Cloud | r3 4.6, §8, W21/W21b | VAULT-M7 sender, MurageCloud receiver | MurageCloud signs |
| Part 2: command delivery, MCP binding | r3 11.1, 11.2 (carried unchanged) | VAULT-M7; D3 for MCP | MAIN rulings Q2, Q3 |

## 11. r3 open findings: disposition

| Finding | Sev | r4 | Mechanism | Witness | Mutant |
| --- | --- | --- | --- | --- | --- |
| Astra conv3 #1 bearer copied during the pause works after it | Critical | CLOSED | D25 `vaultGen` in the claim; gen bumps on every exposure change | W29c | compare `active` only |
| Astra conv3 #2 lease asked after REPLACE starts | High | CLOSED (no leases) | D13 single-step dispatch in main; `replacing` | W15f | `replacing` removed |
| Astra conv3 #3 failed rollback adopts a sign-in draft | High | CLOSED for the Vault (no shared writer use); the writer bug moves to V4 | D1 own file | W6d | Vault through the shared writer |
| Astra conv3 #4 CoW full volume defeats journal slots | High | CLOSED (no journal) | D27 armed marker | W16i | marker created at narrowing time |
| Astra conv3 #5 Forget vs issued lease; stale "usable" | High | REMOVED (V2) | no chat holds in V1 | W23 (no chat choice) | — |
| Astra conv3 #6 remount changes the invocation id | High | CLOSED | D23 key from the call, map in main | W27 (c) | key with request id |
| Astra conv3 #7 redirect carries the query value | High | CLOSED | D26 no redirects | W2c | same-origin follow |
| Astra conv3 #8 preload relink bypasses the fence | High | REMOVED (V3), and V3's entry condition makes relink a main handler | — | — | — |
| Astra conv3 #9 narrowing in BROKEN stalls the shared queue | High | CLOSED | own queue; no write while BROKEN | W6i | Vault job on the shared queue |
| Fable r3 M1 decode order | Med | fixed | 4.4 step 6 | W13 rows | gzip as text |
| Fable r3 M2 DIVERGED on ordinary failure | Med | fixed | 5.3 step 3 | W6b | pause on ordinary failure |
| Fable r3 M3 main narrowing waits for server ack | Med | gone | no handshake (D13) | W15a | — |
| Fable r3 M4 dirty boot unexplained | Med | fixed | 5.4 step 3 notice + page line | W16i | — |
| Fable r3 M5 claim issue time | Med | fixed | `vaultGen` | W29c | — |
| Fable r3 M6 look-alike origin | Med | fixed | 4.1 step 4 | W2d | — |
| Fable r3 M7 text drift, W14 timing | Med | fixed | 13 forms; W14 call count | W14 | — |
| Fable r3 M8 request id restart | Med | fixed | D23 | W27 | — |
| Astra conv3 Medium W29 control, W12 | Med | fixed | W29 at Auto; W12 under exposure | W29, W12 | — |

### 11.1 In-lane Astra round 1 on r4 (865881b834, BLOCK 8) → r4b

| Astra conv4 | Sev | Mechanism | Witness | Mutant |
| --- | --- | --- | --- | --- |
| #1 task-level Full access / engine not in the gate | Critical | D25 over every task projection and every live turn until retirement | W29b task rows, W29c | bot defaults only; exposure ends at demotion |
| #2 quit from review removes the marker | High | review latched; quit from review keeps the marker (D27, Q1) | W16i | marker removed on a quit from review |
| #3 ambiguous write reported by receipt as KEPT | High | UNCONFIRMED until reconciled; boot re-persists `doc` before READY (5.3, 5.4 step 5) | W6 restart row, W6b | receipt-only recovery |
| #4 write from cached doc over an unreadable file | High | no write while `uncertain`; still unreadable at reconcile → BROKEN | W9 mid-session, W6b | writing from cache |
| #5 same-machine restore shares the Vault | High | Vault under `dirname(CREDENTIALS_FILE)` | W19b | fixed path |
| #6 two REPLACEs, first clears `replacing` | High | second REPLACE refused while one pending; mark cleared only on a terminal outcome | W15f | per-item flag cleared by the first op |
| #7 new `secrets/` directory entry not durable | High | mkdir + fsync `profileDir`, then marker, then file (5.4 step 3) | W4 fresh-profile row | parent fsync omitted |
| #8 sealed temp survives a crash | High | temp unlinked after a failed write; boot sweep before READY | W16k | sweep omitted |
| Medium: exposure at turn start; double narrowing apply; 206; D23 bound | Med | `vaultGen` captured at turn start; narrowing applied once; 206 rule in 4.4; 8 MiB per turn | W29c, W8, W13 | — |

### 11.2 In-lane Astra round 2 on r4b (2bed3eafd0, BLOCK 7) → r4c

| Astra conv4b | Sev | Mechanism | Witness | Mutant |
| --- | --- | --- | --- | --- |
| #1 review lost after a failed boot; shared marker path | High | marker checked first; `markerOwned` separate from displayed state; marker per profile (D27, 5.4 step 2) | W16i | state-only guard; shared path |
| #2 M4 invents KEPT/NOT_KEPT during boot failures | High | M4 verdicts only after the boot re-persist; otherwise UNCONFIRMED; W6b text fixed | W6, W6b | receipt-only; missing-means-absent |
| #3 first save on a fresh or restored profile | High | confirmed absence = empty; each missing ancestor created with parent fsync | W4 | ancestor fsync omitted |
| #4 stale GRANT widens consent | High | every scope change bumps the generation; GRANT carries the displayed generation | W2d | narrowing-only counter |
| #5 failed temp cleanup, DELETE still writes | High | all writes held until the sweep succeeds | W16k | writes with a failed sweep |
| #6 values pass through the server | High | D28: renderer → preload IPC → main, joined by op token | W3 ingress row | value through the owner route |
| #7 batched narrowing loses its receipt | High | receipts for every narrowing in `snap` | W16 | only the op's receipt |
| Medium: W27 reservation; W19 positive control | Med | W27 row (d); W19 backed-up control | W27, W19 | — |

### 11.3 In-lane Astra round 3 on r4c (fe8d5c3736, BLOCK 5) → r4d, cap reached: folded in, NOT re-reviewed by Astra

| Astra conv4c | Sev | Mechanism | Witness | Mutant |
| --- | --- | --- | --- | --- |
| #1 narrowing accepted with no armed marker | High | arm before acknowledging; else "Not removed", store LOCKED | W16j | removal reported with no marker |
| #2 first-write rule NOT_KEPT after rename | High | preparation vs document write; 5.3 decides after the write starts | W4 | unconditional first-write rejection |
| #3 retry skips the parent barrier | High | fsync the whole chain on every session's first write | W4 | fsync only new directories |
| #4 Windows has no directory fsync | High | win32 barriers: none for directories, FlushFileBuffers for the marker | W4 Windows row | directory fsync on win32 |
| #5 failed narrowing reported terminal, later committed | High | narrowings PENDING until a covering write; M4 answers PENDING | W16 | terminal NOT_KEPT on first failure |
| Medium: W27 order; Q1 cleanup wording | Med | W27 order probe; Q1 text aligned | W27 | — |

Every earlier r2/r1 finding that r3 closed by removing a surface stays closed (no command delivery, no env, no file delivery). Those r3 closed with leases, the journal or the shared writer are now closed by the r4 structure: lease races (D13), journal retirement (no journal; D16 overlay leaves only by a durable write that contains it), unreadable-boot outcomes (BROKEN never writes; M4 by receipt), restored-profile journal (no journal; `secrets/` never restored).

## 12. GAP-CHECK (one adversarial pass on r4, GAP-CHECK-BAR)

### Fixed
1. (b failure path) Owner deletes an item, the disk is full, Murage then crashes: r3's journal write could fail too; r4's marker was armed at boot, so the next boot is LOCKED(review) and no bot uses the item before the owner looks (D27, W16i).
2. (d safety) A REPLACE is pending and a bot's fetch arrives: one event loop, `replacing` refuses it (W15f).
3. (d safety) The owner revokes a bot while its request waits for DNS: the request is registered before any `await`, the revoke aborts it, nothing is sent (W15a).
4. (d safety) A bot with Full access copies another bot's bearer, then is demoted: the copied claim's `vaultGen` is stale (W29c).
5. (d leak) A login endpoint redirects with the key in the return URL: no redirect is followed; `Location` is scrubbed (W2c).
6. (b failure path) The engine re-sends a POST after a proxy remount with a new request id: same `invocationKey`, joined (W27).
7. (d leak) A gzip or UTF-16 response echoes the key: never scrubbed-as-text; only size and hash return (W13).
8. (b failure path) A Vault file from a newer version: BROKEN, nothing waits, provider-key saves still work (W6i).
9. (b failure path) Downgrade to 1.0.20: the Vault file lives under an already-classified name, so 1.0.20 backups do not stop (W19).
10. (b failure path) A save fails before the rename (keychain prompt declined): NOT_KEPT, store stays READY (W6b).
11. (b failure path) The server process dies with a fetch in flight: main aborts it (E1); the turn is over, a redelivery is refused at ingress.
12. (e cheap enhancement) Main logs nothing per call, and the server never holds a value during a fetch: the value only crosses the port once, at save time (W3 heap row).
13. (b failure path) A crash with nothing unsaved also lands in LOCKED(review): stated on the page, one in-app notice, Resume is one press (5.4).
14. (d safety) The owner sets one of B's tasks (not B's default) to Full access: the gate reads task projections and live turns (D25, W29b).
15. (b failure path) A save renames but cannot be flushed, then Murage restarts: "Not confirmed yet" until boot proves it durable (5.3, 5.4 step 5, W6).
16. (d safety) A same-machine restore reuses bot ids: the Vault follows the connection profile, so the restored copy starts empty (W19b).
17. (d leak) A crash mid-write leaves a sealed temp holding a value the owner later deletes: swept before READY, and no write happens until the sweep succeeds (W16k).
18. (d leak) The server read a value in every card or page save: values now go from the desktop renderer to main directly (D28, W3).
19. (d safety) A card open for minutes grants a scope the owner widened meanwhile: refused as changed (W2d).
20. (b failure path) A SAVE carries a revoke in its snapshot and Murage crashes: the revoke has its own receipt (W16).
21. (b failure path) The disk is full at boot and the owner deletes a secret: told "Not removed" instead of a removal that a crash would undo (W16j).
22. (b failure path) A Windows boot: no directory barrier that Windows cannot do (W4).

### Parked (one-line reason, for the product owner / MAIN)
- Chat-only holds, 1Password, My Cloud: moved to V2, V3, V5 in the same train (10); scope cut, not dropped.
- Shared writer stale-`current` bug for `credentials.bin` (Fable r2 H1): existing behaviour, not used by the Vault; V4, owner MAIN.
- Telling a crash apart from a lost narrowing so a plain crash needs no Resume: needs a write at failure time, which is exactly what can fail; one Resume press is the safe cost.
- Programs a Full-access bot started before demotion: R1, stated on the page (Fable r3 parked).
- Sender-bound internal authority (would lift the D25 pause): changes every internal route; its own design.
- Command delivery and MCP binding: part 2 (Q2, Q3).
- Private-network origins, signing schemes (SigV4, HMAC), OAuth refresh, compressed or UTF-16 bodies returned as text: new surfaces.
- A site that echoes a value transformed (reversed, split): R2.

### Rejected
- Per-item reveal: violates P3.
- Per-call approval card: violates the No limits rule (D20).
- Following same-origin redirects for header slots: a bot can repeat the call to the `Location` itself; following saves one call and reopened Astra conv3 #7.
