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
// a test that needs something open when the call starts sets __initialBot
window.__bot = { id: "bot-1", name: "Sable", color: "green", busy: false, threadId: "thread-1", voice: "v1", messages: [], ...(window.__initialBot || {}) };
window.__actions = [];
window.__config = { flux: { configured: true }, tts: { configured: true, ready: true, routes: { host: "flux", lookup: "flux", speech: "flux", transcribe: "flux" } } };
// a call with the voice host off (no Flux host route)
if (window.__hostOff) delete window.__config.tts.routes.host;
window.__setBot = (patch) => { window.__bot = { ...window.__bot, ...patch }; for (const l of listeners) l(); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
export const visibleMessages = (bot) => bot.messages;
// CallControls.tsx's CallOverlaySlot imports this for real (callbar-rereview.md
// I7); this fixture never selects a different task, so a passthrough is
// exactly what the real one would project it to anyway.
export const viewedTaskBot = (bot) => bot;
const dispatch = (a) => {
  window.__actions.push(a);
  // the harness refusing a send, as it does for a bot with no model connected
  if (a.type === "send" && window.__refuseSends) setTimeout(() => a.onError?.(new Error(window.__refuseSends)), 20);
  // the harness failing to save a decision
  if (a.type === "decideRequest" && window.__refuseDecisions) setTimeout(() => a.onError?.(window.__refuseDecisions), 20);
  // ...and saving one, which is when the call says its rest-of-the-call yes
  else if (a.type === "decideRequest") setTimeout(() => a.onSuccess?.(), 20);
  // CallBarStrip's "tap to return" dispatches a real { type: "select" }
  // (CallControls.tsx), the same as App.tsx's Shell does: bridge it to the
  // fixture's own selection state (window.__select), the same one ?thread2=1
  // drives directly.
  if (a.type === "select") window.__select?.(a.id);
};
export const useStore = () => ({ state: { config: window.__config }, dispatch });
export const api = async () => ({});
export const useFixtureBot = () => useSyncExternalStore(subscribe, () => window.__bot);
`;
// The instant cue's clip is shorter than a reply's, so the fake player and
// the fake native engine can tell it from speech: it is a courtesy sound that
// never takes part in a reply's one-shot failures, pauses or plays.
const CUE_SAMPLES = 300;
const CUE_BYTES = 44 + CUE_SAMPLES * 2;
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
// A player-recovery test seam, set by the test before speaking: how the next
// clip's element behaves once play() is called. null is the normal path
// above. Fired through a microtask, not a timer, so it works the same with
// or without a fake clock installed (only tts/index.ts's own 8s stall
// watchdog needs the clock advanced).
window.__clipFail = null; // null | "error" | "stall" | "no-ended"
const clips = new WeakMap();
// the instant "Mm." cue is told apart by its size; it plays briefly and
// leaves the reply's one-shot failure arming alone
const blobSizes = new Map();
const makeUrl = URL.createObjectURL.bind(URL);
URL.createObjectURL = (obj) => { const url = makeUrl(obj); blobSizes.set(url, obj.size); return url; };
HTMLMediaElement.prototype.play = function () {
  if (blobSizes.get(this.src) === ${CUE_BYTES}) {
    const cue = clips.get(this) ?? { left: 60 };
    cue.cue = true; cue.left = 60; cue.at = Date.now(); cue.playing = true;
    clearTimeout(cue.timer);
    cue.timer = setTimeout(() => { cue.playing = false; this.onended?.(); }, 60);
    clips.set(this, cue);
    return Promise.resolve();
  }
  const mode = window.__clipFail;
  window.__clipFail = null; // one clip per arming, like a real one-shot failure
  if (mode === "error") {
    // decode/playback error: fires "error", never "ended"
    void Promise.resolve().then(() => this.onerror?.());
    return Promise.resolve();
  }
  if (mode === "stall") {
    // never actually starts: no "playing", "timeupdate", "ended" or "error"
    // ever fires — only the production stall watchdog can recover this
    return Promise.resolve();
  }
  if (mode === "no-ended") {
    // starts (so the watchdog's first arm-on-progress fires once), then
    // genuinely never reaches "ended"
    void Promise.resolve().then(() => this.onplaying?.());
    return Promise.resolve();
  }
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
  // the instant cue being replaced by a reply is not the owner pausing the bot
  if (!clip.cue) window.__pauses += 1;
};
Object.defineProperty(HTMLMediaElement.prototype, "paused", { get() { return !clips.get(this)?.playing; } });
// ── The iPhone shell (?os=ios): a fake murageNative with the four call
// audio methods (spec §4.1), standing in for CallAudioEngine. It streams mic
// frames (a tone while window.__native.talk, else silence), "plays" each
// clip for __native.clipMs once its last piece is in, and lets the test hold,
// resume and lose the engine. It also counts every AudioContext and Audio the
// page builds: on the native path there must be none (spec §4.3.3).
if (new URLSearchParams(location.search).get("os") === "ios") {
  const q = new URLSearchParams(location.search);
  const n = window.__native = {
    log: [], opens: 0, count: 0, session: null, held: false, talk: false, clipMs: window.__nativeClipMs || 60, clip: null,
    openErrors: window.__nativeOpenErrors || [], answers: [], plays: [], controls: [], dropped: new Set(),
    // callSessionOpen/Close (callbar-rereview.md M4, Android-only in the
    // real shells) is exercised here too: a generic bridge fake, not one OS
    // in particular, so the real @/lib/call.ts -> native-shell.ts chain
    // gets proven end to end in a real browser, not just source-pinned.
    callSessions: [],
    handlers: { callAudio: new Set(), resume: new Set() },
  };
  window.__ctx = 0;
  window.__audioEls = 0;
  const NativeContext = window.AudioContext;
  window.AudioContext = class extends NativeContext { constructor(...a) { super(...a); window.__ctx += 1; } };
  const NativeAudio = window.Audio;
  window.Audio = function (...a) { window.__audioEls += 1; return new NativeAudio(...a); };
  const frame = (amp) => { let s = ""; for (let i = 0; i < 1024; i++) { const x = Math.round(Math.sin(i / 3) * amp) & 0xffff; s += String.fromCharCode(x & 0xff, x >> 8); } return btoa(s); };
  const LOUD = frame(9830), QUIET = frame(0);
  const emit = (detail) => { for (const h of [...n.handlers.callAudio]) n.answers.push(h(detail)); };
  let mic = null;
  const startMic = () => { clearInterval(mic); mic = setInterval(() => { if (n.session && !n.held) emit({ type: "mic", session: n.session, pcm: n.talk ? LOUD : QUIET }); }, 64); };
  const stopMic = () => { clearInterval(mic); mic = null; };
  const settle = (state, reason) => {
    const c = n.clip;
    if (!c) return;
    clearTimeout(c.timer);
    n.clip = null;
    n.log.push("clip " + state);
    emit({ type: "clip", session: c.session, clip: c.id, state, ...(reason ? { reason } : {}) });
  };
  const run = (c) => {
    c.at = Date.now();
    c.playing = true;
    emit({ type: "clip", session: c.session, clip: c.id, state: "playing" });
    c.timer = setTimeout(() => { if (n.clip === c) settle("ended"); }, c.left);
  };
  const fail = (code) => Promise.reject(Object.assign(new Error(code), { code }));
  window.murageNative = {
    hello: async () => ({
      version: 1,
      methods: q.get("methods") === "none" ? ["haptic"] : ["callAudioOpen", "callAudioClose", "callAudioPlay", "callAudioControl", "callSessionOpen", "callSessionClose"],
    }),
    callSessionOpen: async () => { n.callSessions.push("open"); return true; },
    callSessionClose: async () => { n.callSessions.push("close"); return true; },
    on: (name, h) => { const set = n.handlers[name]; if (!set) return () => {}; set.add(h); return () => set.delete(h); },
    haptic: async () => true,
    callAudioOpen: async () => {
      n.opens += 1;
      n.log.push("open");
      const error = n.openErrors.shift();
      if (error) return fail(error);
      n.count += 1;
      n.session = "s" + n.count;
      n.held = false;
      startMic();
      return { session: n.session, sampleRate: 16000, frame: 1024 };
    },
    callAudioClose: async ({ session }) => {
      n.log.push("close " + session);
      if (session === n.session) { settle("cut", "stop"); stopMic(); n.session = null; }
      return true;
    },
    callAudioPlay: async (a) => {
      if (a.session !== n.session) return fail("unavailable");
      n.plays.push({ at: Date.now(), clip: a.clip, seq: a.seq, mime: a.mime, bytes: a.bytes.length, last: a.last, paused: Boolean(a.paused), session: a.session, held: n.held });
      // during a hold: accepted, dropped, and the clip cut once (spec §4.1)
      if (n.held) {
        if (!n.dropped.has(a.clip)) { n.dropped.add(a.clip); setTimeout(() => emit({ type: "clip", session: a.session, clip: a.clip, state: "cut", reason: "hold" }), 0); }
        return true;
      }
      if (a.seq === 0) {
        if (n.clip) settle("cut", "next");
        n.clip = { id: a.clip, session: a.session, paused: Boolean(a.paused), left: n.clipMs, timer: null, playing: false, complete: false };
        n.log.push("play");
      }
      const c = n.clip;
      if (c && c.id === a.clip && a.last) { c.complete = true; if (!c.paused) run(c); }
      return true;
    },
    callAudioControl: async ({ action }) => {
      n.controls.push(action);
      n.log.push("control " + action);
      const c = n.clip;
      if (action === "stop") settle("cut", "stop");
      else if (action === "pause" && c) { c.paused = true; if (c.playing) { clearTimeout(c.timer); c.left -= Date.now() - c.at; c.playing = false; } }
      else if (action === "resume" && c) { c.paused = false; if (c.complete && !c.playing) run(c); }
      return true;
    },
  };
  window.__talk = (ms) => { n.talk = true; setTimeout(() => { n.talk = false; }, ms); };
  // native sends hold BEFORE it cuts the clip for it
  window.__hold = (reason = "interrupted") => { n.held = true; emit({ type: "hold", session: n.session, reason }); settle("cut", "hold"); };
  window.__resumeEngine = () => { n.held = false; emit({ type: "resume", session: n.session }); };
  window.__lost = () => { const s = n.session; emit({ type: "lost", session: s, reason: "restart-failed" }); stopMic(); n.session = null; };
  window.__appResume = () => { for (const h of [...n.handlers.resume]) h(); };
}
`;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-call-host-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    // react-dom (not just react-dom/client): CallView.tsx/GroupCallView.tsx
    // import createPortal from "react-dom" (callbar-review.md I3), and an
    // un-pre-bundled import of it does not expose a named export here.
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] },
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
        // takeCallRequest/useCallRequest: CallControls.tsx's "What's new's
        // Call a bot" request, unrelated to this spec — stubbed as "never
        // requested" so it mounts without one, same as a real page nobody
        // clicked that button on.
        if (id === "\0host-call") return `export const useOnCall=()=>"bot-1";export const currentCall=()=>"bot-1";export const deferCallCleanup=()=>{};export const endCall=()=>{};export const startCall=()=>{};export const takeCallRequest=()=>false;export const useCallRequest=()=>null;`;
        if (id === "\0host-push") return `export const usePushToTalk=()=>false;`;
        if (id === "\0host-vad") return `export const SPEECH_CONFIDENCE=0.7;export class SileroVad{static async load(){if(window.__noVad)throw new Error("no model");return new SileroVad()}async push(f){window.__vadFrames=(window.__vadFrames||0)+1;let s=0;for(const x of f)s+=x*x;const loud=Math.sqrt(s/f.length)>0.01;if(window.__vadNoise)return 0;if(window.__vadSparse)return window.__vadFrames%6===0?1:0;return ["linux","ios"].includes(new URLSearchParams(location.search).get("os"))?(loud?1:0):1}reset(){}}`;
        // a Mac (on-device dictation) unless the page says otherwise
        if (id === "\0host-caps") return `export const useDesktopCapabilities=()=>({ready:true,capabilities:{dictation:{available:!["linux","ios"].includes(new URLSearchParams(location.search).get("os"))},host:{platform:"darwin"}}});`;
        if (id !== "\0host-entry") return;
        return `
import React from "react"; import { createRoot } from "react-dom/client";
import { useFixtureBot } from "@/state/store"; import { CallOverlay, CallBarStrip } from "/src/components/CallControls.tsx"; import { registerCallSlot } from "/src/lib/call-slot.ts"; import "/src/styles.css";
// moss-approval-bug.md: ?thread2=1 stands a second, unrelated thread up next
// to the call, with its own pending approval — the shape of tapping a push
// notification for another bot mid-call. window.__select drives it exactly
// as App.tsx's Shell would (a bare selection change): CallOverlay itself
// never learns the selection exists except through its collapsed prop.
const thread2 = new URLSearchParams(location.search).get("thread2") === "1";
function Fixture() {
  const bot = useFixtureBot();
  const [selected, setSelected] = React.useState("bot-1");
  const [approved, setApproved] = React.useState(false);
  window.__select = setSelected;
  // Call's full screen now portals into a slot (src/lib/call-slot.ts,
  // callbar-review.md I3) rather than rendering inline; this fixture has
  // no sidebar to keep clear of, so a full-viewport slot is enough to keep
  // every existing test's full-screen assertions working unchanged.
  const slotRef = React.useRef(null);
  React.useEffect(() => { registerCallSlot(slotRef.current); return () => registerCallSlot(null); }, []);
  const slot = React.createElement("div", { ref: slotRef, style: { position: "fixed", inset: 0, pointerEvents: "none" } });
  const overlay = React.createElement(CallOverlay, {
    bot,
    collapsed: thread2 && selected !== "bot-1",
    onExpand: () => setSelected("bot-1"),
  });
  if (!thread2) return React.createElement(React.Fragment, null, slot, overlay);
  return React.createElement(
    React.Fragment,
    null,
    slot,
    overlay,
    // ChatView/GroupView's own job in production (CallControls.tsx).
    // ownThreadId (callbar-rereview.md N3), so the strip hides on bot-1's
    // own thread exactly as ChatView really passes it -- without it the
    // strip never hides, even on the call's own thread.
    React.createElement(CallBarStrip, { ownId: selected, ownThreadId: bot.threadId }),
    selected === "bot-2" &&
      React.createElement(
        "div",
        { "data-testid": "thread-2" },
        React.createElement("div", null, "Ivy wants to search the web."),
        !approved &&
          React.createElement(
            "button",
            {
              onClick: () => {
                setApproved(true);
                window.__thread2Approved = true;
              },
            },
            "Allow",
          ),
        approved && React.createElement("div", null, "Allowed"),
      ),
  );
}
const root = createRoot(document.getElementById("root")); root.render(React.createElement(Fixture));
window.__unmount = () => root.unmount();`;
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
function silentWav(samples = 1200): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

