// The 0.1.59 call flow, driven end to end in a real browser with the native
// dictation helper and the store faked, and the REAL speaker and voice-host
// client. The harness routes are page routes, so nothing here touches a
// server, a key or a data directory.
import { test, expect, type Page, type Route } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;

/** The "microphone" Chromium plays into getUserMedia: 1.5 s of a loud tone
 *  (speech energy for the voice detector), then 4 s of silence, looped.
 *  Generated here so the spec runs the same on macOS, Linux and Windows. */
const FAKE_MIC = join(mkdtempSync(join(tmpdir(), "murage-call-mic-")), "mic.wav");
{
  const rate = 16_000;
  const samples = Math.round(5.5 * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const v = i < 1.5 * rate ? Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767 : 0;
    wav.writeInt16LE(Math.round(v), 44 + i * 2);
  }
  writeFileSync(FAKE_MIC, wav);
}
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${FAKE_MIC}`],
  },
});

// The fake store keeps the bot on window so the test can change it, and
// records every dispatched action. The fake bridge lets the test say things.
const STORE = `
import { useSyncExternalStore } from "react";
const listeners = new Set();
window.__bot = { id: "bot-1", name: "Sable", color: "green", busy: false, threadId: "thread-1", voice: "v1", messages: [] };
window.__actions = [];
window.__config = { flux: { configured: true }, tts: { configured: true, ready: true, routes: { host: "flux", lookup: "flux", speech: "flux", transcribe: "flux" } } };
window.__setBot = (patch) => { window.__bot = { ...window.__bot, ...patch }; for (const l of listeners) l(); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
export const visibleMessages = (bot) => bot.messages;
const dispatch = (a) => {
  window.__actions.push(a);
  // the harness refusing a send, as it does for a bot with no model connected
  if (a.type === "send" && window.__refuseSends) setTimeout(() => a.onError?.(new Error(window.__refuseSends)), 20);
  // the harness failing to save a decision
  if (a.type === "decideRequest" && window.__refuseDecisions) setTimeout(() => a.onError?.(window.__refuseDecisions), 20);
};
export const useStore = () => ({ state: { config: window.__config }, dispatch });
export const api = async () => ({});
export const useFixtureBot = () => useSyncExternalStore(subscribe, () => window.__bot);
`;
const BRIDGE = `
window.__speech = { starts: 0, stops: 0, onText: null, onEnd: null, fed: 0, options: [] };
window.muragebox = {
  desktopSurfaceSecret: "fixture-surface-secret",
  speechStart: async (options) => { window.__speech.starts += 1; window.__speech.running = true; window.__speech.options.push(options); },
  speechFeed: (bytes) => { window.__speech.fed += bytes.byteLength; },
  speechStop: async () => { window.__speech.stops += 1; window.__speech.running = false; },
  onSpeechTranscript: (fn) => { window.__speech.onText = fn; return () => {}; },
  onSpeechEnd: (fn) => { window.__speech.onEnd = fn; return () => {}; },
};
// Like Apple's recognizer in the helper: words arrive only while a session
// runs, and the session ends by itself after each finished sentence.
window.__say = (text, partial = false) => {
  if (!window.__speech.running) { window.__speech.missed = (window.__speech.missed || 0) + 1; return; }
  window.__speech.onText?.({ text, partial });
  if (!partial) { window.__speech.running = false; setTimeout(() => window.__speech.onEnd?.({ code: 0, reason: "completed" }), 10); }
};
// Headless audio: every clip "plays" for __clipMs and ends; pause() holds
// the rest of it, play() carries on.
window.__clipMs = 60;
window.__pauses = 0;
const clips = new WeakMap();
HTMLMediaElement.prototype.play = function () {
  const clip = clips.get(this) ?? { left: window.__clipMs };
  clip.at = Date.now();
  clip.playing = true;
  clip.timer = setTimeout(() => { clip.playing = false; this.onended?.(); }, clip.left);
  clips.set(this, clip);
  return Promise.resolve();
};
HTMLMediaElement.prototype.pause = function () {
  const clip = clips.get(this);
  if (!clip?.playing) return;
  clearTimeout(clip.timer);
  clip.left -= Date.now() - clip.at;
  clip.playing = false;
  window.__pauses += 1;
};
Object.defineProperty(HTMLMediaElement.prototype, "paused", { get() { return !clips.get(this)?.playing; } });
`;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-call-host-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] },
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "call-host-fixture", enforce: "pre",
      resolveId(id) {
        const map: Record<string, string> = { "@/state/store": "store", "@/lib/call": "call", "@/lib/push-to-talk": "push", "@/components/DesktopCapabilities": "caps" };
        for (const [alias, key] of Object.entries(map)) if (id === alias || id.endsWith("/src/" + alias.slice(2))) return "\0host-" + key;
        // CallView imports it by a relative path
        if (id === "./DesktopCapabilities") return "\0host-caps";
        // Silero: the fake mic plays a tone, not speech. Sound counts as
        // speech unless the page says it is noise (window.__vadNoise).
        if (id === "./silero-vad") return "\0host-vad";
        if (id === "/__call.js") return "\0host-entry";
      },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id === "\0host-store") return STORE;
        if (id === "\0host-call") return `export const useOnCall=()=>"bot-1";export const currentCall=()=>"bot-1";export const deferCallCleanup=()=>{};export const endCall=()=>{};export const startCall=()=>{};`;
        if (id === "\0host-push") return `export const usePushToTalk=()=>false;`;
        if (id === "\0host-vad") return `export const SPEECH_CONFIDENCE=0.7;export class SileroVad{static async load(){return new SileroVad()}async push(f){window.__vadFrames=(window.__vadFrames||0)+1;let s=0;for(const x of f)s+=x*x;const loud=Math.sqrt(s/f.length)>0.01;if(window.__vadNoise)return 0;if(window.__vadSparse)return window.__vadFrames%6===0?1:0;return new URLSearchParams(location.search).get("os")==="linux"?(loud?1:0):1}reset(){}}`;
        // a Mac (on-device dictation) unless the page says otherwise
        if (id === "\0host-caps") return `export const useDesktopCapabilities=()=>({ready:true,capabilities:{dictation:{available:new URLSearchParams(location.search).get("os")!=="linux"},host:{platform:"darwin"}}});`;
        if (id !== "\0host-entry") return;
        return `
import React from "react"; import { createRoot } from "react-dom/client";
import { useFixtureBot } from "@/state/store"; import { CallOverlay } from "/src/components/CallView.tsx"; import "/src/styles.css";
function Fixture() { const bot = useFixtureBot(); return React.createElement(CallOverlay, { bot }); }
createRoot(document.getElementById("root")).render(React.createElement(Fixture));`;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__call") return next();
          res.setHeader("content-type", "text/html");
          // the bridge is the preload's: it exists before any app module runs
          res.end(`<div id="root"></div><script>${BRIDGE}</script><script type="module" src="/__call.js"></script>`);
        });
      },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

type HostReply = Array<Record<string, unknown>>;

/** 50 ms of silence as a real WAV, so the element decodes it instead of
 *  firing `error` (which the speaker rightly treats as a failed clip). */
function silentWav(): Buffer {
  const samples = 1200;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

async function harness(page: Page, os: "mac" | "linux" = "mac") {
  const spoken: string[] = [];
  const hostBodies: any[] = [];
  const replies: HostReply[] = [];
  const h = { delayMs: 0 };
  await page.route("**/api/tts/speak", async (route: Route) => {
    spoken.push(JSON.parse(route.request().postData() ?? "{}").text);
    await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
  });
  await page.route("**/api/tts/prepare", async (route: Route) => {
    const text = JSON.parse(route.request().postData() ?? "{}").text;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ready: true, utterances: [text] }) });
  });
  // The real harness serves the call routes to the desktop app only, and
  // refuses them without the per-launch proof: so does this fake.
  const desktop = (route: Route) => {
    const headers = route.request().headers();
    return headers["x-murage-surface"] === "desktop" && headers["x-murage-surface-secret"] === "fixture-surface-secret";
  };
  await page.route("**/api/bots/bot-1/voice-host", async (route: Route) => {
    if (!desktop(route)) return route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"desktop only"}' });
    const body = JSON.parse(route.request().postData() ?? "{}");
    hostBodies.push(body);
    if (body.warm) return route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
    if (h.delayMs) await new Promise((r) => setTimeout(r, h.delayMs));
    const events = replies.shift() ?? [{ type: "done" }];
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
  });
  const transcribed: number[] = [];
  const heard: string[] = [];
  await page.route("**/api/voice/transcribe", async (route: Route) => {
    transcribed.push(route.request().postDataBuffer()?.byteLength ?? 0);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ text: heard.shift() ?? "" }) });
  });
  await page.goto(`${origin}/__call?os=${os}`);
  await expect(page.locator('button[aria-label="Hang up"]')).toBeVisible();
  // the microphone opens asynchronously; a Mac call is ready once the
  // recognizer has been started
  if (os === "mac") await expect.poll(() => page.evaluate(() => (window as any).__speech.starts)).toBeGreaterThan(0);
  // and Silero has judged some audio (in the app the recognizer is fed only
  // audio Silero has already judged, so words never arrive before it)
  await expect.poll(() => page.evaluate(() => (window as any).__vadFrames ?? 0)).toBeGreaterThan(0);
  return Object.assign(h, { spoken, hostBodies, replies, transcribed, heard });
}

const actions = (page: Page) => page.evaluate(() => (window as any).__actions as Array<Record<string, any>>);
const starts = (page: Page) => page.evaluate(() => (window as any).__speech.starts as number);

test("the host answers first, hands work down through the ordinary send, and keeps listening while the engine works", async ({ page }, info) => {
  const h = await harness(page);
  await expect.poll(() => h.hostBodies.some((b) => b.warm)).toBe(true);

  // 1. answered by the host, spoken sentence by sentence, nothing sent
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "sentence", text: "Two approvals are waiting." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect.poll(() => h.spoken).toEqual(["Three meetings today.", "Two approvals are waiting."]);
  // listening again, with a recognizer session running for the owner
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__speech.running)).toBe(true);
  expect(await actions(page)).toEqual([]);
  expect(h.hostBodies.at(-1)).toMatchObject({ text: "What's on the board?", threadId: "thread-1", history: [] });

  // 2. handed down: the request is an ordinary send; the host's line is spoken
  h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "Book a table for two at 8pm" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Book me a table for two at eight"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "send", botId: "bot-1", text: "Book a table for two at 8pm", threadId: "thread-1" });
  await expect.poll(() => h.spoken.at(-1)).toBe("Let me look into that.");
  expect(h.hostBodies.at(-1).history).toEqual([
    { role: "owner", text: "What's on the board?" },
    { role: "host", text: "Three meetings today. Two approvals are waiting." },
  ]);

  // 3. the engine works: the mic stays open and the activity line shows the step
  const listening = await starts(page);
  await page.evaluate(() => (window as any).__setBot({ busy: true, messages: [{ id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } }] }));
  await expect(page.getByText("Searching the web")).toBeVisible();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("working-listening.png") });
  expect(await starts(page)).toBeGreaterThanOrEqual(listening);

  // 4. the engine's answer lands while the owner is mid-sentence: held until
  //    the owner's turn and the host's reply are done, then spoken
  await page.evaluate(() => (window as any).__say("how's it", true));
  await page.evaluate(() => (window as any).__setBot({ busy: false, messages: [
    { id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } },
    { id: "r1", role: "bot", kind: "text", at: 2, text: "Booked Nara at 8pm for two." },
  ] }));
  await page.waitForTimeout(300);
  expect(h.spoken).not.toContain("Booked Nara at 8pm for two.");
  h.replies.push([{ type: "sentence", text: "Still on it." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("how's it going?"));
  await expect.poll(() => h.spoken.slice(-2)).toEqual(["Still on it.", "Booked Nara at 8pm for two."]);
});

test("a Flux account without the capability falls back to the engine for the rest of the call", async ({ page }) => {
  const h = await harness(page);
  h.replies.push([{ type: "error", reason: "premium", message: "Fast replies on calls need a paid Flux plan." }]);
  await page.evaluate(() => (window as any).__say("Check my mail"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "send", text: "Check my mail" });
  const hostCalls = h.hostBodies.filter((b) => !b.warm).length;
  // the next turn goes straight to the engine, without asking the host again
  await page.evaluate(() => (window as any).__setBot({ busy: true }));
  await page.evaluate(() => (window as any).__setBot({ busy: false }));
  await page.evaluate(() => (window as any).__say("And the calendar"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "send", text: "And the calendar" });
  expect(h.hostBodies.filter((b) => !b.warm).length).toBe(hostCalls);
});

test("a long answer from the engine is told as a brief, and a failed brief reads the answer out", async ({ page }) => {
  const h = await harness(page);
  const long = `## Today's AI news\n\n${"- A long bullet about a launch that goes on for a while. ".repeat(12)}`;
  h.replies.push([{ type: "sentence", text: "Three big stories today." }, { type: "sentence", text: "The full version is in the chat." }, { type: "done" }]);
  await page.evaluate((text) => (window as any).__setBot({ messages: [{ id: "n1", role: "bot", kind: "text", at: 1, text }] }), long);
  await expect.poll(() => h.spoken).toEqual(["Three big stories today.", "The full version is in the chat."]);
  expect(h.hostBodies.filter((b) => !b.warm).at(-1)).toMatchObject({ brief: true, text: long, threadId: "thread-1" });

  // the fast model is unreachable: the owner still hears the answer. It
  // lands while the brief is still being told, so it waits its turn.
  h.spoken.length = 0;
  h.replies.push([{ type: "error", reason: "upstream", message: "down" }]);
  const second = long.replace("Today's", "Tonight's");
  await page.evaluate((text) => (window as any).__setBot({ messages: [{ id: "n2", role: "bot", kind: "text", at: 2, text }] }), second);
  await expect.poll(() => h.spoken.join(" ")).toContain("Tonight's AI news");

  // a short answer is read as written, without asking the host
  h.spoken.length = 0;
  const asked = h.hostBodies.length;
  await page.evaluate(() => (window as any).__setBot({ messages: [{ id: "n3", role: "bot", kind: "text", at: 3, text: "Booked Nara at 8pm for two." }] }));
  await expect.poll(() => h.spoken).toEqual(["Booked Nara at 8pm for two."]);
  expect(h.hostBodies.length).toBe(asked);
});

