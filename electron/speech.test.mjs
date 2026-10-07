import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
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

const { configureCallTrace, writeCallTrace } = await import("./call-trace.mjs");
const { finishSpeech, launchSpeechSession, speechArgs, startSpeech, stopSpeech } = await import("./speech.mjs");
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

describe("the endpoint windows handed to the helper", () => {
  it("passes both windows, and a long one by default when only the base is given", () => {
    expect(speechArgs({ endpointMs: 1500, endpointLongMs: 2800 })).toEqual(["--endpoint-ms", "1500", "--endpoint-long-ms", "2800"]);
    expect(speechArgs({ endpointMs: 1500 })).toEqual(["--endpoint-ms", "1500", "--endpoint-long-ms", "2800"]);
  });
  it("clamps both to a sane range and never lets the long window undercut the base", () => {
    expect(speechArgs({ endpointMs: 10, endpointLongMs: 99_999 })).toEqual(["--endpoint-ms", "250", "--endpoint-long-ms", "8000"]);
    expect(speechArgs({ endpointMs: 99_999, endpointLongMs: 100 })).toEqual(["--endpoint-ms", "5000", "--endpoint-long-ms", "5000"]);
    expect(speechArgs({ endpointMs: 2000, endpointLongMs: 1000 })).toEqual(["--endpoint-ms", "2000", "--endpoint-long-ms", "2000"]);
  });
  it("sends no endpoint flags for composer dictation", () => {
    expect(speechArgs({})).toEqual([]);
    expect(speechArgs(undefined)).toEqual([]);
    expect(speechArgs({ endpointMs: 0, endpointLongMs: 2800 })).toEqual([]);
  });
});

describe("the final line's longEndpoint flag", () => {
  it("reaches the renderer untouched, so the call can shorten its hold", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    appendFileSync(argAfter(proc, "-o"), `${JSON.stringify({ partial: false, text: "my top three movies are", longEndpoint: true })}\n`);
    proc.emit("close", 0);
    expect(sent[0]).toEqual(["speech:transcript", { partial: false, text: "my top three movies are", longEndpoint: true }]);
  });
});

describe("an empty final or an error after words were shown", () => {
  const lines = (proc, ...objs) => appendFileSync(argAfter(proc, "-o"), objs.map((o) => `${JSON.stringify(o)}\n`).join(""));

  it("delivers the last non-empty text as the final when the session ends empty", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "What's the weather in Austin?" }, { partial: true, text: "" }, { partial: false, text: "" });
    proc.emit("close", 0);
    const finals = sent.filter(([c, p]) => c === "speech:transcript" && p.partial === false);
    expect(finals).toEqual([["speech:transcript", { partial: false, text: "What's the weather in Austin?", recovered: true }]]);
    expect(sent.at(-1)).toEqual(["speech:end", { code: 0, reason: "completed" }]);
  });

  it("delivers a recovered final when recognition errors after words, and ends completed", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "Remind me at five" }, { error: "recognition-error" });
    proc.emit("close", 1);
    const finals = sent.filter(([c, p]) => c === "speech:transcript" && p.partial === false);
    expect(finals).toEqual([["speech:transcript", { partial: false, text: "Remind me at five", recovered: true }]]);
    expect(sent.at(-1)).toEqual(["speech:end", { code: 0, reason: "completed" }]);
  });

  it("still reports an error when nothing was ever heard", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "" }, { error: "recognition-error" });
    proc.emit("close", 1);
    expect(sent.at(-1)).toEqual(["speech:end", { code: 1, reason: "recognition-error" }]);
  });

  it("writes counts and states to the call trace, never the words", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "call-trace-")), "call-trace.log");
    configureCallTrace(file);
    try {
      const { win } = fakeWindow();
      launchSpeechSession(win);
      const proc = spawned.at(-1);
      lines(proc, { partial: true, text: "secret launch codes are here" }, { partial: true, text: "" }, { partial: false, text: "", longEndpoint: true });
      proc.emit("close", 0);
      const log = readFileSync(file, "utf8");
      expect(log).toContain("partials=2 emptyPartials=1 lastPartialChars=28 final=28 longEndpoint=true recovered=true exit=0 reason=completed");
      expect(log).not.toMatch(/secret|launch|codes/);
    } finally {
      configureCallTrace(null);
    }
  });
});