// "Mm." is the instant cue the call prefetches through the same route.
const ACK_PHRASES = new Set(["Mm.", "Let me have a look.", "One sec.", "Okay, give me a moment.", "Sure, let me see."]);

async function harness(page: Page, os: "mac" | "linux" | "ios" = "mac", options: { query?: string; ready?: boolean } = {}) {
  const spoken: string[] = [];
  const cues: string[] = [];
  const hostBodies: any[] = [];
  const replies: HostReply[] = [];
  // transcribeWait: a transcription that answers only once the test says
  // transcribeStatus: the transcription route failing with this status
  const h = { delayMs: 0, transcribeDelayMs: 0, transcribeWait: null as Promise<void> | null, transcribeStatus: 200 };
  await page.route("**/api/tts/speak", async (route: Route) => {
    // the call's pre-synthesized acknowledgement clips are fetched through
    // the same route; they are not the reply, so they are kept apart
    const text = JSON.parse(route.request().postData() ?? "{}").text;
    (ACK_PHRASES.has(text) ? cues : spoken).push(text);
    await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav(text === "Mm." ? CUE_SAMPLES : undefined) });
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
    if (h.transcribeDelayMs) await new Promise((r) => setTimeout(r, h.transcribeDelayMs));
    if (h.transcribeWait) await h.transcribeWait;
    if (h.transcribeStatus !== 200) return route.fulfill({ status: h.transcribeStatus, contentType: "application/json", body: '{"error":"transcription-failed"}' });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ text: heard.shift() ?? "" }) });
  });
  await page.goto(`${origin}/__call?os=${os}${options.query ?? ""}`);
  await expect(page.locator('button[aria-label="Hang up"]')).toBeVisible();
  // the microphone opens asynchronously; a Mac call is ready once the
  // recognizer has been started
  if (os === "mac") await expect.poll(() => page.evaluate(() => (window as any).__speech.starts)).toBeGreaterThan(0);
  // and Silero has judged some audio (in the app the recognizer is fed only
  // audio Silero has already judged, so words never arrive before it)
  if (options.ready !== false) await expect.poll(() => page.evaluate(() => (window as any).__vadFrames ?? 0)).toBeGreaterThan(0);
  return Object.assign(h, { spoken, cues, hostBodies, replies, transcribed, heard });
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
  // the cue's side of the bargain: at most two clips prewarmed, never in the host's history
  expect(h.cues.filter((c) => c !== "Mm.").length).toBeLessThanOrEqual(2);
  for (const body of h.hostBodies.filter((b) => !b.warm)) {
    for (const line of body.history ?? []) expect(ACK_PHRASES.has(line.text)).toBe(false);
  }

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

test("an empty partial and an empty final after words still send those words, once", async ({ page }) => {
  const h = await harness(page);
  await expect.poll(() => h.hostBodies.some((b) => b.warm)).toBe(true);
  h.replies.push([{ type: "sentence", text: "Cloudy, mild." }, { type: "done" }]);
  const turns = () => h.hostBodies.filter((b) => !b.warm && typeof b.text === "string" && b.text);
  await page.evaluate(() => (window as any).__speech.onText({ text: "what's the weather in Austin", partial: true }));
  await page.evaluate(() => (window as any).__speech.onText({ text: "", partial: true }));
  // the words stay on screen through the empty partial
  await expect(page.getByText("what's the weather in Austin")).toBeVisible();
  await page.evaluate(() => (window as any).__say(""));
  await expect.poll(() => h.spoken).toEqual(["Cloudy, mild."]);
  expect(turns()).toHaveLength(1);
  expect(turns()[0].text).toBe("what's the weather in Austin");
});

test("words before a recognizer reset stay in the turn: A, empty, B sends A B", async ({ page }) => {
  const h = await harness(page);
  await expect.poll(() => h.hostBodies.some((b) => b.warm)).toBe(true);
  h.replies.push([{ type: "sentence", text: "Noted." }, { type: "done" }]);
  const turns = () => h.hostBodies.filter((b) => !b.warm && typeof b.text === "string" && b.text);
  await page.evaluate(() => (window as any).__speech.onText({ text: "remind me to call mom and", partial: true }));
  await page.evaluate(() => (window as any).__speech.onText({ text: "", partial: true }));
  await page.evaluate(() => (window as any).__speech.onText({ text: "at five", partial: true }));
  await page.evaluate(() => (window as any).__say(""));
  await expect.poll(() => h.spoken).toEqual(["Noted."]);
  expect(turns()).toHaveLength(1);
  expect(turns()[0].text).toBe("remind me to call mom and at five");
});

