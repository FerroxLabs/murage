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
// MURAGE_VOICE_HOST_EVAL_VIA=xai runs the HOST on that xAI key instead of Flux
// (MURAGE_VOICE_HOST_MODEL picks the model).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runVoiceHostTurn, type VoiceHostState } from "./voice-host.ts";
import type { VoiceEndpoint } from "./voice-routes.ts";

const keyFile = process.env.MURAGE_VOICE_HOST_EVAL?.replace(/^~/, process.env.HOME ?? "");
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
  { said: "Fix the churn number in the Northwind deck.", state: IDLE, want: "hand" },
  { said: "Book me a table for two at eight tonight somewhere near the office.", state: IDLE, want: "hand" },
  { said: "Did Mark reply to my email about the contract?", state: IDLE, want: "hand" },
  { said: "Send the Q3 invoices.", state: IDLE, want: "hand" },
  { said: "How's it going?", state: BUSY, want: "answer" },
  { said: "Actually, stop that, never mind.", state: BUSY, want: "cancel" },
];

describe.skipIf(!keyFile)("voice host, live routing", () => {
  const xaiFile = process.env.MURAGE_VOICE_HOST_EVAL_XAI?.replace(/^~/, process.env.HOME ?? "");
  const fluxKey = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
  const xaiKey = xaiFile ? readFileSync(xaiFile, "utf8").trim() : "";
  const viaXai = process.env.MURAGE_VOICE_HOST_EVAL_VIA === "xai" && xaiKey;
  const host: VoiceEndpoint = viaXai
    ? { via: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", key: xaiKey, model: process.env.MURAGE_VOICE_HOST_MODEL || "grok-4-fast-non-reasoning" }
    : { via: "flux", label: "Flux", baseUrl: "https://api.fluxrouter.ai/v1", key: fluxKey, model: process.env.MURAGE_VOICE_HOST_MODEL || "claude-haiku-4-5" };
  const lookup: VoiceEndpoint | null = xaiKey
    ? { via: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", key: xaiKey, model: "grok-4-fast-non-reasoning" }
    : null;
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

  it("report", () => {
    console.log(`\nhost: ${host.via} ${host.model}, lookup: ${lookup ? lookup.via : "none"}\n${rows.join("\n")}`);
  });
});
