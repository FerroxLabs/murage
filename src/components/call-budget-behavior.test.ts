// Execute the views and their effects with a deterministic hook scheduler and
// isolated audio/bridge fixtures. No DOM layout or provider calls are involved.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false, state: {} as any, dispatch: vi.fn(), speak: vi.fn(), fetchClip: vi.fn(), close: vi.fn(), start: vi.fn(async () => {}), transcript: null as any, micEnd: null as any, micError: null as any, native: false, player: {} as any }));
vi.mock("react", async original => {
  const real = await original<any>();
  const memo = (factory: () => any, deps?: any[]) => {
    const i = h.cursor++;
    const old = h.slots[i];
    if (!old || !deps || deps.some((d, n) => !Object.is(d, old.deps?.[n]))) h.slots[i] = { value: factory(), deps };
    return h.slots[i].value;
  };
  const state = (initial: any) => {
    const i = h.cursor++;
    if (!h.slots[i]) h.slots[i] = { value: typeof initial === "function" ? initial() : initial };
    return [h.slots[i].value, (next: any) => { const value = typeof next === "function" ? next(h.slots[i].value) : next; if (!Object.is(value, h.slots[i].value)) { h.slots[i].value = value; h.dirty = true; } }];
  };
  return { ...real, useState: state, useReducer: (f: any, initial: any) => { const [v, set] = state(initial); return [v, (a: any) => set((s: any) => f(s, a))]; }, useRef: (v: any) => memo(() => ({ current: v }), []), useCallback: (f: any, d: any[]) => memo(() => f, d), useMemo: memo,
    useEffect: (f: any, deps: any[]) => { const i = h.cursor++; const old = h.slots[i]; if (!old || !deps || deps.some((d, n) => !Object.is(d, old.deps?.[n]))) { h.slots[i] = { deps, cleanup: old?.cleanup }; h.effects.push(() => { old?.cleanup?.(); h.slots[i].cleanup = f(); }); } },
  };
});
vi.mock("@/state/store", () => ({ useStore: () => ({ state: h.state, dispatch: h.dispatch }), useStreaming: () => ({ streaming: {} }), visibleMessages: (b: any) => b.messages, olderOpenCards: (_b: any, m: any) => m }));
vi.mock("@/lib/call-slot", () => ({ useCallSlot: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { dictation: { available: true }, capture: { available: true } } }) }));
vi.mock("@/lib/tts/useSpeech", () => ({ useSpeech: () => ({ status: "idle" }) }));
vi.mock("@/lib/push-to-talk", () => ({ usePushToTalk: () => ({}) }));
vi.mock("@/lib/plain-approval", () => ({ usePlainApprovalSettled: () => true, holdForPlainWords: () => false }));
vi.mock("@/lib/use-keyboard-hints", () => ({ useKeyboardHints: () => false }));
vi.mock("@/lib/tts", () => ({ onClipElement: () => () => {}, speaker: { stream: (o: any) => { queueMicrotask(() => o.onBudget?.()); return { push: vi.fn(), end: vi.fn(), done: Promise.resolve(false), heard: () => [], playingAt: () => null, firstClip: () => null, player: () => null }; }, speak: h.speak, fetchClip: h.fetchClip, stop: vi.fn(), resetBudgetHold: vi.fn(), isSpeaking: () => false, state: { status: "idle" }, setPlayer: vi.fn(), useOutput: vi.fn(), onChange: () => () => {} } }));
vi.mock("@/lib/call-audio", () => {
  const mic = { kind: "apple", duplex: true, start: h.start, stop: vi.fn(async () => {}), close: h.close, open: async () => {}, onLine: (f: any) => { h.transcript = f; return () => {}; }, onEnd: (f: any) => { h.micEnd = f; return () => {}; }, onError: (f: any) => { h.micError = f; return () => {}; }, onVoice: () => () => {}, onLevel: () => () => {} };
  return { micFor: () => mic, offerResumeWhenHeld: () => () => {}, CallAudio: class { path = h.native ? "native" : "web"; source = h.native ? { onEvent: () => () => {} } : null; player = () => h.player; pulse = vi.fn(); chosen = async () => this.path; setMuted = vi.fn(); mic = mic; open = async () => ({ kind: "web" }); close = h.close; } };
});
import { Call as CallView } from "./CallView";
import { GroupCall as GroupCallView } from "./GroupCallView";
import { callBudgetEnded, currentCall, endCall, startCall } from "@/lib/call";
let render: () => unknown;
async function flush() {
  for (let i = 0; i < 12; i++) {
    h.cursor = 0; h.dirty = false; render();
    const effects = h.effects.splice(0); effects.forEach(f => f());
    for (let j = 0; j < 10; j++) await Promise.resolve();
    if (!h.dirty) break;
  }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); h.close.mockReset(); h.slots = []; h.effects = []; h.cursor = 0; h.native = false;
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), muragebox: { speechStart: h.start, speechStop: h.close, onSpeechTranscript: (f: any) => { h.transcript = f; return () => {}; }, onSpeechEnd: () => () => {}, onSpeechError: (f: any) => { h.micError = f; return () => {}; } } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/calls/sessions" ? { callId: "fixture-session" } : {}))));
  vi.stubGlobal("location", { protocol: "http:", host: "fixture.invalid" });
  vi.stubGlobal("WebSocket", class { readyState = 0; close() { this.readyState = 3; } send() {} });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  h.state = { config: { tts: {} }, routines: [], bots: [], groups: [] };
  h.speak.mockImplementation(async () => {}); h.fetchClip.mockImplementation(async () => new Blob(["cue"]));
});
afterEach(() => { h.slots.forEach(s => s?.cleanup?.()); endCall(); vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const group of [false, true]) for (const source of ["engine", "speech"]) it(`${group ? "group" : "bot"} ${source} budget ends immediately even when closing speech stalls`, async () => {
  const bot: any = { id: "b", name: "Bot", threadId: "t", messages: [], tasks: [], busy: false };
  const room: any = { id: "g", name: "Room", threadId: "t", messages: [], members: ["b"] };
  h.state.bots = [bot]; h.state.groups = [room];
  const target = group ? room : bot;
  startCall(target.id);
  render = () => group ? GroupCallView({ group: room, members: [bot], collapsed: true }) : CallView({ bot, collapsed: true });
  await flush();
  let finishClosing!: () => void;
  h.speak.mockImplementation((_text: string, options: any) => {
    if (options.call) options.onBudget?.();
    return options.budgetClosing ? new Promise<void>(resolve => { finishClosing = resolve; }) : Promise.resolve();
  });
  const startsBeforeBudget = h.start.mock.calls.length;
  if (!group) h.close.mockImplementationOnce(() => h.micEnd?.({ code: 0 }));
  target.messages = [{ id: "budget", role: "bot", kind: "activity", text: "refusal", at: Date.now(), tool: { ok: false, providerError: { fluxBudget: true, provider: "flux-router" } } }];
  if (source === "speech") target.messages = [{ id: "answer", role: "bot", kind: "text", text: "Hello from the bot.", at: Date.now(), from: { id: "b", name: "Bot" } }];
  await flush();
  await vi.advanceTimersByTimeAsync(2000);
  await flush();
  expect(currentCall()).toBeNull();
  expect(callBudgetEnded()).toBe(target.id);
  expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: group ? "interruptGroup" : "interrupt" }));
  expect(h.close).toHaveBeenCalled();
  if (!group) expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/fixture-session/end"))).toHaveLength(1);
  expect(h.start).toHaveBeenCalledTimes(startsBeforeBudget);
  expect(h.speak).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ budgetClosing: true }));
  const starts = h.start.mock.calls.length;
  await flush();
  expect(h.start).toHaveBeenCalledTimes(starts);
  endCall(target.id); // Hanging up again must retain the reason.
  expect(callBudgetEnded()).toBe(target.id);
  startCall(target.id); // An independent call can even have the same target.
  finishClosing();
  await flush();
  expect(currentCall()).toBe(target.id);
  expect(callBudgetEnded()).toBeNull();
});