test("a placeholder partial and an empty final send nothing", async ({ page }) => {
  const h = await harness(page);
  await expect.poll(() => h.hostBodies.some((b) => b.warm)).toBe(true);
  await page.evaluate(() => (window as any).__speech.onText({ text: "\u2026", partial: true }));
  await page.evaluate(() => (window as any).__say(""));
  await page.waitForTimeout(600);
  expect(h.hostBodies.filter((b) => !b.warm && typeof b.text === "string" && b.text)).toHaveLength(0);
  expect(h.spoken).toEqual([]);
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
  await expect.poll(() => h.spoken).toContain("Can I search the web? Say yes, no, or yes for the rest of the call, which covers searches and lookups.");
  h.replies.push([{ type: "sentence", text: "It wants to search for this week's AI news. Yes or no?" }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What is it searching for?"));
  await expect.poll(() => h.spoken.at(-1)).toBe("It wants to search for this week's AI news. Yes or no?");
  expect(h.hostBodies.at(-1)).toMatchObject({ text: "What is it searching for?", approval: "Can I search the web? Yes or no." });
  expect((await actions(page)).some((a) => a.type === "decideRequest")).toBe(false);
  await page.evaluate(() => (window as any).__say("Yes"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "allow" });
});

test("an engine answer that lands while the owner's line waits for the rest is told after their turn, never cut", async ({ page }) => {
  const h = await harness(page);
  // sounds unfinished: held for the rest
  await page.evaluate(() => (window as any).__say("My top three movies. Blues Brothers,"));
  await page.evaluate(() => (window as any).__setBot({ messages: [{ id: "r1", role: "bot", kind: "text", at: 2, text: "Booked Nara at 8pm for two." }] }));
  await page.waitForTimeout(300);
  expect(h.spoken).toEqual([]);
  // the owner goes on; the rest joins the held line as one turn
  await page.evaluate(() => (window as any).__say("Heartbreak", true));
  h.replies.push([{ type: "sentence", text: "Good picks." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Heartbreak Ridge."));
  await expect.poll(() => h.spoken).toEqual(["Good picks.", "Booked Nara at 8pm for two."]);
  expect(h.hostBodies.filter((b) => !b.warm).map((b) => b.text)).toEqual(["My top three movies. Blues Brothers, Heartbreak Ridge."]);
});

test("an approval raised while the owner's line waits is never answered by the rest of it, and is asked after the host's turn", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__say("Go ahead and"));
  await page.evaluate(() => (window as any).__setBot({ busy: true, messages: [
    { id: "ap1", role: "bot", kind: "options", at: 1, card: { tool: "other", subtitle: "Agents_web_search", requestId: "req-1", options: ["Allow", "Deny"] } },
  ] }));
  await page.waitForTimeout(300);
  // owed, not read over the owner's unfinished sentence
  expect(h.spoken).toEqual([]);
  await page.evaluate(() => (window as any).__say("yes", true));
  h.replies.push([{ type: "sentence", text: "Sure thing." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("yes, book the table."));
  await expect.poll(() => h.spoken).toEqual(["Sure thing.", "Can I search the web? Say yes, no, or yes for the rest of the call, which covers searches and lookups."]);
  expect(h.hostBodies.filter((b) => !b.warm).map((b) => b.text)).toEqual(["Go ahead and yes, book the table."]);
  expect((await actions(page)).some((a) => a.type === "decideRequest")).toBe(false);
  // asked in full: now a yes answers it
  await page.evaluate(() => (window as any).__say("Yes"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "allow" });
});

test("\"hold on\" after an unfinished line keeps it waiting, and the rest joins it", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__say("My top three movies are,"));
  await expect.poll(() => page.evaluate(() => (window as any).__speech.running)).toBe(true);
  await page.evaluate(() => (window as any).__say("hold on"));
  await expect.poll(() => page.evaluate(() => (window as any).__speech.running)).toBe(true);
  // well past the ordinary 1.2 s wait: nothing asked yet
  await page.waitForTimeout(2_000);
  expect(h.hostBodies.filter((b) => !b.warm)).toEqual([]);
  h.replies.push([{ type: "sentence", text: "Classics." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Casablanca and Heartbreak Ridge."));
  await expect.poll(() => h.spoken).toEqual(["Classics."]);
  expect(h.hostBodies.filter((b) => !b.warm).map((b) => b.text)).toEqual(["My top three movies are, Casablanca and Heartbreak Ridge."]);
});

test("\"no, wait, stop\" after an unfinished line takes it back: the stop word wins over the wait", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__say("My top three movies are,"));
  await expect.poll(() => page.evaluate(() => (window as any).__speech.running)).toBe(true);
  await page.evaluate(() => (window as any).__say("no, wait, stop"));
  await expect.poll(() => page.evaluate(() => (window as any).__speech.running)).toBe(true);
  // dropped, not parked: nothing is sent, now or later
  await page.waitForTimeout(2_000);
  expect(h.hostBodies.filter((b) => !b.warm)).toEqual([]);
  h.replies.push([{ type: "sentence", text: "Almost ten." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What time is it?"));
  await expect.poll(() => h.spoken).toEqual(["Almost ten."]);
  expect(h.hostBodies.filter((b) => !b.warm).map((b) => b.text)).toEqual(["What time is it?"]);
});

test("an approval that lands while the host fetches its answer is asked after the reply, which is heard and remembered", async ({ page }) => {
  const h = await harness(page);
  h.delayMs = 800;
  h.replies.push([{ type: "sentence", text: "Nara has a table at eight." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Can we get dinner at Nara?"));
  await expect.poll(() => h.hostBodies.filter((b) => !b.warm).length).toBe(1);
  await page.evaluate(() => (window as any).__setBot({ busy: true, messages: [
    { id: "ap1", role: "bot", kind: "options", at: 1, card: { tool: "other", subtitle: "Agents_web_search", requestId: "req-1", options: ["Allow", "Deny"] } },
  ] }));
  // the reply is not silenced by the prompt: it is said, then the prompt
  await expect.poll(() => h.spoken).toEqual(["Nara has a table at eight.", "Can I search the web? Say yes, no, or yes for the rest of the call, which covers searches and lookups."]);
  h.delayMs = 0;
  await page.evaluate(() => (window as any).__say("Yes"));
  await expect.poll(async () => (await actions(page)).at(-1)).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "allow" });
  // and the host remembers what it said, because it was heard
  await page.evaluate(() => (window as any).__setBot({ busy: false, messages: [] }));
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  h.replies.push([{ type: "sentence", text: "Done." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("Thanks for that."));
  await expect.poll(() => h.hostBodies.filter((b) => !b.warm).length).toBe(2);
  expect(h.hostBodies.filter((b) => !b.warm).at(-1).history).toEqual([
    { role: "owner", text: "Can we get dinner at Nara?" },
    { role: "host", text: "Nara has a table at eight." },
  ]);
});

test("a yes for the rest of the call, said any way, answers every ordinary request until hang-up", async ({ page }) => {
  const h = await harness(page);
  // the engine stamps an everyday lookup low-risk; only such a card is answered by the call-long yes
  const card = (id: string, subtitle: string, tool = "Local computer approval") => ({ id, role: "bot", kind: "options", at: 1, card: { tool, subtitle, requestId: `req-${id}`, options: ["Allow", "Deny"], lowRisk: tool === "other" } });
  await page.evaluate((c) => (window as any).__setBot({ busy: true, messages: [c] }), card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other"));
  await expect.poll(() => h.spoken.at(-1)).toBe("Can I look up which app tools to use? Say yes, no, or yes for the rest of the call, which covers searches and lookups.");
  // heard live: not "yes" first, so it used to be neither yes nor no
  await page.evaluate(() => (window as any).__say("I'll allow it for the rest of the call"));
  await expect.poll(async () => (await actions(page)).filter((a) => a.type === "decideRequest").length).toBe(1);
  await expect.poll(() => h.spoken.at(-1)).toBe("Okay, for the rest of the call I'll go ahead with web searches and lookups. I'll still ask you first before sending a message, paying, deleting, running a command, changing a file, or using your computer.");
  const spokenBefore = h.spoken.length;

  // a covered lookup goes through without a word; anything else (a command, an
  // app action that does something) still gets its own card and its own yes
  const answered = { ...card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other"), card: { ...card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other").card, answered: "allow" } };
  await page.evaluate((cards) => (window as any).__setBot({ busy: true, messages: cards }), [answered, card("a2", "composio__COMPOSIO_SEARCH_TOOLS", "other")]);
  await expect.poll(async () => (await actions(page)).filter((a) => a.type === "decideRequest").map((a) => a.requestId)).toEqual(["req-a1", "req-a2"]);
  await page.evaluate((cards) => (window as any).__setBot({ busy: true, messages: cards }), [card("a3", 'python3 -c "import json"', "shell")]);
  await expect.poll(() => h.spoken.at(-1)).toBe("Can I run a small script on your computer? Yes or no.");
  expect((await actions(page)).filter((a) => a.type === "decideRequest").map((a) => a.requestId)).toEqual(["req-a1", "req-a2"]);
  void spokenBefore;
});

test("an approval allowed for the call that fails to save is asked aloud, not left waiting", async ({ page }) => {
  const h = await harness(page);
  const card = (id: string, subtitle: string, tool: string) => ({ id, role: "bot", kind: "options", at: 1, card: { tool, subtitle, requestId: `req-${id}`, options: ["Allow", "Deny"], lowRisk: tool === "other" } });
  await page.evaluate((c) => (window as any).__setBot({ busy: true, messages: [c] }), card("a1", "composio__COMPOSIO_SEARCH_TOOLS", "other"));
  await expect.poll(() => h.spoken.at(-1)).toContain("Say yes, no, or yes for the rest of the call, which covers searches and lookups.");
  await page.evaluate(() => (window as any).__say("yes for the rest of the call"));
  await expect.poll(() => h.spoken.at(-1)).toBe("Okay, for the rest of the call I'll go ahead with web searches and lookups. I'll still ask you first before sending a message, paying, deleting, running a command, changing a file, or using your computer.");
  await page.evaluate(() => { (window as any).__refuseDecisions = "the request is no longer open"; });
  await page.evaluate((c) => (window as any).__setBot({ busy: true, messages: [c] }), card("a2", "composio__COMPOSIO_SEARCH_TOOLS", "other"));
  await expect.poll(() => h.spoken.at(-1)).toBe("I couldn't allow that on my own. Can I look up which app tools to use? Yes or no.");
});

test("a yes that does not start with yes still answers the approval", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => (window as any).__setBot({ busy: true, messages: [
    { id: "ap1", role: "bot", kind: "options", at: 1, card: { tool: "other", subtitle: "Agents_web_search", requestId: "req-1", options: ["Allow", "Deny"] } },
  ] }));
  await expect.poll(() => h.spoken).toContain("Can I search the web? Say yes, no, or yes for the rest of the call, which covers searches and lookups.");
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

  // the second sentence plays after the first finishes: the call carried on.
  // The read-along shows the sentence still to come as dim text before it
  // sounds, so "being spoken" is the current line, not any text on screen.
  await expect(page.locator('[data-read-along="current"]')).toContainText("It goes on for a while.", { timeout: 8_000 });

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
  await expect(page.locator('[data-read-along="current"]')).toContainText("It goes on for a while.", { timeout: 5_000 });
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

// call-fixes-brief.md: the owner's own words stay on screen, and a reply
// clip that fails, stalls or stops answering "ended" never strands the call
// on "speaking". Fake-mic-plus-DOM behavioral coverage, review round 1
// (call-fixes-review.md Important #1): src/components/CallView.test.ts pins
// the fixed source shape as a fast secondary guard, but these are the real
// proof — they run the actual tellReply/hostReply control flow end to end.

test("the Flux path keeps the owner's words on screen through One moment and the reply", async ({ page }) => {
  const h = await harness(page, "linux");
  // Slow the host down so "One moment" stays up long enough to observe (the
  // real turnaround, plus expect.poll's own backoff below, can already eat
  // several hundred ms before the test ever looks). This is the exact race
  // the brief's item 1 fixes: on the phone, the final transcript and the
  // move to "sending" used to land in the same render, so a listening-only
  // line was painted over before anyone saw it.
  h.delayMs = 3_000;
  h.heard.push("What's on the board?");
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "done" }]);
  // the fake mic speaks for 1.5 s, then goes quiet: one utterance, one upload
  await expect.poll(() => h.transcribed.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.getByText("One moment", { exact: true })).toBeVisible();
  await expect(page.getByText("You: What's on the board?")).toBeVisible();
  await page.evaluate(() => ((window as any).__clipMs = 2_000));
  await expect(page.getByText("Three meetings today.")).toBeVisible();
  // still up next to the bot's own caption, through the reply
  await expect(page.getByText("You: What's on the board?")).toBeVisible();
});

test("a reply clip that errors mid-play returns the call to listening", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => { (window as any).__clipFail = "error"; });
  h.replies.push([{ type: "sentence", text: "Here is the answer." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  // the fake error fires on the very next microtask, faster than the
  // "speaking" caption can reliably be observed in between — the end state
  // is what proves the fix: back to listening, with the one plain line
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await expect(page.getByText("The generated voice clip couldn't be played.")).toBeVisible();
});

test("a reply clip that never starts within 8s returns the call to listening", async ({ page }) => {
  await page.clock.install();
  const h = await harness(page);
  await page.evaluate(() => { (window as any).__clipFail = "stall"; });
  h.replies.push([{ type: "sentence", text: "Here is the answer." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is the answer.")).toBeVisible();
  // nothing ever fires "playing", "ended" or "error": only the production
  // stall watchdog (armed right after play(), ~8s) can recover this
  await page.clock.runFor(8_500);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
});

test("a reply clip that starts but never fires ended returns the call to listening", async ({ page }) => {
  await page.clock.install();
  const h = await harness(page);
  await page.evaluate(() => { (window as any).__clipFail = "no-ended"; });
  h.replies.push([{ type: "sentence", text: "Here is the answer." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is the answer.")).toBeVisible();
  // "playing" fires once (the watchdog's first re-arm), then nothing: no
  // "timeupdate", no "ended", no "error" — the watchdog has to fire again
  await page.clock.runFor(8_500);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
});

test("a failed clip while a long answer is being told as a brief still returns to listening", async ({ page }) => {
  // tellReply's own guard (CallView.tsx ~357), distinct from hostReply's
  // (~516): this is the brief path, told through speaker.stream() the same
  // way, but reached only when the engine's own answer is long.
  const h = await harness(page);
  const long = `## Today's AI news\n\n${"- A long bullet about a launch that goes on for a while. ".repeat(12)}`;
  await page.evaluate(() => { (window as any).__clipFail = "error"; });
  h.replies.push([{ type: "sentence", text: "Three big stories today." }, { type: "done" }]);
  await page.evaluate((text) => (window as any).__setBot({ messages: [{ id: "n1", role: "bot", kind: "text", at: 1, text }] }), long);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
});

test("a real interruption reaches Listening and does not auto-resume the interrupted reply", async ({ page }) => {
  const h = await harness(page);
  await page.evaluate(() => ((window as any).__clipMs = 4_000));
  h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "sentence", text: "It goes on for a while." }, { type: "done" }]);
  await page.evaluate(() => (window as any).__say("What's on the board?"));
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();

  // two words while the bot talks: the owner, for real (not a cough, not
  // backchannel) — bargeIn() bumps sayGeneration and moves to "listening"
  // itself; this proves the new failure-recovery fallthrough never ALSO
  // fires for a genuine interruption and makes the bot talk again on its own.
  // (h.spoken is not the right signal here: the stream prefetches sentence
  // n+1's audio while n plays, so it is already posted regardless of any
  // later interruption — see the interrupted-history assertion elsewhere in
  // this file for that check. "Listening" that stays "Listening" is the
  // direct proof of no auto-resume.)
  await page.evaluate(() => (window as any).__say("wait actually", true));
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
});

// ── The iPhone's native call audio (spec rev 3, §4.3, §6.4) ───────────────
// ?os=ios gives the page the fake murageNative above: Flux transcription on
// the shell's mic frames, and every reply clip sent to callAudioPlay. The
// same CallView as every test above, so the desktop cases double as proof
// that the web path is unchanged.

type NativePlay = { at: number; clip: string; seq: number; mime: string; bytes: number; last: boolean; paused: boolean; session: string; held: boolean };
const native = (page: Page) =>
  page.evaluate(() => {
    const n = (window as any).__native;
    return {
      log: [...n.log] as string[],
      opens: n.opens as number,
      session: n.session as string | null,
      plays: [...n.plays] as NativePlay[],
      controls: [...n.controls] as string[],
      answers: [...n.answers] as unknown[],
      contexts: (window as any).__ctx as number,
      audios: (window as any).__audioEls as number,
    };
  });
const call = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([name, rest]) => (window as any)[name as string](...(rest as unknown[])), [fn, args] as const);
const diag = (page: Page) => {
  const lines: string[] = [];
  page.on("console", (message) => { if (message.text().startsWith("[call-diag] audio")) lines.push(message.text()); });
  return lines;
};
const LONG = `## Today's AI news\n\n${"- A long bullet about a launch that goes on for a while. ".repeat(12)}`;
const approvalCard = { id: "ap1", role: "bot", kind: "options", at: 1, card: { tool: "other", subtitle: "Agents_web_search", requestId: "req-1", options: ["Allow", "Deny"] } };
const APPROVAL_PROMPT = "Can I search the web? Say yes, no, or yes for the rest of the call, which covers searches and lookups.";
const count = (list: string[], text: string) => list.filter((s) => s === text).length;

test("iPhone: a whole turn runs through the shell's engine, streamed with no MediaSource, and the page builds no AudioContext or Audio", async ({ page }) => {
  // the iPhone's WebKit may have no MediaSource: the native player streams anyway
  await page.addInitScript(() => { delete (window as any).MediaSource; });
  const lines = diag(page);
  const h = await harness(page, "ios");
  h.heard.push("What's on the board?");
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "done" }]);
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.hostBodies.find((b) => !b.warm)?.text, { timeout: 10_000 }).toBe("What's on the board?");
  await expect.poll(async () => (await native(page)).plays.some((p) => p.last)).toBe(true);
  await expect.poll(async () => (await native(page)).log).toContain("clip ended");
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  const n = await native(page);
  expect(n.opens).toBe(1);
  expect(n.plays[0]).toMatchObject({ session: "s1", seq: 0, mime: "audio/wav", paused: false });
  expect(n.plays[0].bytes).toBeGreaterThan(0);
  expect(n.contexts).toBe(0);
  expect(n.audios).toBe(0);
  // the watchdog contract: every mic event was answered true (spec §4.2.7)
  expect(n.answers.length).toBeGreaterThan(10);
  expect(n.answers.every((a) => a === true)).toBe(true);
  expect(lines).toContain("[call-diag] audio native");
  expect(lines).not.toContain("[call-diag] audio web");
});

test("iPhone: a clip that arrives whole (no response stream) goes to native in pieces too", async ({ page }) => {
  await page.addInitScript(() => {
    const body = Object.getOwnPropertyDescriptor(Response.prototype, "body")!;
    Object.defineProperty(Response.prototype, "body", { get() { return this.url.includes("/api/tts/speak") ? null : body.get!.call(this); } });
  });
  const h = await harness(page, "ios");
  await call(page, "__setBot", { messages: [{ id: "r1", role: "bot", kind: "text", at: 1, text: "Booked Nara at 8pm for two." }] });
  await expect.poll(() => h.spoken).toEqual(["Booked Nara at 8pm for two."]);
  await expect.poll(async () => (await native(page)).log).toContain("clip ended");
  const n = await native(page);
  expect(n.plays[0]).toMatchObject({ seq: 0, mime: "audio/wav", last: true });
  expect(n.plays[0].bytes).toBeGreaterThan(0);
  expect(n.audios).toBe(0);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
});

test("iPhone: a hold while the bot speaks cuts it, nothing plays during the hold, and a reply that lands then is spoken after", async ({ page }) => {
  const h = await harness(page, "ios");
  await page.evaluate(() => { (window as any).__native.clipMs = 4_000; });
  // a long engine answer, told through the host's brief stream
  h.replies.push([{ type: "sentence", text: "Three big stories today." }, { type: "sentence", text: "The full version is in the chat." }, { type: "done" }]);
  await call(page, "__setBot", { messages: [{ id: "n1", role: "bot", kind: "text", at: 1, text: LONG }] });
  await expect(page.getByText("Three big stories today.")).toBeVisible();
  await call(page, "__hold", "interrupted");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await expect(page.locator('[data-call-held="true"]')).toBeVisible();
  // the page stopped its own speech too
  await expect.poll(async () => (await native(page)).controls).toContain("stop");
  const spokenAtHold = h.spoken.length;
  // an engine answer lands during the hold: held back, not spoken
  await call(page, "__setBot", { messages: [
    { id: "n1", role: "bot", kind: "text", at: 1, text: LONG },
    { id: "r2", role: "bot", kind: "text", at: 2, text: "Booked Nara at 8pm for two." },
  ] });
  await page.waitForTimeout(800);
  expect(h.spoken.length).toBe(spokenAtHold);
  expect((await native(page)).plays.filter((p) => p.held)).toEqual([]);
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();

  await page.evaluate(() => { (window as any).__native.clipMs = 60; });
  await call(page, "__resumeEngine");
  await expect.poll(() => h.spoken.at(-1)).toBe("Booked Nara at 8pm for two.");
  // and never the cut brief again
  expect(count(h.spoken, "The full version is in the chat.")).toBeLessThanOrEqual(1);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
});

test("iPhone: a hold while the host is fetching an answer drops it, and the call listens after", async ({ page }) => {
  const h = await harness(page, "ios");
  h.delayMs = 2_500;
  h.heard.push("What's on the board?");
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "done" }]);
  await call(page, "__talk", 1_200);
  await expect(page.getByText("One moment", { exact: true })).toBeVisible({ timeout: 10_000 });
  await call(page, "__hold", "interrupted");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await page.waitForTimeout(3_000);
  // the host's answer came back during the hold: never voiced
  expect(h.spoken).not.toContain("Three meetings today.");
  // only the instant cue (a short clip, base64 in the bridge) may have sounded, never the reply
  expect((await native(page)).plays.filter((p: any) => p.bytes !== Math.ceil(CUE_BYTES / 3) * 4)).toEqual([]);
  await call(page, "__resumeEngine");
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  // the held turn was never answered: the host's next turn does not see the
  // owner's question in its history, as if it had been (callbar-rereview3.md A6)
  h.delayMs = 0;
  h.heard.push("And tomorrow?");
  h.replies.push([{ type: "sentence", text: "Two meetings tomorrow." }, { type: "done" }]);
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.hostBodies.filter((b) => !b.warm).length, { timeout: 10_000 }).toBe(2);
  const next = h.hostBodies.filter((b) => !b.warm)[1];
  expect(next.text).toBe("And tomorrow?");
  expect(next.history).toEqual([]);
});

test("iPhone: a hold with a transcription in flight drops the utterance, and the next one is heard", async ({ page }) => {
  const h = await harness(page, "ios");
  h.transcribeDelayMs = 1_500;
  h.heard.push("Cancel my flight");
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.transcribed.length, { timeout: 10_000 }).toBe(1);
  await call(page, "__hold", "interrupted");
  await page.waitForTimeout(2_000);
  expect(h.hostBodies.filter((b) => !b.warm)).toEqual([]);
  await call(page, "__resumeEngine");
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  // the microphone's listeners are the same ones: a new turn goes through
  h.transcribeDelayMs = 0;
  h.heard.push("What's on the board?");
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "done" }]);
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.hostBodies.find((b) => !b.warm)?.text, { timeout: 10_000 }).toBe("What's on the board?");
});

