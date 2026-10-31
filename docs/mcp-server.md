# Murage MCP server

The Murage desktop app includes a local stdio MCP server. It lets another MCP client coordinate your
Murage team while the desktop app and its harness are running.

## What it can do

- list bots and channels, including their active task and current activity;
- read bounded transcript pages and search local transcripts without returning screenshot pixels;
- create and safely edit bot profiles, channels, and separate task conversations;
- send work to a bot or channel, wait for either conversation to settle or need help, and interrupt its active turn;
- list configured model instances and switch an idle bot to an exact available model.

The v1 server intentionally cannot approve requests, remember permission grants, delete data, import teams,
change credentials, or control computer/VM lifecycle. Those actions stay in the human-facing app.

## From a source checkout

Start Murage, then configure the MCP client to run:

```json
{
  "mcpServers": {
    "murage": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/Murage", "mcp"]
    }
  }
}
```

## From the installed desktop app

Release builds bundle `server/mcp-server.js` and can run it with Electron's embedded Node runtime, so users do
not need Node.js or pnpm installed.

The installed app keeps no standing key, so first make script access for one bot (see Connection discovery
below): **Settings → Devices → Advanced → Scripts and other apps**, switch on "Let scripts use a bot", pick
the bot, choose whether it may also send, and copy the token Murage shows once. Every packaged config then
carries that token in `MURAGE_TOKEN` and the port in `MURAGE_PORT` (`8799` unless another program held it at
start, then `18799` or `28799`). A token is refused without an explicit port or URL, so it is never sent while
probing.

macOS example:

```json
{
  "mcpServers": {
    "murage": {
      "command": "/Applications/Murage.app/Contents/MacOS/Murage",
      "args": ["/Applications/Murage.app/Contents/Resources/server/mcp-server.js"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "MURAGE_TOKEN": "mcpg_paste-the-token-here",
        "MURAGE_PORT": "8799"
      }
    }
  }
}
```

On Windows, use the installed `Murage.exe` as `command`, the adjacent
`resources\\server\\mcp-server.js` as the argument, and the same three environment values
(`ELECTRON_RUN_AS_NODE=1`, `MURAGE_TOKEN`, `MURAGE_PORT`). The usual per-user install is under
`%LOCALAPPDATA%\\Programs\\Murage`.

On Ubuntu `.deb` installs, the executable is normally `/opt/Murage/murage` and the script is
`/opt/Murage/resources/server/mcp-server.js`. Use the same three environment values.

## Connection discovery

With no configuration, the MCP process probes Murage's three desktop ports (`8799`, `18799`, and `28799`)
and accepts only a health response that identifies itself as Murage. This handles the desktop's normal
fallback when another local process already owns port 8799.

The harness answers its conversation routes (the fleet, transcripts, search) only to a caller that proved who
it is, so a script on the same computer cannot read them just by reaching the port. The packaged app and the
headless install keep no standing key on disk. Instead you make script access for one bot: in Murage, open
**Settings → Devices → Advanced → Scripts and other apps** (on a headless install, Settings → General in your
browser), switch on "Let scripts use a bot", pick the bot, and choose whether it may also send. Murage shows the
token once; put it in `MURAGE_TOKEN` and set `MURAGE_PORT` (or `MURAGE_URL`). The harness keeps only a hash of
the token, so nothing a bot can read in the data folder opens a door. The token reads that bot's conversation
and, if you allowed it, sends to that bot or stops its turn; it cannot reach other bots, rooms, search or any
setting. It lasts 30 days and you can switch it off at any time. Approving a request or changing a setting
still happens in the app or on your paired phone.

Development and fixture launches (`MURAGE_ALLOW_DEV_DESKTOP_SECRET=1`) still use the key file
`mcp-access.token` in the data folder, which the server and the control CLI read themselves and send only to a
loopback address.

Set `MURAGE_PORT` to force one local port, or `MURAGE_URL` to use an explicit HTTP(S) origin. Cleartext remote
HTTP is rejected unless `ALLOW_INSECURE_HTTP=true`; HTTPS should be used outside loopback. An optional
`MURAGE_TOKEN` is sent as a bearer token for authenticated reverse proxies. When a token is set, an
explicit `MURAGE_URL` or `MURAGE_PORT` is required so the credential is never sent while probing unrelated
local ports. `MURAGE_MCP_TIMEOUT_MS` can set an HTTP timeout between 1,000 and 120,000 milliseconds.

## Tools

| Purpose | Tools |
|---|---|
| Inspect | `get_system_health`, `list_bots`, `list_channels`, `get_bot_messages`, `get_channel_messages`, `search_messages`, `list_available_models` |
| Create and organize | `create_bot`, `update_bot_profile`, `create_channel`, `update_channel`, `create_task`, `switch_task`, `rename_task` |
| Run work | `send_bot_message`, `send_channel_message`, `wait_for_conversation`, `interrupt_conversation`, `set_bot_model` |

### What a one-bot token reaches

A script-access token opens only the routes in `server/mcp-grants.ts` (`mcpGrantAdmits`), all for its one bot:

| Tool | With a read token | With a read-and-send token |
|---|---|---|
| `get_system_health` | yes | yes |
| `list_bots` | lists that bot only | lists that bot only |
| `get_bot_messages` | that bot's conversations | that bot's conversations |
| `wait_for_conversation` | that bot's conversations | that bot's conversations |
| `send_bot_message` | no | yes |
| `interrupt_conversation` | no | that bot only |

Every other tool (channels, search, creating or editing bots and tasks, models) gets the unknown-route answer.
`get_bot_messages` and `wait_for_conversation` reach the tasks the bot record lists; an older task outside that
window needs the task lookup route, which a token does not open. A token never approves anything.

`wait_for_conversation` returns `settled`, `needs-user`, `failed`, `stalled`, or `timed-out`, along with a
small redacted transcript tail (`messages`, the last 10, and `hasMore`). Its `target` carries the bot's or
channel's status fields (`busy`, `activity`, `working`, `activeTaskId` and the rest) and only the waited task as
`task`, not the owner's whole task list; `list_bots` and `list_channels` list tasks. MCP cancellation is
honored while a tool is waiting.

## Safety and data scope

Transcript reads are paged and capped at 200 messages. Search is capped at 100 hits. Screenshot pixels and
permission grant keys are removed from MCP results. Tool schemas reject unknown fields and malformed values,
and model changes are refused while a bot is working.

The harness itself is local-first and normally binds to loopback. If you expose it through a reverse proxy,
authentication and TLS at that proxy are part of your deployment's security boundary.
