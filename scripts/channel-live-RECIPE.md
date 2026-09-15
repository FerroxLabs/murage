# Live channel qualification recipe — Telegram, Slack, Discord

Qualifies the existing Chief-only channel implementations against a real
provider using **dedicated test identities only**. It is not a production
setup guide and it grants no authority by itself: a live run needs Sean's
explicit approval, which is recorded as the manifest's `authorityReference`.

Missing inputs mean **live qualification NOT RUN**, not passed.

## What a live run proves, and what it does not

| Proven against the live provider | Not proven live (rehearsal or unit evidence only) |
|---|---|
| Saved credentials are not a paired owner | Offline and startup recovery (not safely inducible) |
| The credential belongs to the dedicated test identity | Receiver conflict or credential rejection (needs a second receiver or a revoked credential) |
| Pairing binds the exact dedicated owner and DM to the current Chief | Provider redelivery of an accepted event (the provider controls this) |
| The paired owner's channel account starts link-required and is linked to the workspace owner before any work (runner owner API, isolated data only) | Link guidance to an unlinked sender and the settings link screen (offline journeys and browser evidence only) |
| Plain `yes` gets review guidance and starts no run (Slack, Discord) | Approve once / Deny button rendering and taps unless the separately authorized `--buttons yes` pilot runs |
| One owner request → one run → one reply: the fake Claude engine by default; with `engine.descriptorFile`, the admitted real engine's completed run and its exact reply | Ambiguous outbound delivery (cannot be forced without interfering with the provider) |
| A same-data restart resumes without a new pairing code | Installed desktop app behaviour (the run uses the source server, not a signed package) |
| A Chief change stops intake; revoke unpairs this test installation | Slack: Socket Mode ACK is transport receipt, not model completion |
| No credential bytes in evidence or logs | Discord: Gateway Resume is not durable offline history |

No provider promises lossless delivery. Telegram retains undelivered updates
for at most 24 hours; Slack retries are finite; Discord does not replay events
missed while the process was stopped.

## Preconditions (all platforms)

1. **Dedicated identities.** Create a new test bot/app and use a test owner account. Never use Sean's production Telegram bot, a production Slack workspace app or a production Discord application. Put known production identities in `denylistIdentityIds`.
2. **No second receiver.** No other Murage installation, script or webhook may use the test credential while the run is active. For Telegram, a new BotFather bot has no webhook. If anything else polls it, the run will observe a conflict and stop.
3. **Stop on mismatch.** The runner stops, revokes and cleans up if the provider identity, bound owner or DM differs from the manifest.
4. **Test computer.** Run from a checkout of the branch under test on the computer named in `testHostname`, with Node 24 and `pnpm install` done. The run launches its own isolated server (temporary HOME and data; the fake Claude engine, or only the admitted real engine when `engine.descriptorFile` is set) and never touches a normal Murage profile.
5. **Budget.** At most 10 operator messages, 10 bot replies and 45 minutes, set per manifest. The planned sequences need 4/3 (Telegram) and 5/4 (Slack, Discord).

## Secure credential delivery

The owner creates each credential file on the test computer. Credentials never go through chat, command-line arguments, shell history or the repository.

```sh
umask 077
mkdir -p ~/murage-channel-qualification && cd ~/murage-channel-qualification
# Paste the token into an editor, save, then:
chmod 600 telegram-test-bot.token
```

Each file must be a regular file (not a symlink), owned by you, mode `0600`, at most 512 bytes, outside the checkout, and hold one credential of the right shape. The manifest is a separate JSON file holding identities and file paths only; start from `scripts/channel-live-inputs.example.json`, keep one platform per file, and store it next to the tokens.

After the run: revoke or rotate the test credential at the provider and delete the files.

## Optional real model engine

By default the replies come from the repository's fake Claude engine: the run then proves channel mechanics only and records `model.live` as NOT RUN. To qualify real model runs and replies, add `"engine": { "descriptorFile": "/absolute/path/engine.json" }` to the manifest. Root supplies the reviewed descriptor; this lane does not create provider or model credentials.