test("iPhone: a hold while the engine works keeps the phase, and a reply that lands during it is spoken on resume", async ({ page }) => {
  const h = await harness(page, "ios");
  await call(page, "__setBot", { busy: true, messages: [{ id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } }] });
  await call(page, "__hold", "background");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await call(page, "__setBot", { busy: false, messages: [
    { id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } },
    { id: "r1", role: "bot", kind: "text", at: 2, text: "Booked Nara at 8pm for two." },
  ] });
  await page.waitForTimeout(800);
  expect(h.spoken).toEqual([]);
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await call(page, "__resumeEngine");
  await expect.poll(() => h.spoken).toEqual(["Booked Nara at 8pm for two."]);
  await expect.poll(async () => (await native(page)).log).toContain("clip ended");
});

test("iPhone: an approval open when the call starts is asked at once, through the shell", async ({ page }) => {
  await page.addInitScript((card) => { (window as any).__initialBot = { busy: true, messages: [card] }; }, approvalCard);
  const h = await harness(page, "ios");
  await expect.poll(() => h.spoken).toEqual([APPROVAL_PROMPT]);
  await expect.poll(async () => (await native(page)).plays.length).toBeGreaterThan(0);
  const n = await native(page);
  // asked only once the native output was chosen, never through <audio>
  expect(n.log.indexOf("open")).toBeLessThan(n.log.indexOf("play"));
  expect(n.audios).toBe(0);
  await page.waitForTimeout(500);
  expect(h.spoken).toEqual([APPROVAL_PROMPT]);
});

test("iPhone: an approval raised during a hold is asked once on resume, never twice and never through the host", async ({ page }) => {
  const h = await harness(page, "ios");
  await call(page, "__hold", "interrupted");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await call(page, "__setBot", { busy: true, messages: [approvalCard] });
  await page.waitForTimeout(800);
  expect(h.spoken).toEqual([]);
  await call(page, "__resumeEngine");
  await expect.poll(() => h.spoken).toContain(APPROVAL_PROMPT);
  await page.waitForTimeout(1_000);
  expect(count(h.spoken, APPROVAL_PROMPT)).toBe(1);
  expect(h.hostBodies.some((b) => b.brief)).toBe(false);
  // and it is answered like any other
  h.heard.push("Yes");
  await call(page, "__talk", 1_200);
  await expect.poll(async () => (await actions(page)).at(-1), { timeout: 10_000 }).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "allow" });
});

test("iPhone: an approval asked before a hold and not answered is asked again on resume, once", async ({ page }) => {
  const h = await harness(page, "ios");
  await call(page, "__setBot", { busy: true, messages: [approvalCard] });
  await expect.poll(() => h.spoken).toEqual([APPROVAL_PROMPT]);
  await expect.poll(async () => (await native(page)).log).toContain("clip ended");
  await call(page, "__hold", "interrupted");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await call(page, "__resumeEngine");
  await expect.poll(() => count(h.spoken, APPROVAL_PROMPT)).toBe(2);
  await page.waitForTimeout(1_000);
  expect(count(h.spoken, APPROVAL_PROMPT)).toBe(2);
});

test("iPhone: the working pulse plays natively, stops on a hold and comes back on resume while the work runs", async ({ page }) => {
  await harness(page, "ios");
  await call(page, "__setBot", { busy: true, messages: [{ id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } }] });
  await expect.poll(async () => (await native(page)).controls).toEqual(["pulseOn"]);
  await call(page, "__hold", "interrupted");
  await expect.poll(async () => (await native(page)).controls.at(-1)).toBe("pulseOff");
  await call(page, "__resumeEngine");
  await expect.poll(async () => (await native(page)).controls.filter((c) => c === "pulseOn").length).toBe(2);
  expect((await native(page)).contexts).toBe(0);
  // the work ends: the pulse stops
  await call(page, "__setBot", { busy: false });
  await expect.poll(async () => (await native(page)).controls.at(-1)).toBe("pulseOff");
});

test("iPhone: when the engine is lost, Resume call opens a new session and the call carries on", async ({ page }) => {
  const h = await harness(page, "ios");
  await call(page, "__lost");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume call" }).click();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume call" })).toHaveCount(0);
  const n = await native(page);
  expect(n.opens).toBe(2);
  expect(n.session).toBe("s2");
  // the same listeners hear the new session, and replies play on it
  h.heard.push("What's on the board?");
  h.replies.push([{ type: "sentence", text: "Three meetings today." }, { type: "done" }]);
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.hostBodies.find((b) => !b.warm)?.text, { timeout: 10_000 }).toBe("What's on the board?");
  await expect.poll(async () => (await native(page)).plays.at(-1)?.session).toBe("s2");
  await expect.poll(async () => (await native(page)).log).toContain("clip ended");
});

test("iPhone: when Resume call cannot open the microphone, it says so and can be tried again", async ({ page }) => {
  await harness(page, "ios");
  await call(page, "__lost");
  await page.evaluate(() => { (window as any).__native.openErrors.push("unavailable"); });
  await page.getByRole("button", { name: "Resume call" }).click();
  await expect(page.getByText("The microphone couldn't start.", { exact: true })).toBeVisible();
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume call" }).click();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  expect((await native(page)).session).toBe("s2");
});

test("iPhone: hanging up stops the speech before the session closes", async ({ page }) => {
  const h = await harness(page, "ios");
  await page.evaluate(() => { (window as any).__native.clipMs = 4_000; });
  await call(page, "__setBot", { messages: [{ id: "r1", role: "bot", kind: "text", at: 1, text: "Booked Nara at 8pm for two." }] });
  await expect.poll(() => h.spoken).toEqual(["Booked Nara at 8pm for two."]);
  await expect.poll(async () => (await native(page)).log).toContain("play");
  await call(page, "__unmount");
  await expect.poll(async () => (await native(page)).log).toContain("close s1");
  const log = (await native(page)).log;
  expect(log.indexOf("control stop")).toBeGreaterThan(-1);
  expect(log.indexOf("control stop")).toBeLessThan(log.indexOf("close s1"));
});

// moss-approval-bug.md: an approval push for another bot used to select that
// bot's chat, which unmounted the call (it was mounted inside the selected
// chat) and silently hung it up. CallOverlay is now mounted independently of
// the selection (App.tsx's Shell) and only collapses to a bar; ?thread2=1
// stands a second thread up to prove selecting it, and answering an
// approval there, never touches the call underneath.
test("iPhone: the call survives selecting another thread, approving a card there, and returning", async ({ page }) => {
  const h = await harness(page, "ios", { query: "&thread2=1" });
  const opened = await native(page);
  expect(opened.opens).toBe(1);
  const session = opened.session;

  // A push tap for another bot: select it. The old bug unmounted Call here.
  await call(page, "__select", "bot-2");
  await expect(page.getByTestId("call-bar")).toBeVisible();
  // The exact trailing phrase depends on viewport width (callbar-review.md
  // I4/I5's md+ swap, CallControls.tsx's CallBarStrip); the lead sentence
  // does not.
  await expect(page.getByText(/On a call with Sable\./)).toBeVisible();
  await expect(page.locator("div.absolute.inset-0.z-30")).toHaveCount(0);
  await expect(page.getByTestId("thread-2")).toBeVisible();

  // Answer the other thread's approval while the call is collapsed.
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__thread2Approved)).toBe(true);

  // The native session never noticed: no second open, no close, same id —
  // the mic kept running the whole time this thread was on screen.
  const whileAway = await native(page);
  expect(whileAway.opens).toBe(1);
  expect(whileAway.session).toBe(session);
  expect(whileAway.log).not.toContain("close " + session);

  // Tap the bar: back to the full call screen, same session.
  await page.getByTestId("call-bar").click();
  await expect(page.locator('button[aria-label="Hang up"]')).toBeVisible();
  await expect(page.getByTestId("call-bar")).toHaveCount(0);
  expect((await native(page)).session).toBe(session);

  // And turns still work exactly as they did before any of this happened.
  h.heard.push("What's on my calendar?");
  h.replies.push([{ type: "sentence", text: "Nothing until three." }, { type: "done" }]);
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.hostBodies.find((b) => !b.warm)?.text, { timeout: 10_000 }).toBe("What's on my calendar?");
  await expect.poll(async () => (await native(page)).plays.at(-1)?.session).toBe(session);
  await expect.poll(async () => (await native(page)).log).toContain("clip ended");
  expect((await native(page)).opens).toBe(1);
});

