# VAULT-M7 part 1 (1.0.21): saved secrets, design r2

STATUS: r2 for the joint fix-check (Fable and Astra). Supersedes r1 (`DESIGN.md`, 707d514f5d) in full; r1 stays for history. Security row: no builder starts until Fable AND Astra AGREE.

Owners (each side of each contract):
- Desktop Vault (Electron main custody, server Vault service and op queue, `vault_run` tool, custom card, Vault page, prompt names, scrub): **VAULT-M7 builder lane** (to be seated by MAIN; producer). Until seated: OPEN NO-OWNER builder.
- Encrypted credential document `credentials.bin` and its serialized writer (`electron/secure-credential-state.mjs`, `updateSecureCredentialDocument` in `electron/main.mjs`): existing desktop shell code; the VAULT-M7 builder adds one section and keeps every other section byte-equal (consumer of the writer).
- MCP key custody (`mcpServerSecrets`, `server/mcp-secrets.ts`): **mcpskills-1021 lane** (D3). Part 1 adds **nothing** to MCP custody (D8). The part-2 binding contract (11.2) names D3 as the owner of the receiving side.
- Cloud half of "Also use on My Cloud" (supervisor store, receiving route): **MurageCloud** (consumer). Desktop sender: VAULT-M7 builder. Held until MurageCloud signs (D7).
- 1Password provider adapter: VAULT-M7 builder.
- Intake, review seats, merge: **MAIN**.

Code truth: hub `dev/1021` at `ce13438869baecb709e495f572bff879c940e740` (re-checked). Every `file:line` below is at that sha unless it says v1.0.20 (`183ec9be4b`). Upstream donors (behaviour only): #4980, #5008, #5073, #5145, #4954, as listed in r1.

Inputs closed by this round: Fable design review (`vault-m7-design-1021-wf1121/FABLE-DESIGN.txt`: 3 High, 7 Medium, rollback line) and Astra design review (`arev-dsg-UPVAULT-1121/ASTRA-DESIGN.txt`: 2 Critical, 9 High). MAIN ruling for this round: **no plain-text secret file in the bot workspace; secrets go by env injection into the single tool process, or a short-lived fd/pipe, scoped to that call, never readable by other bots or the model, never in a git-addable or deployable tree; revoked/deleted items stay dead across a stale-save reload (tombstone wins).** Section 12 is the CHANGES table (finding → mechanism → witness → mutant).

"Card" means a bot's secure in-app request card (`src/components/SecretRequestCard.tsx`), never a payment card.

## 0. PURPOSE and USER PROMISES

PURPOSE: the owner gives a secret once, on a bot's secure card or on Settings → Vault, and the bots the owner chose can use it later in commands Murage runs for them, without a new card, without Murage ever showing the value to a model, writing it to a file, a log or a command line, or leaving it on disk outside the encrypted store.

USER PROMISES (each is tested; section 9). Each says exactly what Murage enforces; what it cannot enforce is in 1.1.
- **P1 Save once.** A value saved to the Vault is used again, with no new card, when a bot it is granted to asks for the same name.
- **P2 Only chosen bots.** Murage hands an item only to the bots listed on it, and only into a process Murage itself starts for that bot's `vault_run` call. A bot that is not listed gets a card for the owner to decide, never the value. (A bot whose commands run as you can still look at your other programs; 1.1 R1. The Vault page says so.)
- **P3 Never in the model, a file or a log, by Murage.** Murage never puts a Vault value in a prompt, a tool result, a transcript, an event, a log line, a command line (argv), a file (any file outside `credentials.bin`), any environment other than the one `vault_run` process, config.json, telemetry, feedback or a crash report. What that process prints is masked before the bot sees it. A granted bot that deliberately disguises or sends away a value it was given is acting with the authority the owner gave it (1.1 R2); the card says this in one line.
- **P4 Honest "saved".** The card and the Vault page say "kept in the Vault" only after main has read the value back from encrypted storage at the op's own receipt. A save that is not confirmed says "not confirmed yet" until a read decides it; one that failed says it was used once and not kept, and why.
- **P5 Never silently weak, never silently lost.** The Vault is used only where values are sealed by the OS store (macOS Keychain key, Windows DPAPI, Linux libsecret/KWallet). Linux `basic_text`, headless servers and Cloud homes keep the Vault locked in part 1, with a line saying why. A Vault that cannot be read is never replaced or emptied.
- **P6 Owner control.** The owner sees every item (name, bots, source, last used, "in use until"; never the value), changes which bots may use it, replaces the value, deletes it. A revoke or delete takes effect at once, stops any running `vault_run` process holding the item, and stays in effect across a failed write and a restart.
- **P7 Linked manager stays the source.** With 1Password linked, its items are listed by name only, read at the moment of use, never written to disk and never cached by Murage, and each item (or its vault) says which bots may use it.
- **P8 My Cloud only on purpose.** (Held, S6.) A Vault item goes to the owner's own Murage Cloud only when the owner presses "Also use on My Cloud" for that item.

## 1. Threat model

Assets: Vault values; the linked 1Password token; the grant list of each item.

| Actor | Can | Must not be able to |
| --- | --- | --- |
| Owner (renderer, owner routes) | everything in P6 | read a value back (no route returns one) |
| A bot / model (any engine), incl. one steered by prompt injection | ask by name (`request_credential("custom:<label>")`), run a command with granted items through `vault_run` | obtain an item not granted to it; receive a value in any tool result, error or prompt; make Murage put a value in a file, argv, or its own engine environment; plant anything that makes Murage hand an item to a different recipient |
| Another bot (not on the item), through Murage | everything a bot can | get the value through any Murage tool, card, file, env, or folder |
| Engine child processes | receive what their driver adds after `stripWorkspaceCredentialEnv` (`server/config.ts:927`) | inherit a Vault value |
| Disk thief / backup reader / old-version backup | read the data folder, workspaces and backups | find a value (values live only in `credentials.bin` in Electron userData, outside the backed-up data folder; nothing else ever holds one) |
| 1Password | see the token and the items read | receive any other Murage secret |

