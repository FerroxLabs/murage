// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLUX_VOICES } from "../../server/tts/flux-speech.ts";
import { XAI_VOICES } from "../../server/tts/xai-speech.ts";
import { Speaker } from "@/lib/tts";
import {
  filterVoices,
  listKey,
  pickerFilters,
  previewButton,
  previewMessageId,
  rowPreview,
  sortVoices,
  typeAhead,
  voiceAccent,
  type VoiceFilter,
} from "./voice-picker-model";

const all = [...FLUX_VOICES, ...XAI_VOICES];
const none: VoiceFilter = { query: "", gender: "all", accent: "all" };

describe("the voice list", () => {
  it("lists every voice once, alphabetical by the name Murage shows", () => {
    const sorted = sortVoices(all);
    expect(sorted).toHaveLength(41);
    expect(sorted.map((v) => v.label)).toEqual([...all.map((v) => v.label)].sort((a, b) => a.localeCompare(b)));
    expect(sorted[0]!.label).toBe("Adrian");
  });

  it("reads the accent from the end of the description, or takes one a list supplies", () => {
    expect(voiceAccent(FLUX_VOICES.find((v) => v.id === "fable")!)).toBe("British");
    expect(voiceAccent(FLUX_VOICES.find((v) => v.id === "marin")!)).toBe("American");
    // no accent where the listens disagreed
    expect(voiceAccent(XAI_VOICES.find((v) => v.id === "naksh")!)).toBeUndefined();
    expect(voiceAccent(FLUX_VOICES.find((v) => v.id === "alloy")!)).toBeUndefined();
    // a list from a server may say it outright
    expect(voiceAccent({ id: "x", label: "X", description: "Calm", accent: "Irish" })).toBe("Irish");
    expect(voiceAccent({ id: "x", label: "X" })).toBeUndefined();
  });

  it("offers only the filters the list can use", () => {
    expect(pickerFilters(all)).toEqual({ genders: ["female", "male", "neutral"], accents: ["American", "British"] });
    expect(pickerFilters(XAI_VOICES)).toEqual({ genders: ["female", "male"], accents: ["American", "British"] });
    // ElevenLabs and built-in voices carry neither
    expect(pickerFilters([{ id: "a", label: "Rachel", description: "calm" }])).toEqual({ genders: [], accents: [] });
  });
});

describe("filtering", () => {
  it("shows everything with no filter", () => {
    expect(filterVoices(all, none)).toHaveLength(41);
  });

  it("matches the name, the description and the provider's id, ignoring case, every word", () => {
    expect(filterVoices(all, { ...none, query: "kira" }).map((v) => v.id)).toEqual(["nova"]);
    expect(filterVoices(all, { ...none, query: "  STORYTELLER " }).map((v) => v.id)).toEqual(["fable"]);
    expect(filterVoices(all, { ...none, query: "marin" }).map((v) => v.id)).toEqual(["marin"]);
    expect(filterVoices(all, { ...none, query: "calm british" }).map((v) => v.id)).toEqual(["leo"]);
    expect(filterVoices(all, { ...none, query: "nobody sounds like this" })).toEqual([]);
  });

  it("narrows by gender and accent, together with the words", () => {
    const female = filterVoices(all, { ...none, gender: "female" });
    expect(female.length).toBeGreaterThan(0);
    expect(female.every((v) => v.gender === "female")).toBe(true);
    expect(filterVoices(all, { ...none, gender: "neutral" }).map((v) => v.id)).toEqual(["alloy"]);
    const british = filterVoices(all, { ...none, accent: "British" }).map((v) => v.id).sort();
    expect(british).toEqual(["ballad", "eve", "fable", "leo"]);
    expect(filterVoices(all, { ...none, gender: "female", accent: "British" }).map((v) => v.id)).toEqual(["eve"]);
    expect(filterVoices(all, { query: "calm", gender: "male", accent: "British" }).map((v) => v.id)).toEqual(["leo"]);
  });

  it("keeps the list's order", () => {
    const sorted = sortVoices(all);
    const male = filterVoices(sorted, { ...none, gender: "male" });
    expect(male.map((v) => v.label)).toEqual(sorted.filter((v) => v.gender === "male").map((v) => v.label));
  });
});

