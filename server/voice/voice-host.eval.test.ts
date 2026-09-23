// Live routing eval for the voice host. Skipped unless MURAGE_VOICE_HOST_EVAL
// names a file holding a Flux key (the key is read, never printed). Each case
// is a spoken sentence and what the host must do with it: answer from the
// snapshot, hand it down, or cancel. The host's worst failure is answering
// something it cannot know, so every "hand" case is a question the snapshot
// does not answer.
//
//   MURAGE_VOICE_HOST_EVAL=~/.config/<key file> npx vitest run server/voice/voice-host.eval.test.ts
//
// MURAGE_VOICE_HOST_EVAL_XAI names a file holding an xAI key: lookups then run
// live through xAI's own web search (Flux's lookup route is not deployed yet).
// MURAGE_VOICE_HOST_EVAL_VIA=<provider> runs the HOST on that provider's own
// key instead of Flux, with the model voice-routes.ts would pick
// (MURAGE_VOICE_HOST_MODEL overrides it). xai reads the file above; anthropic,
// openai and groq read ~/.config/murage-test/<provider>.key. Lookups then use
// that provider's own web search when it has one, else xAI's.
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";

import { PROVIDER_PRESETS } from "../../electron/provider-connections.mjs";
import type { ProviderPreset } from "../../shared/provider-connections.ts";
import { runVoiceBrief, runVoiceHostTurn, type VoiceHostState } from "./voice-host.ts";
import { handDownResult } from "./hand-downs.ts";
import { voiceEndpoint, type VoiceEndpoint } from "./voice-routes.ts";

// the owner's real home: the test setup points HOME at a scratch folder
const home = (file: string | undefined) => file?.replace(/^~/, userInfo().homedir);
const keyFile = home(process.env.MURAGE_VOICE_HOST_EVAL);
const via = (process.env.MURAGE_VOICE_HOST_EVAL_VIA || "flux") as ProviderPreset;
const keyFiles: Partial<Record<ProviderPreset, string | undefined>> = {
  flux: keyFile,
  xai: home(process.env.MURAGE_VOICE_HOST_EVAL_XAI),
  ...Object.fromEntries((["anthropic", "openai", "groq"] as const).map((p) => [p, home(`~/.config/murage-test/${p}.key`)])),
};
const keyFor = (p: ProviderPreset) => {
  const file = keyFiles[p];
  return file && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
};

/** The route voice-routes.ts picks when `presets` are the only saved connections. */
function routeVia(part: "host" | "lookup", presets: ProviderPreset[]): VoiceEndpoint | null {
  const saved = presets.filter((p) => keyFor(p));
  return voiceEndpoint(part, {
    list: () => saved.map((p) => ({ id: p, preset: p, label: p, enabled: true })),
    resolve: (id) => ({ baseUrl: PROVIDER_PRESETS[id as ProviderPreset].baseUrl, key: keyFor(id as ProviderPreset), preset: id as ProviderPreset, label: id }),
  });
}
const NOW = Date.now();

const IDLE: VoiceHostState = {
  botName: "Sable",
  persona: "Chief of staff. Dry, brief, warm underneath. Calls the owner 'boss' now and then.",
  description: "Runs the owner's day: board, inbox, calendar, travel.",
  now: NOW,
  task: { title: "Morning board", busy: false, activity: [] },
  recent: [
    { who: "owner", text: "Pull today's board together.", at: NOW - 40 * 60_000 },
    {
      who: "bot",
      text: "Today's board: three meetings (10:00 investor call with Northwind, 13:00 hiring sync, 16:30 dentist). Two approvals waiting: the Bangkok flight and the Q3 invoice run. Revenue dashboard shows MRR at 182k, up 4 percent week on week. One risk: the Northwind deck still has last quarter's churn number.",
      at: NOW - 38 * 60_000,
    },
  ],
  otherTasks: [{ title: "Bangkok trip", at: NOW - 3 * 3_600_000 }],
  needsYou: [
    { title: "Approve flight", summary: "Thai Airways BKK, 14 Oct, 1,240 USD", at: NOW - 2 * 3_600_000 },
    { title: "Q3 invoice run", summary: "12 invoices ready to send", at: NOW - 3_600_000 },
  ],
};

/** The live call's state: an earlier news request already answered in the
 *  thread, then a failed attempt. */