### 1.1 Residuals (stated; need both reviewers' AGREE and the product owner's acknowledgement, QUESTIONS-r2 Q1)
- **R1 Same OS user.** A program running as the owner's OS user, including a command a Full-access bot runs, can (a) read the environment of another same-user process while it runs (Linux `/proc/<pid>/environ`, macOS `KERN_PROCARGS2`, Windows PEB), (b) on Windows read its memory, (c) on Windows and Linux ask the OS store for the key that seals `credentials.bin`. This is already true of every secret Murage holds (workspace keys, MCP keys, email) and is the accepted product residual "Full-access bots run as that same user, so the file is not a security boundary" (`docs/terms-acceptance.md:13`). The Vault narrows it as far as it can without a new OS sandbox: no file, no lasting environment; **stdin delivery is the default**, so the value is not in any environment at all (Linux `/proc/<pid>/mem` needs ptrace-attach, which the Yama default blocks for non-ancestors); env delivery only when the bot asks for it, and only for the life of that one call (≤ 10 minutes). The Vault page carries one line: "Bots with Full access run as you. While a saved secret is in use, they could look for it. Give Full access only to bots you trust." A per-bot OS sandbox is out of scope (GAP-CHECK Parked).
- **R2 Granted bot's own command.** The process a granted bot runs receives the value by design. A command can disguise it (reverse it, split it), print it in a form the mask does not cover, put it on its own child's command line, write it to a file, or send it to a server. Murage masks every known encoding before the bot sees output (F9) and its tool text steers to stdin forms (`--password-stdin`, `-H @-`), but cannot stop a command that the owner's grant allows. The card says: "<bot> will be able to use this in commands it runs. Only save secrets for bots you trust with them."

Out of model: malware with debugger access to Electron main; a compromised OS keychain.

## 2. What Murage has today (at ce13438869)

- Custody: one JSON document `userData/credentials.bin` sealed with safeStorage; read keeps "unavailable" apart from "empty" (`electron/secure-credentials.mjs:36-72`); a failed read refuses every write (`electron/main.mjs:1795-1806`, `electron/secure-credential-state.mjs:53-60`); writes are serialized and each writer derives from the latest committed doc inside the queue (`secure-credential-state.mjs:65-97`: `serialize`, `update(derive, afterPersist)`), so unknown sections survive current writers (`main.mjs:2089-2098`). Atomic write = temp, fsync, rename, dir fsync (`electron/durable-write.mjs:10-27`): a failure can happen **after** the rename.
- Write policy: Linux `basic_text`/unknown refused unless `MURAGE_ALLOW_PLAINTEXT_SECRETS=1` (`electron/secret-storage-policy.mjs:48-62`).
- Server child: launched by main; its stdout/stderr go to the native log (`main.mjs:2779-2780`); the per-launch companion token goes over the launch-secret transport (`main.mjs:2776`, `server/launch-secret.ts:22-42,60-78`, one stdin read, unmatched messages dropped).
- Spawning: `spawnCli` (`server/procs.ts:390`) runs a CLI through the launcher, whose own environment is fixed (`launcherEnvironment`, `procs.ts:293-297`) and which receives the child's env and cwd as a stdin frame (`launcherFrame`, `procs.ts:300`), inside a kill-on-close job on Windows (`engineJob`, `procs.ts:227`).
- Cards: `request_credential` takes the closed list or `mcp:<server>:<KEY>:<rev>` (`server/drivers/agents-proxy.ts:598-615`, `shared/credential-request.ts:6,59-74`); the card ends the turn and Murage resumes it after save/dismiss (`agents-proxy.ts:1392-1421`, routes `server/index.ts:40142-40159`). No custom card, no secretRef, no file delivery today.
- MCP materialization writes values to disk today: Claude's per-turn credential file (`server/drivers/claude.ts:5572-5574`) and 0600 `mcp.json` (`claude.ts:5585`), Pi's `mcp.json` (`server/drivers/pi.ts:1012-1016`); env resolved by server name and key only (`server/mcp-secrets.ts:227-236`, `server/config.ts:1486`).
- Redaction: by key name and shape (`server/redact.ts:20-74`); a known-literal scrub exists in the OpenAI chat driver (`server/drivers/openai-chat-tools.ts:58-67`, `scrubKnown`).
- Bots: fresh random ids at create (`server/store.ts:4718-4719`, with a tombstoned-id guard on Cloud homes); deletion is serialized per bot (`server/index.ts:8170`).
- Headless servers keep secrets in 0600 config.json (`server/config.ts:696,1144`); Cloud home has its own sealed supervisor store (`server/cloud-home/secrets.ts:17-37`).

## 3. Decisions (fail-closed, one line each)

