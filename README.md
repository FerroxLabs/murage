<div align="center">

<img src="brand/MurageLogo-Dark.png#gh-light-mode-only" alt="Murage" width="420">
<img src="brand/MurageLogo-Light.png#gh-dark-mode-only" alt="Murage" width="420">

**One desktop. Every AI engine. Doing real work on their own computer.**

[![License](https://img.shields.io/badge/license-Apache--2.0-FF6B35)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-111)](#install)
[![Engines](https://img.shields.io/badge/engines-10%2B-FF6B35)](#the-engines)
[![Built by Ferrox Labs](https://img.shields.io/badge/built%20by-Ferrox%20Labs-111)](https://murage.ai)

</div>

---

You're already paying for the models. You're just missing the thing that runs them.

Here's the deal. You've got a Claude subscription. Probably a ChatGPT one too. Maybe Gemini, maybe Grok, and a terminal agent or two you installed at 1am and forgot about. Every one of them lives in its own window. Its own chat history. Its own idea of who you are. You copy-paste between them like it's 2023.

None of them can touch anything. They write you an answer and it's on you to go and do it.

Murage is one window that runs all of them. Same roster, same memory, same connected apps. And an Ember can be handed a real machine of its own, so the work actually gets done instead of described.

### Where this came from

Two things got welded together to make this.

The first is [OpenMausBot](https://github.com/milind-soni/OpenMausBot), built by Milind Soni. Genuinely excellent work, Apache 2.0, and moving at a pace most teams could not survive. Murage is a fork of it. We say that up front because it's true and because the shell he built is the best starting point in this category by a distance. Credit where it's earned.

The second is ours. Ferrox Labs has been building **Wayland** for a while now: Wayland Core, the agent engine, and the transport layer underneath it that speaks Slack, Discord, Telegram, WhatsApp, Signal, iMessage, SMS, Email, Matrix and Teams natively. Years of that work, hardened in production, is what Murage now inherits.

So this is not a reskin. It's Wayland's engine and channels moving into a desktop shell that deserved them, and the Wayland lineage is where the roadmap goes from here. More of Core lands in this app every release.

<div align="center">

*Screenshot: the roster. Coming with the first release.*

</div>

## Install

macOS, Windows and Linux. Grab the build for your machine:

```
https://murage.ai/download
```

Open it. It picks up your existing agent CLIs, creates your first Ember, and you're talking to it in under a minute.

Building from source instead? Skip to [Build it yourself](#build-it-yourself).

**You need:** Node 24+, and at least one agent CLI installed (Claude Code, Codex, Gemini, Grok, whatever you already run). Murage finds them.

## What an Ember is

An Ember is an agent that lives in your roster. It has a name, a face, a color, a model, and a job.

The first one is called Ember, and she's orange. Everyone after her gets a name from the pool and a color you pick, or you drop in your own avatar and she wears that instead.

Embers are not chat windows. They hold state. They run on a schedule if you tell them to. They talk to each other. They can pick up a task you handed them on Tuesday and still know what it was about on Friday.

<div align="center">

*Screenshot: an Ember mid-task. Coming with the first release.*

</div>

## The engines

This is the part nobody else does.

Claude Desktop runs Claude. Codex Desktop runs Codex. Want a second model, install a second app, with a second roster and a second memory and a second set of everything.

Murage runs whatever you've got:

| | |
|---|---|
| **Claude** | Claude Code, full permission cards |
| **Codex** | OpenAI's CLI, approval policy honored |
| **Gemini** | Google's CLI over ACP |
| **Grok** | xAI's Grok Build |
| **Kimi** · **Qwen** · **Droid** | via ACP |
| **Cursor** · **opencode** | via ACP |
| **Fuigo** | our own engine, see below |
| **Anything else** | any CLI that speaks ACP over stdio. One config entry, no code |

Different Ember, different engine, same roster. Put Claude on the writing, Codex on the refactor, Gemini on the research, and watch them hand work to each other.

That last row matters more than it looks. When the next model ships with a CLI, you add four lines to a config file and it's in your roster that afternoon. You don't wait for us.

## Fuigo

Fuigo is the engine underneath. Named for the bellows that feed a furnace, which is roughly its job.

Murage looks for it on first run. If it's already on your machine you're done. If it isn't, you get one prompt and about thirty seconds of downloading, and then you're done.

You never have to use it. Every other engine above works exactly the same. But Fuigo is where the channels come from, and the channels are the interesting bit.

## Where your agents can reach you

An agent that only exists inside an app you have to open is a worse agent.

Through Fuigo, Embers reach you on **Slack, Discord, Telegram, WhatsApp, Signal, iMessage, SMS, Email, Matrix and Microsoft Teams.** Native, not a webhook duct-taped to a Zapier zap.

So the routine you set on Sunday night sends its Monday summary to the Slack channel your team already reads. And when it needs a decision, it asks you there, and you answer there, on your phone, in the queue at the airport.

## Connect the rest of your stack

Gmail, GitHub, Notion, Linear, Calendar and a few hundred others, through Composio. Click connect, sign in, done. No API keys to paste, no OAuth app to register.

Your Embers get those tools automatically. Ask one to go through your inbox and it just can.

## What else is in there

**Routines.** Say "every weekday at 8, check the overnight PRs and tell me what broke." It runs whether you're watching or not, and reports back where you asked it to.

**Skills that learn.** When an Ember works out a better way to do something you asked for twice, it writes it down. You review the change before it sticks. Nothing edits itself behind your back.

**A real browser.** Not a scraper. A browser your Embers drive, that you can take the wheel of mid-task when it gets stuck.

**Computers.** Give an Ember a sandboxed machine, or your own desktop, or a VPS. It clicks things.

**Your phone.** The iOS companion puts the roster in your pocket. Share a link or a file straight to an Ember from anywhere.

**Teams.** Point a group of Embers at a goal, cap the rounds so it can't run away, and let them work it out between them.

## Build it yourself

```bash
git clone https://github.com/FerroxLabs/murage.git
cd murage
pnpm install
pnpm dev          # UI on :5199
pnpm dev:server   # API on :8799
```

Node 24+ and pnpm 10+. `pnpm package:mac`, `package:win` or `package:linux` to build installers.

Ports are configurable with `MURAGE_PORT` and `MURAGE_UI_PORT` if something else already has them.

## Configuration

Everything lives in `~/.murage/config.json`.

Bring your own MCP servers by dropping them in, same shape Claude Code uses:

```json
{
  "mcpServers": {
    "notes": { "command": "npx", "args": ["-y", "@example/notes-mcp"] }
  }
}
```

Custom servers are never pre-approved. Their tools come through permission cards until you say otherwise. See [docs/custom-mcp-servers.md](docs/custom-mcp-servers.md).

## Contributing

Issues and pull requests welcome. Run `pnpm test` and `pnpm typecheck` before you open one.

## License

Apache 2.0. See [LICENSE](LICENSE).

Murage is a fork of [OpenMausBot](https://github.com/milind-soni/OpenMausBot) by Milind Soni, also Apache 2.0. Full attribution in [NOTICE](NOTICE). Go star his repo, he earned it.

We are not affiliated with the OpenMausBot project, and any bug you find in here is ours, not his.

---

<div align="center">

**[murage.ai](https://murage.ai)** · built by [Ferrox Labs](https://murage.ai)

</div>