test("a hand-down the harness refuses is said out loud, and the host is told nothing is running", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => { (window as any).__refuseSends = "This bot's model needs an AI provider connected first."; });
  h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "AI news from the last 48 hours" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("AI news from the last 48 hours"));
  await expect.poll(() => h.spoken).toContain("I couldn't start that. This bot's model needs an AI provider connected first.");
  h.replies.push([{ type: "sentence", text: "Nothing is running yet." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Do you have any results yet?"));
  await expect.poll(() => h.spoken.at(-1)).toBe("Nothing is running yet.");
  // the host is told through the hand-down itself, in order, not by a stray line
  const last = h.hostBodies.at(-1);
  expect(last.history).toEqual([
    { role: "owner", text: "AI news from the last 48 hours" },
    { role: "host", text: "Let me look into that.", handDown: { id: expect.any(String), request: "AI news from the last 48 hours" } },
  ]);
  expect(last.handDowns).toEqual([
    { id: last.history[1].handDown.id, request: "AI news from the last 48 hours", at: expect.any(Number), state: "refused", reason: "This bot's model needs an AI provider connected first." },
  ]);
});

test("a handed-down turn that fails is said out loud, not left running in silence", async ({ page }) => {
  const h = await harness(page);
  h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "AI news from the last 72 hours" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("AI news from the last 72 hours"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "send" });
  await page.evaluate(() => (window as any).__setBot({ busy: false, messages: [
    { id: "e1", role: "bot", kind: "activity", at: 5, tool: { name: "error: Grok CLI is not signed in", ok: false, errorDetails: "Grok CLI is not signed in, run grok login in a terminal" } },
  ] }));
  await expect.poll(() => h.spoken).toContain("That didn't work. Grok CLI is not signed in, run grok login in a terminal.");
  h.replies.push([{ type: "sentence", text: "Nothing is running." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Are you doing it?"));
  await expect.poll(() => h.hostBodies.at(-1).history).toContainEqual({ role: "host", text: "That didn't work. Grok CLI is not signed in, run grok login in a terminal." });
});

test("while the engine works and the call is quiet, the bot says what it is doing, now and then", async ({ page }) => {
  await page.clock.install();
  const h = await harness(page);
  h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "Research flights to Bangkok" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Research flights to Bangkok"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "send" });
  await page.clock.runFor(500);
  await page.evaluate(() => (window as any).__setBot({ busy: true, messages: [{ id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebFetch", spoken: "reading a page" } }] }));
  await page.clock.runFor(8_000);
  expect(h.spoken).not.toContain("Still on it: reading a page.");
  await page.clock.runFor(8_000);
  await expect.poll(() => h.spoken).toContain("Still on it: reading a page.");
  // capped: not every second
  await page.clock.runFor(10_000);
  expect(h.spoken.filter((s) => s.startsWith("Still on it")).length).toBe(1);
});

test("an approval is asked in plain words, and a question about it goes to the host, never deciding it", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__setBot({ busy: true, messages: [
    { id: "ap1", role: "bot", kind: "options", at: 1, card: { tool: "other", subtitle: "Agents_web_search", requestId: "req-1", options: ["Allow", "Deny"] } },
  ] }));
  // the first approval of a call also offers a yes for the rest of the call
  await expect.poll(() => h.spoken).toContain("Can I search the web? Say yes, no, or yes for the rest of the call.");
  h.replies.push([{ type: "sentence", text: "It wants to search for this week's AI news. Yes or no?" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What is it searching for?"));
  await expect.poll(() => h.spoken.at(-1)).toBe("It wants to search for this week's AI news. Yes or no?");
  expect(h.hostBodies.at(-1)).toMatchObject({ text: "What is it searching for?", approval: "Can I search the web? Yes or no." });
  expect((await actions(page)).some((a) => a.type === "decideRequest")).toBe(false);
  await page.evaluate(() => (window as any).__say("Yes"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "allow" });
});

test("a yes for the rest of the call, said any way, answers every ordinary request until hang-up", async ({ page }) => {
  const h = await harness(page);
  const card = (id: string, subtitle: string, tool = "Local computer approval") => ({ id, role: "bot", kind: "options", at: 1, card: { tool, subtitle, requestId: `req-${id}`, options: ["Allow", "Deny"] } });
  await page.evaluate((c) => (window as any).__setBot({ busy: true, messages: [c] }), card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other"));
  await expect.poll(() => h.spoken.at(-1)).toBe("Can I look up which app tools to use? Say yes, no, or yes for the rest of the call.");
  // heard live: not "yes" first, so it used to be neither yes nor no
  await page.evaluate(() => (window as any).__say("I'll allow it for the rest of the call"));
  await expect.poll(async () => (await actions(page)).filter((a) => a.type === "decideRequest").length).toBe(1);
  await expect.poll(() => h.spoken.at(-1)).toBe("Okay. I won't ask again until you hang up.");
  const spokenBefore = h.spoken.length;

  // other kinds of request too (heard live: the script and the connected
  // apps were each asked again): allowed without a word
  const answered = { ...card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other"), card: { ...card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other").card, answered: "allow" } };
  await page.evaluate((cards) => (window as any).__setBot({ busy: true, messages: cards }), [answered, card("a2", 'python3 -c "import json"', "shell")]);
  await expect.poll(async () => (await actions(page)).filter((a) => a.type === "decideRequest").map((a) => a.requestId)).toEqual(["req-a1", "req-a2"]);
  await page.evaluate((cards) => (window as any).__setBot({ busy: true, messages: cards }), [card("a3", "composio__COMPOSIO_MULTI_EXECUTE_TOOL", "other")]);
  await expect.poll(async () => (await actions(page)).filter((a) => a.type === "decideRequest").map((a) => a.requestId)).toEqual(["req-a1", "req-a2", "req-a3"]);
  await page.waitForTimeout(300);
  expect(h.spoken.length).toBe(spokenBefore);
});

test("an approval allowed for the call that fails to save is asked aloud, not left waiting", async ({ page }) => {
  const h = await harness(page);
  const card = (id: string, subtitle: string, tool: string) => ({ id, role: "bot", kind: "options", at: 1, card: { tool, subtitle, requestId: `req-${id}`, options: ["Allow", "Deny"] } });
  await page.evaluate((c) => (window as any).__setBot({ busy: true, messages: [c] }), card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other"));
  await expect.poll(() => h.spoken.at(-1)).toContain("Say yes, no, or yes for the rest of the call.");
  await page.evaluate(() => (window as any).__say("yes for the rest of the call"));
  await expect.poll(() => h.spoken.at(-1)).toBe("Okay. I won't ask again until you hang up.");
  await page.evaluate(() => { (window as any).__refuseDecisions = "the request is no longer open"; });
  await page.evaluate((c) => (window as any).__setBot({ busy: true, messages: [c] }), card("a2", 'python3 -c "import json"', "shell"));
  await expect.poll(() => h.spoken.at(-1)).toBe("I couldn't allow that on my own. Can I run a small script on your computer? Yes or no.");
});

test("a yes that does not start with yes still answers the approval", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__setBot({ busy: true, messages: [
    { id: "ap1", role: "bot", kind: "options", at: 1, card: { tool: "other", subtitle: "Agents_web_search", requestId: "req-1", options: ["Allow", "Deny"] } },
  ] }));
  await expect.poll(() => h.spoken).toContain("Can I search the web? Say yes, no, or yes for the rest of the call.");
  await page.evaluate(() => (window as any).__say("You can go ahead"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "allow" });
  expect(h.hostBodies.some((b) => b.text === "You can go ahead")).toBe(false);
});

test("cancel from the host stops the running turn", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__setBot({ busy: true }));
  h.replies.push([{ type: "sentence", text: "Stopping that." }, { type: "cancel" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("never mind, stop"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "interrupt", botId: "bot-1", threadId: "thread-1" });
  await expect.poll(() => h.spoken).toContain("Stopping that.");
  // the stopped work still writes a reply: it stays in the chat, unspoken
  await page.evaluate(() => (window as any).__setBot({ busy: false, messages: [{ id: "late", role: "bot", kind: "text", at: Date.now(), text: "Here is the half-finished report." }] }));
  await page.waitForTimeout(500);
  expect(h.spoken).not.toContain("Here is the half-finished report.");
});

test("on a Mac the recognizer is fed the echo-cancelled microphone and the owner can talk over the bot", async ({ page }) => {
  const h = await harness(page);
  await expect.poll(() => page.evaluate(() => (window as any).__speech.options.at(-1))).toMatchObject({ fed: true, hints: ["Sable"] });
  await expect.poll(() => page.evaluate(() => (window as any).__speech.fed)).toBeGreaterThan(16_000);

  // a long answer; the owner cuts in two words into it
  await page.evaluate(() => ((window as any).__clipMs = 5_000));
  h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "sentence", text: "It goes on." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  const startsBefore = await starts(page);
  await page.evaluate(() => (window as any).__say("wait", true)); // one word: could be a cough
  await page.waitForTimeout(200);
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  await page.evaluate(() => (window as any).__say("wait actually", true)); // the owner
  await expect(page.getByText("wait actually")).toBeVisible();
  // the recognizer kept running through the bot's speech: no restart needed
  expect(await starts(page)).toBe(startsBefore);
  h.replies.push([{ type: "sentence", text: "Sure." }, { type: "done" }]);
  await page.evaluate(() => ((window as any).__clipMs = 60));
  await page.evaluate(() => (window as any).__say("wait actually, just the first meeting"));
  await expect.poll(() => h.hostBodies.at(-1)?.text).toBe("wait actually, just the first meeting");

  // mute stops the audio reaching the recognizer
  await page.getByRole("button", { name: "Mute microphone" }).click();
  await expect(page.getByText("Muted", { exact: true })).toBeVisible();
  const fedAtMute = await page.evaluate(() => (window as any).__speech.fed);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).__speech.fed)).toBe(fedAtMute);
  await page.getByRole("button", { name: "Unmute microphone" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__speech.fed)).toBeGreaterThan(fedAtMute);
});

test("a stray word pauses the bot and it carries on; the owner's words stop it, and the host is told only what was heard", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => ((window as any).__clipMs = 4_000));
  h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "sentence", text: "It goes on for a while." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();

  // one word (a cough the recognizer guessed at): paused, then resumed
  await page.evaluate(() => (window as any).__say("uh", true));
  await expect.poll(() => page.evaluate(() => (window as any).__pauses)).toBe(1);
  await page.waitForTimeout(2_600);
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  expect(await actions(page)).toEqual([]);

  // the second sentence plays after the first finishes: the call carried on
  await expect(page.getByText("It goes on for a while.")).toBeVisible({ timeout: 8_000 });

  // two words: the owner. Stopped, and the host learns what was heard
  await page.evaluate(() => (window as any).__say("hold on", true));
  h.replies.push([{ type: "sentence", text: "Sure." }, { type: "done" }]);
  await page.evaluate(() => ((window as any).__clipMs = 60));
  await page.evaluate(() => (window as any).__say("hold on, just the first meeting"));
  await expect.poll(() => h.hostBodies.at(-1)?.text).toBe("hold on, just the first meeting");
  expect(h.hostBodies.at(-1).history.at(-1)).toEqual({
    role: "host",
    text: "Here is a long summary of the whole board. It goes on for a while… [the owner cut in here]",
  });
});

test("an uh-huh while the bot talks is listening, not interrupting", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => ((window as any).__clipMs = 1_500));
  h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "sentence", text: "It goes on for a while." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  const asked = h.hostBodies.length;
  await page.evaluate(() => (window as any).__say("uh-huh"));
  await expect(page.getByText("It goes on for a while.")).toBeVisible({ timeout: 5_000 });
  expect(h.hostBodies.length).toBe(asked);
});