test("iPhone: a refused microphone points to Settings, and Try again opens it natively", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__nativeOpenErrors = ["denied"]; });
  await harness(page, "ios", { ready: false });
  await expect(page.getByText("Allow the microphone for Murage in Settings, then try again", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  await expect(page.getByText("Allow the microphone for Murage in Settings, then try again", { exact: true })).toHaveCount(0);
  const n = await native(page);
  expect(n.opens).toBe(2);
  expect(n.contexts).toBe(0);
});

test("iPhone: an app that is not active yet is tried again when it comes back", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__nativeOpenErrors = ["inactive"]; });
  await harness(page, "ios", { ready: false });
  await expect.poll(async () => (await native(page)).opens).toBe(1);
  await page.waitForTimeout(300);
  expect((await native(page)).opens).toBe(1);
  await call(page, "__appResume");
  await expect.poll(async () => (await native(page)).session).toBe("s1");
  await expect.poll(() => page.evaluate(() => (window as any).__vadFrames ?? 0)).toBeGreaterThan(0);
  expect((await native(page)).contexts).toBe(0);
});

test("iPhone: an open cut short by an interruption, with no resume to follow, is tried again after 3 s", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__nativeOpenErrors = ["inactive"]; });
  await harness(page, "ios", { ready: false });
  await expect.poll(async () => (await native(page)).opens).toBe(1);
  await page.waitForTimeout(2_000);
  expect((await native(page)).opens).toBe(1);
  await expect.poll(async () => (await native(page)).session, { timeout: 5_000 }).toBe("s1");
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
  expect((await native(page)).opens).toBe(2);
  expect((await native(page)).contexts).toBe(0);
});

test("iPhone: an engine that cannot start falls back to today's web path", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__nativeOpenErrors = ["unavailable"]; });
  const lines = diag(page);
  const h = await harness(page, "ios");
  const n = await native(page);
  expect(n.opens).toBe(1);
  // getUserMedia and Web Audio, as a browser call
  expect(n.contexts).toBeGreaterThan(0);
  expect(lines).toContain("[call-diag] audio web, native unavailable");
  await call(page, "__setBot", { messages: [{ id: "r1", role: "bot", kind: "text", at: 1, text: "Booked Nara at 8pm for two." }] });
  await expect.poll(() => h.spoken).toEqual(["Booked Nara at 8pm for two."]);
  await expect.poll(() => page.evaluate(() => (window as any).__audioEls)).toBeGreaterThan(0);
  expect((await native(page)).plays).toEqual([]);
});

test("iPhone: an app build without the methods, or the switch turned off, keeps today's web path", async ({ page }) => {
  const lines = diag(page);
  await harness(page, "ios", { query: "&methods=none" });
  expect((await native(page)).opens).toBe(0);
  expect((await native(page)).contexts).toBeGreaterThan(0);
  expect(lines).toContain("[call-diag] audio web");

  await page.addInitScript(() => localStorage.setItem("murage.call.nativeAudio", "off"));
  await harness(page, "ios");
  expect((await native(page)).opens).toBe(0);
  expect((await native(page)).contexts).toBeGreaterThan(0);
});

test("a browser call whose microphone cannot open still asks an approval open at the start, and keeps the note", async ({ page }) => {
  await page.addInitScript((card) => {
    (window as any).__initialBot = { busy: true, messages: [card] };
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  }, approvalCard);
  const h = await harness(page, "linux", { ready: false });
  await expect.poll(() => h.spoken).toEqual([APPROVAL_PROMPT]);
  await expect(page.getByText("The microphone couldn't start. Check Microphone access for Murage.", { exact: true })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByText("The microphone couldn't start. Check Microphone access for Murage.", { exact: true })).toBeVisible();
  expect(h.spoken).toEqual([APPROVAL_PROMPT]);
});

test("iPhone: a hold and a resume that land together still bring the pulse back", async ({ page }) => {
  await harness(page, "ios");
  await call(page, "__setBot", { busy: true, messages: [{ id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } }] });
  await expect.poll(async () => (await native(page)).controls).toEqual(["pulseOn"]);
  // both events in one task: React renders once, and held is false before and after
  await page.evaluate(() => { (window as any).__hold("media-reset"); (window as any).__resumeEngine(); });
  await expect.poll(async () => (await native(page)).controls).toEqual(["pulseOn", "pulseOff", "pulseOn"]);
});

test("iPhone: with the host off, a hold while the engine works resumes to working, and the reply is spoken after", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__hostOff = true; });
  const h = await harness(page, "ios");
  await call(page, "__setBot", { busy: true, messages: [{ id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } }] });
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
  await call(page, "__hold", "interrupted");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await call(page, "__resumeEngine");
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
  await call(page, "__setBot", { busy: false, messages: [
    { id: "a1", role: "bot", kind: "activity", at: 1, tool: { name: "WebSearch", spoken: "searching the web" } },
    { id: "r1", role: "bot", kind: "text", at: 2, text: "Booked Nara at 8pm for two." },
  ] });
  await expect.poll(() => h.spoken.at(-1)).toBe("Booked Nara at 8pm for two.");
});

// ── Talking over the bot on the Flux path (Windows, Linux, the iPhone) ────
// Flux's line lands 1.5-3 s after the owner stops (the endpoint, the upload,
// the transcription), after the 2 s false-interruption timer. Heard live on
// an iPhone: the bot paused, carried on, and the late "stop" was then
// dropped as "no speech heard" because the speech was older than the window
// it was checked against. These drive the real CallView on the fake shell's
// mic frames (?os=ios), the same Flux code the desktops run.

/** The bot's pause, resume and stop, in order (the pulse left out). */
const speakerControls = async (page: Page) => (await native(page)).controls.filter((c) => c === "pause" || c === "resume" || c === "stop");

/** A call where the bot is saying one long sentence, past the echo warm-up.
 *  With `prompt`, the long sentence is an approval or a question being read
 *  (a card open as the call starts). */
async function botTalking(page: Page, options: { prompt?: Record<string, unknown>; ready?: boolean } = {}) {
  // a prompt is read as the call opens: its clip must be long from the start
  if (options.prompt) await page.addInitScript((card) => { (window as any).__initialBot = { busy: true, messages: [card] }; (window as any).__nativeClipMs = 30_000; }, options.prompt);
  const h = await harness(page, "ios", { ready: options.ready });
  await page.evaluate(() => ((window as any).__native.clipMs = 30_000));
  if (!options.prompt) {
    h.heard.push("What's on the board?");
    h.replies.push([{ type: "sentence", text: "Here is a long summary of the whole board." }, { type: "done" }]);
    await call(page, "__talk", 1_200);
    await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible({ timeout: 10_000 });
  }
  await expect.poll(async () => (await native(page)).log, { timeout: 10_000 }).toContain("play");
  // the echo canceller's warm-up (ECHO_WARMUP_MS): voice then is the bot
  await page.waitForTimeout(3_300);
  expect(await speakerControls(page)).toEqual([]);
  return h;
}

/** The owner talks for `ms`; resolves once the bot has paused, with when. */
async function talkOver(page: Page, ms: number) {
  await call(page, "__talk", ms);
  await expect.poll(() => speakerControls(page), { intervals: [50] }).toEqual(["pause"]);
  return Date.now();
}

test("Flux talk-over: a stop that is transcribed 2.5 s after the voice ended still stops the bot", async ({ page }) => {
  const h = await botTalking(page);
  const asked = h.hostBodies.length;
  h.heard.push("stop");
  h.transcribeDelayMs = 2_000;
  await talkOver(page, 500);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({ timeout: 8_000 });
  // held until the line came, never resumed, then stopped for good
  expect(await speakerControls(page)).toEqual(["pause", "stop"]);
  await page.waitForTimeout(500);
  expect(h.hostBodies.length).toBe(asked);
});

test("Flux talk-over: a correction transcribed late is the owner's next turn", async ({ page }) => {
  const h = await botTalking(page);
  h.heard.push("no, just the first meeting");
  h.replies.push([{ type: "sentence", text: "Sure." }, { type: "done" }]);
  h.transcribeDelayMs = 2_000;
  await talkOver(page, 900);
  await expect.poll(() => h.hostBodies.filter((b) => !b.warm).at(-1)?.text, { timeout: 8_000 }).toBe("no, just the first meeting");
  const controls = await speakerControls(page);
  expect(controls.slice(0, 2)).toEqual(["pause", "stop"]);
  expect(controls).not.toContain("resume");
});

test("Flux talk-over: a cough (voice, then nothing transcribed) resumes the bot once the line is in", async ({ page }) => {
  const h = await botTalking(page);
  const asked = h.hostBodies.length;
  h.heard.push("");
  h.transcribeDelayMs = 3_000;
  const pausedAt = await talkOver(page, 400);
  // past the old 2 s timer: still holding, the transcription is not in
  await page.waitForTimeout(Math.max(0, pausedAt + 3_200 - Date.now()));
  expect(await speakerControls(page)).toEqual(["pause"]);
  await expect.poll(() => speakerControls(page), { timeout: 5_000 }).toEqual(["pause", "resume"]);
  await expect(page.getByText("Here is a long summary of the whole board.")).toBeVisible();
  expect(h.hostBodies.length).toBe(asked);
});

test("Flux talk-over: a transcription that never answers resumes the bot at the cap", async ({ page }) => {
  const h = await botTalking(page);
  let answer = () => {};
  h.transcribeWait = new Promise<void>((resolve) => (answer = resolve));
  const pausedAt = await talkOver(page, 400);
  let resumedAt = 0;
  while (!resumedAt && Date.now() - pausedAt < 9_000) {
    if ((await speakerControls(page)).includes("resume")) resumedAt = Date.now();
    else await page.waitForTimeout(100);
  }
  // held well past the 2 s timer, and carried on by the cap: 6 s after the
  // voice ended (about 0.7 s after the pause)
  expect(resumedAt - pausedAt).toBeGreaterThan(5_500);
  expect(resumedAt - pausedAt).toBeLessThan(8_500);
  expect(await speakerControls(page)).toEqual(["pause", "resume"]);
  answer();
});

test("Flux talk-over: a long correction (4 s) transcribed late stops the bot once, never resuming it over the owner", async ({ page }) => {
  const h = await botTalking(page);
  h.heard.push("no, I meant the one on Tuesday with Sarah");
  h.replies.push([{ type: "sentence", text: "Sure." }, { type: "done" }]);
  h.transcribeDelayMs = 2_500;
  await talkOver(page, 4_000);
  await expect.poll(() => h.hostBodies.filter((b) => !b.warm).at(-1)?.text, { timeout: 12_000 }).toBe("no, I meant the one on Tuesday with Sarah");
  const controls = await speakerControls(page);
  expect(controls.slice(0, 2)).toEqual(["pause", "stop"]);
  expect(controls).not.toContain("resume");
});

test("Flux talk-over: a transcription that fails resumes the bot at once, not at the cap", async ({ page }) => {
  const h = await botTalking(page);
  const asked = h.hostBodies.length;
  h.transcribeDelayMs = 2_500;
  // a refusal, not a 5xx: a 5xx is asked once more (callbar-rereview3.md A5)
  h.transcribeStatus = 413;
  const pausedAt = await talkOver(page, 400);
  await expect.poll(() => speakerControls(page), { timeout: 8_000, intervals: [50] }).toEqual(["pause", "resume"]);
  // the failure lands about 0.7 + 0.85 + 2.5 s after the pause; the cap would be ~6.7 s
  expect(Date.now() - pausedAt).toBeLessThan(5_500);
  expect(h.hostBodies.length).toBe(asked);
});

test("Flux talk-over: a hold while the transcript is awaited drops it, and nothing resumes or answers after", async ({ page }) => {
  const h = await botTalking(page);
  const asked = h.hostBodies.length;
  h.heard.push("no, just the first meeting");
  h.transcribeDelayMs = 2_500;
  await talkOver(page, 400);
  await page.waitForTimeout(2_800); // past the 2 s timer: waiting on the transcript
  expect(await speakerControls(page)).toEqual(["pause"]);
  await call(page, "__hold", "interrupted");
  await expect(page.getByText("Call paused", { exact: true })).toBeVisible();
  await call(page, "__resumeEngine");
  await page.waitForTimeout(3_000);
  expect(await speakerControls(page)).not.toContain("resume");
  expect(h.hostBodies.length).toBe(asked);
});

test("Flux talk-over: a one-word yes over an approval being read answers it", async ({ page }) => {
  const h = await botTalking(page, { prompt: approvalCard });
  h.heard.push("yes");
  h.transcribeDelayMs = 2_000;
  await talkOver(page, 400);
  await expect.poll(async () => (await actions(page)).find((a) => a.type === "decideRequest"), { timeout: 8_000 }).toMatchObject({ requestId: "req-1", behavior: "allow" });
  expect(await speakerControls(page)).not.toContain("resume");
});

