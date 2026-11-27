# VAULT-M7 part 1 (1.0.21): saved secrets, design r3

STATUS: r3 (r3c after three in-lane Astra rounds; round 3 BLOCK 9, all nine folded in as r3c and not yet re-reviewed by Astra), convergence round. Supersedes r2 (`DESIGN-r2.md`, 6d8b70d3ba) in full; r1 and r2 stay for history. Security row: no builder starts until Fable AND Astra AGREE and the product owner answers QUESTIONS-r3 Q1-Q3.

Owners (each side of each contract):
- Main-side Vault authority (`electron/vault-authority.mjs`, new: the op queue jobs, the lease answer, the narrowing journal, the chat holds) and the one change to the shared writer (`electron/secure-credential-state.mjs` reconcile, 5.3): **VAULT-M7 builder lane** (producer; seated by MAIN). Until seated: **OPEN NO-OWNER builder**.
- Server side (`server/vault/*`: index copy without values, op records, custom card, `vault_fetch` route and scrub, prompt names, Vault page routes): **VAULT-M7 builder lane** (consumer of the main-side authority over the utility port).
- Every other section of `credentials.bin` and its existing writers (`updateSecureCredentialDocument`, `electron/main.mjs:2089`): existing desktop shell code, unchanged except that they inherit the reconcile rule (5.3). Owner of that module for review purposes: **MAIN** (no lane holds it today).
- MCP key custody (`mcpServerSecrets`, `server/mcp-secrets.ts`): **mcpskills-1021 lane (D3)**. Part 1 adds nothing to MCP custody (D8). Part-2 contract 11.2 names D3 as owner of the MCP side.
- Cloud half of "Also use on My Cloud" (receiver): **MurageCloud**. Desktop sender: VAULT-M7 builder. Held until MurageCloud signs (D7).
- 1Password adapter (runs in main): VAULT-M7 builder.
- Intake, review seats, scope rulings (Q2, Q3): **MAIN**; policy acknowledgement (Q1): **product owner**.

Code truth: hub `dev/1021` at `068a595c9a8ee59d1a9c994f7484ecd97ab4c48e`. Every `file:line` below is at that sha unless it says v1.0.20 (`183ec9be4b`).

Inputs closed by this round: Fable r2 fix-check (`frev-UPVAULT-r2/FABLE-R2.txt`: 3 High, 8 Medium) and Astra r2 re-review (`arev2-dsg-UPVAULT-r2/ASTRA-R2.txt`: 2 Critical, 11 High). CHANGES-r3.md maps every finding to a mechanism, a witness and a mutant, or to PARKED with a reason.

"Card" means a bot's secure in-app request card (`src/components/SecretRequestCard.tsx`), never a payment card.

## Why r3 is a redesign, not a patch

The r2 findings cluster in two places. Each cluster comes from one structural choice. r3 replaces both choices instead of adding guards around them.

1. **Two authorities for one fact** (Fable 1, 2, M5, M8; Astra 4, 5, 6). In r2 the server kept a memory copy of the Vault, a narrowing ledger, timers that produced outcomes, and a boot resolution, while main kept the document. The two disagreed after an uncertain write, a late reply, a server restart or a failed ledger write. **r3: main is the only Vault authority.** The server holds no values and no ledger. Every Vault read, op and outcome is a job in main's single credential write queue, so a read can never overtake the write it judges. Uses get a value from main per call (a *lease*), answered from main's own state. The shared writer reconciles with the file after an uncertain write, so no writer can derive from a stale document (5.3).
2. **A free-form command runner Murage cannot contain** (Fable 3; Astra 1, 2, 3, 8, 9, 10, 11, 12). `vault_run` let the model choose any program and give it the value. Murage has no per-command filesystem or network sandbox to put around it: the host-power block is a shutdown block, not a sandbox (`server/procs.ts:221-226,435-449`), and engine sandboxes belong to each engine. Every r2 command finding (containment, environment, surviving children, launcher diagnostics, recoverable output, plaintext in the workspace) follows from that. **r3 drops command delivery from part 1.** The only delivery is `vault_fetch`: Murage itself makes one HTTPS request to a **site the owner pinned on the item**, with the value placed by Murage in the **one slot the owner pinned** (a header or a query parameter), and returns the response scrubbed of that value. No local process ever receives a Vault value. Command use (CLI logins, PEM keys) moves to part 2 behind the contract in 11.1 (QUESTIONS-r3 Q2).

## 0. PURPOSE and USER PROMISES

PURPOSE: the owner gives an API key or token once, on a bot's secure card or on Settings → Vault, and the bots the owner chose can use it later in web requests Murage makes for them to the sites the owner allowed. This happens without a new card, without the value ever reaching a model, a file, a log or another program, and without it being stored anywhere but the encrypted store.

USER PROMISES (each is tested; section 9). Each says exactly what Murage enforces; what it cannot enforce is in 1.1.
- **P1 Save once.** A saved value is used again, with no new card, when a bot it is granted to asks for the same name for a site the item allows.
- **P2 Only chosen bots, only chosen sites.** Murage sends an item only for a bot listed on it, only to an origin listed on it (exact scheme, host and port), and only in the slot listed on it. A bot that is not listed gets a card for the owner to decide, never the value.
- **P3 Never in the model, a file, a log or another program.** No Vault value is ever in a prompt, a tool result, a transcript, an event, a log line, any process's argv or environment, any child process, any file other than `credentials.bin`, config.json, telemetry, feedback or a crash report. The response the bot sees has every pinned form of the value masked (F9). The pinned site receives the value: that is the owner's choice (1.1 R2).
- **P4 Honest "saved".** "Kept in the Vault" is shown only after main's write queue has confirmed the op's receipt in the document that is on disk. Before that the card says "Saving…" or "Not confirmed yet". A save that failed says why and that the value is usable in this chat for 1 hour only.
- **P5 Never silently weak, never silently lost.** The Vault is READY only where `credentials.bin` is sealed by the OS store (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet). Linux `basic_text`, headless servers and Cloud homes keep it LOCKED in part 1, with the reason. A Vault that cannot be read is never replaced or emptied.
- **P6 Owner control.** The owner sees every item (name, bots, sites, slot kind, source, last used; never the value), changes bots and sites, replaces the value, deletes it. A revoke or delete takes effect at once, aborts any request in flight that holds the item, and stays in effect across a failed write and a restart.
- **P7 Linked manager stays the source.** With 1Password linked, its fields are granted by their stable ids, read at the moment of use, never written to disk and never cached.
- **P8 My Cloud only on purpose.** (Held, S6.) An item goes to the owner's Murage Cloud only when the owner presses "Also use on My Cloud" for it.

## 1. Threat model

Assets: Vault values; the 1Password token; each item's bots, sites and slot.

| Actor | Can | Must not be able to |
| --- | --- | --- |
| Owner (renderer, owner routes) | everything in P6 | read a value back (no route returns one) |
| A bot / model (any engine), incl. one steered by prompt injection | ask by name with a proposed site and slot (`request_credential("custom:<label>", use)`); call `vault_fetch` for a granted item to a pinned origin | get an item not granted to it; send an item to a site or slot the owner did not pin; receive a value in any tool result, error or prompt; make Murage put a value in a file, argv, environment or child process; reach any origin through `vault_fetch` other than the pinned ones |
| Another bot (not on the item), through Murage | everything a bot can | get the value or a signal about it (mask counts, timing of masking) through any Murage tool, card, file or route |
| Engine child processes | what their drivers give them today | inherit or receive a Vault value (none is ever given to any child) |
| Disk thief / backup reader / old-version backup | read the data folder, workspaces and backups | find a value (values live only in `credentials.bin` in userData, excluded from data-folder backups, `server/data-dir-inventory.ts:299`) |
| A pinned site | receive the value in the pinned slot | receive another item, or receive it outside a request the granted bot made |
| 1Password | see the token and the fields read | receive any other Murage secret |

