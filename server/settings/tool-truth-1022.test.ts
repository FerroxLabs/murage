import { describe, expect, it } from "vitest";
import { toolTruthFor } from "./tools-off.ts";
import { voiceScopeFor } from "../tts/scope-read.ts";
import { admitTool, TOOL_NAMES, PER_BOT_TOOLS } from "./tools-off.ts";

const cfg = (extra: Record<string, unknown> = {}) => ({ ...extra }) as any;
describe("G4 tool and voice truth", () => {
  it("every tool the page shows on is one the proxy admits, and every one it shows off is refused, in each switch state", () => {
    const states: [string, any, any][] = [
      ["all on", cfg(), { id: "a" }],
      ["reader off app-wide", cfg({ webRead: { enabled: false } }), { id: "a" }],
      ["search off app-wide", cfg({ webSearch: { provider: "off" } }), { id: "a" }],
      ["images and routines off for the bot", cfg(), { id: "a", toolsOff: ["images", "routines", "past_chats"] }],
    ];
    for (const [, c, bot] of states) {
      for (const row of toolTruthFor(c, bot)) {
        const names = TOOL_NAMES[row.toolId];
        for (const name of names) expect(admitTool(c, bot, name).ok, `${row.toolId}/${name}`).toBe(row.on);
      }
    }
  });
  it("matches a hand-written table, not only admitTool", () => {
    const on = (c: any, bot: any) => Object.fromEntries(toolTruthFor(c, bot).map(r => [r.toolId, r.on]));
    expect(on(cfg(), { id: "a" })).toEqual({ web_search: true, web_read: true, images: true, voice_notes: true, past_chats: true, routines: true });
    expect(on(cfg({ webRead: { enabled: false } }), { id: "a" })).toMatchObject({ web_read: false, web_search: true });
    expect(on(cfg({ webSearch: { provider: "off" } }), { id: "a" })).toMatchObject({ web_search: false, web_read: false });
    expect(on(cfg(), { id: "a", toolsOff: ["voice_notes", "routines"] })).toEqual({ web_search: true, web_read: true, images: true, voice_notes: false, past_chats: true, routines: false });
  });
  it("gives a reason code for each off row and none for an on row", () => {
    const rows = toolTruthFor(cfg({ webRead: { enabled: false } }), { id: "a", toolsOff: ["images"] });
    expect(rows.find(r => r.toolId === "web_read")).toMatchObject({ on: false, reason: expect.any(String) });
    expect(rows.find(r => r.toolId === "images")).toMatchObject({ on: false, reason: "tool-off-for-bot" });
    expect(rows.find(r => r.toolId === "web_search")).toEqual({ toolId: "web_search", on: true });
    expect(rows.map(r => r.toolId)).toEqual([...PER_BOT_TOOLS]);
  });
  it("past chats has no proxy name but still reads the bot's own switch", () => {
    expect(toolTruthFor(cfg(), { id: "a", toolsOff: ["past_chats"] }).find(r => r.toolId === "past_chats")).toMatchObject({ on: false });
    expect(toolTruthFor(cfg(), { id: "a" }).find(r => r.toolId === "past_chats")).toEqual({ toolId: "past_chats", on: true });
  });
  it("a voice note is off when the voice scope says the voice is not ready", () => {
    expect(toolTruthFor(cfg(), { id: "a" }, { voiceReady: false }).find(r => r.toolId === "voice_notes")).toEqual({ toolId: "voice_notes", on: false, reason: "voice-not-ready" });
    expect(toolTruthFor(cfg(), { id: "a" }, { voiceReady: true }).find(r => r.toolId === "voice_notes")?.on).toBe(true);
  });
  it("voice scope: a bot's own provider wins over the app's, and readiness follows the provider's own credential", () => {
    const app = cfg({ tts: { provider: "elevenlabs", key: "k", voice: "v1" } });
    expect(voiceScopeFor(app, undefined)).toEqual({ provider: "elevenlabs", source: "app", voice: "v1", ready: true });
    expect(voiceScopeFor(app, { voiceProvider: "system", voice: "" })).toMatchObject({ provider: "system", source: "bot" });
    expect(voiceScopeFor(cfg({ tts: { provider: "elevenlabs", voice: "v1" } }), undefined).ready).toBe(false);
    expect(voiceScopeFor(app, { voice: "v2" })).toMatchObject({ voice: "v2", ready: true });
    expect(JSON.stringify(voiceScopeFor(app, undefined))).not.toContain('"k"');
  });
});
