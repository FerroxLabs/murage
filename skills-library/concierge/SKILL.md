---
name: concierge
description: |
  Wayland's own how-to guide: explains what Wayland can do and gives the exact steps to operate it. Covers what can Wayland do, connecting an AI provider or model, creating an assistant, building and launching a workflow, setting up a team, scheduling a task, connecting an MCP server or outside tool, and switching models or using Flux Auto.
  Use when the user asks what Wayland can do, what features exist, how do I connect a provider or model, how do I add Claude or OpenAI or Gemini, how do I create or edit an assistant, how do I build or run a workflow, how do I set up a team of assistants, how do I schedule a task or set up a recurring job, how do I connect an MCP server or outside tool, or how do I switch models or turn on Flux Auto automatic model routing.
  Do NOT use when the user wants help with a non-Wayland task (writing, coding, research, document creation) — those have their own skills; this skill is only about operating Wayland itself.
license: Apache-2.0
metadata:
  author: foundry-skills
  version: '1.0.0'
  tags: 'wayland onboarding automation guide productivity'
  category: 'productivity'
  subcategory: 'automation'
  depends: ''
  disclaimer: 'none'
  difficulty: 'beginner'
---

# Concierge — How to Use Wayland

This skill is the front-desk knowledge for Wayland itself: what it can do, and the exact steps to do
each thing. Answer in plain language. Lead with the answer. For a "how do I…" question, give a short
numbered list of real steps, then end with **exactly one** concrete next step framed as an offer
("Want me to set that up?"). Never dump the full list of skills. Use the live capability summary for
real counts, model names, and connection status — never invent them.

## What can Wayland do?

Wayland is a desktop app for running AI on your terms. The headline things it does:

- **Assistants** — purpose-built helpers for specific jobs (documents, slide decks, book editing,
  roleplay, and more).
- **Your own models** — connect around a hundred AI providers (Claude, OpenAI, Gemini, and many more)
  with your own account, and switch between them freely.
- **Flux Auto** — picks the best model for each message automatically.
- **Skills** — a large library (over two thousand) of ready-made know-how an assistant pulls in when
  relevant. It surfaces on its own; nobody has to browse it.
- **Workflows** — ready-made, multi-step jobs Wayland runs end to end. Dozens are built in.
- **Teams** — several assistants working together on one job, handing work between each other.
- **Scheduled tasks** — Wayland does something on a timer, even while you're away.
- **Connected tools (MCP servers)** — plug in outside services so an assistant can actually use them.
- **Projects** — keep the files and context for one piece of work together.
- **Backends** — Wayland's built-in engine (Wayland Core), or outside coding agents (Claude Code,
  Codex, Gemini CLI).

Give a short tour grounded in the live summary — real counts, the providers they actually have
connected, a couple of concrete jobs they could hand off. Then: "Want me to show you any of these in
action?"

## Connect an AI provider or model

1. Open **Settings → Models** (the model/provider area).
2. Pick the provider you want (Claude, OpenAI, Gemini, or one of the others).
3. Sign in with that provider, or paste your own API key for it.
4. Save — Wayland verifies the connection and the provider's models become available to pick.

End with: "Want me to walk you through connecting [provider] right now?"

## Switch models / use Flux Auto

1. In a chat, open the **model picker** (the model name near the message box).
2. Pick any model from a provider you've connected — the change applies to that chat.
3. To stop choosing manually, select **Flux Auto** instead; Wayland then picks the best model per
   message for you.

End with: "Want me to turn on Flux Auto so you never have to pick again?"

## Create an assistant

1. Go to the **assistants** area and choose **New assistant**.
2. Give it a name and, in plain words, describe the job it's for.
3. Choose its model (or leave it on Flux Auto) and turn on any skills it should always have.
4. Save — it now shows up as its own helper you can chat with anytime.

End with: "Want me to set up an assistant for [their job] now?"

## Build and launch a workflow

1. Open the **workflows** area — browse the built-in ones or choose **New workflow**.
2. Pick a ready-made workflow that matches the job, or add the steps you want in order.
3. Fill in anything it asks for (a topic, a file, a destination).
4. **Run** it — Wayland carries out the steps start to finish and shows you the result.

End with: "Want me to launch a workflow for that right now?"

## Set up a team

1. Go to the **teams** area and choose **New team**.
2. Add the assistants that should work together, each on its part of the job.
3. Set who does what and in what order (e.g. research → draft → review).
4. Save and start the team — they hand work between each other to finish the whole job.

End with: "Want me to put together a team for [their job]?"

## Schedule a task

1. Open the **scheduled tasks** area and choose **New scheduled task**.
2. Choose what should happen (which assistant or workflow, and the instruction).
3. Set when and how often (e.g. every weekday at 8am).
4. Save — Wayland runs it on that timer, even when you're away.

End with: "Want me to schedule that for [time] so it runs on its own?"

## Connect an MCP server (outside tool)

1. Open **Settings → MCP / connected tools**.
2. Choose **Add server** and pick or paste the tool you want to connect.
3. Sign in or provide the access it needs, then enable it.
4. Wayland checks the connection and the tool's actions become available to your assistants. If it
   connects but shows zero tools, the tool isn't exposing any actions yet — re-check its setup.

End with: "Want me to walk you through connecting [tool] now?"

## Reminders for every answer

- Answer first, in plain words. No insider jargon — translate every Wayland term as you use it.
- Exactly one offer at the end. Never a menu, never zero.
- Use the live summary for real numbers and connection state; if you don't have it, say so and offer
  to check rather than guessing.
- Never paste the whole skills list — pick the few things that help this person.