test("after a slow answer (a web lookup) the owner can still talk over the bot", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => ((window as any).__clipMs = 4_000));
  // the recognizer's session ends with the question, while the call waits
  // several seconds for the lookup (heard live: nothing was listening then)
  h.delayMs = 1_200;
  h.replies.push([{ type: "sentence", text: "Here is the news from the last three days." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's the latest AI news?"));
  await expect(page.getByText("Here is the news from the last three days.")).toBeVisible();
  // listening WHILE it speaks, not once it has finished
  await expect.poll(() => page.evaluate(() => (window as any).__speech.running), { timeout: 1_000 }).toBe(true);
  await expect(page.getByText("Here is the news from the last three days.")).toBeVisible();
  h.delayMs = 0;
  await page.evaluate(() => (window as any).__say("stop stop", true));
  await page.evaluate(() => (window as any).__say("stop stop stop"));
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__speech.missed ?? 0)).toBe(0);
});

test("music that trips the speech model now and then does not stop the bot", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => ((window as any).__clipMs = 4_000));
  h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  const asked = h.hostBodies.length;
  // instrumental music: an occasional frame reads as speech, and the
  // recognizer invents a few words from it
  await page.evaluate(() => { (window as any).__vadSparse = true; });
  await page.waitForTimeout(1_600);
  await page.evaluate(() => (window as any).__say("oh the", true));
  await page.waitForTimeout(300);
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  expect(h.hostBodies.length).toBe(asked);
});