test("Flux talk-over: a one-word no over an approval being read denies it", async ({ page }) => {
  const h = await botTalking(page, { prompt: approvalCard });
  h.heard.push("no");
  h.transcribeDelayMs = 2_000;
  await talkOver(page, 400);
  await expect.poll(async () => (await actions(page)).find((a) => a.type === "decideRequest"), { timeout: 8_000 }).toMatchObject({ requestId: "req-1", behavior: "deny" });
  expect(await speakerControls(page)).not.toContain("resume");
});

test("Flux talk-over: a one-word answer over a question being read answers it", async ({ page }) => {
  const card = { id: "q1", role: "bot", kind: "options", at: 1, card: { requestId: "req-q", subtitle: "Which day works for the review", options: ["Monday", "Tuesday"] } };
  const h = await botTalking(page, { prompt: card });
  // a spoken answer goes through the thread's respond action with the
  // original requestId, never an ordinary send (callbar-rereview3.md A2)
  const posts: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  await page.route("**/api/threads/*/respond", async (route: Route) => {
    posts.push({ url: route.request().url(), body: JSON.parse(route.request().postData() ?? "{}"), headers: route.request().headers() });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  h.heard.push("Tuesday");
  h.transcribeDelayMs = 2_000;
  await talkOver(page, 400);
  await expect.poll(() => posts[0], { timeout: 8_000 }).toMatchObject({ body: { requestId: "req-q", behavior: "answer", message: "Tuesday" } });
  expect(posts[0].url).toContain("/api/threads/thread-1/respond");
  // the desktop's proof rides along, or the harness answers 403 (review C1)
  expect(posts[0].headers).toMatchObject({ "x-murage-surface": "desktop", "x-murage-surface-secret": "fixture-surface-secret" });
  expect(await speakerControls(page)).not.toContain("resume");
});

test("a spoken answer to a question is not followed by the question read out again (review I-a)", async ({ page }) => {
  const h = await harness(page, "ios");
  const card = { id: "q1", role: "bot", kind: "options", at: 1, card: { requestId: "req-q", subtitle: "Which day works for the review", options: ["Monday", "Tuesday"] } };
  const posts: string[] = [];
  // the server accepts it but its update has not arrived: the card stays open
  await page.route("**/api/threads/*/respond", async (route: Route) => {
    posts.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await call(page, "__setBot", { messages: [card] });
  const asks = () => h.spoken.filter((t) => t.includes("asks:")).length;
  await expect.poll(asks, { timeout: 10_000 }).toBe(1);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({ timeout: 10_000 });
  h.heard.push("Tuesday");
  await call(page, "__talk", 1_200);
  await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(2_500);
  expect(asks()).toBe(1);
});

test("a spoken answer the server refuses is asked again, with a word that it did not go through (review I3)", async ({ page }) => {
  const card = { id: "q1", role: "bot", kind: "options", at: 1, card: { requestId: "req-q", subtitle: "Which day works for the review", options: ["Monday", "Tuesday"] } };
  const h = await botTalking(page, { prompt: card });
  let posts = 0;
  await page.route("**/api/threads/*/respond", async (route: Route) => {
    posts += 1;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"later"}' });
  });
  h.heard.push("Tuesday");
  h.transcribeDelayMs = 500;
  await talkOver(page, 400);
  await expect.poll(() => posts, { timeout: 8_000 }).toBe(1);
  await expect.poll(() => h.spoken.some((t) => t.startsWith("That answer didn't go through.")), { timeout: 10_000 }).toBe(true);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("a spoken answer the server refuses for good is said once, left to the screen, and not asked again (review M-a)", async ({ page }) => {
  const h = await harness(page, "ios");
  const card = { id: "q1", role: "bot", kind: "options", at: 1, card: { requestId: "req-q", subtitle: "Which day works for the review", options: ["Monday", "Tuesday"] } };
  let posts = 0;
  await page.route("**/api/threads/*/respond", async (route: Route) => {
    posts += 1;
    await route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"no"}' });
  });
  await call(page, "__setBot", { messages: [card] });
  const asks = () => h.spoken.filter((t) => t.includes("asks:")).length;
  await expect.poll(asks, { timeout: 10_000 }).toBe(1);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({ timeout: 10_000 });
  h.heard.push("Tuesday");
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.spoken.some((t) => t.startsWith("I couldn't send that answer from the call.")), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(2_500);
  expect(posts).toBe(1);
  expect(asks()).toBe(1);
  expect(h.spoken.some((t) => t.includes("didn't go through"))).toBe(false);
});

test("after a refused answer, a second open question is still read aloud (review M-d)", async ({ page }) => {
  const h = await harness(page, "ios");
  const q = (id: string, req: string, subtitle: string) => ({ id, role: "bot", kind: "options", at: id === "q1" ? 1 : 2, card: { requestId: req, subtitle, options: ["Yes", "No"] } });
  await page.route("**/api/threads/*/respond", (route: Route) => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"no"}' }));
  await call(page, "__setBot", { messages: [q("q1", "req-a", "Which day works")] });
  await expect.poll(() => h.spoken.filter((t) => t.includes("Which day works")).length, { timeout: 10_000 }).toBe(1);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({ timeout: 10_000 });
  h.heard.push("Tuesday");
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.spoken.some((t) => t.startsWith("I couldn't send that answer")), { timeout: 10_000 }).toBe(true);
  await call(page, "__setBot", { messages: [q("q1", "req-a", "Which day works"), q("q2", "req-b", "Should I book it")] });
  await expect.poll(() => h.spoken.some((t) => t.includes("Should I book it")), { timeout: 10_000 }).toBe(true);
});

test("a refused answer's line waits for speech already playing instead of cutting it off (review M-e)", async ({ page }) => {
  const h = await harness(page, "ios");
  const card = { id: "q1", role: "bot", kind: "options", at: 1, card: { requestId: "req-q", subtitle: "Which day works", options: ["Monday", "Tuesday"] } };
  let posted = false;
  await page.route("**/api/threads/*/respond", async (route: Route) => {
    posted = true;
    await new Promise((r) => setTimeout(r, 3_500));
    await route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"no"}' });
  });
  await call(page, "__setBot", { messages: [card] });
  await expect.poll(() => h.spoken.filter((t) => t.includes("Which day works")).length, { timeout: 10_000 }).toBe(1);
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({ timeout: 10_000 });
  h.heard.push("Tuesday");
  await call(page, "__talk", 1_200);
  await expect.poll(() => posted, { timeout: 10_000 }).toBe(true);
  // a long reply starts while the POST is out
  await page.evaluate(() => ((window as any).__native.clipMs = 6_000));
  await call(page, "__setBot", { messages: [card, { id: "r1", role: "bot", kind: "text", at: 2, text: "Booked Nara at 8pm for two." }] });
  await expect.poll(() => h.spoken.includes("Booked Nara at 8pm for two."), { timeout: 10_000 }).toBe(true);
  const stopsBefore = (await native(page)).controls.filter((c: string) => c === "stop").length;
  await page.waitForTimeout(3_500);
  // the refusal landed during that reply: it is not cut off for the line
  expect((await native(page)).controls.filter((c: string) => c === "stop").length).toBe(stopsBefore);
  await page.evaluate(() => ((window as any).__native.clipMs = 60));
  await expect.poll(() => h.spoken.some((t) => t.startsWith("I couldn't send that answer")), { timeout: 20_000 }).toBe(true);
});

test("iPhone: a transcription that fails twice shows why, and the call listens again (review I2)", async ({ page }) => {
  const h = await harness(page, "ios");
  h.transcribeStatus = 502;
  h.heard.push("What's on the board?");
  await call(page, "__talk", 1_200);
  await expect.poll(() => h.transcribed.length, { timeout: 10_000 }).toBe(2);
  await expect(page.getByText("Couldn't reach Murage to transcribe that.")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Listening", { exact: true })).toBeVisible();
});

test("Flux talk-over: outside a prompt, a spoken one-word line is a turn, and a yes is only listening", async ({ page }) => {
  const h = await botTalking(page);
  const asked = h.hostBodies.length;
  // "yeah": a listening noise; the bot carries on once the line is in
  h.heard.push("yeah");
  h.transcribeDelayMs = 2_000;
  await talkOver(page, 400);
  await expect.poll(() => speakerControls(page), { timeout: 8_000 }).toEqual(["pause", "resume"]);
  expect(h.hostBodies.length).toBe(asked);
  // "Tuesday": a word with speech behind it, the owner's turn
  await page.waitForTimeout(1_000);
  h.heard.push("Tuesday");
  h.replies.push([{ type: "sentence", text: "Tuesday it is." }, { type: "done" }]);
  await call(page, "__talk", 400);
  await expect.poll(() => h.hostBodies.filter((b) => !b.warm).at(-1)?.text, { timeout: 8_000 }).toBe("Tuesday");
  expect((await speakerControls(page)).slice(0, 4)).toEqual(["pause", "resume", "pause", "stop"]);
});

test("Flux talk-over: without a speech model, a one-word line is still taken for a noise", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__noVad = true; });
  const h = await botTalking(page, { ready: false });
  const asked = h.hostBodies.length;
  h.heard.push("Tuesday");
  h.transcribeDelayMs = 1_000;
  await talkOver(page, 900);
  await expect.poll(() => speakerControls(page), { timeout: 8_000 }).toEqual(["pause", "resume"]);
  expect(h.hostBodies.length).toBe(asked);
});

