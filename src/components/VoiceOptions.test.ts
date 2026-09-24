// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLUX_VOICES } from "../../server/tts/flux-speech.ts";
import { XAI_VOICES } from "../../server/tts/xai-speech.ts";
import { VoiceOptions, voiceGroups, voiceOptionText } from "./VoiceOptions";

const all = [...FLUX_VOICES, ...XAI_VOICES];
const render = (voices: typeof all) => renderToStaticMarkup(createElement("select", null, createElement(VoiceOptions, { voices })));

describe("the voice picker", () => {
  it("groups the 41 Flux voices as Female, Male and Neutral, every voice once", () => {
    const groups = voiceGroups(all);
    expect(groups.map((g) => g.label)).toEqual(["Female", "Male", "Neutral"]);
    expect(groups.flatMap((g) => g.voices)).toHaveLength(41);
    expect(groups[0]!.voices.map((v) => v.id)).toEqual(expect.arrayContaining(["nova", "marin", "eve", "ara"]));
    expect(groups[2]!.voices.map((v) => v.id)).toEqual(["alloy"]);
    const html = render(all);
    expect(html).toContain('<optgroup label="Female">');
    expect(html).toContain('<optgroup label="Neutral">');
    expect(html.match(/<option /g)).toHaveLength(41);
  });

  it("names each voice plainly, with whose voice it is only where the list mixes two", () => {
    const nova = FLUX_VOICES.find((v) => v.id === "nova")!;
    const eve = XAI_VOICES.find((v) => v.id === "eve")!;
    expect(voiceOptionText(nova, true)).toBe("Nova, upbeat and energetic (OpenAI)");
    expect(voiceOptionText(eve, true)).toBe("Eve, energetic (Grok)");
    expect(voiceOptionText(eve, false)).toBe("Eve, energetic");
    expect(render(all)).toContain('value="eve">Eve, energetic (Grok)</option>');
    // xAI's own engine lists only its 28: no provider suffix needed
    expect(render(XAI_VOICES)).not.toContain("(Grok)");
    expect(render(all)).not.toMatch(/—/);
  });

  it("keeps a flat list for voices that carry no gender (ElevenLabs, built-in)", () => {
    const html = render([{ id: "v1", label: "Rachel", description: "calm" }] as typeof all);
    expect(html).not.toContain("<optgroup");
    expect(html).toContain('value="v1">Rachel, calm</option>');
  });
});

describe("the Voice & alerts copy", () => {
  const voice = readFileSync(new URL("./VoiceSettings.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  const notifications = panel.slice(panel.indexOf('<SettingsSection id="voice"'), panel.indexOf('<SettingsSection id="routines"'));
  it("says bot, not agent, and has no em dashes", () => {
    for (const text of [voice, notifications]) {
      expect(text).not.toMatch(/—/);
      // product copy only: JSX text and string literals
      expect(text.match(/>[^<{]*\bagent\b[^<]*</gi) ?? []).toEqual([]);
      expect(text.match(/"[^"\n]*\bagent\b[^"\n]*"/gi) ?? []).toEqual([]);
    }
    expect(voice).toContain("Give this bot a voice");
  });

  it("shows the xAI engine only to an owner with an xAI key of their own", () => {
    expect(voice).toContain("tts?.xaiKey");
  });
});