- **Admission** reuses the B08 runner's rules. The descriptor must name a non-fake engine, driver, model, dedicated account and spend record, with no inline secret. Its credential must come through `credential.file`: owner-only (0600), outside the repository and personal credential stores. The credential reaches only the isolated server's environment. It never appears in the manifest, plan, arguments, evidence or logs, and the evidence scan also checks for its bytes.
- **Launch.** The isolated server's config names only that one instance (explicit discovery, no fake-engine switches). The fixture Chief is pinned to the descriptor's model with computer, browser and connected apps off.
- **Checks.** Before promotion and again after the restart, `/api/instances` must describe exactly that available, non-fake instance with its catalog model (`A0.engine`, `A0.engine-restart`). For each owner request the run must produce exactly one new completed Chief run and exactly one new delivery for that run, in state `sent`, whose reply equals the run's own output. The Chief task for that run's thread must be pinned to the admitted instance and model, with no Auto or remembered grants (`A6.one-identity`, `A6.restart-identity`). Evidence keeps each reply's run ID, SHA-256 and length, not its text. The operator confirms the reply that begins with the excerpt shown on the terminal. At most 2 model runs (request one and request two) are dispatched; a third is a stop.
- **Spend** follows the descriptor's recorded authority and cap. The pilot uses two model turns.
- **Not proven:** answer quality, other templates, the installed desktop app, or provider-side billing.

## Provider setup

### Telegram

1. In Telegram, message `@BotFather`, send `/newbot`, and create a bot used only for qualification. Save its token to the credential file.
2. Record the bot's username (shown by `@BotFather`, for example via `/mybots`) and its numeric ID, which is the digits before `:` in the token. Read them in your editor; don't print the token in a terminal. The runner checks offline that the token's prefix equals `botId`, then checks the `getMe` identity during pairing.
3. Record the owner test account's numeric user ID, for example from an ID-lookup bot. Treat that lookup as account activity you authorise.
4. From the owner account, open a private chat with the new bot and press Start, so the bot can reply.

### Slack