const AFTER_NEWS: VoiceHostState = {
  ...IDLE,
  recent: [
    ...IDLE.recent,
    { who: "owner", text: "latest AI news today", at: NOW - 30 * 60_000 },
    { who: "bot", text: "Here's the latest AI news, with the well-sourced stories first. U.S. and China move toward a formal AI safety dialogue. Google shipped a native Gemini app for Windows.", at: NOW - 29 * 60_000 },
    { who: "owner", text: "I'd like the latest AI news", at: NOW - 60_000 },
    { who: "bot", text: "(That attempt failed and nothing is running: Grok CLI is not signed in)", at: NOW - 59_000 },
  ],
};

const BUSY: VoiceHostState = {
  ...IDLE,
  task: { title: "Morning board", busy: true, activity: ["searching the web", "reading northwind.com/investors", "drafting the summary"] },
};

type Expect = "answer" | "hand" | "lookup" | "cancel";
const CASES: Array<{ said: string; state: VoiceHostState; want: Expect }> = [
  { said: "Hey Sable, give me a quick summary of today's board.", state: IDLE, want: "answer" },
  { said: "What's my first meeting?", state: IDLE, want: "answer" },
  { said: "What's waiting on me?", state: IDLE, want: "answer" },
  { said: "Morning! How are you doing?", state: IDLE, want: "answer" },
  { said: "What are the benchmarks saying about Opus 5.5 versus GPT 6 Sol?", state: IDLE, want: "lookup" },
  { said: "Where did the S&P 500 close yesterday?", state: IDLE, want: "lookup" },
  // said on a live call, 2026-09-23
  { said: "I want to see what the latest AI news is.", state: IDLE, want: "lookup" },
  { said: "Well, AI news from the last 48 hours.", state: IDLE, want: "lookup" },
  { said: "I'd like the latest AI news from the last 72 hours.", state: AFTER_NEWS, want: "lookup" },
  { said: "Fix the churn number in the Northwind deck.", state: IDLE, want: "hand" },
  { said: "Book me a table for two at eight tonight somewhere near the office.", state: IDLE, want: "hand" },
  { said: "Did Mark reply to my email about the contract?", state: IDLE, want: "hand" },
  { said: "Send the Q3 invoices.", state: IDLE, want: "hand" },
  { said: "How's it going?", state: BUSY, want: "answer" },
  { said: "Actually, stop that, never mind.", state: BUSY, want: "cancel" },
];

const planned = routeVia("host", [via]);