// ── App-level wiring: the call survives a selection change ────────────────
// (callbar-review.md I1, I3, I7). Everything above drives CallOverlay
// directly, with `@/lib/call` faked to a single hard-coded bot — exactly
// right for CallView's own turn-taking logic, but it cannot exercise the
// actual moss-approval-bug fix, which lives in App.tsx's Shell: mounting
// the call keyed to `useOnCall()` rather than the selection, with
// `key={activeCallId}` and a portal into whichever chat/room slot is on
// screen. This runs the REAL `@/lib/call`, `CallControls.tsx`,
// `CallView.tsx` and `src/lib/call-slot.ts` against a thin harness that
// mirrors App.tsx's overlay block — "a thin harness around App's overlay
// block," per the review's own suggested alternative to mounting the
// whole app (a fake store stands in for the rest, which nothing here
// depends on).
test.describe("the call survives a selection change (callbar-review.md I1, I3, I7)", () => {
  let wiringServer: ViteDevServer;
  let wiringOrigin: string;
  let wiringCache: string;

  test.beforeAll(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    wiringCache = mkdtempSync(join(tmpdir(), "murage-call-wiring-"));
    wiringServer = await createServer({
      configFile: false, root, cacheDir: wiringCache, envFile: false,
      // react-dom (not just react-dom/client): CallView.tsx/GroupCallView.tsx
      // import createPortal from "react-dom" (callbar-review.md I3), and an
      // un-pre-bundled import of it does not expose a named export here.
      optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] },
      resolve: { alias: { "@": `${root}/src` } },
      server: { host: "127.0.0.1", watch: null, hmr: false },
      plugins: [tailwindcss(), {
        name: "call-wiring-fixture", enforce: "pre",
        resolveId(id) {
          // @/lib/call is NOT stubbed here — the whole point is to prove
          // the real module, mounted the real way, keeps a call alive
          // across a selection change.
          const map: Record<string, string> = { "@/state/store": "store", "@/lib/push-to-talk": "push", "@/components/DesktopCapabilities": "caps" };
          for (const [alias, key] of Object.entries(map)) if (id === alias || id.endsWith("/src/" + alias.slice(2))) return "\0wiring-" + key;
          if (id === "./DesktopCapabilities") return "\0wiring-caps";
          if (id === "./silero-vad") return "\0wiring-vad";
          if (id === "/__wiring.js") return "\0wiring-entry";
        },
        load(id) {
          if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
          if (id === "\0wiring-push") return `export const usePushToTalk=()=>false;`;
          if (id === "\0wiring-vad") return `export const SPEECH_CONFIDENCE=0.7;export class SileroVad{static async load(){return new SileroVad()}async push(){return 0}reset(){}}`;
          if (id === "\0wiring-caps") return `export const useDesktopCapabilities=()=>({ready:true,capabilities:{dictation:{available:false},host:{platform:"darwin"}}});`;
          if (id === "\0wiring-store") return `
import { useSyncExternalStore } from "react";
const listeners = new Set();
window.__state = {
  bots: [
    { id: "moss", name: "Moss", color: "blue", busy: false, threadId: "moss-thread", voice: "v1", messages: [] },
    { id: "sable", name: "Sable", color: "green", busy: false, threadId: "sable-thread", voice: "v2", messages: [] },
  ],
  groups: [
    { id: "room1", name: "Room One", dm: false, busyBotId: null, working: false, messages: [], memberIds: ["moss", "sable"], defaultResponder: null, threadId: "room1-thread" },
  ],
  selectedId: "moss",
  // CallOverlaySlot (the real component, callbar-rereview.md I7) only
  // shows the full screen on "chat" (N4's guard against another view
  // entirely covering the call) -- the real store's own select action
  // always carries this, so the fake one below matches it.
  activeView: "chat",
  config: { tts: { configured: true, ready: true, routes: { host: "flux", lookup: "flux", speech: "flux", transcribe: "flux" } } },
};
window.__actions = [];
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const getSnapshot = () => window.__state;
const notify = () => { for (const l of listeners) l(); };
const dispatch = (a) => {
  window.__actions.push(a);
  if (a.type === "select") { window.__state = { ...window.__state, selectedId: a.id, activeView: "chat" }; notify(); }
};
window.__select = (id) => dispatch({ type: "select", id });
export const viewedTaskBot = (bot) => bot;
export const visibleMessages = (bot) => bot.messages;
export const useStore = () => ({ state: useSyncExternalStore(subscribe, getSnapshot, getSnapshot), dispatch });
export const api = async () => ({});
`;
          if (id !== "\0wiring-entry") return;
          return `
import React from "react"; import { createRoot } from "react-dom/client";
import { useStore } from "@/state/store";
import { startCall, endCall, currentCall } from "@/lib/call";
// callbar-rereview.md I7: CallOverlaySlot and CallButton are the REAL
// production components (App.tsx's Shell mounts the former; the header
// mounts the latter) — not hand-copied stand-ins. Reverting the \`key\` fix,
// the end-first logic, or CallView.tsx/GroupCallView.tsx's portal now fails
// this suite the same way it fails the real app, because this IS the real
// app's code, just wired to a fake store.
import { CallOverlaySlot, CallButton, CallBarStrip } from "/src/components/CallControls.tsx";
import { registerCallSlot } from "/src/lib/call-slot.ts";
import "/src/styles.css";
window.__startCall = startCall;
window.__endCall = endCall;
window.__currentCall = currentCall;
function Shell() {
  const { state, dispatch } = useStore();
  const slotRef = React.useRef(null);
  React.useEffect(() => { registerCallSlot(slotRef.current); return () => registerCallSlot(null); }, []);
  return React.createElement(
    "div",
    { style: { display: "flex", width: "100vw", height: "100vh" } },
    // The sidebar: outside the call slot, so a portal into the slot must
    // never cover it (callbar-review.md I3). Each bot's real CallButton
    // lives here too, exactly like the header does in production — a
    // click runs CallTargetButton's actual end-first logic (I1), not a
    // re-implementation of it.
    React.createElement(
      "div",
      { style: { width: "220px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "8px" } },
      React.createElement("button", { "data-testid": "sidebar-button", onClick: () => window.__actions.push({ type: "sidebarClicked" }) }, "Sidebar"),
      state.bots.map((bot) => React.createElement(CallButton, { key: bot.id, bot })),
    ),
    // The chat column: the call's full screen portals inside this box
    // only, matching ChatView's own "relative" chat-column (ChatView.tsx).
    React.createElement(
      "div",
      { style: { position: "relative", flex: 1 } },
      // The strip: ChatView/GroupView's own job in production (CallControls.tsx).
      // ownThreadId, like ChatView/GroupView really pass, so the strip
      // hides on the call's own thread and shows everywhere else (N3) --
      // without it the strip never hides and masks what the full screen
      // itself is doing underneath.
      React.createElement(CallBarStrip, {
        ownId: state.selectedId,
        ownThreadId: state.bots.find((b) => b.id === state.selectedId)?.threadId ?? state.groups.find((g) => g.id === state.selectedId)?.threadId,
      }),
      React.createElement("div", { ref: slotRef, style: { position: "absolute", inset: 0, pointerEvents: "none" } }),
    ),
    // Mounted once, keyed to the call's own target — App.tsx's own Shell
    // mounts this exact component the same way (callbar-rereview.md I7).
    React.createElement(CallOverlaySlot, { state, dispatch }),
  );
}
const root = createRoot(document.getElementById("root")); root.render(React.createElement(Shell));
window.__unmount = () => root.unmount();`;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__wiring") return next();
            res.setHeader("content-type", "text/html");
            res.end(`<div id="root"></div><script>${BRIDGE}</script><script type="module" src="/__wiring.js"></script>`);
          });
        },
      }],
    });
    await wiringServer.listen(0);
    const address = wiringServer.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    wiringOrigin = `http://127.0.0.1:${address.port}`;
  });
  test.afterAll(async () => { await wiringServer?.close(); safeWipeSync(wiringCache); });

  const wiringNative = (page: Page) =>
    page.evaluate(() => {
      const n = (window as any).__native;
      return {
        opens: n.opens as number,
        session: n.session as string | null,
        log: n.log as string[],
        callSessions: n.callSessions as string[],
      };
    });
  const sidebarClicks = (page: Page) =>
    page.evaluate(() => (window as any).__actions.filter((a: any) => a.type === "sidebarClicked").length);

  // The full screen's own root (CallView.tsx's `absolute inset-0 z-30`
  // wrapper): distinct from CallBarStrip's classes, so "full screen up"
  // and "bar up" are never ambiguous even though both carry a button whose
  // accessible name is "Hang up" (the strip has its own — CallControls.tsx).
  const fullScreen = (page: Page) => page.locator("div.absolute.inset-0.z-30");

  test("selecting another bot, then a room, collapses the call without ending it; the sidebar stays clickable", async ({ page }) => {
    await page.goto(`${wiringOrigin}/__wiring?os=ios`);
    await page.evaluate(() => (window as any).__startCall("moss"));
    await expect.poll(() => wiringNative(page).then((n) => n.opens)).toBe(1);
    await expect(fullScreen(page)).toBeVisible();
    const session = (await wiringNative(page)).session;

    // A push tap for Sable (what App.tsx's Shell does for any selection
    // change) must not touch the call at all.
    await page.evaluate(() => (window as any).__select("sable"));
    await expect(page.getByTestId("call-bar")).toBeVisible();
    await expect(fullScreen(page)).toHaveCount(0);
    expect((await wiringNative(page)).opens).toBe(1);
    expect((await wiringNative(page)).session).toBe(session);

    // The sidebar, outside the call's slot, stays reachable the whole
    // time (callbar-review.md I3) — proven while collapsed…
    await page.getByTestId("sidebar-button").click();
    await expect.poll(() => sidebarClicks(page)).toBe(1);

    // …and selecting a room (not just another bot) keeps the call alive too.
    await page.evaluate(() => (window as any).__select("room1"));
    await expect(page.getByTestId("call-bar")).toBeVisible();
    expect((await wiringNative(page)).opens).toBe(1);
    expect((await wiringNative(page)).session).toBe(session);

    // Tap the bar: back to the full screen, same session — and the
    // sidebar is still reachable (the full screen only ever portals into
    // the chat column, never covers it).
    await page.getByTestId("call-bar").click();
    await expect(fullScreen(page)).toBeVisible();
    expect((await wiringNative(page)).session).toBe(session);
    await page.getByTestId("sidebar-button").click();
    await expect.poll(() => sidebarClicks(page)).toBe(2);
  });

  test("calling a different bot while one call is collapsed ends it first, instead of inheriting its state", async ({ page }) => {
    await page.goto(`${wiringOrigin}/__wiring?os=ios`);
    await page.evaluate(() => (window as any).__startCall("moss"));
    await expect.poll(() => wiringNative(page).then((n) => n.opens)).toBe(1);
    await expect(fullScreen(page)).toBeVisible();
    const mossSession = (await wiringNative(page)).session;
    // callSessionOpen for Moss (callbar-rereview.md M4's native signal,
    // wired through the real @/lib/call.ts, not a stub).
    await expect.poll(() => wiringNative(page).then((n) => n.callSessions)).toEqual(["open"]);

    // Moss's call is held (a background, an interruption…) before the
    // owner ever leaves it.
    await page.evaluate(() => {
      const n = (window as any).__native;
      n.held = true;
      for (const h of [...n.handlers.callAudio]) h({ type: "hold", session: n.session, reason: "interrupted" });
    });
    await expect(page.getByText("Call paused", { exact: true })).toBeVisible();

    // Collapse Moss (select Sable), then press Sable's REAL call button
    // (CallButton/CallTargetButton, CallControls.tsx) — the fix: end
    // Moss's call first and mount Sable's fresh (`key={activeCallId}`),
    // instead of reusing the same `Call` instance and inheriting its
    // "paused" state (callbar-review.md I1). A real click, not a call into
    // `@/lib/call` that skips CallTargetButton's own onClick handler
    // entirely (callbar-rereview.md I7) — so reverting its end-first logic
    // fails this test.
    await page.evaluate(() => (window as any).__select("sable"));
    await page.getByTestId("call-button-sable").click();
    await expect.poll(() => wiringNative(page).then((n) => n.opens)).toBe(2);
    expect(await page.evaluate(() => (window as any).__currentCall())).toBe("sable");
    // Moss's own session was actually closed, not just superseded in the UI
    // while its native call audio kept running underneath (the key fix
    // alone forces a fresh mount for the new target regardless of this, so
    // this checks the OTHER half of the fix on its own).
    expect((await wiringNative(page)).log).toContain(`close ${mossSession}`);
    // The real end-first ordering (CallTargetButton's onClick,
    // callbar-review.md I1): endCall(moss) fires -- and so callSessionClose
    // -- BEFORE startCall(sable)'s callSessionOpen, not just an open with no
    // matching close. Skipping the explicit endCall (reverting the
    // end-first logic) drops this "close" entry even though the key still
    // forces Sable's Call to mount fresh -- this is the one signal that
    // catches THAT revert on its own, independent of the key.
    await expect.poll(() => wiringNative(page).then((n) => n.callSessions)).toEqual(["open", "close", "open"]);
    // Sable's own thread is selected and its call is not collapsed, so this
    // is the full screen talking, not the bar (a bar's similarly worded
    // "Call with Sable paused." must not be mistaken for a fresh mount).
    await expect(fullScreen(page)).toBeVisible();
    // A fresh mount: not stuck on Moss's held state. Scoped to the full
    // screen itself, not the whole page: the bar's own text ("Call with
    // Sable paused.") is deliberately worded differently, but scoping
    // guards against that ever changing to coincide.
    await expect(fullScreen(page).getByText("Call paused", { exact: true })).toHaveCount(0);
  });
});