1. Create a Slack app in a **test workspace**. Enable **Socket Mode** and create an app-level token with only `connections:write` (`xapp-…`).
2. Bot token scopes: `im:history` and `chat:write` only (`chat:write` also covers editing the bot's own approval card). Event subscription: bot event `message.im` only. Under **Interactivity & Shortcuts**, turn Interactivity on so Approve once / Deny taps can reach the runtime as `block_actions` over the Socket Mode connection; Socket Mode needs no Request URL. Add no shortcuts or slash commands. Enable the Messages tab so members can DM the app.
3. Install to the test workspace and save the bot token (`xoxb-…`).
4. Record these identities without putting a token in a command:
   - App ID (`A…`): the app's **Basic Information** page. The runner checks offline that the app-level token carries this app ID.
   - Workspace ID (`T…`): the workspace URL or its About page.
   - Bot user ID (`U…`): in Slack, open the app's profile from **App Home** and use **Copy member ID**.
   - Owner member ID (`U…`): the owner's profile, **Copy member ID**.
   - Bot ID (`B…`): if the UI doesn't show it, one authorised `auth.test` call may be made, with the token in a 0600 header file rather than the command line: create `slack-auth.header` containing `Authorization: Bearer <xoxb token>` (mode 0600), then run `curl -sS -H @slack-auth.header https://slack.com/api/auth.test`, and delete the header file afterwards. That call is account activity you authorise. The live run also stops if the verified bot identity differs from the manifest.
5. Distribution stays private to that workspace. Socket Mode apps are not Marketplace-distributable.

### Discord

1. Create an application in the Discord Developer Portal. Add a bot and save its token.
2. Privileged intents: none. The runtime requests only the Direct Messages intent. Do not enable Message Content, Server Members or Presence. Leave **Interactions Endpoint URL** (General Information) empty: Discord delivers interactions either to that URL or over the Gateway, never both, and Approve once / Deny taps must arrive over the Gateway, which needs no extra intent.
3. Install with OAuth2 scope `bot` and permissions `0`. The bot does not operate in guild channels.
4. Make the bot reachable for an owner-initiated DM. For example, add it to a private test server that only the owner is in, or use a user install. Then send it a DM from the owner account. Record the application ID (Developer Portal → **General Information**), the bot user ID (with Developer Mode enabled, right-click the bot → **Copy User ID**) and the owner user ID, all decimal snowflakes. The runner checks offline that the bot token's first segment encodes this bot user ID.

## Commands

From the checkout root:

```sh
# 1. Offline validation only: prints the redacted plan and budget, launches nothing.
node --experimental-strip-types scripts/channel-live-providers.ts plan --platform telegram --inputs ~/murage-channel-qualification/telegram.json

# 2. Optional offline rehearsal of the same steps with scripted stand-ins (no network).
node --experimental-strip-types scripts/channel-live-qualify.ts rehearse --platform telegram
node --experimental-strip-types scripts/channel-live-providers.ts rehearse --platform slack
node --experimental-strip-types scripts/channel-live-providers.ts rehearse --platform discord

# 3. LIVE: interactive terminal, exact authority text from the manifest.
node --experimental-strip-types scripts/channel-live-providers.ts run --platform telegram \
  --inputs ~/murage-channel-qualification/telegram.json --authority "<exact authorityReference>"
```

`run` refuses unless the manifest validates, `--authority` matches exactly, the terminal is interactive, and the credential files pass their checks. Evidence goes to `$TMPDIR/murage-channel-live-evidence-<platform>-live-*` (`steps.jsonl`, `server-boot-*.log`, `result.json`). The pairing code is shown only on the terminal.

## Budgeted message sequence

The operator sends each message only when the runner prompts for it.

| # | Operator sends (from the dedicated owner, in the bot DM) | Expected bot reply | Checks |
|---|---|---|---|
| 1 | `/pair <code shown by the runner>` | one pairing confirmation | identity, exact owner/DM binding, A1 |
| 2 | `yes` (Slack and Discord only) | one "review approvals in Murage" reply, no run | approval text is never authority |
| — | runner links the paired owner's channel account to the workspace owner, in the isolated data only | none | channel work requires a linked person (A5.link); without it request one gets link guidance instead of a run |
| 3 | `Qualification request one: reply once.` | fake engine: one `hello from fake claude`; real engine: one model reply (the runner shows its opening words) | one run, one reply (A6; with a real engine also A6.one-identity) |
| — | runner restarts the server on the same data | none | resume without a new code (A2) |
| 4 | `Qualification request two after restart: reply once.` | one new reply | A6 after restart |
| — | runner demotes the fixture Chief | none | — |
| 5 | `Qualification request after the Chief changed: expect no reply.` | **no reply** | Chief change fences intake (A9) |
| — | runner revokes and cleans up | none | A9 revoke, evidence custody |

The operator answers y/N attestations about what arrived in the chat, and those answers are recorded. With the fake engine no model is called; with an admitted real engine exactly two model turns are dispatched under the descriptor's spend record.

### Optional button pilot (`--buttons yes`)

Offline admission passed: 12 runner checks include actual Slack and Discord permission-host Allow/Deny paths; the CLI is executable and source typechecking passes. Live provider-button qualification remains unrun and requires the larger message/tap budget below. The unchanged default sequence remains available. Known-zero cost applies only to the scripted permission phase, not the preceding real-model replies.

The optional pilot requires separate root approval of the larger budget and manifest limits at least the totals below, with maxMinutes no greater than 30. Pass `--buttons yes` to both `plan` and `run`. Default runs remain unchanged. The existing 10/10/45 manifest hard caps remain in force; opt-in admission adds the stricter pilot requirements.

After the two ordinary reply turns and their identity receipts, the runner stops its owned server, replaces only the isolated engine catalog with `scripts/channel-button-permission-cli.mjs`, restarts the same channel binding, and pins the Chief defaults and checks each new task against that fixture with autoReview off, autoApprove false and alwaysAllow empty. Real model credentials are omitted from this boot. This fixture calls the actual mounted permission host but never executes a command or calls a model. Permission results are therefore **scripted-engine/live-provider** evidence, separately labeled from the earlier real model turns.

The operator confirms each new card before tapping exactly once. Host request/decision receipts and task/run/delivery identity are measured. Provider card sends and in-place edits have no durable product receipt, so their exact counts and appearance are explicitly **operator attestations**, counted separately from ordinary delivery receipts. Missing or uncertain observations stop the pilot; do not repeat a tap.

Per platform it adds, after the restart and before the Chief demotion: 2 owner messages (an approve-once request, then a deny request), 2 taps (**Approve once** once on the first card, **Deny** once on the second) and 4 bot messages (2 cards, 2 replies), plus 2 in-place card edits. Totals: Telegram 6 owner / 7 bot / 2 taps; Slack and Discord 7 / 8 / 2; 30 minutes; inside the 10 / 10 / 45 caps.

Tap each button once, from the dedicated owner in the bot DM, within 10 minutes of the card being sent (tap promptly after it arrives). Typing `yes` never approves. A button offered before a restart, or tapped after the Chief change, must not decide anything. Those stale/duplicate/owner/message fences retain their existing offline coverage; this two-tap live budget does not exercise extra adversarial taps or create a third permission card.

## Cleanup

The server runs in its own process group, so Ctrl-C in the terminal reaches only the runner. The runner prints the server PID and fixture root at every boot.

**What happens on exit.** All of these leave through one cleanup path:
- normal completion;
- any stop condition (identity/owner/DM mismatch, budget, time limit, missing reply, operator `STOP`);
- a runner error;
- the runner receiving SIGINT (Ctrl-C), SIGTERM or SIGHUP. A second signal during cleanup only prints a notice.

That path does four things, in order:
1. If pairing was started — even if the pair request itself failed or timed out — POST revoke, then re-read status. The revoke counts only when the request returned 200 and status shows unpaired. The outcome is recorded as `stop.revoke`, and a failure is a FAIL, never assumed success.
2. Demote the fixture Chief, best effort, recorded as `stop.demote`.
3. Stop only the server PID it launched (SIGTERM, then SIGKILL after a grace period).
4. Remove only its temporary root. That also deletes the local binding data.

If the server was already unreachable, the revoke is recorded as failed. Removing the root still deletes the local binding, but the provider credential stays valid.

**What cannot be handled.** If the runner is killed with SIGKILL, or the computer loses power, no cleanup runs. The detached server keeps running with the test credential. Stop the printed server PID yourself (`kill <pid>`), delete the printed fixture root, and rotate the test credential at the provider.

Afterwards:

- Telegram: revoke the token in `@BotFather` (`/revoke`) or delete the bot.
- Slack: uninstall the test app or rotate both tokens.
- Discord: reset the bot token or delete the test application.
- Delete the credential files and manifest. Keep the evidence directory for review.

## Inputs

Identities, test computer hostname, denylist and credential file paths already held in a per-platform manifest are not requested again; `plan` must validate that manifest on the test computer first. Before each live run supply only:

- the current exact `authorityReference` for that run (an earlier grant does not carry over);
- the budget: Telegram 4 operator / 3 replies, Slack and Discord 5 / 4, 30 minutes;
- confirmation at run time that no other receiver uses the test credential;
- button pilot only: the root-approved pilot budget (Telegram 6 / 7, Slack and Discord 7 / 8, plus 2 taps); Slack Interactivity is on; Discord Interactions Endpoint URL is empty.

The engine descriptor (`engine.descriptorFile`) is supplied by root, not requested from the account owner.

Only a platform without a manifest needs the identities below, together with the test computer hostname and the production identities to deny.

**Telegram:** dedicated test bot numeric ID and username; owner test account numeric user ID; path to the 0600 bot-token file; confirmation the owner has pressed Start in the bot chat.

**Slack:** test workspace ID; app ID; bot user ID; bot ID; owner member ID; paths to the 0600 app-level (`xapp-`, `connections:write`) and bot (`xoxb-`, `im:history` + `chat:write`) token files; confirmation that Socket Mode, `message.im` and the Messages tab are enabled in the test workspace install.

**Discord:** application ID; bot user ID; owner user ID; path to the 0600 bot-token file; confirmation that only the Direct Messages intent is used, the install is `bot` with permissions 0, and the owner can DM the bot.
