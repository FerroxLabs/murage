import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The real preload, loaded in a vm with a fake ipcRenderer, as
// ipc-channel-classes.node-test.mjs does. Composer dictation events carry a
// `session` token; calls and push-to-talk must never see them.
const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, "preload.cjs"), "utf8");
const ORIGIN = "https://murage.test";

function loadBridge() {
  const listeners = new Map();
  const invoked = [];
  let exposed = null;
  const ipcRenderer = {
    sendSync: () => "",
    send() {},
    invoke: (channel, ...args) => {
      invoked.push([channel, ...args]);
      return Promise.resolve();
    },
    on: (channel, handler) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
    },
    removeListener: (channel, handler) => listeners.get(channel)?.delete(handler),
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
    ipcRenderer,
    webUtils: { getPathForFile: () => "" },
  };
  vm.runInNewContext(source, {
    require: () => electron,
    process: { platform: "darwin", argv: ["electron", `--murage-renderer-origin=${ORIGIN}`] },
    location: { origin: ORIGIN },
    URL,
    queueMicrotask,
  });
  const emit = (channel, payload) => {
    for (const handler of [...(listeners.get(channel) ?? [])]) handler({}, payload);
  };
  return { bridge: exposed.value, emit, invoked, listeners };
}

describe("preload speech bridge", () => {
  it("onSpeech* drop tagged events and the dictation pair passes only them", () => {
    const { bridge, emit } = loadBridge();
    const call = { transcript: [], end: [] };
    const dictation = { transcript: [], end: [] };
    bridge.onSpeechTranscript((line) => call.transcript.push(line));
    bridge.onSpeechEnd((info) => call.end.push(info));
    bridge.onDictationTranscript((line) => dictation.transcript.push(line));
    bridge.onDictationEnd((info) => dictation.end.push(info));

    emit("speech:transcript", { partial: true, text: "call words" });
    emit("speech:transcript", { partial: true, text: "composer words", session: "T1" });
    emit("speech:end", { code: 0, reason: "completed" });
    emit("speech:end", { code: 0, reason: "superseded", session: "T1" });

    expect(call.transcript).toEqual([{ partial: true, text: "call words" }]);
    expect(call.end).toEqual([{ code: 0, reason: "completed" }]);
    expect(dictation.transcript).toEqual([{ partial: true, text: "composer words", session: "T1" }]);
    expect(dictation.end).toEqual([{ code: 0, reason: "superseded", session: "T1" }]);
  });

  it("the unsubscribe functions detach their listeners", () => {
    const { bridge, emit } = loadBridge();
    const seen = [];
    const off = bridge.onDictationEnd((info) => seen.push(info));
    emit("speech:end", { code: 0, session: "T1" });
    off();
    emit("speech:end", { code: 0, session: "T1" });
    expect(seen).toHaveLength(1);
  });

  it("passes the token on start, stop and finish", async () => {
    const { bridge, invoked } = loadBridge();
    await bridge.speechStart({ session: "T1" });
    await bridge.speechFinish("T1");
    await bridge.speechStop("T1");
    await bridge.speechStop();
    expect(invoked).toEqual([
      ["speech:start", { session: "T1" }],
      ["speech:finish", "T1"],
      ["speech:stop", "T1"],
      ["speech:stop", undefined],
    ]);
  });
});