test("stop, stop, stop while the bot talks: it goes quiet, answers nothing and drops what was waiting", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => ((window as any).__clipMs = 4_000));
  h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  // an engine answer lands while it talks, and waits its turn
  await page.evaluate(() => (window as any).__setBot({ messages: [{ id: "w1", role: "bot", kind: "text", at: Date.now(), text: "Your flight is booked." }] }));
  const asked = h.hostBodies.length;
  await page.evaluate(() => (window as any).__say("stop stop", true));
  await page.evaluate(() => (window as any).__say("stop stop stop"));
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await page.evaluate(() => ((window as any).__clipMs = 60));
  await page.waitForTimeout(800);
  expect(h.hostBodies.length).toBe(asked);
  expect(h.spoken).not.toContain("Your flight is booked.");
});

test("words the recognizer guesses from a noise (no speech heard) neither interrupt the bot nor start a turn", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => ((window as any).__clipMs = 4_000));
  h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  const asked = h.hostBodies.length;
  // a TradingView beep, which the recognizer hears as words; Silero hears no speech
  await page.evaluate(() => { (window as any).__vadNoise = true; });
  await page.waitForTimeout(1_700);
  await page.evaluate(() => (window as any).__say("have your", true));
  await page.evaluate(() => (window as any).__say("have your jam honey"));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__pauses)).toBe(0);
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  expect(h.hostBodies.length).toBe(asked);
  expect(await actions(page)).toEqual([]);
});

test("on Windows and Linux the app finds the end of the utterance and Flux transcribes it", async ({ page }) => {
  const h = await harness(page, "linux");
  h.heard.push("What's on the board?");
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "done" }]);
  // the fake mic speaks for 1.5 s, then goes quiet: one utterance, one upload
  await expect.poll(() => h.transcribed.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(h.transcribed[0]).toBeGreaterThan(16_000 * 2); // more than a second of 16 kHz audio
  await expect.poll(() => h.hostBodies.find((b) => !b.warm)?.text).toBe("What's on the board?");
  await expect.poll(() => h.spoken).toContain("Three meetings today.");
  // never the Mac helper
  expect(await page.evaluate(() => (window as any).__speech.starts)).toBe(0);
});