### 1.1 Residuals (stated; Q1 asks the product owner for a NEW acknowledgement)
- **R1 Same OS user.** A program running as the owner's OS user (any Full-access bot's command, or other software) can, on Windows and Linux, ask the OS store for the key that seals `credentials.bin`, and on Windows read Murage's process memory. **The Vault adds no new place where this is possible**: its values sit in the same file and the same two processes (main always; the server only for the length of one request) as the provider and workspace keys Murage holds today. Nothing about the Vault reaches a file, an environment, a child process or a pipe. Because a program running as the owner can also read a turn's bearer and act as that bot on Murage's internal routes, the Vault is paused while any bot can do that (D25). This is still a new acknowledgement for secrets, not one already given: `docs/terms-acceptance.md:13` covers only the terms record (Fable r2 M9). The Vault page carries: "Bots with Full access run as you and could read Murage's saved keys, including these. Give Full access only to bots you trust." A per-bot OS sandbox is out of scope (Parked).
- **R2 The pinned site and the granted bot.** The site the owner pinned receives the value; a site that echoes it back in a form outside F9, or a granted bot that sends its own context data to that site, acts within the owner's grant. The card says: "<bot> will be able to send requests to <origin> with this. Only allow sites you trust with it."

Out of model: malware with debugger access to Electron main; a compromised OS keychain; a compromised pinned site's TLS certificate authority.

## 2. What Murage has today (at 068a595c9a)

- Custody: one JSON document `userData/credentials.bin` sealed with safeStorage. The writer is serialized (`electron/secure-credential-state.mjs:65-72`), each `update(derive, afterPersist)` derives from `current` (`:79-83`), a failed launch read refuses writes (`:53-60`). **When `persist` throws after the rename** (`electron/durable-write.mjs:18-27`: directory fsync, or the Windows reopen-flush), `current` stays the previous document while the file holds the new one, and the next writer derives from the stale `current` (Fable r2 H1). Unknown top-level sections survive current writers (`electron/main.mjs:2089-2098`).
- Main ↔ server: the server is a `utilityProcess` (`electron/main.mjs:2769-2772`) with a private message port (`:2782`); its stdout/stderr go to the native log (`:2780-2781`); its exit is handled at `:2874`. Precedent for a secret answered per request from the encrypted document over that port: the WhatsApp auth key (`:2796-2806`).
- Bot tools: `request_credential` (`server/drivers/agents-proxy.ts:598-616`); proxy calls wait up to 250 s (`:864-875`); long results are parked by `capResult` (`:954-956`); `tools/call` (`:1678-1687`). Server routes check the turn with `requireActiveInternal` (`server/index.ts:30578`); the credential card route is `server/index.ts:31941`, and on a No limits turn it raises no MCP key card (`:31957-31960`).
- Public-address checks exist: `isPublicAddress` and `validateHost` (`server/cloud-home/own-server.ts:203,213`).
- MCP materialization writes key values to disk today (`server/drivers/claude.ts:5572-5585`, `server/drivers/pi.ts:1012-1016`): why D8 holds.
- Headless servers keep secrets in 0600 config.json (`server/config.ts:696,1144`); Cloud home has its own store (`server/cloud-home/secrets.ts:17-37`).

## 3. Decisions (fail-closed, one line each)