describe.skipIf(!planned)("voice host, live routing", () => {
  // the body is collected even when skipped: no key means nothing to build
  if (!planned) return;
  const host: VoiceEndpoint = { ...planned, model: process.env.MURAGE_VOICE_HOST_MODEL || planned.model };
  // Flux's own lookup route is not deployed yet: Flux runs use xAI's search.
  const lookup = (via !== "flux" && routeVia("lookup", [via])) || routeVia("lookup", ["xai"]);
  const rows: string[] = [];

  for (const c of CASES) {
    it(`${c.want}: ${c.said}`, async () => {
      const start = performance.now();
      let first: number | null = null;
      let spoken = "";
      let did: Expect = "answer";
      let request = "";
      for await (const event of runVoiceHostTurn({ state: c.state, history: [], said: c.said, host, lookup })) {
        if (event.type === "error") throw new Error(`${event.reason}: ${event.message}`);
        if (first === null && (event.type === "sentence" || event.type === "hand_down" || event.type === "cancel")) first = performance.now() - start;
        if (event.type === "sentence") spoken += `${event.text} `;
        if (event.type === "hand_down") {
          if (did === "lookup") request += " (timed out, handed down)";
          did = did === "lookup" ? "lookup" : "hand";
          if (did === "hand") request = event.request;
        }
        if (event.type === "cancel") did = "cancel";
        if (event.type === "lookup") {
          did = "lookup";
          request = `lookup: ${event.query}`;
        }
      }
      const total = performance.now() - start;
      rows.push(`${did === c.want ? "ok  " : "MISS"} ${String(Math.round(first ?? total)).padStart(5)}ms first, ${String(Math.round(total)).padStart(5)}ms all | ${c.said}\n       said: ${spoken.trim() || "(nothing)"}${request ? `\n       hand_down: ${request}` : ""}`);
      expect(did).toBe(c.want);
    }, 30_000);
  }

  it("news asked again after it was handed down earlier on the call is looked up, not handed down again", async () => {
    let did = "answer";
    const history = [
      { role: "owner" as const, text: "I'd like the latest AI news" },
      { role: "host" as const, text: "Let me look into that.", handDown: { id: "h1", request: "I'd like the latest AI news" } },
      { role: "owner" as const, text: "Well are you doing it" },
      { role: "host" as const, text: "That didn't work. You've used all the included free usage for model grok-4.7 for now." },
    ];
    const results = { h1: handDownResult({ kind: "failed", reason: "You've used all the included free usage for model grok-4.7 for now." }) };
    for await (const event of runVoiceHostTurn({ state: AFTER_NEWS, history, results, said: "Well I need the news from the last 72 hours for AI.", host, lookup })) {
      if (event.type === "lookup") did = "lookup";
      else if (event.type === "hand_down" && did !== "lookup") did = "hand";
    }
    rows.push(`again | ${did}`);
    expect(did).toBe("lookup");
  }, 30_000);

  it("nonsense from a mishearing gets a request to repeat, not a promise", async () => {
    let spoken = "";
    let acted = false;
    for await (const event of runVoiceHostTurn({ state: BUSY, history: [], said: "Have your jam honey", host, lookup })) {
      if (event.type === "sentence") spoken += `${event.text} `;
      if (event.type === "hand_down" || event.type === "lookup" || event.type === "cancel") acted = true;
    }
    rows.push(`noise | said: ${spoken.trim()}`);
    expect(acted).toBe(false);
    expect(spoken).not.toMatch(/\bon it\b/i);
    expect(spoken).toMatch(/catch|again|repeat|say that|didn'?t get/i);
  }, 30_000);

  it("a misheard name is answered, not corrected", async () => {
    let spoken = "";
    for await (const event of runVoiceHostTurn({ state: IDLE, history: [], said: "Hey Sabel, how are you doing?", host, lookup })) {
      if (event.type === "sentence") spoken += `${event.text} `;
    }
    rows.push(`name  | said: ${spoken.trim()}`);
    expect(spoken).not.toMatch(/clarif|actually|it'?s sable|i'?m sable|my name/i);
  }, 30_000);

  it("after a refused hand-down, a progress question is answered honestly, not handed down again", async () => {
    let spoken = "";
    let handed = false;
    // as the app sends it: the hand-down is a tool call whose result says it failed
    const history = [
      { role: "owner" as const, text: "Well AI news from the last 48 hours" },
      { role: "host" as const, text: "Let me look into that.", handDown: { id: "h1", request: "AI news from the last 48 hours" } },
    ];
    const results = { h1: handDownResult({ kind: "failed", reason: "This bot's model needs an AI provider connected first." }) };
    for await (const event of runVoiceHostTurn({ state: IDLE, history, results, said: "Do you have any results yet?", host, lookup })) {
      if (event.type === "sentence") spoken += `${event.text} `;
      // a lookup is fine (it gets them the news now); a second hand-down of
      // the refused work is not
      if (event.type === "hand_down") handed = true;
    }
    rows.push(`refused | said: ${spoken.trim()}`);
    expect(handed).toBe(false);
    expect(spoken).toMatch(/nothing is running|couldn'?t start|didn'?t start|failed/i);
  }, 30_000);

  it("a long answer is told item by item, briefly", async () => {
    const answer = [
      "Here's the latest AI news, well-sourced stories first.",
      "## Today's biggest story",
      "**U.S. and China move toward a formal AI safety dialogue.** Reuters reports the two sides discussed an incident line for AI events that could rise to a national-security level. A follow-up meeting is planned in roughly two months in Shenzhen.",
      "## Product launches",
      "- **Google shipped a native Gemini app for Windows**, for Windows 10 and 11, with an Alt + Space hotkey.",
      "- **IBM and NASA released an open-source lunar foundation model** (Sept 10) on Hugging Face.",
      "- **Apple opened a public beta of its rebuilt, Gemini-powered Siri** (Sept 15).",
      "Want me to narrow this down, e.g. just the U.S.-China story?",
    ].join("\n\n");
    const sentences: string[] = [];
    for await (const event of runVoiceBrief({ state: IDLE, answer, host })) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "sentence") sentences.push(event.text);
    }
    rows.push(`brief | ${sentences.join(" ")}`);
    expect(sentences.length).toBeGreaterThan(0);
    // every item heard, not just that there is news
    const told = sentences.join(" ");
    for (const item of [/china/i, /gemini|windows/i, /nasa|lunar/i, /siri/i]) expect(told).toMatch(item);
    expect(sentences.length).toBeLessThanOrEqual(10);
    // ends by pointing at the chat, or with the answer's own question
    expect(told).toMatch(/chat|\?\s*$/i);
  }, 30_000);

  it("report", () => {
    console.log(`\nhost: ${host.via} ${host.model}, lookup: ${lookup ? lookup.via : "none"}\n${rows.join("\n")}`);
  });
});