// ── A room call (GroupCallView.tsx) through the voice host ────────────────
// The room's own fixture: GroupCall mounted directly with a fake store and
// the same fake bridge as above, so the owner's words arrive the Mac way.
test.describe("room call", () => {
  let roomServer: ViteDevServer;
  let roomOrigin: string;
  let roomCache: string;

  const ROOM_STORE = `
import { useSyncExternalStore } from "react";
const listeners = new Set();
window.__room = {
  group: { id: "room1", name: "Launch", dm: false, threadId: "room1-thread", busyBotId: null, working: false, messages: [], memberIds: ["moss", "sable"], defaultResponder: { kind: "member", botId: "moss" } },
  members: [
    { id: "moss", name: "Moss", color: "blue", voice: "v1", threadId: "moss-thread", messages: [] },
    { id: "sable", name: "Sable", color: "green", voice: "v2", threadId: "sable-thread", messages: [] },
  ],
};
window.__actions = [];
window.__config = { tts: { configured: true, ready: true, routes: { host: "flux", lookup: "flux", speech: "flux", transcribe: "flux" } } };
if (window.__hostOff) delete window.__config.tts.routes.host;
window.__streaming = {};
const notify = () => { for (const l of listeners) l(); };
window.__setGroup = (patch) => { window.__room = { ...window.__room, group: { ...window.__room.group, ...patch } }; notify(); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const dispatch = (a) => {
  window.__actions.push(a);
  if (a.type === "sendGroup" && window.__refuseSends) setTimeout(() => a.onError?.(new Error(window.__refuseSends)), 20);
  else if (a.type === "sendGroup") setTimeout(() => a.onReceipt?.({ sendId: a.sendId, queued: Boolean(window.__queueSends), requestId: "req-" + a.sendId }), 20);
};
export const useStore = () => ({ state: { config: window.__config }, dispatch });
export const useStreaming = () => ({ streaming: useSyncExternalStore(subscribe, () => window.__streaming) });
export const api = async () => ({});
export const visibleMessages = (bot) => bot.messages;
export const viewedTaskBot = (bot) => bot;
export const useFixtureRoom = () => useSyncExternalStore(subscribe, () => window.__room);
`;

  test.beforeAll(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    roomCache = mkdtempSync(join(tmpdir(), "murage-room-call-"));
    roomServer = await createServer({
      configFile: false, root, cacheDir: roomCache, envFile: false,
      optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] },
      resolve: { alias: { "@": `${root}/src` } },
      server: { host: "127.0.0.1", watch: null, hmr: false },
      plugins: [tailwindcss(), {
        name: "room-call-fixture", enforce: "pre",
        resolveId(id) {
          const map: Record<string, string> = { "@/state/store": "store", "@/lib/call": "call", "@/lib/push-to-talk": "push" };
          for (const [alias, key] of Object.entries(map)) if (id === alias || id.endsWith("/src/" + alias.slice(2))) return "\0room-" + key;
          if (id === "/__room.js") return "\0room-entry";
        },
        load(id) {
          if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
          if (id === "\0room-store") return ROOM_STORE;
          if (id === "\0room-push") return `export const usePushToTalk=()=>false;`;
          if (id === "\0room-call") return `export const useOnCall=()=>"room1";export const currentCall=()=>"room1";export const deferCallCleanup=()=>{};export const endCall=()=>{};export const startCall=()=>{};export const takeCallRequest=()=>false;export const useCallRequest=()=>null;`;
          if (id !== "\0room-entry") return;
          return `
import React from "react"; import { createRoot } from "react-dom/client";
import { useFixtureRoom } from "@/state/store"; import { GroupCall } from "/src/components/GroupCallView.tsx"; import { registerCallSlot } from "/src/lib/call-slot.ts"; import "/src/styles.css";
function Fixture() {
  const room = useFixtureRoom();
  const slotRef = React.useRef(null);
  React.useEffect(() => { registerCallSlot(slotRef.current); return () => registerCallSlot(null); }, []);
  return React.createElement(React.Fragment, null,
    React.createElement("div", { ref: slotRef, style: { position: "fixed", inset: 0, pointerEvents: "none" } }),
    React.createElement(GroupCall, { group: room.group, members: room.members }));
}
createRoot(document.getElementById("root")).render(React.createElement(Fixture));`;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/__room") return next();
            res.setHeader("content-type", "text/html");
            res.end(`<div id="root"></div><script>${BRIDGE}</script><script type="module" src="/__room.js"></script>`);
          });
        },
      }],
    });
    await roomServer.listen(0);
    const address = roomServer.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    roomOrigin = `http://127.0.0.1:${address.port}`;
  });
  test.afterAll(async () => { await roomServer?.close(); safeWipeSync(roomCache); });

  async function roomHarness(page: Page, options: { hostOff?: boolean } = {}) {
    const spoken: string[] = [];
    const cues: string[] = [];
    const hostBodies: any[] = [];
    const hostBots: string[] = [];
    const replies: Array<Array<Record<string, unknown>>> = [];
    if (options.hostOff) await page.addInitScript(() => { (window as any).__hostOff = true; });
    await page.route("**/api/tts/speak", async (route: Route) => {
      const text = JSON.parse(route.request().postData() ?? "{}").text;
      (ACK_PHRASES.has(text) ? cues : spoken).push(text);
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav(text === "Mm." ? CUE_SAMPLES : undefined) });
    });
    await page.route("**/api/tts/prepare", async (route: Route) => {
      const text = JSON.parse(route.request().postData() ?? "{}").text;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ready: true, utterances: [text] }) });
    });
    await page.route("**/api/bots/*/voice-host", async (route: Route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.warm) return route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
      hostBodies.push(body);
      hostBots.push(new URL(route.request().url()).pathname.split("/")[3]);
      const events = replies.shift() ?? [{ type: "done" }];
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    });
    await page.goto(`${roomOrigin}/__room`);
    await expect(page.locator('button[aria-label="Hang up"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__speech.starts)).toBeGreaterThan(0);
    return { spoken, cues, hostBodies, hostBots, replies };
  }
  const roomSay = (page: Page, text: string, partial = false) => page.evaluate(([t, p]) => (window as any).__say(t, p), [text, partial] as const);
  const roomActions = (page: Page) => page.evaluate(() => (window as any).__actions as Array<Record<string, any>>);
  const listening = (page: Page) => page.evaluate(() => Boolean((window as any).__speech.running));
  const sends = async (page: Page) => (await roomActions(page)).filter((a) => a.type === "sendGroup").map((a) => a.text);

  test("everyone goes to the members' engines, as before, and no voice is asked", async ({ page }) => {
    const h = await roomHarness(page);
    await roomSay(page, "everyone, where are we?");
    await expect.poll(() => sends(page)).toEqual(["@everyone where are we?"]);
    expect(h.hostBodies).toEqual([]);
  });

  test("the member named answers through the voice host, in the room, and nothing goes to the engines", async ({ page }) => {
    const h = await roomHarness(page);
    h.replies.push([{ type: "sentence", text: "Two launches are left this week." }, { type: "done" }]);
    await roomSay(page, "Sable, what's left this week?");
    await expect.poll(() => h.spoken).toContain("Two launches are left this week.");
    expect(h.hostBots).toEqual(["sable"]);
    expect(h.hostBodies[0]).toMatchObject({ text: "what's left this week?", groupId: "room1", threadId: "room1-thread", history: [], handDowns: [], roomHeard: [] });
    expect(await sends(page)).toEqual([]);
    await expect.poll(() => listening(page)).toBe(true);
  });

  test("a line for nobody in particular goes to the lead's voice", async ({ page }) => {
    const h = await roomHarness(page);
    h.replies.push([{ type: "sentence", text: "Moss here, all good." }, { type: "done" }]);
    await roomSay(page, "how are we doing?");
    await expect.poll(() => h.spoken).toContain("Moss here, all good.");
    expect(h.hostBots).toEqual(["moss"]);
  });

  test("a hand-down goes to the room addressed to that member, and the mic stays open while it works", async ({ page }) => {
    const h = await roomHarness(page);
    h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "check the deploy" }, { type: "done" }]);
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => sends(page)).toEqual(["Sable, check the deploy"]);
    await expect.poll(() => h.spoken).toContain("Let me look into that.");
    await page.evaluate(() => (window as any).__setGroup({ busyBotId: "sable", working: true }));
    await expect.poll(() => listening(page)).toBe(true);
    await page.waitForTimeout(500);
    expect(await listening(page)).toBe(true);
    // the next turn tells Sable's voice what it handed down
    h.replies.push([{ type: "sentence", text: "Still on it." }, { type: "done" }]);
    await roomSay(page, "Sable, how's it going?");
    await expect.poll(() => h.hostBodies.length).toBe(2);
    // what was sent is the owner's own words, verbatim, with its send receipt kept
    expect(h.hostBodies[1].handDowns).toMatchObject([{ request: "Sable, check the deploy", state: "accepted", sendId: expect.any(String) }]);
    expect(h.hostBodies[1].history).toMatchObject([{ role: "owner", text: "check the deploy" }, { role: "host", handDown: { request: "Sable, check the deploy" } }]);
  });

  test("a cancel reaches that member's queued request even while another member is busy", async ({ page }) => {
    const h = await roomHarness(page);
    await page.evaluate(() => { (window as any).__queueSends = true; });
    h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "check the deploy" }, { type: "done" }]);
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => sends(page)).toEqual(["Sable, check the deploy"]);
    await expect.poll(() => h.spoken).toContain("Let me look into that.");
    await page.evaluate(() => (window as any).__setGroup({ busyBotId: "moss", working: true }));
    await expect.poll(() => listening(page)).toBe(true);
    h.replies.push([{ type: "cancel" }, { type: "sentence", text: "Cancelled." }, { type: "done" }]);
    await roomSay(page, "Sable, cancel that");
    await expect.poll(async () => (await roomActions(page)).filter((a) => a.type === "cancelGroupQueued").length).toBe(1);
    const all = await roomActions(page);
    expect(all.find((a) => a.type === "cancelGroupQueued")).toMatchObject({ queueId: expect.stringMatching(/^req-/) });
    // Moss is the busy one: nothing running is interrupted
    expect(all.some((a) => a.type === "interruptGroup")).toBe(false);
  });

  test("a hand-down with nothing said still says On it", async ({ page }) => {
    const h = await roomHarness(page);
    h.replies.push([{ type: "hand_down", request: "check the deploy" }, { type: "done" }]);
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => h.spoken).toContain("On it.");
  });

  test("a hand-down the room refuses is said out loud by that member", async ({ page }) => {
    const h = await roomHarness(page);
    await page.evaluate(() => { (window as any).__refuseSends = "error: No model is connected."; });
    h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "check the deploy" }, { type: "done" }]);
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => h.spoken).toContain("I couldn't start that. No model is connected.");
  });

  test("a host failure hands the owner's words to the room, once", async ({ page }) => {
    const h = await roomHarness(page);
    h.replies.push([{ type: "error", reason: "upstream", message: "no" }, { type: "done" }]);
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => sends(page)).toEqual(["@Sable check the deploy"]);
    expect(h.hostBodies).toHaveLength(1);
    await page.waitForTimeout(300);
    expect(await sends(page)).toHaveLength(1);
  });

  test("with no voice host the room works as before", async ({ page }) => {
    const h = await roomHarness(page, { hostOff: true });
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => sends(page)).toEqual(["@Sable check the deploy"]);
    expect(h.hostBodies).toEqual([]);
  });

  test("the second member's voice is told what the first said on this call", async ({ page }) => {
    const h = await roomHarness(page);
    h.replies.push([{ type: "sentence", text: "Revenue is up four percent." }, { type: "done" }]);
    await roomSay(page, "Moss, how did the quarter go?");
    await expect.poll(() => h.spoken).toContain("Revenue is up four percent.");
    await expect.poll(() => listening(page)).toBe(true);
    h.replies.push([{ type: "sentence", text: "I agree." }, { type: "done" }]);
    await roomSay(page, "Sable, do you agree?");
    await expect.poll(() => h.hostBodies.length).toBe(2);
    expect(h.hostBodies[1].roomHeard).toEqual([{ member: "Moss", owner: "how did the quarter go?", reply: "Revenue is up four percent." }]);
    expect(h.hostBodies[1].history).toEqual([]);
  });

  test("a member's reply that lands while the owner is talking waits for them to finish", async ({ page }) => {
    const h = await roomHarness(page);
    await roomSay(page, "Moss, can you", true);
    await page.evaluate(() => (window as any).__setGroup({ messages: [{ id: "m1", role: "bot", kind: "text", text: "The deploy is green.", from: { botId: "sable", name: "Sable", color: "green" }, at: Date.now() }] }));
    await page.waitForTimeout(700);
    expect(h.spoken).not.toContain("The deploy is green.");
    expect(await listening(page)).toBe(true);
    h.replies.push([{ type: "sentence", text: "Sure, checking the logs." }, { type: "done" }]);
    await roomSay(page, "Moss, can you check the logs?");
    await expect.poll(() => h.spoken).toContain("The deploy is green.");
    await expect.poll(() => h.spoken).toContain("Sure, checking the logs.");
  });

  test("while a member works the owner sees that the room is listening and who is working", async ({ page }) => {
    const h = await roomHarness(page);
    h.replies.push([{ type: "sentence", text: "Let me look into that." }, { type: "hand_down", request: "check the deploy" }, { type: "done" }]);
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => h.spoken).toContain("Let me look into that.");
    await page.evaluate(() => (window as any).__setGroup({ busyBotId: "sable", working: true }));
    await expect(page.getByText("Listening · Sable is working")).toBeVisible();
  });

  test("interrupting while the host is still working aborts its request", async ({ page }) => {
    await roomHarness(page);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/bots/*/voice-host", async (route: Route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.warm) return route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
      await held;
      await route.abort().catch(() => {});
    });
    // the page's own view: did the signal it gave the host request fire?
    await page.evaluate(() => {
      const w = window as any;
      const realFetch = window.fetch.bind(window);
      w.__hostAborted = false;
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/voice-host") && !String(init?.body ?? "").includes("warm")) { w.__hostSent = true; init?.signal?.addEventListener("abort", () => { w.__hostAborted = true; }); }
        return realFetch(input, init);
      };
    });
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => page.evaluate(() => (window as any).__hostSent)).toBe(true);
    // another member is speaking when the owner cuts in
    await page.route("**/api/tts/speak", async () => {});
    await page.evaluate(() => (window as any).__setGroup({ messages: [{ id: "m9", role: "bot", kind: "text", text: "Almost there.", from: { botId: "moss", name: "Moss", color: "blue" }, at: Date.now() }] }));
    await page.getByRole("button", { name: "Interrupt" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__hostAborted)).toBe(true);
    release();
  });

  test("a call started before the config arrives uses the fast voice once it does", async ({ page }) => {
    const h = await roomHarness(page, { hostOff: true });
    await page.evaluate(() => { (window as any).__config = { tts: { configured: true, ready: true, routes: { host: "flux", lookup: "flux", speech: "flux", transcribe: "flux" } } }; (window as any).__setGroup({}); });
    h.replies.push([{ type: "sentence", text: "Checking now." }, { type: "done" }]);
    await roomSay(page, "Sable, check the deploy");
    await expect.poll(() => h.spoken).toContain("Checking now.");
    expect(h.hostBodies).toHaveLength(1);
    expect(await sends(page)).toEqual([]);
  });
});
