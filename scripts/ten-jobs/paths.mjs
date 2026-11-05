// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ten owner jobs as an owner walks them in THIS build: role + visible English
// name only (src/locales/en.json, en-ux/*.json and component literals), no test ids.
// Written against int/1015 (b47ece583). When a slice changes a screen, the slice
// updates its job here in the same change; the verdict records this file's hash.
//
// Step: { kind: "click" | "key" | "type", role + name | label | placeholder | text,
//         value | secret | valueFrom(ctx), option (a native select choice), decision, optional, waitMs }
// - optional: a screen that only some machines get (skipped when absent, never counted).
// - The plan's target paths (UX-OVERHAUL-BUILD-PLAN.md section 5) are shorter; a job that
//   walks longer here fails over budget until its slice lands. That is the gate working.
// End: { role + name | text | probe(ctx) -> true | "why not yet", ms, what }.

const OWNER = "Gate Owner";
const replyIn = (b) => (b?.messages ?? []).some((m) => ["assistant", "bot"].includes(m.role) && String(m.text ?? "").trim().length > 0);
const bots = async (ctx) => (await ctx.api("GET", "/api/bots")).body?.bots ?? [];
const rememberBots = async (ctx) => { ctx.state.botsBefore = new Set((await bots(ctx)).map((b) => b.id)); };
const pendingCard = (b) => (b?.messages ?? []).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);

export const PHONE_BUTTON = /^(Checking phone status|Phone status unavailable|Phone access off|Pair a phone|Phone connected|Phone paired: not connected|Phone active recently|Phone paired: not recently active|\d+ phones connected|\d+ of \d+ phones connected|\d+ phones paired: none connected|\d+ phones active recently|\d+ of \d+ phones active recently|\d+ phones paired: none recently active)$/;