| # | Decision | Why |
| --- | --- | --- |
| D1 | Values live only in `credentials.bin` as a new `vaultSecrets` section (schema `v: 1`). No other file ever holds a value: no secrets folder, no temp file, no per-turn credential file. | MAIN ruling; one custody path, already outside backups. |
| D2 | Electron main is the only disk writer; the server holds a memory copy. | Matches email/MCP custody. |
| D3 | Boot handoff of the Vault doc and every op go over the **private utility parent port** as request/reply messages with ids (`vault-load`, `vault-op`, `vault-read`); never env, never argv, never the launch-secret stdin read (whose single read stays for the companion token). | Env is readable for the server's life; the stdin framing must stay one-shot. |
| D4 | Delivery is **only** `vault_run` (4.4): Murage spawns the bot's command itself and gives the value to that one process, by stdin (default) or a named env variable, for that call only. There is no file delivery and no ref delivery in part 1. | MAIN ruling; Fable H1/H2, Astra C1/H6. |
| D5 | Unreadable or malformed Vault section (decrypt/parse failure, schema mismatch, `v` newer than known) = **BROKEN**: every Vault write refused, the section preserved byte-equal through sibling writes, never replaced. | P5; Astra H4. |
| D6 | Linux `basic_text`, headless servers and Cloud homes: Vault **LOCKED** in part 1. No opt-in path. | P5/P4 stay true; Astra H8. Opt-in is QUESTIONS-r2 Q4. |
| D7 | Cloud send (S6) stays hidden until MurageCloud signs the contract in 8; the contract now binds home, item generation and Cloud grants with a durable receipt. | Astra H10. |
| D8 | **No MCP binding in part 1.** "Use a saved one" is not offered on MCP key slots; no route writes a binding; MCP launch never reads the Vault. The part-2 contract is in 11.2. | Every MCP materialization path today writes values to disk (2), which breaks D1; Astra C2. QUESTIONS-r2 Q2. |
| D9 | New card kind `custom:<label>`. Settlement and continuation per 4.1. | No custom card today. |
| D10 | Item names in the prompt: only items usable by that bot, JSON-quoted, control characters stripped, ≤ 80 chars, ≤ 40 names, introduced as data. | r1, unchanged. |
| D11 | One scrub point that owns the bytes before any model or log sees them: the `vault_run` result and every Vault error text, built in the server before the HTTP reply to the proxy (F9). | Astra H3. |
| D12 | 1Password: token in the Vault section; SDK loaded lazily; values read per use, **never cached**; any provider error refuses the use. | Astra H7, Fable M10. |
| D13 | Grants and generation are checked at lookup **and again immediately before spawn**; every change bumps generation; revoke/delete kill running `vault_run` processes that hold the item. | P2, P6; Astra H11. |
| D14 | Values shorter than 8 characters are refused at intake (card, page, 1Password field at use). | F9 cannot mask short values without destroying output; Astra H3. |
| D15 | Vault ops run strictly one at a time in the server (FIFO); each carries an `opId` and a **delta** (never a whole doc); main applies the delta to its latest doc inside `update(derive)`. | Astra H5, Fable M4. |
| D16 | Narrowing (REVOKE, DELETE, REVOKE_BOT, UNLINK) is applied to memory at once and recorded in a **narrowing ledger** file (ids, generations, opIds, no values) before the op is posted; the ledger is applied over every load until a read shows the narrowing durable. Tombstone wins. | MAIN ruling; Fable H3, Astra H4/H5. |
| D17 | Every committed op writes a **receipt** (`opId`, kind, item id, generation) into the same document write; outcomes after a crash or uncertain write are decided only by receipts. | Astra H4. |
| D18 | Build constant `VAULT_ENABLED` (`shared/vault-flags.ts`). False = store LOCKED(disabled): no `vault_run`, no custom card, no prompt names; the section on disk untouched. | Fable rollback line. |
| D19 | Bot deletion enqueues REVOKE_BOT before the delete completes. | Fable M5, Astra H6. |
| D20 | `vault_run` follows the bot's existing command approval at its level (tool class `run_command`, `shared/no-limits-decision.ts:29`); no new approval kind. Its approval card lists item names, never values. | No limits rule: no new prompts. |

## 4. Flows

### 4.1 Save from a card (settlement and continuation)
1. Bot calls `request_credential("custom:<label>", reason)`. `nameKey = vaultNameKey(label)` (NFKC, lowercase, runs of non-alnum → `-`, trimmed).
2. Live item with that nameKey granted to this bot → no card; tool text: `"<name>" is saved. Use vault_run with name "<name>".` (P1).
3. Otherwise a card. Header: "**<bot> wrote this name and reason**" then the label and reason (Fable M8). Password input; checkbox "Keep in the Vault for <bot>" on by default (No limits); R2 line. If a live item with that nameKey exists but is not granted, the card adds a choice "Let <bot> use the saved '<name>'" (GRANT). Typing a value in that case creates a **new** item `<label> (<bot name>)` granted only to this bot; a card never replaces an existing item (REPLACE is Vault-page only).
4. Settlement: card state `OPEN → SETTLED(once|keep|grant) | DISMISSED`, a compare-and-set on the stored message (`secret.state`); a second submit or a submit after dismiss gets 409 "already answered" and changes nothing. Only owner routes settle; in a group room the item goes to the asking bot only.
5. On SETTLED: (a) **delivery outcome**: a memory-only *once item* `{botId, threadId, value, expiresAt = now + 1 h}` is created at once (gone on restart, never on disk); (b) **persistence outcome** (keep): op SAVE enqueued (5); (grant): op GRANT enqueued. The card renders the two outcomes on separate lines: "Ready for <bot> in this chat" and "Kept in the Vault" / "Saving…" / "Not confirmed yet" / "Not kept: <reason>".
6. Continuation: Murage resumes the thread (existing resume path, `index.ts:40142-40159`) with text naming the item and how to use it, never the value: `Secret "<name>" is ready. Use vault_run with name "<name>".` DISMISSED resumes with "The owner declined." A confirmed Stop of the resumed turn kills its `vault_run` processes (JOINT RULING STOP-VS-REFUSAL unaffected: no refusal row is involved).
7. Once items count as granted to `(botId, threadId)` only, and are in the scrub set while they live.

### 4.2 Settings → Vault page
Items: name, bots, source, last used, "in use by <bot> until hh:mm" while a `vault_run` holds it. Actions: Add (name, value, bots: zero or more), Replace value, Change bots, Delete. Write-only value field. Store line at top: READY (none), LOCKED(keyring | headless | cloud | disabled | store-unavailable | loading), BROKEN ("The Vault could not be opened. Nothing was changed."). Pending page actions show "Saving…"/"Not confirmed yet" from the persisted op record (5). R1 line. UX per `designs/MURAGE-UX-BAR.md`, strings via the inventory.

### 4.3 "Use a saved one"
Custom cards only (D8). Picking grants the asking bot (op GRANT) and settles the card as `grant`; the once item is not needed (the grant becomes usable on KEPT; until then the card says "Saving…").