it("cue prewarming ends its call on budget and aborts when the view unmounts", async () => {
  const bot: any = { id: "prewarm-b", name: "Bot", threadId: "t", messages: [], tasks: [], busy: false };
  h.state.config.tts.routes = { host: "flux" };
  let options: any;
  h.fetchClip.mockImplementation((_text: string, o: any) => { options = o; return new Promise(() => {}); });
  startCall(bot.id);
  render = () => CallView({ bot, collapsed: true });
  await flush();
  expect(h.fetchClip).toHaveBeenCalledTimes(1);
  expect(options.signal.aborted).toBe(false);
  expect(currentCall()).toBe(bot.id);
  options.onBudget();
  expect(currentCall()).toBeNull();
  expect(callBudgetEnded()).toBe(bot.id);
  expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "interrupt" }));
  h.slots.forEach(s => { s?.cleanup?.(); if (s) s.cleanup = undefined; });
  expect(options.signal.aborted).toBe(true);
  startCall("owner-key-b");
  options.onBudget();
  expect(currentCall()).toBe("owner-key-b");
  expect(callBudgetEnded()).toBeNull();
  expect(h.fetchClip).toHaveBeenCalledTimes(1);
});

it.each(["fetch", "playback"])("native budget closing survives unmount and stops stalled %s at the five second deadline without reopening the mic", async stalled => {
  const { Speaker, HtmlAudioPlayer } = await vi.importActual<typeof import("@/lib/tts")>("@/lib/tts");
  const { speaker: viewSpeaker } = await import("@/lib/tts");
  const real = new Speaker();
  const play = vi.spyOn(HtmlAudioPlayer.prototype, "play").mockImplementation(() => new Promise(() => {}));
  const teardown = vi.spyOn(HtmlAudioPlayer.prototype, "teardown");
  h.native = true;
  h.player = { teardown: vi.fn(), stop: vi.fn(), render: vi.fn(), play: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const stop = vi.mocked(viewSpeaker.stop).mockImplementation(() => real.stop());
  const output = vi.mocked(viewSpeaker.useOutput).mockImplementation(player => real.useOutput(player));
  h.speak.mockImplementation((text, options) => {
    if (options.budgetClosing) {
      expect(currentCall()).toBeNull();
      expect(callBudgetEnded()).toBe("native-b");
    }
    return real.speak(text, options);
  });
  let signal: AbortSignal | undefined;
  const bot: any = { id: "native-b", name: "Bot", threadId: "t", messages: [], tasks: [], busy: false };
  startCall(bot.id);
  render = () => CallView({ bot, collapsed: true });
  try {
    await flush();
    expect(output).toHaveBeenCalledWith(h.player);
    const starts = h.start.mock.calls.length;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url) === "/api/tts/speak") {
        signal = init?.signal as AbortSignal;
        if (stalled === "fetch") return new Promise(() => {});
        return new Response(new Blob(["fixture audio"], { type: "audio/mpeg" }));
      }
      return new Response("{}");
    });
    bot.messages = [{ id: "budget", role: "bot", kind: "activity", text: "refusal", at: Date.now(), tool: { ok: false, providerError: { fluxBudget: true, provider: "flux-router" } } }];
    await flush();
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    if (stalled === "playback") expect(play).toHaveBeenCalledTimes(1);
    expect(h.player.play).not.toHaveBeenCalled();
    const stops = teardown.mock.calls.length;
    h.slots.forEach(s => { s?.cleanup?.(); if (s) s.cleanup = undefined; });
    expect(teardown).toHaveBeenCalledTimes(stops);
    expect(signal!.aborted).toBe(false);
    expect(output).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(real.state.status).toBe("idle");
    expect(teardown).toHaveBeenCalledTimes(stops + 1);
    expect(h.start).toHaveBeenCalledTimes(starts);
    expect(callBudgetEnded()).toBe(bot.id);
  } finally {
    real.stop(); stop.mockReset(); output.mockReset(); play.mockRestore(); teardown.mockRestore();
  }
});
