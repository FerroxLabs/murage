// VOICE-402-STOP, the window's half: once the harness says the Flux key's
// budget is used up, auto-speak and call mode stop sending speech requests
// for the next messages, instead of about three per message.
import { afterEach, describe, expect, it, vi } from "vitest";

import { Speaker, VOICE_BUDGET_HOLD_MS } from "./index";

// Keep the entry point real, with isolated browser and rendering boundaries.
const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("../../App", () => ({ default: () => null }));
vi.mock("../../components/RootErrorBoundary", () => ({ RootErrorBoundary: () => null }));
vi.mock("../trusted-html", () => ({ installTrustedTypes() {}, sanitizerReady: () => Promise.resolve() }));
vi.mock("../cloud-home-meta", () => ({ homeMeta: () => ({}) }));
vi.mock("../chunk-reload", () => ({ browserChunkReloadDeps() {}, installChunkReload() {} }));
vi.mock("../call-diag-forward", () => ({ installCallDiagForward() {} }));
vi.mock("../native-shell", () => ({ inNativeShell: () => false, nativeHello() {} }));
vi.mock("../open-external", () => ({ routeNativeClicks() {} }));
vi.mock("../register-sw", () => ({ registerServiceWorker() {} }));
vi.mock("../skins", () => ({ applySkin() {}, readPreference() {}, resolveSkin() {}, watchSystemSkin() {} }));
vi.mock("../fonts", () => ({ applyFont() {}, readFont() {} }));

const LINE = "Voice is paused: this Flux key has reached its budget. It starts again when the budget changes.";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

it("production startup installs budget reset before the first render can request speech", async () => {
  vi.resetModules();
  vi.stubGlobal("window", {});
  // Helpers must remain importable before browser event support exists.
  const { speaker } = await import("./index");
  const events = new EventTarget();
  const add = vi.spyOn(events, "addEventListener");
  vi.stubGlobal("window", events);
  vi.stubGlobal("document", { getElementById: () => ({}) });
  const speech = budgetSpent();
  let firstSpeech: Promise<unknown> | undefined;
  render.mockImplementationOnce(() => {
    firstSpeech = speaker.fetchClip("One.", {}).catch(error => error);
  });
  await import("../../main");
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
  expect(await firstSpeech).toMatchObject({ message: LINE });
  expect(add).toHaveBeenCalledWith("murage:provider-connections-changed", expect.any(Function));
  expect(add.mock.invocationCallOrder[0]).toBeLessThan(render.mock.invocationCallOrder[0]);
  expect(add.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[0]);
  await expect(speaker.fetchClip("Held.", {})).rejects.toThrow(LINE);
  expect(speech).toHaveLength(1);
  events.dispatchEvent(new Event("murage:provider-connections-changed"));
  await expect(speaker.fetchClip("Retry.", {})).rejects.toThrow(LINE);
  expect(speech).toHaveLength(2);
});

it("repeated install shares one reset listener and an idempotent cleanup", async () => {
  vi.resetModules();
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  const { speaker, installSpeakerBudgetReset } = await import("./index");
  const reset = vi.spyOn(speaker, "resetBudgetHold");
  const add = vi.spyOn(events, "addEventListener");
  const remove = vi.spyOn(events, "removeEventListener");
  const stop = installSpeakerBudgetReset();
  const stopAgain = installSpeakerBudgetReset();
  const change = () => events.dispatchEvent(new Event("murage:provider-connections-changed"));
  change();
  expect(reset).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledTimes(1);
  expect(stopAgain).toBe(stop);
  change();
  expect(reset).toHaveBeenCalledTimes(2);
  // Cleanup belongs to the original target even if the global changes.
  vi.stubGlobal("window", new EventTarget());
  stopAgain();
  stop();
  change();
  expect(reset).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledTimes(1);
  vi.stubGlobal("window", events);
  const stopNew = installSpeakerBudgetReset();
  stop(); // An old cleanup must not remove the new registration.
  change();
  expect(reset).toHaveBeenCalledTimes(3);
  expect(add).toHaveBeenCalledTimes(2);
  stopNew();
  change();
  expect(reset).toHaveBeenCalledTimes(3);
});

function budgetSpent() {
  const speech: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/prepare")) return json({ ready: true, utterances: ["One.", "Two.", "Three."] });
      speech.push(String(init?.body));
      return json({ error: LINE, code: "voice_budget_reached" }, 402);
    }),
  );
  return speech;
}