export const PATHS = [
  {
    id: 0, // First run: terms, Hello, Flux Router key, first job. Fuigo is in the box; the key connects Flux Router.
    path: [
      { kind: "click", role: "checkbox", name: /I am 18 or older/, waitMs: 60000 },
      { kind: "click", role: "button", name: "Accept and continue", exact: true },
      { kind: "type", role: "textbox", name: "Your name", exact: true, value: OWNER, waitMs: 60000 },
      { kind: "click", role: "button", name: "Continue", exact: true },
      { kind: "click", role: "button", name: "Next", exact: true, optional: true, waitMs: 20000 },
      { kind: "type", label: "Your Flux Router key", secret: "fluxKey", waitMs: 60000 },
      { kind: "click", role: "button", name: "Connect Flux Router", exact: true },
      { kind: "click", role: "button", name: /Brief me every morning/, decision: true, waitMs: 60000 },
    ],
    end: { what: "first real result", ms: 300000, probe: async (ctx) => ((await bots(ctx)).some(replyIn) ? true : "no bot reply yet") },
  },
  {
    id: 1, // Create a bot and get its first reply.
    setup: rememberBots,
    path: [
      { kind: "click", role: "button", name: "New or share", exact: true },
      { kind: "click", role: "button", name: "New Bot", exact: true },
      { kind: "click", role: "button", name: /^Start blank/, decision: true },
      { kind: "type", role: "textbox", name: /^Message /, value: "Hello. Reply with one short line that includes the word TENJOBS.", submit: true, waitMs: 20000 },
    ],
    end: {
      what: "the new bot's first reply", ms: 300000,
      probe: async (ctx) => { const fresh = (await bots(ctx)).filter((b) => !ctx.state.botsBefore?.has(b.id)); if (!fresh.length) return "no new bot"; ctx.state.newBot = fresh[0]; return fresh.some(replyIn) ? true : "new bot has not replied"; },
    },
  },
  {
    id: 2, // Connect Gmail: stops at the account label, before the browser opens Google (never automate a Google login).
    path: [
      { kind: "click", role: "button", name: new RegExp(OWNER) },
      { kind: "click", role: "menuitem", name: "Connected apps", exact: true },
      // TENJOBS-APP-GAPS: Gmail leads the common apps, so its Connect is the first one, no search.
      { kind: "click", role: "button", name: "Connect", exact: true },
    ],
    end: { what: "Gmail account step", role: "textbox", name: "Label for the new Gmail account" },
  },
  {
    id: 3, // Morning routine: every weekday at 8, send me a brief.
    path: [
      { kind: "click", role: "button", name: "Routines", exact: true },
      { kind: "click", role: "button", name: "Create", exact: true },
      { kind: "click", role: "button", name: "More options", exact: true },
      { kind: "type", placeholder: "Add title", value: "Morning brief" },
      { kind: "type", label: "Start time", value: "08:00" },
      { kind: "click", role: "combobox", name: "Repeat", option: "Every weekday (Monday to Friday)", decision: true },
      { kind: "type", placeholder: "Add instructions for the bot", value: "Send me a brief of my day." },
      { kind: "click", role: "button", name: "Schedule routine", exact: true },
    ],
    end: { what: "routine listed", text: "Morning brief" },
  },
  {
    id: 4, // Approve or deny: a real Fuigo turn asks to write a file (Ask level), the owner answers from Needs you.
    setup: async (ctx) => {
      const b = ctx.state.newBot ?? (await bots(ctx))[0]; if (!b) throw new Error("no bot to ask");
      const r = await ctx.api("POST", `/api/bots/${b.id}/messages`, { text: "Run this shell command and tell me what it printed: echo tenjobs-approval", threadId: b.threadId });
      if (r.status !== 202) throw new Error(`asker turn not accepted ${r.status}`);
      const end = Date.now() + 240000;
      while (Date.now() < end) { const cur = (await bots(ctx)).find((x) => x.id === b.id); const c = pendingCard(cur); if (c) { ctx.state.card = { botId: b.id, requestId: c.card.requestId }; return; } await ctx.sleep(3000); }
      throw new Error("the asker turn raised no approval card in 240 s");
    },
    // Needs you lists the card with its own Allow once / Deny (seen on the 1.0.14 package, run 2 screenshot).
    path: [
      { kind: "click", role: "button", name: /^Needs you, \d+ waiting/ },
      { kind: "click", role: "button", name: /^(Allow once|Allow|Run|Send|Confirm)$/, decision: true },
    ],
    end: {
      what: "card resolved", ms: 30000,
      probe: async (ctx) => { const b = (await bots(ctx)).find((x) => x.id === ctx.state.card?.botId); const m = (b?.messages ?? []).find((x) => x.card?.requestId === ctx.state.card?.requestId); return m && (m.card.answered || m.card.dismissed) ? true : "card still open"; },
    },
  },
  {
    id: 5, // Change a level: the composer chip to Full access, confirmed.
    // Start state, not a step: the owner is in a chat with a bot that has nothing waiting (the chip is off on the
    // start screen and while a card waits). Opened by its sidebar row before the walk starts.
    setup: async (ctx) => {
      const all = await bots(ctx);
      const pick = [ctx.state.newBot && all.find((b) => b.id === ctx.state.newBot.id), ...all].find((b) => b && !pendingCard(b));
      if (!pick) throw new Error("no bot without a waiting card to open");
      const name = pick.name ?? pick.displayName; const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const row = ctx.page.getByRole("button", { name: new RegExp(`^${esc}\\b`) });
      // Measured, no scrolling: if the row is not on screen the job fails rather than being scrolled to.
      await ctx.setupClick((await row.count()) ? row : ctx.page.getByText(name, { exact: true }), `the sidebar row for ${name}`);
      await ctx.sleep(1500);
    },
    path: [
      { kind: "click", role: "button", name: /^(Ask for approval|Auto)\b/ },
      { kind: "click", role: "menuitemradio", name: /^Full access/, decision: true },
      { kind: "click", role: "button", name: "Use Full access", exact: true },
    ],
    end: { what: "chip reads Full access", role: "button", name: /^Full access\b/ },
  },
  {
    id: 6, // Find a setting from the palette.
    path: [
      { kind: "key", chord: "ControlOrMeta+K", help: true },
      { kind: "type", placeholder: /^Search bots, channels, messages, settings/, value: "working folder" },
      { kind: "key", chord: "Enter" },
    ],
    end: {
      what: "Working folder control focused", ms: 8000,
      probe: async (ctx) => (await ctx.page.evaluate(() => { const a = document.activeElement; if (!a || a === document.body) return false; let n = a; for (let i = 0; i < 6 && n; i++, n = n.parentElement) if (/working folder/i.test(n.textContent || "") && n.textContent.length < 600) return true; return false; })) || "focus is not on the Working folder control",
    },
  },
  {
    id: 7, // Connect Telegram: token in, pairing code shown. A made-up token; on the Linux rig api.telegram.org is
    // answered by the local stand-in (rig/stand-ins/proxy.mjs), so Telegram is never called for real.
    path: [
      { kind: "click", role: "button", name: "App settings", exact: true },
      { kind: "click", role: "button", name: "Messaging apps", exact: true },
      { kind: "type", label: "Bot token", value: "123456789:AAtenjobsGateTokenNotARealOne000000" },
      // TENJOBS-APP-GAPS: the token field takes the cursor and Save token goes straight on to the pairing code.
      { kind: "click", role: "button", name: "Save token", exact: true },
    ],
    end: { what: "pairing code shown", text: "/pair" },
  },
  {
    id: 8, // Understand a cost.
    path: [
      { kind: "click", role: "button", name: "App settings", exact: true },
      { kind: "click", role: "button", name: "Usage", exact: true },
    ],
    end: { what: "this month by bot", text: "This month by bot" },
  },
  {
    id: 9, // Pair the phone. On the Linux rig a stand-in Tailscale CLI (rig/stand-ins/tailscale) is on PATH.
    path: [
      // TENJOBS-APP-GAPS: the sidebar's own phone button (SidebarPhoneButton) opens the same Phone page in one click.
      // Every label SidebarPhoneButton can show (deriveSidebarPhoneStatus), so the walk never misses it mid-check.
      { kind: "click", role: "button", name: PHONE_BUTTON },
      { kind: "click", role: "switch", name: "Turn on: Phone and other devices", exact: true },
      { kind: "click", role: "button", name: "Serve on my tailnet", exact: true },
    ],
    end: { what: "QR code visible", text: "Scan it, or type the code" },
  },
  {
    id: 10, // Start a chat with the right bot from the palette.
    setup: async (ctx) => { const b = ctx.state.newBot ?? (await bots(ctx)).at(-1); ctx.state.target = b?.name ?? b?.displayName ?? null; },
    path: [
      { kind: "key", chord: "ControlOrMeta+K", help: true },
      { kind: "type", placeholder: /^Search bots, channels, messages, settings/, valueFrom: (ctx) => ctx.state.target },
      { kind: "key", chord: "Enter" },
    ],
    end: {
      what: "that bot's chat, composer focused", ms: 8000,
      probe: async (ctx) => (await ctx.page.evaluate((name) => { const a = document.activeElement; return Boolean(a && name && (a.getAttribute("aria-label") || "") === `Message ${name}`); }, ctx.state.target)) || "composer for that bot not focused",
    },
  },
];
