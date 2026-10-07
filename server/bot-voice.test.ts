import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assignMissingVoices, DEFAULT_VOICE_POOL, setVoiceRandom } from "./bot-voice.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { XAI_VOICES } from "./tts/xai-speech.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const FEMALE = XAI_VOICES.filter((v) => v.gender === "female").map((v) => v.id);

describe("a default voice for every bot", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    setVoiceRandom(seeded(7));
  });
  afterEach(() => setVoiceRandom());

  it("pools exactly the nine female Grok voices", () => {
    expect([...DEFAULT_VOICE_POOL].sort()).toEqual([...FEMALE].sort());
    expect(FEMALE).toHaveLength(9);
  });

  it("nine new bots get nine different voices, and the tenth the least-used one", () => {
    const store = new Store(selection);
    const bots = Array.from({ length: 9 }, () => store.createBot({}, { seedMessages: false }));
    const voices = bots.map((b) => b.voice!);
    expect(new Set(voices).size).toBe(9);
    for (const v of voices) expect(FEMALE).toContain(v);
    expect(bots.every((b) => b.voiceAssigned === true)).toBe(true);
    const tenth = store.createBot({}, { seedMessages: false });
    expect(FEMALE).toContain(tenth.voice);
    // all nine used once: any is least-used; the 11th..18th must avoid doubling up
    const rest = Array.from({ length: 8 }, () => store.createBot({}, { seedMessages: false }));
    const all = [tenth, ...rest].map((b) => b.voice!);
    expect(new Set(all).size).toBe(9);
    const counts = new Map<string, number>();
    for (const b of store.bots) counts.set(b.voice!, (counts.get(b.voice!) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
  });

  it("the tenth bot takes the one voice used least", () => {
    const bots: Array<{ voice?: string; voiceAssigned?: boolean }> = [
      ...FEMALE.slice(1).map((voice) => ({ voice })),
      ...FEMALE.slice(1).map((voice) => ({ voice })),
      {},
    ];
    assignMissingVoices(bots);
    expect(bots.at(-1)!.voice).toBe(FEMALE[0]);
  });

  it("an owner's choice is never changed, by a patch or an upgrade", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.patchBot(bot.id, { voice: "nova", voiceProvider: "flux" });
    expect(store.bot(bot.id)!.voiceAssigned).toBeUndefined();
    const el = store.createBot({}, { seedMessages: false });
    store.patchBot(el.id, { voice: "", voiceProvider: "elevenlabs" });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toMatchObject({ voice: "nova", voiceProvider: "flux" });
    expect(reloaded.bot(el.id)).toMatchObject({ voice: "", voiceProvider: "elevenlabs" });
    expect(reloaded.bot(el.id)!.voiceAssigned).toBeUndefined();
  });

  it("the voice is stable across a restart", () => {
    const store = new Store(selection);
    const bots = [store.createBot({}, { seedMessages: false }), store.createBot({}, { seedMessages: false })];
    const before = bots.map((b) => b.voice);
    setVoiceRandom(seeded(99));
    const reloaded = new Store(selection);
    expect(bots.map((b) => reloaded.bot(b.id)!.voice)).toEqual(before);
    expect(bots.every((b) => reloaded.bot(b.id)!.voiceAssigned === true)).toBe(true);
  });

  it("an upgrade gives each voice-less bot a voice once, distinct, and leaves the rest", () => {
    const store = new Store(selection);
    const a = store.createBot({}, { seedMessages: false });
    const b = store.createBot({}, { seedMessages: false });
    const c = store.createBot({}, { seedMessages: false });
    const file = join(DATA_DIR, "bots.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list: any[] = Array.isArray(raw) ? raw : raw.bots;
    for (const rec of list) { delete rec.voice; delete rec.voiceAssigned; }
    list.find((r) => r.id === c.id).voice = "rex";
    writeFileSync(file, JSON.stringify(raw));
    const upgraded = new Store(selection);
    const va = upgraded.bot(a.id)!, vb = upgraded.bot(b.id)!;
    expect(FEMALE).toContain(va.voice);
    expect(FEMALE).toContain(vb.voice);
    expect(va.voice).not.toBe(vb.voice);
    expect(va.voiceAssigned && vb.voiceAssigned).toBe(true);
    expect(upgraded.bot(c.id)).toMatchObject({ voice: "rex" });
    expect(upgraded.bot(c.id)!.voiceAssigned).toBeUndefined();
    setVoiceRandom(seeded(5));
    const again = new Store(selection);
    expect([again.bot(a.id)!.voice, again.bot(b.id)!.voice]).toEqual([va.voice, vb.voice]);
  });
});
