# OpenGrokBot

An open clone of the **Grok Bot** macOS app — a Telegram-style chat manager
for AI bots, where every bot is a real agent running on the provider of your
choice.

## How it works

Two processes:

- **Harness server** (`server/`, port 8799) — owns every provider process.
  A driver registry turns instance configs into live provider instances
  (Claude and Codex over their local CLIs, and a cloud-computer agent; a
  Grok/xAI API driver exists behind config). Every driver's native protocol
  is normalized into one canonical runtime event stream, which is logged
  per-thread as NDJSON, folded into persistent transcripts, and fanned out
  to clients over SSE.
- **App** (`src/`, port 5199) — React + Tailwind. Holds no transports of its
  own: it sends typed commands over HTTP (`/api/...`, proxied by Vite) and
  folds the one SSE stream into local state.

Features wired end-to-end:

- **Sidebar** — bot list with SupaMaus cursor mascots, role-aware expressions,
  ten-color identities, previews, unread dots,
  new-bot button, Plugins + profile footer
- **Chat** — streaming replies (token deltas), tool-run activity chips,
  approval/question cards answered inline, screenshots of the bot's cloud
  computer, stop button
- **Model selector** — in the chat header and in Settings: per-instance rail
  with provider marks, model list with defaults, unavailable providers shown
  disabled with the reason (missing API key, CLI not installed, …)
- **Computer** — each bot gets a computer: a cloud box (auto-provisioned,
  live screen preview, hand-over via browser) or this Mac (frames via the
  desktop app), with a per-bot cloud/local/off switch
- **Voice** — the composer mic dictates via native macOS speech recognition
  (desktop app; on-device when supported)
- **Settings** — per-bot Name / Title / Description (become the bot's system
  prompt), model selection, Notifications toggle; app-level credentials
  (Composio, Box) are pasted once in App Settings and hot-reload the fleet
- **Connected apps** — Composio Connect marketplace with one-click OAuth

## Run

```sh
pnpm install
pnpm dev:server   # harness server on http://127.0.0.1:8799
pnpm dev          # app on http://localhost:5199 (proxies /api to the server)
pnpm dev:desktop  # Electron shell (loads the dev URL)
```

Provider setup: paste keys in **App Settings** (gear in the sidebar footer)
— Composio Connect key, optional Composio API key (full app catalog), Box
token. They persist to `~/.opengrokbot/config.json` and the provider fleet
hot-reloads. Claude and Codex need their CLIs (`claude`, `codex`) installed
and logged in.

```sh
pnpm typecheck    # app + server
pnpm build        # typecheck + production build
```
