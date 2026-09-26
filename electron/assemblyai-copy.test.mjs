// 0.1.60 audit C1: an AssemblyAI 5xx reached the Skill recorder as
// "Error invoking remote method 'assemblyai:streaming-token': Error: Could
// not start cloud transcription (HTTP 503)." Both halves are fixed: the
// mint says a plain sentence, and the preload strips Electron's wrapper.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { mintAssemblyAIStreamingToken } from "./assemblyai.mjs";

const mint = status => mintAssemblyAIStreamingToken("k", { fetchImpl: async () => new Response("{}", { status }) }).catch(e => e);

describe("AssemblyAI token failures in plain words", () => {
  it.each([500, 502, 503, 429, 400, 404])("HTTP %i shows no status code", async status => {
    const error = await mint(status);
    expect(String(error.message)).not.toMatch(/HTTP|\b[45]\d\d\b|\(|\)/);
    expect(String(error.message)).toMatch(/\.$/);
  });
  it("says it is AssemblyAI's side for a 5xx", async () => {
    expect((await mint(503)).message).toBe("AssemblyAI isn't answering right now, so recording can't start. Try again in a few minutes.");
  });
});

describe("the preload hands the window only the message", () => {
  const ORIGIN = "http://127.0.0.1:1";
  function bridge(reject) {
    const exposed = {};
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
      ipcRenderer: { invoke: async channel => { throw new Error(`Error invoking remote method '${channel}': Error: ${reject}`); }, on: () => {}, once: () => {}, send: () => {}, removeListener: () => {}, removeAllListeners: () => {} },
      webUtils: { getPathForFile: () => "" } };
    const context = { require: name => { if (name === "electron") return electron; throw Error("preload may not require " + name); },
      process: { argv: [`--murage-renderer-origin=${ORIGIN}`], platform: process.platform, env: {} }, location: { origin: ORIGIN }, console, setTimeout, clearTimeout, URL, module: { exports: {} }, exports: {} };
    context.globalThis = context;
    vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), context);
    return exposed.muragebox;
  }
  it.each(["streamingToken", "status", "setKey"])("transcription.%s", async name => {
    const sentence = "AssemblyAI isn't answering right now, so recording can't start. Try again in a few minutes.";
    const error = await bridge(sentence).transcription[name]("x").catch(e => e);
    expect(error.message).toBe(sentence);
  });
  it("saveFile and workspaceFileAction keep doing the same", async () => {
    const box = bridge("That file is gone.");
    expect((await box.saveFile("/x").catch(e => e)).message).toBe("That file is gone.");
    expect((await box.workspaceFileAction({}, "a", "open").catch(e => e)).message).toBe("That file is gone.");
  });
});
