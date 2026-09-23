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
};
export const useStore = () => ({ state: { config: window.__config }, dispatch });
export const api = async () => ({});
export const useFixtureBot = () => useSyncExternalStore(subscribe, () => window.__bot);
`;
const BRIDGE = `
window.__speech = { starts: 0, stops: 0, onText: null, onEnd: null, fed: 0, options: [] };
window.muragebox = {
  desktopSurfaceSecret: "fixture-surface-secret",
  speechStart: async (options) => { window.__speech.starts += 1; window.__speech.options.push(options); },
  speechFeed: (bytes) => { window.__speech.fed += bytes.byteLength; },
  speechStop: async () => { window.__speech.stops += 1; },
  onSpeechTranscript: (fn) => { window.__speech.onText = fn; return () => {}; },
  onSpeechEnd: (fn) => { window.__speech.onEnd = fn; return () => {}; },
};
window.__say = (text, partial = false) => window.__speech.onText?.({ text, partial });
// Headless audio: every clip "plays" for 60 ms and ends.
window.__clipMs = 60;
HTMLMediaElement.prototype.play = function () { setTimeout(() => this.onended?.(), window.__clipMs); return Promise.resolve(); };
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
        if (id === "/__call.js") return "\0host-entry";
      },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id === "\0host-store") return STORE;
        if (id === "\0host-call") return `export const useOnCall=()=>"bot-1";export const currentCall=()=>"bot-1";export const deferCallCleanup=()=>{};export const endCall=()=>{};export const startCall=()=>{};`;
        if (id === "\0host-push") return `export const usePushToTalk=()=>false;`;
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
  return { spoken, hostBodies, replies, transcribed, heard };
}

const actions = (page: Page) => page.evaluate(() => (window as any).__actions as Array<Record<string, any>>);
const starts = (page: Page) => page.evaluate(() => (window as any).__speech.starts as number);

test("the host answers first, hands work down through the ordinary send, and keeps listening while the engine works", async ({ page }, info) => {
  const h = await harness(page);
  await expect.poll(() => h.hostBodies.some((b) => b.warm)).toBe(true);

  // 1. answered by the host, spoken sentence by sentence, nothing sent
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "sentence", text: "Two approvals are waiting." }, { type: "done" }]);
  const before = await starts(page);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect.poll(() => h.spoken).toEqual(["Three meetings today.", "Two approvals are waiting."]);
  // listening again: the recognizer ran straight through the bot's speech
  // (full duplex), so there is nothing to restart
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  expect(await starts(page)).toBe(before);
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
  expect(h.hostBodies.at(-1).history).toContainEqual({ role: "host", text: "I couldn't start that. This bot's model needs an AI provider connected first." });
});

test("cancel from the host stops the running turn", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__setBot({ busy: true }));
  h.replies.push([{ type: "sentence", text: "Stopping that." }, { type: "cancel" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("never mind, stop"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "interrupt", botId: "bot-1", threadId: "thread-1" });
  await expect.poll(() => h.spoken).toContain("Stopping that.");
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