### 4.4 Hand-over: `vault_run` (the only delivery)
Tool on the agents proxy, beside `request_credential`:
`vault_run({ argv: string[], items: [{ name, as: "stdin" } | { name, as: "env", env: "NAME" }], cwd?: string, timeout_s?: number })`
- `argv` non-empty, ≤ 64 entries, ≤ 32 KiB total; `cwd` relative to the bot folder, must resolve inside it (`botFolderOrThrow`, `server/bot-folder.ts:15`); no folder (API/Box turns) → refused "this bot has no folder to run commands in". `timeout_s` ≤ 600, default 120. At most one `stdin` item. Env names match `^[A-Z][A-Z0-9_]{2,63}$` and are not on the denylist (`PATH`, `HOME`, `SHELL`, `IFS`, `ENV`, `BASH_ENV`, `PROMPT_COMMAND`, `PS4`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PYTHON*`, `PERL5*`, `RUBYOPT`, `ELECTRON_*`, `MURAGE_*`).
- Path: proxy → `POST /api/internal/vault-run {fromBotId, fromThreadId, turnId, ...}` (same bot authentication as `request-credential`) → server:
  1. store READY and `VAULT_ENABLED`; turn live for that bot and thread (not Stopped);
  2. approval per D20 (Ask level shows the existing command card with argv and item names);
  3. **lookup**: each name resolves to a live item granted to the bot (or the bot+thread's once item), not in the narrowing ledger, generation `g` recorded;
  4. 1Password items: read now (4.5);
  5. **spawn fence**: in the same synchronous block as the spawn call, re-check each item is still live, granted, and at generation `g` (and the 1Password account generation unchanged); any change → refused "the owner changed this secret; ask again";
  6. spawn via `spawnCli` (`procs.ts:390`): the launcher's own env is fixed (`procs.ts:293`); the child's env (`stripWorkspaceCredentialEnv` of the bot's normal command env, plus the env items) and cwd travel in the launcher's stdin frame (`procs.ts:300`), never in the launcher's env or argv; stdin items are written to the child's stdin pipe, then the pipe is closed; stdout/stderr are pipes owned by the server (never inherited, so never the server's stdout and never the native log, `main.mjs:2779`); Windows kill-on-close job; POSIX own process group;
  7. registry entry `{pid identity, botId, threadId, turnId, itemIds+generations, until}`; killed (group/job) on timeout, confirmed Stop, REVOKE/DELETE/REVOKE_BOT/UNLINK of a held item, and server shutdown;
  8. result: output buffered whole (each stream ≤ 1 MiB, middle dropped with a marker), **scrubbed (F9) before the HTTP reply is built**, returned with the exit code and "values masked: N". The server logs one line: bot, item names, exit code, ms. Never argv contents beyond `argv[0]`'s basename.
- What is never done: no value into a file, argv, the engine's environment, the proxy process, a tool result, or an error string. Errors name the item and the reason.
- The tool description tells the model to prefer stdin (`--password-stdin`, `-H @-`, `read -r KEY`), and that env items exist only inside that command.

### 4.5 Linked 1Password
Owner pastes a service-account token on the Vault page → op LINK (widening). Section field `onePassword {token, accountGeneration, grants}`; LINK/relink/token change bumps `accountGeneration`. Item-level grants override vault-level grants (#4954). A use: snapshot `(accountGeneration, item/vault grant)` → SDK read → on completion re-check both against live memory → spawn fence (4.4 step 5). Any SDK error (denied, item gone, field gone, outage, timeout 15 s) refuses the use with a reason; there is **no cache** and no stale value. UNLINK is narrowing (D16): applied at once, kills running processes holding a 1Password value, clears in-flight reads (their completion fails the generation check). Values read are in the scrub set for the life of their process and its result. Token ≥ 8 chars, in the scrub set.

### 4.6 Also use on My Cloud (S6, held)
Contract in 8. The button stays hidden until MurageCloud signs.

### 4.7 Bot deleted
Before `store.deleteBot` commits (`index.ts:8170` serial path): enqueue REVOKE_BOT(botId) (narrowing: ledger + memory at once), kill that bot's `vault_run` processes, drop its once items, remove it from 1Password grants. The delete does not wait for the op's KEPT; the ledger keeps the narrowing across a failed write or restart. New bots get fresh ids (`store.ts:4718`) and, even if an id were reused, no grant names it.

### 4.8 Rollback (leak found after release)
Ship a build with `VAULT_ENABLED=false` (D18): LOCKED(disabled) at boot, no tool, no card, no names; `credentials.bin` untouched, so a fixed build later finds every item. Nothing to clean on disk (D1).

## 5. State machine (the only state that crosses turns and restarts)

Durable truth: `credentials.bin.vaultSecrets = { v: 1, rev, items: {id: {name, nameKey, value, bots[], source, generation, createdAt, updatedAt, lastUsedAt}}, tombstones: {id: {generation, at}}, receipts: [{opId, kind, itemId, generation, at}] (last 256), onePassword?: {token, accountGeneration, grants} }`.

Server-local, no values: `vault-ledger.json` (data folder, 0600; narrowing entries `{opId, kind, itemId|botId|"1p", generation}`) and the op records (`vaultOp {opId, kind, state}` on the card message; page ops in the store's `vaultOps` list). Memory: `base` (last doc main returned), `ledger`, `view = apply(ledger, base)` (an item is usable only in `view`).

Store states: `LOCKED(loading)` at server start → from main's `vault-load` reply: `READY | LOCKED(keyring|headless|cloud|disabled|store-unavailable) | BROKEN`. Only READY accepts ops and `vault_run`.

Op kinds: widening SAVE, REPLACE, GRANT, LINK; narrowing REVOKE, DELETE, REVOKE_BOT, UNLINK; Change bots = one GRANT and/or one REVOKE op.

| Id | From | Event | Guards (fail → X) | Effects, in order | To | X |
| --- | --- | --- | --- | --- | --- | --- |
| O1 | — | owner action / card settle | READY; value 8..4096 bytes; owner route | persist op record PENDING; narrowing: append ledger entry (fsync) and recompute `view`, kill holders; enqueue | QUEUED | NOT_KEPT(reason), terminal now |
| O2 | QUEUED | head of the FIFO | — | post `vault-op {epoch, opId, kind, delta, baseGeneration}` | IN_FLIGHT | post throws → O4 |
| O3 | IN_FLIGHT | `vault-op-result {opId, kept, rev, receipt}` | opId = in-flight op (else ignore, log cause) | `base` = apply(delta) at `rev`; widening becomes usable; ledger entries whose receipt is present are removed (fsync); record KEPT | KEPT (terminal) | — |
| O4 | IN_FLIGHT | `vault-op-result {opId, refused \| failed, reason}`, or post failed | opId matches | widening discarded; narrowing stays in ledger and `view` (still dead); record NOT_KEPT(reason); for narrowing the page says "Removed for now; Murage will keep trying to save this" and the ledger re-posts it as a new op at the next READY load | NOT_KEPT (terminal) | — |
| O5 | IN_FLIGHT | `vault-op-result {opId, uncertain}` (write threw after rename, or read-back failed), or 30 s with no reply | — | record UNCONFIRMED; post `vault-read {readId}` | UNCONFIRMED | — |
| O6 | UNCONFIRMED | `vault-read-result {readId, doc}` | readId matches | `base = doc`; receipt with opId present → KEPT (O3 effects) else NOT_KEPT(`not-saved`) (O4 effects) | KEPT / NOT_KEPT | read fails → store LOCKED(store-unavailable); record stays UNCONFIRMED ("Not confirmed yet"); narrowing stays in ledger; widening unusable; resolved at the next successful read (Retry on the page, or boot) |
| O7 | any | server process ends | — | nothing (memory gone; ledger and records on disk) | — | — |
| O8 | boot | `vault-load` reply READY with doc | — | `base = doc`; ledger entries already durable (doc tombstone/generation ≥ entry, or receipt present) removed; the rest re-posted as fresh narrowing ops; every PENDING/QUEUED/IN_FLIGHT/UNCONFIRMED record resolved by receipts (present → KEPT, absent → NOT_KEPT(`restart`)) | READY | load not READY: records stay UNCONFIRMED; nothing is usable (store not READY); the ledger is kept for the next READY load |

The FIFO advances only when the in-flight op reaches KEPT, NOT_KEPT or UNCONFIRMED; an UNCONFIRMED op blocks later **widening** ops (they wait) but not narrowing ops (they run; fail closed).

Main side, per `vault-op` (inside one `update(derive, afterPersist)` call, so check and write are one serialized mutation, `secure-credential-state.mjs:65-97`):
- `derive(latest)`: `epoch` must equal the epoch main gave the **currently running** server child (read inside the queue) else throw `refused(epoch)`; Vault BROKEN/LOCKED → `refused(state)`; apply the delta to `latest.vaultSecrets` only: widening requires the item has no tombstone with generation ≥ its own and `item.generation === baseGeneration` (else `refused(changed)`); narrowing always applies and sets `generation = max(current, tombstone) + 1` (DELETE writes a tombstone and removes the value); items the op does not name are carried from `latest`, never from the server (Fable M4); append the receipt; `rev + 1`.
- `afterPersist(next)`: decrypt read-back of the file; receipt present → `kept` with `{rev, receipt}`; read-back fails or lacks the receipt → `uncertain`.
- A throw from `derive` → `refused/failed`, nothing written. A throw from the write after the rename → `uncertain`.
- Exactly one `vault-op-result` per opId (try/finally), sent after `afterPersist`, in queue order.
- `vault-load` / `vault-read`: decrypt; `unavailable` → LOCKED(store-unavailable); section fails the v1 schema or `v > 1` → BROKEN (section untouched); else the doc.

**One terminal path:** every op ends in exactly one of KEPT or NOT_KEPT(reason); UNCONFIRMED is not terminal and leaves only through a read (O6/O8). No timer makes a terminal state (the 30 s timer only asks for a read). Invariants: **V1** "kept" is shown only when a decrypted read holds the op's receipt. **V2** no use ever sees a grant wider than `apply(ledger, last durable doc)`; a revoked or deleted item is never usable again in this session or after restart unless a later widening op is KEPT (tombstone wins). **V3** the section is never replaced or emptied while BROKEN.

**Fences:** (a) server launch `epoch`, checked inside the write queue; (b) item `generation`, checked by main on widening and by the server at lookup and at spawn; (c) `opId` on every message and receipt; (d) 1Password `accountGeneration`; (e) narrowing ledger over every load.

## 6. Fences (each has a witness, 9)

- F1 No value in: logs (native log, `console`, `slog`), transcripts, SSE events, tool results, system prompt, argv of any process Murage starts, any environment except the one `vault_run` child, any file outside `credentials.bin`, config.json, backups, restore bundles, feedback/telemetry/crash payloads, renderer responses.
- F2 Grant and generation at lookup and at spawn (D13).
- F3 Delivery only through `vault_run`; no other route or tool hands over a value.
- F4 No file: nothing Murage writes contains a value (D1).
- F5 No binding: no route, config entry, tool argument or MCP spec makes Murage read the Vault for anything but `vault_run` (D8).
- F6 Durability: V1 through O3/O6/O8 receipts.
- F7 Broken store: V3, incl. malformed or newer section.
- F8 Weak storage: D6 LOCKED states reach the card and the page.
- F9 Scrub: one matcher built when the held set changes (Vault items in `view`, once items, values of running `vault_run` processes incl. replaced/deleted ones until those processes end and their result is sent, 1Password values read, the 1Password token). Forms per value: raw, JSON-escaped, URI component, form-encoded, HTML-escaped, base64 standard and URL-safe at the three byte alignments (padded and unpadded core), hex lower and upper. One multi-pattern pass (Aho-Corasick, reusing the literal approach of `openai-chat-tools.ts:58-67`) over the whole buffered output, longest match first; cost is O(output + matches), the matcher is O(held values), never O(history). Output is buffered whole, so no match is split across chunks.
- F10 Epoch inside the write queue.
- F11 No handoff by env/argv/stdin-read; utility port only (D3).
- F12 Cloud: S6 contract (8).
- F13 Kill on narrowing: revoke/delete/unlink/bot delete end every running holder before the op is posted.

## 7. Migration and compatibility

- From Murage today: nothing to migrate; no existing value moves.
- Downgrade to 1.0.20 and back: the Vault adds one top-level section and nothing inside `mcpServerSecrets` (D8), so the v1.0.20 MCP per-server pruning Astra found (v1.0.20 `electron/workspace-credentials.mjs:189-199,289-313`) cannot touch it; v1.0.20's writers preserve unknown top-level sections (checked by Astra and Fable on both shas; W19a records it). No plaintext delivery exists to be caught by an old backup or the Windows recovery clone (D1, Astra H9). W19b runs the released v1.0.20 build against a doc with a `vaultSecrets` section: edit a workspace key, an MCP key, run a backup, then re-upgrade: items, tombstones, receipts and grants byte-equal. If W19b fails, Q4 adds the release-note line.
- Restore: a restored profile has its own `credentials.bin` (`electron/restored-connections.mjs:20`); the ledger lives in the data folder and refers only to item ids, so on a restored profile it matches nothing or keeps the same items dead (fail closed).

## 8. Cloud vs desktop

| | Desktop (macOS, Windows, Linux with keyring) | Linux without keyring | Headless / container | Cloud home |
| --- | --- | --- | --- | --- |
| Values | `credentials.bin` | — | — | — (MurageCloud) |
| Store state | READY | LOCKED(keyring) | LOCKED(headless) | LOCKED(cloud) |
| `vault_run` | yes | no | no | no |
| Also use on My Cloud | sender, when contract signed | no | no | receiver, when signed |

S6 contract (owners: desktop sender = VAULT-M7 builder; Cloud receiver = MurageCloud; must be signed before the button shows). One owner press = one op `SEND_CLOUD {opId, homePin, itemId, generation, cloudBots}`: `homePin` is the paired home identity from `electron/cloud-home-protocol.mjs:110-140`; `cloudBots` are picked by the owner from the Cloud's own bot list fetched at send time (Cloud ids, validated by the Cloud), never desktop ids. Request over the pinned `murage-home://` channel `{opId, itemId, generation, name, value, cloudBots, nonce}`. Cloud stores keyed by `itemId`; accepts only `generation` greater than stored, or the same `(generation, opId)` (retry returns the stored answer); refuses a value equal to the home's primary Flux key; answers `{ok, opId, generation, fingerprint = HMAC_nonce(value ‖ generation ‖ sorted cloudBots)}` or `{ok:false, reason}`. Desktop shows "On My Cloud (version g)" only on a matching fingerprint for the current item generation, and records `cloud {homePin, generation, opId}` in the item through the op queue (receipt). Lost reply → retry with the same opId only; a changed home pin → refused; a later desktop REPLACE shows "On My Cloud is an older version". Desktop delete does not delete on Cloud (page says so; Parked).

## 9. Witnesses (builder makes each RED first on ce13438869, GREEN after, plus the named mutant RED)

Real path rule: real routes, real proxy tool, real `secure-credential-state` writer with a fake safeStorage only at the OS boundary, real child spawns via `spawnCli`, a real fixture server process for restart rows, a real engine-side reader of the proxy's MCP output for model-boundary rows. Test seams are barriers inside the real path (pause after lookup, fail after rename), never a mock of the unit under test. Each sink in W13 has its own mutant.

| W | Promise/fence | Scenario | Mutant that must turn it RED |
| --- | --- | --- | --- |
| W1 | P1 | bot asks `custom:stripe key` twice in two turns; second gets "is saved, use vault_run", no card; `vault_run` with it exits 0 and the child read the sentinel from stdin | lookup ignores durable items |
| W2a | P2/F2 | item granted to A; B asks the same name → card; B's `vault_run` naming it → refused, no child spawned | grant check removed |
| W2b | P2/F3/F4 | A runs `vault_run` (stdin and env rows); during and after: scan B's folder, A's folder, every workspace, task cwd, tmpdir, data folder, userData except `credentials.bin` (raw + base64 + hex) → 0; B's engine process env → 0; stdin row: `/proc/<child>/environ` read by a separate same-user process → 0 (Linux) | value delivered by temp file / env for the stdin row |
| W3 | P3/F1 | sentinel through card save, page add, `vault_run` (stdin and env), 1Password read: native log, store, events, transcript, system prompt, config.json, feedback payload, error replies → 0 (one mutant per sink) | scrub/omission removed from that sink |
| W4 | P4/O3 | main delays the reply; card "Saving…"; reply → KEPT; reply lacking the receipt → UNCONFIRMED → read → NOT_KEPT | KEPT set on post |
| W5 | O8 | kill the server (exact pid) after post, main never wrote → restart: NOT_KEPT(restart), item absent | boot resolution skipped |
| W6 | O8 | main wrote, server killed before the reply → restart: KEPT by receipt; then REPLACE the item and restart again → the first op still KEPT | resolution by final item state instead of receipt |
| W6b | O5/O6 | write fails **after rename** (seam) → UNCONFIRMED → read finds receipt → KEPT; read-back fails → LOCKED(store-unavailable), UNCONFIRMED shown, widening unusable | uncertain treated as NOT_KEPT |
| W6c | page ops | page Add, server killed mid-op → restart resolves the page op by receipt | page ops not persisted |
| W7 | F10 | old-epoch server's `vault-op` arrives after a new server started → doc unchanged, `refused(epoch)` | epoch checked outside `derive` |
| W8 | D15 | 100 mixed ops from 100 bots' cards (SAVE, GRANT, REVOKE, DELETE interleaved) → every op terminal, final doc = sequential application, every revoke holds | ops posted concurrently / CAS outside queue |
| W8b | Fable M4 | main's doc holds item Y the server's memory lacks; server op on X → Y unchanged | main replaces the whole section |
| W9 | P5/F7 | decrypt fails → BROKEN, save refused, bytes unchanged | BROKEN treated as empty |
| W9b | F7 | doc decrypts but `vaultSecrets` has `v: 2` or a bad item → BROKEN; a workspace-key save still succeeds and the section is byte-equal | schema failure treated as empty |
| W10 | D6 | Linux `basic_text` with and without `MURAGE_ALLOW_PLAINTEXT_SECRETS=1` → LOCKED(keyring); card "Not kept: keyring"; value still usable once | opt-in honoured for the Vault |
| W11 | D6 | headless server → LOCKED(headless); config.json never holds the value | headless path writes config.json |
| W12 | F11 | server and engine child `environ`/`cmdline` (Linux; spawn env object on Windows/macOS) contain no value; launcher argv/env contain no value | doc or env items passed by env/argv |
| W13 | F9/model boundary | child prints the sentinel raw, JSON-escaped, URI, form, HTML, base64 (3 alignments, url-safe), hex; the bytes the engine side reads from the proxy's MCP output → 0 hits; masked count = 9 | any one form dropped (one mutant per form) |
| W13b | F9 | child prints the sentinel to stdout and stderr → native log (`main.mjs:2779-2780` capture) 0 hits | child stdio inherited |
| W14 | F9 cost | 100 items, 1 MiB output: one pass, < 250 ms on CI, matcher built once per held-set change | per-value regex loop over text history |
| W15a | D13/F2 | pause after lookup; REVOKE the bot → spawn refused, no child | no re-check at spawn |
| W15b | D13 | pause after lookup; REPLACE with the bot still granted → spawn refused ("changed"), never the old value | spawn uses the looked-up value at old generation |
| W15c | F13/P6 | long `vault_run`; DELETE (and REVOKE, UNLINK rows) → child group killed before the op is posted; next call refused | no kill on narrowing |
| W16 | D16/V2 | DELETE whose write fails → item unusable; then a SAVE of another item is KEPT and a `vault-read` reloads `base` → deleted item still unusable; restart with keyring still failing → still unusable; keyring back → ledger re-posts, DELETE KEPT, ledger entry gone | ledger cleared on reload / not applied at boot |
| W17 | F5/D8 | config.json edited to add `vault:`-like strings, a bot-added MCP server naming an item id or name, an MCP slot "Use a saved one" request → no value anywhere, no binding route (404) | `resolveHeldEnv` consults the Vault |
| W18 | D10 | prompt lists only granted names, quoted, ≤ 40, control chars stripped | quoting removed |
| W19a | 7 (guard, GREEN on base) | every current whole-doc writer preserves an unknown top-level section | writer rebuilds from known keys |
| W19b | 7 downgrade | v1.0.20 build: workspace-key edit, MCP-key edit, backup, re-upgrade → section byte-equal, items usable | (inherited behaviour check; mutant: a fixture writer that drops unknown keys turns it RED) |
| W20 | P7/D12 | item grant overrides vault grant; UNLINK during an in-flight read → completion refused; relink with another account → old item ids refused; SDK denial/item removed/outage → refused, no stale value; token absent from config/log/env | any cache or vault-grant-first |
| W21 | S6 | (when signed) lost reply → retry same opId → same answer; matching value with different `cloudBots` → fingerprint mismatch, not shown; changed home pin → refused | fingerprint over value only |
| W22 | 4.1 | double submit → one settlement, second 409; dismiss then submit → 409; settle `once` → resumed text names the item, never the value; group room → only the asking bot granted | no CAS on settlement |
| W23 | 4.1/M8 | card shows "<bot> wrote this name"; typing a value for an existing ungranted nameKey creates `<label> (<bot>)`; the original item's value and bots unchanged | card path performs REPLACE |
| W24 | 4.7 | delete a bot holding grants and a running `vault_run` → child killed, grants gone (also after a failed write + restart, via ledger); a new bot → no grants; 0-bot item usable by none | no REVOKE_BOT on delete |
| W25 | D14 | 7-char value on card/page/1Password field → refused with the reason | length check removed |
| W26 | D18 | `VAULT_ENABLED=false` → no tool listed, card refuses, page LOCKED(disabled), `credentials.bin` bytes unchanged | flag ignored by tool registration |
| W27 | 4.4 | API/Box turn without a folder → refused with the folder line; `cwd` escaping the folder (`..`, symlink) → refused; denylisted env name → refused | cwd/env checks removed |
| W28 | R1 text | card and page render the R1 and R2 lines from the string inventory | line removed |

Windows and macOS rows (W2b stdin row, W12, W15c kill) go through WINRUN-REQ / the Mac relay.

## 10. Pushed and WIP code: what survives

Unchanged from r1 §10: `fa75e7e925` (Wave A, survives; its plain-server data folder is why D6 keeps headless LOCKED), `2a5cca8fcf`, `e1504a45d9`, `1e2bc9ed97` (no Vault overlap, survive). Upstream: #4980/#5073 taken as behaviour with D5/D15-D17; #5008 taken with D10/D12 (no cache); **#5145 pointer and MCP binding not taken in part 1** (D8, 11.2); #4954 taken (W20); logins not part 1.

## 11. Build slices and the part-2 MCP contract

### 11.1 Slices
S1 custody: section, delta op path inside `update(derive)`, receipts, ledger, utility-port load/op/read, store states, flag (W4-W11, W16, W19, W26). S2 server Vault service, scrub, prompt names (W3, W13, W13b, W14, W18, W25). S3 custom card settlement and `vault_run` (W1, W2a, W2b, W12, W15a-c, W17, W22, W23, W27, W28). S4 Vault page and bot deletion (W6c, W24). S5 1Password (W20). S6 Cloud send after MurageCloud signs (W21). S1 and S2 first. All slices security-touching: merge needs Fable AND Astra AGREE.

### 11.2 Part-2 MCP binding contract (not built in part 1; owners: VAULT-M7 = Vault side, mcpskills-1021/D3 = MCP side)
A binding may ship only when all hold: (1) it binds `{serverId, D3 approved execution revision (command, args, url, header names), slot, itemId, generation}` and is rechecked against live values and live grants for the bot the mount serves at final materialization, including owner Test and remote header slots; (2) materialization writes no value to disk on that driver (today's Claude credential file and the `mcp.json` files fail this); (3) warm MCP children holding an item are stopped on narrowing, and a new turn re-admits; (4) witnesses: changed command with same name and slot refused, crash leaves no residue, warm-next-turn denied.

## 12. CHANGES (r1 → r2): every Critical/High and Medium from both reviews

| Finding | Mechanism (section) | Witness | Mutant |
| --- | --- | --- | --- |
| Fable H1 file delivery readable by model and other bots; card text untrue | File delivery removed; only `vault_run` (D4, 4.4); P2/P3 reworded to what is enforced; R1/R2 stated on card and page (1.1) | W2b, W3, W13, W28 | temp-file/env for stdin row; scrub sink removed; R-line removed |
| Fable H2 secrets inside a git-addable/deployable tree | No file anywhere (D1, F4); the `inSecretFolder` predicate is dropped as unnecessary | W2b (whole-tree scan) | debug copy written to tmp/workspace |
| Fable H3 stale reload re-widens grants | No reload-and-reapply path; FIFO ops (D15); `view = apply(ledger, base)` on every load (D16) | W16 | ledger cleared on reload |
| Astra C1 same-user custody bypasses grants | Delivery only into a Murage-spawned process, stdin by default; nothing on disk; honest R1 with page line and product acknowledgement (Q1); the store-key residual is the existing accepted one (`docs/terms-acceptance.md:13`) | W2a, W2b (incl. `/proc` environ row), W12, W28 | grant removed; env/file for stdin row |
| Astra C2 MCP binding without recipient fence | No MCP binding in part 1 (D8, F5); part-2 contract with identity + revision + no-disk + warm-stop rules (11.2) | W17 | `resolveHeldEnv` consults the Vault |
| Astra H3 scrub misses short values / after model delivery / native log / chunks | D14 refuses < 8; scrub owned by the server before the reply to the proxy (D11); child stdio never inherited; whole-buffer scrub; held set covers replaced/deleted values until their processes end (F9) | W13, W13b, W14, W25 | form dropped; stdio inherit; per-value loop; length check removed |
| Astra H4 restart cannot prove which action committed | Receipts in the same write (D17); page ops persisted; UNCONFIRMED for post-rename/read-back failure; malformed/newer section = BROKEN (D5) | W4, W5, W6, W6b, W6c, W9b | final-state resolution; uncertain → NOT_KEPT; page ops unpersisted; schema failure → empty |
| Astra H5 live protocol loses a revocation or strands a card | Epoch + generation checks inside `derive` (one serialized mutation); FIFO; ledger through reloads; post failure, 30 s silence and mismatched replies defined (O2-O6); boot over utility port, launch-secret stdin untouched (D3) | W7, W8, W16, W4 | epoch outside queue; concurrent posts; ledger cleared |
| Astra H6 card delivery/continuation contract | Settlement CAS, separate delivery and persistence outcomes, resume text names the item, once items, collision rule, room rule, no-folder refusal, no files so no repeat-use collision (4.1, 4.4) | W22, W23, W27, W24 | no CAS; card REPLACE; cwd check removed; no REVOKE_BOT |
| Astra H7 1Password authority/cache | `accountGeneration`, completion re-check, spawn fence, UNLINK narrowing, no cache, every provider error refuses (4.5, D12) | W20, W15c (UNLINK row) | cache added; vault grant first; no completion check |
| Astra H8 headless opt-in custody | LOCKED on headless and `basic_text`, no opt-in (D6); Q4 | W10, W11 | opt-in honoured |
| Astra H9 downgrade exposes a plaintext delivery in backups | No plaintext delivery exists (D1); section is top-level and outside `mcpServerSecrets`; released-version downgrade witness (7) | W19a, W19b | dropping fixture writer |
| Astra H10 Cloud contract | homePin + item generation + Cloud-validated bots + opId receipt + fingerprint over value, generation and bots; retry by opId; Flux key refusal (8); still hidden until signed | W21 | fingerprint over value only |
| Astra H11 W15 passes without generation fence | W15 rewritten: REPLACE with grant kept, pause between lookup and spawn; replay/expiry/foreign rows are moot (no refs); W19 split into a guard and a downgrade check | W15a, W15b, W19a/b | no spawn re-check; stale generation used |
| Fable M4 main replaces whole section | Delta ops; main carries unnamed items from its latest doc | W8b | whole-section replace |
| Fable M5 bot deletion | REVOKE_BOT before delete commits (4.7, D19) | W24 | no REVOKE_BOT |
| Fable M6 file TTL across quit | Moot: no files | W2b | — |
| Fable M7 base64/hex, cost by held values | F9 forms and single pass | W13, W14 | form dropped; per-value loop |
| Fable M8 card phishing, name collision | "<bot> wrote this", new item on collision, card never replaces | W23 | card REPLACE |
| Fable M9 1.0.20 downgrade unverified | W19b on the released build before Q4 | W19b | dropping fixture writer |
| Fable M10 1Password cache after revoke | No cache (D12) | W20 | cache added |
| Fable rollback line | `VAULT_ENABLED` constant (D18, 4.8) | W26 | flag ignored |

## 13. GAP-CHECK (one adversarial pass on r2, GAP-CHECK-BAR)

### Fixed
1. (b failure path) The owner revokes a bot, the keyring locks mid-session, Murage restarts: in r1 the item came back. Now the ledger keeps it dead until a write succeeds (W16).
2. (d leak) A bot runs `curl -H "Authorization: Bearer $KEY"` through a shell: the value lands in curl's argv, readable by any local user. Murage cannot stop the command, but stdin is the default and the tool text steers to `-H @-`; stated in R2.
3. (b failure path) A `vault_run` child outlives a crashed server on POSIX: it keeps its own memory copy until it exits (≤ timeout); nothing is on disk; Windows kill-on-close job ends it. Stated, no residue (W2b covers disk).
4. (d leak) The bot prints a value the owner just replaced; the old value is no longer "held". Fixed: replaced/deleted values stay in the scrub set until every process started with them has ended and its result is sent (F9).
5. (b failure path) Main never answers (bug or hang): the FIFO would block forever. Fixed: 30 s → UNCONFIRMED → read; narrowing ops still run (O5, FIFO rule).
6. (a purpose gap) A card's value is needed now but the save is pending: the once item makes it usable at once in that chat, separate from persistence (4.1 step 5).
7. (d safety) A bot names `PATH` or `LD_PRELOAD` as the env name to hijack the command: denylist (W27).
8. (c rule conflict, No limits) `vault_run` could have added its own approval prompt; it reuses the command approval at the bot's level (D20).
9. (d leak) A once item from a dismissed or Stopped card: none is created on dismiss; Stop kills running holders; once items expire in 1 h and die on restart.
10. (b failure path) 100 card saves at once from a 100-bot room: FIFO plus per-op terminal states, no lost revocation (W8).

### Parked (one-line reason, for the product owner)
- Per-bot OS sandbox for commands (would close R1 for env delivery): a new platform surface, far over 20% of this design.
- Plain-text opt-in Vault on headless and `basic_text` Linux (Q4): needs its own custody design.
- MCP key slot binding (Q2, 11.2): needs no-disk MCP custody from D3 first.
- Owner-pinned commands per item (would narrow R2): a new feature.
- Desktop delete propagating to My Cloud: new sync behaviour.
- Listing closed-list and MCP keys on the Vault page; Bitwarden (#6353); team vaults: as r1.

### Rejected
- Per-item reveal button: violates P3.
- Scrubbing values under 8 characters: masks ordinary output words; D14 refuses them instead.