describe("a recognizer reset in the middle of an utterance", () => {
  const lines = (proc, ...objs) => appendFileSync(argAfter(proc, "-o"), objs.map((o) => `${JSON.stringify(o)}\n`).join(""));
  const transcripts = (sent) => sent.filter(([c]) => c === "speech:transcript").map(([, p]) => p);

  it("keeps the words before the reset: A, empty, B ends as A B", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "A" }, { partial: true, text: "" }, { partial: true, text: "B" }, { partial: false, text: "B" });
    proc.emit("close", 0);
    const t = transcripts(sent);
    expect(t.at(-1)).toMatchObject({ partial: false, text: "A B" });
    expect(t.filter((p) => p.partial && p.text).map((p) => p.text)).toEqual(["A", "A B"]);
  });

  it("keeps a whole sentence across a reset", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "Remind me to call mom and" }, { partial: true, text: "" }, { partial: true, text: "at five" }, { partial: false, text: "at five" });
    proc.emit("close", 0);
    expect(transcripts(sent).at(-1).text).toBe("Remind me to call mom and at five");
  });

  it("recovers both halves when the session ends empty after a reset", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "A" }, { partial: true, text: "" }, { partial: true, text: "B" }, { partial: false, text: "" });
    proc.emit("close", 0);
    expect(transcripts(sent).at(-1)).toMatchObject({ partial: false, text: "A B", recovered: true });
  });

  it("does not double a segment Apple re-sends after an empty result: A, empty, A B is A B", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "A" }, { partial: true, text: "" }, { partial: true, text: "A B" }, { partial: false, text: "A B" });
    proc.emit("close", 0);
    expect(transcripts(sent).at(-1).text).toBe("A B");
  });

  it("matches the re-sent segment without regard to case", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "call mom" }, { partial: true, text: "" }, { partial: true, text: "Call mom and" }, { partial: false, text: "Call mom and" });
    proc.emit("close", 0);
    expect(transcripts(sent).at(-1).text).toBe("Call mom and");
  });

  it("a different segment after the empty result is joined: A, empty, B is A B", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "A" }, { partial: true, text: "" }, { partial: true, text: "B" }, { partial: false, text: "B" });
    proc.emit("close", 0);
    expect(transcripts(sent).at(-1).text).toBe("A B");
  });

  it("the Swift helper applies the same rule: drops a kept segment the new text restates, word-based and punctuation-insensitive", () => {
    const swift = readFileSync(new URL("./resources/speech-helper.swift", import.meta.url), "utf8");
    expect(swift).toMatch(/private func restates\(/);
    // on any partial, not only the first after a reset: Apple can re-send the kept words a word at a time
    expect(swift).toMatch(/if restates\(committedText, raw\) \{\s*committedText = ""/);
    // the segment-close test is by words, not characters
    expect(swift).toMatch(/segmentClosed && !currentText\.isEmpty && !restates\(currentText, raw\)/);
    expect(swift).not.toMatch(/hasPrefix\(currentText/);
  });

  it("does not double a helper that already merges its own segments", () => {
    const { win, sent } = fakeWindow();
    launchSpeechSession(win);
    const proc = spawned.at(-1);
    lines(proc, { partial: true, text: "A" }, { partial: true, text: "A B" }, { partial: false, text: "A B" });
    proc.emit("close", 0);
    expect(transcripts(sent).at(-1).text).toBe("A B");
  });
});

describe("a stopped session still writes its trace summary", () => {
  it("writes reason=stopped with counts only", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "call-trace-")), "call-trace.log");
    configureCallTrace(file);
    try {
      const { win } = fakeWindow();
      launchSpeechSession(win);
      const proc = spawned.at(-1);
      appendFileSync(argAfter(proc, "-o"), `${JSON.stringify({ partial: true, text: "private words here" })}\n`);
      const stopping = stopSpeech();
      await flush();
      proc.emit("close", 0);
      await stopping;
      const log = readFileSync(file, "utf8");
      expect(log).toContain("helper session partials=1");
      expect(log).toContain("reason=stopped");
      expect(log).not.toMatch(/private|words/);
    } finally {
      configureCallTrace(null);
    }
  });
});

describe("the call trace writer", () => {
  it("rejects non-call lines, flattens control characters and rotates keeping one old file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "call-trace-"));
    const file = path.join(dir, "call-trace.log");
    configureCallTrace(file);
    try {
      expect(writeCallTrace("random words")).toBe(false);
      expect(writeCallTrace("[call-trace] a\nb")).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(/\[call-trace\] a b\n$/);
      writeCallTrace("[call-diag] x".padEnd(100, "x"), { maxBytes: 50 });
      writeCallTrace("[call-diag] y", { maxBytes: 50 });
      expect(existsSync(`${file}.1`)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("[call-diag] y");
      expect(existsSync(`${file}.2`)).toBe(false);
    } finally {
      configureCallTrace(null);
    }
  });
});

describe("the Mac helper's recognition error path", () => {
  it("ends in failRecognition so a Dictation-off error keeps its own reason", () => {
    const swift = readFileSync(new URL("./resources/speech-helper.swift", import.meta.url), "utf8");
    const handler = swift.slice(swift.indexOf("private func handleRecognition("), swift.indexOf("SFSpeechRecognizer.requestAuthorization"));
    expect(handler).toMatch(/if let error = error \{[\s\S]*failRecognition\(error\)/);
    expect(handler).not.toContain('fail("recognition-error")');
    // heard text is still recovered before the error is reported
    expect(handler).toMatch(/"recovered": true[\s\S]*failRecognition\(error\)/);
  });
});