describe("the budget hold", () => {
  it("40 messages after a budget 402 send 1 speech request, not about 120", async () => {
    const speech = budgetSpent();
    let now = 1_000;
    const speaker = new Speaker(() => now, () => {});
    for (let i = 0; i < 40; i += 1) {
      await speaker.speak(`Message ${i}. Two. Three.`, { messageId: `m${i}` });
      now += 1_000;
    }
    expect(speech.length).toBeLessThanOrEqual(2);
    expect(speaker.state.error).toBe(LINE);
  });

  it("asks again once the hold ends, and a picker preview asks at once", async () => {
    const speech = budgetSpent();
    let now = 1_000;
    const speaker = new Speaker(() => now, () => {});
    await speaker.speak("One. Two. Three.", { messageId: "a" });
    const first = speech.length;
    await speaker.speak("One. Two. Three.", { messageId: "voice-preview:cedar" });
    expect(speech.length).toBeGreaterThan(first);
    const second = speech.length;
    await speaker.speak("One. Two. Three.", { messageId: "b" });
    expect(speech.length).toBe(second);
    now += VOICE_BUDGET_HOLD_MS + 1;
    await speaker.speak("One. Two. Three.", { messageId: "c" });
    expect(speech.length).toBeGreaterThan(second);
  });
});

it("a call reports a typed budget failure and permits only its closing request through the hold", async () => {
  const speech = budgetSpent();
  const onBudget = vi.fn();
  const speaker = new Speaker(() => 1_000, () => {});
  await speaker.speak("One.", { botId: "bot", call: true, onBudget });
  expect(onBudget).toHaveBeenCalledTimes(1);
  expect(JSON.parse(speech[0]).call).toBe(true);
  const before = speech.length;
  await speaker.speak("Closing.", { botId: "bot", budgetClosing: true });
  expect(speech.length).toBeGreaterThan(before);
  expect(JSON.parse(speech.at(-1)!)).toMatchObject({ budgetClosing: true });
});

it("cue requests observe budget holds and notify an active call", async () => {
  const speech = budgetSpent();
  const onBudget = vi.fn();
  const speaker = new Speaker(() => 1_000, () => {});
  await expect(speaker.fetchClip("Cue.", { call: true, onBudget })).rejects.toThrow(LINE);
  await expect(speaker.fetchClip("Cue.", { call: true, onBudget })).rejects.toThrow(LINE);
  expect(speech).toHaveLength(1);
  expect(onBudget).toHaveBeenCalledTimes(2);
});

it("the closing line does not depend on configured paid speech preparation", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    return json({ error: LINE, code: "voice_budget_reached" }, 402);
  });
  const speaker = new Speaker(() => 1_000, () => {});
  await speaker.speak("Closing.", { budgetClosing: true });
  expect(requests).toEqual(["/api/tts/speak"]);
});

it("a route change clears the client hold so an own-key route can be tried", async () => {
  const speech = budgetSpent();
  const speaker = new Speaker(() => 1000, () => {});
  await speaker.speak("Flux call.", { call: true });
  const first = speech.length;
  speaker.resetBudgetHold();
  await speaker.speak("Own-key call.", { call: true });
  expect(speech.length).toBeGreaterThan(first);
});

it.each(["reset", "abort"])("ignores a late cue refusal after call %s", async action => {
  let reply!: (r: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { reply = resolve; })).mockResolvedValue(new Response("owner audio"));
  vi.stubGlobal("fetch", fetcher);
  const speaker = new Speaker(() => 1000, () => {});
  const controller = new AbortController();
  const onBudget = vi.fn();
  const a = speaker.fetchClip("Call A", { signal: controller.signal, call: true, onBudget });
  if (action === "reset") speaker.resetBudgetHold(); else controller.abort();
  reply(json({ code: "voice_budget_reached" }, 402));
  await expect(a).rejects.toMatchObject({ name: "AbortError" });
  await expect(speaker.fetchClip("Call B owner key", { call: true, onBudget })).resolves.toBeInstanceOf(Blob);
  expect(onBudget).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("closing speech has a deadline even if the fetch ignores cancellation", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise(() => {}); });
  const speaker = new Speaker(() => 1000, () => {});
  try {
    const done = speaker.speak("Closing.", { budgetClosing: true });
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(signal?.aborted).toBe(true);
    expect(speaker.state.status).toBe("idle");
  } finally { speaker.stop(); vi.useRealTimers(); }
});
