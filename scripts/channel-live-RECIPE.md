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
| One owner request → one run → one reply (fake Claude engine, no paid model) | Ambiguous outbound delivery (cannot be forced without interfering with the provider) |
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
4. **Test computer.** Run from a checkout of the branch under test on the computer named in `testHostname`, with Node 24 and `pnpm install` done. The run launches its own isolated server (temporary HOME and data, fake Claude engine) and never touches a normal Murage profile.
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

## Provider setup

### Telegram

1. In Telegram, message `@BotFather`, send `/newbot`, and create a bot used only for qualification. Save its token to the credential file.
2. Record the bot's username (shown by `@BotFather`, for example via `/mybots`) and its numeric ID, which is the digits before `:` in the token. Read them in your editor; don't print the token in a terminal. The runner checks offline that the token's prefix equals `botId`, then checks the `getMe` identity during pairing.
3. Record the owner test account's numeric user ID, for example from an ID-lookup bot. Treat that lookup as account activity you authorise.
4. From the owner account, open a private chat with the new bot and press Start, so the bot can reply.

### Slack

1. Create a Slack app in a **test workspace**. Enable **Socket Mode** and create an app-level token with only `connections:write` (`xapp-…`).
2. Bot token scopes: `im:history` and `chat:write` only. Event subscription: bot event `message.im` only. Enable the Messages tab so members can DM the app.
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
2. Privileged intents: none. The runtime requests only the Direct Messages intent. Do not enable Message Content, Server Members or Presence.
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
| 3 | `Qualification request one: reply once.` | one `hello from fake claude` | one run, one reply (A6) |
| — | runner restarts the server on the same data | none | resume without a new code (A2) |
| 4 | `Qualification request two after restart: reply once.` | one new reply | A6 after restart |
| — | runner demotes the fixture Chief | none | — |
| 5 | `Qualification request after the Chief changed: expect no reply.` | **no reply** | Chief change fences intake (A9) |
| — | runner revokes and cleans up | none | A9 revoke, evidence custody |

The operator answers y/N attestations about what arrived in the chat, and those answers are recorded. Replies come from the fake Claude engine, so no paid model is called.

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

## Required inputs, grouped by platform (one request)

**All platforms:** exact approval text (`authorityReference`); test computer hostname; message/time budget (defaults 5 operator / 4 replies / 30 minutes); production identities to deny; confirmation that no other receiver uses the test credential.

**Telegram:** dedicated test bot numeric ID and username; owner test account numeric user ID; path to the 0600 bot-token file; confirmation the owner has pressed Start in the bot chat.

**Slack:** test workspace ID; app ID; bot user ID; bot ID; owner member ID; paths to the 0600 app-level (`xapp-`, `connections:write`) and bot (`xoxb-`, `im:history` + `chat:write`) token files; confirmation that Socket Mode, `message.im` and the Messages tab are enabled in the test workspace install.

**Discord:** application ID; bot user ID; owner user ID; path to the 0600 bot-token file; confirmation that only the Direct Messages intent is used, the install is `bot` with permissions 0, and the owner can DM the bot.
