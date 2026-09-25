// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLUX_VOICES } from "../../server/tts/flux-speech.ts";
import { XAI_VOICES } from "../../server/tts/xai-speech.ts";
import { VoicePicker, type VoicePickerProps } from "./VoicePicker";
import type { RowPreviewState } from "./voice-picker-model";

const all = [...FLUX_VOICES, ...XAI_VOICES];
const render = (props: Partial<VoicePickerProps> = {}) =>
  renderToStaticMarkup(createElement(VoicePicker, {
    voices: all,
    value: "nova",
    onChange: () => {},
    label: "Nova's voice",
    preview: () => ({ state: "idle" as RowPreviewState }),
    onPreview: () => {},
    ...props,
  }));
/** The listbox's own markup, up to the play column that follows it. */
const listbox = (html: string) => html.slice(html.indexOf('role="listbox"'), html.indexOf("pointer-events-none absolute right-1"));

describe("the voice picker", () => {
  it("lists all 41 Flux voices as options in one named listbox, the chosen one selected", () => {
    const html = render();
    expect(html.match(/role="listbox"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Nova&#x27;s voice"');
    expect(html.match(/role="option"/g)).toHaveLength(41);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*data-voice="nova"/);
    // only the active row (the chosen one) is in the Tab order
    expect(html).toMatch(/aria-selected="true" tabindex="0"/);
    expect(html.match(/role="option" aria-selected="false" tabindex="0"/g)).toBeNull();
  });

  it("shows each voice's name and how it sounds, never the provider's id", () => {
    const html = render();
    expect(html).toContain(">Kira<");
    expect(html).toContain(">Upbeat, confident, American<");
    expect(html).toContain(">Harriet<");
    expect(html).toContain(">Calm, measured<");
    expect(html).not.toMatch(/>(nova|marin|eve)</);
    expect(html).not.toMatch(/\((OpenAI|Grok)\)|multilingual/);
    const names = all.map((v) => v.label);
    expect(new Set(names).size).toBe(41);
  });

  it("gives every row its own play button, outside the options", () => {
    const html = render();
    expect(html.match(/<button[^>]*aria-label="Play [^"]+"/g)).toHaveLength(41);
    expect(html).toContain('aria-label="Play Kira"');
    // an option may not hold a button: none of them does
    expect(listbox(html).match(/role="option"/g)).toHaveLength(41);
    expect(listbox(html)).not.toContain("<button");
  });

  it("says Loading, Stop, or what went wrong on the row it is about", () => {
    const states: Record<string, { state: RowPreviewState; error?: string }> = {
      nova: { state: "playing" },
      marin: { state: "loading" },
      fable: { state: "error", error: "Flux voices aren't switched on for this account yet." },
    };
    const html = render({ preview: (id) => states[id] ?? { state: "idle" } });
    expect(html).toContain('aria-label="Stop Kira"');
    expect(html).toMatch(/aria-label="Loading Nora" aria-busy="true"/);
    expect(html).toContain('aria-label="Play Rupert"');
    expect(html.match(/Couldn&#x27;t play</g)).toHaveLength(1);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t play Rupert. Flux voices aren&#x27;t switched on for this account yet.");
  });

  it("offers gender and accent filters for the Flux list, and none for a plain list", () => {
    const html = render();
    expect(html).toContain('aria-label="Search voices"');
    for (const chip of ["All", "Female", "Male", "Neutral", "American", "British"]) expect(html).toMatch(new RegExp(`aria-pressed="(true|false)"[^>]*>${chip}<`));
    const plain = render({ voices: [{ id: "v1", label: "Rachel", description: "calm" }], value: "v1" });
    expect(plain).not.toContain('aria-pressed');
    expect(plain).toContain(">Calm<");
  });

  it("keeps pinned rows first", () => {
    const html = render({ pinned: [{ id: "", label: "Workspace default" }], value: "" });
    expect(html.indexOf("Workspace default")).toBeLessThan(html.indexOf(">Adrian<"));
    expect(html).toMatch(/aria-selected="true"[^>]*data-voice=""/);
    expect(html.match(/role="option"/g)).toHaveLength(42);
  });

  it("says it is loading while the list is on its way", () => {
    const html = render({ voices: [], loading: true });
    expect(html).toContain("Loading voices");
    expect(html).toContain('aria-busy="true"');
  });

  it("is sized for touch: 52px rows and 44px play buttons", () => {
    const html = render();
    expect(html).toContain("height:52px");
    expect(html).toContain("size-11");
  });
});

describe("the Voice & alerts copy", () => {
  const voice = readFileSync(new URL("./VoiceSettings.tsx", import.meta.url), "utf8");
  const picker = readFileSync(new URL("./VoicePicker.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  const notifications = panel.slice(panel.indexOf('<SettingsSection id="voice"'), panel.indexOf('<SettingsSection id="routines"'));
  it("says bot, not agent, and has no em dashes", () => {
    for (const text of [voice, picker, notifications]) {
      expect(text).not.toMatch(/—/);
      // product copy only: JSX text and string literals
      expect(text.match(/>[^<{]*\bagent\b[^<]*</gi) ?? []).toEqual([]);
      expect(text.match(/"[^"\n]*\bagent\b[^"\n]*"/gi) ?? []).toEqual([]);
    }
    expect(voice).toContain("Give this bot a voice");
  });

  it("never talks about price", () => {
    for (const text of [voice, picker]) expect(text).not.toMatch(/billed|per character|price|\bcosts?\b/i);
  });

  it("says every voice speaks every language once, under the picker", () => {
    expect(voice.match(/Every voice speaks every language\./g)).toHaveLength(1);
    expect(picker).not.toContain("every language");
  });

  it("shows the xAI engine only to an owner with an xAI key of their own", () => {
    expect(voice).toContain("tts?.xaiKey");
  });
});

describe("the settings wiring", () => {
  const source = readFileSync(new URL("./VoiceSettings.tsx", import.meta.url), "utf8");
  it("uses the picker, not a native select, and stores the provider's id", () => {
    expect(source).toContain("<VoicePicker");
    expect(source).not.toContain("<select");
    expect(source).toContain("onChange={(voice) => onPatch({ voice })}");
  });
  it("plays each row as its own preview through the one speaker, and stops it", () => {
    expect(source).toContain("previewMessageId(bot.id, voiceId)");
    expect(source).toContain("speaker.stop()");
    // no network on render: the list is fetched once per engine, audio only on play
    expect(source.match(/api\(/g)).toHaveLength(2);
  });
});
