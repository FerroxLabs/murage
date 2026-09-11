import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The `open -W` waiter is faked: its "close" is the observed helper exit. No
// native helper is built or launched, and the platform is never stubbed; the
// launcher is driven directly past startSpeech's platform/build gates.
const { spawned } = vi.hoisted(() => ({ spawned: [] }));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
}));
vi.mock("node:child_process", () => ({
  spawn: (command, args) => {
    const proc = new EventEmitter();
    Object.assign(proc, { command, args });
    spawned.push(proc);
    return proc;
  },
}));
vi.mock("./build-speech-helper.mjs", () => ({
  buildSpeechHelper: () => {
    throw new Error("tests never build the native helper");
  },
  speechHelperBinary: "/nonexistent/speech-helper",
  speechHelperBundle: "/nonexistent/Murage Speech.app",
}));

const { finishSpeech, launchSpeechSession, startSpeech, stopSpeech } = await import("./speech.mjs");
const { HELPER_STOP_TIMEOUT_MS } = await import("./helper-stop.mjs");
const { OWNED_WORK_TIMEOUT_MS } = await import("./server-child-lifecycle.mjs");

function fakeWindow() {
  const sent = [];
  return { sent, win: { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } } };
}
const argAfter = (proc, flag) => proc.args[proc.args.indexOf(flag) + 1];
function track(promise) {
  const state = { settled: "pending" };
  promise.then(() => { state.settled = "resolved"; }, () => { state.settled = "rejected"; });
  return state;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
  // Observe every fake helper's exit so no session stays owned across tests.
  for (const proc of spawned.splice(0)) proc.emit("close", 0);
});

describe("speech helper stop ownership (B5)", () => {
  it("reuses the existing 10 s owned-work deadline", () => {
    expect(OWNED_WORK_TIMEOUT_MS).toBe(10_000);
    expect(HELPER_STOP_TIMEOUT_MS).toBe(OWNED_WORK_TIMEOUT_MS);
  });

  it("keeps the helper owned until its exit is observed, without reporting a natural end", async () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    const stopping = stopSpeech();
    const state = track(stopping);
    await flush();

    expect(readFileSync(argAfter(proc, "--stop-file"), "utf8")).toBe("stop");
    expect(state.settled).toBe("pending");
    // A stopping recognizer is not finalized again, and its last chunk never
    // reaches the renderer.
    finishSpeech();
    expect(existsSync(argAfter(proc, "--finish-file"))).toBe(false);
    appendFileSync(argAfter(proc, "-o"), `${JSON.stringify({ partial: false, text: "late words" })}\n`);

    proc.emit("close", 0);
    await expect(stopping).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    await expect(stopSpeech()).resolves.toBeUndefined();
  });

  it("still reports a helper that ends on its own", async () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    spawned.at(-1).emit("close", 1);
    expect(sent).toEqual([["speech:end", { code: 1, reason: "helper-exited" }]]);
    await expect(stopSpeech()).resolves.toBeUndefined();
  });

  it("reports a failed stop marker, keeps ownership, refuses a second helper and retries once the writer recovers", async () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    const stopPath = argAfter(proc, "--stop-file");
    const sessionDir = path.dirname(stopPath);
    rmSync(sessionDir, { recursive: true, force: true });

    await expect(stopSpeech()).rejects.toMatchObject({ code: "HELPER_STOP_SIGNAL_FAILED" });
    await startSpeech(win);
    expect(spawned).toHaveLength(1);
    expect(sent).toEqual([["speech:end", { code: 1, reason: "helper-stop-pending" }]]);

    mkdirSync(sessionDir, { recursive: true });
    const retry = stopSpeech();
    await flush();
    expect(readFileSync(stopPath, "utf8")).toBe("stop");
    proc.emit("close", 0);
    await expect(retry).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("keeps ownership when the helper outlives the owned-work deadline", async () => {
    vi.useFakeTimers();
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    const stopping = stopSpeech();
    const state = track(stopping);

    await vi.advanceTimersByTimeAsync(HELPER_STOP_TIMEOUT_MS - 1);
    expect(state.settled).toBe("pending");
    const expired = expect(stopping).rejects.toMatchObject({ code: "HELPER_EXIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1);
    await expired;

    // Still owned: a new Start signals and waits on the same helper again,
    // and refuses rather than launching beside it.
    const starting = startSpeech(win);
    await vi.advanceTimersByTimeAsync(HELPER_STOP_TIMEOUT_MS);
    await starting;
    expect(spawned).toHaveLength(1);
    expect(sent).toEqual([["speech:end", { code: 1, reason: "helper-stop-pending" }]]);

    proc.emit("close", 0);
    await expect(stopSpeech()).resolves.toBeUndefined();
  });

  it("a Stop issued while a Start waits on the previous helper cancels that Start", async () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    const starting = startSpeech(win);
    const stopping = stopSpeech();
    await flush();
    proc.emit("close", 0);
    await starting;
    await stopping;
    expect(spawned).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});