describe("the keyboard", () => {
  it("moves one row with the arrows and stops at the ends", () => {
    expect(listKey("ArrowDown", 0, 5)).toBe(1);
    expect(listKey("ArrowDown", 4, 5)).toBe(4);
    expect(listKey("ArrowUp", 3, 5)).toBe(2);
    expect(listKey("ArrowUp", 0, 5)).toBe(0);
  });

  it("jumps to the ends with Home and End, and a page with Page Up and Page Down", () => {
    expect(listKey("Home", 3, 5)).toBe(0);
    expect(listKey("End", 1, 5)).toBe(4);
    expect(listKey("PageDown", 0, 20)).toBe(8);
    expect(listKey("PageDown", 15, 20)).toBe(19);
    expect(listKey("PageUp", 10, 20)).toBe(2);
    expect(listKey("PageUp", 3, 20)).toBe(0);
  });

  it("starts from the top or bottom when nothing is active yet", () => {
    expect(listKey("ArrowDown", -1, 5)).toBe(0);
    expect(listKey("ArrowUp", -1, 5)).toBe(4);
  });

  it("does nothing for other keys, or an empty list", () => {
    expect(listKey("a", 2, 5)).toBeNull();
    expect(listKey("Enter", 2, 5)).toBeNull();
    expect(listKey("ArrowDown", 0, 0)).toBeNull();
  });

  it("finds a voice by typing the start of its name", () => {
    const sorted = sortVoices(all);
    const at = (label: string) => sorted.findIndex((v) => v.label === label);
    expect(sorted[typeAhead(sorted, "ki", 0)]!.label).toBe("Kira");
    expect(sorted[typeAhead(sorted, "KIRA", 0)]!.label).toBe("Kira");
    expect(typeAhead(sorted, "qx", 0)).toBe(-1);
    // the same letter again moves on to the next name with it
    const first = typeAhead(sorted, "n", -1);
    expect(sorted[first]!.label).toBe("Naomi");
    expect(sorted[typeAhead(sorted, "n", first)]!.label).toBe("Nathan");
    // and wraps around from the last one
    expect(typeAhead(sorted, "n", at("Nora"))).toBe(at("Naomi"));
    // a longer prefix stays on the current row when it still fits
    expect(typeAhead(sorted, "na", at("Naomi"))).toBe(at("Naomi"));
  });
});

describe("previews", () => {
  it("gives every voice of every bot its own preview", () => {
    expect(previewMessageId("bot-1", "marin")).toBe("voice-preview:bot-1:marin");
    expect(previewMessageId("bot-1", "")).toBe("voice-preview:bot-1:default");
    expect(previewMessageId("bot-1", "marin")).not.toBe(previewMessageId("bot-2", "marin"));
  });

  it("reads each row's state from the one speaker", () => {
    const id = previewMessageId("b", "marin");
    const other = previewMessageId("b", "cedar");
    expect(rowPreview({ status: "idle" }, id)).toEqual({ state: "idle" });
    expect(rowPreview({ status: "preparing", messageId: id }, id)).toEqual({ state: "loading" });
    expect(rowPreview({ status: "speaking", messageId: id }, id)).toEqual({ state: "playing" });
    expect(rowPreview({ status: "speaking", messageId: other }, id)).toEqual({ state: "idle" });
    expect(rowPreview({ status: "idle", messageId: id, error: "Flux said no." }, id)).toEqual({ state: "error", error: "Flux said no." });
    // someone else's failure is not this row's
    expect(rowPreview({ status: "idle", messageId: other, error: "Flux said no." }, id)).toEqual({ state: "idle" });
    expect(rowPreview({ status: "idle", error: "Flux said no." }, id)).toEqual({ state: "idle" });
  });

  it("names the button for the voice it plays", () => {
    expect(previewButton("idle", "Nora")).toEqual({ text: "Play", label: "Play Nora" });
    expect(previewButton("error", "Nora")).toEqual({ text: "Play", label: "Play Nora" });
    expect(previewButton("loading", "Nora")).toEqual({ text: "Loading", label: "Loading Nora" });
    expect(previewButton("playing", "Nora")).toEqual({ text: "Stop", label: "Stop Nora" });
  });
});

describe("one preview at a time", () => {
  class FakeAudio {
    static all: FakeAudio[] = [];
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = vi.fn(async () => {});
    constructor(public src: string) {
      FakeAudio.all.push(this);
    }
  }
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    FakeAudio.all = [];
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("playing a second voice stops the first, and the rows say so", async () => {
    const voices: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/prepare")) return json({ ready: true, utterances: ["Morning."] });
      voices.push(JSON.parse(String(init?.body)).voiceId);
      return new Response(new Blob(["mp3"]), { status: 200 });
    }));
    const speaker = new Speaker();
    const first = previewMessageId("b", "marin");
    const second = previewMessageId("b", "cedar");
    const firstDone = speaker.speak("Morning.", { voiceId: "marin", botId: "b", messageId: first });
    await vi.waitFor(() => expect(rowPreview(speaker.state, first).state).toBe("playing"));
    expect(rowPreview(speaker.state, second).state).toBe("idle");

    const secondDone = speaker.speak("Morning.", { voiceId: "cedar", botId: "b", messageId: second });
    await expect(firstDone).resolves.toBeUndefined();
    await vi.waitFor(() => expect(rowPreview(speaker.state, second).state).toBe("playing"));
    expect(rowPreview(speaker.state, first).state).toBe("idle");
    expect(FakeAudio.all[0]!.pause).toHaveBeenCalled();
    expect(voices).toEqual(["marin", "cedar"]);

    FakeAudio.all.at(-1)!.onended?.();
    await secondDone;
    expect(rowPreview(speaker.state, second).state).toBe("idle");
  });

  it("a failed preview is shown on its own row only", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/prepare")
        ? json({ ready: true, utterances: ["Morning."] })
        : new Response(JSON.stringify({ error: "Flux voices aren't switched on for this account yet." }), { status: 503 })));
    const speaker = new Speaker();
    const id = previewMessageId("b", "fable");
    await speaker.speak("Morning.", { voiceId: "fable", botId: "b", messageId: id });
    expect(rowPreview(speaker.state, id)).toEqual({ state: "error", error: "Flux voices aren't switched on for this account yet." });
    expect(rowPreview(speaker.state, previewMessageId("b", "marin")).state).toBe("idle");
  });
});