| # | Decision | Why |
| --- | --- | --- |
| D1 | Values live only in `credentials.bin`, top-level section `vaultSecrets` (schema `v: 1`). No other file, no temp file, no per-call file. | MAIN ruling; one custody path, outside backups. |
| D2 | **Main is the only Vault authority.** It holds the document (the shared writer's `current`), the narrowing journal, chat holds and leases. The server holds an index **without values** (names, ids, bots, origins, slot kinds, generations, store state) pushed by main. | Fable r2 H1/H2, Astra r2 4/5/6: one authority, no copies to disagree. |
| D3 | All main ↔ server Vault traffic is request/reply messages on the private utility port, each carrying the server's launch `epoch`. Never env, argv or the launch-secret stdin read. | As r2. |
| D4 | **The only delivery is `vault_fetch`** (4.4): one HTTPS request made by the server, to an origin pinned on the item, with the value in the item's pinned slot. No command delivery, no file, no env, no ref, no MCP binding in part 1. | Fable r2 H3, Astra r2 1/2/3/8/9/10/12: no local recipient exists to contain. |
| D5 | Unreadable or malformed section (decrypt/parse failure, schema mismatch, `v` newer) = **BROKEN**: Vault writes and leases refused; section preserved byte-equal through sibling writes. | P5. |
| D6 | Linux `basic_text`, headless servers and Cloud homes: **LOCKED**, no opt-in. | P5. |
| D7 | Cloud send (S6) hidden until MurageCloud signs the contract in 8. | Held. |
| D8 | No MCP binding in part 1 (scope gate, QUESTIONS-r3 Q3 for MAIN; part-2 contract 11.2). | Every MCP launch path writes values to disk today. |
| D9 | New card kind `custom:<label>` with a required `use {origin, slot}`; settlement per 4.1. | No custom card today. |
| D10 | Prompt names: only items usable by that bot, with their origins; JSON-quoted, control characters stripped, ≤ 80 chars, ≤ 40 names, introduced as data. | As r1/r2. |
| D11 | The response is scrubbed in the server, streamed, **before** any cap, park or log, against the forms of **the values this call holds only** (F9). | Astra r2 3, 12; Fable r2 M6. |
| D12 | 1Password: token in the section; reads run in main by stable ids `{accountId, vaultId, itemId, fieldId}`; never cached; any provider error refuses the use. | Astra r2 7. |
| D13 | Grant, origin, slot and generation are checked by main when it answers a lease; the server checks the lease is still unrevoked and the turn still live **in the same synchronous block** that starts the request; revoke/delete/unlink/bot delete send `vault-revoke` and the server aborts in-flight requests holding the item. | P2, P6; Astra r2 8. |
| D14 | Values: one line, printable, 8..4096 bytes (card, page, 1Password field at use). | Header and query slots cannot carry newlines; F9 needs ≥ 8 (Fable r2 M7). |
| D15 | Every op is one job in main's credential write queue; main applies the op's **delta** to the latest document in `derive`. | Fable M4, r2 H2. |
| D16 | Narrowing (REVOKE, DELETE, REVOKE_BOT, REMOVE_ORIGIN, UNLINK) takes effect in main's authority at once, before its queue job, and is recorded in main's **narrowing journal** `userData/vault-narrowing.json` (exact targets, no values). An entry is retired only by **its own receipt** in a reconciled document, or by a later KEPT widening on the **same exact target**. | Astra r2 4, Fable r2 M5. |
| D17 | Every committed op writes a receipt `{opId, kind, target, generation}` into the same document write. Receipts stay until the server acknowledges the outcome (`vault-ack`); at 1024 unacknowledged receipts new widening ops are refused, narrowing never is. | Astra r2 5 (eviction). |
| D18 | Build constant `VAULT_ENABLED` (`shared/vault-flags.ts`): false = LOCKED(disabled), no tool, no card, no names, section untouched. | Rollback. |
| D19 | Bot deletion applies REVOKE_BOT before the delete commits. | As r2. |
| D20 | **No new approval prompt.** The owner's grant on the card or page (bot + origin + slot) is the authority for `vault_fetch` at every level. There is no per-call card; the grant text says plainly what it allows. | No limits rule; Fable r2 H3(c): there is no server decision entry point to cite because none is used. |
| D21 | The shared writer **reconciles** after any `persist` that throws: inside the same queue job it re-reads the file; if that read fails, the store is DIVERGED and every credential write (all sections) and every lease is refused until a re-read succeeds (5.3). | Fable r2 H1, Astra r2 5. |
| D22 | Only main decides an op's outcome. The server never turns a timer into an outcome; it only shows "Not confirmed yet". | Fable r2 H2. |
| D23 | `vault_fetch` has a proxy-made `invocationId`; the server joins duplicates and records each dispatched call (no values) so a redelivery after a lost reply is never sent twice. | Astra r2 11. |
| D24 | A custom card is raised only when the store is READY and the turn is not No limits; otherwise `request_credential` returns the reason and where to save it. | Fable r2 M4, M10. |
| D25 | **Turn-bearer fence (Astra conv #1).** Internal routes identify a bot only by its per-turn bearer, which sits in a 0600 credential file (`server/drivers/claude.ts:4930-4940`, `server/index.ts:29274`) that any program running as the owner can read. So main answers **no lease while any bot in this home can read another turn's credential file**: any bot at Full access, and any bot on an engine/OS pair whose command sandbox has not passed the W29b check (unqualified pairs count as Full access). The store shows LOCKED(full-access) naming those bots: "Saved secrets are paused while <bots> have Full access. Bots with Full access run as you and could act as another bot." Turning a bot to Full access revokes every lease at once (F13 path). **Unpause fence (Astra conv3 #1):** main records `pauseEndedAt` when the last such bot loses Full access; a lease is answered only for a turn whose internal claim was issued after `pauseEndedAt` (`server/internal-capabilities.ts:139-145` claims carry their generation), so a bearer copied during the pause is useless after it. | Fail-closed; P2 cannot hold otherwise. |
| D26 | **Narrowing and dispatch are serialized in the server.** Every narrowing and every REPLACE starts in a server owner route. That route, in the same synchronous block, adds the target to the server's `narrowedSince` list and aborts in-flight requests holding it, **before** posting the op to main. The dispatch fence refuses any lease whose target is in `narrowedSince` with a sequence number later than the lease request. A REPLACE also marks the item `replacing` from the moment its route runs until its outcome; the lease fence refuses an item that is `replacing`, so a lease asked after REPLACE starts never gets the old value (Astra conv3 #2). Narrowings that start in **main** (LINK/relink/UNLINK through preload, the D25 pause) use a handshake: main sends `vault-revoke {targets}` and applies the change only after the server answers `vault-revoke-ack` (target added to `narrowedSince`, holders aborted); with no server running, nothing can dispatch (Astra conv3 #8). Main's `vault-revoke` for server-started narrowings is kept as a second signal; correctness no longer depends on its delivery time (Astra conv #4). | One process owns both sides of the race. |

## 4. Flows

### 4.1 Save from a card
1. Bot calls `request_credential({credential_id: "custom:<label>", reason, use: {origin, slot}})`. `origin` is `https://host[:port]` (validated with `validateHost`, `own-server.ts:213`; DNS names and public IP literals only; no path, no userinfo). `slot` is one of `bearer` (Authorization: Bearer), `header:<Name>` (`^[A-Za-z][A-Za-z0-9-]{1,63}$`, not on the reserved list in 4.4), `basic:<user>` (Authorization: Basic of `user:value`), `query:<param>` (`^[A-Za-z0-9_.-]{1,64}$`). `nameKey = vaultNameKey(label)` (NFKC, lowercase, runs of non-alnum → `-`, trimmed).
2. Store not READY, or `VAULT_ENABLED` false → no card: `Secrets can't be saved here: <reason line>.` No limits turn → no card: `Save it in Settings → Vault and allow <bot> and <origin> there.` (D24).
3. A live item with that nameKey, granted to this bot, whose origins include `origin` and whose slot equals `slot` → no card: `"<name>" is saved for <origin>. Use vault_fetch with name "<name>".` (P1).
4. Otherwise a card. Header "**<bot> wrote this name and reason**", then label and reason. Line: "Murage will send it only to **<origin>**, as <slot words>." The owner may edit the origin field (validated again). Single-line password input. Choice "Keep in the Vault for <bot>" (on by default) or "Only for this chat (1 hour)". R2 line. If a live item with that nameKey exists but is not granted to this bot, or lacks this origin, the card also offers "Let <bot> use the saved '<name>' for <origin>" (GRANT). The GRANT choice states the item's **whole effective scope** before the owner presses it: every origin already on the item, its slot, and every bot already granted, plus the origin being added, if any, named as "also lets <bots> use it with <origin>". GRANT is offered only when the bot's requested slot equals the item's slot; otherwise only a new item can be made (Astra conv #3). Typing a value in that case creates a **new** item `<label> (<bot name>)`; a card never replaces a value (REPLACE is Vault-page only).
5. Settlement: one store transaction does the compare-and-set `OPEN → SETTLED(keep|chat|grant)` on the card message and writes the op record `{settlementId, opId, kind, state: PENDING}`. A second submit, or a submit after dismiss, gets 409 "already answered". Only owner routes settle; in a group room the item goes to the asking bot only. Only after that commit does the server post the op to main (so a crash in between leaves a PENDING record that main never saw: 5.4 resolves it as NOT_KEPT(restart)).
6. Ops: keep → `SAVE {item: {name, nameKey, value, bots:[bot], origins:[origin], slot}, chatFallback: {settlementId, name, nameKey, botId, threadId}}`; chat → `HOLD_CHAT {settlementId, name, nameKey, botId, threadId, origin, slot, value}` (main memory only, expires 1 h, gone on restart); grant → `GRANT {itemId, botId, origin?, baseGeneration}`.
7. Outcomes on the card, each on its own line: KEPT "Kept in the Vault for <bot>"; NOT_KEPT for a SAVE: "Not kept: <reason>." and, **only when main's result carries `hold: true`**, "Usable in this chat for 1 hour." (main made the hold inside the same job, 5.2 M3; a NOT_KEPT(restart) from M4 never carries a hold, because the value died with the process, so the card says "Ask again"); NOT_KEPT for a GRANT "Not allowed: <reason>"; UNCONFIRMED "Not confirmed yet" (resolved by main, 5.3).
8. Continuation: Murage resumes the thread (existing resume path) **only after the outcome**: on KEPT, or on a chat hold, `Secret "<name>" is ready for <origin>. Use vault_fetch with name "<name>".`; on NOT_KEPT of a GRANT, `The owner allowed it, but it could not be saved: <reason>. Ask again later.`; on UNCONFIRMED after 30 s, `The secret is not confirmed yet. vault_fetch will refuse it until it is.`; on DISMISSED, `The owner declined.` The resume text never holds a value. A resumed turn that is Stopped aborts its in-flight `vault_fetch` (4.4 step 7).
9. Chat holds are usable only by `(botId, threadId)`, only for their origin and slot, until expiry, an owner "Forget" on the card, thread delete, bot delete, or app restart. A lease for `name` in that thread resolves the chat hold with that nameKey first, then a granted item (Astra conv #9). Forget is a server-started narrowing on the holdId (D26 fence and abort). The card's "usable" line is computed from the live index (holdId present), never from the settled record, so after a restart it reads "No longer usable" (Astra conv3 #5).

### 4.2 Settings → Vault page
Items: name, bots, sites, slot kind, source, last used (kept in the server store, never in `credentials.bin`), "in use" while a request holds it. Actions: Add (name, value, sites, slot, bots: zero or more), Replace value, Change bots, Change sites, Delete. Write-only value field. Store line: READY (none), LOCKED(keyring | headless | cloud | disabled | store-unavailable | full-access | review | loading), BROKEN ("The Vault could not be opened. Nothing was changed."), DIVERGED ("Murage could not confirm the last save. Saving is paused until it can read the store again." with Retry). Pending actions show "Saving…" / "Not confirmed yet" from the persisted op record. R1 line. UX per `designs/MURAGE-UX-BAR.md`, strings via the inventory.

### 4.3 "Use a saved one"
Custom cards only (D8). Picking a saved item = GRANT (4.1 step 4).

### 4.4 Hand-over: `vault_fetch` (the only delivery)
Tool on the agents proxy, beside `request_credential`:
`vault_fetch({ name, url, method?: "GET"|"HEAD"|"POST"|"PUT"|"PATCH"|"DELETE", headers?: {[k]: string}, body?: string, timeout_s?: number })`
- `url`: absolute `https:` URL, ≤ 8 KiB, no userinfo, no fragment; its origin (scheme, host, port) must equal one origin of the item. For a `query:<param>` slot the URL must not already contain `<param>`.
- `headers`: names `^[A-Za-z0-9-]{1,64}$`, values without CR/LF, ≤ 16 KiB total. Reserved, refused: `authorization`, `proxy-*`, `cookie`, `host`, `content-length`, `transfer-encoding`, `connection`, `te`, `upgrade`, `expect`, and the item's own pinned header name.
- `body` ≤ 1 MiB text. `timeout_s` ≤ 60, default 30 (well under the proxy's 250 s wait, `agents-proxy.ts:868`).
- Path: the proxy derives `invocationId = H(turnId, JSON-RPC request id, tool name, canonical arguments)`, with no proxy instance id, so a redelivery of the same `tools/call` keeps its id across a proxy remount, and a remount that reuses a request id for different arguments gets a different id (Astra conv3 #6) (an engine that issues a new request id is making a new call) → `POST /api/internal/vault-fetch {fromBotId, fromThreadId, turnId, invocationId, ...}` (same bot authentication as `request-credential`) → server:
  1. **join**: the server **atomically reserves** `invocationId` (unique insert in the store, before any lease) or finds it already reserved for this bot → wait for that call, or return its stored scrubbed result, or (DISPATCHED with no result after a restart) `Outcome unknown: Murage sent this request but lost the reply. Check before repeating it.` Never sent twice.
  2. `VAULT_ENABLED`, store READY in the index, `requireActiveInternal()` (`index.ts:30578`) for the claim's bot and thread; argument checks above.
  3. **lease**: post `vault-lease {epoch, leaseId, botId, threadId, name, origin, method}` to main. Main answers from its authority (5.2 L1). 1Password fields are read in main by ids at this point (4.5).
  4. **dispatch fence**, in the one synchronous block that also starts the request: the lease is not in the server's revoked set and its target is not in `narrowedSince` after the lease request (D26), the epoch is unchanged, `requireActiveInternal()` still passes and no confirmed Stop exists for the turn; then write the call record `{invocationId, botId, threadId, turnId, itemId, origin, method, state: DISPATCHED}` (store, no values, no path or query) and start the request. A Stop confirmed or a revoke during steps 2-3 therefore refuses here; no request is sent.
  5. **request**: Node `https` via undici with: certificate verification on; no proxy from the environment; a `lookup` hook that rejects any address for which `isPublicAddress` (`own-server.ts:203`) is false, on every connection; the value placed only in the pinned slot; model headers added after the reserved check; redirects not followed automatically: a same-origin redirect is followed (≤ 5, the slot re-applied) only for header and basic slots and only when the call's matcher finds no form of the value in its `Location`; for a `query:` slot no redirect is followed (Astra conv3 #7), a cross-origin redirect is returned as its status and scrubbed `Location`, and the value is never sent to it.
  6. **response**: status code (number only, no reason phrase); `content-type` reduced to bare `type/subtype` matching `^[a-z0-9.+-]{1,64}/[a-z0-9.+-]{1,64}$` (parameters dropped, anything else omitted); `content-length` as a number; no other header. Every returned string (the media type, a scrubbed `Location`) also passes the call's matcher (Astra conv #2). Text types (`text/*`, `application/json`, `application/xml`, `application/*+json`, `application/*+xml`, `application/x-www-form-urlencoded`) are decoded and passed through the call's streaming matcher (F9) with carry-over **before** the size cap; the scrubbed text is then capped at 256 KiB (end dropped with a marker). Other types return only size and SHA-256, never bytes. The proxy's own `capResult` (`agents-proxy.ts:954-956`) then sees only scrubbed text.
  7. **abort**: a `vault-revoke` naming the lease, a confirmed Stop of the turn, the timeout, or server shutdown aborts the request (bytes already on the wire cannot be recalled; the result says "stopped").
  8. **result**: `{status, contentType, body | {size, sha256}, masked: N, truncated?}`; `masked` counts matches of this call's own values only (D11). Errors are fixed strings by error class (DNS, TLS, refused address, timeout, reset, too large), never the library's message (which can contain the URL). The call record becomes DONE with the scrubbed result. Main gets `vault-lease-done {leaseId}`.
  9. **log**: one server log line: bot, item name, origin, method, status, ms. Never path, query, headers or body.
- The value exists in the server only between the lease reply and the end of the request (header/URL construction and the matcher); it is never stored, logged or copied into a child process.

### 4.5 Linked 1Password
Owner pastes a service-account token on the Vault page; the page hands it **straight to main** through a dedicated preload IPC (`vault:link`), never through the server, and main runs LINK as a queue job (Astra conv #12). Other values (card and page saves) pass through the server once on their way to main, are never stored or logged there, and W3 checks that. Section field `onePassword {token, accountId, accountGeneration, grants: [{vaultId, itemId?, fieldId, bots, origins, slot, label}]}`; LINK/relink/token change bumps `accountGeneration`; a relink whose `accountId` differs voids every grant (they name the old account's ids). Item-level grants override vault-level grants (#4954). A lease for a 1Password name: main snapshots `(accountId, accountGeneration, grant)`, reads the field **by ids** through the SDK (loaded lazily in main; timeout 15 s), then re-checks the snapshot against its live authority before answering. Any SDK error (denied, item or field gone, outage, timeout), a multi-line or < 8-byte value, or a snapshot change refuses the use with a reason. No cache. UNLINK is narrowing (D16): applied at once, revokes leases holding a 1Password value, fails in-flight reads at the re-check. The token never leaves main (no lease carries it), so it cannot appear in any response; W20 checks the server never holds it. A vault-level grant resolves a name to exactly one `{itemId, fieldId}` in that vault; if two entries or fields share the label, the use is refused: "Two 1Password entries share this name; grant the entry itself." (Astra conv #11).

### 4.6 Also use on My Cloud (S6, held)
Contract in 8. The button stays hidden until MurageCloud signs.

### 4.7 Bot deleted
Before `store.deleteBot` commits (`index.ts` serial delete path): post REVOKE_BOT(botId) (narrowing: journal + authority at once, its leases revoked, its chat holds dropped, removed from 1Password grants). The delete does not wait for the doc write; the journal keeps it until its receipt.

### 4.8 Rollback
Ship `VAULT_ENABLED=false` (D18): LOCKED(disabled), no tool, no card, no names; `credentials.bin` and the journal untouched, so a fixed build finds every item and every pending narrowing.

## 5. Authority and state machine (main side; the only state that crosses turns and restarts)

### 5.1 Data
Durable, in `credentials.bin`: `vaultSecrets = { v: 1, rev, items: {id: {name, nameKey, value, bots[], origins[], slot, source, generation, createdAt, updatedAt}}, tombstones: {id: {generation, at}}, docId, receipts: [{opId, seq, kind, target, generation, at}], onePassword? }`.
Durable, in `userData/vault-narrowing-<docId>.json` (main only, no values; `docId` is a random id stored in the `vaultSecrets` section at creation, so a restored or swapped `credentials.bin` never reads or retires another document's journal, Astra conv #13). The file is **preallocated** at Vault creation (256 fixed slots of 512 bytes plus a header, created and fsynced while the disk has room). An entry is written in place into a free slot (`pwrite`, `fsync`), each slot carrying `{seq, opId, kind, target, crc32}`, so a full disk cannot block a narrowing record (Astra conv #7). A torn slot fails its checksum and counts as an unreadable journal (5.4 step 2, fail closed). When the free slots run out, retired slots are reused. If none is free, the narrowing gets `journalFault`. `target` is exact: REVOKE `{itemId, botId}`, REMOVE_ORIGIN `{itemId, origin}`, DELETE `{itemId}`, REVOKE_BOT `{botId}`, UNLINK `{accountId}`.
Main memory: `doc` (= the shared writer's `current.vaultSecrets`), `journal`, `authority = apply(journal, doc)` (an item, grant or origin is usable only in `authority`), `chatHolds`, `leases {leaseId → {epoch, botId, itemId|hold, generation}}`, `outcomes {opId → KEPT | NOT_KEPT(reason) | UNCONFIRMED}`, `epoch` of the running server child, store state.
Server, no values: the index main pushes; op records (card message `vaultOp`, page `vaultOps` list); `vault_fetch` call records; `lastUsedAt` per item.

Store states (main): `LOADING` → `READY | LOCKED(keyring|headless|cloud|disabled|store-unavailable|full-access|review) | BROKEN`; `DIVERGED` (from READY, 5.3). Only READY answers leases and accepts widening ops. Narrowing is accepted in every state (it only removes authority).

### 5.2 Main handlers

| Id | Message / event | Guards (fail → reply) | Effects, in order | Reply |
| --- | --- | --- | --- | --- |
| M1 | `vault-op` widening (SAVE, REPLACE, GRANT, ADD_ORIGIN, LINK) | epoch = running child's; READY; unacked receipts < 1024; value 8..4096 single-line (else NOT_KEPT(reason) now) | append a queue job (M3) | — (result comes from M3) |
| M1b | `vault-op` HOLD_CHAT | epoch live; READY; not paused (D25); value 8..4096 single-line | create the hold `{holdId, settlementId, name, nameKey, botId, threadId, origin, slot, value, expiresAt}` in memory; push the index (holds listed by holdId without values) | `vault-op-result {opId, hold: true, holdId}` |
| M2 | `vault-op` narrowing (REVOKE, REMOVE_ORIGIN, DELETE, REVOKE_BOT, UNLINK) | well-formed only (any epoch, any state) | (1) write the journal slot (5.1); if that write throws, set `journalFault` (5.3); (2) recompute `authority`; drop matching chat holds; (3) post `vault-revoke {leaseIds}` for every lease that holds the target; (4) push the index; (5) append a queue job (M3) **only while the store is READY**; otherwise the narrowing waits in the journal, outside the writer queue, and is enqueued at the next READY, so it never stalls sibling writes behind it (Astra conv3 #9) | `vault-op-accepted {opId}` (outcome from M3) |
| M3 | queue job runs (inside `update(derive)`) | in `derive`: widening: epoch still the running child's (else throw `refused(epoch)`), READY, no tombstone ≥ the item's generation, `generation === baseGeneration` (else `refused(changed)`); narrowing: READY (a narrowing whose store is LOCKED, BROKEN or DIVERGED stays applied in memory and in the journal, and its job is not enqueued until READY (M2); an unsupported or newer document is never modified, Astra conv #6) | apply the delta to `latest.vaultSecrets` only (items the op does not name come from `latest`); narrowing sets `generation = max(item, tombstone) + 1`, DELETE writes a tombstone and removes the value; append the receipt; `rev + 1`; persist | persist ok → KEPT. `derive` threw → NOT_KEPT(reason), nothing written. persist threw → 5.3 reconcile decides KEPT / NOT_KEPT(not-saved) / UNCONFIRMED. On KEPT: retire journal entries with this opId; for a widening, retire older entries (`seq` < this op's) on the **same exact target** (Fable r2 M5); the receipt carries `seq` and `target`, so 5.4 step 3 can repeat this retirement from the document alone after a crash between the commit and the journal update (Astra conv #8). REPLACE also revokes every lease on the item (old value). On NOT_KEPT of a SAVE: create the chat hold from `chatFallback` in the same job. Record `outcomes[opId]`; send `vault-op-result`. |
| M4 | `vault-op-status {opIds}` (server boot, or Retry) | store READY or DIVERGED-resolved; while LOCKED(store-unavailable) or not yet read, the answer is UNCONFIRMED for every opId, never NOT_KEPT (Astra conv #6) | appended as a **queue job**, so every op posted before it has run | per opId: `outcomes` value; else receipt in `doc` → KEPT; else NOT_KEPT(restart) |
| M5 | `vault-hello {epoch}` (server boot) | epoch = running child's | queue job | `vault-index` (state, items without values, journal-hidden targets) |
| L1 | `vault-lease {epoch, leaseId, botId, threadId, name, origin, method}` | READY (not DIVERGED, not `journalFault`, not LOCKED(full-access), D25), epoch live; name resolves in `authority` (item or this bot+thread's chat hold); bot granted; origin listed; generation recorded | **synchronous, not queued** (reads only main's in-memory authority, which already includes every accepted narrowing); 1Password: async read then re-check (4.5) | `{leaseId, itemId, generation, slot, value}` or `refused(reason)` |
| L2 | `vault-lease-done {leaseId}` | — | drop the lease | — |
| L3 | `vault-ack {opIds}` | — | mark receipts acknowledged; pruned in the next queue job | — |
| E1 | server child exit (`main.mjs:2874`) | — | drop every lease of that epoch (its requests died with the process); its queued widening jobs fail the epoch check in M3 → NOT_KEPT(epoch) | — |
| E2 | app quits or main crashes | — | nothing; the journal and the document are on disk; chat holds and leases are gone | — |

Port ordering: messages from main to the server are delivered in order, so a `vault-revoke` sent after a lease reply always arrives after it; the server's dispatch fence (4.4 step 4) and abort (step 7) make "revoked after lease" mean "not sent" or "aborted".

### 5.3 Reconcile, DIVERGED and journal faults (the shared writer change)
`createSecureCredentialState` gets one more dependency, `readBack()` (decrypt the file as it is now; already how launch reads it). In `update`, when `persist` throws:
1. Inside the same serialized job: `disk = await readBack()`.
2. Read ok, and the failed update had **no second phase** (`afterPersist` undefined; every Vault job): `current = disk`. A readBack can succeed from the page cache after the directory fsync failed, so it proves what the file holds now but **not that it survives a power loss**. So, still inside the same job, the writer **re-persists** `disk` with the full `writeFileDurable` path (temp, fsync, rename, directory fsync). Re-persist ok: `durable = true`; the update rejects with `UncertainWrite {committed: disk holds next}`; for a Vault job the op's receipt in `disk.vaultSecrets` → KEPT, else NOT_KEPT(not-saved). Re-persist throws: DIVERGED (step 3), with `current = disk` kept so no writer can derive from the stale document. Every later writer, Vault or not, derives from what is on disk (closes Fable r2 H1 for every section).
2b. Read ok, and the failed update **has a second phase** (for example model sign-in's cancellation fence, `electron/model-signin.mjs:200-218`): the draft is never adopted, because its second phase never ran. The writer durably re-persists `previous` (the existing rollback, `secure-credential-state.mjs:98-105`), keeps `current = previous`, and the update rejects. If that re-persist fails, the writer is DIVERGED (Astra conv #5). If that rollback re-persist fails, the writer keeps `rollbackTarget = previous` in memory, and DIVERGED recovery re-persists `rollbackTarget`, never the disk draft (Astra conv3 #3). Across an app restart the draft on disk is fenced by its own caller, as today (existing behaviour of the sign-in writer, not changed by the Vault; Parked).
3. Read fails, or the re-persist fails: the writer is **DIVERGED**. Every later `update` first retries `readBack()` plus the durable re-persist; while it still fails, every credential write (all sections) throws "The credential store could not be confirmed after a failed save; nothing more is saved until it can be read". Main's Vault answers no lease and accepts no widening; narrowing is still applied in memory and journaled. A successful retry (the next write attempt, the page Retry, or the next launch: launch reads only, so it re-persists before the first lease) applies step 2 and resolves every UNCONFIRMED op by receipt.
`journalFault` (M2 journal write failed): main keeps the narrowing in memory and enqueues its doc write as usual, refuses every lease until that op is KEPT (then the narrowing is durable in the document itself), and the page says "Removed for now. Murage could not record this yet and keeps the Vault paused until it can." If the app also quits before the doc write lands, the narrowing is lost: the page said so (Fable r2 M8; residual stated, both writes failing). **Clean-shutdown marker (Astra conv3 #4):** at each boot, before READY, main sets `open = 1` in the journal header (an in-place write; if that fails the Vault stays LOCKED(store-unavailable)), and clears it at a clean quit only when no `journalFault` is outstanding. A boot that finds `open = 1` (crash, or a quit with an unrecorded narrowing) pauses all leases as LOCKED(review) with the line "Murage closed before it could confirm a change. Check who can use your saved secrets, then press Resume."; Resume is an owner action on the page.

### 5.4 Boot (main)
1. Read `credentials.bin` (existing launch read) → store state; section schema check (D5).
2. Read the journal for this document's `docId`: missing → empty; unreadable or schema-invalid → **fail closed**: authority starts with every item granted to no bot (REVOKE_ALL applied in memory and as the first queue job, written as a receipt) and the page says "Murage could not read its record of removed secrets, so every saved secret was taken away from every bot. Give them back on this page."
3. A journal entry is retired when the document holds its own receipt, or a receipt of a widening with a later `seq` on the same exact target; the rest stay in `authority` and are re-enqueued as queue jobs with **their original opId** (narrowing is idempotent), so they retire on their own receipt.
4. Server boot (each fork): `vault-hello` → index; `vault-op-status` for every non-terminal op record → outcomes. Because M4 is a queue job and an app restart ends main's queue, no write from before can land after the answer.

**One terminal path:** every op ends KEPT or NOT_KEPT(reason), decided only in main (M3, M4, 5.3). UNCONFIRMED exists only while the writer is DIVERGED and leaves only through a successful `readBack`. No timer creates an outcome.
Invariants: **V1** "kept" is shown only when a document holding the op's receipt completed a full durable write (a normal persist, or the reconcile re-persist). **V2** no lease is ever answered from a grant, origin or item wider than `apply(journal, doc)`; a narrowed target is never usable again unless a later widening on the same exact target is KEPT. **V3** the section is never replaced or emptied while BROKEN. **V4** no writer derives from a document that differs from the file after a failed persist.
Fences: (a) server `epoch`, checked at receipt and inside `derive`; (b) item `generation` and tombstones in `derive`; (c) `opId` on every message and receipt; (d) 1Password `accountId` + `accountGeneration`; (e) journal over every boot; (f) lease revocation + dispatch fence; (g) `invocationId`.

## 6. Fences (each has a witness, 9)

- F1 No value in: logs (native log, `console`, `slog`), transcripts, SSE events, tool results, prompts, argv or environment of any process, any child process, any file outside `credentials.bin`, config.json, backups, restore bundles, feedback/telemetry/crash payloads, renderer responses, the journal, call records.
- F2 Grant, origin, slot, generation at lease (main) and lease-unrevoked + turn-live at dispatch (server).
- F3 Delivery only through `vault_fetch`, only in the pinned slot, only to a pinned origin, only to public addresses.
- F4 No file (D1).
- F5 No binding (D8): no route, config entry, tool argument or MCP spec makes Murage read the Vault for anything but a `vault_fetch` lease.
- F6 Durability: V1, V4 (M3, M4, 5.3, 5.4).
- F7 Broken store: V3.
- F8 Weak storage: D6 LOCKED reaches card and page.
- F9 Scrub: per call, the matcher is built from **only the value(s) this lease holds** (the item value; for `basic:<user>` also `user:value`). Forms per value, exactly these 13 (duplicates of identical bytes collapse): raw; JSON-string-escaped; `encodeURIComponent`; form-urlencoded (`+` for space); HTML-escaped; base64 standard at byte offsets 0, 1, 2 of the value (the stable core of each, padding removed), base64 URL-safe at offsets 0, 1, 2 (same); hex lower; hex upper. One Aho-Corasick pass over the decoded stream with carry-over of (longest form − 1) bytes, longest match first, replacing each match with `[masked]`; then the cap. Cost O(output + matches). A value is never in the matcher of another bot's call, so output and `masked` never depend on items outside the call (Astra r2 12).
- F10 Epoch inside the write queue.
- F11 Utility port only (D3).
- F12 Cloud: S6 (8).
- F13 Narrowing aborts in-flight requests holding the target.
- F14 Reconcile: no writer derives from a stale document (D21).
- F15 Egress: only the pinned origin, `https`, public addresses, verified TLS, no cross-origin redirect with the value.

## 7. Migration and compatibility

- From Murage today: nothing to migrate.
- Downgrade to 1.0.20 and back: one new top-level section; v1.0.20 writers preserve unknown top-level sections (W19a). W19b runs the released v1.0.20 build: workspace-key edit, MCP-key edit, backup (and inspects the backup's contents for the sentinel), re-upgrade: items, tombstones, receipts and grants byte-equal. The journal sits in userData; 1.0.20 ignores it. If W19b fails, Q-release line "Going back to an earlier version removes saved Vault secrets."
- The reconcile change (D21) changes behaviour for every section only in the post-rename failure case, which today silently loses or resurrects data; W6d covers a workspace-key write there.
- Restore: a restored profile has its own `credentials.bin` and userData; the journal travels with userData (never in the data-folder backup), so a restored profile has a consistent pair or no journal (empty, nothing hidden that was not hidden in its document).

## 8. Cloud vs desktop

| | Desktop (macOS, Windows, Linux with keyring) | Linux without keyring | Headless / container | Cloud home |
| --- | --- | --- | --- | --- |
| Values | `credentials.bin` | — | — | — (MurageCloud) |
| Store state | READY | LOCKED(keyring) | LOCKED(headless) | LOCKED(cloud) |
| `vault_fetch` | yes | no | no | no |
| Custom card | yes | no (reason line) | no (reason line) | no (reason line) |
| Also use on My Cloud | sender, when signed | no | no | receiver, when signed |

S6 contract (owners: desktop sender = VAULT-M7 builder; Cloud receiver = MurageCloud; signed before the button shows): as r2 §8 (homePin, item generation, Cloud-validated `cloudBots`, opId retry, fingerprint `HMAC_nonce(value ‖ generation ‖ sorted cloudBots ‖ origins ‖ slot)`), plus the receiver refuses a value equal to **any** of the home's provider keys (not only the primary Flux key), under any name (Astra r2 H10 note, `server/cloud-home/credential-projection.ts:41-49`); W21b.

## 9. Witnesses (builder makes each RED first on 068a595c9a or the builder's base, GREEN after, plus the named mutant RED)

Real path rule: real routes, real proxy tool, real `secure-credential-state` writer and real `writeFileDurable` with a fake safeStorage and fault seams only at the OS boundary (fsync, rename, decrypt), real main-side authority in a real Electron main test harness or the same module driven through a real `MessageChannel`, a real local HTTPS fixture server (self-signed CA trusted only by the test) standing in for the pinned site, real undici, a real fixture server process for restart rows. Seams are barriers inside the real path (hold persist, pause after lease), never a mock of the unit under test. Each sink in W3 has its own mutant. Public-address rows use an injectable resolver at the `lookup` boundary only.

| W | Promise/fence | Scenario | Mutant that must turn it RED |
| --- | --- | --- | --- |
| W1 | P1 | bot asks `custom:stripe key` for `https://api.fixture.test` twice in two turns: second gets "is saved", no card; `vault_fetch` reaches the fixture with `Authorization: Bearer <sentinel>`, exit 200 | lookup ignores durable items |
| W2a | P2/F2 | item granted to A; B asks the same name → card; B's `vault_fetch` naming it → refused, fixture sees no request | grant check removed in L1 |
| W2b | P2/F3/F15 | A's `vault_fetch` to an origin not on the item, to `http:`, to a host resolving to 127.0.0.1 / 10.x / ::1 / link-local, and a same-origin redirect chain ending cross-origin → all refused or not followed; fixture B (other origin) never receives the sentinel | origin check removed; lookup hook removed; cross-origin redirect followed |
| W2c | P2 slot | model passes `Authorization` or the pinned header name, or the pinned query param in the URL → refused; value appears only in the pinned slot at the fixture; a same-origin redirect whose `Location` carries the query value → not followed, zero follow-up requests | reserved-header check removed |
| W2d | Astra conv #3 | item has origins staging and production; B's card asks for staging → the GRANT choice names both origins and the slot; B's card asking a different slot → no GRANT choice | single-origin disclosure; GRANT across slots |
| W3 | P3/F1/F4 | sentinel through card save, page add, `vault_fetch` (bearer, header, basic, query), 1Password read: native log, server log, store DB, call records, journal, events, transcript, system prompt, config.json, feedback payload, error replies, every file under userData except `credentials.bin`, data folder, workspaces, tmpdir (raw + base64 + hex) → 0; `/proc/*/environ` and `/proc/*/cmdline` of every process of the app tree → 0 (Linux; spawn-env capture on Windows/macOS) | omission removed from that sink (one mutant per sink) |
| W4 | P4/M3 | main holds persist; card "Saving…"; release → KEPT; continuation only after KEPT | KEPT set on post / resume before outcome |
| W5 | M4/5.4 | server killed (exact pid) after the settlement commit but before posting → restart: NOT_KEPT(restart), card "Not kept: Murage restarted…", resume text says so | boot status skipped |
| W6 | M4 | main wrote, server killed before the reply → new server: KEPT by receipt; then REPLACE and restart again → first op still KEPT | outcome by final item state |
| W6b | 5.3 | persist throws **after rename** (seam), readBack ok and holds the receipt, durable re-persist ok → KEPT; readBack ok without it → NOT_KEPT(not-saved); readBack ok but the re-persist's directory fsync fails again → DIVERGED, op UNCONFIRMED (never KEPT on a cache read alone); readBack fails → DIVERGED: lease refused, widening refused, workspace-key write refused; Retry with readBack ok → UNCONFIRMED op resolved by receipt | uncertain treated as NOT_KEPT; DIVERGED not entered; KEPT on readBack without the durable re-persist |
| W6c | page ops | page Add, server killed mid-op → restart resolves the page op by receipt | page ops not persisted |
| W6d | 5.3/V4 (Fable r2 H1) | SAVE with throw-after-rename → reconciled KEPT; then a **real** sibling workspace-key save; then app restart → item present and usable. Same with DELETE → item still dead after the sibling save and restart | reconcile removed (current stays previous) |
| W6e | M4 ordering (Fable r2 H2) | hold persist past 30 s, then release → op ends KEPT, never NOT_KEPT; card shows "Not confirmed yet" in between; restart row: server killed and re-forked while persist is held → the test observes the new server's `vault-op-status` **reach main before** release and its answer arrive only after release, KEPT | status/read answered outside the queue; server-side timer makes NOT_KEPT |
| W6f | Astra conv #5 | model sign-in with a cancel during encryption, flush fault after rename, restart → the cancelled sign-in is absent; its predecessor present | unconditional adoption of the draft |
| W6h | Astra conv3 #3 | cancelled sign-in, flush fault, rollback re-persist also fails, then recovery → the predecessor is persisted, never the draft | DIVERGED recovery adopts the disk draft |
| W6g | Astra conv #6 | keyring locked at restart after a committed SAVE → status UNCONFIRMED; unlock → KEPT. DELETE submitted with `v: 2` section → applied in memory and journal, document bytes unchanged | NOT_KEPT on unreadable store; narrowing writes a BROKEN document |
| W6i | Astra conv3 #9 | `v: 2` section, delete a bot → a provider-key save completes while the Vault stays BROKEN | narrowing waits inside `derive` |
| W7 | F10 | old-epoch SAVE queued behind a held job while its epoch is live; child replaced; release → `refused(epoch)`, doc unchanged, outcome NOT_KEPT(epoch) visible to the new server | epoch checked only at receipt (outside `derive`) |
| W8 | D15 | 100 mixed ops from 100 bots' cards (SAVE, GRANT, REVOKE, DELETE) → every op terminal, final doc = sequential application in posting order, every revoke holds | ops applied outside the queue |
| W8b | Fable M4 | main's doc holds Y the server index lacks; op on X → Y unchanged | whole-section replace |
| W8c | D17 | 1024 unacknowledged receipts → the next SAVE refused with the reason, a REVOKE still applies; after `vault-ack` SAVE works | receipts pruned before ack; narrowing refused at the cap |
| W9 | P5/F7 | decrypt fails → BROKEN, save and lease refused, bytes unchanged | BROKEN treated as empty |
| W9b | F7 | `vaultSecrets.v = 2` or a bad item → BROKEN; a workspace-key save succeeds; section byte-equal | schema failure treated as empty |
| W10 | D6/D24 | Linux `basic_text` with and without `MURAGE_ALLOW_PLAINTEXT_SECRETS=1` → LOCKED(keyring); `request_credential("custom:…")` returns the reason line, no card | opt-in honoured / card raised while LOCKED |
| W11 | D6 | headless → LOCKED(headless), no card, config.json never holds a value | headless writes config.json |
| W12 | D24/No limits | No limits turn → no custom card, text points to Settings → Vault; no lease is answered (No limits needs Full access, so D25 pauses the Vault) | card raised on No limits; lease answered under the pause |
| W13 | F9 | the fixture echoes a sentinel chosen so all 13 forms are distinct (it contains `"`, `&`, `<`, space and `/`, and its base64 has `+` and `/`) in each of the 13 forms, once each → the bytes the engine side reads from the proxy's MCP output hold 0 hits; `masked = 13`; a form split across two TCP chunks and across the 256 KiB cap boundary is masked | each form dropped (13 mutants); cap before scrub; no carry-over |
| W13b | F9 isolation (Astra r2 12) | B runs the identical fixture call twice, once with A's item saved and once without (A's value appears in the fixture's response) → B's results byte-equal, `masked` equal | matcher built from all items in view |
| W13c | F1 errors | TLS failure, DNS failure, refused address, timeout with the value in a `query:` slot → reply and log hold fixed strings, no URL, no value | raw library error returned |
| W13d | Astra conv #2 | the fixture puts the sentinel in a `Content-Type` parameter, the reason phrase and a cross-origin `Location` → proxy result and DONE record hold 0 hits | raw header forwarding |
| W14 | F9 cost | 4 values (basic slot), 1 MiB response: one pass, < 100 ms on CI | per-form regex loop |
| W15a | D13 | pause after the lease reply, REVOKE the bot → dispatch fence refuses, fixture sees nothing | no dispatch fence |
| W15b | D13 | pause after lease; REPLACE with the bot still granted → the lease is revoked → refused; never the old value at the fixture | no revoke on REPLACE |
| W15c | F13/P6 | long fixture response; DELETE (and REVOKE, REMOVE_ORIGIN, UNLINK, REVOKE_BOT rows) → request aborted; next call refused | no abort on revoke |
| W15d | Astra r2 8 | Stop confirmed while the lease (and a 1Password read) is pending → no request sent; Stop confirmed mid-request → aborted | liveness checked only at ingress |
| W15e | D26 (Astra conv #4) | main's `vault-revoke` delivery delayed past dispatch; owner REVOKE and REPLACE on a leased item → no request leaves with the old grant or old value | fence relies on main's notification only; REPLACE not invalidating |
| W15f | Astra conv3 #2/#8 | lease asked after REPLACE starts, write held, notice delayed → refused (`replacing`); relink through preload after a 1Password lease is issued, then dispatch → refused (handshake) | sequence-only fence; relink without handshake |
| W16 | D16/V2 | DELETE whose doc write fails → item unusable; a later SAVE of another item KEPT → still unusable; app restart with keyring failing → unusable; keyring back → journal re-posts with the same opId, KEPT, entry retired by that receipt | journal not applied at boot |
| W16b | D16 exact target (Astra r2 4) | item on A and B; REVOKE(B) write fails; a REPLACE of the same item (generation advances, B still listed in the doc) is KEPT; restart → B refused, A usable | retirement by generation; target without botId |
| W16c | Fable r2 M5 | REVOKE(B) write fails; owner re-grants B (GRANT KEPT, later seq) → B usable; restart → B still usable (old entry retired by the later same-target widening) | widening does not retire older same-target entries |
| W16d | 5.3 journalFault | journal write fails on a DELETE → leases refused for all items until the DELETE is KEPT; page line shown | lease answered during journalFault |
| W16e | 5.4 step 2 | corrupt journal at boot → every item granted to no bot; page line; owner re-grant works | corrupt journal treated as empty |
| W16f | Astra conv #7 | disk full (no free blocks) at DELETE → journal slot written, restart against the old document → item still dead | journal append that allocates |
| W16i | Astra conv3 #4 | journal slot write fails (full CoW volume seam), app killed → next boot LOCKED(review), no lease until Resume | preallocation without the open marker |
| W16g | Astra conv #8 | crash after the re-grant commit, before journal retirement → boot retires the old REVOKE from the receipt; B usable; GRANT reported KEPT | retirement by own receipt only |
| W16h | Astra conv #13 | failed REVOKE_BOT, restore another profile, undo the restore → the revoke still holds; the restored profile's journal untouched | one shared userData journal |
| W17 | F5/D8 | config.json with `vault:`-like strings, an MCP server naming an item, an MCP slot "Use a saved one" → no value anywhere, no binding route (404) | `resolveHeldEnv` consults the Vault |
| W18 | D10 | prompt lists only granted names with origins, quoted, ≤ 40, control chars stripped | quoting removed |
| W19a | 7 guard | every whole-doc writer preserves an unknown top-level section (GREEN on base) | writer rebuilds from known keys |
| W19b | 7 downgrade | released v1.0.20: edits, backup (contents scanned), re-upgrade → section byte-equal | fixture writer drops unknown keys |
| W20 | P7/D12 | two fields with the same label and different grants → each bot gets only its own field id; relink to another account during an in-flight read → refused; SDK denial / field removed / outage → refused, no stale value; token never leaves main (server memory snapshot, logs, port messages other than LINK) | label resolution; no completion re-check; any cache |
| W20b | Astra conv #11/#12 | two entries share a label under one vault grant → refused with the reason; LINK: every server-port message during linking holds 0 token bytes | first-match selection; LINK through the server |
| W21 | S6 | (when signed) retry same opId → same answer; different `cloudBots` or origins → fingerprint mismatch | fingerprint over value only |
| W21b | S6 | receiver refuses a value equal to any home provider key under an arbitrary name | equality with the primary Flux key only |
| W22 | 4.1 | double submit → one settlement, second 409; dismiss then submit → 409; `chat` → resume names the item, never the value; group room → only the asker granted | no CAS |
| W23 | 4.1 | card shows "<bot> wrote this"; typing a value for an existing ungranted nameKey creates `<label> (<bot>)`; the original item unchanged | card performs REPLACE |
| W23b | Astra r2 6 | SAVE NOT_KEPT → chat hold usable in that thread only, 1 h; GRANT NOT_KEPT → no use, resume says not saved; thread delete / bot delete / "Forget" → chat hold refused | early continuation; hold outlives bot delete |
| W23c | Astra conv #9 | "Only for this chat" → vault_fetch by name in that thread works, in another thread refused; W5 restart card never claims a hold | hold without name binding; phantom hold line |
| W23d | Astra conv3 #5 | lease issued, owner presses Forget, dispatch resumes → refused; settled card reopened after restart → "No longer usable" | hold Forget without lease fence; display from the settled record |
| W24 | 4.7 | delete a bot with grants, a chat hold and a request in flight → request aborted, grants gone (also after failed write + restart via journal); new bot → no grants | no REVOKE_BOT on delete |
| W25 | D14 | 7-byte or multi-line value on card/page/1Password field → refused with the reason | length/line check removed |
| W26 | D18 | `VAULT_ENABLED=false` → no tool, card refuses, page LOCKED(disabled), `credentials.bin` and journal bytes unchanged | flag ignored |
| W27 | D23 (Astra r2 11) | the fixture accepts a POST, the server drops the reply to the proxy; the engine redelivers the same MCP `tools/call` (same request id), once after reply loss, once concurrently during lease acquisition, and once after a proxy remount; leases counted separately → fixture counts 1 request; the reply is the stored result; after a server restart in between → "Outcome unknown", fixture still 1 | fresh id per delivery; reservation after the lease |
| W28 | R1/R2 text | card and page render the R1 and R2 lines from the string inventory | line removed |
| W29 | Astra r2 1 (no new reader path) | two same-login bots: A granted, B not, B at Auto on a qualified engine/OS pair (positive control outside the D25 pause); a second run with B at Full access shows LOCKED(full-access): B's tools, B's workspace, B's own processes' environments, every app-tree process's environ/cmdline, the data folder, the native log → 0 sentinel; positive control: A's `vault_fetch` reaches the fixture with the sentinel during the run | value placed in any env/argv/file/child |
| W29b | D25 (Astra conv #1) | B at Full access copies A's turn bearer and calls vault-fetch as A → refused (LOCKED(full-access)) while A at Auto succeeds when no bot has Full access; per engine/OS pair: a non-Full bot's real sandboxed command cannot read another turn's credential file (pairs that fail are listed as unqualified) | bearer-only admission with a Full-access bot present |
| W29c | Astra conv3 #1 | B copies A's bearer during the pause, B loses Full access, B presents the old claim → refused; a fresh A turn succeeds | unpause reopens on current settings alone |

Windows and macOS rows (W3 process rows, W6b/W6d fsync seams, W29) go through WINRUN-REQ / the Mac relay.

## 10. Pushed and WIP code: what survives

As r2 §10 for `fa75e7e925`, `2a5cca8fcf`, `e1504a45d9`, `1e2bc9ed97`. r2's `vault_run` design is withdrawn (nothing of it was built). Upstream: #4980/#5073 behaviour with D5/D15-D17/D21; #5008 with D10/D12; #5145 pointer and MCP binding not in part 1 (D8, Q3); #4954 taken (W20). The local branches `fix/1021-up21-vault-platform*` predate r2; the builder reads them for UI only and takes no custody or delivery code from them.

## 11. Build slices and part-2 contracts

### 11.0 Slices
S1 main authority: writer reconcile (D21), section, queue jobs, receipts, journal, leases, store states, flag (W4-W11, W16*, W19, W26). S2 server: index, op records, `vault_fetch` route, egress, scrub, call records, prompt names (W1, W2*, W3, W13*, W14, W15*, W18, W25, W27, W29). S3 custom card and settlement (W12, W22, W23, W23b, W28). S4 Vault page and bot deletion (W6c, W24). S5 1Password (W20). S6 Cloud after MurageCloud signs (W21, W21b). S1 first. All slices security-touching: merge needs Fable AND Astra AGREE.

### 11.1 Part-2 command delivery contract (not built in part 1; owner: VAULT-M7)
Command use may ship only when all hold: (1) the recipient is an owner-pinned program (absolute path + content hash + exact argv template, no interpreter or shell) shown on the card; (2) it runs under a containment Murage owns on each OS that is at least the bot's own engine sandbox (filesystem, network, process), with a witness per OS; (3) the value reaches it by a pipe closed after one write, never env or argv; (4) a surviving authority (main) owns its deadline and kills it on server death, revoke and restart; (5) its output is scrubbed by (F9) of its own values before any cap or log; (6) it is refused where (2) or (4) cannot be met.

### 11.2 Part-2 MCP binding contract (owners: VAULT-M7 = Vault side, mcpskills-1021/D3 = MCP side)
As r2 §11.2, plus: the binding obtains its value only through a main lease (5.2 L1) bound to `{serverId, D3 approved execution revision, slot, itemId, generation}`, and materialization writes no value to disk.

## 12. GAP-CHECK (one adversarial pass on r3, GAP-CHECK-BAR)

### Fixed
1. (b failure path) Write throws after the rename, card later confirmed, then the owner edits a workspace key: in r2 the save vanished (or a delete came back). Now the writer reconciles inside the same job, or refuses all writes while it cannot (5.3, W6d).
2. (b failure path) Keychain unlock prompt takes 40 s: in r2 a timer-driven read answered "not kept" and the save then landed. Now only main decides, in queue order; the card waits on "Not confirmed yet" (W6e).
3. (d safety) A sandboxed bot uses the Vault tool to run `sh -c` outside its sandbox: impossible, there is no command delivery; `vault_fetch` reaches only the pinned origin (W2b).
4. (d leak) A bot asks the pinned site's echo endpoint to return the key, or names the key's header itself: the slot is pinned and reserved (W2c), the echo is masked in 14 forms (W13); a site that transforms the key is R2.
5. (d leak) A bot points the pinned host's DNS at `127.0.0.1` to hit a local admin port with the key: public-address lookup hook on every connection (W2b).
6. (d leak) B learns that A saved a value by comparing `masked` counts: the matcher holds only the call's own values (W13b).
7. (b failure path) The proxy loses the reply to a POST and the call is redelivered: joined by `invocationId`, never sent twice (W27).
8. (b failure path) The owner revokes B, the write fails, then a REPLACE succeeds: in r2 boot dropped B's revoke on generation alone. Now retirement is by its own receipt or a later same-target widening (W16b, W16c).
9. (a purpose gap) A card settled while the store is locked promised "ready" for a value the bot could not use: no card unless READY (W10).
10. (c rule conflict, No limits) Custom card on a No limits turn: none; text points to Settings (W12).
11. (b failure path) Journal file cannot be written: leases paused until the narrowing is durable in the document (W16d); journal corrupt at boot: every grant removed, owner told (W16e).
12. (b failure path) Server crashes between the card's "answered" commit and posting the save: card ends "Not kept: Murage restarted", resume says so (W5).
13. (d leak) Fetch error text carries the URL with a `query:` slot value: fixed error strings (W13c).
14. (d safety) A redirect sends the bearer to another origin: cross-origin redirects are never followed with the value (W2b).

15. (d safety) A Full-access bot copies another bot's turn bearer and calls `vault_fetch` as it: leases paused while any bot can read another turn's credential file (D25, W29b).
16. (d leak) A pinned site echoes the key in a `Content-Type` parameter: only bare `type/subtype` is returned, every returned string scrubbed (W13d).
17. (d safety) A card grant silently extends a bot to a second origin: the GRANT choice names the whole scope (W2d).
18. (b failure path) Revoke while main's notice is still in flight: the server fences dispatch against its own narrowings (D26, W15e).
19. (b failure path) Disk full at a delete: preallocated journal slots (W16f); crash between re-grant and journal update: receipt-based retirement (W16g); restore and undo: per-document journal (W16h).
20. (b failure path) Sign-in cancelled while its write fails after the rename: rolled back, never adopted (W6f).

### Parked (one-line reason, for the product owner / MAIN)
- Command delivery (CLI logins, `docker login`, `gh auth`, PEM/SSH keys): needs a Murage-owned per-OS containment (11.1); a new platform surface, far over 20% (Q2).
- MCP key binding / #5145 pointer: scope gate for MAIN; D3 must first make MCP materialization disk-free (Q3, 11.2).
- Per-bot OS sandbox closing R1: new platform surface.
- A cancelled sign-in draft left on disk across an app restart after both the write and its rollback failed: existing sign-in writer behaviour, unchanged by the Vault (5.3 step 2b).
- Sender-bound internal authority (would lift the D25 Full-access pause): changes every internal route; its own design.
- Plain-text opt-in Vault on headless and `basic_text` Linux: needs its own custody design.
- Local or private-network APIs (localhost, LAN hosts) as pinned origins: needs an owner-visible private-network grant; rare for API keys.
- Request signing schemes (AWS SigV4, HMAC-signed webhooks) and OAuth refresh: new slot kinds.
- Desktop delete propagating to My Cloud: new sync behaviour.
- Listing closed-list and MCP keys on the Vault page; Bitwarden (#6353); team vaults: as r1.
- A destination that echoes a value in a transformed form (reversed, split): owner's site choice (R2).

### Rejected
- Per-item reveal button: violates P3.
- Per-call approval card for `vault_fetch`: violates the No limits "no new prompts" rule; the pinned grant is the approval (D20).
- Scrubbing values under 8 bytes: masks ordinary words; D14 refuses them.
